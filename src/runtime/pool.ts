/**
 * 独立异步并发池（`TaskPool`）：为日志自动监管池（默认并发 4）与 MR 自动评审池
 * （默认并发 3）提供互不饥饿的槽位隔离、`AbortSignal` 排队/执行期取消、实时活跃
 * 与排队统计，以及插件卸载时的 `drainAndClose()` 平滑屏障。
 *
 * @module dsh-logalyze/runtime/pool
 */

/** Default concurrency of the automatic log analysis pool (`04-storage-and-operations.md`). */
export const DEFAULT_LOG_POOL_CONCURRENCY = 4

/** Default concurrency of the automatic MR review pool (`04-storage-and-operations.md`). */
export const DEFAULT_MR_POOL_CONCURRENCY = 3

/** Options when constructing a {@link TaskPool}. */
export interface TaskPoolOptions {
  /** Readable pool name used in error messages and diagnostics (e.g. `'logPool'`, `'mrPool'`). */
  readonly name?: string
  /** Maximum number of tasks executing concurrently (positive integer). */
  readonly concurrency: number
}

/** Per-task run options. */
export interface TaskRunOptions {
  /** Cancels waiting in the queue immediately, or signals an already-started task. */
  readonly signal?: AbortSignal
}

/** Snapshot of pool capacity and occupancy. */
export interface TaskPoolStats {
  readonly name: string
  readonly concurrency: number
  readonly active: number
  readonly queued: number
  readonly completed: number
  readonly closing: boolean
  readonly closed: boolean
}

/** Options controlling how {@link TaskPool.drainAndClose} winds down in-flight work. */
export interface DrainPoolOptions {
  /** Reject still-queued tasks immediately instead of letting them run as slots free up. Defaults to `false`. */
  readonly cancelQueued?: boolean
  /** Trigger the pool abort signal passed to currently active tasks. Defaults to `false`. */
  readonly abortActive?: boolean
  /** Custom cancellation reason used when `cancelQueued` or `abortActive` is set. */
  readonly reason?: unknown
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted.', 'AbortError')
}

interface QueuedEntry {
  readonly start: () => void
  readonly cancel: (reason: unknown) => void
}

/** Bounded-concurrency async execution pool with cancellation and graceful drain. */
export class TaskPool {
  readonly name: string
  private limit: number
  private active = 0
  private completed = 0
  private closing = false
  private closed = false
  private readonly queue: QueuedEntry[] = []
  private readonly poolAbort = new AbortController()
  private drainPromise: Promise<void> | undefined
  private resolveIdle: (() => void) | undefined

  constructor(options: TaskPoolOptions) {
    if (!Number.isInteger(options.concurrency) || options.concurrency < 1) {
      throw new RangeError(`TaskPool(${options.name ?? 'pool'}): concurrency 必须是正整数，收到 ${String(options.concurrency)}`)
    }
    this.name = options.name ?? 'pool'
    this.limit = options.concurrency
  }

  /** Configured concurrency limit. */
  get concurrency(): number {
    return this.limit
  }

  /** Number of currently executing tasks. */
  get activeCount(): number {
    return this.active
  }

  /** Number of tasks waiting for a concurrency slot. */
  get queuedCount(): number {
    return this.queue.length
  }

  /** Whether the pool is draining or already closed. */
  get isClosing(): boolean {
    return this.closing
  }

  /** Whether the pool has finished draining and closed completely. */
  get isClosed(): boolean {
    return this.closed
  }

  /** Snapshot of current pool metrics. */
  stats(): TaskPoolStats {
    return {
      name: this.name,
      concurrency: this.limit,
      active: this.active,
      queued: this.queue.length,
      completed: this.completed,
      closing: this.closing,
      closed: this.closed,
    }
  }

