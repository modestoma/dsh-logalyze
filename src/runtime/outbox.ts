/**
 * 持久化幂等回传队列执行器（`OutboxRunner`）：
 * - 基于 `'dsh_supervisor'` 存储域的 `outbox_platform` 表持久化投递状态；
 * - 失败按指数退避（`baseDelayMs * 2^(attempts - 1)`，封顶 `maxDelayMs`）自动重试；
 * - 超过最大尝试次数 `maxAttempts`（或抛出标记 `permanent: true` 的错误）转入 `dead` 死信状态，支持面板手动 `retryDead` / `retryAllDead`；
 * - 严格保证 `(taskId, logId)` 维度的 `revision` 单调性：同一 `(taskId, logId)` 串行投递且高版本优先，一旦存在更高 `revision` 已完成（`done`），旧 `revision` 自动跳过并丢弃，绝不倒退覆盖平台上的新报告。
 *
 * @module dsh-logalyze/runtime/outbox
 */

import { messageOf } from '../util/errors.ts'
import { outboxPlatformKey } from './domain.ts'
import type { OutboxPlatformRecord } from './domain.ts'
import { TaskPool } from './pool.ts'
import type { DomainTable } from './storage.ts'

/** Default maximum delivery attempts before moving an entry to `'dead'`. */
export const DEFAULT_OUTBOX_MAX_ATTEMPTS = 5

/** Default initial retry delay in milliseconds (doubles on each retry). */
export const DEFAULT_OUTBOX_BASE_DELAY_MS = 2_000

/** Default retry delay cap in milliseconds (5 minutes). */
export const DEFAULT_OUTBOX_MAX_DELAY_MS = 5 * 60 * 1000

/** Default concurrent deliveries across distinct `(taskId, logId)` targets. */
export const DEFAULT_OUTBOX_CONCURRENCY = 4

/** Optional metadata returned by a successful platform upload. */
export interface OutboxDeliverResult {
  readonly analysisId?: string
  readonly detailUrl?: string
}

/** Input to enqueue one platform report upload. */
export interface OutboxEnqueueInput {
  readonly taskId: string
  readonly revision: number
  readonly logId: string
}

/** Outcome of {@link OutboxRunner.enqueue}. */
export type OutboxEnqueueOutcome =
  | { readonly status: 'enqueued'; readonly key: string; readonly record: OutboxPlatformRecord }
  | { readonly status: 'existing'; readonly key: string; readonly record: OutboxPlatformRecord }
  | { readonly status: 'already-done'; readonly key: string; readonly record: OutboxPlatformRecord }
  | { readonly status: 'superseded'; readonly key: string; readonly doneRevision: number }

/** Outcome of {@link OutboxRunner.retryDead}. */
export type OutboxRetryOutcome = 'requeued' | 'superseded' | 'not-dead'

/** Summary of one {@link OutboxRunner.processDue} pass. */
export interface OutboxProcessSummary {
  readonly delivered: number
  readonly retried: number
  readonly dead: number
  readonly skipped: number
}

/** Options when constructing an {@link OutboxRunner}. */
export interface OutboxRunnerOptions {
  readonly table: DomainTable<OutboxPlatformRecord>
  /** Actual upload side effect; resolves on success or rejects on failure. */
  readonly deliver: (record: OutboxPlatformRecord, signal: AbortSignal) => Promise<OutboxDeliverResult | void>
  /** Maximum attempts before transitioning to `'dead'`. Defaults to {@link DEFAULT_OUTBOX_MAX_ATTEMPTS}. */
  readonly maxAttempts?: number
  /** First backoff interval in milliseconds. Defaults to {@link DEFAULT_OUTBOX_BASE_DELAY_MS}. */
  readonly baseDelayMs?: number
  /** Ceiling for exponential backoff in milliseconds. Defaults to {@link DEFAULT_OUTBOX_MAX_DELAY_MS}. */
  readonly maxDelayMs?: number
  /** Maximum concurrent uploads across distinct `(taskId, logId)` pairs. Defaults to {@link DEFAULT_OUTBOX_CONCURRENCY}. */
  readonly concurrency?: number
  /** Invoked whenever an item transitions to `'dead'`. */
  readonly onDead?: (key: string, record: OutboxPlatformRecord) => void | Promise<void>
  /** Optional background error sink. */
  readonly onError?: (error: unknown) => void
  /** Injectable clock (epoch ms); defaults to `Date.now`. */
  readonly now?: () => number
}

