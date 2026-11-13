/**
 * 基于 `'dsh_supervisor'` 存储域 `circuit_breakers` 表的滑动窗口风暴熔断器（`CircuitBreakerRegistry`）：
 * - 按作用域键（如 `'log:<appId>'` 或 `'mr:<repo>'`）维护精确滑动时间窗口计数；
 * - 窗口内触发次数超出上限（`> limit`）时自动 `trip` 熔断，持久化 `trippedUntil` 与原因，并触发 `onTrip` 通知回调；
 * - 熔断期内拦截自动唤醒；冷却时间到期后自动恢复放行并清空旧窗口；
 * - 支持管理面板一键手动 `reset(key)` 解除熔断。
 *
 * @module dsh-logalyze/runtime/breaker
 */

import type { CircuitBreakerRecord } from './domain.ts'
import type { DomainTable } from './storage.ts'

/** Default sliding window duration: 1 hour (`04-storage-and-operations.md`). */
export const DEFAULT_BREAKER_WINDOW_MS = 60 * 60 * 1000

/** Default cooldown duration after tripping: 1 hour. */
export const DEFAULT_BREAKER_COOLDOWN_MS = 60 * 60 * 1000

/** Default hourly batch ceiling per log application (`> 15` batches/hour trips). */
export const DEFAULT_LOG_APP_HOURLY_LIMIT = 15

/** Default hourly wake ceiling per MR repository (`> 30` wakes/hour trips). */
export const DEFAULT_MR_REPO_HOURLY_LIMIT = 30

/** Policy governing one breaker key. */
export interface CircuitBreakerPolicy {
  /** Sliding window width in milliseconds. */
  readonly windowMs: number
  /** Maximum allowed triggers within `windowMs`; the `(limit + 1)`-th trigger trips the breaker. */
  readonly limit: number
  /** How long the breaker stays open (`tripped`) in milliseconds before auto-recovering. */
  readonly cooldownMs: number
}

/** Notification payload delivered when a breaker transitions to tripped. */
export interface CircuitBreakerTripEvent {
  readonly key: string
  readonly triggeredCount: number
  readonly limit: number
  readonly windowMs: number
  readonly trippedAt: number
  readonly trippedUntil: number
  readonly reason: string
}

/** Live view of one circuit breaker key. */
export interface CircuitBreakerStatus {
  readonly key: string
  readonly tripped: boolean
  readonly windowStartAt: number
  readonly triggeredCount: number
  readonly limit: number
  readonly windowMs: number
  readonly trippedUntil?: number
  readonly reason?: string
}

/** Outcome of recording one trigger attempt against a breaker key. */
export interface CircuitBreakerDecision {
  /** `true` if execution may proceed; `false` if blocked because the breaker tripped or was already open. */
  readonly allowed: boolean
  /** `true` when the breaker is currently open (`tripped`). */
  readonly tripped: boolean
  /** `true` only on the exact transition that tripped the breaker. */
  readonly newlyTripped: boolean
  readonly status: CircuitBreakerStatus
}

/** Options when constructing a {@link CircuitBreakerRegistry}. */
export interface CircuitBreakerRegistryOptions {
  readonly table: DomainTable<CircuitBreakerRecord>
  /** Default policy; defaults to 1h window, limit 15 (or 30 for `mr:` keys unless overridden), 1h cooldown. */
  readonly defaultPolicy?: Partial<CircuitBreakerPolicy>
  /** Optional per-key policy resolver (e.g. distinguishing `'log:<app>'` vs `'mr:<repo>'`). */
  readonly resolvePolicy?: (key: string) => Partial<CircuitBreakerPolicy> | undefined
  /** Invoked whenever a key trips (automatic threshold breach or explicit `trip()`). */
  readonly onTrip?: (event: CircuitBreakerTripEvent) => void | Promise<void>
  /** Optional error logger if `onTrip` throws; callback failures never corrupt breaker state. */
  readonly onError?: (error: unknown, event: CircuitBreakerTripEvent) => void
  /** Injectable clock (epoch ms); defaults to `Date.now`. */
  readonly now?: () => number
}

/** Registry of persistent, per-scope sliding-window circuit breakers. */
export class CircuitBreakerRegistry {
  private readonly table: DomainTable<CircuitBreakerRecord>
  private readonly defaultPolicy: Partial<CircuitBreakerPolicy>
  private readonly resolvePolicy: ((key: string) => Partial<CircuitBreakerPolicy> | undefined) | undefined
  private readonly onTrip: ((event: CircuitBreakerTripEvent) => void | Promise<void>) | undefined
  private readonly onError: ((error: unknown, event: CircuitBreakerTripEvent) => void) | undefined
  private readonly now: () => number
  private readonly locks = new Map<string, Promise<unknown>>()

