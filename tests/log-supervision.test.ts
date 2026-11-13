import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { lstat, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { deflateRawSync, gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveConfig } from '../src/config.ts'
import type { ActionProposalSpec, FeishuActionsService } from '../src/deps/actions-contract.ts'
import type {
  CommentInfo,
  DshReposV8,
  MrDetail,
  MrDiscussion,
  MrInfo,
  MrListParams,
  MrReviewParams,
  MrStatus,
  RepoUser,
} from '../src/deps/repos-contract.ts'
import { DSH_REPOS_SERVICE, ReposClient } from '../src/deps/repos.ts'
import {
  FEISHU_TOPICS_STATUS_EVENT,
  type FeishuTopicService,
  type TopicCardLinks,
  type TopicLaunchSpec,
  type TopicLaunchState,
} from '../src/deps/topics-contract.ts'
import type { HostContext, ToolActivationContext, ToolDefinition } from '../src/host.ts'
import { IssueMemory } from '../src/issues/memory.ts'
import { LogSupervisor, unpackLogSlot } from '../src/log/index.ts'
import type { LogSessionDriver, LogSessionTurnRequest } from '../src/log/session-driver.ts'
import { MrSupervisor } from '../src/mr/index.ts'
import type { MrSessionDriver } from '../src/mr/index.ts'
import { PlatformClient } from '../src/platform/client.ts'
import { CircuitBreakerRegistry } from '../src/runtime/breaker.ts'
import { openSupervisorDomain, outboxPlatformKey } from '../src/runtime/domain.ts'
import { createSupervisionPools } from '../src/runtime/pool.ts'
import { LogalyzeService } from '../src/service.ts'
import type { StateWire } from '../src/settings/contract.ts'
import { OverlayStore } from '../src/settings/overlay.ts'
import { loadBundledSkills } from '../src/skill/bundled.ts'
import { FakePlatform } from './fake-platform.ts'
import { FakeRepos } from './fake-repos.ts'
import { createAppRepo, tempDir } from './helpers.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(fn => fn()))
})

// ---------------------------------------------------------------------------
// Minimal Pure-Node ZIP & TAR Builders for Safe Unpack Tests
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i += 1) {
    let c = i
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) !== 0 ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1)
    }
    table[i] = c >>> 0
  }
  return table
})()

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i += 1) {
    c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8)
  }
  return (c ^ 0xffffffff) >>> 0
}

function buildZipBuffer(entries: readonly { readonly name: string; readonly content: string | Buffer; readonly deflate?: boolean }[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8')
    const raw = typeof entry.content === 'string' ? Buffer.from(entry.content, 'utf8') : entry.content
    const method = entry.deflate ? 8 : 0
    const compressed = method === 8 ? deflateRawSync(raw) : raw
    const checksum = crc32(raw)

    const localHeader = Buffer.alloc(30 + nameBuf.length)
    localHeader.writeUInt32LE(0x04034b50, 0)
    localHeader.writeUInt16LE(20, 4)
    localHeader.writeUInt16LE(0, 6)
    localHeader.writeUInt16LE(method, 8)
    localHeader.writeUInt16LE(0, 10)
    localHeader.writeUInt16LE(0, 12)
    localHeader.writeUInt32LE(checksum, 14)
    localHeader.writeUInt32LE(compressed.length, 18)
    localHeader.writeUInt32LE(raw.length, 22)
    localHeader.writeUInt16LE(nameBuf.length, 26)
    localHeader.writeUInt16LE(0, 28)
    nameBuf.copy(localHeader, 30)

    const centralHeader = Buffer.alloc(46 + nameBuf.length)
    centralHeader.writeUInt32LE(0x02014b50, 0)
    centralHeader.writeUInt16LE(20, 4)
    centralHeader.writeUInt16LE(20, 6)
    centralHeader.writeUInt16LE(0, 8)
    centralHeader.writeUInt16LE(method, 10)
    centralHeader.writeUInt16LE(0, 12)
    centralHeader.writeUInt16LE(0, 14)
    centralHeader.writeUInt32LE(checksum, 16)
    centralHeader.writeUInt32LE(compressed.length, 20)
    centralHeader.writeUInt32LE(raw.length, 24)
    centralHeader.writeUInt16LE(nameBuf.length, 28)
    centralHeader.writeUInt16LE(0, 30)
    centralHeader.writeUInt16LE(0, 32)
    centralHeader.writeUInt16LE(0, 34)
    centralHeader.writeUInt16LE(0, 36)
    centralHeader.writeUInt32LE(0, 38)
    centralHeader.writeUInt32LE(offset, 42)
    nameBuf.copy(centralHeader, 46)

    locals.push(localHeader, compressed)
    centrals.push(centralHeader)
    offset += localHeader.length + compressed.length
  }

  const centralSize = centrals.reduce((acc, buf) => acc + buf.length, 0)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralSize, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)

  return Buffer.concat([...locals, ...centrals, eocd])
}

function buildTarBuffer(entries: readonly { readonly name: string; readonly content?: string | Buffer; readonly type?: '0' | '2'; readonly linkname?: string }[]): Buffer {
  const blocks: Buffer[] = []
  for (const entry of entries) {
    const type = entry.type ?? '0'
    const raw = entry.content === undefined ? Buffer.alloc(0) : (typeof entry.content === 'string' ? Buffer.from(entry.content, 'utf8') : entry.content)
    const header = Buffer.alloc(512)
    header.write(entry.name.slice(0, 100), 0, 'utf8')
    header.write('0000644\0', 100, 'ascii')
    header.write('0000000\0', 108, 'ascii')
    header.write('0000000\0', 116, 'ascii')
    header.write(`${raw.length.toString(8).padStart(11, '0')}\0`, 124, 'ascii')
    header.write('14500000000\0', 136, 'ascii')
    header.fill(' ', 148, 156, 'ascii')
    header.write(type, 156, 'ascii')
    if (entry.linkname !== undefined) {
      header.write(entry.linkname.slice(0, 100), 157, 'utf8')
    }
    header.write('ustar\0', 257, 'ascii')
    header.write('00', 263, 'ascii')
    let sum = 0
    for (let i = 0; i < 512; i += 1) sum += header[i]!
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii')
    blocks.push(header)
    if (raw.length > 0) {
      const rem = raw.length % 512
      blocks.push(raw)
      if (rem !== 0) blocks.push(Buffer.alloc(512 - rem))
    }
  }
  blocks.push(Buffer.alloc(1024))
  return Buffer.concat(blocks)
}

// ---------------------------------------------------------------------------
// Harness Helpers: Fake FeishuTopics + Fake FeishuActions + FakeReposV8
// ---------------------------------------------------------------------------

class FakeFeishuTopics implements FeishuTopicService {
  readonly version = 3 as const
  readonly launched: TopicLaunchSpec[] = []
  readonly states = new Map<string, TopicLaunchState>()
  readonly updatedLinks: { readonly key: string; readonly links: TopicCardLinks }[] = []
  failNextLaunch: { readonly code: 'not-connected' | 'send-failed'; readonly message: string } | undefined
  failedLaunches = 0
  private readonly sessionToKey = new Map<string, string>()
  private statusListeners: ((state: TopicLaunchState) => void)[] = []

  attachListener(listener: (state: TopicLaunchState) => void): void {
    this.statusListeners.push(listener)
  }

  async launch(spec: TopicLaunchSpec) {
    if (this.failNextLaunch !== undefined) {
      const failure = this.failNextLaunch
      this.failNextLaunch = undefined
      this.failedLaunches += 1
      return { ok: false as const, code: failure.code, message: failure.message }
    }
    this.launched.push(spec)
    const msgId = `om_${this.launched.length}`
    const state: TopicLaunchState = {
      key: spec.key,
      status: 'running',
    }
    this.states.set(spec.key, state)
    return { ok: true as const, replayed: false, chatId: spec.chatId, messageId: msgId }
  }

  emitState(state: TopicLaunchState): void {
    this.states.set(state.key, state)
    if (state.sessionId !== undefined) this.sessionToKey.set(state.sessionId, state.key)
    for (const fn of this.statusListeners) fn(state)
  }

  state(key: string): TopicLaunchState | undefined {
    return this.states.get(key)
  }

  launchKeyOf(sessionId: string): string | undefined {
    return this.sessionToKey.get(sessionId)
  }

  async updateLinks(key: string, links: TopicCardLinks | undefined) {
    if (links !== undefined) this.updatedLinks.push({ key, links })
    return { ok: true as const }
  }
}

class FakeFeishuActions implements FeishuActionsService {
  readonly version = 1 as const
  readonly proposals: ActionProposalSpec[] = []
  readonly superseded: { readonly key: string; readonly reason?: string }[] = []

  async propose(spec: ActionProposalSpec) {
    const existingIdx = this.proposals.findIndex(p => p.key === spec.key)
    if (existingIdx >= 0) {
      return { ok: true as const, replayed: true, cardMessageId: `card_${existingIdx + 1}` }
    }
    this.proposals.push(spec)
    return { ok: true as const, replayed: false, cardMessageId: `card_${this.proposals.length}` }
  }

  async supersede(key: string, reason?: string): Promise<void> {
    this.superseded.push({ key, ...(reason === undefined ? {} : { reason }) })
  }
}

class FakeReposWithMr extends FakeRepos {
  readonly v8Mrs = new Map<string, Map<number, {
    info: MrInfo
    comments: CommentInfo[]
    discussions: MrDiscussion[]
    status: MrStatus
    diff: string
  }>>()
  botUser: RepoUser = { username: 'dsh-bot', webUrl: 'https://git.example/dsh-bot' }
  private mrSeq = 40

  constructor(dir: string) {
    super(dir)
    this.openMr = async ({ repo, branch, base, title, body }) => {
      this.mrSeq += 1
      const num = this.mrSeq
      const webUrl = `https://git.example/org/app/pull/${num}`
      const headSha = this.pushes.at(-1)?.commit ?? `sha-push-${num}`
      const info: MrInfo = {
        number: num,
        title,
        body: body ?? '',
        state: 'open',
        draft: false,
        sourceBranch: branch,
        targetBranch: base,
        headSha,
        author: this.botUser,
        labels: [],
        assignees: [],
        createdAt: '2026-11-12T00:00:00Z',
        updatedAt: '2026-11-12T00:00:00Z',
        webUrl,
      }
      let repoMap = this.v8Mrs.get(repo)
      if (repoMap === undefined) {
        repoMap = new Map()
        this.v8Mrs.set(repo, repoMap)
      }
      repoMap.set(num, {
        info,
        comments: [],
        discussions: [],
        status: { headSha, overall: 'success', mergeable: true, checks: [{ name: 'ci', state: 'success' }] },
        diff: '+fixed',
      })
      return { number: num, title, branch, base, state: 'open', webUrl }
    }
  }