function targetLockKey(taskId: string, logId: string): string {
  return `${taskId}\0${logId}`
}

/** Persistent, revision-monotonic outbox runner with exponential backoff and dead-letter retry. */
export class OutboxRunner {
  private readonly table: DomainTable<OutboxPlatformRecord>
  private readonly deliver: (record: OutboxPlatformRecord, signal: AbortSignal) => Promise<OutboxDeliverResult | void>
  private readonly maxAttempts: number
  private readonly baseDelayMs: number
  private readonly maxDelayMs: number
  private readonly onDead: ((key: string, record: OutboxPlatformRecord) => void | Promise<void>) | undefined
  private readonly onError: ((error: unknown) => void) | undefined
  private readonly now: () => number
  private readonly pool: TaskPool
  private readonly pairLocks = new Map<string, Promise<unknown>>()
  private readonly inflightPasses = new Set<Promise<OutboxProcessSummary>>()
  private readonly inflightOps = new Set<Promise<unknown>>()
  private readonly activePairPasses = new Map<string, { maxDueAt: number; promise: Promise<void> }>()
  private bgPollInFlight = false
  private pollTimer: ReturnType<typeof setInterval> | undefined
  private closing = false

  constructor(options: OutboxRunnerOptions) {
    if (options.maxAttempts !== undefined && (!Number.isInteger(options.maxAttempts) || options.maxAttempts < 1)) {
      throw new RangeError(`OutboxRunner: maxAttempts 必须是正整数，收到 ${String(options.maxAttempts)}`)
    }
    if (options.baseDelayMs !== undefined && (!Number.isFinite(options.baseDelayMs) || options.baseDelayMs < 0)) {
      throw new RangeError(`OutboxRunner: baseDelayMs 必须是非负数，收到 ${String(options.baseDelayMs)}`)
    }
    if (options.maxDelayMs !== undefined && (!Number.isFinite(options.maxDelayMs) || options.maxDelayMs < 0)) {
      throw new RangeError(`OutboxRunner: maxDelayMs 必须是非负数，收到 ${String(options.maxDelayMs)}`)
    }
    this.table = options.table
    this.deliver = options.deliver
    this.maxAttempts = options.maxAttempts ?? DEFAULT_OUTBOX_MAX_ATTEMPTS
    this.baseDelayMs = options.baseDelayMs ?? DEFAULT_OUTBOX_BASE_DELAY_MS
    this.maxDelayMs = options.maxDelayMs ?? DEFAULT_OUTBOX_MAX_DELAY_MS
    this.onDead = options.onDead
    this.onError = options.onError
    this.now = options.now ?? Date.now
    this.pool = new TaskPool({
      name: 'outboxPlatform',
      concurrency: options.concurrency ?? DEFAULT_OUTBOX_CONCURRENCY,
    })
  }

  private withPairLock<T>(taskId: string, logId: string, fn: () => Promise<T>): Promise<T> {
    const lockKey = targetLockKey(taskId, logId)
    const prev = this.pairLocks.get(lockKey) ?? Promise.resolve()
    const next = prev.then(fn, fn)
    const tracked = next.then(() => undefined, () => undefined).finally(() => {
      if (this.pairLocks.get(lockKey) === tracked) {
        this.pairLocks.delete(lockKey)
      }
    })
    this.pairLocks.set(lockKey, tracked)
    return next
  }

  /**
   * Highest revision already marked `'done'` for `(taskId, logId)` (`0` when none).
   */
  highestDoneRevision(taskId: string, logId: string): number {
    let highest = 0
    for (const [, record] of this.table.entries()) {
      if (record.taskId === taskId && record.logId === logId && record.status === 'done' && record.revision > highest) {
        highest = record.revision
      }
    }
    return highest
  }

  /**
   * Compute exponential backoff delay after `attempts` failed attempts (`1`-based).
   */
  computeBackoffMs(attempts: number): number {
    const exponent = Math.max(0, attempts - 1)
    const raw = this.baseDelayMs * (2 ** exponent)
    return Math.min(this.maxDelayMs, Math.round(raw))
  }

  private trackOperation<T>(op: () => Promise<T>): Promise<T> {
    const promise = op().finally(() => {
      this.inflightOps.delete(promise)
    })
    this.inflightOps.add(promise)
    return promise
  }

