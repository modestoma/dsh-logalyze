/**
 * 按键分组窗口防抖与批次合并器（`KeyedDebouncer`）：
 * - **首条起算固定窗口（`mode: 'fixed'`）**：用于日志批次聚合（首条日志打开窗口，凑满 `maxItems` 立即发车，否则到期发车，支持重启按 `windowOpenedAt` 恢复计时）。
 * - **信号合并滑动窗口（`mode: 'sliding'`）**：用于 MR 新提交/新评论防抖（每次新信号顺延窗口，可选 `maxWaitMs` 硬上限防无限推迟）。
 * - 支持立即刷出（`flush` / `flushDue` / `flushAll`）、取消（`cancel` / `cancelAll`）、可注入时钟 `now` 与平滑关闭屏障 `drainAndClose()`。
 *
 * @module dsh-logalyze/runtime/debouncer
 */

/** Window advancement strategy. */
export type DebounceWindowMode = 'fixed' | 'sliding'

/** Metadata passed alongside flushed items. */
export interface DebounceFlushMeta {
  readonly firstAt: number
  readonly lastAt: number
  readonly dueAt: number
  readonly flushedAt: number
  readonly reason: 'timer' | 'max-items' | 'manual'
}

/** Snapshot of one buffered key. */
export interface DebounceEntrySnapshot<T> {
  readonly items: readonly T[]
  readonly firstAt: number
  readonly lastAt: number
  readonly dueAt: number
  readonly mode: DebounceWindowMode
}

/** Result returned by {@link KeyedDebouncer.push}. */
export interface DebouncePushResult<T> {
  /** Whether reaching `maxItems` (or `windowMs <= 0`) triggered an immediate flush. */
  readonly flushedImmediately: boolean
  /** Promise of the immediate flush when `flushedImmediately === true`. */
  readonly flushPromise?: Promise<void>
  /** Pending window state when still buffered (`flushedImmediately === false`). */
  readonly snapshot?: DebounceEntrySnapshot<T>
}

/** Per-push overrides. */
export interface DebouncePushOptions {
  readonly windowMs?: number
  readonly mode?: DebounceWindowMode
  readonly maxItems?: number
  readonly maxWaitMs?: number
  /** Explicit window open timestamp (e.g., recovered from `pending_batches.windowOpenedAt`). */
  readonly openedAt?: number
}

/** Options when constructing a {@link KeyedDebouncer}. */
export interface KeyedDebouncerOptions<T, K extends string = string> {
  /** Default window duration in milliseconds. */
  readonly windowMs: number
  /** Default window mode (`'fixed'` from first item, or `'sliding'` signal merge). Defaults to `'sliding'`. */
  readonly mode?: DebounceWindowMode
  /** Optional item count ceiling that triggers immediate flush upon reaching `maxItems`. */
  readonly maxItems?: number
  /** Optional ceiling from `firstAt` for `'sliding'` windows so continuous signals still flush eventually. */
  readonly maxWaitMs?: number
  /** Optional item combiner/deduplicator invoked before appending or flushing. */
  readonly merge?: (existing: readonly T[], incoming: T) => T[]
  /** Callback invoked when a key's window flushes. */
  readonly onFlush: (key: K, items: readonly T[], meta: DebounceFlushMeta) => void | Promise<void>
  /** Error sink for timer-triggered async `onFlush` rejections. */
  readonly onError?: (error: unknown, key: K, items: readonly T[]) => void
  /** Injectable clock (epoch ms); defaults to `Date.now`. */
  readonly now?: () => number
  /** Set `false` to disable background `setTimeout` scheduling and drive exclusively via `flushDue()`. Defaults to `true`. */
  readonly autoTimer?: boolean
}

interface InternalBucket<T> {
  items: T[]
  readonly firstAt: number
  lastAt: number
  dueAt: number
  mode: DebounceWindowMode
  timer?: ReturnType<typeof setTimeout>
}

/** Keyed fixed-window & sliding-window debouncer with deterministic clock support. */
export class KeyedDebouncer<T, K extends string = string> {
  private readonly defaultWindowMs: number
  private readonly defaultMode: DebounceWindowMode
  private readonly defaultMaxItems: number | undefined
  private readonly defaultMaxWaitMs: number | undefined
  private readonly merge: (existing: readonly T[], incoming: T) => T[]
  private readonly onFlush: (key: K, items: readonly T[], meta: DebounceFlushMeta) => void | Promise<void>
  private readonly onError: ((error: unknown, key: K, items: readonly T[]) => void) | undefined
  private readonly now: () => number
  private readonly autoTimer: boolean
  private readonly buckets = new Map<K, InternalBucket<T>>()
  private readonly inflight = new Set<Promise<void>>()
  private closed = false

