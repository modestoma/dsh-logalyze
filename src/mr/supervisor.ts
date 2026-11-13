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
  appendBoundedUnique,
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
const MAX_MR_LIST_PAGES = 10

type TurnOutcome = 'ran' | 'noop' | 'blocked'

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
  },
  signal?: AbortSignal,
): Promise<MrInfo[]> {
  const collected: MrInfo[] = []
  let page = 1
  for (let i = 0; i < MAX_MR_LIST_PAGES; i += 1) {
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
    if (res.nextPage === undefined) break
    page = res.nextPage
  }
  return collected
}

/** Stateful orchestrator supervising MR discovery, debounced wakeups, persistent sessions, and safety limits. */
export class MrSupervisor implements MrToolsRuntime {
  private readonly now: () => number
  private readonly autoPollTimer: boolean
  private readonly debouncer: KeyedDebouncer<MrPendingSignal, string>
  private readonly keyLocks = new Map<string, Promise<unknown>>()
  private readonly sessionToKey = new Map<string, string>()
  private readonly repoCursors = new Map<string, number>()
  private readonly runningKeys = new Set<string>()
  private readonly rerunNeeded = new Set<string>()
  private readonly activeFlushPromises = new Set<Promise<void>>()
  private pollTimer: ReturnType<typeof setTimeout> | undefined
  private pollInFlight: Promise<void> | undefined
  private lastPollAt: number | undefined
  private lastError: string | undefined
  private closed = false
  private started = false