  /**
   * Recover rows left in `'uploading'` from an unclean shutdown back to `'pending'`
   * (or discard them if a higher revision already completed).
   * @returns number of rows recovered or cleaned up.
   */
  recoverInterrupted(): Promise<number> {
    if (this.closing) {
      return Promise.reject(new Error('OutboxRunner 已关闭，不能执行中断恢复'))
    }
    return this.trackOperation(async () => {
      let touched = 0
      for (const [key, record] of this.table.entries()) {
        if (record.status !== 'uploading') continue
        await this.withPairLock(record.taskId, record.logId, async () => {
          const latest = this.table.get(key)
          if (latest?.status !== 'uploading') return
          if (this.highestDoneRevision(latest.taskId, latest.logId) > latest.revision) {
            await this.table.delete(key)
            touched += 1
            return
          }
          await this.table.put(key, {
            ...latest,
            status: 'pending',
            nextRetryAt: this.now(),
          })
          touched += 1
        })
      }
      return touched
    })
  }

  /**
   * Enqueue a `(taskId, revision, logId)` item idempotently.
   * Skips insertion immediately if a higher revision for `(taskId, logId)` is already `'done'`.
   */
  enqueue(input: OutboxEnqueueInput): Promise<OutboxEnqueueOutcome> {
    if (this.closing) {
      return Promise.reject(new Error('OutboxRunner 已关闭，不能入队新回传任务'))
    }
    if (!Number.isInteger(input.revision) || input.revision < 1) {
      return Promise.reject(new RangeError(`OutboxRunner.enqueue: revision 必须是正整数，收到 ${String(input.revision)}`))
    }
    const key = outboxPlatformKey(input.taskId, input.revision, input.logId)
    return this.trackOperation(() => this.withPairLock(input.taskId, input.logId, async () => {
      const doneRevision = this.highestDoneRevision(input.taskId, input.logId)
      if (doneRevision > input.revision) {
        return { status: 'superseded', key, doneRevision }
      }
      const existing = this.table.get(key)
      if (existing !== undefined) {
        if (existing.status === 'done') {
          return { status: 'already-done', key, record: existing }
        }
        return { status: 'existing', key, record: existing }
      }
      const record: OutboxPlatformRecord = {
        taskId: input.taskId,
        revision: input.revision,
        logId: input.logId,
        status: 'pending',
        attempts: 0,
        nextRetryAt: this.now(),
      }
      await this.table.put(key, record)
      return { status: 'enqueued', key, record }
    }))
  }

  /**
   * Manually reset one `'dead'` record to `'pending'` for immediate retry,
   * unless a higher revision for `(taskId, logId)` has already completed.
   */
  retryDead(key: string): Promise<OutboxRetryOutcome> {
    if (this.closing) {
      return Promise.reject(new Error('OutboxRunner 已关闭，不能重试死信任务'))
    }
    return this.trackOperation(() => this.retryDeadInternal(key))
  }

  private async retryDeadInternal(key: string): Promise<OutboxRetryOutcome> {
    const initial = this.table.get(key)
    if (initial === undefined || initial.status !== 'dead') {
      return 'not-dead'
    }
    const outcome = await this.withPairLock(initial.taskId, initial.logId, async (): Promise<OutboxRetryOutcome> => {
      const current = this.table.get(key)
      if (current === undefined || current.status !== 'dead') return 'not-dead'
      if (this.highestDoneRevision(current.taskId, current.logId) > current.revision) {
        await this.table.delete(key)
        return 'superseded'
      }
      const resetRecord: OutboxPlatformRecord = {
        taskId: current.taskId,
        revision: current.revision,
        logId: current.logId,
        status: 'pending',
        ...(current.analysisId === undefined ? {} : { analysisId: current.analysisId }),
        ...(current.detailUrl === undefined ? {} : { detailUrl: current.detailUrl }),
        attempts: 0,
        nextRetryAt: this.now(),
      }
      await this.table.put(key, resetRecord)
      return 'requeued'
    })
    if (outcome === 'requeued' && this.pollTimer !== undefined && !this.closing) {
      void this.processDue().catch(err => this.onError?.(err))
    }
    return outcome
  }