  constructor(options: KeyedDebouncerOptions<T, K>) {
    if (!Number.isFinite(options.windowMs) || options.windowMs < 0) {
      throw new RangeError(`KeyedDebouncer: windowMs 必须是非负数，收到 ${String(options.windowMs)}`)
    }
    if (options.maxItems !== undefined && (!Number.isInteger(options.maxItems) || options.maxItems < 1)) {
      throw new RangeError(`KeyedDebouncer: maxItems 必须是正整数，收到 ${String(options.maxItems)}`)
    }
    if (options.maxWaitMs !== undefined && (!Number.isFinite(options.maxWaitMs) || options.maxWaitMs < 0)) {
      throw new RangeError(`KeyedDebouncer: maxWaitMs 必须是非负数，收到 ${String(options.maxWaitMs)}`)
    }
    this.defaultWindowMs = options.windowMs
    this.defaultMode = options.mode ?? 'sliding'
    this.defaultMaxItems = options.maxItems
    this.defaultMaxWaitMs = options.maxWaitMs
    this.merge = options.merge ?? ((existing, incoming) => [...existing, incoming])
    this.onFlush = options.onFlush
    this.onError = options.onError
    this.now = options.now ?? Date.now
    this.autoTimer = options.autoTimer ?? true
  }

  /** Number of keys currently holding buffered items. */
  get size(): number {
    return this.buckets.size
  }

  /** Keys currently holding buffered items. */
  keys(): K[] {
    return [...this.buckets.keys()]
  }

  /** Inspect the buffered items and timestamps for `key`, if any. */
  peek(key: K): DebounceEntrySnapshot<T> | undefined {
    const bucket = this.buckets.get(key)
    if (bucket === undefined) return undefined
    return {
      items: [...bucket.items],
      firstAt: bucket.firstAt,
      lastAt: bucket.lastAt,
      dueAt: bucket.dueAt,
      mode: bucket.mode,
    }
  }

  /**
   * Push an item into `key`'s window.
   * - In `'fixed'` mode, `dueAt` stays anchored at `firstAt + windowMs`.
   * - In `'sliding'` mode, `dueAt` advances to `now + windowMs` (capped at `firstAt + maxWaitMs` if configured).
   * - If item count reaches `maxItems` (or `dueAt <= now`), flushes immediately.
   */
  push(key: K, item: T, options: DebouncePushOptions = {}): DebouncePushResult<T> {
    if (this.closed) {
      throw new Error('KeyedDebouncer 已关闭，不再接受新事件')
    }
    const currentNow = this.now()
    const windowMs = options.windowMs ?? this.defaultWindowMs
    const mode = options.mode ?? this.defaultMode
    const maxItems = options.maxItems ?? this.defaultMaxItems
    const maxWaitMs = options.maxWaitMs ?? this.defaultMaxWaitMs

    let bucket = this.buckets.get(key)
    if (bucket === undefined) {
      const firstAt = options.openedAt ?? currentNow
      const rawDue = firstAt + windowMs
      const dueAt = maxWaitMs === undefined ? rawDue : Math.min(rawDue, firstAt + maxWaitMs)
      bucket = {
        items: this.merge([], item),
        firstAt,
        lastAt: currentNow,
        dueAt,
        mode,
      }
      this.buckets.set(key, bucket)
    } else {
      bucket.items = this.merge(bucket.items, item)
      bucket.lastAt = currentNow
      bucket.mode = mode
      if (mode === 'sliding') {
        const rawDue = currentNow + windowMs
        bucket.dueAt = maxWaitMs === undefined ? rawDue : Math.min(rawDue, bucket.firstAt + maxWaitMs)
      }
    }

    if (maxItems !== undefined && bucket.items.length >= maxItems) {
      const flushPromise = this.dispatchBucket(key, bucket, currentNow, 'max-items')
      return { flushedImmediately: true, flushPromise }
    }

    if (bucket.dueAt <= currentNow) {
      const flushPromise = this.dispatchBucket(key, bucket, currentNow, 'timer')
      return { flushedImmediately: true, flushPromise }
    }

    this.scheduleTimer(key, bucket, currentNow)
    return {
      flushedImmediately: false,
      snapshot: this.peek(key)!,
    }
  }

