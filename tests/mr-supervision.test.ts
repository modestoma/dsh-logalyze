import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
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
import type { HostContext, ToolActivationContext, ToolDefinition } from '../src/host.ts'
import { MrSupervisor, createHostMrSessionDriver } from '../src/mr/index.ts'
import {
  MAX_SEEN_NOTE_IDS,
  advanceHumanNoteWatermark,
  classifyMrPollUpdate,
  isSameBotUser,
  normalizeBotHandle,
} from '../src/mr/signals.ts'
import type { MrSessionDriver, MrSessionTurnRequest } from '../src/mr/session-driver.ts'
import { resolveConfig } from '../src/config.ts'
import { CircuitBreakerRegistry } from '../src/runtime/breaker.ts'
import { openSupervisorDomain, supervisedMrKey } from '../src/runtime/domain.ts'
import { createSupervisionPools } from '../src/runtime/pool.ts'
import { LogalyzeService } from '../src/service.ts'
import type { StateWire } from '../src/settings/contract.ts'
import { OverlayStore } from '../src/settings/overlay.ts'
import { loadBundledSkills } from '../src/skill/bundled.ts'
import {
  MR_CHECKPOINT_TOOL_NAME,
  MR_PREPARE_TOOL_NAME,
  MR_PUBLISH_REVIEW_TOOL_NAME,
  MR_REPLY_THREAD_TOOL_NAME,
  MR_RESOLVE_THREAD_TOOL_NAME,
} from '../src/tool-names.ts'
import { FakeRepos } from './fake-repos.ts'
import { createAppRepo, tempDir } from './helpers.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(fn => fn()))
})

interface StoredFakeMr {
  info: MrInfo
  comments: CommentInfo[]
  discussions: MrDiscussion[]
  status: MrStatus
  diff: string
  compareDiffs: Map<string, string>
}

function makeMr(repoUrl: string, num: number, overrides: Partial<MrInfo> = {}): MrInfo {
  return {
    number: num,
    title: `MR #${num}`,
    body: `Description for MR #${num}`,
    state: 'open',
    draft: false,
    sourceBranch: `feat/mr-${num}`,
    targetBranch: 'main',
    headSha: `sha-mr-${num}-v1`,
    author: { username: 'alice' },
    labels: [],
    assignees: [],
    createdAt: '2026-11-01T00:00:00Z',
    updatedAt: '2026-11-01T00:01:00Z',
    webUrl: `https://git.example/org/app/pull/${num}`,
    ...overrides,
  }
}

class FakeReposV8 {
  readonly base: FakeRepos
  botUser: RepoUser = { username: 'dsh-bot', webUrl: 'https://git.example/dsh-bot' }
  failCurrentBotUser = false
  readonly mrs = new Map<string, Map<number, StoredFakeMr>>()
  readonly mrListCalls: MrListParams[] = []
  readonly reviewCalls: MrReviewParams[] = []
  readonly replyCalls: { discussionId: string; body: string }[] = []
  readonly resolveCalls: { discussionId: string; resolved: boolean }[] = []
  mrGetCalls = 0
  onMrGet?: (params: { readonly repo: string; readonly number: number; readonly callIndex: number }) => Promise<void> | void
  private noteSeq = 100

  constructor(dir: string) {
    this.base = new FakeRepos(dir)
  }

  upsertMr(repo: string, num: number, mr: Partial<MrInfo> = {}, extra: Partial<Omit<StoredFakeMr, 'info'>> = {}): StoredFakeMr {
    let repoMap = this.mrs.get(repo)
    if (repoMap === undefined) {
      repoMap = new Map()
      this.mrs.set(repo, repoMap)
    }
    const existing = repoMap.get(num)
    const info: MrInfo = makeMr(repo, num, { ...(existing?.info ?? {}), ...mr })
    const stored: StoredFakeMr = {
      info,
      comments: extra.comments ?? existing?.comments ?? [],
      discussions: extra.discussions ?? existing?.discussions ?? [],
      status: extra.status ?? existing?.status ?? { headSha: info.headSha, checks: [], overall: 'success', mergeable: true },
      diff: extra.diff ?? existing?.diff ?? `diff --git a/src/a.ts b/src/a.ts\n+console.log(${num})\n`,
      compareDiffs: extra.compareDiffs ?? existing?.compareDiffs ?? new Map(),
    }
    repoMap.set(num, stored)
    return stored
  }

  service(): DshReposV8 {
    const base = this.base
    return {
      version: 8,
      repoList: params => base.repoList(params),
      featureRegister: feature => base.featureRegister(feature),
      repoOnChange: listener => base.repoOnChange(listener),
      settingsGet: () => base.settingsGet(),
      hostOnChange: listener => base.hostOnChange(listener),
      snapshotAcquire: params => base.snapshotAcquire(params),
      workspaceCreate: params => base.workspaceCreate(params),
      workspaceStatus: params => base.workspaceStatus(params),
      workspacePush: params => base.workspacePush(params),
      currentBotUser: async () => {
        if (this.failCurrentBotUser) throw new Error('token expired')
        return this.botUser
      },
      mrList: async (params) => {
        this.mrListCalls.push(params)
        const list = [...(this.mrs.get(params.repo)?.values() ?? [])]
          .map(entry => entry.info)
          .filter(item => params.state === 'all' || params.state === undefined || item.state === params.state)
          .filter(item => params.targetBranch === undefined || item.targetBranch === params.targetBranch)
          .filter(item => params.updatedAfter === undefined || item.updatedAt >= params.updatedAfter)
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        const page = Math.max(1, params.page ?? 1)
        const perPage = Math.max(1, params.perPage ?? 50)
        const start = (page - 1) * perPage
        const items = list.slice(start, start + perPage)
        const nextPage = start + perPage < list.length ? page + 1 : undefined
        return {
          items,
          ...(nextPage === undefined ? {} : { nextPage }),
        }
      },
      mrGet: async ({ repo, number }) => {
        this.mrGetCalls += 1
        if (this.onMrGet !== undefined) {
          await this.onMrGet({ repo, number, callIndex: this.mrGetCalls })
        }
        const found = this.mrs.get(repo)?.get(number)
        if (found === undefined) throw new Error(`MR ${repo}#${number} not found`)
        const detail: MrDetail = { ...found.info, comments: found.comments }
        return detail
      },
      mrDiff: async ({ repo, number }) => {
        const found = this.mrs.get(repo)?.get(number)
        if (found === undefined) throw new Error(`MR ${repo}#${number} not found`)
        return { diff: found.diff, truncated: false }
      },
      mrCompare: async ({ repo, baseSha, headSha }) => {
        const repoMap = this.mrs.get(repo)
        for (const entry of repoMap?.values() ?? []) {
          const cmp = entry.compareDiffs.get(`${baseSha}..${headSha}`)
          if (cmp !== undefined) return { diff: cmp, truncated: false }
        }
        return { diff: `diff ${baseSha}..${headSha}`, truncated: false }
      },
      mrStatus: async ({ repo, number }) => {
        const found = this.mrs.get(repo)?.get(number)
        if (found === undefined) throw new Error(`MR ${repo}#${number} not found`)
        return found.status
      },
      mrDiscussions: async ({ repo, number, onlyUnresolved }) => {
        const found = this.mrs.get(repo)?.get(number)
        if (found === undefined) throw new Error(`MR ${repo}#${number} not found`)
        const items = onlyUnresolved ? found.discussions.filter(d => d.resolvable && !d.resolved) : found.discussions
        return { items }
      },
      mrReview: async (params) => {
        this.reviewCalls.push(params)
        const found = this.mrs.get(params.repo)?.get(params.number)
        if (found === undefined) throw new Error(`MR ${params.repo}#${params.number} not found`)
        this.noteSeq += 1
        const noteId = `bot-review-${this.noteSeq}`
        const createdAt = `2026-11-01T00:05:${String(this.noteSeq % 60).padStart(2, '0')}Z`
        found.comments.push({
          id: noteId,
          author: this.botUser,
          body: params.body ?? '',
          createdAt,
        })
        for (const [idx, c] of (params.comments ?? []).entries()) {
          this.noteSeq += 1
          found.discussions.push({
            id: `disc-bot-${this.noteSeq}`,
            inline: true,
            position: { path: c.path, ...(c.newLine === undefined ? {} : { newLine: c.newLine }), ...(c.oldLine === undefined ? {} : { oldLine: c.oldLine }) },
            resolvable: true,
            resolved: false,
            notes: [{
              id: `note-bot-${this.noteSeq}-${idx}`,
              author: this.botUser,
              body: c.body,
              createdAt,
            }],
          })
        }
        return {
          verdict: params.verdict,
          postedComments: params.comments?.length ?? 0,
          fallbackInlineCount: 0,
        }
      },
      mrDiscussionReply: async (params) => {
        this.replyCalls.push({ discussionId: params.discussionId, body: params.body })
        const found = this.mrs.get(params.repo)?.get(params.number)
        const threadIdx = found?.discussions.findIndex(d => d.id === params.discussionId) ?? -1
        this.noteSeq += 1
        const note = {
          id: `note-reply-${this.noteSeq}`,
          author: this.botUser,
          body: params.body,
          createdAt: `2026-11-01T00:06:${String(this.noteSeq % 60).padStart(2, '0')}Z`,
        }
        if (found !== undefined && threadIdx >= 0) {
          const thread = found.discussions[threadIdx]!
          found.discussions[threadIdx] = {
            ...thread,
            notes: [...thread.notes, note],
          }
        }
        return note
      },
      mrDiscussionResolve: async (params) => {
        this.resolveCalls.push({ discussionId: params.discussionId, resolved: params.resolved })
        const found = this.mrs.get(params.repo)?.get(params.number)
        const thread = found?.discussions.find(d => d.id === params.discussionId)
        if (thread !== undefined) {
          (thread as { resolved: boolean }).resolved = params.resolved
        }
        return { resolved: params.resolved }
      },
    }
  }
}

async function createServiceHarness(options: {
  readonly fakeV8: FakeReposV8
  readonly dir: string
  readonly clock?: () => number
  readonly mrConfig?: Record<string, unknown>
  readonly driver: MrSessionDriver
}) {
  const routes = new Map<string, (req: IncomingMessage, res: ServerResponse) => void | Promise<void>>()
  const tools = new Map<string, { definition: ToolDefinition<unknown>; when?: (context: ToolActivationContext) => boolean | Promise<boolean> }>()
  const webServer = {
    register: (route: { path: string; handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }) => {
      routes.set(route.path, route.handler)
      return () => { routes.delete(route.path) }
    },
  }
  const connection = { requestRejection: () => undefined }
  const dshRepos = options.fakeV8.service()

  const ctx: HostContext = {
    tools: {
      register: (definition, regOpts) => {
        tools.set(definition.name, { definition: definition as ToolDefinition<unknown>, when: regOpts?.when })
        return () => { tools.delete(definition.name) }
      },
    },
    skills: {
      registerProvider: () => () => {},
    },
    subagents: {
      getProvider: () => ({}),
      resolveMaxDepth: () => 1,
      startActivation: () => Promise.reject(new Error('not used')),
    },
    get: (name: string) => {
      if (name === DSH_REPOS_SERVICE) return dshRepos
      if (name === 'webServer') return webServer
      if (name === 'connection') return connection
      return undefined
    },
    on: () => () => {},
    effect: (cb) => {
      const clean = cb()
      return () => { void clean?.() }
    },
  }

  let httpServer: Server | undefined
  let baseUrl = ''
  const config = resolveConfig(options.mrConfig === undefined ? {} : { mrReview: options.mrConfig })
  const bundled = loadBundledSkills(new URL('../skills/', import.meta.url))
  const service = new LogalyzeService(
    ctx,
    config,
    new OverlayStore(join(options.dir, 'settings.json')),
    { bundled },
    {
      supervisorDir: join(options.dir, 'supervisor'),
      mrWorkspacesDir: join(options.dir, 'mr-workspaces'),
      mrSessionDriver: options.driver,
      now: options.clock,
      autoMrPollTimer: false,
    },
  )

  const { mountSettingsRoutes } = await import('../src/settings/routes.ts')
  service.registerSkill()
  service.registerTools()
  mountSettingsRoutes(ctx, service)
  await service.boot()
  const unwatchRepos = service.watchRepos(dshRepos)

  httpServer = createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
    const handler = routes.get(pathname)
    if (handler === undefined) {
      res.statusCode = 404
      res.end()
      return
    }
    void handler(req, res)
  })
  await new Promise<void>(resolve => httpServer!.listen(0, '127.0.0.1', resolve))
  const addr = httpServer.address() as { port: number }
  baseUrl = `http://127.0.0.1:${addr.port}`

  const callTool = async (name: string, args: unknown, sessionId: string, delegationDepth?: number) => {
    const entry = tools.get(name)
    if (entry === undefined) throw new Error(`Tool ${name} not registered`)
    const agent = { id: sessionId, session: { header: { id: sessionId, ...(delegationDepth === undefined ? {} : { delegationDepth }) } } }
    if (entry.when !== undefined) {
      const allowed = await entry.when({ agent, signal: new AbortController().signal })
      if (!allowed) throw new Error(`Tool ${name} is not active for session ${sessionId}`)
    }
    return entry.definition.execute(args, { agent, signal: new AbortController().signal })
  }

  const dispose = async () => {
    unwatchRepos()
    await service.shutdown()
    await new Promise<void>(resolve => httpServer?.close(() => resolve()))
  }

  return { service, tools, callTool, baseUrl, dispose }
}