  /**
   * Reset all `'dead'` entries (optionally scoped to `taskId`) for immediate retry.
   */
  retryAllDead(filter?: { readonly taskId?: string }): Promise<{ readonly requeued: number; readonly superseded: number }> {
    if (this.closing) {
      return Promise.reject(new Error('OutboxRunner 已关闭，不能批量重试死信任务'))
    }
    return this.trackOperation(async () => {
      let requeued = 0
      let superseded = 0
      for (const [key, record] of this.table.entries()) {
        if (record.status !== 'dead') continue
        if (filter?.taskId !== undefined && record.taskId !== filter.taskId) continue
        const outcome = await this.retryDeadInternal(key)
        if (outcome === 'requeued') requeued += 1
        else if (outcome === 'superseded') superseded += 1
      }
      return { requeued, superseded }
    })
  }

  /** List all entries currently in `'dead'` status. */
  listDead(): [string, OutboxPlatformRecord][] {
    return this.table.entries().filter(([, record]) => record.status === 'dead')
  }

  /**
   * Execute all `'pending'` entries whose `nextRetryAt <= at` (defaults to `this.now()`).
   * Within each `(taskId, logId)` pair, higher revisions execute first so obsolete
   * lower revisions are automatically skipped without calling `deliver`.
   */
  processDue(at: number = this.now()): Promise<OutboxProcessSummary> {
    if (this.closing) {
      return Promise.resolve({ delivered: 0, retried: 0, dead: 0, skipped: 0 })
    }
    const pass = this.runDuePass(at).finally(() => {
      this.inflightPasses.delete(pass)
    })
    this.inflightPasses.add(pass)
    return pass
  }

  private async runDuePass(at: number): Promise<OutboxProcessSummary> {
    const duePairs = new Map<string, { readonly taskId: string; readonly logId: string }>()
    for (const [, record] of this.table.entries()) {
      const pairKey = targetLockKey(record.taskId, record.logId)
      const isDuePending = record.status === 'pending' && record.nextRetryAt <= at
      const isInFlightUploading = record.status === 'uploading' && this.activePairPasses.has(pairKey)
      if (!isDuePending && !isInFlightUploading) continue
      if (!duePairs.has(pairKey)) {
        duePairs.set(pairKey, { taskId: record.taskId, logId: record.logId })
      }
    }

    let delivered = 0
    let retried = 0
    let dead = 0
    let skipped = 0

    await Promise.all([...duePairs.entries()].map(async ([pairKey, sample]) => {
      if (this.closing) return
      const existing = this.activePairPasses.get(pairKey)
      if (existing !== undefined) {
        existing.maxDueAt = Math.max(existing.maxDueAt, at)
        await existing.promise
        return
      }
      const state = { maxDueAt: at, promise: Promise.resolve() }
      const promise = this.pool.run(async (signal) => {
        await this.withPairLock(sample.taskId, sample.logId, async () => {
          const attemptedKeys = new Set<string>()
          while (!this.closing && !signal.aborted) {
            const threshold = state.maxDueAt
            const candidates = this.table.entries()
              .filter(([key, rec]) =>
                rec.taskId === sample.taskId
                && rec.logId === sample.logId
                && rec.status === 'pending'
                && rec.nextRetryAt <= threshold
                && !attemptedKeys.has(key))
              .sort((a, b) => b[1].revision - a[1].revision)
            if (candidates.length === 0) {
              if (this.activePairPasses.get(pairKey) === state) {
                this.activePairPasses.delete(pairKey)
              }
              break
            }
            for (const [key] of candidates) {
              if (this.closing || signal.aborted) return
              attemptedKeys.add(key)
              const outcome = await this.deliverOne(key, threshold, signal)
              if (outcome === 'delivered') delivered += 1
              else if (outcome === 'retried') retried += 1
              else if (outcome === 'dead') dead += 1
              else if (outcome === 'skipped') skipped += 1
            }
          }
        })
      }).catch((error: unknown) => {
        if (!this.closing) throw error
      }).finally(() => {
        if (this.activePairPasses.get(pairKey) === state) {
          this.activePairPasses.delete(pairKey)
        }
      })
      state.promise = promise
      this.activePairPasses.set(pairKey, state)
      await promise
    }))

    return { delivered, retried, dead, skipped }
  }

