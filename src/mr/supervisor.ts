/**
 * 审微有状态 MR 监管编排器（`MrSupervisor`）：
 * - 跟随 `dsh-repo` 启用 `mr-review` 的仓库，增量轮询开放与近期更新的 MR；
 * - 经 `KeyedDebouncer`（sliding 窗口）合并短时间内的连续 push 与人类讨论信号；
 * - 复用 `TaskPool`（`mrPool`）控制并发，并为每条 MR 维持持久化会话（首次无头创建，后续增量唤醒，己方 MR 复用原话题会话）；
 * - 集成 `CircuitBreakerRegistry`（单 MR 日限、单仓库时限、CI 自修上限）并支持面板状态展示与一键解除熔断；
 * - 遵守自触发防护铁律与已关闭 MR（14 天工作区清理 / 60 天记录清理）留存策略。
 *
 * @module dsh-logalyze/mr/supervisor
 */

import type { DshReposV8, MrDetail, MrInfo, MrStatus, RepoUser } from '../deps/repos-contract.ts'
import type { ReposClient } from '../deps/repos.ts'
import type { HostLogger } from '../host.ts'
import type { CircuitBreakerRegistry } from '../runtime/breaker.ts'
import { KeyedDebouncer } from '../runtime/debouncer.ts'
import { supervisedMrKey } from '../runtime/domain.ts'
import type {
  IssuesTable,
  MrOrigin,
  MrPendingSignal,
  SupervisedMrRecord,
} from '../runtime/domain.ts'
import type { DomainTable } from '../runtime/storage.ts'
import type { TaskPool } from '../runtime/pool.ts'
import type {
  BreakerStatusWire,
  MrRepoStatusWire,
  MrReviewSettings,
  MrSupervisionWire,
  SupervisedMrWire,
} from '../settings/contract.ts'
import { messageOf } from '../util/errors.ts'
import { buildMrWakePrompt } from './prompt.ts'
import type { MrSessionDriver } from './session-driver.ts'
import {
  MAX_OWN_PUSHED_SHAS,
  MAX_SEEN_NOTE_IDS,
  type MrIgnoreReason,
  advanceHumanNoteWatermark,
  appendBoundedUnique,
  canonicalCommentKey,
  canonicalDiscussionNoteKey,
  classifyMrPollUpdate,
  evaluateMrFilter,
  mergePendingSignals,
  signalNoteKeys,
  subtractPendingSignals,
} from './signals.ts'
import { listAllDiscussions } from './tools.ts'
import type { MrToolsRuntime } from './tools.ts'
import { defaultMrWorkDir, removeExpiredMrWorkspace } from './workspace.ts'

const DAY_MS = 24 * 60 * 60 * 1000
const HOUR_MS = 60 * 60 * 1000
const WORKDIR_RETENTION_MS = 14 * DAY_MS
const RECORD_RETENTION_MS = 60 * DAY_MS
const DEBOUNCE_MAX_WAIT_MS = 5 * 60 * 1000
const MAX_MR_LIST_PAGES = 1_000

type TurnOutcome = 'ran' | 'noop' | 'blocked'

interface RepoPaginationProgress {
  readonly nextPage: number
  readonly state: 'open' | 'all'
  readonly targetBranch: string | undefined
  readonly updatedAfter: string | undefined
  readonly watermarkMs: number | undefined
}

/** Parameters to register a self-authored MR (`self-fix` / `self-skill`). */
export interface RegisterSelfMrInput {
  readonly repo: string
  readonly mrNumber: number
  readonly origin: Extract<MrOrigin, 'self-fix' | 'self-skill'>
  readonly headSha: string
  readonly sessionId?: string
  readonly workDir?: string
  readonly feishuLaunchKey?: string
  readonly issueId?: string
  readonly title?: string
  readonly url?: string
  readonly sourceBranch?: string
  readonly targetBranch?: string
  readonly author?: string
}

/** Notification sink when a circuit breaker trips or human intervention is needed. */
export type MrHumanNotifier = (input: {
  readonly repo: string
  readonly mrNumber?: number
  readonly feishuLaunchKey?: string
  readonly text: string
}) => Promise<void>

/** Collaborators for {@link MrSupervisor}. */
export interface MrSupervisorDeps {
  readonly table: DomainTable<SupervisedMrRecord>
  readonly breakers: CircuitBreakerRegistry
  readonly issues?: IssuesTable
  readonly repos: ReposClient
  readonly mrPool: TaskPool
  readonly workspacesRoot: string
  readonly sessionDriver: MrSessionDriver
  readonly getSettings: () => MrReviewSettings
  readonly getMrRepos: () => readonly MrRepoStatusWire[]
  readonly notifyHuman?: MrHumanNotifier
  readonly onChange?: () => void
  readonly now?: () => number
  readonly logger?: HostLogger
  /** Override periodic timer creation in tests. */
  readonly autoPollTimer?: boolean
  /** Override maximum `mrList` pages fetched per repository per poll (primarily for tests). */
  readonly maxListPagesPerPoll?: number
}

function breakerStorageKey(scope: BreakerStatusWire['scope'], key: string): string {
  switch (scope) {
    case 'mr': return `mr:${key}`
    case 'mr-repo': return `mr-repo:${key}`
    case 'mr-fix': return `mr-fix:${key}`
    case 'log-app': return `log:${key}`
  }
}

export function parseBreakerStorageKey(storageKey: string): { readonly scope: BreakerStatusWire['scope']; readonly key: string } | undefined {
  if (storageKey.startsWith('mr-repo:')) return { scope: 'mr-repo', key: storageKey.slice('mr-repo:'.length) }
  if (storageKey.startsWith('mr-fix:')) return { scope: 'mr-fix', key: storageKey.slice('mr-fix:'.length) }
  if (storageKey.startsWith('mr:')) return { scope: 'mr', key: storageKey.slice('mr:'.length) }
  if (storageKey.startsWith('log:')) return { scope: 'log-app', key: storageKey.slice('log:'.length) }
  return undefined
}

async function listRepoMrs(
  repos: DshReposV8,
  params: {
    readonly repo: string
    readonly state: 'open' | 'all'
    readonly targetBranch?: string
    readonly updatedAfter?: string
    readonly startPage?: number
    readonly maxPages?: number
  },
  signal?: AbortSignal,
): Promise<{ readonly items: MrInfo[]; readonly nextPage: number | undefined }> {
  const collected: MrInfo[] = []
  const maxPages = Math.max(1, params.maxPages ?? MAX_MR_LIST_PAGES)
  let page = Math.max(1, params.startPage ?? 1)
  let nextPage: number | undefined
  for (let i = 0; i < maxPages; i += 1) {
    signal?.throwIfAborted()
    const res = await repos.mrList({
      repo: params.repo,
      state: params.state,
      ...(params.targetBranch === undefined ? {} : { targetBranch: params.targetBranch }),
      sort: 'updated',
      ...(params.updatedAfter === undefined ? {} : { updatedAfter: params.updatedAfter }),
      page,
      perPage: 50,
      signal,
    })
    collected.push(...res.items)
    if (res.nextPage === undefined || res.items.length === 0 || res.nextPage <= page) {
      nextPage = undefined
      break
    }
    nextPage = res.nextPage
    page = res.nextPage
  }
  return { items: collected, nextPage }
}

/** Stateful orchestrator supervising MR discovery, debounced wakeups, persistent sessions, and safety limits. */
export class MrSupervisor implements MrToolsRuntime {
  private readonly now: () => number
  private readonly autoPollTimer: boolean
  private readonly maxListPagesPerPoll: number
  private readonly debouncer: KeyedDebouncer<MrPendingSignal, string>
  private readonly keyLocks = new Map<string, Promise<unknown>>()
  private readonly sessionToKey = new Map<string, string>()
  private readonly repoCursors = new Map<string, number>()
  private readonly repoBackfill = new Map<string, RepoPaginationProgress>()
  private readonly runningKeys = new Set<string>()
  private readonly rerunNeeded = new Set<string>()
  private readonly activeFlushPromises = new Set<Promise<void>>()
  private pollTimer: ReturnType<typeof setTimeout> | undefined
  private pollInFlight: Promise<void> | undefined
  private lastPollAt: number | undefined
  private lastError: string | undefined
  private lastFilterSignature: string | undefined
  private closed = false
  private started = false

