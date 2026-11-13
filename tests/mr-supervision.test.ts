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
  MrReviewParams,
  MrStatus,
  RepoUser,
} from '../src/deps/repos-contract.ts'
import { DSH_REPOS_SERVICE } from '../src/deps/repos.ts'
import type { HostContext, ToolActivationContext, ToolDefinition } from '../src/host.ts'
import {
  classifyMrPollUpdate,
  isSameBotUser,
  normalizeBotHandle,
} from '../src/mr/signals.ts'
import type { MrSessionDriver, MrSessionTurnRequest } from '../src/mr/session-driver.ts'
import { resolveConfig } from '../src/config.ts'
import { openSupervisorDomain, supervisedMrKey } from '../src/runtime/domain.ts'
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
        const list = [...(this.mrs.get(params.repo)?.values() ?? [])]
          .map(entry => entry.info)
          .filter(item => params.state === 'all' || params.state === undefined || item.state === params.state)
          .filter(item => params.targetBranch === undefined || item.targetBranch === params.targetBranch)
          .filter(item => params.updatedAfter === undefined || item.updatedAt >= params.updatedAfter)
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        return { items: list }
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
})