  asV8(): DshReposV8 {
    return Object.assign(this, {
      version: 8 as const,
      currentBotUser: async () => this.botUser,
      mrList: async (params: MrListParams) => {
        const list = [...(this.v8Mrs.get(params.repo)?.values() ?? [])].map(m => m.info)
        return { items: list }
      },
      mrGet: async (params: { repo: string; number: number }) => {
        const found = this.v8Mrs.get(params.repo)?.get(params.number)
        if (found === undefined) throw new Error(`MR !${params.number} not found`)
        const detail: MrDetail = {
          ...found.info,
          comments: found.comments,
        }
        return detail
      },
      mrDiff: async (params: { repo: string; number: number }) => ({
        diff: this.v8Mrs.get(params.repo)?.get(params.number)?.diff ?? '',
        truncated: false,
      }),
      mrStatus: async (params: { repo: string; number: number }) =>
        this.v8Mrs.get(params.repo)?.get(params.number)?.status ?? { headSha: '', overall: 'pending', checks: [] },
      mrComments: async (params: { repo: string; number: number }) =>
        this.v8Mrs.get(params.repo)?.get(params.number)?.comments ?? [],
      mrDiscussions: async (params: { repo: string; number: number }) => ({
        items: this.v8Mrs.get(params.repo)?.get(params.number)?.discussions ?? [],
      }),
      mrCompare: async () => ({
        diff: '+cmp',
        truncated: false,
      }),
      mrReview: async (_params: MrReviewParams) => ({ submitted: true, reviewId: 'r1' }),
      mrComment: async () => ({ id: 'c1', body: '', author: this.botUser, createdAt: '2026-11-12T00:00:00Z' }),
      mrDiscussionReply: async () => ({ id: 'd1', body: '', author: this.botUser, createdAt: '2026-11-12T00:00:00Z' }),
      mrDiscussionResolve: async () => ({ resolved: true }),
    }) as unknown as DshReposV8
  }
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 12_000): Promise<void> {
  const start = Date.now()
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms`)
    }
    await new Promise(resolve => setTimeout(resolve, 15))
  }
}

// ---------------------------------------------------------------------------
// 1. Safe Archive Unpacker
// ---------------------------------------------------------------------------

describe('safe archive unpacker (unpackLogSlot)', () => {
  it('unpacks valid zip, tar, tar.gz, gz, and plain files safely', async () => {
    const { dir, cleanup } = await tempDir()
    cleanups.push(cleanup)

    const zipPath = join(dir, 'sample.zip')
    await writeFile(zipPath, buildZipBuffer([
      { name: 'logs/app.log', content: '2026-11-12 ERROR NullPointerException\n', deflate: true },
      { name: 'meta.json', content: '{"ok":true}', deflate: false },
    ]))
    const zipDest = join(dir, 'slot-zip')
    const zipRes = await unpackLogSlot({ archivePath: zipPath, fileName: 'sample.zip', destDir: zipDest, maxBytes: 1024 * 1024 })
    expect(zipRes.status).toBe('ok')
    expect(zipRes.files).toEqual(['logs/app.log', 'meta.json'])
    expect(await readFile(join(zipDest, 'logs/app.log'), 'utf8')).toContain('NullPointerException')

    const tarPath = join(dir, 'sample.tar')
    await writeFile(tarPath, buildTarBuffer([
      { name: 'var/service.log', content: 'service started\n' },
    ]))
    const tarDest = join(dir, 'slot-tar')
    const tarRes = await unpackLogSlot({ archivePath: tarPath, fileName: 'sample.tar', destDir: tarDest, maxBytes: 1024 * 1024 })
    expect(tarRes.status).toBe('ok')
    expect(tarRes.files).toEqual(['var/service.log'])

    const tgzPath = join(dir, 'sample.tar.gz')
    await writeFile(tgzPath, gzipSync(buildTarBuffer([
      { name: 'kernel.log', content: 'oops at line 42\n' },
    ])))
    const tgzDest = join(dir, 'slot-tgz')
    const tgzRes = await unpackLogSlot({ archivePath: tgzPath, fileName: 'sample.tar.gz', destDir: tgzDest, maxBytes: 1024 * 1024 })
    expect(tgzRes.status).toBe('ok')
    expect(tgzRes.files).toEqual(['kernel.log'])

    const gzPath = join(dir, 'single.log.gz')
    await writeFile(gzPath, gzipSync(Buffer.from('single gz line\n')))
    const gzDest = join(dir, 'slot-gz')
    const gzRes = await unpackLogSlot({ archivePath: gzPath, fileName: 'single.log.gz', destDir: gzDest, maxBytes: 1024 * 1024 })
    expect(gzRes.status).toBe('ok')
    expect(gzRes.files).toEqual(['single.log'])

    const plainPath = join(dir, 'raw.log')
    await writeFile(plainPath, 'plain text line\n')
    const plainDest = join(dir, 'slot-plain')
    const plainRes = await unpackLogSlot({ archivePath: plainPath, fileName: 'raw.log', destDir: plainDest, maxBytes: 1024 * 1024 })
    expect(plainRes.status).toBe('ok')
    expect(plainRes.files).toEqual(['raw.log'])
  })

  it('rejects Zip-Slip, symlink entries, Zip-Bomb byte caps, and isolates corrupted archives', async () => {
    const { dir, cleanup } = await tempDir()
    cleanups.push(cleanup)

    const slipPath = join(dir, 'slip.zip')
    await writeFile(slipPath, buildZipBuffer([{ name: '../../etc/passwd', content: 'evil' }]))
    const slipDest = join(dir, 'slot-slip')
    const slipRes = await unpackLogSlot({ archivePath: slipPath, fileName: 'slip.zip', destDir: slipDest, maxBytes: 1024 * 1024 })
    expect(slipRes.status).toBe('corrupted')
    if (slipRes.status === 'corrupted') expect(slipRes.error).toContain('路径穿越')
    expect(await readFile(join(slipDest, 'CORRUPTED.txt'), 'utf8')).toContain('路径穿越')

    const symPath = join(dir, 'symlink.tar')
    await writeFile(symPath, buildTarBuffer([
      { name: 'link.log', type: '2', linkname: '/etc/shadow' },
    ]))
    const symDest = join(dir, 'slot-sym')
    const symRes = await unpackLogSlot({ archivePath: symPath, fileName: 'symlink.tar', destDir: symDest, maxBytes: 1024 * 1024 })
    expect(symRes.status).toBe('corrupted')
    if (symRes.status === 'corrupted') expect(symRes.error).toContain('符号链接')

    const bombPath = join(dir, 'bomb.zip')
    await writeFile(bombPath, buildZipBuffer([
      { name: 'huge.log', content: Buffer.alloc(64 * 1024, 0x41), deflate: true },
    ]))
    const bombDest = join(dir, 'slot-bomb')
    const bombRes = await unpackLogSlot({ archivePath: bombPath, fileName: 'bomb.zip', destDir: bombDest, maxBytes: 4096 })
    expect(bombRes.status).toBe('corrupted')
    if (bombRes.status === 'corrupted') expect(bombRes.error).toContain('超过上限')

    // 4566593853: Reject <512-byte non-TAR inputs (.tar and .tar.gz) and truncated TARs without clean EOF blocks.
    const shortTarPath = join(dir, 'short.tar')
    await writeFile(shortTarPath, Buffer.from('not-a-tar-archive'))
    const shortTarDest = join(dir, 'slot-short-tar')
    const shortTarRes = await unpackLogSlot({ archivePath: shortTarPath, fileName: 'short.tar', destDir: shortTarDest, maxBytes: 1024 * 1024 })
    expect(shortTarRes.status).toBe('corrupted')
    expect(await readFile(join(shortTarDest, 'CORRUPTED.txt'), 'utf8')).toContain('TAR')

    const shortTgzPath = join(dir, 'short.tar.gz')
    await writeFile(shortTgzPath, gzipSync(Buffer.from('not-a-tar-archive')))
    const shortTgzDest = join(dir, 'slot-short-tgz')
    const shortTgzRes = await unpackLogSlot({ archivePath: shortTgzPath, fileName: 'short.tar.gz', destDir: shortTgzDest, maxBytes: 1024 * 1024 })
    expect(shortTgzRes.status).toBe('corrupted')
    expect(await readFile(join(shortTgzDest, 'CORRUPTED.txt'), 'utf8')).toContain('TAR')

    const validTar = buildTarBuffer([{ name: 'first.log', content: 'ok\n' }])
    const truncatedTar = Buffer.concat([validTar.subarray(0, validTar.length - 1024), Buffer.alloc(100, 0x41)])
    const truncTarPath = join(dir, 'truncated.tar')
    await writeFile(truncTarPath, truncatedTar)
    const truncTarDest = join(dir, 'slot-trunc-tar')
    const truncTarRes = await unpackLogSlot({ archivePath: truncTarPath, fileName: 'truncated.tar', destDir: truncTarDest, maxBytes: 1024 * 1024 })
    expect(truncTarRes.status).toBe('corrupted')
    await expect(stat(join(truncTarDest, 'first.log'))).rejects.toThrow()
    expect(await readFile(join(truncTarDest, 'CORRUPTED.txt'), 'utf8')).toContain('TAR')
  })
})

// ---------------------------------------------------------------------------
// 2. IssueMemory Search, Human Field Protection & Batch Dedup
// ---------------------------------------------------------------------------

describe('IssueMemory search, humanConclusion preservation, and batch dedup', () => {
  it('matches NFKC/case-insensitively, prioritizes humanConclusion, preserves human edits, and deduplicates titles', async () => {
    const domain = await openSupervisorDomain()
    cleanups.push(() => domain.close())
    const memory = new IssueMemory(domain.issues)

    const first = await memory.upsertNewOrReuseByTitle({
      appId: 'order-service',
      title: '订单超时重试导致 NPE',
      matchCriteria: 'NullPointerException at OrderRetryHandler:88',
      aiDiagnosis: '旧 AI 判断可能是网络抖动',
      aiStatus: 'located',
      resolutionAdvice: '检查空指针判空',
      seenAt: 1_000,
    })
    expect(first.created).toBe(true)
    expect(first.issueId).toBe('ISS-order-service-0001')

    await domain.issues.syncHumanFields(first.issueId, {
      humanConclusion: '人工确认为 Redis 连接池配置过小且未判空',
      humanStatus: '已排期修复',
      assignee: 'bob',
    })

    // AI upsert / title dedup reuses the same ID and NEVER overwrites human fields.
    const dup = await memory.upsertNewOrReuseByTitle({
      appId: 'order-service',
      title: '  订单超时重试导致 ＮＰＥ  ',
      matchCriteria: 'NullPointerException at OrderRetryHandler:88',
      aiDiagnosis: '新一轮 AI 补充证据',
      aiStatus: 'located',
      resolutionAdvice: '建议加固判空并增大连接池',
      seenAt: 2_000,
    })
    expect(dup.created).toBe(false)
    expect(dup.issueId).toBe('ISS-order-service-0001')
    expect(dup.record.humanConclusion).toBe('人工确认为 Redis 连接池配置过小且未判空')
    expect(dup.record.assignee).toBe('bob')

    const hits = memory.search({ appId: 'order-service', query: 'ｎｐｅ orderretryhandler' })
    expect(hits).toHaveLength(1)
    expect(hits[0]?.humanConclusion).toBe('人工确认为 Redis 连接池配置过小且未判空')
    expect(hits[0]?.humanStatus).toBe('已排期修复')

    // Collision-resistant slug namespaces & serialized allocation for >32-char prefixes and non-ASCII appIds
    const [alphaRes, betaRes, cnOrderRes, cnPayRes] = await Promise.all([
      memory.upsertNewOrReuseByTitle({
        appId: 'enterprise-microservice-platform-order-alpha',
        title: 'Alpha 超时',
        matchCriteria: 'TimeoutException alpha',
        aiDiagnosis: 'alpha diag',
        aiStatus: 'located',
        resolutionAdvice: 'fix alpha',
        seenAt: 3_000,
      }),
      memory.upsertNewOrReuseByTitle({
        appId: 'enterprise-microservice-platform-order-beta',
        title: 'Beta 超时',
        matchCriteria: 'TimeoutException beta',
        aiDiagnosis: 'beta diag',
        aiStatus: 'located',
        resolutionAdvice: 'fix beta',
        seenAt: 3_000,
      }),
      memory.upsertNewOrReuseByTitle({
        appId: '订单核心服务',
        title: '订单库连接泄露',
        matchCriteria: 'PoolExhausted order',
        aiDiagnosis: 'cn order diag',
        aiStatus: 'located',
        resolutionAdvice: 'close conn',
        seenAt: 3_000,
      }),
      memory.upsertNewOrReuseByTitle({
        appId: '支付核心服务',
        title: '支付渠道超时',
        matchCriteria: 'ChannelTimeout pay',
        aiDiagnosis: 'cn pay diag',
        aiStatus: 'located',
        resolutionAdvice: 'retry pay',
        seenAt: 3_000,
      }),
    ])
    expect(new Set([alphaRes.issueId, betaRes.issueId, cnOrderRes.issueId, cnPayRes.issueId]).size).toBe(4)
    expect(alphaRes.record.appId).toBe('enterprise-microservice-platform-order-alpha')
    expect(betaRes.record.appId).toBe('enterprise-microservice-platform-order-beta')
    expect(cnOrderRes.record.appId).toBe('订单核心服务')
    expect(cnPayRes.record.appId).toBe('支付核心服务')

    await expect(domain.issues.upsertByAi({
      issueId: alphaRes.issueId,
      appId: 'enterprise-microservice-platform-order-beta',
      title: 'Cross app overwrite',
      matchCriteria: 'none',
      aiDiagnosis: 'none',
      aiStatus: 'located',
      resolutionAdvice: 'none',
      seenAt: 4_000,
    })).rejects.toThrow(/已归属应用/)
  })
})

// ---------------------------------------------------------------------------
// 3. End-to-End LogSupervision: Poller, Batching, Breaker, Outbox, Feishu & Self-MR Loop
// ---------------------------------------------------------------------------

describe('LogSupervisor & LogalyzeService M3 end-to-end closed loops', () => {
  async function createFullHarness(options: {
    readonly clockStart?: number
    readonly deliveryMode?: 'quiet-until-done' | 'topic-on-start'
    readonly batchSizeThreshold?: number
    readonly maxBatchSize?: number
    readonly batchWindowMs?: number
    readonly maxConcurrentBatches?: number
    readonly appHourlyBatchLimit?: number
    readonly origin?: string
    readonly withSecondApp?: boolean
    readonly settingsPath?: string
    readonly skipSaveApplication?: boolean
    readonly supervisorDir?: string
    readonly withPlatform?: boolean
    readonly setupPlatform?: (platform: FakePlatform) => void
    readonly allowedHosts?: readonly string[]
    readonly fetch?: typeof fetch
    readonly onLogTurn?: (req: LogSessionTurnRequest, tools: readonly ToolDefinition<unknown>[]) => Promise<void>
    readonly onMrTurn?: (req: { repo: string; mrNumber: number; origin: string; prompt: string }) => Promise<void>
  } = {}) {
    const { dir, cleanup } = await tempDir()
    cleanups.push(cleanup)

    const origin = options.origin ?? await createAppRepo(join(dir, 'order-service'), {
      'src/handler.ts': 'export function handleOrder() { return null }\n',
    })
    const secondOrigin = options.withSecondApp
      ? await createAppRepo(join(dir, 'payment-service'), {
          '.agents/logalyze.yaml': [
            'id: payment-service',
            'name: 支付服务',
            'description: 支付网关与回调处理',
            'aliases: [支付, pay-comp]',
            'logHints: [payment-service, PayClient]',
            'skill: log-analysis',
            '',
          ].join('\n'),
          'src/pay.ts': 'export const pay = true\n',
        })
      : undefined

    const fakeRepos = new FakeReposWithMr(join(dir, 'repos-store'))
    fakeRepos.setCatalog(
      [
        { url: origin, base: 'main' },
        ...(secondOrigin === undefined ? [] : [{ url: secondOrigin, base: 'main' }]),
      ],
      ['log-analysis', 'mr-review'],
    )

    const fakePlatform = new FakePlatform()
    if (options.withPlatform !== false) {
      await fakePlatform.start()
      cleanups.push(() => fakePlatform.stop())
      options.setupPlatform?.(fakePlatform)
    }

    const fakeTopics = new FakeFeishuTopics()
    const fakeActions = new FakeFeishuActions()

    let currentNow = options.clockStart ?? Date.parse('2026-11-12T10:00:00.000Z')
    const tools: ToolDefinition<unknown>[] = []
    const services = new Map<string, unknown>([
      [DSH_REPOS_SERVICE, fakeRepos.asV8()],
      ['feishuTopics', fakeTopics],
      ['feishuActions', fakeActions],
      ['credentials', {
        resolve: async (name: string) => name === 'LOGALYZE_PLATFORM_CLIENT_SECRET' ? { value: fakePlatform.secret, source: 'env' } : undefined,
        set: async () => undefined,
        unset: async () => undefined,
        describe: async (name: string) => ({ configured: name === 'LOGALYZE_PLATFORM_CLIENT_SECRET', writable: false }),
      }],
    ])

    const ctx: HostContext = {
      tools: {
        register: (def) => {
          tools.push(def as ToolDefinition<unknown>)
          return () => undefined
        },
      },
      subagents: {
        getProvider: () => undefined,
        resolveMaxDepth: () => 1,
        startActivation: async () => { throw new Error('unused') },
      },
      skills: {
        registerProvider: () => () => undefined,
      },
      on: (event, listener) => {
        if (event === FEISHU_TOPICS_STATUS_EVENT) {
          fakeTopics.attachListener(listener as (state: TopicLaunchState) => void)
        }
        return () => undefined
      },
      effect: (factory) => {
        factory()
        return () => undefined
      },
      get: name => services.get(name),
      logger: {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
    }

    const store = new OverlayStore(options.settingsPath ?? join(dir, 'settings.json'))
    const config = resolveConfig({
      mrReview: {
        enabled: true,
        debounceMs: 0,
      },
      ...(options.allowedHosts === undefined ? {} : {
        download: {
          allowedHosts: [...options.allowedHosts],
        },
      }),
      ...(options.withPlatform !== false ? {
        analyze: {
          platform: fakePlatform.settings(),
          upload: { timeoutMs: 5000, concurrency: 2, maxFiles: 10, maxFileBytes: 1024 * 1024, maxMarkdownBytes: 1024 * 1024, maxBytes: 5 * 1024 * 1024 },
        },
      } : {}),
      logSupervision: {
        enabled: true,
        pollIntervalMs: 60_000,
        batchSizeThreshold: options.batchSizeThreshold ?? 5,
        maxBatchSize: options.maxBatchSize ?? 20,
        batchWindowMs: options.batchWindowMs ?? 300_000,
        maxConcurrentBatches: options.maxConcurrentBatches ?? 4,
        appHourlyBatchLimit: options.appHourlyBatchLimit ?? 15,
        feishuChatId: 'oc_ops_group',
        deliveryMode: options.deliveryMode ?? 'quiet-until-done',
      },
    })

    let turnSeq = 0
    const logTurns: LogSessionTurnRequest[] = []
    const logSessionDriver: LogSessionDriver = {
      async runTurn(req) {
        logTurns.push(req)
        turnSeq += 1
        const sessionId = req.existingSessionId ?? `log-sess-${turnSeq}`
        await req.onSessionBound?.(sessionId)
        if (options.onLogTurn !== undefined) {
          await options.onLogTurn({ ...req, existingSessionId: sessionId }, tools)
        }
        return { sessionId }
      },
    }

    const mrTurns: { repo: string; mrNumber: number; origin: string; prompt: string }[] = []
    const mrSessionDriver: MrSessionDriver = {
      async runTurn(req) {
        mrTurns.push({ repo: req.repo, mrNumber: req.mrNumber, origin: req.origin, prompt: req.prompt })
        const sid = req.existingSessionId ?? `mr-sess-${mrTurns.length}`
        await req.onSessionBound?.(sid)
        await options.onMrTurn?.({ repo: req.repo, mrNumber: req.mrNumber, origin: req.origin, prompt: req.prompt })
        return { sessionId: sid }
      },
    }

    const bundled = loadBundledSkills(new URL('../skills/', import.meta.url))
    const service = new LogalyzeService(ctx, config, store, { bundled }, {
      analysesDir: join(dir, 'analyses'),
      legacyReportsDir: join(dir, 'legacy'),
      supervisorDir: options.supervisorDir ?? join(dir, 'supervisor'),
      mrWorkspacesDir: join(dir, 'mr-ws'),
      logWorkspacesDir: join(dir, 'log-ws'),
      mrSessionDriver,
      logSessionDriver,
      autoMrPollTimer: false,
      autoLogPollTimer: false,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      now: () => currentNow,
    })

    service.registerTools()
    await service.boot()
    if (!options.skipSaveApplication) {
      await service.saveApplication({ url: origin, description: '订单服务', aliases: ['order-comp'] })
      if (secondOrigin !== undefined) {
        await service.saveApplication({ url: secondOrigin, description: '支付服务', aliases: ['pay-comp'] })
      }
    }
    cleanups.push(() => service.shutdown())

    const toolExecCtx = (sessionId: string, cwd = dir, callId = 'call-1') => ({
      agent: {
        id: 'agent-supervisor',
        name: 'dsh-agent',
        session: { header: { id: sessionId, cwd } },
      },
      cwd,
      callId,
      signal: new AbortController().signal,
    })

    return {
      dir,
      origin,
      secondOrigin,
      service,
      fakeRepos,
      fakePlatform,
      fakeTopics,
      fakeActions,
      tools,
      logTurns,
      mrTurns,
      getNow: () => currentNow,
      setNow: (ms: number) => { currentNow = ms },
      advanceNow: (deltaMs: number) => { currentNow += deltaMs },
      toolExecCtx,
      toolNamed: (name: string) => tools.find(t => t.name === name)!,
    }
  }

  it('supports multi-page backfill, window batching (size & time & 20-cap slicing), quiet-until-done Feishu summary, Outbox URL backfill, and manual dead-letter retry', async () => {
    let submittedTaskId = ''
    let submittedWorkDir = ''

    const h = await createFullHarness({
      batchSizeThreshold: 5,
      maxBatchSize: 20,
      batchWindowMs: 300_000,
      onLogTurn: async (req) => {
        submittedTaskId = req.taskId
        submittedWorkDir = req.workDir
        const prepare = h.toolNamed('supervisor_log_prepare')
        const submit = h.toolNamed('supervisor_log_submit')
        const prepared = await prepare.execute({ taskId: req.taskId }, h.toolExecCtx(req.existingSessionId!, req.workDir)) as {
          readonly slots: readonly { readonly ref: string; readonly unpackStatus: string; readonly files: readonly string[] }[]
        }
        const reportExtraDir = join(req.workDir, 'scratch')
        await mkdir(reportExtraDir, { recursive: true })
        await writeFile(join(reportExtraDir, 'trace.txt'), 'NPE stacktrace line 1\n')

        await submit.execute({
          taskId: req.taskId,
          summary: '订单服务处理超时引发空指针',
          items: prepared.slots.map(s => ({
            ref: s.ref,
            status: 'diagnosed',
            rootCauseCategory: 'code_defect',
            conclusion: 'HandleOrder 未判空导致 NPE',
            evidences: [
              { source: `logs/${s.ref}/${s.files[0]}`, locator: 'L1', excerpt: 'NullPointerException' },
              { source: 'repos/order-service/src/handler.ts', locator: 'L1', excerpt: 'return null' },
            ],
            issueLink: {
              mode: 'new',
              title: '订单服务 NPE 空指针异常',
              matchCriteria: 'NullPointerException handleOrder',
              resolutionAdvice: '对入参增加空检查',
            },
          })),
          attachments: ['scratch/trace.txt'],
        }, h.toolExecCtx(req.existingSessionId!, req.workDir))
      },
    })

    const sup = h.service.logSupervisorInstance()!
    // Rewind cursor before populating multi-page logs (105 eligible logs -> page 100 + page 5, sliced into 20-cap batches!)
    await h.service.controlLogWatermark({ action: 'rewind', cursorTime: '2026-11-12T09:50:00.000Z' })

    // Add 105 eligible archived logs in NFKC alias 'Ｏｒｄｅｒ－ｃｏｍｐ' + 1 non-fds log that must be ignored.
    for (let i = 1; i <= 25; i += 1) {
      const zip = buildZipBuffer([{ name: 'app.log', content: `NullPointerException log #${i}\n` }])
      h.fakePlatform.addLog({
        log_id: `log-${String(i).padStart(3, '0')}`,
        product_code: 'P1',
        component_code: 'Ｏｒｄｅｒ－ｃｏｍｐ',
        error_code: 'E_NPE',
        file_name: `log-${i}.zip`,
        storage_type: 'fds',
        status: 'completed',
        archived_at: '2026-11-12T09:55:00.000Z',
      }, zip)
    }
    // Non-FDS log should be ignored by client filter
    h.fakePlatform.addLog({
      log_id: 'log-non-fds',
      product_code: 'P1',
      component_code: 'order-comp',
      error_code: 'E_NPE',
      file_name: 'ignored.log',
      storage_type: 's3',
      status: 'completed',
      archived_at: '2026-11-12T09:55:00.000Z',
    }, 'ignored')

    // No Feishu topic launched before diagnosis completes (quiet-until-done!)
    await sup.pollNow()
    await waitFor(() => h.fakeTopics.launched.length >= 2)
    await flushMicrotasks()

    // 25 logs with maxBatchSize=20, threshold=5 -> slices 20 + 5 immediately! (Two tasks executed!)
    expect(h.logTurns.length).toBe(2)
    expect(h.fakePlatform.requests.some(r => r.path.includes('log-non-fds'))).toBe(false)
    // Both completed Phase-1 headless batches delivered Phase-2 Feishu summary cards AFTER completion
    expect(h.fakeTopics.launched.length).toBe(2)
    expect(h.fakeTopics.launched[0]?.card.taskName).toBe('汇总')

    // Emit 'done' on the Phase-2 topic -> triggers feishuActions.propose!
    const launch = h.fakeTopics.launched[0]!
    h.fakeTopics.emitState({
      key: launch.key,
      status: 'done',
      sessionId: 'feishu-summary-sess-1',
    })
    await flushMicrotasks()

    expect(h.fakeActions.proposals.length).toBeGreaterThanOrEqual(1)
    expect(h.fakeActions.proposals[0]?.actions.map(a => a.id)).toEqual(['fix_code', 'improve_skill'])

    // Verify Outbox uploaded per-log reports & backfilled IssueMemory sampleReportUrl / latestReportUrl
    const state = await h.service.state()
    expect(state.logSupervision?.tasks.length).toBe(2)
    const domain = await h.service.supervisorDomain()
    const issue = domain.issues.get('ISS-order-service-0001')
    expect(issue?.sampleReportUrl).toContain('/logs/')
    expect(issue?.latestReportUrl).toContain('/logs/')
    // Intra-batch & across-batch title dedup resulted in 1 single issue ID for 25 logs!
    expect(domain.issues.keys()).toEqual(['ISS-order-service-0001'])

    // Verify attachment snapshot exists inside revisions/rev-1/trace.txt
    expect((await stat(join(submittedWorkDir, 'report', 'revisions', 'rev-1', 'trace.txt'))).isFile()).toBe(true)

    // Verify dead-letter outbox row retry via control API works
    const deadKey = outboxPlatformKey(submittedTaskId, 2, 'log-001')
    await domain.outboxPlatform.put(deadKey, {
      taskId: submittedTaskId,
      revision: 2,
      logId: 'log-001',
      status: 'dead',
      attempts: 5,
      nextRetryAt: 0,
      lastError: 'HTTP 502 simulated failure',
    })
    // Also seed rev 2 in logTasks so deliverOutboxRecord finds rev 2
    const curTask = domain.logTasks.get(submittedTaskId)!
    await domain.logTasks.put(submittedTaskId, {
      ...curTask,
      revisions: [...curTask.revisions, { ...curTask.revisions[0]!, revision: 2, summary: 'rev 2 reupload' }],
    })
    const beforeDead = await h.service.state()
    expect(beforeDead.logSupervision?.outboxDead.map(d => d.key)).toEqual([deadKey])
    const afterRetry = await h.service.retryOutboxDead({ key: deadKey })
    expect(afterRetry.logSupervision?.outboxDead).toEqual([])
    expect(h.fakePlatform.revisions.some(r => r.key === deadKey && r.completed)).toBe(true)

    // Verify multi-page backfill pagination (>100 eligible logs across 2 pages) + pause/resume + backoff error state
    await h.service.controlLogWatermark({ action: 'pause' })
    expect((await h.service.state()).logSupervision?.watermark?.paused).toBe(true)
    await h.service.controlLogWatermark({ action: 'resume' })
    expect((await h.service.state()).logSupervision?.watermark?.paused).toBe(false)

    // Inject HTTP 502 on logs query -> pollNow records consecutiveFailures >= 1 (one-shot failure)
    h.advanceNow(10_000)
    h.fakePlatform.fail('logs', 502)
    await sup.pollNow()
    expect((await h.service.state()).logSupervision?.watermark?.consecutiveFailures).toBeGreaterThanOrEqual(1)

    // Add 105 new logs at a later archived_at so page size 100 spans 2 API pages
    h.setNow(Date.parse('2026-11-12T10:15:00.000Z'))
    await h.service.controlLogWatermark({ action: 'rewind', cursorTime: '2026-11-12T10:10:00.000Z' })
    for (let i = 1; i <= 105; i += 1) {
      h.fakePlatform.addLog({
        log_id: `mp-${String(i).padStart(3, '0')}`,
        product_code: 'P1',
        component_code: 'order-comp',
        error_code: 'E_MP',
        file_name: `mp-${i}.log`,
        storage_type: 'fds',
        status: 'completed',
        archived_at: '2026-11-12T10:11:00.000Z',
      }, `multi-page log #${i}\n`)
    }
    const prevLogReqCount = h.fakePlatform.requests.filter(r => r.method === 'GET' && r.path.startsWith('/open-api/v1/logs?')).length
    await sup.pollNow()
    await waitFor(() => h.logTurns.length >= 8)
    const afterLogReqCount = h.fakePlatform.requests.filter(r => r.method === 'GET' && r.path.startsWith('/open-api/v1/logs?')).length
    expect(afterLogReqCount - prevLogReqCount).toBeGreaterThanOrEqual(2)
    expect(h.logTurns.length).toBe(8) // 2 original + 6 batches (105 = 20*5 + 5)
  }, 20_000)

  it('triggers non-resetting batchWindowMs timer and enforces log:<appId> breaker without blocking other apps', async () => {
    const throttles: string[] = []
    const h = await createFullHarness({
      batchSizeThreshold: 5,
      batchWindowMs: 300_000,
      appHourlyBatchLimit: 2,
      onLogTurn: async (req) => {
        const prepare = h.toolNamed('supervisor_log_prepare')
        const submit = h.toolNamed('supervisor_log_submit')
        const prepared = await prepare.execute({ taskId: req.taskId }, h.toolExecCtx(req.existingSessionId!, req.workDir)) as {
          readonly slots: readonly { readonly ref: string; readonly files: readonly string[] }[]
        }
        await submit.execute({
          taskId: req.taskId,
          summary: '配置缺失导致失败',
          items: prepared.slots.map(s => ({
            ref: s.ref,
            status: 'diagnosed',
            rootCauseCategory: 'config_or_env',
            conclusion: '缺少环境变量',
            evidences: [{ source: `logs/${s.ref}/${s.files[0]}`, locator: 'L1', excerpt: 'missing env' }],
          })),
        }, h.toolExecCtx(req.existingSessionId!, req.workDir))
      },
    })

    // Replace notifier by testing log:<appId> trip via LogSupervisor state
    await h.service.controlLogWatermark({ action: 'rewind', cursorTime: '2026-11-12T09:50:00.000Z' })

    // Add 2 logs (< threshold 5) -> waits in pending_batches without dispatching immediately
    for (let i = 1; i <= 2; i += 1) {
      h.fakePlatform.addLog({
        log_id: `win-${i}`,
        product_code: 'P1',
        component_code: 'order-service',
        error_code: 'E_WIN',
        file_name: `win-${i}.log`,
        storage_type: 'fds',
        status: 'completed',
        archived_at: '2026-11-12T09:52:00.000Z',
      }, 'missing env')
    }
    const sup = h.service.logSupervisorInstance()!
    await sup.pollNow()
    let st = await h.service.state()
    expect(st.logSupervision?.pendingBatches).toHaveLength(1)
    expect(h.logTurns.length).toBe(0)

    // Add a 3rd log 100s later -> windowOpenedAt does NOT reset, still waits at original 5min deadline!
    h.advanceNow(100_000)
    h.fakePlatform.addLog({
      log_id: 'win-3',
      product_code: 'P1',
      component_code: 'order-service',
      error_code: 'E_WIN',
      file_name: 'win-3.log',
      storage_type: 'fds',
      status: 'completed',
      archived_at: new Date(h.getNow() - 1000).toISOString(),
    }, 'missing env')
    await sup.pollNow()
    expect(h.logTurns.length).toBe(0)

    // Advance past original window (another 201s -> total 301s >= 300s from first arrival!) -> dispatches batch 1!
    h.advanceNow(201_000)
    sup.notifyConfigOrReposChanged()
    await waitFor(() => h.logTurns.length === 1)

    // Now flood 2 more threshold batches (batch 2 succeeds, batch 3 hits appHourlyBatchLimit=2 and trips log:order-service!)
    for (let i = 1; i <= 10; i += 1) {
      h.fakePlatform.addLog({
        log_id: `storm-${i}`,
        product_code: 'P1',
        component_code: 'order-service',
        error_code: i <= 5 ? 'E_S1' : 'E_S2',
        file_name: `s-${i}.log`,
        storage_type: 'fds',
        status: 'completed',
        archived_at: new Date(h.getNow() - 500).toISOString(),
      }, 'missing env')
    }
    await sup.pollNow()
    await waitFor(() => h.logTurns.length === 2)
    await flushMicrotasks()

    st = await h.service.state()
    expect(st.logSupervision?.breakers.some(b => b.scope === 'log-app' && b.key === 'order-service' && b.tripped)).toBe(true)
    // E_S2 arrived first (sorted created_at/log_id desc), so E_S1 stays safely in pendingBatches and throttle Feishu card was sent!
    expect(st.logSupervision?.pendingBatches.some(b => b.errorCode === 'E_S1')).toBe(true)
    expect(h.fakeTopics.launched.some(l => l.key.startsWith('log-throttle:'))).toBe(true)
    void throttles

    // 1. Automatic cooldown recovery via polling with ZERO new logs for E_S1!
    h.advanceNow(60 * 60_000 + 1_000)
    await sup.pollNow()
    await waitFor(() => h.logTurns.length === 3)
    st = await h.service.state()
    expect(st.logSupervision?.pendingBatches.some(b => b.errorCode === 'E_S1')).toBe(false)

    // 2. Automatic cooldown recovery via scheduled timer (trippedUntil) with ZERO pollNow() and ZERO resetBreaker()!
    h.advanceNow(1_000)
    const domain = await h.service.supervisorDomain()
    const timerTripUntil = h.getNow() + 40
    await domain.circuitBreakers.put('log:order-service', {
      windowStartAt: h.getNow(),
      triggeredCount: 3,
      events: [h.getNow(), h.getNow(), h.getNow()],
      trippedUntil: timerTripUntil,
      reason: 'simulated timer cooldown',
    })
    for (let i = 1; i <= 5; i += 1) {
      h.fakePlatform.addLog({
        log_id: `timer-cd-${i}`,
        product_code: 'P1',
        component_code: 'order-service',
        error_code: 'E_TIMER',
        file_name: `timer-cd-${i}.log`,
        storage_type: 'fds',
        status: 'completed',
        archived_at: new Date(h.getNow() - 100).toISOString(),
      }, 'missing env')
    }
    await sup.pollNow()
    expect(h.logTurns.length).toBe(3)
    h.advanceNow(50)
    await waitFor(() => h.logTurns.length === 4)

    // 3. Manual resetBreaker immediately unblocks pending E_RESET batch!
    h.advanceNow(1_000)
    await domain.circuitBreakers.put('log:order-service', {
      windowStartAt: h.getNow(),
      triggeredCount: 3,
      events: [h.getNow(), h.getNow(), h.getNow()],
      trippedUntil: h.getNow() + 3_600_000,
      reason: 'simulated manual reset',
    })
    for (let i = 1; i <= 5; i += 1) {
      h.fakePlatform.addLog({
        log_id: `manual-reset-${i}`,
        product_code: 'P1',
        component_code: 'order-service',
        error_code: 'E_RESET',
        file_name: `manual-reset-${i}.log`,
        storage_type: 'fds',
        status: 'completed',
        archived_at: new Date(h.getNow() - 100).toISOString(),
      }, 'missing env')
    }
    await sup.pollNow()
    expect(h.logTurns.length).toBe(4)

    const afterReset = await h.service.resetBreaker({ scope: 'log-app', key: 'order-service' })
    expect(afterReset.logSupervision?.breakers.some(b => b.tripped)).toBe(false)
    await waitFor(() => h.logTurns.length === 5)
  }, 20_000)

  it('supports manual Feishu ZIP diagnosis without platform config AND closes the full fix_code + isolated improve_skill MR loop', async () => {
    const h = await createFullHarness({
      withPlatform: false, // Even when log platform is completely unconfigured!
      withSecondApp: true,
      allowedHosts: ['logs.example.com'],
      fetch: async () => new Response('missing', { status: 404 }),
      onMrTurn: async () => undefined,
    })

    // Seed an existing human-confirmed issue in IssueMemory
    const domain = await h.service.supervisorDomain()
    await domain.issues.upsertByAi({
      issueId: 'ISS-order-service-0001',
      appId: 'order-service',
      title: '历史 NPE 空指针',
      matchCriteria: 'NullPointerException handleOrder',
      aiDiagnosis: '旧判断',
      aiStatus: 'located',
      resolutionAdvice: '检查空值',
      seenAt: 1000,
    })
    await domain.issues.syncHumanFields('ISS-order-service-0001', {
      humanConclusion: '人工已确认：handleOrder 必须返回默认值',
      humanStatus: '待修代码',
    })

    const feishuSessionId = 'feishu-manual-sess-1'
    const workDir = join(h.dir, 'manual-topic-ws')
    await mkdir(workDir, { recursive: true })
    const localZip = join(h.dir, 'user-upload.zip')
    await writeFile(localZip, buildZipBuffer([
      { name: 'service.log', content: '2026-11-12 ERROR NullPointerException at handleOrder\n' },
    ]))

    const prepare = h.toolNamed('supervisor_log_prepare')
    const search = h.toolNamed('supervisor_issue_search')
    const submit = h.toolNamed('supervisor_log_submit')
    const pushMr = h.toolNamed('supervisor_log_push_mr')

    // 1. Prepare manual Feishu ZIP without platform config
    const prepRes = await prepare.execute({
      app: 'order-service',
      logs: [{ path: localZip }],
    }, h.toolExecCtx(feishuSessionId, workDir, 'c-prep')) as {
      readonly taskId: string
      readonly slots: readonly { readonly ref: string }[]
      readonly candidateIssues: readonly { readonly issueId: string; readonly humanConclusion?: string }[]
    }
    expect(prepRes.slots).toHaveLength(1)
    expect(prepRes.candidateIssues[0]?.humanConclusion).toBe('人工已确认：handleOrder 必须返回默认值')

    // 2. Search IssueMemory explicitly
    const searchRes = await search.execute({ query: 'handleOrder', app: 'order-service' }, h.toolExecCtx(feishuSessionId, workDir)) as {
      readonly issues: readonly { readonly issueId: string; readonly humanConclusion?: string }[]
    }
    expect(searchRes.issues[0]?.issueId).toBe('ISS-order-service-0001')

    // 3. Submit validation rejects non-existent evidence path & non-repos code_defect evidence
    await expect(submit.execute({
      summary: 'bad evidence',
      items: [{
        ref: 'L1',
        status: 'diagnosed',
        rootCauseCategory: 'code_defect',
        conclusion: 'NPE',
        evidences: [{ source: 'logs/L1/missing.log', locator: 'L1', excerpt: 'x' }],
      }],
    }, h.toolExecCtx(feishuSessionId, workDir))).rejects.toThrow(/不存在/)

    await expect(submit.execute({
      summary: 'code_defect without repo file',
      items: [{
        ref: 'L1',
        status: 'diagnosed',
        rootCauseCategory: 'code_defect',
        conclusion: 'NPE',
        evidences: [{ source: 'logs/L1/service.log', locator: 'L1', excerpt: 'NullPointerException' }],
      }],
    }, h.toolExecCtx(feishuSessionId, workDir))).rejects.toThrow(/repos\//)

    // 4566593847: Root report.md attachment collides with generated entry -> rejected; nested subdirectory succeeds.
    await mkdir(join(workDir, 'scratch', 'attachments'), { recursive: true })
    await writeFile(join(workDir, 'scratch', 'report.md'), 'colliding root attachment\n')
    await writeFile(join(workDir, 'scratch', 'attachments', 'report.md'), 'nested report attachment\n')
    await expect(submit.execute({
      summary: 'colliding report.md attachment',
      items: [{
        ref: 'L1',
        status: 'diagnosed',
        rootCauseCategory: 'code_defect',
        conclusion: 'handleOrder 返回 null',
        evidences: [
          { source: 'logs/L1/service.log', locator: 'L1', excerpt: 'NullPointerException' },
          { source: 'repos/order-service/src/handler.ts', locator: 'L1', excerpt: 'return null' },
        ],
      }],
      attachments: ['scratch/report.md'],
    }, h.toolExecCtx(feishuSessionId, workDir))).rejects.toThrow(/report\.md/)

    // Valid submit linking ISS-order-service-0001 -> no platform Outbox entries created!
    const submitRes = await submit.execute({
      summary: '确认 handleOrder 空返回值缺陷',
      items: [{
        ref: 'L1',
        status: 'diagnosed',
        rootCauseCategory: 'code_defect',
        conclusion: 'handleOrder 返回 null',
        evidences: [
          { source: 'logs/L1/service.log', locator: 'L1', excerpt: 'NullPointerException' },
          { source: 'repos/order-service/src/handler.ts', locator: 'L1', excerpt: 'return null' },
        ],
        issueLink: { mode: 'existing', issueId: 'ISS-order-service-0001' },
      }],
      attachments: ['scratch/attachments/report.md'],
    }, h.toolExecCtx(feishuSessionId, workDir)) as {
      readonly revision: number
      readonly outboxEnqueued: readonly string[]
    }
    expect(submitRes.revision).toBe(1)
    expect(submitRes.outboxEnqueued).toEqual([])
    expect((await stat(join(workDir, 'report', 'revisions', 'rev-1', 'attachments', 'report.md'))).isFile()).toBe(true)

    // 4. Turn ends -> LogSupervisor posts feishuActions.propose card with [fix_code, improve_skill]
    h.service.logSupervisorInstance()!.onSessionEvent(feishuSessionId, 'turn/end', { reason: { kind: 'completed' } })
    await waitFor(() => h.fakeActions.proposals.length === 1)
    const proposal = h.fakeActions.proposals[0]!
    expect(proposal.actions[0]?.id).toBe('fix_code')
    expect(proposal.actions[0]?.requiredAccess).toBe('code-write')
    expect(proposal.actions[0]?.independent).toBe(true)
    expect(proposal.actions[1]?.id).toBe('improve_skill')
    expect(proposal.actions[1]?.independent).toBe(true)

    // 5. Simulate user clicking [fix_code]: edit repos/order-service/src/handler.ts & call supervisor_log_push_mr
    await writeFile(join(workDir, 'repos', 'order-service', 'src', 'handler.ts'), 'export function handleOrder() { return "ok" }\n')
    const fixPush = await pushMr.execute({
      kind: 'fix_code',
      commitMessage: 'fix(order): avoid returning null in handleOrder',
      mrTitle: 'fix(order): handle empty order safely',
    }, h.toolExecCtx(feishuSessionId, workDir, 'call-fix-mr')) as {
      readonly mrNumber: number
      readonly mrUrl: string
      readonly fixMrLinkedIssueId: string
      readonly mrSupervisionRegistered: boolean
    }
    expect(fixPush.mrSupervisionRegistered).toBe(true)
    expect(fixPush.fixMrLinkedIssueId).toBe('ISS-order-service-0001')
    expect(domain.issues.get('ISS-order-service-0001')?.fixMrUrl).toBe(fixPush.mrUrl)

    // Verify agent & callId were forwarded to dshRepos.workspacePush!
    expect(h.fakeRepos.pushes.at(-1)?.callId).toBe('call-fix-mr')
    expect(h.fakeRepos.pushes.at(-1)?.session).toBe(feishuSessionId)

    // 6. Simulate user independently clicking [improve_skill]: prepare isolated `<slug>-knowledge` workspace & push separate MR!
    await prepare.execute({
      taskId: prepRes.taskId,
      workspace: 'knowledge',
    }, h.toolExecCtx(feishuSessionId, workDir, 'c-prep-kb'))
    await mkdir(join(workDir, 'repos', 'order-service-knowledge', '.agents', 'skills', 'order-triage'), { recursive: true })
    await writeFile(
      join(workDir, 'repos', 'order-service-knowledge', '.agents', 'skills', 'order-triage', 'SKILL.md'),
      '---\nname: order-triage\ndescription: Order log triage\n---\n\n# Case ISS-order-service-0001\n',
    )
    const skillPush = await pushMr.execute({
      kind: 'improve_skill',
      commitMessage: 'docs(skill): document handleOrder NPE triage case',
      mrTitle: 'docs(skill): add handleOrder NPE triage guide',
    }, h.toolExecCtx(feishuSessionId, workDir, 'call-skill-mr')) as {
      readonly mrNumber: number
      readonly workspacePath: string
      readonly mrSupervisionRegistered: boolean
    }
    expect(skillPush.mrSupervisionRegistered).toBe(true)
    expect(skillPush.workspacePath).toContain('order-service-knowledge')
    expect(skillPush.mrNumber).not.toBe(fixPush.mrNumber)

    // Verify both self-fix and self-skill MRs are registered in MrSupervisor without conflict, and CI failure wakes the originating session!
    const mrSup = h.service.mrSupervisorInstance()!
    const st = await h.service.state()
    expect(st.mrSupervision?.mrs.some(m => m.mrNumber === fixPush.mrNumber && m.origin === 'self-fix')).toBe(true)
    expect(st.mrSupervision?.mrs.some(m => m.mrNumber === skillPush.mrNumber && m.origin === 'self-skill')).toBe(true)

    // Inject CI failure on self-fix MR -> MrSupervisor wakes session!
    const storedFix = h.fakeRepos.v8Mrs.get(h.origin)!.get(fixPush.mrNumber)!
    storedFix.status = { headSha: storedFix.info.headSha, overall: 'failure', checks: [{ name: 'unit', state: 'failure' }] }
    storedFix.info = { ...storedFix.info, updatedAt: '2026-11-12T10:05:00Z' }
    await mrSup.pollNow()
    h.advanceNow(1_000)
    await mrSup.flushDebouncedDue()
    await waitFor(() => h.mrTurns.some(t => t.mrNumber === fixPush.mrNumber && t.origin === 'self-fix'))
    expect(h.mrTurns.find(t => t.mrNumber === fixPush.mrNumber)?.prompt).toContain('ci-failed')

    // 7. 4566693290: Failed initial prepare with new logs rolls back cleanly without orphan task/workspace,
    // and supplying another valid manual ZIP in the same session creates an isolated new task/workspace
    // instead of silently reusing Task 1's manifest and revising Task 1.
    await expect(prepare.execute({
      app: 'pay-comp',
      logs: [{ url: 'https://logs.example.com/missing.zip' }],
    }, h.toolExecCtx(feishuSessionId, workDir, 'c-prep-fail-url'))).rejects.toThrow(/404|HTTP/i)
    expect(domain.logTasks.size).toBe(1)

    const secondZip = join(h.dir, 'payment-crash.zip')
    await writeFile(secondZip, buildZipBuffer([
      { name: 'pay.log', content: 'PaymentGatewayTimeout at PayClient:12\n' },
    ]))

    const secondPrep = await prepare.execute({
      app: 'pay-comp',
      logs: [{ path: secondZip }],
    }, h.toolExecCtx(feishuSessionId, workDir, 'c-prep-second')) as {
      readonly taskId: string
      readonly appId: string
      readonly reused: boolean
      readonly workDir: string
      readonly slots: readonly { readonly ref: string; readonly files: readonly string[] }[]
    }
    expect(secondPrep.taskId).not.toBe(prepRes.taskId)
    expect(secondPrep.appId).toBe('payment-service')
    expect(secondPrep.reused).toBe(false)
    expect(secondPrep.workDir).toBe(join(workDir, 'tasks', secondPrep.taskId))
    expect(secondPrep.slots.map(s => s.files)).toEqual([['pay.log']])

    // Switching app without providing new logs rejects clearly instead of silently reusing.
    await expect(prepare.execute({
      app: 'order-service',
    }, h.toolExecCtx(feishuSessionId, workDir, 'c-prep-switch-err'))).rejects.toThrow(/同时传入 logs/)

    const secondSubmit = await submit.execute({
      summary: '支付网关超时定位完成',
      items: [{
        ref: 'L1',
        status: 'diagnosed',
        rootCauseCategory: 'hardware_or_external',
        conclusion: '上游支付网关超时',
        evidences: [{ source: 'logs/L1/pay.log', locator: 'L1', excerpt: 'PaymentGatewayTimeout' }],
      }],
    }, h.toolExecCtx(feishuSessionId, workDir, 'c-sub-second')) as {
      readonly taskId: string
      readonly revision: number
    }
    expect(secondSubmit.taskId).toBe(secondPrep.taskId)
    expect(secondSubmit.revision).toBe(1)
    expect(domain.logTasks.get(prepRes.taskId)?.revisions).toHaveLength(1)
    expect(domain.logTasks.get(secondPrep.taskId)?.revisions).toHaveLength(1)
  }, 20_000)

  it('launches Feishu topic immediately under topic-on-start deliveryMode and prevents symlink follow in unpack', async () => {
    const h = await createFullHarness({
      deliveryMode: 'topic-on-start',
      batchSizeThreshold: 2,
    })

    await h.service.controlLogWatermark({ action: 'rewind', cursorTime: '2026-11-12T09:50:00.000Z' })
    for (let i = 1; i <= 2; i += 1) {
      h.fakePlatform.addLog({
        log_id: `tos-${i}`,
        product_code: 'P1',
        component_code: 'order-service',
        error_code: 'E_LIVE',
        file_name: `tos-${i}.log`,
        storage_type: 'fds',
        status: 'completed',
        archived_at: '2026-11-12T09:55:00.000Z',
      }, 'live log error line\n')
    }

    await h.service.logSupervisorInstance()!.pollNow()
    await waitFor(() => h.fakeTopics.launched.length === 1)
    expect(h.fakeTopics.launched[0]?.card.taskName).toBe('分析')
    expect(h.logTurns.length).toBe(0)

    // Topic executes in live Feishu session & completes
    const launched = h.fakeTopics.launched[0]!
    const liveSess = 'live-feishu-sess-1'
    const liveWs = join(h.dir, 'live-ws')
    await mkdir(liveWs, { recursive: true })
    h.fakeTopics.emitState({
      key: launched.key,
      status: 'running',
      sessionId: liveSess,
      workDir: liveWs,
    })
    await flushMicrotasks()

    const prep = await h.toolNamed('supervisor_log_prepare').execute({}, h.toolExecCtx(liveSess, liveWs)) as {
      readonly slots: readonly { readonly ref: string; readonly files: readonly string[] }[]
    }
    await h.toolNamed('supervisor_log_submit').execute({
      summary: '直播诊断结论：环境变量缺失',
      items: prep.slots.map(s => ({
        ref: s.ref,
        status: 'diagnosed',
        rootCauseCategory: 'config_or_env',
        conclusion: '配置项缺失',
        evidences: [{ source: `logs/${s.ref}/${s.files[0]}`, locator: 'L1', excerpt: 'live log error' }],
      })),
    }, h.toolExecCtx(liveSess, liveWs))

    h.fakeTopics.emitState({
      key: launched.key,
      status: 'done',
      sessionId: liveSess,
      workDir: liveWs,
    })
    await flushMicrotasks()
    expect(h.fakePlatform.revisions.filter(r => r.completed).length).toBe(2)
    expect((await lstat(liveWs)).isDirectory()).toBe(true)
  }, 20_000)

  it('enforces maxConcurrentBatches for topic-on-start until terminal topic state', async () => {
    const h = await createFullHarness({
      deliveryMode: 'topic-on-start',
      batchSizeThreshold: 1,
      maxConcurrentBatches: 1,
    })

    await h.service.controlLogWatermark({ action: 'rewind', cursorTime: '2026-11-12T09:50:00.000Z' })
    h.fakePlatform.addLog({
      log_id: 'conc-1',
      product_code: 'P1',
      component_code: 'order-service',
      error_code: 'E_CONC_1',
      file_name: 'conc-1.log',
      storage_type: 'fds',
      status: 'completed',
      archived_at: '2026-11-12T09:55:00.000Z',
    }, 'err 1\n')
    h.fakePlatform.addLog({
      log_id: 'conc-2',
      product_code: 'P1',
      component_code: 'order-service',
      error_code: 'E_CONC_2',
      file_name: 'conc-2.log',
      storage_type: 'fds',
      status: 'completed',
      archived_at: '2026-11-12T09:55:00.000Z',
    }, 'err 2\n')

    await h.service.logSupervisorInstance()!.pollNow()
    await waitFor(() => h.fakeTopics.launched.length === 1)
    await flushMicrotasks()

    // While topic 1 is still running, topic 2 must remain queued under maxConcurrentBatches=1!
    expect(h.fakeTopics.launched).toHaveLength(1)
    expect((await h.service.state()).logSupervision?.running).toBe(1)

    const liveSess1 = 'live-conc-1'
    const liveWs1 = join(h.dir, 'live-conc-ws-1')
    await mkdir(liveWs1, { recursive: true })
    const launch1 = h.fakeTopics.launched[0]!
    h.fakeTopics.emitState({ key: launch1.key, status: 'running', sessionId: liveSess1, workDir: liveWs1 })
    await flushMicrotasks()
    const prep1 = await h.toolNamed('supervisor_log_prepare').execute({}, h.toolExecCtx(liveSess1, liveWs1)) as {
      readonly slots: readonly { readonly ref: string; readonly files: readonly string[] }[]
    }
    await h.toolNamed('supervisor_log_submit').execute({
      summary: '批次 1 已完成',
      items: prep1.slots.map(s => ({
        ref: s.ref,
        status: 'diagnosed',
        rootCauseCategory: 'config_or_env',
        conclusion: 'ok',
        evidences: [{ source: `logs/${s.ref}/${s.files[0]}`, locator: 'L1', excerpt: 'err' }],
      })),
    }, h.toolExecCtx(liveSess1, liveWs1))
    h.fakeTopics.emitState({ key: launch1.key, status: 'done', sessionId: liveSess1, workDir: liveWs1 })

    // Terminal state releases the pool slot so topic 2 launches immediately.
    await waitFor(() => h.fakeTopics.launched.length === 2)
    expect(h.fakeTopics.launched[1]?.key).not.toBe(launch1.key)
  }, 20_000)

  it('keeps pendingTopicDelivery on transient launch failure and deduplicates crash recovery across log_tasks and pending_batches', async () => {
    const sharedSup = await tempDir()
    cleanups.push(sharedSup.cleanup)
    const settingsPath = join(sharedSup.dir, 'settings.json')

    // 1. First boot saves application configuration to persistent OverlayStore, then shuts down.
    const h1 = await createFullHarness({
      supervisorDir: sharedSup.dir,
      settingsPath,
    })
    const origin = h1.origin
    await h1.service.shutdown()

    // 2. Pre-seed crash state: one persisted platform running task plus an overlapping pending_batches entry
    const seedDomain = await openSupervisorDomain({ fallbackDir: sharedSup.dir })
    const persistedWorkDir = join(sharedSup.dir, 'ws-persisted')
    await mkdir(persistedWorkDir, { recursive: true })
    await seedDomain.logTasks.put('log-crashed-1', {
      source: 'platform',
      appId: 'order-service',
      appName: 'order-service',
      batchKey: 'P1\0order-service\0E_CRASH',
      errorCode: 'E_CRASH',
      workDir: persistedWorkDir,
      deliveryMode: 'quiet-until-done',
      feishuChatId: 'oc_ops_group',
      inputs: [{
        ref: 'L1',
        logId: 'crash-log-1',
        productCode: 'P1',
        componentCode: 'order-service',
        errorCode: 'E_CRASH',
        fileName: 'crash-1.log',
      }],
      status: 'running',
      revisions: [],
      createdAt: 1_000,
      updatedAt: 1_000,
    })
    await seedDomain.logTasks.put('log-missing-outbox-1', {
      source: 'platform',
      appId: 'order-service',
      appName: 'order-service',
      batchKey: 'P1\0order-service\0E_ORPHAN',
      errorCode: 'E_ORPHAN',
      inputs: [{
        ref: 'L1',
        logId: 'orphan-outbox-log-1',
        productCode: 'P1',
        componentCode: 'order-service',
        errorCode: 'E_ORPHAN',
        fileName: 'orphan.log',
      }],
      status: 'completed',
      revisions: [{
        revision: 1,
        summary: '提交后回传前中断',
        createdAt: 1_000,
      }],
      createdAt: 1_000,
      updatedAt: 1_000,
    })
    await seedDomain.pendingBatches.put('P1\0order-service\0E_CRASH', {
      productCode: 'P1',
      componentCode: 'order-service',
      errorCode: 'E_CRASH',
      appId: 'order-service',
      logIds: ['crash-log-1'],
      logs: [{
        ref: 'L1',
        logId: 'crash-log-1',
        productCode: 'P1',
        componentCode: 'order-service',
        errorCode: 'E_CRASH',
        fileName: 'crash-1.log',
      }],
      windowOpenedAt: 1_000,
    })
    await seedDomain.close()

    let failedOnce = false
    const h = await createFullHarness({
      origin,
      settingsPath,
      skipSaveApplication: true,
      supervisorDir: sharedSup.dir,
      batchSizeThreshold: 1,
      setupPlatform: (platform) => {
        platform.addLog({
          log_id: 'crash-log-1',
          product_code: 'P1',
          component_code: 'order-service',
          error_code: 'E_CRASH',
          file_name: 'crash-1.log',
          storage_type: 'fds',
          status: 'completed',
          archived_at: '2026-11-12T09:55:00.000Z',
        }, 'recovered log\n')
        platform.addLog({
          log_id: 'orphan-outbox-log-1',
          product_code: 'P1',
          component_code: 'order-service',
          error_code: 'E_ORPHAN',
          file_name: 'orphan.log',
          storage_type: 'fds',
          status: 'completed',
          archived_at: '2026-11-12T09:55:00.000Z',
        }, 'orphan outbox log\n')
      },
      onLogTurn: async (req) => {
        if (!failedOnce) {
          failedOnce = true
          h.fakeTopics.failNextLaunch = { code: 'not-connected', message: 'bot offline' }
        }
        const prepare = h.toolNamed('supervisor_log_prepare')
        const submit = h.toolNamed('supervisor_log_submit')
        const prepared = await prepare.execute({ taskId: req.taskId }, h.toolExecCtx(req.existingSessionId!, req.workDir)) as {
          readonly slots: readonly { readonly ref: string; readonly files: readonly string[] }[]
        }
        await submit.execute({
          taskId: req.taskId,
          summary: '崩溃恢复后完成诊断',
          items: prepared.slots.map(s => ({
            ref: s.ref,
            status: 'diagnosed',
            rootCauseCategory: 'config_or_env',
            conclusion: 'recovered diagnosis',
            evidences: [{ source: `logs/${s.ref}/${s.files[0]}`, locator: 'L1', excerpt: 'recovered log' }],
          })),
        }, h.toolExecCtx(req.existingSessionId!, req.workDir))
      },
    })

    // Boot reconciled missing outbox row for completed platform revision and uploaded it!
    await waitFor(() => h.fakePlatform.revisions.some(r => r.key === 'log-missing-outbox-1:rev1:orphan-outbox-log-1' && r.completed))

    // Recovered task ran once without duplicating pending_batches!
    await waitFor(() => h.logTurns.length === 1)
    const domainAfter = await h.service.supervisorDomain()
    await waitFor(() => domainAfter.logTasks.get('log-crashed-1')?.status === 'completed')
    expect(domainAfter.logTasks.keys().sort()).toEqual(['log-crashed-1', 'log-missing-outbox-1'])
    expect(domainAfter.pendingBatches.size).toBe(0)

    // Initial launch returned not-connected -> pendingTopicDelivery stayed true until retry succeeded!
    await waitFor(() => h.fakeTopics.failedLaunches === 1)
    expect(h.fakeTopics.launched).toHaveLength(0)
    expect(domainAfter.logTasks.get('log-crashed-1')?.pendingTopicDelivery).toBe(true)

    await h.service.topicsAvailable()
    await waitFor(() => h.fakeTopics.launched.length === 1)
    expect(domainAfter.logTasks.get('log-crashed-1')?.pendingTopicDelivery).toBeUndefined()
    expect(domainAfter.logTasks.get('log-crashed-1')?.feishuLaunchKey).toBe('log-task:log-crashed-1')
  }, 20_000)

  it('serializes concurrent task submissions, preserves mid-poll watermark rewinds, and fails thrown turns cleanly for rewind recovery', async () => {
    let logsCallStarted = false
    let logsFetchGate: (() => void) | undefined
    let throwFirstTurn = false

    const interceptedFetch: typeof fetch = async (input, init) => {
      const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (!logsCallStarted && urlStr.includes('/open-api/v1/logs?')) {
        logsCallStarted = true
        await new Promise<void>((resolve) => {
          logsFetchGate = resolve
        })
      }
      return await fetch(input, init)
    }

    const h = await createFullHarness({
      batchSizeThreshold: 1,
      fetch: interceptedFetch,
      onLogTurn: async (req) => {
        if (throwFirstTurn) {
          throwFirstTurn = false
          throw new Error('sessionController prompt rejected')
        }
        const prepare = h.toolNamed('supervisor_log_prepare')
        const submit = h.toolNamed('supervisor_log_submit')
        const prepared = await prepare.execute({ taskId: req.taskId }, h.toolExecCtx(req.existingSessionId!, req.workDir)) as {
          readonly slots: readonly { readonly ref: string; readonly files: readonly string[] }[]
        }
        await submit.execute({
          taskId: req.taskId,
          summary: '诊断恢复完成',
          items: prepared.slots.map(s => ({
            ref: s.ref,
            status: 'diagnosed',
            rootCauseCategory: 'config_or_env',
            conclusion: 'recovered after rewind or retry',
            evidences: [{ source: `logs/${s.ref}/${s.files[0]}`, locator: 'L1', excerpt: 'error' }],
          })),
        }, h.toolExecCtx(req.existingSessionId!, req.workDir))
      },
    })

    // Scenario A (4566335176): Two overlapping supervisor_log_submit calls on the same task allocate distinct revisions [1, 2] without clobbering attachments!
    const concurrentSess = 'feishu-concurrent-submit'
    const concurrentWs = join(h.dir, 'concurrent-ws')
    await mkdir(join(concurrentWs, 'scratch'), { recursive: true })
    const concurrentZip = join(h.dir, 'concurrent.zip')
    await writeFile(concurrentZip, buildZipBuffer([{ name: 'app.log', content: 'concurrent submit log\n' }]))

    const prepare = h.toolNamed('supervisor_log_prepare')
    const submit = h.toolNamed('supervisor_log_submit')
    const prepConcurrent = await prepare.execute({
      app: 'order-service',
      logs: [{ path: concurrentZip }],
    }, h.toolExecCtx(concurrentSess, concurrentWs, 'c-prep-conc')) as {
      readonly taskId: string
      readonly slots: readonly { readonly ref: string; readonly files: readonly string[] }[]
    }
    await writeFile(join(concurrentWs, 'scratch', 'att-a.txt'), 'attachment A\n')
    await writeFile(join(concurrentWs, 'scratch', 'att-b.txt'), 'attachment B\n')

    const makeSubmitPayload = (attachment: string, summary: string) => ({
      taskId: prepConcurrent.taskId,
      summary,
      items: prepConcurrent.slots.map(s => ({
        ref: s.ref,
        status: 'diagnosed',
        rootCauseCategory: 'config_or_env',
        conclusion: summary,
        evidences: [{ source: `logs/${s.ref}/${s.files[0]}`, locator: 'L1', excerpt: 'concurrent submit' }],
      })),
      attachments: [attachment],
    })
    const [resA, resB] = await Promise.all([
      submit.execute(makeSubmitPayload('scratch/att-a.txt', 'submission A'), h.toolExecCtx(concurrentSess, concurrentWs, 'c-sub-a')),
      submit.execute(makeSubmitPayload('scratch/att-b.txt', 'submission B'), h.toolExecCtx(concurrentSess, concurrentWs, 'c-sub-b')),
    ]) as [
      { readonly revision: number },
      { readonly revision: number },
    ]
    expect([resA.revision, resB.revision].sort((a, b) => a - b)).toEqual([1, 2])
    const revDir1 = join(concurrentWs, 'report', 'revisions', 'rev-1')
    const revDir2 = join(concurrentWs, 'report', 'revisions', 'rev-2')
    const attFile1 = resA.revision === 1 ? 'att-a.txt' : 'att-b.txt'
    const attFile2 = resA.revision === 2 ? 'att-a.txt' : 'att-b.txt'
    expect((await stat(join(revDir1, attFile1))).isFile()).toBe(true)
    expect((await stat(join(revDir2, attFile2))).isFile()).toBe(true)

    // Scenario B (4566335182): Mid-poll watermark rewind is preserved and backfills the rewound interval!
    const sup = h.service.logSupervisorInstance()!
    const inFlightPoll = sup.pollNow()
    await waitFor(() => logsFetchGate !== undefined)

    h.fakePlatform.addLog({
      log_id: 'rewind-midpoll-1',
      product_code: 'P1',
      component_code: 'order-service',
      error_code: 'E_REWIND',
      file_name: 'rewind-midpoll.log',
      storage_type: 'fds',
      status: 'completed',
      archived_at: '2026-11-12T09:30:00.000Z',
    }, 'mid-poll rewind error\n')
    await h.service.controlLogWatermark({ action: 'rewind', cursorTime: '2026-11-12T09:25:00.000Z' })
    logsFetchGate!()
    await inFlightPoll

    await waitFor(() => h.logTurns.length === 1)
    const domain = await h.service.supervisorDomain()
    await waitFor(() => {
      const midPollTask = domain.logTasks.entries().find(([, t]) => t.inputs.some(i => i.logId === 'rewind-midpoll-1'))
      return midPollTask?.[1].status === 'completed'
    })
    await waitFor(async () => h.fakeTopics.launched.length >= 1 && (await h.service.state()).logSupervision?.running === 0)

    // Scenario C (4566335190): Non-shutdown exception from sessionDriver.runTurn transitions task to 'failed' (never stuck 'running'), and rewind recovers it!
    throwFirstTurn = true
    h.advanceNow(10_000)
    h.fakePlatform.addLog({
      log_id: 'thrown-turn-1',
      product_code: 'P1',
      component_code: 'order-service',
      error_code: 'E_THROW',
      file_name: 'thrown-turn.log',
      storage_type: 'fds',
      status: 'completed',
      archived_at: new Date(h.getNow() - 500).toISOString(),
    }, 'thrown turn log\n')
    await sup.pollNow()

    await waitFor(() => {
      const failedEntry = domain.logTasks.entries().find(([, t]) => t.inputs.some(i => i.logId === 'thrown-turn-1'))
      return failedEntry?.[1].status === 'failed'
    })
    const failedTask = domain.logTasks.entries().find(([, t]) => t.inputs.some(i => i.logId === 'thrown-turn-1'))![1]
    expect(failedTask.lastError).toContain('sessionController prompt rejected')
    await waitFor(async () => (await h.service.state()).logSupervision?.running === 0)
    expect((await h.service.state()).logSupervision?.running).toBe(0)

    // Rewinding watermark across thrown-turn-1's archived_at re-ingests and recovers it cleanly.
    await h.service.controlLogWatermark({
      action: 'rewind',
      cursorTime: new Date(h.getNow() - 2_000).toISOString(),
    })
    await sup.pollNow()
    await waitFor(() => domain.logTasks.entries().some(
      ([, t]) => t.inputs.some(i => i.logId === 'thrown-turn-1') && t.status === 'completed',
    ))
    await waitFor(async () => h.fakeTopics.launched.length >= 2 && (await h.service.state()).logSupervision?.running === 0)
  }, 20_000)

  it('persists initial polling boundary before first request and transfers Phase-1 workspace to quiet-done follow-up topic', async () => {
    let phase1TaskId = ''
    let phase1WorkDir = ''

    const h = await createFullHarness({
      batchSizeThreshold: 1,
      deliveryMode: 'quiet-until-done',
      onLogTurn: async (req) => {
        phase1TaskId = req.taskId
        phase1WorkDir = req.workDir
        const prepare = h.toolNamed('supervisor_log_prepare')
        const submit = h.toolNamed('supervisor_log_submit')
        const prepared = await prepare.execute({ taskId: req.taskId }, h.toolExecCtx(req.existingSessionId!, req.workDir)) as {
          readonly slots: readonly { readonly ref: string; readonly files: readonly string[] }[]
        }
        await writeFile(join(req.workDir, 'scratch', 'phase1-trace.txt'), 'phase1 root cause notes\n')
        await submit.execute({
          taskId: req.taskId,
          summary: '静默诊断结论完成',
          items: prepared.slots.map(s => ({
            ref: s.ref,
            status: 'diagnosed',
            rootCauseCategory: 'config_or_env',
            conclusion: 'phase 1 root cause confirmed',
            evidences: [{ source: `logs/${s.ref}/${s.files[0]}`, locator: 'L1', excerpt: 'initial boundary error' }],
          })),
        }, h.toolExecCtx(req.existingSessionId!, req.workDir))
      },
    })

    // 4566478093: Initial poll fails on first request -> lower boundary 09:59:00Z is already persisted,
    // so retrying minutes later still captures archived logs inside [09:59:00Z, 10:00:00Z) without skipping.
    h.fakePlatform.addLog({
      log_id: 'first-boundary-1',
      product_code: 'P1',
      component_code: 'order-service',
      error_code: 'E_INIT_POLL',
      file_name: 'first-boundary.log',
      storage_type: 'fds',
      status: 'completed',
      archived_at: '2026-11-12T09:59:30.000Z',
    }, 'initial boundary error\n')

    const sup = h.service.logSupervisorInstance()!
    h.fakePlatform.fail('logs', 502)
    await sup.pollNow()

    const failedWmState = await h.service.state()
    expect(failedWmState.logSupervision?.watermark?.cursorTime).toBe('2026-11-12T09:59:00.000Z')
    expect(failedWmState.logSupervision?.watermark?.consecutiveFailures).toBe(1)

    h.advanceNow(180_000)
    await sup.pollNow()
    await waitFor(async () => h.fakeTopics.launched.length === 1 && (await h.service.state()).logSupervision?.running === 0)
    expect(phase1TaskId).not.toBe('')

    // 4566478102: Quiet-done Feishu topic runs in a new directory -> Phase-1 workDir stays preserved until
    // supervisor_log_prepare transfers logs/ and scratch/ to followupWs without re-downloading.
    const launch = h.fakeTopics.launched[0]!
    const followupSess = 'feishu-quiet-followup-1'
    const followupWs = join(h.dir, 'feishu-quiet-followup-ws')
    await mkdir(followupWs, { recursive: true })

    h.fakeTopics.emitState({ key: launch.key, status: 'running', sessionId: followupSess, workDir: followupWs })
    h.fakeTopics.emitState({ key: launch.key, status: 'done', sessionId: followupSess, workDir: followupWs })
    await flushMicrotasks()

    const domain = await h.service.supervisorDomain()
    expect(domain.logTasks.get(phase1TaskId)?.workDir).toBe(phase1WorkDir)

    h.fakePlatform.fail('download', 404)
    const followupPrep = await h.toolNamed('supervisor_log_prepare').execute({}, h.toolExecCtx(followupSess, followupWs)) as {
      readonly reused: boolean
      readonly workDir: string
    }
    expect(followupPrep.reused).toBe(true)
    expect(followupPrep.workDir).toBe(followupWs)
    expect(await readFile(join(followupWs, 'scratch', 'phase1-trace.txt'), 'utf8')).toBe('phase1 root cause notes\n')
    expect((await stat(join(followupWs, 'logs', 'manifest.json'))).isFile()).toBe(true)
    expect(domain.logTasks.get(phase1TaskId)?.workDir).toBe(followupWs)
  }, 20_000)
})