  constructor(options: CircuitBreakerRegistryOptions) {
    this.table = options.table
    this.defaultPolicy = options.defaultPolicy ?? {}
    this.resolvePolicy = options.resolvePolicy
    this.onTrip = options.onTrip
    this.onError = options.onError
    this.now = options.now ?? Date.now
  }

  private policyFor(key: string, overrides?: Partial<CircuitBreakerPolicy>): CircuitBreakerPolicy {
    const fallbackLimit = key.startsWith('mr:') ? DEFAULT_MR_REPO_HOURLY_LIMIT : DEFAULT_LOG_APP_HOURLY_LIMIT
    const custom = this.resolvePolicy?.(key)
    const windowMs = overrides?.windowMs ?? custom?.windowMs ?? this.defaultPolicy.windowMs ?? DEFAULT_BREAKER_WINDOW_MS
    const limit = overrides?.limit ?? custom?.limit ?? this.defaultPolicy.limit ?? fallbackLimit
    const cooldownMs = overrides?.cooldownMs ?? custom?.cooldownMs ?? this.defaultPolicy.cooldownMs ?? DEFAULT_BREAKER_COOLDOWN_MS
    return { windowMs, limit, cooldownMs }
  }

  private withKeyLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve()
    const next = prev.then(fn, fn)
    const tracked = next.then(() => undefined, () => undefined).finally(() => {
      if (this.locks.get(key) === tracked) {
        this.locks.delete(key)
      }
    })
    this.locks.set(key, tracked)
    return next
  }

  private pruneWindowEvents(record: CircuitBreakerRecord | undefined, now: number, windowMs: number): number[] {
    if (record === undefined) return []
    const lowerBound = now - windowMs
    if (record.events !== undefined) {
      return record.events.filter(ts => ts > lowerBound && ts <= now)
    }
    if (record.triggeredCount > 0 && record.windowStartAt > lowerBound) {
      return Array.from({ length: record.triggeredCount }, () => record.windowStartAt)
    }
    return []
  }

  private toStatus(key: string, record: CircuitBreakerRecord | undefined, policy: CircuitBreakerPolicy, now: number): CircuitBreakerStatus {
    if (record === undefined) {
      return {
        key,
        tripped: false,
        windowStartAt: now,
        triggeredCount: 0,
        limit: policy.limit,
        windowMs: policy.windowMs,
      }
    }
    const stillTripped = record.trippedUntil !== undefined && now < record.trippedUntil
    if (stillTripped) {
      return {
        key,
        tripped: true,
        windowStartAt: record.windowStartAt,
        triggeredCount: record.triggeredCount,
        limit: policy.limit,
        windowMs: policy.windowMs,
        trippedUntil: record.trippedUntil,
        ...(record.reason === undefined ? {} : { reason: record.reason }),
      }
    }
    // If cooldown expired, view reflects recovered sliding window after trip expiry.
    const activeEvents = record.trippedUntil !== undefined
      ? []
      : this.pruneWindowEvents(record, now, policy.windowMs)
    return {
      key,
      tripped: false,
      windowStartAt: activeEvents[0] ?? now,
      triggeredCount: activeEvents.length,
      limit: policy.limit,
      windowMs: policy.windowMs,
    }
  }

  /**
   * Read-only snapshot of `key`'s breaker state at `this.now()`.
   */
  inspect(key: string): CircuitBreakerStatus {
    const now = this.now()
    const policy = this.policyFor(key)
    return this.toStatus(key, this.table.get(key), policy, now)
  }

  /**
   * List all keys currently in the `tripped` (open) state as of `this.now()`.
   */
  listTripped(): CircuitBreakerStatus[] {
    const now = this.now()
    const tripped: CircuitBreakerStatus[] = []
    for (const [key, record] of this.table.entries()) {
      if (record.trippedUntil !== undefined && now < record.trippedUntil) {
        const policy = this.policyFor(key)
        tripped.push(this.toStatus(key, record, policy, now))
      }
    }
    return tripped
  }

  /**
   * Check whether `key` is currently open without incrementing its trigger count.
   * If a previous trip's `trippedUntil` has elapsed, persists the recovery automatically.
   */
  canProceed(key: string): Promise<{ readonly allowed: boolean; readonly status: CircuitBreakerStatus }> {
    return this.withKeyLock(key, async () => {
      const now = this.now()
      const policy = this.policyFor(key)
      const existing = this.table.get(key)
      if (existing?.trippedUntil !== undefined) {
        if (now < existing.trippedUntil) {
          return { allowed: false, status: this.toStatus(key, existing, policy, now) }
        }
        // Cooldown expired: recover durable state cleanly.
        const recovered: CircuitBreakerRecord = {
          windowStartAt: now,
          triggeredCount: 0,
          events: [],
        }
        await this.table.put(key, recovered)
        return { allowed: true, status: this.toStatus(key, recovered, policy, now) }
      }
      return { allowed: true, status: this.toStatus(key, existing, policy, now) }
    })
  }

  /**
   * Record one trigger attempt for `key` within its sliding window.
   * - If already `tripped` and `now < trippedUntil`, rejects (`allowed: false`, `newlyTripped: false`).
   * - If `trippedUntil` has expired, auto-recovers and starts a fresh window with this attempt.
   * - If adding this trigger causes `count > limit`, trips the breaker (`allowed: false`, `newlyTripped: true`),
   *   persists `trippedUntil = now + cooldownMs`, and invokes `onTrip`.
   */
  record(
    key: string,
    options?: Partial<CircuitBreakerPolicy> & { readonly reason?: string },
  ): Promise<CircuitBreakerDecision> {
    return this.withKeyLock(key, async () => {
      const now = this.now()
      const policy = this.policyFor(key, options)
      const existing = this.table.get(key)

      if (existing?.trippedUntil !== undefined && now < existing.trippedUntil) {
        return {
          allowed: false,
          tripped: true,
          newlyTripped: false,
          status: this.toStatus(key, existing, policy, now),
        }
      }

      // If recovering from an expired trip, start from an empty event window.
      const priorEvents = existing?.trippedUntil !== undefined
        ? []
        : this.pruneWindowEvents(existing, now, policy.windowMs)

      const nextEvents = [...priorEvents, now]
      const windowStartAt = nextEvents[0] ?? now
      const triggeredCount = nextEvents.length

      if (triggeredCount > policy.limit) {
        const trippedUntil = now + policy.cooldownMs
        const reason = options?.reason
          ?? `滑动窗口 ${Math.round(policy.windowMs / 1000)}s 内触发 ${triggeredCount} 次，超过上限 ${policy.limit} 次`
        const trippedRecord: CircuitBreakerRecord = {
          windowStartAt,
          triggeredCount,
          events: nextEvents,
          trippedUntil,
          reason,
        }
        await this.table.put(key, trippedRecord)
        const event: CircuitBreakerTripEvent = {
          key,
          triggeredCount,
          limit: policy.limit,
          windowMs: policy.windowMs,
          trippedAt: now,
          trippedUntil,
          reason,
        }
        await this.notifyTrip(event)
        return {
          allowed: false,
          tripped: true,
          newlyTripped: true,
          status: this.toStatus(key, trippedRecord, policy, now),
        }
      }

      const updated: CircuitBreakerRecord = {
        windowStartAt,
        triggeredCount,
        events: nextEvents,
      }
      await this.table.put(key, updated)
      return {
        allowed: true,
        tripped: false,
        newlyTripped: false,
        status: this.toStatus(key, updated, policy, now),
      }
    })
  }

  /**
   * Explicitly trip `key` immediately with a custom reason and optional cooldown override.
   */
  trip(key: string, reason: string, cooldownMs?: number): Promise<CircuitBreakerStatus> {
    return this.withKeyLock(key, async () => {
      const now = this.now()
      const policy = this.policyFor(key, cooldownMs === undefined ? undefined : { cooldownMs })
      const existing = this.table.get(key)
      const events = this.pruneWindowEvents(existing, now, policy.windowMs)
      const trippedUntil = now + policy.cooldownMs
      const record: CircuitBreakerRecord = {
        windowStartAt: events[0] ?? existing?.windowStartAt ?? now,
        triggeredCount: Math.max(events.length, existing?.triggeredCount ?? 0),
        events,
        trippedUntil,
        reason,
      }
      await this.table.put(key, record)
      await this.notifyTrip({
        key,
        triggeredCount: record.triggeredCount,
        limit: policy.limit,
        windowMs: policy.windowMs,
        trippedAt: now,
        trippedUntil,
        reason,
      })
      return this.toStatus(key, record, policy, now)
    })
  }

  /**
   * Manually clear a tripped breaker and reset its sliding window counter.
   * @returns whether a stored breaker entry existed and was cleared.
   */
  reset(key: string): Promise<boolean> {
    return this.withKeyLock(key, () => this.table.delete(key))
  }

  /** Reset all breaker entries. */
  async resetAll(): Promise<number> {
    const keys = this.table.keys()
    let removed = 0
    for (const key of keys) {
      if (await this.reset(key)) removed += 1
    }
    return removed
  }

  private async notifyTrip(event: CircuitBreakerTripEvent): Promise<void> {
    if (this.onTrip === undefined) return
    try {
      await this.onTrip(event)
    } catch (error) {
      this.onError?.(error, event)
    }
  }
}