  /** Dynamically adjust concurrency and dispatch queued tasks if capacity grew. */
  setConcurrency(concurrency: number): void {
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new RangeError(`TaskPool(${this.name}): concurrency 必须是正整数，收到 ${String(concurrency)}`)
    }
    this.limit = concurrency
    this.pump()
  }

  /**
   * Schedule and run an async task inside the pool.
   * - Rejects immediately if the pool is closing/closed or `options.signal` is already aborted.
   * - Evicts from the queue immediately without starting `fn` if `options.signal` aborts while queued.
   * - Passes a combined `AbortSignal` to `fn` and holds the slot until `fn`'s promise settles.
   */
  run<T>(fn: (signal: AbortSignal) => Promise<T>, options: TaskRunOptions = {}): Promise<T> {
    if (this.closing || this.closed) {
      return Promise.reject(new Error(`并发池 "${this.name}" 已关闭，不再接受新任务`))
    }
    const callerSignal = options.signal
    if (callerSignal?.aborted === true) {
      return Promise.reject(abortReason(callerSignal))
    }

    if (this.active < this.limit && this.queue.length === 0) {
      return this.executeNow(fn, callerSignal)
    }

    return new Promise<T>((resolve, reject) => {
      let settled = false
      const onCallerAbort = (): void => {
        if (settled) return
        settled = true
        const idx = this.queue.indexOf(entry)
        if (idx >= 0) this.queue.splice(idx, 1)
        reject(abortReason(callerSignal!))
        this.checkIdle()
      }

      const entry: QueuedEntry = {
        start: () => {
          if (settled) return
          settled = true
          callerSignal?.removeEventListener('abort', onCallerAbort)
          if (callerSignal?.aborted === true) {
            reject(abortReason(callerSignal))
            this.pump()
            this.checkIdle()
            return
          }
          this.executeNow(fn, callerSignal).then(resolve, reject)
        },
        cancel: (reason: unknown) => {
          if (settled) return
          settled = true
          callerSignal?.removeEventListener('abort', onCallerAbort)
          reject(reason)
        },
      }

      callerSignal?.addEventListener('abort', onCallerAbort, { once: true })
      this.queue.push(entry)
    })
  }

  private async executeNow<T>(fn: (signal: AbortSignal) => Promise<T>, callerSignal: AbortSignal | undefined): Promise<T> {
    this.active += 1
    const runSignal = callerSignal === undefined
      ? this.poolAbort.signal
      : AbortSignal.any([this.poolAbort.signal, callerSignal])
    try {
      return await fn(runSignal)
    } finally {
      this.active -= 1
      this.completed += 1
      this.pump()
      this.checkIdle()
    }
  }

  private pump(): void {
    while (this.active < this.limit && this.queue.length > 0) {
      const next = this.queue.shift()
      next?.start()
    }
  }

  private checkIdle(): void {
    if (this.closing && this.active === 0 && this.queue.length === 0) {
      this.closed = true
      const done = this.resolveIdle
      this.resolveIdle = undefined
      done?.()
    }
  }

  /**
   * Stop admitting new tasks and wait until queued and active tasks finish.
   * Calling `drainAndClose()` multiple times is idempotent; upgrading options with
   * `cancelQueued` or `abortActive` takes effect immediately on remaining work.
   */
  drainAndClose(options: DrainPoolOptions = {}): Promise<void> {
    this.closing = true
    const reason = options.reason ?? new Error(`并发池 "${this.name}" 正在卸载关闭`)
    if (options.cancelQueued === true && this.queue.length > 0) {
      const evicted = this.queue.splice(0)
      for (const entry of evicted) {
        entry.cancel(reason)
      }
    }
    if (options.abortActive === true && !this.poolAbort.signal.aborted) {
      this.poolAbort.abort(reason)
    }
    if (this.active === 0 && this.queue.length === 0) {
      this.closed = true
      return Promise.resolve()
    }
    if (this.drainPromise === undefined) {
      this.drainPromise = new Promise<void>((resolve) => {
        this.resolveIdle = resolve
      })
    }
    return this.drainPromise
  }
}

/** Dual isolated supervision pools (`logPool` & `mrPool`). */
export interface SupervisionPools {
  readonly logPool: TaskPool
  readonly mrPool: TaskPool
  drainAndClose(options?: DrainPoolOptions): Promise<void>
}

/** Create the standard isolated `logPool` (default 4) and `mrPool` (default 3). */
export function createSupervisionPools(options: {
  readonly logConcurrency?: number
  readonly mrConcurrency?: number
} = {}): SupervisionPools {
  const logPool = new TaskPool({ name: 'logPool', concurrency: options.logConcurrency ?? DEFAULT_LOG_POOL_CONCURRENCY })
  const mrPool = new TaskPool({ name: 'mrPool', concurrency: options.mrConcurrency ?? DEFAULT_MR_POOL_CONCURRENCY })
  return {
    logPool,
    mrPool,
    async drainAndClose(drainOptions?: DrainPoolOptions): Promise<void> {
      await Promise.all([
        logPool.drainAndClose(drainOptions),
        mrPool.drainAndClose(drainOptions),
      ])
    },
  }
}