  private async deliverOne(
    key: string,
    dueThreshold: number,
    signal: AbortSignal,
  ): Promise<'delivered' | 'retried' | 'dead' | 'skipped' | 'noop'> {
    const current = this.table.get(key)
    if (current === undefined || current.status !== 'pending' || current.nextRetryAt > dueThreshold) {
      return 'noop'
    }

    // Monotonic guard BEFORE upload: skip & discard if a higher revision already finished!
    if (this.highestDoneRevision(current.taskId, current.logId) > current.revision) {
      await this.table.delete(key)
      return 'skipped'
    }

    const uploading: OutboxPlatformRecord = {
      ...current,
      status: 'uploading',
    }
    await this.table.put(key, uploading)

    try {
      const result = await this.deliver(uploading, signal)
      // Re-check monotonic guard just in case an external path wrote a higher done revision.
      if (this.highestDoneRevision(current.taskId, current.logId) > current.revision) {
        await this.table.delete(key)
        return 'skipped'
      }
      const analysisId = result?.analysisId ?? current.analysisId
      const detailUrl = result?.detailUrl ?? current.detailUrl
      const doneRecord: OutboxPlatformRecord = {
        taskId: current.taskId,
        revision: current.revision,
        logId: current.logId,
        status: 'done',
        ...(analysisId === undefined ? {} : { analysisId }),
        ...(detailUrl === undefined ? {} : { detailUrl }),
        attempts: current.attempts + 1,
        nextRetryAt: this.now(),
      }
      await this.table.put(key, doneRecord)
      return 'delivered'
    } catch (error) {
      if (this.highestDoneRevision(current.taskId, current.logId) > current.revision) {
        await this.table.delete(key)
        return 'skipped'
      }
      const attempts = current.attempts + 1
      const permanent = typeof error === 'object'
        && error !== null
        && (error as { permanent?: unknown }).permanent === true
      const now = this.now()
      const lastError = messageOf(error)

      if (permanent || attempts >= this.maxAttempts) {
        const deadRecord: OutboxPlatformRecord = {
          taskId: current.taskId,
          revision: current.revision,
          logId: current.logId,
          status: 'dead',
          ...(current.analysisId === undefined ? {} : { analysisId: current.analysisId }),
          ...(current.detailUrl === undefined ? {} : { detailUrl: current.detailUrl }),
          attempts,
          nextRetryAt: now,
          lastError,
        }
        await this.table.put(key, deadRecord)
        try {
          await this.onDead?.(key, deadRecord)
        } catch (cbError) {
          this.onError?.(cbError)
        }
        return 'dead'
      }

      const nextRetryAt = now + this.computeBackoffMs(attempts)
      const retryRecord: OutboxPlatformRecord = {
        taskId: current.taskId,
        revision: current.revision,
        logId: current.logId,
        status: 'pending',
        ...(current.analysisId === undefined ? {} : { analysisId: current.analysisId }),
        ...(current.detailUrl === undefined ? {} : { detailUrl: current.detailUrl }),
        attempts,
        nextRetryAt,
        lastError,
      }
      await this.table.put(key, retryRecord)
      return 'retried'
    }
  }

  /**
   * Start periodic background polling for due outbox entries.
   */
  start(pollIntervalMs = 1_000): void {
    if (this.closing || this.pollTimer !== undefined) return
    const timer = setInterval(() => {
      if (this.closing || this.bgPollInFlight) return
      this.bgPollInFlight = true
      void this.processDue()
        .catch((error: unknown) => {
          this.onError?.(error)
        })
        .finally(() => {
          this.bgPollInFlight = false
        })
    }, pollIntervalMs)
    timer.unref?.()
    this.pollTimer = timer
  }

  /**
   * Stop background polling and wait for all in-flight upload passes and admitted mutations to settle.
   */
  async drainAndClose(options: { readonly abortActive?: boolean } = {}): Promise<void> {
    this.closing = true
    if (this.pollTimer !== undefined) {
      clearInterval(this.pollTimer)
      this.pollTimer = undefined
    }
    await this.pool.drainAndClose({
      cancelQueued: true,
      abortActive: options.abortActive ?? false,
    })
    while (this.inflightPasses.size > 0 || this.inflightOps.size > 0 || this.pairLocks.size > 0) {
      await Promise.allSettled([
        ...this.inflightPasses,
        ...this.inflightOps,
        ...this.pairLocks.values(),
      ])
    }
  }
}