  /** Immediately flush one key if buffered, returning the flushed items. */
  async flush(key: K): Promise<readonly T[] | undefined> {
    const bucket = this.buckets.get(key)
    if (bucket === undefined) return undefined
    const items = [...bucket.items]
    await this.dispatchBucket(key, bucket, this.now(), 'manual', true)
    return items
  }

  /**
   * Flush every key whose `dueAt <= at` (defaults to `this.now()`).
   * Ideal for deterministic clock testing as well as periodic tick loops.
   * @returns number of keys flushed.
   */
  async flushDue(at: number = this.now()): Promise<number> {
    const dueEntries: [K, InternalBucket<T>][] = []
    for (const [key, bucket] of this.buckets.entries()) {
      if (bucket.dueAt <= at) {
        dueEntries.push([key, bucket])
      }
    }
    await Promise.all(dueEntries.map(([key, bucket]) => this.dispatchBucket(key, bucket, at, 'timer', true)))
    return dueEntries.length
  }

  /** Immediately flush all buffered keys. */
  async flushAll(): Promise<void> {
    const entries = [...this.buckets.entries()]
    await Promise.all(entries.map(([key, bucket]) => this.dispatchBucket(key, bucket, this.now(), 'manual', true)))
  }

  /** Cancel and discard buffered items for `key` without invoking `onFlush`. */
  cancel(key: K): boolean {
    const bucket = this.buckets.get(key)
    if (bucket === undefined) return false
    if (bucket.timer !== undefined) {
      clearTimeout(bucket.timer)
      bucket.timer = undefined
    }
    this.buckets.delete(key)
    return true
  }

  /** Cancel and discard all buffered keys without invoking `onFlush`. */
  cancelAll(): void {
    for (const bucket of this.buckets.values()) {
      if (bucket.timer !== undefined) {
        clearTimeout(bucket.timer)
        bucket.timer = undefined
      }
    }
    this.buckets.clear()
  }

  /**
   * Close the debouncer, either flushing or cancelling remaining buffered windows,
   * and wait for all in-flight `onFlush` callbacks to settle.
   */
  async drainAndClose(options: { readonly flushPending?: boolean } = {}): Promise<void> {
    this.closed = true
    if (options.flushPending === true) {
      await this.flushAll()
    } else {
      this.cancelAll()
    }
    await Promise.allSettled([...this.inflight])
  }

  private scheduleTimer(key: K, bucket: InternalBucket<T>, currentNow: number): void {
    if (!this.autoTimer) return
    if (bucket.timer !== undefined) {
      clearTimeout(bucket.timer)
      bucket.timer = undefined
    }
    const delayMs = Math.max(0, bucket.dueAt - currentNow)
    const timer = setTimeout(() => {
      bucket.timer = undefined
      if (this.buckets.get(key) !== bucket) return
      const now = this.now()
      if (now < bucket.dueAt) {
        // Clock has not reached dueAt yet (e.g., custom `now` clock); reschedule remaining delta.
        this.scheduleTimer(key, bucket, now)
        return
      }
      void this.dispatchBucket(key, bucket, now, 'timer')
    }, delayMs)
    timer.unref?.()
    bucket.timer = timer
  }

  private dispatchBucket(
    key: K,
    bucket: InternalBucket<T>,
    flushedAt: number,
    reason: DebounceFlushMeta['reason'],
    propagateError = false,
  ): Promise<void> {
    if (bucket.timer !== undefined) {
      clearTimeout(bucket.timer)
      bucket.timer = undefined
    }
    if (this.buckets.get(key) === bucket) {
      this.buckets.delete(key)
    }
    const items = [...bucket.items]
    const meta: DebounceFlushMeta = {
      firstAt: bucket.firstAt,
      lastAt: bucket.lastAt,
      dueAt: bucket.dueAt,
      flushedAt,
      reason,
    }
    const run = Promise.resolve()
      .then(() => this.onFlush(key, items, meta))
      .catch((error: unknown) => {
        this.onError?.(error, key, items)
        if (propagateError) throw error
      })
    const tracked = run.finally(() => {
      this.inflight.delete(tracked)
    })
    this.inflight.add(tracked)
    return tracked
  }
}