  constructor(private readonly deps: MrSupervisorDeps) {
    this.now = deps.now ?? Date.now
    this.autoPollTimer = deps.autoPollTimer ?? true
    this.debouncer = new KeyedDebouncer<MrPendingSignal, string>({
      windowMs: Math.max(0, deps.getSettings().debounceMs),
      mode: 'sliding',
      maxWaitMs: DEBOUNCE_MAX_WAIT_MS,
      merge: (existing, incoming) => mergePendingSignals(existing, [incoming]),
      onFlush: (key) => {
        const promise = this.handleDebouncedFlush(key)
        this.activeFlushPromises.add(promise)
        void promise.finally(() => { this.activeFlushPromises.delete(promise) })
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
    const enabled = this.deps.getSettings().enabled
    for (const [key, record] of this.deps.table.entries()) {
      if (record.sessionId !== undefined) {
        this.sessionToKey.set(record.sessionId, key)
      }
      if (
        enabled
        && record.state === 'open'
        && record.pendingSignals.length > 0
        && record.dueAt !== undefined
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
    await this.resumeDormantPending()
    this.scheduleNextPoll(0)
  }

  /** Notify supervisor when `mr-review` repository list or settings changed. */
  notifyConfigOrReposChanged(): void {
    if (this.closed || !this.started) return
    const settings = this.deps.getSettings()
    this.deps.mrPool.setConcurrency(settings.maxConcurrentSessions)
    if (!settings.enabled) {
      this.debouncer.cancelAll()
      return
    }
    void this.resumeDormantPending().catch((error: unknown) => {
      this.deps.logger?.warn?.('logalyze: MR 恢复待办失败：%s', messageOf(error))
    })
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
        if (matches && !this.isTurnBreakerTripped(mrKey, rec.repo)) {
          const updated = await this.updateRecord(rec.repo, rec.mrNumber, cur => ({
            ...cur,
            dueAt: currentNow,
            updatedAt: currentNow,
          }))
          if (!this.closed && this.deps.getSettings().enabled) {
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

  private isTurnBreakerTripped(mrKey: string, repo: string): boolean {
    return (
      this.deps.breakers.inspect(`mr:${mrKey}`).tripped
      || this.deps.breakers.inspect(`mr-repo:${repo}`).tripped
    )
  }

  private async resumeDormantPending(): Promise<void> {
    if (this.closed) return
    const settings = this.deps.getSettings()
    if (!settings.enabled) return
    if (this.deps.repos.lookupV8().availability !== 'ready') return
    const currentNow = this.now()

    for (const [mrKey, rec] of this.deps.table.entries()) {
      if (this.closed) break
      if (rec.state !== 'open' || rec.pendingSignals.length === 0 || rec.dueAt !== undefined) continue
      if (this.runningKeys.has(mrKey) || this.debouncer.peek(mrKey) !== undefined) continue
      if (this.isTurnBreakerTripped(mrKey, rec.repo)) continue
      if (rec.pendingSignals.every(s => s.kind === 'ci-failed') && this.deps.breakers.inspect(`mr-fix:${mrKey}`).tripped) {
        continue
      }

      let resumedRecord: SupervisedMrRecord | undefined
      await this.updateRecord(rec.repo, rec.mrNumber, (cur) => {
        if (cur.state !== 'open' || cur.pendingSignals.length === 0 || cur.dueAt !== undefined) return cur
        resumedRecord = { ...cur, dueAt: currentNow, updatedAt: currentNow }
        return resumedRecord
      })
      if (resumedRecord !== undefined && !this.closed && !this.runningKeys.has(mrKey) && this.debouncer.peek(mrKey) === undefined) {
        for (const sig of resumedRecord.pendingSignals) {
          this.debouncer.push(mrKey, sig, { windowMs: 0 })
        }
      }
    }
  }

  private async doPoll(signal?: AbortSignal): Promise<void> {
    const settings = this.deps.getSettings()
    this.deps.mrPool.setConcurrency(settings.maxConcurrentSessions)
    if (!settings.enabled) return
    const lookup = this.deps.repos.lookupV8()
    if (lookup.availability !== 'ready') return
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
    const listed = await listRepoMrs(repos, {
      repo: mrRepo.url,
      state: cursor === undefined ? 'open' : 'all',
      ...(mrRepo.targetBranch === undefined ? {} : { targetBranch: mrRepo.targetBranch }),
      ...(cursor === undefined ? {} : { updatedAfter: new Date(Math.max(0, cursor - 2000)).toISOString() }),
    }, signal)

    let nextCursor = cursor
    for (const item of listed) {
      const parsedMs = Date.parse(item.updatedAt)
      if (!Number.isNaN(parsedMs) && (nextCursor === undefined || parsedMs > nextCursor)) {
        nextCursor = parsedMs
      }
    }

    const byNumber = new Map<number, MrInfo>(listed.map(item => [item.number, item]))

    // Ensure tracked open MRs missing from incremental window (e.g. merged offline or CI check change) are still checked.
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

    let completedAll = true
    for (const mr of byNumber.values()) {
      if (this.closed || signal?.aborted === true) {
        completedAll = false
        break
      }
      await this.processPolledMr(repos, mrRepo, mr, bot, settings, signal)
    }

    if (completedAll && nextCursor !== undefined) {
      this.repoCursors.set(mrRepo.url, nextCursor)
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
    if (filter.skip && filter.reason !== 'draft') return
    if (filter.skip && filter.reason === 'draft' && existingPre === undefined) {
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

      if (classification.nextState === 'draft_skipped') {
        this.debouncer.cancel(key)
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
        ...(existing?.lastNoteCursor === undefined ? {} : { lastNoteCursor: existing.lastNoteCursor }),
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
        && latest?.state === 'open'
        && latest.pendingSignals.length > 0
        && latest.dueAt !== undefined
        && (latest.dueAt <= currentNow || (rerunRequested && this.debouncer.peek(key) === undefined))
      if (shouldFollowUp) {
        const follow = this.handleDebouncedFlush(key)
        this.activeFlushPromises.add(follow)
        void follow.finally(() => { this.activeFlushPromises.delete(follow) })
      }
    }
  }

  private async executeMrTurn(key: string, signal: AbortSignal): Promise<TurnOutcome> {
    const initial = this.deps.table.get(key)
    if (initial === undefined || initial.state !== 'open' || initial.pendingSignals.length === 0) return 'noop'

    const repos = this.deps.repos.lookupV8()
    const settings = this.deps.getSettings()
    if (!settings.enabled || repos.availability !== 'ready' || this.isTurnBreakerTripped(key, initial.repo)) {
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

    const capturedBatch = [...initial.pendingSignals]
    let signalsToRun = [...capturedBatch]
    const isSelf = initial.origin === 'self-fix' || initial.origin === 'self-skill'
    const hasCiFailed = signalsToRun.some(s => s.kind === 'ci-failed')

    if (isSelf && hasCiFailed && initial.autoFixAttempts >= settings.maxAutoFixAttempts) {
      const strippedCiSignals = signalsToRun.filter(s => s.kind === 'ci-failed')
      await this.deps.breakers.trip(
        `mr-fix:${key}`,
        `MR ${key} 自动修复 CI 已达上限（${initial.autoFixAttempts}/${settings.maxAutoFixAttempts} 次），请人工处理`,
        DAY_MS,
      )
      await this.notifyBreakerOrHuman({
        repo: initial.repo,
        mrNumber: initial.mrNumber,
        feishuLaunchKey: initial.feishuLaunchKey,
        text: `@人工处理：MR ${initial.repo}#${initial.mrNumber} 自动修复 CI 已达到上限（${settings.maxAutoFixAttempts} 次），已停止继续自修。\n链接：${mr.webUrl}`,
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
      limit: settings.dailyMrTurnLimit,
      cooldownMs: DAY_MS,
      reason: `单 MR 24h 内唤醒次数超过上限（>${settings.dailyMrTurnLimit} 次）`,
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
      limit: settings.repoHourlyTurnLimit,
      cooldownMs: HOUR_MS,
      reason: `仓库 ${initial.repo} 1h 内 MR 唤醒次数超过上限（>${settings.repoHourlyTurnLimit} 次）`,
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

    const prompt = buildMrWakePrompt({
      record: preparedRecord,
      mr,
      status,
      signals: signalsToRun,
      maxAutoFixAttempts: settings.maxAutoFixAttempts,
    })

    try {
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
        await this.updateRecord(initial.repo, initial.mrNumber, (cur) => {
          if (cur.lastReviewedSha !== preTurnReviewedSha || cur.deliveredNoteIds === undefined) return cur
          return {
            ...cur,
            pendingSignals: mergePendingSignals(signalsToRun, cur.pendingSignals),
            deliveredNoteIds: undefined,
            dueAt: undefined,
            updatedAt: this.now(),
          }
        }).catch(() => undefined)
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
      if (!signal.aborted && !this.closed) {
        this.lastError = `MR ${key} 会话唤醒失败：${messageOf(error)}`
        this.deps.logger?.error?.('logalyze: %s', this.lastError)
        await this.updateRecord(initial.repo, initial.mrNumber, (cur) => {
          if (cur.lastReviewedSha !== preTurnReviewedSha || cur.deliveredNoteIds === undefined) return cur
          return {
            ...cur,
            pendingSignals: mergePendingSignals(signalsToRun, cur.pendingSignals),
            deliveredNoteIds: undefined,
            dueAt: undefined,
            updatedAt: this.now(),
          }
        }).catch(() => undefined)
      }
      throw error
    }
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