  constructor(private readonly deps: MrSupervisorDeps) {
    this.now = deps.now ?? Date.now
    this.autoPollTimer = deps.autoPollTimer ?? true
    this.maxListPagesPerPoll = Math.max(1, deps.maxListPagesPerPoll ?? MAX_MR_LIST_PAGES)
    this.debouncer = new KeyedDebouncer<MrPendingSignal, string>({
      windowMs: Math.max(0, deps.getSettings().debounceMs),
      mode: 'sliding',
      maxWaitMs: DEBOUNCE_MAX_WAIT_MS,
      merge: (existing, incoming) => mergePendingSignals(existing, [incoming]),
      onFlush: (key) => {
        const promise = this.handleDebouncedFlush(key)
        this.trackFlushPromise(promise)
        return promise
      },
      onError: (error, key) => {
        this.lastError = `MR 会话唤醒失败 (${key})：${messageOf(error)}`
        this.deps.logger?.error?.('logalyze: %s', this.lastError)
      },
      now: this.now,
    })
  }

  /** Rehydrate durable `supervised_mrs` index + pending debounce timers and start polling. */
  async boot(): Promise<void> {
    if (this.closed) return
    const currentNow = this.now()
    const settings = this.deps.getSettings()
    const enabled = settings.enabled
    this.lastFilterSignature = this.computeFilterSignature(settings)
    for (const [key, record] of this.deps.table.entries()) {
      if (record.sessionId !== undefined) {
        this.sessionToKey.set(record.sessionId, key)
      }
      if (
        enabled
        && record.state === 'open'
        && record.pendingSignals.length > 0
        && record.dueAt !== undefined
        && this.isRecordRepoEligible(record)
        && !this.isTurnBreakerTripped(key, record.repo)
      ) {
        const remainingMs = Math.max(0, record.dueAt - currentNow)
        for (const sig of record.pendingSignals) {
          this.debouncer.push(key, sig, { windowMs: remainingMs })
        }
      }
    }
    this.started = true
    await this.sweepRetention().catch((error: unknown) => {
      this.deps.logger?.warn?.('logalyze: MR 留存清理失败：%s', messageOf(error))
    })
    await this.suspendIneligibleDeadlines().catch((error: unknown) => {
      this.deps.logger?.warn?.('logalyze: 清理未启用仓库 MR 截止时间失败：%s', messageOf(error))
    })
    await this.resumeDormantPending()
    this.scheduleNextPoll(0)
  }

  /** Notify supervisor when `mr-review` repository list or settings changed. */
  notifyConfigOrReposChanged(): void {
    if (this.closed || !this.started) return
    this.pruneRemovedRepoWatermarks()
    const settings = this.deps.getSettings()
    const nextFilterSig = this.computeFilterSignature(settings)
    if (this.lastFilterSignature !== nextFilterSig) {
      this.lastFilterSignature = nextFilterSig
      this.repoCursors.clear()
      this.repoBackfill.clear()
    }
    this.deps.mrPool.setConcurrency(settings.maxConcurrentSessions)
    if (!settings.enabled) {
      this.debouncer.cancelAll()
      const suspendPromise = this.suspendPendingDeadlines().catch((error: unknown) => {
        this.deps.logger?.warn?.('logalyze: 清理暂停 MR 截止时间失败：%s', messageOf(error))
      })
      this.trackFlushPromise(suspendPromise)
      return
    }
    for (const [mrKey, rec] of this.deps.table.entries()) {
      if (!this.isRecordRepoEligible(rec)) {
        this.debouncer.cancel(mrKey)
      }
    }
    const reconcilePromise = this.reconcilePendingEligibility().catch((error: unknown) => {
      this.deps.logger?.warn?.('logalyze: MR 恢复待办失败：%s', messageOf(error))
    })
    this.trackFlushPromise(reconcilePromise)
    this.scheduleNextPoll(0)
  }

  /** Whether a host session ID is bound to any supervised MR. */
  isMrSession(sessionId: string): boolean {
    if (this.sessionToKey.has(sessionId)) return true
    for (const [key, record] of this.deps.table.entries()) {
      if (record.sessionId === sessionId) {
        this.sessionToKey.set(sessionId, key)
        return true
      }
    }
    return false
  }

  requireV8(): DshReposV8 {
    return this.deps.repos.requireV8()
  }

  workspacesRoot(): string {
    return this.deps.workspacesRoot
  }

  resolveForTool(sessionId: string, repo?: string, mrNumber?: number): SupervisedMrRecord {
    const mappedKey = this.sessionToKey.get(sessionId)
    if (mappedKey !== undefined) {
      const rec = this.deps.table.get(mappedKey)
      if (rec !== undefined) {
        if ((repo !== undefined && rec.repo !== repo) || (mrNumber !== undefined && rec.mrNumber !== mrNumber)) {
          throw new Error(`当前会话已绑定 MR ${rec.repo}#${rec.mrNumber}，不能跨 MR 操作 ${repo ?? rec.repo}#${mrNumber ?? rec.mrNumber}`)
        }
        return rec
      }
    }
    for (const [key, rec] of this.deps.table.entries()) {
      if (rec.sessionId === sessionId) {
        this.sessionToKey.set(sessionId, key)
        if ((repo !== undefined && rec.repo !== repo) || (mrNumber !== undefined && rec.mrNumber !== mrNumber)) {
          throw new Error(`当前会话已绑定 MR ${rec.repo}#${rec.mrNumber}，不能跨 MR 操作`)
        }
        return rec
      }
    }
    if (repo !== undefined && mrNumber !== undefined) {
      const explicit = this.deps.table.get(supervisedMrKey(repo, mrNumber))
      if (explicit !== undefined) return explicit
    }
    throw new Error('当前会话未绑定任何受监管的 MR（请确保工具仅在审微 MR 会话中使用或显式指定 repo 与 mrNumber）')
  }

  async updateRecord(
    repo: string,
    mrNumber: number,
    updater: (current: SupervisedMrRecord) => SupervisedMrRecord,
  ): Promise<SupervisedMrRecord> {
    const key = supervisedMrKey(repo, mrNumber)
    return this.withKeyLock(key, async () => {
      const current = this.deps.table.get(key)
      if (current === undefined) {
        throw new Error(`受监管 MR ${key} 不存在`)
      }
      const next = updater(current)
      await this.deps.table.put(key, next)
      if (next.sessionId !== undefined) this.sessionToKey.set(next.sessionId, key)
      this.deps.onChange?.()
      return next
    })
  }