describe('MR signal helpers & bot normalization', () => {
  it('normalizes GitHub App [bot] handles and case-insensitive usernames', () => {
    expect(normalizeBotHandle('Dsh-Bot[bot]')).toBe('dsh-bot')
    expect(isSameBotUser({ username: 'DSH-BOT[bot]' }, { username: 'dsh-bot' })).toBe(true)
    expect(isSameBotUser({ username: 'other', webUrl: 'https://git.example/dsh-bot' }, { username: 'dsh-bot', webUrl: 'https://git.example/dsh-bot' })).toBe(true)
    expect(isSameBotUser({ username: 'human-dev' }, { username: 'dsh-bot' })).toBe(false)
  })

  it('skips draft and ignored labels and detects ready-for-review transitions', () => {
    const repo = { url: 'git@x/a.git', writable: true }
    const settings = { skipDraft: true, ignoreLabels: ['no-ai-review'] }
    const mrDraft = makeMr('git@x/a.git', 1, { draft: true })
    const detailDraft: MrDetail = { ...mrDraft, comments: [] }
    const status: MrStatus = { headSha: mrDraft.headSha, checks: [], overall: 'success', mergeable: true }

    const res1 = classifyMrPollUpdate({
      existing: undefined,
      mr: mrDraft,
      detail: detailDraft,
      discussions: [],
      status,
      bot: { username: 'bot' },
      repo,
      settings,
      nowMs: 1000,
    })
    expect(res1.nextState).toBe('draft_skipped')
    expect(res1.signals).toEqual([])

    const mrIgnored = makeMr('git@x/a.git', 2, { labels: ['NO-AI-REVIEW'] })
    const resIgnored = classifyMrPollUpdate({
      existing: undefined,
      mr: mrIgnored,
      detail: { ...mrIgnored, comments: [] },
      discussions: [],
      status,
      bot: { username: 'bot' },
      repo,
      settings,
      nowMs: 1000,
    })
    expect(resIgnored.action).toBe('skip')
  })

  it('excludes in-flight deliveredNoteIds from duplicate feedback signals while accepting genuinely new notes', () => {
    const repo = { url: 'git@x/a.git', writable: true }
    const settings = { skipDraft: true, ignoreLabels: [] }
    const mr = makeMr('git@x/a.git', 3)
    const detail: MrDetail = { ...mr, comments: [] }
    const status: MrStatus = { headSha: mr.headSha, checks: [], overall: 'success', mergeable: true }
    const discussions: MrDiscussion[] = [{
      id: 'disc-1',
      inline: true,
      position: { path: 'src/a.ts', newLine: 3 },
      resolvable: true,
      resolved: false,
      notes: [
        { id: 'note-1', author: { username: 'alice' }, body: 'Already delivered to running turn', createdAt: '2026-11-01T00:02:00Z' },
        { id: 'note-2', author: { username: 'bob' }, body: 'Arrived mid-turn', createdAt: '2026-11-01T00:03:00Z' },
      ],
    }]

    const res = classifyMrPollUpdate({
      existing: {
        repo: 'git@x/a.git',
        mrNumber: 3,
        origin: 'external',
        state: 'open',
        headSha: mr.headSha,
        lastReviewedSha: mr.headSha,
        ownPushedShas: [],
        autoFixAttempts: 0,
        pendingSignals: [],
        seenNoteIds: [],
        deliveredNoteIds: ['d:disc-1:note-1'],
      },
      mr,
      detail,
      discussions,
      status,
      bot: { username: 'bot' },
      repo,
      settings,
      nowMs: 2000,
    })

    expect(res.signals.map(s => s.noteId)).toEqual(['note-2'])
  })
})