  /** Register a self-authored (`self-fix` or `self-skill`) MR into supervision immediately. */
  async registerSelfMr(input: RegisterSelfMrInput): Promise<SupervisedMrRecord> {
    const key = supervisedMrKey(input.repo, input.mrNumber)
    return this.withKeyLock(key, async () => {
      const existing = this.deps.table.get(key)
      const currentNow = this.now()
      const ownPushedShas = appendBoundedUnique(existing?.ownPushedShas, [input.headSha], MAX_OWN_PUSHED_SHAS)
      const record: SupervisedMrRecord = {
        repo: input.repo,
        mrNumber: input.mrNumber,
        origin: input.origin,
        ...(input.title ?? existing?.title ? { title: input.title ?? existing?.title } : {}),
        ...(input.url ?? existing?.url ? { url: input.url ?? existing?.url } : {}),
        ...(input.sourceBranch ?? existing?.sourceBranch ? { sourceBranch: input.sourceBranch ?? existing?.sourceBranch } : {}),
        ...(input.targetBranch ?? existing?.targetBranch ? { targetBranch: input.targetBranch ?? existing?.targetBranch } : {}),
        ...(input.author ?? existing?.author ? { author: input.author ?? existing?.author } : {}),
        headSha: input.headSha,
        ...(input.issueId ?? existing?.issueId ? { issueId: input.issueId ?? existing?.issueId } : {}),
        ...(input.sessionId ?? existing?.sessionId ? { sessionId: input.sessionId ?? existing?.sessionId } : {}),
        ...(input.workDir ?? existing?.workDir ? { workDir: input.workDir ?? existing?.workDir } : {}),
        ...(input.feishuLaunchKey ?? existing?.feishuLaunchKey ? { feishuLaunchKey: input.feishuLaunchKey ?? existing?.feishuLaunchKey } : {}),
        state: 'open',
        ...(existing?.lastReviewedSha === undefined ? {} : { lastReviewedSha: existing.lastReviewedSha }),
        ...(existing?.reviewedHeadSha === undefined ? {} : { reviewedHeadSha: existing.reviewedHeadSha }),
        ...(existing?.lastNoteCursor === undefined ? {} : { lastNoteCursor: existing.lastNoteCursor }),
        ...(existing?.notifiedConflictSha === undefined ? {} : { notifiedConflictSha: existing.notifiedConflictSha }),
        ...(existing?.seenNoteIds === undefined ? {} : { seenNoteIds: existing.seenNoteIds }),
        ...(existing?.deliveredNoteIds === undefined ? {} : { deliveredNoteIds: existing.deliveredNoteIds }),
        ownPushedShas,
        autoFixAttempts: existing?.autoFixAttempts ?? 0,
        pendingSignals: existing?.pendingSignals ?? [],
        ...(existing?.dueAt === undefined ? {} : { dueAt: existing.dueAt }),
        updatedAt: currentNow,
      }
      await this.deps.table.put(key, record)
      if (record.sessionId !== undefined) this.sessionToKey.set(record.sessionId, key)
      this.deps.onChange?.()
      return record
    })
  }

  /** Run one poll cycle across all enabled `mr-review` repositories immediately. */
  async pollNow(signal?: AbortSignal): Promise<void> {
    if (this.closed) return
    if (this.pollInFlight !== undefined) {
      await this.pollInFlight
      return
    }
    const run = this.doPoll(signal).finally(() => {
      if (this.pollInFlight === run) this.pollInFlight = undefined
    })
    this.pollInFlight = run
    await run
  }

  /** Flush all currently debounced MR signals immediately (primarily for deterministic tests). */
  async flushDebouncedDue(): Promise<void> {
    await this.debouncer.flushDue(this.now())
    if (this.activeFlushPromises.size > 0) {
      await Promise.allSettled([...this.activeFlushPromises])
    }
  }

  /** Wait until all currently running/queued MR turn flushes settle. */
  async waitForIdle(): Promise<void> {
    while (this.activeFlushPromises.size > 0 || this.runningKeys.size > 0) {
      await Promise.allSettled([...this.activeFlushPromises])
    }
  }

  /** Manually reset a circuit breaker and resume any blocked open MRs with pending signals. */
  async resetBreaker(scope: BreakerStatusWire['scope'], key: string): Promise<boolean> {
    const storageKey = breakerStorageKey(scope, key)
    const removed = await this.deps.breakers.reset(storageKey)
    if (scope === 'mr-fix') {
      const existing = this.deps.table.get(key)
      if (existing !== undefined) {
        await this.updateRecord(existing.repo, existing.mrNumber, cur => ({
          ...cur,
          autoFixAttempts: 0,
          updatedAt: this.now(),
        }))
      }
    }
    if (scope === 'mr' || scope === 'mr-repo' || scope === 'mr-fix') {
      const currentNow = this.now()
      for (const [mrKey, rec] of this.deps.table.entries()) {
        if (rec.state !== 'open' || rec.pendingSignals.length === 0) continue
        const matches = (scope === 'mr' && mrKey === key)
          || (scope === 'mr-fix' && mrKey === key)
          || (scope === 'mr-repo' && rec.repo === key)
        if (matches && !this.isTurnBreakerTripped(mrKey, rec.repo) && this.isRecordRepoEligible(rec)) {
          const updated = await this.updateRecord(rec.repo, rec.mrNumber, cur => ({
            ...cur,
            dueAt: currentNow,
            updatedAt: currentNow,
          }))
          if (!this.closed && this.deps.getSettings().enabled && this.isRecordRepoEligible(updated)) {
            for (const sig of updated.pendingSignals) {
              this.debouncer.push(mrKey, sig, { windowMs: 0 })
            }
          }
        }
      }
    }
    this.deps.onChange?.()
    return removed
  }