describe('MrSupervisor end-to-end stateful supervision loop', () => {
  it('runs initial review, prevents bot self-triggers, preserves mid-turn human comments, and reuses the same session on coalesced updates', async () => {
    const { dir, cleanup } = await tempDir('logalyze-mr-e2e-')
    cleanups.push(cleanup)
    const origin = await createAppRepo(join(dir, 'repo-origin'))
    const fakeV8 = new FakeReposV8(join(dir, 'repos'))
    fakeV8.base.catalog = [{
      id: 'r1',
      url: origin,
      base: 'main',
      access: 'write',
      features: [{ id: 'mr-review' }],
    }]

    let clockMs = 1_000_000
    const turns: MrSessionTurnRequest[] = []
    let h!: Awaited<ReturnType<typeof createServiceHarness>>

    let midTurnHumanInjected = false
    const driver: MrSessionDriver = {
      async runTurn(req) {
        turns.push(req)
        const sessionId = req.existingSessionId ?? `mr-sess-${turns.length}`
        await req.onSessionBound?.(sessionId)

        if (turns.length === 1) {
          await h.callTool(MR_PREPARE_TOOL_NAME, {}, sessionId)
          // Inject a fresh human comment MID-TURN before publish_review finishes!
          if (!midTurnHumanInjected) {
            midTurnHumanInjected = true
            const entry = fakeV8.mrs.get(origin)!.get(10)!
            entry.discussions.push({
              id: 'disc-human-midturn',
              inline: true,
              position: { path: 'src/a.ts', newLine: 1 },
              resolvable: true,
              resolved: false,
              notes: [{
                id: 'note-mid-1',
                author: { username: 'bob' },
                body: 'Why is this line changed?',
                createdAt: '2026-11-01T00:05:30Z',
              }],
            })
            entry.info = { ...entry.info, updatedAt: '2026-11-01T00:05:30Z' }
          }
          await h.callTool(MR_PUBLISH_REVIEW_TOOL_NAME, {
            headSha: 'sha-mr-10-v1',
            verdict: 'comment',
            body: 'Initial review',
            comments: [{ path: 'src/a.ts', newLine: 1, body: 'Bot nit' }],
          }, sessionId)
        } else if (turns.length === 2) {
          await h.callTool(MR_PREPARE_TOOL_NAME, {}, sessionId)
          await h.callTool(MR_REPLY_THREAD_TOOL_NAME, {
            discussionId: 'disc-human-midturn',
            body: 'Good point, documented.',
          }, sessionId)
          await h.callTool(MR_CHECKPOINT_TOOL_NAME, {
            markDeliveredNotesSeen: true,
          }, sessionId)
        } else if (turns.length === 3) {
          const prep = await h.callTool(MR_PREPARE_TOOL_NAME, {}, sessionId) as { incrementalDiff?: string }
          expect(prep.incrementalDiff).toContain('incremental')
          await h.callTool(MR_RESOLVE_THREAD_TOOL_NAME, { discussionId: 'disc-human-midturn', resolved: true }, sessionId)
          await h.callTool(MR_PUBLISH_REVIEW_TOOL_NAME, {
            headSha: 'sha-mr-10-v2',
            verdict: 'approve',
            body: 'LGTM now',
          }, sessionId)
        }

        return { sessionId }
      },
    }

    const mr10 = fakeV8.upsertMr(origin, 10, {
      headSha: 'sha-mr-10-v1',
      targetBranch: 'main',
      updatedAt: '2026-11-01T00:01:00Z',
    })
    mr10.compareDiffs.set('sha-mr-10-v1..sha-mr-10-v2', '+incremental fix')

    h = await createServiceHarness({
      fakeV8,
      dir,
      clock: () => clockMs,
      mrConfig: { debounceMs: 5000, pollIntervalMs: 1000 },
      driver,
    })
    cleanups.push(h.dispose)

    const supervisor = h.service.mrSupervisorInstance()!
    // Verify MR tools are hidden on unrelated sessions!
    await expect(h.callTool(MR_PREPARE_TOOL_NAME, {}, 'unrelated-session')).rejects.toThrow(/not active/)

    // First poll discovers MR #10 -> buffered in debounce window.
    await supervisor.pollNow()
    expect(turns.length).toBe(0)

    // Advance past debounce window -> Turn 1 runs!
    clockMs += 6000
    await supervisor.flushDebouncedDue()
    expect(turns.length).toBe(1)
    expect(turns[0]?.prompt).toContain('首次评审')
    expect(fakeV8.reviewCalls).toHaveLength(1)

    // Second poll: bot's own comments MUST be ignored, while mid-turn human comment MUST trigger!
    clockMs += 1000
    await supervisor.pollNow()
    expect(turns.length).toBe(1)
    clockMs += 6000
    await supervisor.flushDebouncedDue()
    expect(turns.length).toBe(2)
    expect(turns[1]?.existingSessionId).toBe('mr-sess-1')
    expect(turns[1]?.prompt).toContain('Why is this line changed?')
    expect(fakeV8.replyCalls).toEqual([{ discussionId: 'disc-human-midturn', body: 'Good point, documented.' }])

    // Third poll with no external changes -> zero triggers (bot reply ignored!).
    clockMs += 10_000
    await supervisor.pollNow()
    await supervisor.flushDebouncedDue()
    expect(turns.length).toBe(2)

    // Coalesce push + discussion note within debounce window -> single Turn 3 in same session!
    mr10.info = { ...mr10.info, headSha: 'sha-mr-10-v2', updatedAt: '2026-11-01T00:10:00Z' }
    await supervisor.pollNow()
    clockMs += 2000 // still inside 5s sliding debounce window
    mr10.discussions[1] = {
      ...mr10.discussions[1]!,
      notes: [
        ...mr10.discussions[1]!.notes,
        { id: 'note-human-2', author: { username: 'alice' }, body: 'Pushed fix!', createdAt: '2026-11-01T00:10:02Z' },
      ],
    }
    mr10.info = { ...mr10.info, updatedAt: '2026-11-01T00:10:02Z' }
    await supervisor.pollNow()
    clockMs += 6000
    await supervisor.flushDebouncedDue()
    expect(turns.length).toBe(3)
    expect(turns[2]?.existingSessionId).toBe('mr-sess-1')
    expect(turns[2]?.prompt).toContain('sha-mr-10-v1')
    expect(fakeV8.resolveCalls).toEqual([{ discussionId: 'disc-human-midturn', resolved: true }])
    expect(fakeV8.reviewCalls[1]?.verdict).toBe('approve')
  })

  it('skips polling a repository cleanly when currentBotUser fails (self-trigger iron law)', async () => {
    const { dir, cleanup } = await tempDir('logalyze-mr-bot-err-')
    cleanups.push(cleanup)
    const origin = await createAppRepo(join(dir, 'repo'))
    const fakeV8 = new FakeReposV8(join(dir, 'repos'))
    fakeV8.base.catalog = [{ id: 'r1', url: origin, base: 'main', access: 'write', features: [{ id: 'mr-review' }] }]
    fakeV8.failCurrentBotUser = true
    fakeV8.upsertMr(origin, 1)

    const runTurn = vi.fn(async (req: MrSessionTurnRequest) => ({ sessionId: req.existingSessionId ?? 's1' }))
    const h = await createServiceHarness({
      fakeV8,
      dir,
      mrConfig: { debounceMs: 0 },
      driver: { runTurn },
    })
    cleanups.push(h.dispose)

    await h.service.mrSupervisorInstance()!.pollNow()
    expect(runTurn).not.toHaveBeenCalled()
    expect(h.service.mrSupervisorInstance()!.panelState().lastError).toContain('token expired')
  })

  it('handles self-fix CI retry cap, ownPushedShas suppression, merge conflict alert, and IssueMemory fix on merge', async () => {
    const { dir, cleanup } = await tempDir('logalyze-mr-selffix-')
    cleanups.push(cleanup)
    const origin = await createAppRepo(join(dir, 'repo'))
    const fakeV8 = new FakeReposV8(join(dir, 'repos'))
    fakeV8.base.catalog = [{ id: 'r1', url: origin, base: 'main', access: 'write', features: [{ id: 'mr-review' }] }]

    let clockMs = 2_000_000
    const turns: MrSessionTurnRequest[] = []
    let h!: Awaited<ReturnType<typeof createServiceHarness>>
    const driver: MrSessionDriver = {
      async runTurn(req) {
        turns.push(req)
        const sessionId = req.existingSessionId ?? `fix-sess-${turns.length}`
        await req.onSessionBound?.(sessionId)
        if (req.prompt.includes('ci-failed')) {
          const newSha = `bot-fix-sha-${turns.length}`
          const stored = fakeV8.mrs.get(origin)!.get(20)!
          stored.info = { ...stored.info, headSha: newSha, updatedAt: `2026-11-01T01:0${turns.length}:00Z` }
          stored.status = { headSha: newSha, checks: [{ name: 'test', state: 'failure' }], overall: 'failure', mergeable: true }
          await h.callTool(MR_CHECKPOINT_TOOL_NAME, { ownPushedSha: newSha }, sessionId)
        }
        return { sessionId }
      },
    }

    h = await createServiceHarness({
      fakeV8,
      dir,
      clock: () => clockMs,
      mrConfig: { debounceMs: 0, maxAutoFixAttempts: 2 },
      driver,
    })
    cleanups.push(h.dispose)

    const domain = await h.service.supervisorDomain()
    await domain.issues.upsertByAi({
      issueId: 'iss-1',
      appId: 'orders',
      title: 'Null pointer in order total',
      matchCriteria: 'NPE OrderTotal',
      aiDiagnosis: 'Missing null guard',
      aiStatus: 'located',
      resolutionAdvice: 'Check null before deref',
    })
    await domain.issues.syncHumanFields('iss-1', { humanConclusion: 'Confirmed bug', assignee: 'carol' })

    const mr20 = fakeV8.upsertMr(origin, 20, {
      headSha: 'bot-init-sha',
      updatedAt: '2026-11-01T01:00:00Z',
    }, {
      status: { headSha: 'bot-init-sha', checks: [{ name: 'test', state: 'failure' }], overall: 'failure', mergeable: true },
    })

    const supervisor = h.service.mrSupervisorInstance()!
    await supervisor.registerSelfMr({
      repo: origin,
      mrNumber: 20,
      origin: 'self-fix',
      headSha: 'bot-init-sha',
      sessionId: 'feishu-fix-sess',
      issueId: 'iss-1',
    })

    // CI fail #1 -> wakes existing Feishu session, pushes bot-fix-sha-1 (registered in ownPushedShas)
    clockMs += 1000
    await supervisor.pollNow()
    await supervisor.flushDebouncedDue()
    expect(turns).toHaveLength(1)
    expect(turns[0]?.existingSessionId).toBe('feishu-fix-sess')

    // CI fail #2 (after bot pushed bot-fix-sha-1, no 'push' trigger!) -> wakes attempt 2, pushes bot-fix-sha-2
    clockMs += 1000
    await supervisor.pollNow()
    await supervisor.flushDebouncedDue()
    expect(turns).toHaveLength(2)

    // CI fail #3 -> maxAutoFixAttempts (2) reached, trips 'mr-fix' breaker without starting a 3rd turn!
    clockMs += 1000
    await supervisor.pollNow()
    await supervisor.flushDebouncedDue()
    expect(turns).toHaveLength(2)
    const panelAfterCap = supervisor.panelState()
    expect(panelAfterCap.breakers.some(b => b.scope === 'mr-fix' && b.tripped)).toBe(true)

    // Merge conflict on current SHA -> emits conflict alert once without auto-rebase.
    mr20.status = { headSha: 'bot-fix-sha-2', checks: [{ name: 'test', state: 'success' }], overall: 'success', mergeable: false }
    mr20.info = { ...mr20.info, updatedAt: '2026-11-01T01:05:00Z' }
    clockMs += 1000
    await supervisor.pollNow()
    await supervisor.flushDebouncedDue()
    expect(turns).toHaveLength(3)
    expect(turns[2]?.prompt).toContain('禁止自动执行 git rebase')

    // Merge PR -> updates IssueMemory aiStatus='fixed' and fixMrUrl while preserving human columns!
    mr20.info = { ...mr20.info, state: 'merged', updatedAt: '2026-11-01T01:10:00Z' }
    clockMs += 1000
    await supervisor.pollNow()
    const issue = domain.issues.get('iss-1')!
    expect(issue.aiStatus).toBe('fixed')
    expect(issue.fixMrUrl).toBe(mr20.info.webUrl)
    expect(issue.humanConclusion).toBe('Confirmed bug')
    expect(issue.assignee).toBe('carol')
  })

  it('trips per-MR circuit breaker when limit is reached, resets cleanly via HTTP route, and recovers pending state across restart', async () => {
    const { dir, cleanup } = await tempDir('logalyze-mr-breaker-')
    cleanups.push(cleanup)
    const origin = await createAppRepo(join(dir, 'repo'))
    const fakeV8 = new FakeReposV8(join(dir, 'repos'))
    fakeV8.base.catalog = [{ id: 'r1', url: origin, base: 'main', access: 'write', features: [{ id: 'mr-review' }] }]

    let clockMs = 3_000_000
    let turnCount = 0
    const driver: MrSessionDriver = {
      async runTurn(req) {
        turnCount += 1
        const sid = req.existingSessionId ?? `s-${turnCount}`
        await req.onSessionBound?.(sid)
        return { sessionId: sid }
      },
    }

    const h = await createServiceHarness({
      fakeV8,
      dir,
      clock: () => clockMs,
      mrConfig: { debounceMs: 0, dailyMrTurnLimit: 1 },
      driver,
    })

    const mr30 = fakeV8.upsertMr(origin, 30, { headSha: 'sha-1', updatedAt: '2026-11-01T02:00:00Z' })
    const supervisor = h.service.mrSupervisorInstance()!

    // Turn 1 allowed
    await supervisor.pollNow()
    await supervisor.flushDebouncedDue()
    expect(turnCount).toBe(1)

    // Turn 2 blocked by dailyMrTurnLimit: 1
    mr30.info = { ...mr30.info, headSha: 'sha-2', updatedAt: '2026-11-01T02:01:00Z' }
    await supervisor.pollNow()
    await supervisor.flushDebouncedDue()
    expect(turnCount).toBe(1)

    const stateBeforeReset = await fetch(`${h.baseUrl}/logalyze/state`).then(r => r.json() as Promise<StateWire>)
    const mrBreaker = stateBeforeReset.mrSupervision?.breakers.find(b => b.scope === 'mr' && b.tripped)
    expect(mrBreaker).toBeDefined()

    // Reset via HTTP POST /logalyze/breakers/reset -> resumes blocked MR!
    const resetRes = await fetch(`${h.baseUrl}/logalyze/breakers/reset`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scope: mrBreaker!.scope, key: mrBreaker!.key }),
    })
    expect(resetRes.status).toBe(200)
    await supervisor.flushDebouncedDue()
    await supervisor.waitForIdle()
    expect(turnCount).toBe(2)

    await h.dispose()

    // Restart recovery: seed a persisted pending signal into supervised_mrs before boot and verify it runs on restart.
    const supervisorDir = join(dir, 'supervisor')
    await mkdir(supervisorDir, { recursive: true })
    const domain = await openSupervisorDomain({ fallbackDir: supervisorDir })
    const mrKey = supervisedMrKey(origin, 30)
    await domain.supervisedMrs.put(mrKey, {
      repo: origin,
      mrNumber: 30,
      origin: 'external',
      state: 'open',
      sessionId: 's-1',
      ownPushedShas: [],
      autoFixAttempts: 0,
      pendingSignals: [{ kind: 'push', observedAt: clockMs, headSha: 'sha-3' }],
      dueAt: clockMs,
    })
    await domain.close()

    mr30.info = { ...mr30.info, headSha: 'sha-3', updatedAt: '2026-11-01T02:02:00Z' }
    const h2 = await createServiceHarness({
      fakeV8,
      dir,
      clock: () => clockMs,
      mrConfig: { debounceMs: 0, dailyMrTurnLimit: 5 },
      driver,
    })
    cleanups.push(h2.dispose)
    await h2.service.mrSupervisorInstance()!.flushDebouncedDue()
    await h2.service.mrSupervisorInstance()!.waitForIdle()
    expect(turnCount).toBe(3)
  })

  it('does not re-queue in-flight delivered notes if a poll runs while a discussion turn is still executing', async () => {
    const { dir, cleanup } = await tempDir('logalyze-mr-inflight-notes-')
    cleanups.push(cleanup)
    const origin = await createAppRepo(join(dir, 'repo'))
    const fakeV8 = new FakeReposV8(join(dir, 'repos'))
    fakeV8.base.catalog = [{ id: 'r1', url: origin, base: 'main', access: 'write', features: [{ id: 'mr-review' }] }]

    let releaseTurn2!: () => void
    const turn2Blocked = new Promise<void>((resolve) => { releaseTurn2 = resolve })
    let turnCount = 0
    let turn2StartedResolve!: () => void
    const turn2Started = new Promise<void>((resolve) => { turn2StartedResolve = resolve })
    let h!: Awaited<ReturnType<typeof createServiceHarness>>

    const driver: MrSessionDriver = {
      async runTurn(req) {
        turnCount += 1
        const sid = req.existingSessionId ?? `s-${turnCount}`
        await req.onSessionBound?.(sid)
        if (turnCount === 1) {
          await h.callTool(MR_PUBLISH_REVIEW_TOOL_NAME, { headSha: 'sha-mr-40-v1', verdict: 'comment', body: 'ok' }, sid)
        } else if (turnCount === 2) {
          turn2StartedResolve()
          await turn2Blocked
          await h.callTool(MR_REPLY_THREAD_TOOL_NAME, { discussionId: 'disc-40', body: 'Fixed!' }, sid)
        }
        return { sessionId: sid }
      },
    }

    h = await createServiceHarness({
      fakeV8,
      dir,
      mrConfig: { debounceMs: 0 },
      driver,
    })
    cleanups.push(h.dispose)

    const mr40 = fakeV8.upsertMr(origin, 40)
    const supervisor = h.service.mrSupervisorInstance()!
    await supervisor.pollNow()
    await supervisor.flushDebouncedDue()
    expect(turnCount).toBe(1)

    mr40.discussions.push({
      id: 'disc-40',
      inline: true,
      position: { path: 'src/a.ts', newLine: 1 },
      resolvable: true,
      resolved: false,
      notes: [{ id: 'n-human-1', author: { username: 'alice' }, body: 'Please rename this', createdAt: '2026-11-01T00:05:10Z' }],
    })
    mr40.info = { ...mr40.info, updatedAt: '2026-11-01T00:05:10Z' }
    await supervisor.pollNow()
    const flushPromise = supervisor.flushDebouncedDue()
    await turn2Started

    // Poll while Turn 2 is still running and n-human-1 is in deliveredNoteIds (not yet in seenNoteIds)
    await supervisor.pollNow()
    releaseTurn2()
    await flushPromise
    await supervisor.waitForIdle()
    await supervisor.flushDebouncedDue()

    expect(turnCount).toBe(2)
  })

  it('halts retries when blocked by breaker or disabled settings and resumes dormant work after cooldown', async () => {
    const { dir, cleanup } = await tempDir('logalyze-mr-breaker-dormant-')
    cleanups.push(cleanup)
    const origin = await createAppRepo(join(dir, 'repo'))
    const fakeV8 = new FakeReposV8(join(dir, 'repos'))
    fakeV8.base.catalog = [{ id: 'r1', url: origin, base: 'main', access: 'write', features: [{ id: 'mr-review' }] }]

    let clockMs = 10_000_000
    let turnCount = 0
    const h = await createServiceHarness({
      fakeV8,
      dir,
      clock: () => clockMs,
      mrConfig: { debounceMs: 0, dailyMrTurnLimit: 1 },
      driver: {
        async runTurn(req) {
          turnCount += 1
          const sid = req.existingSessionId ?? `s-${turnCount}`
          await req.onSessionBound?.(sid)
          return { sessionId: sid }
        },
      },
    })
    cleanups.push(h.dispose)

    const mr41 = fakeV8.upsertMr(origin, 41, { headSha: 'sha-1', updatedAt: '2026-11-01T03:00:00Z' })
    const supervisor = h.service.mrSupervisorInstance()!
    await supervisor.pollNow()
    await supervisor.flushDebouncedDue()
    expect(turnCount).toBe(1)

    // Trigger 2nd update -> blocked by dailyMrTurnLimit: 1
    mr41.info = { ...mr41.info, headSha: 'sha-2', updatedAt: '2026-11-01T03:01:00Z' }
    await supervisor.pollNow()
    await supervisor.flushDebouncedDue()
    await supervisor.waitForIdle()
    expect(turnCount).toBe(1)

    const getsAfterBlock = fakeV8.mrGetCalls
    await new Promise(resolve => setTimeout(resolve, 25))
    expect(fakeV8.mrGetCalls).toBe(getsAfterBlock)

    const dormantRec = (await h.service.supervisorDomain()).supervisedMrs.get(supervisedMrKey(origin, 41))
    expect(dormantRec?.dueAt).toBeUndefined()
    expect(dormantRec?.pendingSignals).toHaveLength(1)

    // Disable supervision via HTTP PUT while pending, then advance past 24h cooldown: still dormant while disabled
    const disableRes = await fetch(`${h.baseUrl}/logalyze/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mrReview: { enabled: false } }),
    })
    expect(disableRes.status).toBe(200)
    clockMs += 24 * 60 * 60 * 1000 + 1000
    await supervisor.pollNow()
    expect(turnCount).toBe(1)

    // Re-enable supervision -> dormant pending signal recovers and runs Turn 2 without manual breaker reset
    const enableRes = await fetch(`${h.baseUrl}/logalyze/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mrReview: { enabled: true } }),
    })
    expect(enableRes.status).toBe(200)
    await new Promise(resolve => setTimeout(resolve, 25))
    await supervisor.flushDebouncedDue()
    await supervisor.waitForIdle()
    expect(turnCount).toBe(2)
  })

  it('transitions MR to merged without deadlocking when mrList returns open but mrGet returns merged', async () => {
    const { dir, cleanup } = await tempDir('logalyze-mr-terminal-lock-')
    cleanups.push(cleanup)
    const origin = await createAppRepo(join(dir, 'repo'))
    const fakeV8 = new FakeReposV8(join(dir, 'repos'))
    fakeV8.base.catalog = [{ id: 'r1', url: origin, base: 'main', access: 'write', features: [{ id: 'mr-review' }] }]

    const h = await createServiceHarness({
      fakeV8,
      dir,
      mrConfig: { debounceMs: 0 },
      driver: {
        async runTurn(req) {
          const sid = req.existingSessionId ?? 's-term'
          await req.onSessionBound?.(sid)
          return { sessionId: sid }
        },
      },
    })
    cleanups.push(h.dispose)

    const domain = await h.service.supervisorDomain()
    await domain.issues.upsertByAi({
      issueId: 'iss-term',
      appId: 'orders',
      title: 'Fix race',
      matchCriteria: 'FixRace',
      aiDiagnosis: 'Race',
      aiStatus: 'located',
      resolutionAdvice: 'Guard lock',
    })

    const mr42 = fakeV8.upsertMr(origin, 42, { headSha: 'sha-open', state: 'open' })
    const supervisor = h.service.mrSupervisorInstance()!
    await supervisor.registerSelfMr({
      repo: origin,
      mrNumber: 42,
      origin: 'self-fix',
      headSha: 'sha-open',
      sessionId: 'sess-term',
      issueId: 'iss-term',
    })

    // mrList returns 'open', then right as mrGet runs the remote reports 'merged'.
    fakeV8.onMrGet = ({ number }) => {
      if (number === 42) {
        mr42.info = { ...mr42.info, state: 'merged', updatedAt: '2026-11-01T04:00:00Z' }
      }
    }

    await supervisor.pollNow()
    const rec = domain.supervisedMrs.get(supervisedMrKey(origin, 42))
    expect(rec?.state).toBe('merged')
    expect(domain.issues.get('iss-term')?.aiStatus).toBe('fixed')
  })

  it('anchors discovery cursor on listed updatedAt rather than poll completion clock', async () => {
    const { dir, cleanup } = await tempDir('logalyze-mr-cursor-')
    cleanups.push(cleanup)
    const origin = await createAppRepo(join(dir, 'repo'))
    const fakeV8 = new FakeReposV8(join(dir, 'repos'))
    fakeV8.base.catalog = [{ id: 'r1', url: origin, base: 'main', access: 'write', features: [{ id: 'mr-review' }] }]

    const startMs = Date.parse('2026-11-01T05:00:00Z')
    let clockMs = startMs
    const seenMrs: number[] = []
    const h = await createServiceHarness({
      fakeV8,
      dir,
      clock: () => clockMs,
      mrConfig: { debounceMs: 0 },
      driver: {
        async runTurn(req) {
          seenMrs.push(req.mrNumber)
          const sid = req.existingSessionId ?? `s-${req.mrNumber}`
          await req.onSessionBound?.(sid)
          return { sessionId: sid }
        },
      },
    })
    cleanups.push(h.dispose)

    fakeV8.upsertMr(origin, 43, {
      updatedAt: new Date(startMs).toISOString(),
    })
    fakeV8.onMrGet = ({ number, callIndex }) => {
      if (number === 43 && callIndex === 1) {
        // Poll processing takes 10s; meanwhile external MR #44 is opened at startMs + 2s (before poll ends!).
        clockMs += 10_000
        fakeV8.upsertMr(origin, 44, {
          updatedAt: new Date(startMs + 2_000).toISOString(),
        })
      }
    }

    const supervisor = h.service.mrSupervisorInstance()!
    await supervisor.pollNow()
    await supervisor.flushDebouncedDue()
    expect(seenMrs).toEqual([43])

    // Next poll uses updatedAfter based on startMs (listed maxUpdatedAt), NOT startMs + 10s!
    await supervisor.pollNow()
    await supervisor.flushDebouncedDue()
    expect(seenMrs).toEqual([43, 44])
  })

  it('preserves signals appended by a concurrent poll while executeMrTurn is fetching remote state', async () => {
    const { dir, cleanup } = await tempDir('logalyze-mr-concurrent-signal-')
    cleanups.push(cleanup)
    const origin = await createAppRepo(join(dir, 'repo'))
    const fakeV8 = new FakeReposV8(join(dir, 'repos'))
    fakeV8.base.catalog = [{ id: 'r1', url: origin, base: 'main', access: 'write', features: [{ id: 'mr-review' }] }]

    let clockMs = 6_000_000
    const seenHeadShas: string[] = []
    let releaseTurn2MrGet!: () => void
    let pausedInTurn2 = false
    let turn2PausedNotify!: () => void
    const turn2Paused = new Promise<void>((resolve) => { turn2PausedNotify = resolve })

    const mr45 = fakeV8.upsertMr(origin, 45, {
      headSha: 'sha-1',
      updatedAt: '2026-11-01T06:00:00Z',
    })

    const h = await createServiceHarness({
      fakeV8,
      dir,
      clock: () => clockMs,
      mrConfig: { debounceMs: 5000 },
      driver: {
        async runTurn(req) {
          seenHeadShas.push(req.prompt.match(/commit (sha-\d+)/)?.[1] ?? 'unknown')
          const sid = req.existingSessionId ?? `s-${seenHeadShas.length}`
          await req.onSessionBound?.(sid)
          return { sessionId: sid }
        },
      },
    })
    cleanups.push(h.dispose)

    const supervisor = h.service.mrSupervisorInstance()!
    await supervisor.pollNow()
    clockMs += 6000
    await supervisor.flushDebouncedDue()
    expect(seenHeadShas).toEqual(['sha-1'])

    // Poll buffers push (sha-2) in debouncer without running executeMrTurn yet.
    mr45.info = { ...mr45.info, headSha: 'sha-2', updatedAt: '2026-11-01T06:01:00Z' }
    await supervisor.pollNow()

    // Pause executeMrTurn inside its mrGet call for sha-2.
    fakeV8.onMrGet = async ({ number }) => {
      if (number === 45 && !pausedInTurn2) {
        pausedInTurn2 = true
        turn2PausedNotify()
        await new Promise<void>((resolve) => { releaseTurn2MrGet = resolve })
      }
    }

    clockMs += 6000
    const flushPromise = supervisor.flushDebouncedDue()
    await turn2Paused
    fakeV8.onMrGet = undefined

    // While executeMrTurn is suspended on mrGet for sha-2, a concurrent poll observes sha-3!
    mr45.info = { ...mr45.info, headSha: 'sha-3', updatedAt: '2026-11-01T06:01:30Z' }
    await supervisor.pollNow()

    // Release executeMrTurn for the sha-2 batch; sha-3 must remain queued and execute cleanly.
    releaseTurn2MrGet()
    await flushPromise
    clockMs += 6000
    await supervisor.flushDebouncedDue()
    await supervisor.waitForIdle()

    const finalRec = (await h.service.supervisorDomain()).supervisedMrs.get(supervisedMrKey(origin, 45))
    expect(seenHeadShas).toEqual(['sha-1', 'sha-2', 'sha-3'])
    expect(finalRec?.pendingSignals).toEqual([])
    expect(finalRec?.reviewedHeadSha).toBe('sha-3')
  })

  it('resumes pending review after disabling and re-enabling supervision mid-debounce without new remote updates', async () => {
    const { dir, cleanup } = await tempDir('logalyze-mr-disable-debounce-')
    cleanups.push(cleanup)
    const origin = await createAppRepo(join(dir, 'repo'))
    const fakeV8 = new FakeReposV8(join(dir, 'repos'))
    fakeV8.base.catalog = [{ id: 'r1', url: origin, base: 'main', access: 'write', features: [{ id: 'mr-review' }] }]

    let clockMs = 7_000_000
    let turnCount = 0
    const h = await createServiceHarness({
      fakeV8,
      dir,
      clock: () => clockMs,
      mrConfig: { debounceMs: 5000 },
      driver: {
        async runTurn(req) {
          turnCount += 1
          const sid = req.existingSessionId ?? `s-${turnCount}`
          await req.onSessionBound?.(sid)
          return { sessionId: sid }
        },
      },
    })
    cleanups.push(h.dispose)

    fakeV8.upsertMr(origin, 46, { headSha: 'sha-1', updatedAt: '2026-11-01T07:00:00Z' })
    const supervisor = h.service.mrSupervisorInstance()!
    const key46 = supervisedMrKey(origin, 46)
    const domain = await h.service.supervisorDomain()

    // Enters 5s debounce window without running yet.
    await supervisor.pollNow()
    expect(turnCount).toBe(0)
    expect(domain.supervisedMrs.get(key46)?.dueAt).toBe(clockMs + 5000)

    // Disable supervision mid-debounce -> timer cancelled and durable deadline cleared.
    const disableRes = await fetch(`${h.baseUrl}/logalyze/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mrReview: { enabled: false } }),
    })
    expect(disableRes.status).toBe(200)
    await new Promise(resolve => setTimeout(resolve, 25))
    expect(domain.supervisedMrs.get(key46)?.dueAt).toBeUndefined()

    clockMs += 6000
    await supervisor.flushDebouncedDue()
    expect(turnCount).toBe(0)

    // Re-enable supervision without any new remote update -> queued review runs automatically.
    const enableRes = await fetch(`${h.baseUrl}/logalyze/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mrReview: { enabled: true } }),
    })
    expect(enableRes.status).toBe(200)
    await new Promise(resolve => setTimeout(resolve, 25))
    await supervisor.flushDebouncedDue()
    await supervisor.waitForIdle()
    expect(turnCount).toBe(1)
  })

  it('restores opened and push-only signal batches when sessionDriver returns an error or throws', async () => {
    const { dir, cleanup } = await tempDir('logalyze-mr-note-free-rollback-')
    cleanups.push(cleanup)
    const origin = await createAppRepo(join(dir, 'repo'))
    const fakeV8 = new FakeReposV8(join(dir, 'repos'))
    fakeV8.base.catalog = [{ id: 'r1', url: origin, base: 'main', access: 'write', features: [{ id: 'mr-review' }] }]

    let attempt = 0
    let h!: Awaited<ReturnType<typeof createServiceHarness>>
    const mr47 = fakeV8.upsertMr(origin, 47, {
      headSha: 'sha-init',
      updatedAt: '2026-11-01T08:00:00Z',
    })

    h = await createServiceHarness({
      fakeV8,
      dir,
      mrConfig: { debounceMs: 0 },
      driver: {
        async runTurn(req) {
          attempt += 1
          const sid = req.existingSessionId ?? 'sess-rollback'
          await req.onSessionBound?.(sid)
          if (attempt === 1 || attempt === 4) {
            return { sessionId: sid, error: 'model overloaded' }
          }
          if (attempt === 2) {
            throw new Error('network reset')
          }
          const targetSha = attempt === 3 ? 'sha-init' : 'sha-push-2'
          await h.callTool(MR_PUBLISH_REVIEW_TOOL_NAME, {
            headSha: targetSha,
            verdict: 'comment',
            body: `Reviewed ${targetSha}`,
          }, sid)
          return { sessionId: sid }
        },
      },
    })
    cleanups.push(h.dispose)

    const supervisor = h.service.mrSupervisorInstance()!
    const domain = await h.service.supervisorDomain()
    const key47 = supervisedMrKey(origin, 47)

    // Attempt 1 (opened, note-free) returns { error } -> opened signal restored, dueAt cleared.
    await supervisor.pollNow()
    await supervisor.waitForIdle()
    expect(attempt).toBe(1)
    let rec = domain.supervisedMrs.get(key47)
    expect(rec?.pendingSignals.map(s => s.kind)).toEqual(['opened'])
    expect(rec?.dueAt).toBeUndefined()

    // Attempt 2 (opened, note-free) throws -> opened signal restored again.
    await supervisor.pollNow()
    await supervisor.waitForIdle()
    expect(attempt).toBe(2)
    rec = domain.supervisedMrs.get(key47)
    expect(rec?.pendingSignals.map(s => s.kind)).toEqual(['opened'])
    expect(rec?.dueAt).toBeUndefined()

    // Attempt 3 succeeds and publishes review.
    await supervisor.pollNow()
    await supervisor.waitForIdle()
    expect(attempt).toBe(3)
    rec = domain.supervisedMrs.get(key47)
    expect(rec?.pendingSignals).toEqual([])
    expect(rec?.lastReviewedSha).toBe('sha-init')

    // Push sha-push-2 (note-free push-only batch): Attempt 4 fails -> restored, Attempt 5 succeeds!
    mr47.info = { ...mr47.info, headSha: 'sha-push-2', updatedAt: '2026-11-01T08:05:00Z' }
    await supervisor.pollNow()
    await supervisor.waitForIdle()
    expect(attempt).toBe(4)
    rec = domain.supervisedMrs.get(key47)
    expect(rec?.pendingSignals.map(s => s.kind)).toEqual(['push'])

    await supervisor.pollNow()
    await supervisor.waitForIdle()
    expect(attempt).toBe(5)
    rec = domain.supervisedMrs.get(key47)
    expect(rec?.pendingSignals).toEqual([])
    expect(rec?.lastReviewedSha).toBe('sha-push-2')
  })

  it('discovers MRs beyond 500 items across >10 pages without stranding older MRs', async () => {
    const { dir, cleanup } = await tempDir('mr-pagination-505-')
    cleanups.push(cleanup)

    const fakeV8 = new FakeReposV8(join(dir, 'repos'))
    const origin = 'https://git.example/org/large-app.git'
    fakeV8.base.catalog = [{ id: 'r1', url: origin, base: 'main', access: 'write', features: [{ id: 'mr-review' }] }]

    // Seed 504 newer draft MRs (skipDraft ignores without creating records) and 1 older reviewable MR on page 11.
    const baseMs = Date.parse('2026-11-01T10:00:00Z')
    for (let num = 2; num <= 505; num += 1) {
      fakeV8.upsertMr(origin, num, {
        draft: true,
        updatedAt: new Date(baseMs + num * 1000).toISOString(),
      })
    }
    fakeV8.upsertMr(origin, 1, {
      draft: false,
      headSha: 'sha-old-1',
      updatedAt: '2026-11-01T01:00:00Z',
    })

    let h!: Awaited<ReturnType<typeof createServiceHarness>>
    h = await createServiceHarness({
      fakeV8,
      dir,
      mrConfig: { debounceMs: 0 },
      driver: {
        async runTurn(req) {
          const sid = 'sess-large-1'
          await req.onSessionBound?.(sid)
          await h.callTool(MR_PUBLISH_REVIEW_TOOL_NAME, {
            headSha: 'sha-old-1',
            verdict: 'approve',
            body: 'Reviewed old MR #1 on page 11',
          }, sid)
          return { sessionId: sid }
        },
      },
    })
    cleanups.push(h.dispose)

    const supervisor = h.service.mrSupervisorInstance()!
    const domain = await h.service.supervisorDomain()

    await supervisor.pollNow()
    await supervisor.waitForIdle()

    expect(fakeV8.mrListCalls.some(c => (c.page ?? 1) === 11)).toBe(true)
    expect(fakeV8.reviewCalls.map(c => c.number)).toContain(1)
    expect(domain.supervisedMrs.get(supervisedMrKey(origin, 1))?.lastReviewedSha).toBe('sha-old-1')
  })

  it('preserves pagination progress across polls before advancing repoCursors when maxListPagesPerPoll is reached', async () => {
    const { dir, cleanup } = await tempDir('mr-pagination-backfill-')
    cleanups.push(cleanup)

    const fakeV8 = new FakeReposV8(join(dir, 'repos'))
    const origin = 'https://git.example/org/backfill.git'
    fakeV8.base.catalog = [{ id: 'r1', url: origin, base: 'main', access: 'write', features: [{ id: 'mr-review' }] }]

    // 110 MRs = 3 pages at perPage=50. Page 1-2 hold #2..#101 (newest) and Page 3 holds #1..#10 (oldest).
    const baseMs = Date.parse('2026-11-01T10:00:00Z')
    for (let num = 2; num <= 110; num += 1) {
      fakeV8.upsertMr(origin, num, {
        draft: true,
        updatedAt: new Date(baseMs + num * 1000).toISOString(),
      })
    }
    fakeV8.upsertMr(origin, 1, {
      draft: false,
      headSha: 'sha-page3-mr1',
      updatedAt: '2026-11-01T01:00:00Z',
    })

    const fakeCtx: HostContext = {
      tools: { register: () => () => {} },
      skills: { registerProvider: () => () => {} },
      subagents: { getProvider: () => ({}), resolveMaxDepth: () => 1, startActivation: () => Promise.reject(new Error('unused')) },
      on: () => () => {},
      effect: () => () => {},
    }
    const domain = await openSupervisorDomain({ ctx: fakeCtx, fallbackDir: join(dir, 'supervisor') })
    cleanups.push(() => domain.close())

    const pools = createSupervisionPools()
    cleanups.push(() => pools.drainAndClose({ cancelQueued: true, abortActive: true }))

    const settings = resolveConfig({ mrReview: { debounceMs: 0 } }).mrReview
    const breakers = new CircuitBreakerRegistry({ table: domain.circuitBreakers, resolvePolicy: () => undefined })
    const repos = new ReposClient(() => fakeV8.service())
    let sup!: MrSupervisor
    sup = new MrSupervisor({
      table: domain.supervisedMrs,
      breakers,
      issues: domain.issues,
      repos,
      mrPool: pools.mrPool,
      workspacesRoot: join(dir, 'mr-workspaces'),
      sessionDriver: {
        async runTurn(req) {
          const sid = 'sess-backfill-1'
          await req.onSessionBound?.(sid)
          await sup.updateRecord(req.repo, req.mrNumber, cur => ({
            ...cur,
            lastReviewedSha: 'sha-page3-mr1',
            reviewedHeadSha: 'sha-page3-mr1',
          }))
          return { sessionId: sid }
        },
      },
      getSettings: () => settings,
      getMrRepos: () => [{ url: origin, writable: true }],
      autoPollTimer: false,
      maxListPagesPerPoll: 2,
    })
    cleanups.push(() => sup.drainAndClose())
    await sup.boot()

    // Poll 1: fetches pages 1 and 2 only (capped at 2 pages); MR #1 on page 3 is not yet visited.
    await sup.pollNow()
    await sup.waitForIdle()
    expect(fakeV8.mrListCalls.map(c => c.page)).toEqual([1, 2])
    expect(domain.supervisedMrs.get(supervisedMrKey(origin, 1))).toBeUndefined()

    // Poll 2: continues backfill from page 3 with same unfiltered scan -> discovers and reviews MR #1!
    await sup.pollNow()
    await sup.waitForIdle()
    expect(fakeV8.mrListCalls.slice(2).map(c => ({ page: c.page, updatedAfter: c.updatedAfter }))).toEqual([
      { page: 3, updatedAfter: undefined },
    ])
    expect(domain.supervisedMrs.get(supervisedMrKey(origin, 1))?.lastReviewedSha).toBe('sha-page3-mr1')

    // Poll 3: backfill completed -> cursor has now advanced, so poll 3 queries page 1 with `updatedAfter` set.
    await sup.pollNow()
    await sup.waitForIdle()
    expect(fakeV8.mrListCalls.at(-1)?.page).toBe(1)
    expect(fakeV8.mrListCalls.at(-1)?.updatedAfter).toBeTypeOf('string')
  })

  it('rechecks repository eligibility when mr-review is disabled during debounce, pool wait, or across restart', async () => {
    const { dir, cleanup } = await tempDir('mr-repo-eligibility-')
    cleanups.push(cleanup)

    const fakeV8 = new FakeReposV8(join(dir, 'repos'))
    const originA = 'https://git.example/org/repo-a.git'
    const originB = 'https://git.example/org/repo-b.git'
    fakeV8.base.catalog = [
      { id: 'ra', url: originA, base: 'main', access: 'write', features: [{ id: 'mr-review' }] },
      { id: 'rb', url: originB, base: 'main', access: 'write', features: [{ id: 'mr-review' }] },
    ]

    let nowMs = 1_000_000
    const turnsExecuted: string[] = []
    let releaseRepoATurn: (() => void) | undefined
    let enteredRepoATurn: (() => void) | undefined
    const repoATurnEntered = new Promise<void>(resolve => { enteredRepoATurn = resolve })

    let h!: Awaited<ReturnType<typeof createServiceHarness>>
    const makeDriver = (harnessRef: () => typeof h): MrSessionDriver => ({
      async runTurn(req) {
        turnsExecuted.push(`${req.repo}#${req.mrNumber}`)
        const sid = `sess-${req.mrNumber}`
        await req.onSessionBound?.(sid)
        if (req.repo === originA && req.mrNumber === 10) {
          enteredRepoATurn?.()
          await new Promise<void>(resolve => { releaseRepoATurn = resolve })
        }
        await harnessRef().callTool(MR_PUBLISH_REVIEW_TOOL_NAME, {
          headSha: `sha-mr-${req.mrNumber}-v1`,
          verdict: 'comment',
          body: 'ok',
        }, sid)
        return { sessionId: sid }
      },
    })

    // Seed MR on repo B while debouncing (5s window).
    fakeV8.upsertMr(originB, 1, { updatedAt: '2026-11-01T09:00:00Z' })
    h = await createServiceHarness({
      fakeV8,
      dir,
      mrConfig: { debounceMs: 5_000, maxConcurrentSessions: 1 },
      clock: () => nowMs,
      driver: makeDriver(() => h),
    })

    let supervisor = h.service.mrSupervisorInstance()!
    let domain = await h.service.supervisorDomain()
    const keyB1 = supervisedMrKey(originB, 1)

    await supervisor.pollNow()
    expect(domain.supervisedMrs.get(keyB1)?.pendingSignals.map(s => s.kind)).toEqual(['opened'])
    expect(domain.supervisedMrs.get(keyB1)?.dueAt).toBeDefined()

    // Disable `mr-review` on repo B while MR B#1 is in its debounce window.
    fakeV8.base.catalog = [
      { id: 'ra', url: originA, base: 'main', access: 'write', features: [{ id: 'mr-review' }] },
      { id: 'rb', url: originB, base: 'main', access: 'write', features: [] },
    ]
    fakeV8.base.emitReposChange()
    await vi.waitFor(() => {
      expect(domain.supervisedMrs.get(keyB1)?.dueAt).toBeUndefined()
    })
    await supervisor.waitForIdle()

    expect(domain.supervisedMrs.get(keyB1)?.dueAt).toBeUndefined()
    expect(domain.supervisedMrs.get(keyB1)?.pendingSignals.map(s => s.kind)).toEqual(['opened'])

    nowMs += 10_000
    await supervisor.flushDebouncedDue()
    await supervisor.waitForIdle()
    expect(turnsExecuted).toEqual([])

    // Restart service while repo B still has `mr-review` disabled -> B#1 stays dormant across restart!
    await h.dispose()
    h = await createServiceHarness({
      fakeV8,
      dir,
      mrConfig: { debounceMs: 0, maxConcurrentSessions: 1 },
      clock: () => nowMs,
      driver: makeDriver(() => h),
    })
    cleanups.push(() => h.dispose())
    supervisor = h.service.mrSupervisorInstance()!
    domain = await h.service.supervisorDomain()

    await supervisor.flushDebouncedDue()
    await supervisor.waitForIdle()
    expect(turnsExecuted).toEqual([])
    expect(domain.supervisedMrs.get(keyB1)?.dueAt).toBeUndefined()

    // Test pool-slot queue case: occupy the single pool slot with repo A#10, while B#1 is queued in `mrPool`.
    fakeV8.upsertMr(originA, 10, { updatedAt: '2026-11-01T09:01:00Z' })
    await supervisor.pollNow()
    await repoATurnEntered

    // Re-enable `mr-review` on repo B so B#1 becomes eligible and queues into `mrPool` behind A#10.
    fakeV8.base.setCatalog([
      { url: originA, base: 'main' },
      { url: originB, base: 'main' },
    ], ['mr-review'])
    await vi.waitFor(() => {
      expect(domain.supervisedMrs.get(keyB1)?.dueAt).toBeDefined()
    })
    const flushB1 = supervisor.flushDebouncedDue()

    // While A#10 holds the slot and B#1 waits in `mrPool`, disable `mr-review` on repo B again!
    fakeV8.base.setCatalog([{ url: originA, base: 'main' }], ['mr-review'])
    await vi.waitFor(() => {
      expect(h.service.registry.mrStatus().some(r => r.url === originB)).toBe(false)
    })

    releaseRepoATurn?.()
    await flushB1
    await supervisor.waitForIdle()

    expect(turnsExecuted).toEqual([`${originA}#10`])
    expect(domain.supervisedMrs.get(keyB1)?.dueAt).toBeUndefined()
    expect(domain.supervisedMrs.get(keyB1)?.pendingSignals.map(s => s.kind)).toEqual(['opened'])

    // Finally re-enable `mr-review` on repo B -> dormant B#1 resumes and executes!
    fakeV8.base.setCatalog([
      { url: originA, base: 'main' },
      { url: originB, base: 'main' },
    ], ['mr-review'])
    await vi.waitFor(() => {
      expect(h.service.registry.mrStatus().some(r => r.url === originB)).toBe(true)
    })
    await supervisor.waitForIdle()
    await supervisor.flushDebouncedDue()
    await supervisor.waitForIdle()

    expect(turnsExecuted).toEqual([`${originA}#10`, `${originB}#1`])
    expect(domain.supervisedMrs.get(keyB1)?.pendingSignals).toEqual([])
    expect(domain.supervisedMrs.get(keyB1)?.lastReviewedSha).toBe('sha-mr-1-v1')
  })

  it('createHostMrSessionDriver correlates completion with submitted requestId and ignores preceding human turn/end', async () => {
    const submittedRequests: Array<{ readonly sessionId: string; readonly requestId: string; readonly mode?: string }> = []
    const ctx: HostContext = {
      tools: { register: () => () => {} },
      skills: { registerProvider: () => () => {} },
      subagents: { getProvider: () => ({}), resolveMaxDepth: () => 1, startActivation: () => Promise.reject(new Error('unused')) },
      on: () => () => {},
      effect: () => () => {},
      get: (name: string) => {
        if (name !== 'sessionController') return undefined
        return {
          resolveAgent: async (sessionId: string) => ({
            agent: { id: 'agent-1', session: { header: { id: sessionId } } },
          }),
          prompt: async (req: { readonly sessionId: string; readonly requestId: string; readonly mode?: string }) => {
            submittedRequests.push(req)
            return { accepted: true }
          },
        }
      },
    }

    const driver = createHostMrSessionDriver(ctx)
    cleanups.push(async () => { driver.dispose?.() })

    let resolved1 = false
    const turnPromise1 = driver.runTurn({
      repo: 'https://git.example/org/app.git',
      mrNumber: 1,
      origin: 'external',
      existingSessionId: 'sess-shared',
      workDir: '/tmp/mr-test',
      prompt: 'Incremental MR review',
      signal: new AbortController().signal,
    }).then((res) => {
      resolved1 = true
      return res
    })

    // Wait for `prompt()` to receive requestId 1.
    await vi.waitFor(() => { expect(submittedRequests).toHaveLength(1) })
    const req1 = submittedRequests[0]!
    expect(req1.mode).toBe('queue')

    // Session is currently running human Turn 1; MR prompt is spliced into inbox next-turn queue.
    driver.onSessionEvent('sess-shared', 'turn/start', { turn: 1 })
    driver.onSessionEvent('sess-shared', 'agent/inbox/spliced', {
      target: 'next-turn',
      start: 0,
      inserted: [{ id: 'msg-mr-1', source: { kind: 'user', rpcId: req1.requestId } }],
    })

    // Preceding human Turn 1 completes -> queued MR turn must NOT resolve early!
    driver.onSessionEvent('sess-shared', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
    await Promise.resolve()
    await Promise.resolve()
    expect(resolved1).toBe(false)

    // Turn 2 starts and claims `msg-mr-1`, then fails with LLM error.
    driver.onSessionEvent('sess-shared', 'turn/start', { turn: 2 })
    driver.onSessionEvent('sess-shared', 'agent/inbox/spliced', {
      target: 'next-turn',
      start: 0,
      removedCount: 1,
      inserted: [],
    })
    driver.onSessionEvent('sess-shared', 'user/message', {
      id: 'msg-mr-1',
      source: { kind: 'user', rpcId: req1.requestId },
    })
    driver.onSessionEvent('sess-shared', 'turn/end', {
      turn: 2,
      reason: { kind: 'error', error: { message: 'llm rate limit' } },
    })

    expect(await turnPromise1).toEqual({ sessionId: 'sess-shared', error: 'llm rate limit' })

    // Second queued prompt gets canceled from inbox before claiming -> waiter settles cleanly with error.
    const turnPromise2 = driver.runTurn({
      repo: 'https://git.example/org/app.git',
      mrNumber: 2,
      origin: 'external',
      existingSessionId: 'sess-shared',
      workDir: '/tmp/mr-test',
      prompt: 'Queued prompt to cancel',
      signal: new AbortController().signal,
    })
    await vi.waitFor(() => { expect(submittedRequests).toHaveLength(2) })
    const req2 = submittedRequests[1]!

    driver.onSessionEvent('sess-shared', 'agent/inbox/spliced', {
      target: 'next-turn',
      start: 0,
      inserted: [{ id: 'msg-mr-2', source: { kind: 'user', rpcId: req2.requestId } }],
    })
    driver.onSessionEvent('sess-shared', 'agent/inbox/spliced', {
      target: 'next-turn',
      start: 0,
      removedCount: 1,
      inserted: [],
      outcome: 'canceled',
    })

    expect(await turnPromise2).toEqual({
      sessionId: 'sess-shared',
      error: '排队的 MR 评审消息已被取消',
    })
  })

  it('restores uncheckpointed signals when shutdown aborts an active turn and resumes on reboot', async () => {
    const { dir, cleanup } = await tempDir('mr-shutdown-restore-')
    cleanups.push(cleanup)

    const fakeV8 = new FakeReposV8(join(dir, 'repos'))
    const origin = 'https://git.example/org/app.git'
    fakeV8.base.setCatalog([{ url: origin, base: 'main' }], ['mr-review'])
    fakeV8.upsertMr(origin, 1, { headSha: 'sha-mr-1-v1', updatedAt: '2026-11-01T10:00:00Z' })

    const nowMs = Date.parse('2026-11-01T10:00:00Z')
    let abortedTurns = 0
    let turnStartedResolve: (() => void) | undefined
    const turnStarted = new Promise<void>(resolve => { turnStartedResolve = resolve })

    const h1 = await createServiceHarness({
      fakeV8,
      dir,
      mrConfig: { debounceMs: 0 },
      clock: () => nowMs,
      driver: {
        async runTurn(req) {
          abortedTurns += 1
          await req.onSessionBound?.('sess-abort-1')
          turnStartedResolve?.()
          await new Promise<void>((_resolve, reject) => {
            if (req.signal.aborted) {
              reject(new Error('aborted by shutdown'))
              return
            }
            req.signal.addEventListener('abort', () => reject(new Error('aborted by shutdown')), { once: true })
          })
          return { sessionId: 'sess-abort-1' }
        },
      },
    })

    const sup1 = h1.service.mrSupervisorInstance()!
    await sup1.pollNow()
    await turnStarted

    // Shutdown aborts the in-flight initial review before checkpointing -> must restore signal & not re-run.
    await h1.dispose()
    expect(abortedTurns).toBe(1)

    // Reboot on the same persistent domain directory: interrupted review automatically resumes and completes,
    // and shutting down during a subsequent push-only review also restores cleanly.
    const resumedHeadShas: string[] = []
    let abortOnPush = false
    let pushTurnStartedResolve: (() => void) | undefined
    const pushTurnStarted = new Promise<void>(resolve => { pushTurnStartedResolve = resolve })
    let h2!: Awaited<ReturnType<typeof createServiceHarness>>
    h2 = await createServiceHarness({
      fakeV8,
      dir,
      mrConfig: { debounceMs: 0 },
      clock: () => nowMs + 1_000,
      driver: {
        async runTurn(req) {
          const sid = req.existingSessionId ?? 'sess-resume-1'
          await req.onSessionBound?.(sid)
          if (abortOnPush) {
            abortedTurns += 1
            pushTurnStartedResolve?.()
            await new Promise<void>((_resolve, reject) => {
              if (req.signal.aborted) {
                reject(new Error('aborted push by shutdown'))
                return
              }
              req.signal.addEventListener('abort', () => reject(new Error('aborted push by shutdown')), { once: true })
            })
          }
          const mr = fakeV8.mrs.get(req.repo)!.get(req.mrNumber)!.info
          resumedHeadShas.push(mr.headSha)
          await h2.callTool(MR_PUBLISH_REVIEW_TOOL_NAME, {
            headSha: mr.headSha,
            verdict: 'comment',
            body: `Reviewed ${mr.headSha}`,
          }, sid)
          return { sessionId: sid }
        },
      },
    })

    const sup2 = h2.service.mrSupervisorInstance()!
    const domain2 = await h2.service.supervisorDomain()
    const key1 = supervisedMrKey(origin, 1)

    await vi.waitFor(() => {
      expect(resumedHeadShas).toEqual(['sha-mr-1-v1'])
    })
    await sup2.waitForIdle()
    expect(domain2.supervisedMrs.get(key1)?.lastReviewedSha).toBe('sha-mr-1-v1')
    expect(domain2.supervisedMrs.get(key1)?.pendingSignals).toEqual([])

    // Now trigger a push-only turn and abort it via shutdown as well.
    abortOnPush = true
    fakeV8.upsertMr(origin, 1, { headSha: 'sha-mr-1-v2', updatedAt: '2026-11-01T10:01:00Z' })
    await sup2.pollNow()
    await pushTurnStarted
    await h2.dispose()
    expect(abortedTurns).toBe(2)

    let h3!: Awaited<ReturnType<typeof createServiceHarness>>
    h3 = await createServiceHarness({
      fakeV8,
      dir,
      mrConfig: { debounceMs: 0 },
      clock: () => nowMs + 2_000,
      driver: {
        async runTurn(req) {
          const sid = req.existingSessionId ?? 'sess-resume-1'
          await req.onSessionBound?.(sid)
          const mr = fakeV8.mrs.get(req.repo)!.get(req.mrNumber)!.info
          resumedHeadShas.push(mr.headSha)
          await h3.callTool(MR_PUBLISH_REVIEW_TOOL_NAME, {
            headSha: mr.headSha,
            verdict: 'comment',
            body: `Reviewed ${mr.headSha}`,
          }, sid)
          return { sessionId: sid }
        },
      },
    })
    cleanups.push(() => h3.dispose())

    const sup3 = h3.service.mrSupervisorInstance()!
    const domain3 = await h3.service.supervisorDomain()
    await vi.waitFor(() => {
      expect(resumedHeadShas).toEqual(['sha-mr-1-v1', 'sha-mr-1-v2'])
    })
    await sup3.waitForIdle()
    expect(domain3.supervisedMrs.get(key1)?.lastReviewedSha).toBe('sha-mr-1-v2')
    expect(domain3.supervisedMrs.get(key1)?.pendingSignals).toEqual([])
  })

  it('reapplies draft and ignoreLabels filters before admitting queued turns and on intervening polls', async () => {
    const { dir, cleanup } = await tempDir('mr-filter-reapply-')
    cleanups.push(cleanup)

    const fakeV8 = new FakeReposV8(join(dir, 'repos'))
    const origin = 'https://git.example/org/app.git'
    fakeV8.base.setCatalog([{ url: origin, base: 'main' }], ['mr-review'])
    fakeV8.upsertMr(origin, 1, { headSha: 'sha-1-v1', updatedAt: '2026-11-01T11:00:00Z' })
    fakeV8.upsertMr(origin, 2, { headSha: 'sha-2-v1', updatedAt: '2026-11-01T11:00:00Z' })
    fakeV8.upsertMr(origin, 3, { headSha: 'sha-3-v1', updatedAt: '2026-11-01T11:00:00Z' })

    let nowMs = Date.parse('2026-11-01T11:00:00Z')
    const executedMrs: string[] = []
    let h!: Awaited<ReturnType<typeof createServiceHarness>>
    h = await createServiceHarness({
      fakeV8,
      dir,
      mrConfig: { debounceMs: 5_000, skipDraft: true, ignoreLabels: ['wip'] },
      clock: () => nowMs,
      driver: {
        async runTurn(req) {
          const sid = req.existingSessionId ?? `sess-filter-${req.mrNumber}`
          await req.onSessionBound?.(sid)
          const mr = fakeV8.mrs.get(req.repo)!.get(req.mrNumber)!.info
          executedMrs.push(`#${req.mrNumber}@${mr.headSha}`)
          await h.callTool(MR_PUBLISH_REVIEW_TOOL_NAME, {
            headSha: mr.headSha,
            verdict: 'approve',
            body: 'LGTM',
          }, sid)
          return { sessionId: sid }
        },
      },
    })
    cleanups.push(() => h.dispose())

    const supervisor = h.service.mrSupervisorInstance()!
    const domain = await h.service.supervisorDomain()
    const key1 = supervisedMrKey(origin, 1)
    const key2 = supervisedMrKey(origin, 2)
    const key3 = supervisedMrKey(origin, 3)

    await supervisor.pollNow()
    expect(domain.supervisedMrs.get(key1)?.pendingSignals.map(s => s.kind)).toEqual(['opened'])
    expect(domain.supervisedMrs.get(key2)?.pendingSignals.map(s => s.kind)).toEqual(['opened'])
    expect(domain.supervisedMrs.get(key3)?.pendingSignals.map(s => s.kind)).toEqual(['opened'])

    // Mutate MR #1 (draft) and MR #2 (ignored label) AFTER debounce queued, WITHOUT polling first.
    fakeV8.upsertMr(origin, 1, { draft: true, updatedAt: '2026-11-01T11:00:02Z' })
    fakeV8.upsertMr(origin, 2, { labels: ['WIP'], updatedAt: '2026-11-01T11:00:02Z' })

    nowMs += 6_000
    await supervisor.flushDebouncedDue()
    await supervisor.waitForIdle()

    // Only MR #3 ran; #1 transitioned to draft_skipped, #2 cleared pending signals & restored headSha=undefined.
    expect(executedMrs).toEqual(['#3@sha-3-v1'])
    expect(domain.supervisedMrs.get(key1)?.state).toBe('draft_skipped')
    expect(domain.supervisedMrs.get(key1)?.pendingSignals).toEqual([])
    expect(domain.supervisedMrs.get(key2)?.pendingSignals).toEqual([])
    expect(domain.supervisedMrs.get(key2)?.dueAt).toBeUndefined()

    // Push a new commit to MR #3 so it enters debounce, then add ignored label `wip` and poll BEFORE debounce expires.
    nowMs += 1_000
    fakeV8.upsertMr(origin, 3, { headSha: 'sha-3-v2', updatedAt: '2026-11-01T11:00:07Z' })
    await supervisor.pollNow()
    expect(domain.supervisedMrs.get(key3)?.pendingSignals.map(s => s.kind)).toEqual(['push'])

    fakeV8.upsertMr(origin, 3, { labels: ['wip'], updatedAt: '2026-11-01T11:00:08Z' })
    await supervisor.pollNow()
    expect(domain.supervisedMrs.get(key3)?.pendingSignals).toEqual([])
    expect(domain.supervisedMrs.get(key3)?.dueAt).toBeUndefined()

    nowMs += 6_000
    await supervisor.flushDebouncedDue()
    await supervisor.waitForIdle()
    expect(executedMrs).toEqual(['#3@sha-3-v1'])

    // Un-draft #1 and remove `wip` from #2 and #3 -> all three resume cleanly!
    fakeV8.upsertMr(origin, 1, { draft: false, updatedAt: '2026-11-01T11:00:15Z' })
    fakeV8.upsertMr(origin, 2, { labels: [], updatedAt: '2026-11-01T11:00:15Z' })
    fakeV8.upsertMr(origin, 3, { labels: [], updatedAt: '2026-11-01T11:00:15Z' })
    await supervisor.pollNow()

    nowMs += 6_000
    await supervisor.flushDebouncedDue()
    await supervisor.waitForIdle()
    expect(executedMrs.sort()).toEqual(['#1@sha-1-v1', '#2@sha-2-v1', '#3@sha-3-v1', '#3@sha-3-v2'].sort())
  })

  it('never lets bot publication timestamps suppress unseen mid-turn human feedback when seenNoteIds hits cap', async () => {
    const { dir, cleanup } = await tempDir('mr-note-watermark-')
    cleanups.push(cleanup)

    const fakeV8 = new FakeReposV8(join(dir, 'repos'))
    const origin = 'https://git.example/org/app.git'
    fakeV8.base.setCatalog([{ url: origin, base: 'main' }], ['mr-review'])

    // Unit check for `advanceHumanNoteWatermark`: bot comments must not advance cursor past unseen human feedback.
    const unitCursor = advanceHumanNoteWatermark({
      detail: {
        comments: [
          { id: 'h-1', author: { username: 'alice' }, body: 'Seen old comment', createdAt: '2026-11-01T00:01:00Z' },
          { id: 'h-mid', author: { username: 'bob' }, body: 'Unseen mid-turn', createdAt: '2026-11-01T00:02:00Z' },
          { id: 'bot-1', author: { username: 'dsh-bot' }, body: 'Bot review', createdAt: '2026-11-01T00:05:00Z' },
        ],
      },
      discussions: [],
      bot: { username: 'dsh-bot' },
      previousSeenNoteIds: ['c:h-1'],
      nextSeenNoteIds: ['c:h-1', 'c:bot-1'],
      pendingSignals: [],
      deliveredNoteIds: undefined,
      previousCursor: undefined,
    })
    expect(unitCursor).toBe('2026-11-01T00:01:00Z')

    // End-to-end check: seenNoteIds reaches 500 cap, human comment arrives mid-turn at 00:02:00Z before bot mrReview at 00:05:XXZ.
    fakeV8.upsertMr(origin, 1, { headSha: 'sha-v1', updatedAt: '2026-11-01T00:00:10Z' })

    const deliveredBatches: Array<{ readonly headSha: string; readonly kinds: readonly string[] }> = []
    let turnCount = 0
    let h!: Awaited<ReturnType<typeof createServiceHarness>>
    h = await createServiceHarness({
      fakeV8,
      dir,
      mrConfig: { debounceMs: 0 },
      driver: {
        async runTurn(req) {
          turnCount += 1
          const sid = req.existingSessionId ?? 'sess-cap-1'
          await req.onSessionBound?.(sid)
          const stored = fakeV8.mrs.get(req.repo)!.get(req.mrNumber)!
          deliveredBatches.push({
            headSha: stored.info.headSha,
            kinds: (await h.service.supervisorDomain()).supervisedMrs.get(supervisedMrKey(req.repo, req.mrNumber))?.deliveredNoteIds ?? [],
          })
          if (turnCount === 2) {
            // Simulate a human comment posted mid-turn at 00:02:00Z (earlier than FakeReposV8.mrReview's 00:05:XXZ).
            stored.comments.push({
              id: 'human-mid-1',
              author: { username: 'carol' },
              body: 'Mid-turn edge case concern',
              createdAt: '2026-11-01T00:02:00Z',
            })
            stored.info = { ...stored.info, updatedAt: '2026-11-01T00:06:00Z' }
          }
          await h.callTool(MR_PUBLISH_REVIEW_TOOL_NAME, {
            headSha: stored.info.headSha,
            verdict: 'comment',
            body: `Review #${turnCount}`,
          }, sid)
          return { sessionId: sid }
        },
      },
    })
    cleanups.push(() => h.dispose())

    const supervisor = h.service.mrSupervisorInstance()!
    const domain = await h.service.supervisorDomain()
    const key1 = supervisedMrKey(origin, 1)

    // Turn 1: initial review of sha-v1.
    await supervisor.pollNow()
    await supervisor.flushDebouncedDue()
    await supervisor.waitForIdle()
    expect(domain.supervisedMrs.get(key1)?.lastReviewedSha).toBe('sha-v1')

    // Fill seenNoteIds to the 500-entry cap so the next poll must consult `lastNoteCursor` for unknown IDs.
    const existingRec = domain.supervisedMrs.get(key1)!
    const cappedSeen = Array.from({ length: MAX_SEEN_NOTE_IDS }, (_, i) => `c:old-${i}`)
    await domain.supervisedMrs.put(key1, { ...existingRec, seenNoteIds: cappedSeen })

    // Push sha-v2 -> Turn 2 sees mid-turn human comment at 00:02:00Z before bot publishes at 00:05:XXZ.
    fakeV8.upsertMr(origin, 1, { headSha: 'sha-v2', updatedAt: '2026-11-01T00:01:30Z' })
    await supervisor.pollNow()
    await supervisor.flushDebouncedDue()
    await supervisor.waitForIdle()

    const afterTurn2 = domain.supervisedMrs.get(key1)!
    expect(afterTurn2.seenNoteIds?.length).toBe(MAX_SEEN_NOTE_IDS)
    expect(afterTurn2.lastNoteCursor === undefined || afterTurn2.lastNoteCursor < '2026-11-01T00:02:00Z').toBe(true)

    // Next poll must NOT discard `human-mid-1` even though seenNoteIds is at 500 and bot review has a later timestamp!
    await supervisor.pollNow()
    expect(domain.supervisedMrs.get(key1)?.pendingSignals.map(s => s.noteId)).toEqual(['human-mid-1'])

    await supervisor.flushDebouncedDue()
    await supervisor.waitForIdle()
    expect(turnCount).toBe(3)
    expect(domain.supervisedMrs.get(key1)?.seenNoteIds).toContain('c:human-mid-1')
  })

  it('persists in-flight signal batches until checkpointed and recovers orphaned deliveredNoteIds after an unclean crash', async () => {
    const { dir, cleanup } = await tempDir('mr-crash-recovery-')
    cleanups.push(cleanup)

    const fakeV8 = new FakeReposV8(join(dir, 'repos'))
    const origin = 'https://git.example/org/app.git'
    fakeV8.base.setCatalog([{ url: origin, base: 'main' }], ['mr-review'])
    fakeV8.upsertMr(origin, 1, { headSha: 'sha-crash-1', updatedAt: '2026-11-01T12:00:00Z' })

    const dirLive = join(dir, 'live')
    const dirCrash = join(dir, 'crashed')

    let snapshotBeforePublish: ReturnType<Awaited<ReturnType<typeof openSupervisorDomain>>['supervisedMrs']['get']>
    let h1!: Awaited<ReturnType<typeof createServiceHarness>>
    h1 = await createServiceHarness({
      fakeV8,
      dir: dirLive,
      mrConfig: { debounceMs: 0 },
      driver: {
        async runTurn(req) {
          const sid = req.existingSessionId ?? 'sess-crash-1'
          await req.onSessionBound?.(sid)
          const d1 = await h1.service.supervisorDomain()
          snapshotBeforePublish = d1.supervisedMrs.get(supervisedMrKey(req.repo, req.mrNumber))
          await h1.callTool(MR_PUBLISH_REVIEW_TOOL_NAME, {
            headSha: 'sha-crash-1',
            verdict: 'comment',
            body: 'Completed in h1',
          }, sid)
          return { sessionId: sid }
        },
      },
    })
    cleanups.push(() => h1.dispose())

    const sup1 = h1.service.mrSupervisorInstance()!
    const dom1 = await h1.service.supervisorDomain()
    const key1 = supervisedMrKey(origin, 1)

    // Seed an open record that already has a tracked MR + an unseen human note waiting to be delivered.
    fakeV8.upsertMr(
      origin,
      1,
      { headSha: 'sha-crash-1', updatedAt: '2026-11-01T12:00:10Z' },
      {
        comments: [{ id: 'human-crash-note', author: { username: 'alice' }, body: 'Please check', createdAt: '2026-11-01T12:00:10Z' }],
      },
    )
    await dom1.supervisedMrs.put(key1, {
      repo: origin,
      mrNumber: 1,
      origin: 'external',
      state: 'open',
      headSha: 'sha-crash-1',
      ownPushedShas: [],
      autoFixAttempts: 0,
      pendingSignals: [
        { kind: 'push', observedAt: 1000, headSha: 'sha-crash-1' },
        { kind: 'discussion', observedAt: 1001, headSha: 'sha-crash-1', noteId: 'human-crash-note', summary: 'Please check' },
      ],
      dueAt: 0,
    })
    await sup1.pollNow()
    await sup1.flushDebouncedDue()
    await sup1.waitForIdle()

    // While runTurn was executing (before publish/checkpoint), durable record retained pendingSignals + deliveredNoteIds!
    expect(snapshotBeforePublish?.pendingSignals.map(s => s.kind)).toEqual(['push', 'discussion'])
    expect(snapshotBeforePublish?.deliveredNoteIds).toEqual(['c:human-crash-note'])
    expect(snapshotBeforePublish?.dueAt).toBeUndefined()

    // Simulate an unclean SIGKILL crash mid-turn: write that exact mid-turn record into `dirCrash` without running rollback.
    const crashSupervisorDir = join(dirCrash, 'supervisor')
    await mkdir(crashSupervisorDir, { recursive: true })
    const crashDomain = await openSupervisorDomain({ fallbackDir: crashSupervisorDir })
    await crashDomain.supervisedMrs.put(key1, snapshotBeforePublish!)
    await crashDomain.close()

    // Boot fresh service on `dirCrash`: boot() must clear orphaned deliveredNoteIds and recover uncheckpointed signals!
    const recoveredHeads: string[] = []
    let h2!: Awaited<ReturnType<typeof createServiceHarness>>
    h2 = await createServiceHarness({
      fakeV8,
      dir: dirCrash,
      mrConfig: { debounceMs: 0 },
      driver: {
        async runTurn(req) {
          const sid = req.existingSessionId ?? 'sess-crash-1'
          await req.onSessionBound?.(sid)
          recoveredHeads.push('sha-crash-1')
          await h2.callTool(MR_PUBLISH_REVIEW_TOOL_NAME, {
            headSha: 'sha-crash-1',
            verdict: 'approve',
            body: 'Recovered cleanly after crash',
          }, sid)
          return { sessionId: sid }
        },
      },
    })
    cleanups.push(() => h2.dispose())

    const sup2 = h2.service.mrSupervisorInstance()!
    const dom2 = await h2.service.supervisorDomain()
    await vi.waitFor(() => {
      expect(recoveredHeads).toEqual(['sha-crash-1'])
    })
    await sup2.waitForIdle()
    expect(dom2.supervisedMrs.get(key1)?.lastReviewedSha).toBe('sha-crash-1')
    expect(dom2.supervisedMrs.get(key1)?.pendingSignals).toEqual([])
    expect(dom2.supervisedMrs.get(key1)?.deliveredNoteIds).toBeUndefined()
    expect(dom2.supervisedMrs.get(key1)?.seenNoteIds).toContain('c:human-crash-note')
  })

  it('keeps supervisor_mr_prepare_workspace from consuming concurrent pushes before publish', async () => {
    const { dir, cleanup } = await tempDir('mr-prepare-head-race-')
    cleanups.push(cleanup)

    const origin = await createAppRepo(join(dir, 'repo'))
    const fakeV8 = new FakeReposV8(join(dir, 'repos'))
    fakeV8.base.setCatalog([{ url: origin, base: 'main' }], ['mr-review'])
    fakeV8.upsertMr(origin, 1, { headSha: 'sha-A', updatedAt: '2026-11-01T13:00:00Z' })

    const publishedHeads: string[] = []
    let turnNumber = 0
    let h!: Awaited<ReturnType<typeof createServiceHarness>>
    h = await createServiceHarness({
      fakeV8,
      dir,
      mrConfig: { debounceMs: 0 },
      driver: {
        async runTurn(req) {
          turnNumber += 1
          const sid = req.existingSessionId ?? 'sess-race-1'
          await req.onSessionBound?.(sid)
          if (turnNumber === 1) {
            // Race: author pushes sha-B right before prepare_workspace runs, while turn prompt targets sha-A!
            fakeV8.upsertMr(origin, 1, { headSha: 'sha-B', updatedAt: '2026-11-01T13:00:05Z' })
            const prep = await h.callTool(MR_PREPARE_TOOL_NAME, {}, sid) as { readonly headSha: string }
            expect(prep.headSha).toBe('sha-B')
            publishedHeads.push('sha-A')
            await h.callTool(MR_PUBLISH_REVIEW_TOOL_NAME, {
              headSha: 'sha-A',
              verdict: 'comment',
              body: 'Review for sha-A',
            }, sid)
          } else {
            const prep = await h.callTool(MR_PREPARE_TOOL_NAME, {}, sid) as { readonly headSha: string }
            publishedHeads.push(prep.headSha)
            await h.callTool(MR_PUBLISH_REVIEW_TOOL_NAME, {
              headSha: prep.headSha,
              verdict: 'approve',
              body: 'Incremental review for sha-B',
            }, sid)
          }
          return { sessionId: sid }
        },
      },
    })
    cleanups.push(() => h.dispose())

    const supervisor = h.service.mrSupervisorInstance()!
    const domain = await h.service.supervisorDomain()
    const key1 = supervisedMrKey(origin, 1)

    await supervisor.pollNow()
    await supervisor.flushDebouncedDue()
    await supervisor.waitForIdle()
    expect(publishedHeads).toEqual(['sha-A'])
    expect(domain.supervisedMrs.get(key1)?.lastReviewedSha).toBe('sha-A')

    // Next poll MUST detect sha-B as a push signal (not swallowed by prepare_workspace)!
    await supervisor.pollNow()
    expect(domain.supervisedMrs.get(key1)?.pendingSignals.map(s => ({ kind: s.kind, headSha: s.headSha }))).toEqual([
      { kind: 'push', headSha: 'sha-B' },
    ])

    await supervisor.flushDebouncedDue()
    await supervisor.waitForIdle()
    expect(publishedHeads).toEqual(['sha-A', 'sha-B'])
    expect(domain.supervisedMrs.get(key1)?.lastReviewedSha).toBe('sha-B')
  })

  it('treats max-tokens turn termination as incomplete so uncheckpointed signals are retained for retry', async () => {
    const submittedRequests: Array<{ readonly sessionId: string; readonly requestId: string }> = []
    const ctx: HostContext = {
      tools: { register: () => () => {} },
      skills: { registerProvider: () => () => {} },
      subagents: { getProvider: () => ({}), resolveMaxDepth: () => 1, startActivation: () => Promise.reject(new Error('unused')) },
      on: () => () => {},
      effect: () => () => {},
      get: (name: string) => {
        if (name !== 'sessionController') return undefined
        return {
          resolveAgent: async (sessionId: string) => ({
            agent: { id: 'agent-1', session: { header: { id: sessionId } } },
          }),
          prompt: async (req: { readonly sessionId: string; readonly requestId: string }) => {
            submittedRequests.push(req)
            return { accepted: true }
          },
        }
      },
    }

    const driver = createHostMrSessionDriver(ctx)
    cleanups.push(async () => { driver.dispose?.() })

    const turnPromise = driver.runTurn({
      repo: 'https://git.example/org/app.git',
      mrNumber: 1,
      origin: 'external',
      existingSessionId: 'sess-max-tok',
      workDir: '/tmp/mr-max-tokens',
      prompt: 'Review MR',
      signal: new AbortController().signal,
    })

    await vi.waitFor(() => { expect(submittedRequests).toHaveLength(1) })
    const req = submittedRequests[0]!
    driver.onSessionEvent('sess-max-tok', 'turn/start', { turn: 1 })
    driver.onSessionEvent('sess-max-tok', 'user/message', { id: 'm1', source: { kind: 'user', rpcId: req.requestId } })
    driver.onSessionEvent('sess-max-tok', 'turn/end', { turn: 1, reason: { kind: 'max-tokens' } })
    expect(await turnPromise).toEqual({ sessionId: 'sess-max-tok', error: 'max-tokens' })

    // Verify MrSupervisor rolls back uncheckpointed signals on `{ error: 'max-tokens' }`.
    const { dir, cleanup } = await tempDir('mr-max-tokens-e2e-')
    cleanups.push(cleanup)
    const fakeV8 = new FakeReposV8(join(dir, 'repos'))
    const origin = 'https://git.example/org/app.git'
    fakeV8.base.setCatalog([{ url: origin, base: 'main' }], ['mr-review'])
    fakeV8.upsertMr(origin, 1, { headSha: 'sha-tok-1', updatedAt: '2026-11-01T14:00:00Z' })

    let run = 0
    let h!: Awaited<ReturnType<typeof createServiceHarness>>
    h = await createServiceHarness({
      fakeV8,
      dir,
      mrConfig: { debounceMs: 0 },
      driver: {
        async runTurn(r) {
          run += 1
          const sid = r.existingSessionId ?? 'sess-tok-e2e'
          await r.onSessionBound?.(sid)
          if (run === 1) {
            return { sessionId: sid, error: 'max-tokens' }
          }
          await h.callTool(MR_PUBLISH_REVIEW_TOOL_NAME, {
            headSha: 'sha-tok-1',
            verdict: 'approve',
            body: 'Completed on retry',
          }, sid)
          return { sessionId: sid }
        },
      },
    })
    cleanups.push(() => h.dispose())

    const sup = h.service.mrSupervisorInstance()!
    const dom = await h.service.supervisorDomain()
    const key1 = supervisedMrKey(origin, 1)

    await sup.pollNow()
    await sup.flushDebouncedDue()
    await sup.waitForIdle()
    expect(run).toBe(1)
    expect(dom.supervisedMrs.get(key1)?.pendingSignals.map(s => s.kind)).toEqual(['opened'])
    expect(dom.supervisedMrs.get(key1)?.lastReviewedSha).toBeUndefined()

    await sup.pollNow()
    await sup.flushDebouncedDue()
    await sup.waitForIdle()
    expect(run).toBe(2)
    expect(dom.supervisedMrs.get(key1)?.lastReviewedSha).toBe('sha-tok-1')
    expect(dom.supervisedMrs.get(key1)?.pendingSignals).toEqual([])
  })

  it('deduplicates active CI repairs across polls and prunes obsolete queued CI failures', async () => {
    const { dir, cleanup } = await tempDir('mr-ci-dedupe-')
    cleanups.push(cleanup)

    const fakeV8 = new FakeReposV8(join(dir, 'repos'))
    const origin = 'https://git.example/org/app.git'
    fakeV8.base.setCatalog([{ url: origin, base: 'main' }], ['mr-review'])
    const stored20 = fakeV8.upsertMr(
      origin,
      20,
      { headSha: 'sha-fail-1', updatedAt: '2026-11-01T15:00:00Z' },
      { status: { headSha: 'sha-fail-1', checks: [{ name: 'test', state: 'failure' }], overall: 'failure', mergeable: true } },
    )

    let repairTurns = 0
    let turn1EnteredResolve: (() => void) | undefined
    let releaseTurn1: (() => void) | undefined
    const turn1Entered = new Promise<void>(resolve => { turn1EnteredResolve = resolve })
    let nowMs = Date.parse('2026-11-01T15:00:00Z')

    let h!: Awaited<ReturnType<typeof createServiceHarness>>
    h = await createServiceHarness({
      fakeV8,
      dir,
      clock: () => nowMs,
      mrConfig: { debounceMs: 5_000, maxAutoFixAttempts: 2 },
      driver: {
        async runTurn(req) {
          repairTurns += 1
          const sid = req.existingSessionId ?? 'sess-ci-20'
          await req.onSessionBound?.(sid)
          if (repairTurns === 1) {
            turn1EnteredResolve?.()
            await new Promise<void>(resolve => { releaseTurn1 = resolve })
            // Fix pushed and CI now passing on sha-fix-2.
            stored20.info = { ...stored20.info, headSha: 'sha-fix-2', updatedAt: '2026-11-01T15:02:00Z' }
            stored20.status = { headSha: 'sha-fix-2', checks: [{ name: 'test', state: 'success' }], overall: 'success', mergeable: true }
            await h.callTool(MR_CHECKPOINT_TOOL_NAME, { ownPushedSha: 'sha-fix-2' }, sid)
          }
          return { sessionId: sid }
        },
      },
    })
    cleanups.push(() => h.dispose())

    const sup = h.service.mrSupervisorInstance()!
    const dom = await h.service.supervisorDomain()
    const key20 = supervisedMrKey(origin, 20)

    await sup.registerSelfMr({
      repo: origin,
      mrNumber: 20,
      origin: 'self-fix',
      issueId: 'iss-20',
      feishuLaunchKey: 'feishu:20',
      headSha: 'sha-fail-1',
    })

    // Poll detects failing CI -> wait past debounce -> Turn 1 starts.
    nowMs += 1_000
    await sup.pollNow()
    nowMs += 6_000
    const flush1 = sup.flushDebouncedDue()
    await turn1Entered

    // While Turn 1 is actively repairing sha-fail-1, another poll runs -> must NOT duplicate `ci-failed`!
    nowMs += 1_000
    await sup.pollNow()
    expect(dom.supervisedMrs.get(key20)?.pendingSignals.filter(s => s.kind === 'ci-failed')).toHaveLength(1)

    releaseTurn1?.()
    await flush1
    await sup.waitForIdle()
    expect(repairTurns).toBe(1)
    expect(dom.supervisedMrs.get(key20)?.autoFixAttempts).toBe(1)
    expect(dom.supervisedMrs.get(key20)?.pendingSignals).toEqual([])

    // Queue a ci-failed for sha-fix-2, then CI flips back to passing BEFORE debounce flushes -> pruned without running Turn 2!
    stored20.status = { headSha: 'sha-fix-2', checks: [{ name: 'test', state: 'failure' }], overall: 'failure', mergeable: true }
    stored20.info = { ...stored20.info, updatedAt: '2026-11-01T15:03:00Z' }
    nowMs += 1_000
    await sup.pollNow()
    expect(dom.supervisedMrs.get(key20)?.pendingSignals.map(s => s.kind)).toEqual(['ci-failed'])

    stored20.status = { headSha: 'sha-fix-2', checks: [{ name: 'test', state: 'success' }], overall: 'success', mergeable: true }
    nowMs += 6_000
    await sup.flushDebouncedDue()
    await sup.waitForIdle()
    expect(repairTurns).toBe(1)
    expect(dom.supervisedMrs.get(key20)?.autoFixAttempts).toBe(1)
    expect(dom.supervisedMrs.get(key20)?.pendingSignals).toEqual([])
  })
})