  /** Web panel snapshot of supervised MRs and circuit breakers. */
  panelState(): MrSupervisionWire {
    const settings = this.deps.getSettings()
    const mrs: SupervisedMrWire[] = this.deps.table.values()
      .map((rec): SupervisedMrWire => ({
        repo: rec.repo,
        mrNumber: rec.mrNumber,
        ...(rec.title === undefined ? {} : { title: rec.title }),
        ...(rec.url === undefined ? {} : { url: rec.url }),
        origin: rec.origin,
        state: rec.state,
        ...(rec.sourceBranch === undefined ? {} : { sourceBranch: rec.sourceBranch }),
        ...(rec.targetBranch === undefined ? {} : { targetBranch: rec.targetBranch }),
        ...(rec.author === undefined ? {} : { author: rec.author }),
        ...(rec.headSha === undefined ? {} : { headSha: rec.headSha }),
        ...(rec.lastReviewedSha === undefined ? {} : { lastReviewedSha: rec.lastReviewedSha }),
        autoFixAttempts: rec.autoFixAttempts,
        pendingCount: rec.pendingSignals.length,
        pendingKinds: [...new Set(rec.pendingSignals.map(s => s.kind))],
        ...(rec.dueAt === undefined ? {} : { dueAt: rec.dueAt }),
        ...(rec.sessionId === undefined ? {} : { sessionId: rec.sessionId }),
        ...(rec.closedAt === undefined ? {} : { closedAt: rec.closedAt }),
        ...(rec.updatedAt === undefined ? {} : { updatedAt: rec.updatedAt }),
      }))
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))

    const breakers: BreakerStatusWire[] = []
    for (const [storageKey, rec] of this.breakersStatusEntries()) {
      breakers.push(this.toWireBreaker(storageKey, rec.triggeredCount, rec.tripped, rec.limit, rec.reason, rec.trippedAt))
    }

    return {
      enabled: settings.enabled,
      running: this.runningKeys.size,
      debouncing: this.debouncer.size,
      ...(this.lastPollAt === undefined ? {} : { lastPollAt: this.lastPollAt }),
      ...(this.lastError === undefined ? {} : { lastError: this.lastError }),
      mrs,
      breakers,
    }
  }

  /** Stop timers, cancel pending debounced notifications, dispose active waits, and drain pool. */
  async drainAndClose(): Promise<void> {
    this.closed = true
    if (this.pollTimer !== undefined) {
      clearTimeout(this.pollTimer)
      this.pollTimer = undefined
    }
    await this.debouncer.drainAndClose({ flushPending: false })
    this.deps.sessionDriver.dispose?.()
    await Promise.allSettled([
      this.pollInFlight,
      ...this.activeFlushPromises,
    ])
  }

  private deps_breakersInspectAll(): Array<{ storageKey: string; triggeredCount: number; tripped: boolean; limit: number; reason?: string; trippedAt?: number }> {
    const out: Array<{ storageKey: string; triggeredCount: number; tripped: boolean; limit: number; reason?: string; trippedAt?: number }> = []
    // CircuitBreakerRegistry exposes inspect(key) and listTripped(). Track keys from listTripped plus known repos/MRs.
    const seenKeys = new Set<string>()
    for (const status of this.deps.breakers.listTripped()) {
      seenKeys.add(status.key)
      out.push({
        storageKey: status.key,
        triggeredCount: status.triggeredCount,
        tripped: status.tripped,
        limit: status.limit,
        ...(status.reason === undefined ? {} : { reason: status.reason }),
        ...(status.trippedUntil === undefined ? {} : { trippedAt: status.windowStartAt }),
      })
    }
    for (const [mrKey] of this.deps.table.entries()) {
      for (const candidate of [`mr:${mrKey}`, `mr-fix:${mrKey}`]) {
        if (seenKeys.has(candidate)) continue
        const st = this.deps.breakers.inspect(candidate)
        if (st.triggeredCount > 0 || st.tripped) {
          seenKeys.add(candidate)
          out.push({
            storageKey: candidate,
            triggeredCount: st.triggeredCount,
            tripped: st.tripped,
            limit: st.limit,
            ...(st.reason === undefined ? {} : { reason: st.reason }),
          })
        }
      }
    }
    for (const repo of this.deps.getMrRepos()) {
      const candidate = `mr-repo:${repo.url}`
      if (seenKeys.has(candidate)) continue
      const st = this.deps.breakers.inspect(candidate)
      if (st.triggeredCount > 0 || st.tripped) {
        seenKeys.add(candidate)
        out.push({
          storageKey: candidate,
          triggeredCount: st.triggeredCount,
          tripped: st.tripped,
          limit: st.limit,
          ...(st.reason === undefined ? {} : { reason: st.reason }),
        })
      }
    }
    return out
  }

  private breakersStatusEntries() {
    return this.deps_breakersInspectAll().map(item => [item.storageKey, item] as const)
  }

  private toWireBreaker(
    storageKey: string,
    count: number,
    tripped: boolean,
    limit: number,
    reason?: string,
    trippedAt?: number,
  ): BreakerStatusWire {
    const parsed = parseBreakerStorageKey(storageKey) ?? { scope: 'mr' as const, key: storageKey }
    return {
      scope: parsed.scope,
      key: parsed.key,
      count,
      limit,
      tripped,
      ...(reason === undefined ? {} : { reason }),
      ...(trippedAt === undefined ? {} : { trippedAt }),
    }
  }

  private scheduleNextPoll(delayMs: number): void {
    if (this.closed || !this.autoPollTimer) return
    if (this.pollTimer !== undefined) {
      clearTimeout(this.pollTimer)
      this.pollTimer = undefined
    }
    const timer = setTimeout(() => {
      this.pollTimer = undefined
      if (this.closed) return
      void this.pollNow().finally(() => {
        if (!this.closed) {
          this.scheduleNextPoll(this.deps.getSettings().pollIntervalMs)
        }
      })
    }, Math.max(0, delayMs))
    timer.unref?.()
    this.pollTimer = timer
  }

  private computeFilterSignature(settings: Pick<MrReviewSettings, 'skipDraft' | 'ignoreLabels'>): string {
    const normalizedLabels = [...new Set(settings.ignoreLabels.map(l => l.trim().toLowerCase()).filter(Boolean))].sort()
    const reposPart = this.deps.getMrRepos()
      .map(r => `${r.url}=>${r.targetBranch ?? '*'}`)
      .sort()
    return JSON.stringify({ skipDraft: settings.skipDraft, ignoreLabels: normalizedLabels, repos: reposPart })
  }

  private findEligibleMrRepo(repoUrl: string): MrRepoStatusWire | undefined {
    return this.deps.getMrRepos().find(repo => repo.url === repoUrl)
  }

  private isRecordRepoEligible(record: Pick<SupervisedMrRecord, 'repo' | 'targetBranch' | 'isDraft'>): boolean {
    const mrRepo = this.findEligibleMrRepo(record.repo)
    if (mrRepo === undefined) return false
    if (mrRepo.targetBranch !== undefined && record.targetBranch !== undefined && record.targetBranch !== mrRepo.targetBranch) {
      return false
    }
    if (this.deps.getSettings().skipDraft && record.isDraft === true) {
      return false
    }
    return true
  }

  private applySkippedFilterToRecord(
    cur: SupervisedMrRecord,
    mr: MrInfo,
    reason: MrIgnoreReason,
    nowMs: number,
  ): SupervisedMrRecord {
    const clearPendingConflict = cur.pendingSignals.some(s => s.kind === 'conflict')
    const nextNotifiedConflictSha = clearPendingConflict ? undefined : cur.notifiedConflictSha
    if (reason === 'draft') {
      return {
        ...cur,
        title: mr.title || cur.title,
        url: mr.webUrl || cur.url,
        sourceBranch: mr.sourceBranch || cur.sourceBranch,
        targetBranch: mr.targetBranch || cur.targetBranch,
        author: mr.author.username || cur.author,
        headSha: mr.headSha,
        isDraft: true,
        state: 'draft_skipped',
        notifiedConflictSha: nextNotifiedConflictSha,
        pendingSignals: [],
        deliveredNoteIds: undefined,
        dueAt: undefined,
        updatedAt: nowMs,
      }
    }
    if (reason === 'ignored-label') {
      return {
        ...cur,
        title: mr.title || cur.title,
        url: mr.webUrl || cur.url,
        sourceBranch: mr.sourceBranch || cur.sourceBranch,
        targetBranch: mr.targetBranch || cur.targetBranch,
        author: mr.author.username || cur.author,
        headSha: cur.lastReviewedSha,
        isDraft: mr.draft,
        notifiedConflictSha: nextNotifiedConflictSha,
        pendingSignals: [],
        deliveredNoteIds: undefined,
        dueAt: undefined,
        updatedAt: nowMs,
      }
    }
    return {
      ...cur,
      targetBranch: mr.targetBranch || cur.targetBranch,
      isDraft: mr.draft,
      dueAt: undefined,
      updatedAt: nowMs,
    }
  }

  private pruneRemovedRepoWatermarks(): void {
    const activeUrls = new Set(this.deps.getMrRepos().map(repo => repo.url))
    for (const url of [...this.repoCursors.keys()]) {
      if (!activeUrls.has(url)) this.repoCursors.delete(url)
    }
    for (const url of [...this.repoBackfill.keys()]) {
      if (!activeUrls.has(url)) this.repoBackfill.delete(url)
    }
  }

  private isTurnBreakerTripped(mrKey: string, repo: string): boolean {
    return (
      this.deps.breakers.inspect(`mr:${mrKey}`).tripped
      || this.deps.breakers.inspect(`mr-repo:${repo}`).tripped
    )
  }

  private async suspendPendingDeadlines(): Promise<void> {
    if (this.closed || this.deps.getSettings().enabled) return
    const currentNow = this.now()
    for (const [mrKey, rec] of this.deps.table.entries()) {
      if (this.closed || this.deps.getSettings().enabled) break
      if (rec.state !== 'open' || rec.dueAt === undefined || this.runningKeys.has(mrKey)) continue
      await this.updateRecord(rec.repo, rec.mrNumber, (cur) => {
        if (this.deps.getSettings().enabled || this.runningKeys.has(mrKey) || cur.state !== 'open' || cur.dueAt === undefined) {
          return cur
        }
        return { ...cur, dueAt: undefined, updatedAt: currentNow }
      }).catch(() => undefined)
    }
  }

  private async suspendIneligibleDeadlines(): Promise<void> {
    if (this.closed) return
    const currentNow = this.now()
    for (const [mrKey, rec] of this.deps.table.entries()) {
      if (this.closed) break
      if (rec.state !== 'open' || rec.dueAt === undefined || this.runningKeys.has(mrKey)) continue
      if (this.isRecordRepoEligible(rec)) continue
      this.debouncer.cancel(mrKey)
      await this.updateRecord(rec.repo, rec.mrNumber, (cur) => {
        if (this.runningKeys.has(mrKey) || cur.state !== 'open' || cur.dueAt === undefined || this.isRecordRepoEligible(cur)) {
          return cur
        }
        return { ...cur, dueAt: undefined, updatedAt: currentNow }
      }).catch(() => undefined)
    }
  }

  private async reconcilePendingEligibility(): Promise<void> {
    await this.suspendIneligibleDeadlines()
    await this.resumeDormantPending()
  }

  private async resumeDormantPending(): Promise<void> {
    if (this.closed) return
    const settings = this.deps.getSettings()
    if (!settings.enabled) return
    if (this.deps.repos.lookupV8().availability !== 'ready') return
    const currentNow = this.now()

    for (const [mrKey, rec] of this.deps.table.entries()) {
      if (this.closed) break
      if (rec.state !== 'open' || rec.pendingSignals.length === 0) continue
      if (!this.isRecordRepoEligible(rec)) continue
      if (this.runningKeys.has(mrKey) || this.debouncer.peek(mrKey) !== undefined) continue
      if (this.isTurnBreakerTripped(mrKey, rec.repo)) continue
      if (rec.pendingSignals.every(s => s.kind === 'ci-failed') && this.deps.breakers.inspect(`mr-fix:${mrKey}`).tripped) {
        continue
      }

      let resumedRecord: SupervisedMrRecord | undefined
      await this.updateRecord(rec.repo, rec.mrNumber, (cur) => {
        if (!this.deps.getSettings().enabled || !this.isRecordRepoEligible(cur) || cur.state !== 'open' || cur.pendingSignals.length === 0) {
          return cur
        }
        const effectiveDue = cur.dueAt !== undefined && cur.dueAt > currentNow ? cur.dueAt : currentNow
        resumedRecord = { ...cur, dueAt: effectiveDue, updatedAt: currentNow }
        return resumedRecord
      })
      if (
        resumedRecord !== undefined
        && !this.closed
        && !this.runningKeys.has(mrKey)
        && this.isRecordRepoEligible(resumedRecord)
        && this.debouncer.peek(mrKey) === undefined
      ) {
        const windowMs = Math.max(0, (resumedRecord.dueAt ?? currentNow) - currentNow)
        for (const sig of resumedRecord.pendingSignals) {
          this.debouncer.push(mrKey, sig, { windowMs })
        }
      }
    }
  }

  private async doPoll(signal?: AbortSignal): Promise<void> {
    const settings = this.deps.getSettings()
    this.deps.mrPool.setConcurrency(settings.maxConcurrentSessions)
    this.pruneRemovedRepoWatermarks()
    if (!settings.enabled) return
    const lookup = this.deps.repos.lookupV8()
    if (lookup.availability !== 'ready') return
    await this.suspendIneligibleDeadlines()
    await this.resumeDormantPending()
    const mrRepos = this.deps.getMrRepos()
    if (mrRepos.length === 0) return

    this.lastPollAt = this.now()
    const repoErrors: string[] = []
    for (const mrRepo of mrRepos) {
      if (this.closed || signal?.aborted === true) break
      try {
        await this.pollSingleRepo(lookup.service, mrRepo, settings, signal)
      } catch (error) {
        const msg = `仓库 ${mrRepo.url} 轮询失败：${messageOf(error)}`
        repoErrors.push(msg)
        this.deps.logger?.warn?.('logalyze: %s', msg)
      }
    }
    await this.sweepRetention().catch((error: unknown) => {
      this.deps.logger?.warn?.('logalyze: MR 留存清理失败：%s', messageOf(error))
    })
    this.lastError = repoErrors.length === 0 ? undefined : repoErrors.join('；')
    this.deps.onChange?.()
  }

  private async pollSingleRepo(
    repos: DshReposV8,
    mrRepo: MrRepoStatusWire,
    settings: MrReviewSettings,
    signal?: AbortSignal,
  ): Promise<void> {
    // Self-trigger iron law: skip evaluating discussions if bot identity cannot be resolved.
    const bot = await repos.currentBotUser({ repo: mrRepo.url, signal })
    const cursor = this.repoCursors.get(mrRepo.url)
    const savedBackfill = this.repoBackfill.get(mrRepo.url)
    const inProgress = savedBackfill !== undefined && savedBackfill.targetBranch === mrRepo.targetBranch
      ? savedBackfill
      : undefined
    if (savedBackfill !== undefined && inProgress === undefined) {
      this.repoBackfill.delete(mrRepo.url)
    }

    const startPage = inProgress?.nextPage ?? 1
    const queryState = inProgress?.state ?? (cursor === undefined ? 'open' : 'all')
    const queryUpdatedAfter = inProgress !== undefined
      ? inProgress.updatedAfter
      : (cursor === undefined ? undefined : new Date(Math.max(0, cursor - 2000)).toISOString())

    const listed = await listRepoMrs(repos, {
      repo: mrRepo.url,
      state: queryState,
      ...(mrRepo.targetBranch === undefined ? {} : { targetBranch: mrRepo.targetBranch }),
      ...(queryUpdatedAfter === undefined ? {} : { updatedAfter: queryUpdatedAfter }),
      startPage,
      maxPages: this.maxListPagesPerPoll,
    }, signal)

    let watermarkMs: number | undefined = inProgress?.watermarkMs ?? cursor
    if (inProgress === undefined || inProgress.watermarkMs === undefined) {
      for (const item of listed.items) {
        const parsedMs = Date.parse(item.updatedAt)
        if (!Number.isNaN(parsedMs) && (watermarkMs === undefined || parsedMs > watermarkMs)) {
          watermarkMs = parsedMs
        }
      }
    }

    const byNumber = new Map<number, MrInfo>(listed.items.map(item => [item.number, item]))

    // Ensure tracked open MRs missing from incremental window (e.g. merged offline or CI check change) are still checked.
    if (startPage === 1) {
      for (const record of this.deps.table.values()) {
        if (record.repo !== mrRepo.url) continue
        if (record.state !== 'open' && record.state !== 'draft_skipped') continue
        if (byNumber.has(record.mrNumber)) continue
        const isSelf = record.origin === 'self-fix' || record.origin === 'self-skill'
        if (cursor === undefined || isSelf) {
          const detail = await repos.mrGet({ repo: mrRepo.url, number: record.mrNumber, signal })
          byNumber.set(record.mrNumber, detail)
        }
      }
    }

    let completedAll = true
    for (const mr of byNumber.values()) {
      if (this.closed || signal?.aborted === true) {
        completedAll = false
        break
      }
      await this.processPolledMr(repos, mrRepo, mr, bot, settings, signal)
    }

    if (completedAll) {
      if (listed.nextPage !== undefined) {
        this.repoBackfill.set(mrRepo.url, {
          nextPage: listed.nextPage,
          state: queryState,
          targetBranch: mrRepo.targetBranch,
          updatedAfter: queryUpdatedAfter,
          watermarkMs,
        })
      } else {
        this.repoBackfill.delete(mrRepo.url)
        if (watermarkMs !== undefined) {
          this.repoCursors.set(mrRepo.url, watermarkMs)
        }
      }
    }
  }

  private async processPolledMr(
    repos: DshReposV8,
    mrRepo: MrRepoStatusWire,
    mr: MrInfo,
    bot: RepoUser,
    settings: MrReviewSettings,
    signal?: AbortSignal,
  ): Promise<void> {
    const key = supervisedMrKey(mrRepo.url, mr.number)
    const currentNow = this.now()

    if (mr.state === 'merged' || mr.state === 'closed') {
      const existing = this.deps.table.get(key)
      if (existing === undefined) return
      await this.handleTerminalMr(existing, mr, currentNow)
      return
    }

    const filter = evaluateMrFilter(mr, mrRepo, settings)
    const existingPre = this.deps.table.get(key)
    if (filter.skip) {
      this.debouncer.cancel(key)
      if (filter.reason === 'draft' && existingPre === undefined) {
        await this.withKeyLock(key, async () => {
          const rec: SupervisedMrRecord = {
            repo: mrRepo.url,
            mrNumber: mr.number,
            origin: 'external',
            title: mr.title || undefined,
            url: mr.webUrl || undefined,
            sourceBranch: mr.sourceBranch || undefined,
            targetBranch: mr.targetBranch || undefined,
            author: mr.author.username || undefined,
            headSha: mr.headSha,
            isDraft: true,
            state: 'draft_skipped',
            ownPushedShas: [],
            autoFixAttempts: 0,
            pendingSignals: [],
            updatedAt: currentNow,
          }
          await this.deps.table.put(key, rec)
        })
        return
      }
      if (existingPre !== undefined) {
        await this.updateRecord(mrRepo.url, mr.number, cur =>
          this.applySkippedFilterToRecord(cur, mr, filter.reason, currentNow),
        )
      }
      return
    }

    const [detail, discussions, status] = await Promise.all([
      repos.mrGet({ repo: mrRepo.url, number: mr.number, signal }),
      listAllDiscussions(repos, mrRepo.url, mr.number, signal),
      repos.mrStatus({ repo: mrRepo.url, number: mr.number, signal }),
    ])

    let signalsToEnqueue: readonly MrPendingSignal[] = []
    await this.withKeyLock(key, async () => {
      const existing = this.deps.table.get(key)
      const classification = classifyMrPollUpdate({
        existing,
        mr: detail,
        detail,
        discussions,
        status,
        bot,
        repo: mrRepo,
        settings,
        nowMs: currentNow,
      })
      if (classification.action === 'skip') return

      if (classification.nextState === 'merged' || classification.nextState === 'closed') {
        this.debouncer.cancel(key)
        if (existing !== undefined) await this.applyTerminalMrUnlocked(key, detail, currentNow)
        return
      }

      if (classification.clearPending === true) {
        const detailFilter = evaluateMrFilter(detail, mrRepo, settings)
        this.debouncer.cancel(key)
        if (existing !== undefined && detailFilter.skip) {
          await this.deps.table.put(
            key,
            this.applySkippedFilterToRecord(existing, detail, detailFilter.reason, currentNow),
          )
          return
        }
        if (classification.nextState === 'draft_skipped') {
          const base: SupervisedMrRecord = existing ?? {
            repo: mrRepo.url,
            mrNumber: mr.number,
            origin: 'external',
            state: 'draft_skipped',
            ownPushedShas: [],
            autoFixAttempts: 0,
            pendingSignals: [],
          }
          await this.deps.table.put(key, {
            ...base,
            title: detail.title || base.title,
            url: detail.webUrl || base.url,
            sourceBranch: detail.sourceBranch || base.sourceBranch,
            targetBranch: detail.targetBranch || base.targetBranch,
            author: detail.author.username || base.author,
            headSha: detail.headSha,
            isDraft: true,
            state: 'draft_skipped',
            pendingSignals: [],
            dueAt: undefined,
            updatedAt: currentNow,
          })
        }
        return
      }

      const prevPending = existing?.pendingSignals ?? []
      const nextPending = mergePendingSignals(prevPending, classification.signals)
      const canScheduleNow = !this.closed && settings.enabled && !this.isTurnBreakerTripped(key, mrRepo.url)
      let dueAt = canScheduleNow ? existing?.dueAt : undefined

      if (!canScheduleNow) {
        this.debouncer.cancel(key)
      } else if (classification.signals.length > 0) {
        const firstAt = this.debouncer.peek(key)?.firstAt ?? currentNow
        dueAt = Math.min(currentNow + Math.max(0, settings.debounceMs), firstAt + DEBOUNCE_MAX_WAIT_MS)
        signalsToEnqueue = classification.signals
      }

      const nextNoteCursor = existing !== undefined && existing.state !== 'draft_skipped'
        ? advanceHumanNoteWatermark({
            detail,
            discussions,
            bot,
            previousSeenNoteIds: existing.seenNoteIds,
            nextSeenNoteIds: existing.seenNoteIds,
            pendingSignals: nextPending,
            deliveredNoteIds: existing.deliveredNoteIds,
            previousCursor: existing.lastNoteCursor,
          })
        : existing?.lastNoteCursor

      const nextRecord: SupervisedMrRecord = {
        repo: mrRepo.url,
        mrNumber: mr.number,
        origin: existing?.origin ?? 'external',
        ...(detail.title ? { title: detail.title } : existing?.title === undefined ? {} : { title: existing.title }),
        ...(detail.webUrl ? { url: detail.webUrl } : existing?.url === undefined ? {} : { url: existing.url }),
        ...(detail.sourceBranch ? { sourceBranch: detail.sourceBranch } : existing?.sourceBranch === undefined ? {} : { sourceBranch: existing.sourceBranch }),
        ...(detail.targetBranch ? { targetBranch: detail.targetBranch } : existing?.targetBranch === undefined ? {} : { targetBranch: existing.targetBranch }),
        ...(detail.author.username ? { author: detail.author.username } : existing?.author === undefined ? {} : { author: existing.author }),
        headSha: detail.headSha,
        isDraft: detail.draft,
        ...(existing?.issueId === undefined ? {} : { issueId: existing.issueId }),
        ...(existing?.sessionId === undefined ? {} : { sessionId: existing.sessionId }),
        ...(existing?.workDir === undefined ? {} : { workDir: existing.workDir }),
        ...(existing?.feishuLaunchKey === undefined ? {} : { feishuLaunchKey: existing.feishuLaunchKey }),
        state: 'open',
        ...(existing?.lastReviewedSha === undefined ? {} : { lastReviewedSha: existing.lastReviewedSha }),
        ...(existing?.reviewedHeadSha === undefined ? {} : { reviewedHeadSha: existing.reviewedHeadSha }),
        ...(nextNoteCursor === undefined ? {} : { lastNoteCursor: nextNoteCursor }),
        ...(classification.notifiedConflictSha !== undefined
          ? { notifiedConflictSha: classification.notifiedConflictSha }
          : existing?.notifiedConflictSha === undefined ? {} : { notifiedConflictSha: existing.notifiedConflictSha }),
        ...(existing?.seenNoteIds === undefined ? {} : { seenNoteIds: existing.seenNoteIds }),
        ...(existing?.deliveredNoteIds === undefined ? {} : { deliveredNoteIds: existing.deliveredNoteIds }),
        ownPushedShas: existing?.ownPushedShas ?? [],
        autoFixAttempts: existing?.autoFixAttempts ?? 0,
        pendingSignals: nextPending,
        ...(dueAt === undefined ? {} : { dueAt }),
        updatedAt: currentNow,
      }
      await this.deps.table.put(key, nextRecord)
    })

    for (const sig of signalsToEnqueue) {
      this.debouncer.push(key, sig, { windowMs: settings.debounceMs })
    }
  }

  private async handleTerminalMr(existing: SupervisedMrRecord, mr: MrInfo, currentNow: number): Promise<void> {
    const key = supervisedMrKey(existing.repo, existing.mrNumber)
    this.debouncer.cancel(key)
    await this.withKeyLock(key, () => this.applyTerminalMrUnlocked(key, mr, currentNow))
  }

  private async applyTerminalMrUnlocked(key: string, mr: MrInfo, currentNow: number): Promise<void> {
    const latest = this.deps.table.get(key)
    if (latest === undefined) return
    const terminalState = mr.state === 'merged' ? 'merged' : 'closed'
    await this.deps.table.put(key, {
      ...latest,
      state: terminalState,
      headSha: mr.headSha || latest.headSha,
      url: mr.webUrl || latest.url,
      title: mr.title || latest.title,
      pendingSignals: [],
      deliveredNoteIds: undefined,
      dueAt: undefined,
      closedAt: latest.closedAt ?? currentNow,
      updatedAt: currentNow,
    })

    if (
      terminalState === 'merged'
      && (latest.origin === 'self-fix' || latest.origin === 'self-skill')
      && latest.issueId !== undefined
      && this.deps.issues !== undefined
    ) {
      const issue = this.deps.issues.get(latest.issueId)
      if (issue !== undefined) {
        await this.deps.issues.upsertByAi({
          issueId: latest.issueId,
          appId: issue.appId,
          title: issue.title,
          matchCriteria: issue.matchCriteria,
          ...(issue.exclusionCriteria === undefined ? {} : { exclusionCriteria: issue.exclusionCriteria }),
          aiDiagnosis: issue.aiDiagnosis,
          aiStatus: 'fixed',
          resolutionAdvice: issue.resolutionAdvice,
          fixMrUrl: mr.webUrl,
          seenAt: currentNow,
        })
      }
    }
  }

  private async handleDebouncedFlush(key: string): Promise<void> {
    if (this.closed) return
    if (this.runningKeys.has(key)) {
      this.rerunNeeded.add(key)
      return
    }
    this.runningKeys.add(key)
    this.deps.onChange?.()
    let outcome: TurnOutcome = 'noop'
    try {
      outcome = await this.deps.mrPool.run(poolSignal => this.executeMrTurn(key, poolSignal))
    } finally {
      this.runningKeys.delete(key)
      const latest = this.deps.table.get(key)
      const rerunRequested = this.rerunNeeded.delete(key)
      this.deps.onChange?.()
      const currentNow = this.now()
      const shouldFollowUp = outcome === 'ran'
        && !this.closed
        && this.deps.getSettings().enabled
        && latest?.state === 'open'
        && this.isRecordRepoEligible(latest)
        && latest.pendingSignals.length > 0
        && latest.dueAt !== undefined
        && (latest.dueAt <= currentNow || (rerunRequested && this.debouncer.peek(key) === undefined))
      if (shouldFollowUp) {
        const follow = this.handleDebouncedFlush(key).catch((error: unknown) => {
          this.lastError = `MR 会话唤醒失败 (${key})：${messageOf(error)}`
          this.deps.logger?.error?.('logalyze: %s', this.lastError)
        })
        this.trackFlushPromise(follow)
      }
    }
  }

  private trackFlushPromise(promise: Promise<void>): void {
    this.activeFlushPromises.add(promise)
    void promise.then(
      () => { this.activeFlushPromises.delete(promise) },
      () => { this.activeFlushPromises.delete(promise) },
    )
  }

  private async executeMrTurn(key: string, signal: AbortSignal): Promise<TurnOutcome> {
    const initial = this.deps.table.get(key)
    if (initial === undefined || initial.state !== 'open' || initial.pendingSignals.length === 0) return 'noop'

    const repos = this.deps.repos.lookupV8()
    const settings = this.deps.getSettings()
    if (
      !settings.enabled
      || repos.availability !== 'ready'
      || !this.isRecordRepoEligible(initial)
      || this.isTurnBreakerTripped(key, initial.repo)
    ) {
      this.debouncer.cancel(key)
      if (initial.dueAt !== undefined) {
        await this.updateRecord(initial.repo, initial.mrNumber, cur => ({
          ...cur,
          dueAt: undefined,
          updatedAt: this.now(),
        }))
      }
      return 'blocked'
    }

    const [mr, status] = await Promise.all([
      repos.service.mrGet({ repo: initial.repo, number: initial.mrNumber, signal }),
      repos.service.mrStatus({ repo: initial.repo, number: initial.mrNumber, signal }),
    ])
    if (mr.state === 'merged' || mr.state === 'closed') {
      await this.handleTerminalMr(initial, mr, this.now())
      return 'noop'
    }
    const latestSettings = this.deps.getSettings()
    const latestEligibleRepo = this.findEligibleMrRepo(initial.repo)
    if (!latestSettings.enabled || latestEligibleRepo === undefined) {
      this.debouncer.cancel(key)
      await this.updateRecord(initial.repo, initial.mrNumber, cur => ({
        ...cur,
        targetBranch: mr.targetBranch,
        isDraft: mr.draft,
        dueAt: undefined,
        updatedAt: this.now(),
      }))
      return 'blocked'
    }
    const filter = evaluateMrFilter(mr, latestEligibleRepo, latestSettings)
    if (filter.skip) {
      this.debouncer.cancel(key)
      await this.updateRecord(initial.repo, initial.mrNumber, cur =>
        this.applySkippedFilterToRecord(cur, mr, filter.reason, this.now()),
      )
      return 'blocked'
    }

    const capturedBatch = [...initial.pendingSignals]
    let signalsToRun = [...capturedBatch]
    const isSelf = initial.origin === 'self-fix' || initial.origin === 'self-skill'
    const hasCiFailed = signalsToRun.some(s => s.kind === 'ci-failed')

    if (isSelf && hasCiFailed && initial.autoFixAttempts >= latestSettings.maxAutoFixAttempts) {
      const strippedCiSignals = signalsToRun.filter(s => s.kind === 'ci-failed')
      await this.deps.breakers.trip(
        `mr-fix:${key}`,
        `MR ${key} 自动修复 CI 已达上限（${initial.autoFixAttempts}/${latestSettings.maxAutoFixAttempts} 次），请人工处理`,
        DAY_MS,
      )
      await this.notifyBreakerOrHuman({
        repo: initial.repo,
        mrNumber: initial.mrNumber,
        feishuLaunchKey: initial.feishuLaunchKey,
        text: `@人工处理：MR ${initial.repo}#${initial.mrNumber} 自动修复 CI 已达到上限（${latestSettings.maxAutoFixAttempts} 次），已停止继续自修。\n链接：${mr.webUrl}`,
      })
      signalsToRun = signalsToRun.filter(s => s.kind !== 'ci-failed')
      if (signalsToRun.length === 0) {
        const afterStrip = await this.updateRecord(initial.repo, initial.mrNumber, (cur) => {
          const remaining = subtractPendingSignals(cur.pendingSignals, strippedCiSignals)
          return {
            ...cur,
            pendingSignals: remaining,
            dueAt: remaining.length > 0 ? cur.dueAt : undefined,
            updatedAt: this.now(),
          }
        })
        return afterStrip.pendingSignals.length > 0 && afterStrip.dueAt !== undefined ? 'ran' : 'blocked'
      }
    }

    const mrBreaker = await this.deps.breakers.record(`mr:${key}`, {
      windowMs: DAY_MS,
      limit: latestSettings.dailyMrTurnLimit,
      cooldownMs: DAY_MS,
      reason: `单 MR 24h 内唤醒次数超过上限（>${latestSettings.dailyMrTurnLimit} 次）`,
    })
    if (!mrBreaker.allowed) {
      this.debouncer.cancel(key)
      await this.updateRecord(initial.repo, initial.mrNumber, cur => ({ ...cur, dueAt: undefined, updatedAt: this.now() }))
      if (mrBreaker.newlyTripped) {
        await this.notifyBreakerOrHuman({
          repo: initial.repo,
          mrNumber: initial.mrNumber,
          feishuLaunchKey: initial.feishuLaunchKey,
          text: `审微熔断：${mrBreaker.status.reason ?? '单 MR 日限已触发'}（${mr.webUrl}），请在设置面板确认后解除熔断。`,
        })
      }
      return 'blocked'
    }

    const repoBreaker = await this.deps.breakers.record(`mr-repo:${initial.repo}`, {
      windowMs: HOUR_MS,
      limit: latestSettings.repoHourlyTurnLimit,
      cooldownMs: HOUR_MS,
      reason: `仓库 ${initial.repo} 1h 内 MR 唤醒次数超过上限（>${latestSettings.repoHourlyTurnLimit} 次）`,
    })
    if (!repoBreaker.allowed) {
      this.debouncer.cancel(key)
      await this.updateRecord(initial.repo, initial.mrNumber, cur => ({ ...cur, dueAt: undefined, updatedAt: this.now() }))
      if (repoBreaker.newlyTripped) {
        await this.notifyBreakerOrHuman({
          repo: initial.repo,
          mrNumber: initial.mrNumber,
          feishuLaunchKey: initial.feishuLaunchKey,
          text: `审微熔断：${repoBreaker.status.reason ?? '单仓库小时限流已触发'}，请在设置面板确认后解除熔断。`,
        })
      }
      return 'blocked'
    }

    const preTurnReviewedSha = initial.lastReviewedSha
    const preTurnOwnPushedCount = initial.ownPushedShas.length
    const deliveredNotes = signalNoteKeys(signalsToRun)
    const willAttemptCiFix = isSelf && signalsToRun.some(s => s.kind === 'ci-failed')
    const workDir = initial.workDir ?? defaultMrWorkDir(this.deps.workspacesRoot, initial.repo, initial.mrNumber)

    const preparedRecord = await this.withKeyLock(key, async () => {
      const current = this.deps.table.get(key) ?? initial
      const remainingPending = subtractPendingSignals(current.pendingSignals, capturedBatch)
      const nextDelivered = deliveredNotes.length > 0
        ? appendBoundedUnique(current.deliveredNoteIds, deliveredNotes, MAX_SEEN_NOTE_IDS)
        : current.deliveredNoteIds
      const nextDueAt = remainingPending.length > 0 ? (current.dueAt ?? this.now()) : undefined
      const nextHeadSha = remainingPending.length > 0 && current.headSha !== undefined
        ? current.headSha
        : mr.headSha
      const next: SupervisedMrRecord = {
        ...current,
        workDir,
        headSha: nextHeadSha,
        reviewedHeadSha: mr.headSha,
        ...(nextDelivered === undefined || nextDelivered.length === 0 ? {} : { deliveredNoteIds: nextDelivered }),
        pendingSignals: remainingPending,
        dueAt: nextDueAt,
        autoFixAttempts: willAttemptCiFix ? current.autoFixAttempts + 1 : current.autoFixAttempts,
        updatedAt: this.now(),
      }
      await this.deps.table.put(key, next)
      return next
    })

    try {
      const prompt = buildMrWakePrompt({
        record: preparedRecord,
        mr,
        status,
        signals: signalsToRun,
        maxAutoFixAttempts: latestSettings.maxAutoFixAttempts,
      })

      const result = await this.deps.sessionDriver.runTurn({
        repo: preparedRecord.repo,
        mrNumber: preparedRecord.mrNumber,
        origin: preparedRecord.origin,
        existingSessionId: preparedRecord.sessionId,
        workDir,
        prompt,
        signal,
        onSessionBound: async (boundSessionId) => {
          this.sessionToKey.set(boundSessionId, key)
          await this.updateRecord(preparedRecord.repo, preparedRecord.mrNumber, cur => ({
            ...cur,
            sessionId: boundSessionId,
            updatedAt: this.now(),
          }))
        },
      })
      this.sessionToKey.set(result.sessionId, key)
      if (result.error !== undefined) {
        this.lastError = `MR ${key} 会话执行异常：${result.error}`
        this.deps.logger?.warn?.('logalyze: %s', this.lastError)
        await this.rollbackFailedTurnBatch({
          repo: initial.repo,
          mrNumber: initial.mrNumber,
          signalsToRun,
          deliveredNotes,
          preTurnReviewedSha,
          preTurnOwnPushedCount,
          willAttemptCiFix,
        })
        return 'blocked'
      }
      if (deliveredNotes.length > 0) {
        await this.updateRecord(initial.repo, initial.mrNumber, (cur) => {
          if (cur.deliveredNoteIds === undefined || cur.deliveredNoteIds.length === 0) return cur
          const nextSeen = appendBoundedUnique(cur.seenNoteIds, cur.deliveredNoteIds, MAX_SEEN_NOTE_IDS)
          return {
            ...cur,
            ...(nextSeen.length === 0 ? {} : { seenNoteIds: nextSeen }),
            deliveredNoteIds: undefined,
            updatedAt: this.now(),
          }
        })
      }
      return 'ran'
    } catch (error) {
      const abortedOrClosing = signal.aborted || this.closed
      if (!abortedOrClosing) {
        this.lastError = `MR ${key} 会话唤醒失败：${messageOf(error)}`
        this.deps.logger?.error?.('logalyze: %s', this.lastError)
      }
      await this.rollbackFailedTurnBatch({
        repo: initial.repo,
        mrNumber: initial.mrNumber,
        signalsToRun,
        deliveredNotes,
        preTurnReviewedSha,
        preTurnOwnPushedCount,
        willAttemptCiFix,
        clearDueAt: abortedOrClosing,
      })
      throw error
    }
  }

  private async rollbackFailedTurnBatch(input: {
    readonly repo: string
    readonly mrNumber: number
    readonly signalsToRun: readonly MrPendingSignal[]
    readonly deliveredNotes: readonly string[]
    readonly preTurnReviewedSha: string | undefined
    readonly preTurnOwnPushedCount: number
    readonly willAttemptCiFix: boolean
    readonly clearDueAt?: boolean
  }): Promise<void> {
    await this.updateRecord(input.repo, input.mrNumber, (cur) => {
      if (cur.state !== 'open') return cur
      const shaReviewed = cur.lastReviewedSha !== input.preTurnReviewedSha
      const pushedFix = cur.ownPushedShas.length > input.preTurnOwnPushedCount
      const seenSet = new Set(cur.seenNoteIds ?? [])
      const signalsToRestore = input.signalsToRun.filter((sig) => {
        switch (sig.kind) {
          case 'opened':
          case 'ready-for-review':
          case 'push':
            return !shaReviewed
          case 'ci-failed':
            return !pushedFix && !shaReviewed
          case 'discussion': {
            if (sig.noteId === undefined) return true
            const noteKey = sig.discussionId !== undefined
              ? canonicalDiscussionNoteKey(sig.discussionId, sig.noteId)
              : canonicalCommentKey(sig.noteId)
            return !seenSet.has(noteKey)
          }
          case 'conflict':
            return !shaReviewed && !pushedFix
        }
      })
      const deliveredSet = new Set(input.deliveredNotes)
      const remainingDelivered = (cur.deliveredNoteIds ?? []).filter(k => !deliveredSet.has(k))
      const mergedPending = mergePendingSignals(signalsToRestore, cur.pendingSignals)
      const preservedDueAt = !input.clearDueAt && !this.closed && cur.pendingSignals.length > 0 && cur.dueAt !== undefined
        ? cur.dueAt
        : undefined
      return {
        ...cur,
        pendingSignals: mergedPending,
        deliveredNoteIds: remainingDelivered.length > 0 ? remainingDelivered : undefined,
        dueAt: preservedDueAt,
        autoFixAttempts: input.willAttemptCiFix && !pushedFix && !shaReviewed
          ? Math.max(0, cur.autoFixAttempts - 1)
          : cur.autoFixAttempts,
        updatedAt: this.now(),
      }
    }).catch(() => undefined)
  }

  private async notifyBreakerOrHuman(input: {
    readonly repo: string
    readonly mrNumber?: number
    readonly feishuLaunchKey?: string
    readonly text: string
  }): Promise<void> {
    if (this.deps.notifyHuman === undefined) return
    try {
      await this.deps.notifyHuman(input)
    } catch (error) {
      this.deps.logger?.warn?.('logalyze: 人工通知发送失败：%s', messageOf(error))
    }
  }

  private async sweepRetention(): Promise<void> {
    const currentNow = this.now()
    for (const [key, rec] of this.deps.table.entries()) {
      if ((rec.state !== 'merged' && rec.state !== 'closed') || rec.closedAt === undefined) continue
      const age = currentNow - rec.closedAt
      if (age >= WORKDIR_RETENTION_MS && rec.workDir !== undefined) {
        const removed = await removeExpiredMrWorkspace(this.deps.workspacesRoot, rec.workDir).catch(() => false)
        if (removed) {
          await this.withKeyLock(key, async () => {
            const latest = this.deps.table.get(key)
            if (latest !== undefined && latest.workDir === rec.workDir) {
              await this.deps.table.put(key, { ...latest, workDir: undefined })
            }
          })
        }
      }
      if (age >= RECORD_RETENTION_MS) {
        if (rec.sessionId !== undefined) this.sessionToKey.delete(rec.sessionId)
        await this.withKeyLock(key, () => this.deps.table.delete(key))
      }
    }
  }

  private withKeyLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.keyLocks.get(key) ?? Promise.resolve()
    const next = prev.then(fn, fn)
    const tracked = next.then(() => undefined, () => undefined).finally(() => {
      if (this.keyLocks.get(key) === tracked) {
        this.keyLocks.delete(key)
      }
    })
    this.keyLocks.set(key, tracked)
    return next
  }
}
