/**
 * 观象有状态日志监管编排器（`LogSupervisor`）：
 * - 增量 `LogPoller`：按 `archived_at` 水位游标 `[T0, T1)` 多页拉取 `/open-api/v1/logs`，先持久化断点续传游标再推进水位线，支持暂停/恢复/回拨与指数退避；
 * - 窗口化 `BatchScheduler`：按 `(product_code, component_code, error_code)` 聚合并持久化在 `pending_batches`，支持阈值立即切片发车（上限 `maxBatchSize`）与固定首发计时窗口，启动时自动崩溃恢复；
 * - 强并发隔离 & 单应用小时级熔断：`logPool`（默认 4）与 `log:<appId>` 滑动窗口限流（触发时推送飞书告警且不阻塞其他应用）；
 * - 兼容全自动（`quiet-until-done` 两阶段静默诊断 / `topic-on-start` 直播话题）与飞书手工 ZIP/URL 会话，驱动 `OutboxRunner` 幂等回传与 `feishuActions` 半自动「修代码 / 改 SKILL」闭环。
 *
 * @module dsh-logalyze/log/supervisor
 */

import { randomBytes } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type { ReadyApp, RepoRegistry } from '../apps/registry.ts'
import type { FeishuActionsService } from '../deps/actions-contract.ts'
import type { ReposClient } from '../deps/repos.ts'
import type { FeishuTopicService, TopicCardLink, TopicLaunchState } from '../deps/topics-contract.ts'
import type { HostLogger } from '../host.ts'
import type { IssueMemory } from '../issues/memory.ts'
import type { RegisterSelfMrInput } from '../mr/supervisor.ts'
import { PlatformClient, PlatformError, platformProblem } from '../platform/client.ts'
import type { PlatformLog } from '../platform/client.ts'
import { listReport } from '../report/files.ts'
import { buildManifest } from '../report/manifest.ts'
import { UNLABELED_ERROR_CODE } from '../report/render.ts'
import { uploadRevision } from '../report/upload.ts'
import { admitPlatformUrl, downloadLog, DownloadError } from '../runs/download.ts'
import type { CircuitBreakerRegistry } from '../runtime/breaker.ts'
import { outboxPlatformKey } from '../runtime/domain.ts'
import type {
  IssuesTable,
  LogTaskInput,
  LogTaskRecord,
  LogTaskRevision,
  OutboxPlatformRecord,
  PendingBatchRecord,
  WatermarkRecord,
} from '../runtime/domain.ts'
import { OutboxRunner } from '../runtime/outbox.ts'
import type { TaskPool } from '../runtime/pool.ts'
import type { DomainTable } from '../runtime/storage.ts'
import type {
  BreakerStatusWire,
  DownloadSettings,
  LogSupervisionSettings,
  LogSupervisionWire,
  PlatformSettings,
  UploadSettings,
} from '../settings/contract.ts'
import { messageOf } from '../util/errors.ts'
import {
  appSlugOf,
  buildDefaultActionsForRevision,
  buildLogTopicLaunchSpec,
  buildPlatformDiagnosisPrompt,
  buildQuietDoneTopicPrompt,
  renderSupervisorLogReport,
} from './prompt.ts'
import type { LogSessionDriver } from './session-driver.ts'
import type { LogToolsRuntime } from './tools.ts'

export const LOG_WATERMARK_KEY = 'log_platform'
const MAX_POLL_PAGES = 1_000
const MAX_POLL_BACKOFF_MS = 15 * 60 * 1000
const OUTBOX_POLL_INTERVAL_MS = 2_000
const MAX_PANEL_TASKS = 50

const watermarkControlSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('pause') }).strict(),
  z.object({ action: z.literal('resume') }).strict(),
  z.object({
    action: z.literal('rewind'),
    cursorTime: z.string().trim().min(1, '回拨时间不能为空'),
  }).strict(),
])

export type WatermarkControlRequest = z.infer<typeof watermarkControlSchema>

/** Optional notification sink when `log:<appId>` circuit breaker trips. */
export type LogThrottleNotifier = (input: {
  readonly appId: string
  readonly appName?: string
  readonly chatId?: string
  readonly text: string
}) => Promise<void>

/** Dependencies injected into {@link LogSupervisor}. */
export interface LogSupervisorDeps {
  readonly watermarks: DomainTable<WatermarkRecord>
  readonly pendingBatches: DomainTable<PendingBatchRecord>
  readonly logTasks: DomainTable<LogTaskRecord>
  readonly outbox: DomainTable<OutboxPlatformRecord>
  readonly issues: IssuesTable
  readonly issueMemory: IssueMemory
  readonly breakers: CircuitBreakerRegistry
  readonly logPool: TaskPool
  readonly platform: PlatformClient
  readonly registry: RepoRegistry
  readonly repos: ReposClient
  readonly workspacesRoot: string
  readonly sessionDriver: LogSessionDriver
  readonly getSettings: () => LogSupervisionSettings
  readonly getPlatformSettings: () => PlatformSettings
  readonly getDownloadSettings: () => DownloadSettings
  readonly getUploadSettings: () => UploadSettings
  readonly getTopics: () => FeishuTopicService | undefined
  readonly getActions: () => FeishuActionsService | undefined
  readonly registerSelfMr?: (input: RegisterSelfMrInput) => Promise<void>
  readonly notifyThrottle?: LogThrottleNotifier
  readonly fetch?: typeof fetch
  readonly now?: () => number
  readonly logger?: HostLogger
  readonly autoPollTimer?: boolean
}

function normalizeComponentKey(value: string): string {
  return value.normalize('NFKC').trim().toLowerCase()
}

function normalizeOptional(value: string | null | undefined): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

function batchKeyFor(
  productCode: string | undefined,
  componentCode: string,
  errorCode: string | undefined,
): string {
  const p = encodeURIComponent(productCode ?? '<none>')
  const c = encodeURIComponent(normalizeComponentKey(componentCode))
  const e = encodeURIComponent(errorCode ?? '<none>')
  return `${p}|${c}|${e}`
}

function extractBreakerAppId(storageKey: string): string | undefined {
  return storageKey.startsWith('log:') ? storageKey.slice(4) : undefined
}

function platformLogDetailUrl(baseUrl: string | undefined, logId: string): string | undefined {
  if (baseUrl === undefined || baseUrl.trim() === '') return undefined
  try {
    return new URL(`/logs/${encodeURIComponent(logId)}`, `${baseUrl.replace(/\/*$/u, '')}/`).href
  } catch {
    return undefined
  }
}

function logTopicKey(taskId: string): string {
  return `log-task:${taskId}`
}

function throttleTopicKey(appId: string, bucketMs: number): string {
  return `log-throttle:${appSlugOf(appId)}:${bucketMs}`
}

function permanentOutboxError(message: string): Error {
  const err = new Error(message) as Error & { permanent: boolean }
  err.permanent = true
  return err
}

interface ScheduledBatchTimer {
  readonly timer: ReturnType<typeof setTimeout>
  readonly targetAt: number
}

/**
 * Stateful log-platform supervisor coordinating incremental polling, windowed batching,
 * headless/topic diagnosis execution, `OutboxRunner` report upload, and `feishuActions` cards.
 */
export class LogSupervisor {
  private readonly now: () => number
  private readonly autoPollTimer: boolean
  private readonly outboxRunner: OutboxRunner

  private pollTimer: ReturnType<typeof setTimeout> | undefined
  private pollInFlight: Promise<void> | undefined
  private readonly batchTimers = new Map<string, ScheduledBatchTimer>()
  private readonly batchLocks = new Map<string, Promise<unknown>>()
  private readonly taskLocks = new Map<string, Promise<unknown>>()
  private readonly backgroundWork = new Set<Promise<unknown>>()
  private readonly activeTaskIds = new Set<string>()
  private readonly sessionToTaskIds = new Map<string, string[]>()
  private readonly launchKeyToTaskId = new Map<string, string>()
  private readonly liveTopicWaiters = new Map<string, Set<() => void>>()
  private readonly topicDeliveryInFlight = new Set<string>()

  private lastConcurrency: number
  private booted = false
  private bootPromise: Promise<void> | undefined
  private closed = false

  constructor(private readonly deps: LogSupervisorDeps) {
    this.now = deps.now ?? Date.now
    this.autoPollTimer = deps.autoPollTimer ?? true
    this.lastConcurrency = deps.getSettings().maxConcurrentBatches

    this.outboxRunner = new OutboxRunner({
      table: deps.outbox,
      now: this.now,
      deliver: (record, signal) => this.deliverOutboxRecord(record, signal),
      onDead: (_key, record) => {
        deps.logger?.warn?.(
          'logalyze: 日志报告回传进入死信（task=%s rev=%d logId=%s）：%s',
          record.taskId,
          record.revision,
          record.logId,
          record.lastError ?? 'unknown',
        )
      },
      onError: (error) => {
        deps.logger?.warn?.('logalyze: OutboxRunner 后台执行异常：%s', messageOf(error))
      },
    })

    for (const [taskId, task] of this.deps.logTasks.entries()) {
      if (task.sessionId !== undefined) this.indexSessionTask(task.sessionId, taskId)
      if (task.feishuLaunchKey !== undefined) this.launchKeyToTaskId.set(task.feishuLaunchKey, taskId)
    }
  }

  /** Restore outbox/task/batch state after process restart and start background pollers. */
  async boot(): Promise<void> {
    if (this.closed || this.booted) return
    if (this.bootPromise !== undefined) return await this.bootPromise
    this.bootPromise = this.runBoot()
    try {
      await this.bootPromise
    } finally {
      this.bootPromise = undefined
    }
  }

  private async runBoot(): Promise<void> {
    if (this.closed || this.booted) return

    this.deps.logPool.setConcurrency(Math.max(1, this.deps.getSettings().maxConcurrentBatches))
    this.lastConcurrency = this.deps.getSettings().maxConcurrentBatches

    await this.outboxRunner.recoverInterrupted()

    // Deduplicate pending_batches against tasks persisted right before a crash in evaluateBatchKey.
    const batchKeys = this.deps.pendingBatches.keys()
    for (const bKey of batchKeys) {
      await this.deduplicatePendingBatch(bKey)
    }

    for (const [taskId, task] of this.deps.logTasks.entries()) {
      if (task.sessionId !== undefined) this.indexSessionTask(task.sessionId, taskId)
      if (task.feishuLaunchKey !== undefined) this.launchKeyToTaskId.set(task.feishuLaunchKey, taskId)

      if (task.status !== 'running') continue

      if (task.source === 'platform') {
        if (task.feishuLaunchKey === undefined && task.revisions.length > 0) {
          const deliveryMode = task.deliveryMode ?? this.deps.getSettings().deliveryMode
          const needsQuietSummary = deliveryMode === 'quiet-until-done'
            && (task.feishuChatId ?? this.deps.getSettings().feishuChatId) !== undefined
          await this.updateTask(taskId, cur => (
            cur.status === 'running'
              ? {
                ...cur,
                status: 'completed',
                lastError: undefined,
                ...(needsQuietSummary ? { pendingTopicDelivery: true } : {}),
                updatedAt: this.now(),
              }
              : cur
          ))
        } else if (!this.closed) {
          this.enqueuePlatformTask(taskId)
        }
        continue
      }

      const reconciled = await this.reconcileRunningTaskOnBoot(taskId, task)
      if (!reconciled && !this.closed) {
        await this.updateTask(taskId, cur => (
          cur.status === 'running'
            ? {
              ...cur,
              status: 'interrupted',
              lastError: cur.lastError ?? 'DSH 重启前本轮日志诊断尚未提交结果',
              updatedAt: this.now(),
            }
            : cur
        ))
      }
    }

    await this.reconcilePendingTopics()

    for (const key of this.deps.pendingBatches.keys()) {
      await this.evaluateBatchKey(key)
    }

    if (this.closed) return
    this.booted = true

    this.outboxRunner.start(OUTBOX_POLL_INTERVAL_MS)
    if (this.autoPollTimer) {
      this.scheduleNextPoll(this.nextPollDelayMs())
    }
  }

  /** Trigger an immediate singleflight incremental log-platform poll cycle. */
  async pollNow(): Promise<void> {
    if (this.closed) return
    if (this.pollInFlight !== undefined) {
      return await this.pollInFlight
    }
    let tracked: Promise<void> | undefined
    tracked = (async (): Promise<void> => {
      try {
        await this.runPollCycle()
      } finally {
        if (this.pollInFlight === tracked) {
          this.pollInFlight = undefined
        }
      }
    })()
    this.pollInFlight = tracked
    return await tracked
  }

  /** React to updated plugin settings or catalog repositories. */
  notifyConfigOrReposChanged(): void {
    if (this.closed || !this.booted) return
    const nextConcurrency = Math.max(1, this.deps.getSettings().maxConcurrentBatches)
    if (nextConcurrency !== this.lastConcurrency) {
      this.lastConcurrency = nextConcurrency
      this.deps.logPool.setConcurrency(nextConcurrency)
    }
    for (const key of this.deps.pendingBatches.keys()) {
      void this.evaluateBatchKey(key).catch((error: unknown) => {
        this.deps.logger?.warn?.('logalyze: 评估待发批次 %s 失败：%s', key, messageOf(error))
      })
    }
    void this.reconcilePendingTopics().catch((error: unknown) => {
      this.deps.logger?.warn?.('logalyze: 补发静默摘要卡片失败：%s', messageOf(error))
    })
    if (this.autoPollTimer) {
      this.scheduleNextPoll(this.nextPollDelayMs())
    }
  }

  /** Deliver deferred quiet-until-done Feishu cards once `feishuTopics` becomes ready. */
  async onTopicsAvailable(): Promise<void> {
    if (this.closed) return
    await this.reconcilePendingTopics()
    const topics = this.deps.getTopics()
    for (const [taskId, task] of this.deps.logTasks.entries()) {
      if (task.feishuLaunchKey !== undefined && task.status === 'running') {
        const reconciled = await this.reconcileTopicLaunchState(taskId, task.feishuLaunchKey)
        if (!reconciled && topics !== undefined && topics.state(task.feishuLaunchKey) === undefined) {
          await this.updateTask(taskId, cur => (
            cur.status === 'running'
              ? {
                ...cur,
                status: 'interrupted',
                lastError: cur.lastError ?? '飞书话题状态已失效（重启或未注册）',
                updatedAt: this.now(),
              }
              : cur
          ))
          this.notifyTopicWaiters(taskId)
        }
      }
    }
  }

  /** Observe `FEISHU_TOPICS_STATUS_EVENT` updates to bind session IDs and post action proposals on completion. */
  onTopicStatusChanged(state: TopicLaunchState): void {
    if (this.closed) return
    const taskId = this.findTaskIdByLaunchKey(state.key)
    if (taskId === undefined) return
    const p = this.applyTopicState(taskId, state).catch((error: unknown) => {
      this.deps.logger?.warn?.('logalyze: 同步日志话题状态失败（%s）：%s', taskId, messageOf(error))
    })
    this.trackBackground(p)
  }

  /** Observe generic host session events (`turn/end`) to trigger action proposals for manual Feishu sessions. */
  onSessionEvent(sessionId: string, eventType: string, _data: unknown): void {
    if (this.closed || eventType !== 'turn/end') return
    const taskIds = this.sessionToTaskIds.get(sessionId)
    if (taskIds === undefined || taskIds.length === 0) return
    const latestTaskId = taskIds[taskIds.length - 1]
    if (latestTaskId === undefined) return
    const task = this.deps.logTasks.get(latestTaskId)
    if (task === undefined || task.source !== 'feishu') return
    const latestRev = task.revisions.at(-1)
    if (latestRev === undefined || latestRev.actionCardKey !== undefined) return
    const p = this.maybeProposeActionsForRevision(latestTaskId, latestRev.revision, sessionId).catch((error: unknown) => {
      this.deps.logger?.warn?.('logalyze: 飞书手动诊断推荐操作卡片发送失败（%s）：%s', latestTaskId, messageOf(error))
    })
    this.trackBackground(p)
  }

  /** Whether `sessionId` currently owns at least one `log_tasks` entry. */
  isLogSession(sessionId: string): boolean {
    const ids = this.sessionToTaskIds.get(sessionId)
    return ids !== undefined && ids.length > 0
  }

  /** Control the platform polling watermark (`pause`, `resume`, `rewind`). */
  async controlWatermark(raw: unknown): Promise<void> {
    const parsed = watermarkControlSchema.safeParse(raw)
    if (!parsed.success) {
      throw new Error(parsed.error.issues[0]?.message ?? '水位线操作参数不合法')
    }
    const current = this.readWatermark()
    const now = this.now()
    if (parsed.data.action === 'pause') {
      await this.deps.watermarks.put(LOG_WATERMARK_KEY, {
        ...current,
        paused: true,
      })
      this.clearPollTimer()
      return
    }
    if (parsed.data.action === 'resume') {
      await this.deps.watermarks.put(LOG_WATERMARK_KEY, {
        ...current,
        paused: false,
        consecutiveFailures: 0,
        lastError: undefined,
      })
      if (this.autoPollTimer) this.scheduleNextPoll(0)
      return
    }
    const parsedMs = Date.parse(parsed.data.cursorTime)
    if (!Number.isFinite(parsedMs)) {
      throw new Error(`回拨时间不是有效的 ISO 时间戳：${parsed.data.cursorTime}`)
    }
    const iso = new Date(parsedMs).toISOString()
    await this.deps.watermarks.put(LOG_WATERMARK_KEY, {
      cursorTime: iso,
      paused: current.paused,
      lastPollAt: current.lastPollAt,
      consecutiveFailures: 0,
      ...(current.paused ? {} : { lastError: undefined }),
    })
    if (this.autoPollTimer && !current.paused && now >= 0) {
      this.scheduleNextPoll(0)
    }
  }

  /** Reset an application throttle breaker (`log:<appId>`) and resume pending batches for that app. */
  async resetBreaker(appId: string): Promise<boolean> {
    const trimmed = appId.trim()
    if (trimmed === '') throw new Error('应用熔断器 key 不能为空')
    const storageKey = trimmed.startsWith('log:') ? trimmed : `log:${trimmed}`
    const existed = await this.deps.breakers.reset(storageKey)
    const targetAppId = extractBreakerAppId(storageKey) ?? trimmed
    for (const [bKey, batch] of this.deps.pendingBatches.entries()) {
      if (batch.appId === targetAppId) {
        await this.evaluateBatchKey(bKey)
      }
    }
    return existed
  }

  /** Retry one dead-letter outbox row by key, or all dead-letter rows when `key` is omitted. */
  async retryOutboxDead(key?: string): Promise<number> {
    if (key !== undefined && key.trim() !== '') {
      const outcome = await this.outboxRunner.retryDead(key.trim())
      if (outcome === 'not-dead') {
        throw new Error(`回传队列中不存在处于死信状态的条目：${key}`)
      }
      await this.outboxRunner.processDue()
      return outcome === 'requeued' ? 1 : 0
    }
    const summary = await this.outboxRunner.retryAllDead()
    if (summary.requeued > 0) {
      await this.outboxRunner.processDue()
    }
    return summary.requeued
  }

  /** Build the panel wire snapshot of `LogSupervisor`. */
  panelState(): LogSupervisionWire {
    const settings = this.deps.getSettings()
    const wm = this.readWatermark()
    const pendingBatches = this.deps.pendingBatches.entries()
      .map(([key, rec]) => ({
        key,
        appId: rec.appId,
        ...(rec.productCode === undefined ? {} : { productCode: rec.productCode }),
        componentCode: rec.componentCode,
        ...(rec.errorCode === undefined ? {} : { errorCode: rec.errorCode }),
        count: rec.logs?.length ?? rec.logIds.length,
        windowOpenedAt: rec.windowOpenedAt,
      }))
      .sort((a, b) => a.windowOpenedAt - b.windowOpenedAt)

    const tasks = this.deps.logTasks.entries()
      .map(([taskId, rec]) => {
        const latestRev = rec.revisions.at(-1)
        return {
          taskId,
          source: rec.source,
          appId: rec.appId,
          ...(rec.appName === undefined ? {} : { appName: rec.appName }),
          ...(rec.errorCode === undefined ? {} : { errorCode: rec.errorCode }),
          status: rec.status,
          inputCount: rec.inputs.length,
          revisionCount: rec.revisions.length,
          ...(latestRev === undefined ? {} : { latestSummary: latestRev.summary }),
          ...(rec.sessionId === undefined ? {} : { sessionId: rec.sessionId }),
          ...(rec.feishuLaunchKey === undefined ? {} : { feishuLaunchKey: rec.feishuLaunchKey }),
          ...(rec.createdAt === undefined ? {} : { createdAt: rec.createdAt }),
          ...(rec.updatedAt === undefined ? {} : { updatedAt: rec.updatedAt }),
        }
      })
      .sort((a, b) => (b.updatedAt ?? b.createdAt ?? 0) - (a.updatedAt ?? a.createdAt ?? 0))
      .slice(0, MAX_PANEL_TASKS)

    let outboxPendingCount = 0
    for (const [, rec] of this.deps.outbox.entries()) {
      if (rec.status === 'pending' || rec.status === 'uploading') {
        outboxPendingCount += 1
      }
    }
    const outboxDead = this.outboxRunner.listDead().map(([key, rec]) => ({
      key,
      taskId: rec.taskId,
      revision: rec.revision,
      logId: rec.logId,
      attempts: rec.attempts,
      ...(rec.lastError === undefined ? {} : { lastError: rec.lastError }),
    }))

    const breakers = this.collectAppBreakers()

    return {
      enabled: settings.enabled,
      running: this.activeTaskIds.size,
      watermark: {
        ...(wm.cursorTime === undefined ? {} : { cursorTime: wm.cursorTime }),
        ...(wm.backfillFrom === undefined ? {} : { backfillFrom: wm.backfillFrom }),
        ...(wm.backfillTo === undefined ? {} : { backfillTo: wm.backfillTo }),
        paused: wm.paused,
        ...(wm.lastPollAt === undefined ? {} : { lastPollAt: wm.lastPollAt }),
        ...(wm.lastError === undefined ? {} : { lastError: wm.lastError }),
        consecutiveFailures: wm.consecutiveFailures,
      },
      pendingBatches,
      tasks,
      outboxPendingCount,
      outboxDead,
      breakers,
    }
  }

  /** Runtime adapter injected into `createLogTools(...)`. */
  toolsRuntime(): LogToolsRuntime {
    return {
      resolveApp: appOrAlias => this.deps.registry.resolve(appOrAlias),
      readyApp: appId => this.deps.registry.readyApp(appId),
      requireRepos: () => this.deps.repos.require(),
      downloadSettings: () => this.deps.getDownloadSettings(),
      uploadSettings: () => this.deps.getUploadSettings(),
      maxUnpackBytes: () => this.deps.getSettings().maxUnpackBytes,
      issueMemory: () => this.deps.issueMemory,
      fetch: this.deps.fetch,
      platformDownload: async (log, dir, fileName, download, signal) => {
        let link
        try {
          link = await this.deps.platform.downloadUrl(log.logId)
        } catch (error) {
          if (error instanceof PlatformError) {
            throw new DownloadError(`日志 ${log.ref}：${error.message}`)
          }
          throw error
        }
        const downloaded = await downloadLog(
          link.url,
          dir,
          fileName,
          download,
          signal,
          this.deps.fetch,
          { admit: admitPlatformUrl, label: `日志 ${log.ref}（${log.fileName}）` },
        )
        return downloaded.path
      },
      resolveTaskForSession: (sessionId, taskId) => this.resolveTaskForSession(sessionId, taskId),
      createFeishuTask: input => this.createFeishuTask(input),
      updateTask: (taskId, updater) => this.updateTask(taskId, updater),
      onRevisionSubmitted: params => this.onRevisionSubmitted(params),
      ...(this.deps.registerSelfMr === undefined ? {} : { registerSelfMr: this.deps.registerSelfMr }),
      logWorkspacesRoot: () => this.deps.workspacesRoot,
      now: () => this.now(),
    }
  }

  /** Gracefully stop polling/timers and wait for outbox & active background tasks. */
  async drainAndClose(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.clearPollTimer()
    for (const entry of this.batchTimers.values()) {
      clearTimeout(entry.timer)
    }
    this.batchTimers.clear()
    for (const taskId of [...this.liveTopicWaiters.keys()]) {
      this.notifyTopicWaiters(taskId)
    }

    await Promise.allSettled([
      this.pollInFlight ?? Promise.resolve(),
      this.outboxRunner.drainAndClose({ abortActive: true }),
      Promise.allSettled([...this.backgroundWork]),
    ])
  }

  // -------------------------------------------------------------------------
  // Polling & Backfill
  // -------------------------------------------------------------------------

  private readWatermark(): WatermarkRecord {
    return this.deps.watermarks.get(LOG_WATERMARK_KEY) ?? {
      paused: false,
      consecutiveFailures: 0,
    }
  }

  private clearPollTimer(): void {
    if (this.pollTimer !== undefined) {
      clearTimeout(this.pollTimer)
      this.pollTimer = undefined
    }
  }

  private nextPollDelayMs(): number {
    const settings = this.deps.getSettings()
    const wm = this.readWatermark()
    if (wm.consecutiveFailures <= 0) return Math.max(0, settings.pollIntervalMs)
    const exp = Math.min(wm.consecutiveFailures, 10)
    return Math.min(settings.pollIntervalMs * (2 ** exp), MAX_POLL_BACKOFF_MS)
  }

  private scheduleNextPoll(delayMs: number): void {
    if (this.closed || !this.autoPollTimer) return
    this.clearPollTimer()
    const settings = this.deps.getSettings()
    const wm = this.readWatermark()
    if (!settings.enabled || wm.paused) return
    const timer = setTimeout(() => {
      this.pollTimer = undefined
      if (this.closed) return
      void this.pollNow().then(
        () => {
          if (!this.closed && this.autoPollTimer) {
            this.scheduleNextPoll(this.nextPollDelayMs())
          }
        },
        () => {
          if (!this.closed && this.autoPollTimer) {
            this.scheduleNextPoll(this.nextPollDelayMs())
          }
        },
      )
    }, Math.max(0, delayMs))
    timer.unref?.()
    this.pollTimer = timer
  }

  private async runPollCycle(): Promise<void> {
    if (this.closed) return
    const settings = this.deps.getSettings()
    if (!settings.enabled) return
    await this.reconcilePendingTopics().catch((error: unknown) => {
      this.deps.logger?.warn?.('logalyze: 轮询前补发静默摘要卡片失败：%s', messageOf(error))
    })
    const wm = this.readWatermark()
    if (wm.paused) return
    if (platformProblem(this.deps.getPlatformSettings()) !== undefined) return

    const currentNow = this.now()
    const resumingBackfill = wm.backfillFrom !== undefined && wm.backfillTo !== undefined
    const fromIso = resumingBackfill
      ? wm.backfillFrom!
      : (wm.cursorTime ?? new Date(currentNow - Math.max(settings.pollIntervalMs, 60_000)).toISOString())
    const toIso = resumingBackfill ? wm.backfillTo! : new Date(currentNow).toISOString()

    const fromMs = Date.parse(fromIso)
    const toMs = Date.parse(toIso)
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs >= toMs) {
      await this.deps.watermarks.put(LOG_WATERMARK_KEY, {
        ...wm,
        lastPollAt: currentNow,
        lastError: undefined,
      })
      return
    }

    let cursor = resumingBackfill ? wm.backfillCursor : undefined
    try {
      for (let pageIndex = 0; pageIndex < MAX_POLL_PAGES; pageIndex += 1) {
        if (this.closed) return
        const page = await this.deps.platform.listLogsPage({
          archivedFrom: fromIso,
          archivedTo: toIso,
          status: 'completed',
          limit: 100,
          ...(cursor === undefined ? {} : { cursor }),
        })

        const eligible = page.items.filter(
          item => item.storage_type === 'fds' && item.status === 'completed',
        )
        if (eligible.length > 0) {
          await this.ingestPolledLogs(eligible)
        }

        const latestWm = this.readWatermark()
        const pageTime = this.now()
        if (page.nextCursor !== undefined && page.nextCursor !== '') {
          // Persist multi-page cursor before querying the next page so crashes never lose progress.
          await this.deps.watermarks.put(LOG_WATERMARK_KEY, {
            ...latestWm,
            backfillFrom: fromIso,
            backfillTo: toIso,
            backfillCursor: page.nextCursor,
            lastPollAt: pageTime,
            consecutiveFailures: 0,
            lastError: undefined,
          })
          cursor = page.nextCursor
        } else {
          await this.deps.watermarks.put(LOG_WATERMARK_KEY, {
            cursorTime: toIso,
            ...(latestWm.cursorId === undefined ? {} : { cursorId: latestWm.cursorId }),
            paused: latestWm.paused,
            lastPollAt: pageTime,
            consecutiveFailures: 0,
          })
          return
        }
      }
      this.deps.logger?.warn?.('logalyze: 单轮日志拉取达到页数上限 %d，将在下周期继续回填', MAX_POLL_PAGES)
    } catch (error) {
      if (this.closed) return
      const latestWm = this.readWatermark()
      const failures = latestWm.consecutiveFailures + 1
      const errMsg = messageOf(error)
      await this.deps.watermarks.put(LOG_WATERMARK_KEY, {
        ...latestWm,
        lastPollAt: this.now(),
        consecutiveFailures: failures,
        lastError: errMsg,
      })
      this.deps.logger?.warn?.('logalyze: 增量拉取平台日志失败（第 %d 次）：%s', failures, errMsg)
    }
  }

  // -------------------------------------------------------------------------
  // App Resolution & Windowed Batch Scheduler
  // -------------------------------------------------------------------------

  private resolveAppByComponent(componentCode: string): ReadyApp | undefined {
    const key = normalizeComponentKey(componentCode)
    if (key === '') return undefined
    const matches: ReadyApp[] = []
    for (const app of this.deps.registry.readyApps()) {
      const idMatch = normalizeComponentKey(app.app.id) === key
      const aliasMatch = app.app.aliases.some(alias => normalizeComponentKey(alias) === key)
      if (idMatch || aliasMatch) {
        matches.push(app)
      }
    }
    if (matches.length === 0) {
      this.deps.logger?.warn?.('logalyze: 收到未知 component_code=%s，已跳过自动入队', componentCode)
      return undefined
    }
    if (matches.length > 1) {
      this.deps.logger?.warn?.(
        'logalyze: component_code=%s 同时匹配多个应用（%s），请通过面板别名消除歧义',
        componentCode,
        matches.map(m => m.app.id).join(', '),
      )
      return undefined
    }
    return matches[0]
  }

  private knownPlatformLogIds(): Set<string> {
    const seen = new Set<string>()
    for (const [, batch] of this.deps.pendingBatches.entries()) {
      for (const id of batch.logIds) seen.add(id.toLowerCase())
    }
    for (const [, task] of this.deps.logTasks.entries()) {
      if (task.source !== 'platform') continue
      for (const input of task.inputs) {
        if (input.logId !== undefined) seen.add(input.logId.toLowerCase())
      }
    }
    return seen
  }

  private async ingestPolledLogs(items: readonly PlatformLog[]): Promise<void> {
    const touchedKeys = new Set<string>()
    const knownIds = this.knownPlatformLogIds()
    const baseUrl = this.deps.getPlatformSettings().baseUrl

    for (const item of items) {
      const logIdLower = item.log_id.toLowerCase()
      if (knownIds.has(logIdLower)) continue

      const componentCode = normalizeOptional(item.component_code)
      if (componentCode === undefined) {
        this.deps.logger?.warn?.('logalyze: 日志 %s 缺少 component_code，已跳过', item.log_id)
        continue
      }
      const app = this.resolveAppByComponent(componentCode)
      if (app === undefined) continue

      const productCode = normalizeOptional(item.product_code)
      const errorCode = normalizeOptional(item.error_code)
      const bKey = batchKeyFor(productCode, componentCode, errorCode)
      const detailUrl = platformLogDetailUrl(baseUrl, item.log_id)

      knownIds.add(logIdLower)
      await this.withBatchLock(bKey, async () => {
        const existing = this.deps.pendingBatches.get(bKey)
        if (existing?.logIds.some(id => id.toLowerCase() === logIdLower)) return

        const input: LogTaskInput = {
          ref: `L${(existing?.logIds.length ?? 0) + 1}`,
          logId: item.log_id,
          ...(item.file_name ? { fileName: item.file_name } : {}),
          ...(detailUrl === undefined ? {} : { detailUrl }),
          ...(productCode === undefined ? {} : { productCode }),
          ...(normalizeOptional(item.product_sn) === undefined ? {} : { productSn: normalizeOptional(item.product_sn) }),
          ...(normalizeOptional(item.sw_version) === undefined ? {} : { swVersion: normalizeOptional(item.sw_version) }),
          componentCode,
          ...(normalizeOptional(item.component_version) === undefined ? {} : { componentVersion: normalizeOptional(item.component_version) }),
          ...(errorCode === undefined ? {} : { errorCode }),
        }

        const nextLogs = [...(existing?.logs ?? []), input]
        const nextLogIds = [...(existing?.logIds ?? []), item.log_id]
        const nextBatch: PendingBatchRecord = {
          ...(productCode === undefined ? {} : { productCode }),
          componentCode,
          ...(errorCode === undefined ? {} : { errorCode }),
          appId: app.app.id,
          logIds: nextLogIds,
          logs: nextLogs,
          // Anchor windowOpenedAt at first arrival in this batch so subsequent arrivals never reset it.
          windowOpenedAt: existing?.windowOpenedAt ?? this.now(),
        }
        await this.deps.pendingBatches.put(bKey, nextBatch)
      })
      touchedKeys.add(bKey)
    }

    for (const bKey of touchedKeys) {
      await this.evaluateBatchKey(bKey)
    }
  }

  private clearBatchTimer(bKey: string): void {
    const existing = this.batchTimers.get(bKey)
    if (existing !== undefined) {
      clearTimeout(existing.timer)
      this.batchTimers.delete(bKey)
    }
  }

  private armBatchTimer(bKey: string, targetAt: number): void {
    if (this.closed) return
    const existing = this.batchTimers.get(bKey)
    if (existing !== undefined && existing.targetAt === targetAt) return
    this.clearBatchTimer(bKey)
    const delayMs = Math.max(0, targetAt - this.now())
    const timer = setTimeout(() => {
      this.batchTimers.delete(bKey)
      if (this.closed) return
      void this.evaluateBatchKey(bKey).catch((error: unknown) => {
        this.deps.logger?.warn?.('logalyze: 批次窗口定时发车失败（%s）：%s', bKey, messageOf(error))
      })
    }, delayMs)
    timer.unref?.()
    this.batchTimers.set(bKey, { timer, targetAt })
  }

  private async evaluateBatchKey(bKey: string): Promise<void> {
    if (this.closed) return
    await this.withBatchLock(bKey, async () => {
      const settings = this.deps.getSettings()
      if (!settings.enabled || this.closed) {
        this.clearBatchTimer(bKey)
        return
      }

      while (!this.closed) {
        const batch = this.deps.pendingBatches.get(bKey)
        if (batch === undefined) {
          this.clearBatchTimer(bKey)
          return
        }

        const currentInputs = this.materializeBatchInputs(batch)
        const count = currentInputs.length
        if (count === 0) {
          await this.deps.pendingBatches.delete(bKey)
          this.clearBatchTimer(bKey)
          return
        }

        const threshold = Math.max(1, settings.batchSizeThreshold)
        const maxSlice = Math.max(1, settings.maxBatchSize)
        const windowDueAt = batch.windowOpenedAt + Math.max(0, settings.batchWindowMs)
        const due = count >= threshold || this.now() >= windowDueAt
        if (!due) {
          const check = await this.deps.breakers.canProceed(`log:${batch.appId}`)
          if (check.allowed) {
            this.armBatchTimer(bKey, windowDueAt)
          } else {
            this.clearBatchTimer(bKey)
          }
          return
        }

        const preCheck = await this.deps.breakers.canProceed(`log:${batch.appId}`)
        if (!preCheck.allowed) {
          this.clearBatchTimer(bKey)
          return
        }

        const sliceCount = Math.min(count, maxSlice)
        const slice = currentInputs.slice(0, sliceCount)
        const remainder = currentInputs.slice(sliceCount)

        // Prepare workspace and allocate taskId before recording breaker or mutating pending_batches.
        const now = this.now()
        const taskId = `log-${now}-${randomBytes(4).toString('hex')}`
        const workDir = join(this.deps.workspacesRoot, taskId)
        await mkdir(workDir, { recursive: true })

        const decision = await this.deps.breakers.record(`log:${batch.appId}`, {
          reason: `应用 ${batch.appId} 1 小时内发车超过上限`,
        })
        if (!decision.allowed) {
          this.clearBatchTimer(bKey)
          if (decision.newlyTripped) {
            const p = this.notifyThrottle(batch.appId, decision.status.triggeredCount, decision.status.limit, decision.status.reason)
            this.trackBackground(p)
          }
          return
        }

        // Persist the recoverable task record BEFORE trimming/deleting pending_batches so a crash
        // between writes never strands logs outside both tables.
        await this.persistDispatchedSlice(taskId, workDir, now, bKey, batch, slice)

        if (remainder.length === 0) {
          await this.deps.pendingBatches.delete(bKey)
          this.clearBatchTimer(bKey)
        } else {
          await this.deps.pendingBatches.put(bKey, {
            ...batch,
            logIds: remainder.map((item, idx) => item.logId ?? batch.logIds[sliceCount + idx] ?? `log-${idx}`),
            logs: remainder.map((item, idx) => ({ ...item, ref: `L${idx + 1}` })),
            windowOpenedAt: this.now(),
          })
        }

        this.enqueuePlatformTask(taskId)
      }
    })
  }

  private async deduplicatePendingBatch(bKey: string): Promise<void> {
    await this.withBatchLock(bKey, async () => {
      const batch = this.deps.pendingBatches.get(bKey)
      if (batch === undefined) return

      const persistedLogIds = new Set<string>()
      for (const [, task] of this.deps.logTasks.entries()) {
        if (task.source !== 'platform') continue
        if (task.batchKey !== undefined && task.batchKey !== bKey) continue
        if ((task.createdAt ?? 0) < batch.windowOpenedAt) continue
        for (const input of task.inputs) {
          if (input.logId !== undefined) {
            persistedLogIds.add(input.logId)
          }
        }
      }
      if (persistedLogIds.size === 0) return

      const currentInputs = this.materializeBatchInputs(batch)
      const remainingInputs = currentInputs.filter((item, idx) => {
        const lid = item.logId ?? batch.logIds[idx]
        return lid === undefined || !persistedLogIds.has(lid)
      })
      if (remainingInputs.length === currentInputs.length) return

      if (remainingInputs.length === 0) {
        await this.deps.pendingBatches.delete(bKey)
        this.clearBatchTimer(bKey)
        return
      }

      await this.deps.pendingBatches.put(bKey, {
        ...batch,
        logIds: remainingInputs.map((item, idx) => item.logId ?? `log-${idx}`),
        logs: remainingInputs.map((item, idx) => ({ ...item, ref: `L${idx + 1}` })),
      })
    })
  }

  private materializeBatchInputs(batch: PendingBatchRecord): LogTaskInput[] {
    if (batch.logs !== undefined && batch.logs.length > 0) {
      return [...batch.logs]
    }
    const baseUrl = this.deps.getPlatformSettings().baseUrl
    return batch.logIds.map((logId, idx) => ({
      ref: `L${idx + 1}`,
      logId,
      ...(platformLogDetailUrl(baseUrl, logId) === undefined ? {} : { detailUrl: platformLogDetailUrl(baseUrl, logId) }),
      ...(batch.productCode === undefined ? {} : { productCode: batch.productCode }),
      componentCode: batch.componentCode,
      ...(batch.errorCode === undefined ? {} : { errorCode: batch.errorCode }),
    }))
  }

  private async persistDispatchedSlice(
    taskId: string,
    workDir: string,
    now: number,
    batchKey: string,
    batch: PendingBatchRecord,
    rawSlice: readonly LogTaskInput[],
  ): Promise<void> {
    const app = this.findReadyOrName(batch.appId)
    const settings = this.deps.getSettings()
    const deliveryMode = settings.deliveryMode
    const feishuChatId = settings.feishuChatId
    const inputs: LogTaskInput[] = rawSlice.map((item, idx) => ({
      ...item,
      ref: `L${idx + 1}`,
    }))

    const record: LogTaskRecord = {
      source: 'platform',
      appId: batch.appId,
      appName: app?.app.name ?? batch.appId,
      batchKey,
      ...(batch.errorCode === undefined ? {} : { errorCode: batch.errorCode }),
      workDir,
      deliveryMode,
      ...(feishuChatId === undefined ? {} : { feishuChatId }),
      inputs,
      status: 'running',
      revisions: [],
      createdAt: now,
      updatedAt: now,
    }
    await this.deps.logTasks.put(taskId, record)
  }

  private enqueuePlatformTask(taskId: string): void {
    if (this.closed) return
    const runPromise = this.deps.logPool.run(async (signal) => {
      if (this.closed || signal.aborted) return
      this.activeTaskIds.add(taskId)
      try {
        await this.executePlatformTask(taskId, signal)
      } finally {
        this.activeTaskIds.delete(taskId)
      }
    }).catch((error: unknown) => {
      if (!this.closed) {
        this.deps.logger?.warn?.('logalyze: 平台日志批次任务执行异常（%s）：%s', taskId, messageOf(error))
      }
    })
    this.trackBackground(runPromise)
  }

  private findReadyOrName(appId: string): ReadyApp | undefined {
    try {
      return this.deps.registry.readyApp(appId)
    } catch {
      return undefined
    }
  }

  private async executePlatformTask(taskId: string, signal: AbortSignal): Promise<void> {
    const task = this.deps.logTasks.get(taskId)
    if (task === undefined || task.status !== 'running' || this.closed || signal.aborted) return

    const mode = task.deliveryMode ?? this.deps.getSettings().deliveryMode
    const topics = this.deps.getTopics()
    const chatId = task.feishuChatId ?? this.deps.getSettings().feishuChatId

    if (task.feishuLaunchKey !== undefined) {
      if (topics === undefined) {
        await this.waitForTopicTerminal(taskId, signal)
        return
      }
      if (chatId !== undefined) {
        await this.runLiveTopicBatch(taskId, task, chatId, topics, signal)
        return
      }
    }

    if (mode === 'topic-on-start' && topics !== undefined && chatId !== undefined) {
      await this.runLiveTopicBatch(taskId, task, chatId, topics, signal)
      return
    }

    await this.runHeadlessBatch(taskId, signal)
  }

  private async runLiveTopicBatch(
    taskId: string,
    task: LogTaskRecord,
    chatId: string,
    topics: FeishuTopicService,
    signal: AbortSignal,
  ): Promise<void> {
    const launchKey = task.feishuLaunchKey ?? logTopicKey(taskId)
    this.launchKeyToTaskId.set(launchKey, taskId)

    if (task.feishuLaunchKey !== undefined) {
      const existingState = topics.state(launchKey)
      if (existingState !== undefined) {
        await this.applyTopicState(taskId, existingState)
        if (this.deps.logTasks.get(taskId)?.status !== 'running') {
          return
        }
        if (existingState.status === 'running') {
          await this.waitForTopicTerminal(taskId, signal)
          return
        }
      }
    }

    await this.updateTask(taskId, cur => ({
      ...cur,
      feishuLaunchKey: launchKey,
      feishuChatId: chatId,
      updatedAt: this.now(),
    }))

    const prompt = buildPlatformDiagnosisPrompt({
      taskId,
      appId: task.appId,
      appName: task.appName ?? task.appId,
      ...(task.errorCode === undefined ? {} : { errorCode: task.errorCode }),
      inputs: task.inputs,
      mode: 'topic-on-start',
      headless: false,
    })

    const spec = buildLogTopicLaunchSpec({
      launchKey,
      fingerprint: launchKey,
      chatId,
      task,
      taskId,
      prompt,
      phase: 'starting',
    })

    let res: Awaited<ReturnType<FeishuTopicService['launch']>>
    try {
      res = await topics.launch(spec)
    } catch (error) {
      await this.updateTask(taskId, cur => ({
        ...cur,
        status: 'failed',
        lastError: `发起飞书话题异常：${messageOf(error)}`,
        updatedAt: this.now(),
      }))
      this.notifyTopicWaiters(taskId)
      return
    }

    if (!res.ok) {
      await this.updateTask(taskId, cur => ({
        ...cur,
        status: 'failed',
        lastError: `发起飞书话题失败（${res.code}）：${res.message}`,
        updatedAt: this.now(),
      }))
      this.notifyTopicWaiters(taskId)
      return
    }

    const currentState = topics.state(launchKey)
    if (currentState !== undefined) {
      await this.applyTopicState(taskId, currentState)
    }

    while (!this.closed && !signal.aborted && this.deps.logTasks.get(taskId)?.status === 'running') {
      await this.waitForTopicTerminal(taskId, signal)
    }
  }

  private notifyTopicWaiters(taskId: string): void {
    const waiters = this.liveTopicWaiters.get(taskId)
    if (waiters === undefined) return
    this.liveTopicWaiters.delete(taskId)
    for (const wake of waiters) {
      wake()
    }
  }

  private waitForTopicTerminal(taskId: string, signal: AbortSignal): Promise<void> {
    if (this.closed || signal.aborted || this.deps.logTasks.get(taskId)?.status !== 'running') {
      return Promise.resolve()
    }
    return new Promise((resolve) => {
      let settled = false
      const finish = (): void => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', finish)
        const set = this.liveTopicWaiters.get(taskId)
        set?.delete(finish)
        if (set !== undefined && set.size === 0) {
          this.liveTopicWaiters.delete(taskId)
        }
        resolve()
      }
      let set = this.liveTopicWaiters.get(taskId)
      if (set === undefined) {
        set = new Set()
        this.liveTopicWaiters.set(taskId, set)
      }
      set.add(finish)
      signal.addEventListener('abort', finish, { once: true })
    })
  }

  private async runHeadlessBatch(taskId: string, signal: AbortSignal): Promise<void> {
    const initial = this.deps.logTasks.get(taskId)
    if (initial === undefined || this.closed) return

    const workDir = initial.workDir ?? join(this.deps.workspacesRoot, taskId)
    await mkdir(workDir, { recursive: true })

    const mode = initial.deliveryMode ?? this.deps.getSettings().deliveryMode
    const prompt = buildPlatformDiagnosisPrompt({
      taskId,
      appId: initial.appId,
      appName: initial.appName ?? initial.appId,
      ...(initial.errorCode === undefined ? {} : { errorCode: initial.errorCode }),
      inputs: initial.inputs,
      mode,
      headless: true,
    })

    const turnResult = await this.deps.sessionDriver.runTurn({
      taskId,
      appId: initial.appId,
      existingSessionId: initial.sessionId,
      workDir,
      prompt,
      signal,
      onSessionBound: async (sid) => {
        this.indexSessionTask(sid, taskId)
        await this.updateTask(taskId, cur => ({
          ...cur,
          sessionId: cur.sessionId ?? sid,
          updatedAt: this.now(),
        }))
      },
    })

    this.indexSessionTask(turnResult.sessionId, taskId)

    const latest = await this.updateTask(taskId, (cur) => {
      if (turnResult.error !== undefined) {
        if (signal.aborted || this.closed) {
          if (cur.revisions.length > 0) {
            const quietNeedsCard = (cur.deliveryMode ?? mode) === 'quiet-until-done'
              && cur.feishuLaunchKey === undefined
              && (cur.feishuChatId ?? this.deps.getSettings().feishuChatId) !== undefined
            return {
              ...cur,
              sessionId: cur.sessionId ?? turnResult.sessionId,
              status: 'completed',
              lastError: undefined,
              ...(quietNeedsCard ? { pendingTopicDelivery: true } : {}),
              updatedAt: this.now(),
            }
          }
          return {
            ...cur,
            sessionId: cur.sessionId ?? turnResult.sessionId,
            status: 'running',
            lastError: turnResult.error,
            updatedAt: this.now(),
          }
        }
        return {
          ...cur,
          sessionId: cur.sessionId ?? turnResult.sessionId,
          status: 'failed',
          lastError: turnResult.error,
          updatedAt: this.now(),
        }
      }
      if (cur.revisions.length === 0) {
        return {
          ...cur,
          sessionId: cur.sessionId ?? turnResult.sessionId,
          status: 'failed',
          lastError: '无头诊断回合完成但未调用 supervisor_log_submit 提交结论',
          updatedAt: this.now(),
        }
      }
      return {
        ...cur,
        sessionId: cur.sessionId ?? turnResult.sessionId,
        status: 'completed',
        lastError: undefined,
        updatedAt: this.now(),
      }
    })

    if (latest.status !== 'completed') return

    const latestRev = latest.revisions.at(-1)
    if (latestRev === undefined) return

    // Process due outbox entries promptly so platform report URLs can be embedded in the Feishu summary card.
    await this.outboxRunner.processDue().catch(() => undefined)
    const reportUrls = this.collectRevisionReportUrls(taskId, latestRev.revision)

    const deliveryMode = latest.deliveryMode ?? mode
    const chatId = latest.feishuChatId ?? this.deps.getSettings().feishuChatId
    if (deliveryMode === 'quiet-until-done' && chatId !== undefined) {
      await this.deliverQuietDoneSummaryTopic(taskId, latestRev, reportUrls)
    }
  }

  private async deliverQuietDoneSummaryTopic(
    taskId: string,
    revision: LogTaskRevision,
    reportUrls: Readonly<Record<string, string>>,
  ): Promise<void> {
    if (this.closed || this.topicDeliveryInFlight.has(taskId)) return
    const task = this.deps.logTasks.get(taskId)
    if (task === undefined) return
    if (task.feishuLaunchKey !== undefined && !task.pendingTopicDelivery) return
    const chatId = task.feishuChatId ?? this.deps.getSettings().feishuChatId
    if (chatId === undefined) return

    const topics = this.deps.getTopics()
    if (topics === undefined) {
      await this.updateTask(taskId, cur => ({
        ...cur,
        feishuChatId: cur.feishuChatId ?? chatId,
        pendingTopicDelivery: true,
        updatedAt: this.now(),
      }))
      return
    }

    this.topicDeliveryInFlight.add(taskId)
    const launchKey = task.feishuLaunchKey ?? logTopicKey(taskId)
    try {
      await this.updateTask(taskId, cur => ({
        ...cur,
        feishuChatId: cur.feishuChatId ?? chatId,
        pendingTopicDelivery: true,
        updatedAt: this.now(),
      }))

      this.launchKeyToTaskId.set(launchKey, taskId)

      const prompt = buildQuietDoneTopicPrompt({
        task,
        taskId,
        revision,
        reportUrls,
      })
      const spec = buildLogTopicLaunchSpec({
        launchKey,
        fingerprint: `${launchKey}:rev${revision.revision}`,
        chatId,
        task,
        taskId,
        prompt,
        reportUrls,
        phase: 'completed',
      })

      let launched: Awaited<ReturnType<FeishuTopicService['launch']>>
      try {
        launched = await topics.launch(spec)
      } catch (error) {
        if (task.feishuLaunchKey === undefined) {
          this.launchKeyToTaskId.delete(launchKey)
        }
        this.deps.logger?.warn?.('logalyze: 投递静默完成飞书卡片异常（%s）：%s', taskId, messageOf(error))
        return
      }

      if (!launched.ok) {
        if (task.feishuLaunchKey === undefined) {
          this.launchKeyToTaskId.delete(launchKey)
        }
        this.deps.logger?.warn?.('logalyze: 投递静默完成飞书卡片失败（%s）：%s', taskId, launched.message)
        return
      }

      await this.updateTask(taskId, cur => ({
        ...cur,
        feishuLaunchKey: launchKey,
        feishuChatId: chatId,
        pendingTopicDelivery: undefined,
        updatedAt: this.now(),
      }))

      const state = topics.state(launchKey)
      if (state !== undefined) {
        await this.applyTopicState(taskId, state)
      }
      if (Object.keys(reportUrls).length > 0) {
        await this.updateTopicLinksForTask(taskId, reportUrls)
      }
    } finally {
      this.topicDeliveryInFlight.delete(taskId)
    }
  }

  private async applyTopicState(taskId: string, state: TopicLaunchState): Promise<void> {
    const task = this.deps.logTasks.get(taskId)
    if (task === undefined) return

    if (state.sessionId !== undefined) {
      this.indexSessionTask(state.sessionId, taskId)
    }

    const updated = await this.updateTask(taskId, (cur) => {
      const nextSessionId = state.sessionId ?? cur.sessionId
      const nextWorkDir = state.workDir ?? cur.workDir
      let nextStatus = cur.status
      let nextError = cur.lastError
      if (cur.status === 'running') {
        if (state.status === 'done') {
          if (cur.revisions.length > 0) {
            nextStatus = 'completed'
            nextError = undefined
          } else {
            nextStatus = 'failed'
            nextError = '飞书诊断话题结束但未提交结论'
          }
        } else if (state.status === 'failed' || state.status === 'error') {
          nextStatus = 'failed'
          nextError = state.reason ?? `飞书话题状态：${state.status}`
        } else if (state.status === 'stopped' || state.status === 'interrupted') {
          nextStatus = 'interrupted'
          nextError = `飞书话题状态：${state.status}`
        }
      }
      return {
        ...cur,
        ...(nextSessionId === undefined ? {} : { sessionId: nextSessionId }),
        ...(nextWorkDir === undefined ? {} : { workDir: nextWorkDir }),
        status: nextStatus,
        ...(nextError === undefined ? { lastError: undefined } : { lastError: nextError }),
        updatedAt: this.now(),
      }
    })

    if (state.status === 'done' && state.sessionId !== undefined) {
      const latestRev = updated.revisions.at(-1)
      if (latestRev !== undefined && latestRev.actionCardKey === undefined) {
        await this.maybeProposeActionsForRevision(taskId, latestRev.revision, state.sessionId)
      }
    }

    if (
      updated.status !== 'running'
      || state.status === 'done'
      || state.status === 'failed'
      || state.status === 'error'
      || state.status === 'stopped'
      || state.status === 'interrupted'
    ) {
      this.notifyTopicWaiters(taskId)
    }
  }

  private async maybeProposeActionsForRevision(
    taskId: string,
    revisionNumber: number,
    sessionId: string,
  ): Promise<void> {
    const actionsService = this.deps.getActions()
    if (actionsService === undefined) return
    const task = this.deps.logTasks.get(taskId)
    if (task === undefined) return
    const revision = task.revisions.find(r => r.revision === revisionNumber)
    if (revision === undefined || revision.actionCardKey !== undefined) return

    const app = this.findReadyOrName(task.appId)
    if (app === undefined) return

    const actions = buildDefaultActionsForRevision({
      taskId,
      appId: task.appId,
      appName: app.app.name,
      repoUrl: app.url,
      baseCommit: app.commit,
      writable: app.writable,
      revision,
    })
    if (actions.length === 0) return

    const cardKey = `log-act:${taskId}:rev${revision.revision}`
    const posted = await actionsService.propose({
      key: cardKey,
      sessionId,
      prompt: '已完成异常日志诊断，请选择后续动作（或忽略/追问）：',
      actions,
    })
    if (!posted.ok) {
      this.deps.logger?.warn?.('logalyze: 投递动作按钮卡片失败（%s）：%s', cardKey, posted.message)
      return
    }

    await this.updateTask(taskId, cur => ({
      ...cur,
      revisions: cur.revisions.map(r => (
        r.revision === revisionNumber ? { ...r, actionCardKey: cardKey } : r
      )),
      updatedAt: this.now(),
    }))
  }

  private async notifyThrottle(
    appId: string,
    triggeredCount: number,
    limit: number,
    reason?: string,
  ): Promise<void> {
    const app = this.findReadyOrName(appId)
    const appName = app?.app.name ?? appId
    const chatId = this.deps.getSettings().feishuChatId
    const text = `观象日志监管限流告警：应用 ${appName} (${appId}) 1 小时内批次数达到 ${triggeredCount}/${limit}，已触发自动熔断（${reason ?? '保护配额'}），其余应用不受影响；可在「日志监管」面板确认后一键解除。`

    if (this.deps.notifyThrottle !== undefined) {
      await this.deps.notifyThrottle({ appId, appName, ...(chatId === undefined ? {} : { chatId }), text }).catch((error: unknown) => {
        this.deps.logger?.warn?.('logalyze: 限流告警回调失败：%s', messageOf(error))
      })
    }

    const topics = this.deps.getTopics()
    if (topics !== undefined && chatId !== undefined) {
      const bucket = Math.floor(this.now() / (60 * 60_000))
      const key = throttleTopicKey(appId, bucket)
      await topics.launch({
        key,
        fingerprint: key,
        chatId,
        requester: { kind: 'external', label: '观象熔断保护' },
        card: {
          title: `观象限流告警：${appName}`,
          taskName: '告警',
          lead: [{ text }],
        },
        prompt: `${text}\n\n请向值班成员简要同步该熔断状态，等待人工在 Web 面板确认后解除；不要自行重试拉取或重复建卡。`,
      }).catch((error: unknown) => {
        this.deps.logger?.warn?.('logalyze: 飞书限流告警卡片发送失败：%s', messageOf(error))
      })
    }
  }

  // -------------------------------------------------------------------------
  // Outbox Delivery & Link Refresh
  // -------------------------------------------------------------------------

  private async onRevisionSubmitted(params: {
    readonly taskId: string
    readonly task: LogTaskRecord
    readonly revision: LogTaskRevision
    readonly app: ReadyApp
  }): Promise<{ readonly enqueuedOutboxKeys: readonly string[]; readonly detailUrlBackfilled: boolean }> {
    const enqueuedKeys: string[] = []

    const priorRevision = params.task.revisions
      .filter(r => r.revision < params.revision.revision && r.actionCardKey !== undefined)
      .at(-1)
    if (priorRevision?.actionCardKey !== undefined) {
      const actions = this.deps.getActions()
      if (actions !== undefined) {
        await actions.supersede(priorRevision.actionCardKey, `已更新至修订 rev ${params.revision.revision}`).catch(() => undefined)
      }
    }

    if (params.task.source === 'platform') {
      for (const input of params.task.inputs) {
        if (input.logId === undefined) continue
        const outcome = await this.outboxRunner.enqueue({
          taskId: params.taskId,
          revision: params.revision.revision,
          logId: input.logId,
        })
        if (outcome.status !== 'superseded') {
          enqueuedKeys.push(outcome.key)
        }
      }
      if (enqueuedKeys.length > 0) {
        const kick = this.outboxRunner.processDue().catch((error: unknown) => {
          this.deps.logger?.warn?.('logalyze: 触发 OutboxRunner 回传失败：%s', messageOf(error))
        })
        this.trackBackground(kick)
      }
    }

    if (params.task.source === 'platform' && params.task.feishuLaunchKey !== undefined && params.task.sessionId !== undefined) {
      const state = this.deps.getTopics()?.state(params.task.feishuLaunchKey)
      if (state?.status === 'done') {
        const kickActions = this.maybeProposeActionsForRevision(params.taskId, params.revision.revision, params.task.sessionId)
          .catch(() => undefined)
        this.trackBackground(kickActions)
      }
    }

    return {
      enqueuedOutboxKeys: enqueuedKeys,
      detailUrlBackfilled: enqueuedKeys.length > 0,
    }
  }

  private async deliverOutboxRecord(
    record: OutboxPlatformRecord,
    _signal: AbortSignal,
  ): Promise<{ readonly detailUrl?: string }> {
    const task = this.deps.logTasks.get(record.taskId)
    if (task === undefined) {
      throw permanentOutboxError(`任务 ${record.taskId} 不存在`)
    }
    const revision = task.revisions.find(r => r.revision === record.revision)
    if (revision === undefined) {
      throw permanentOutboxError(`任务 ${record.taskId} 不存在修订 rev ${record.revision}`)
    }
    const input = task.inputs.find(i => i.logId === record.logId)
    if (input === undefined) {
      throw permanentOutboxError(`任务 ${record.taskId} 不包含日志 ${record.logId}`)
    }

    const upload = this.deps.getUploadSettings()
    const revDir = revision.reportDir ?? task.workDir ?? this.deps.workspacesRoot
    const listing = revision.reportDir === undefined
      ? { files: {}, sizes: {}, refused: [], count: 0, bytes: 0 }
      : await listReport(revDir).catch(() => ({ files: {}, sizes: {}, refused: [], count: 0, bytes: 0 }))

    const preliminaryEntry = renderSupervisorLogReport({
      task,
      taskId: record.taskId,
      input,
      revision,
      skipped: [],
    })
    const manifest = buildManifest(listing, upload, Buffer.byteLength(preliminaryEntry, 'utf8'))
    const finalEntry = manifest.skipped.length === 0
      ? preliminaryEntry
      : renderSupervisorLogReport({
        task,
        taskId: record.taskId,
        input,
        revision,
        skipped: manifest.skipped,
      })

    const detailUrl = await uploadRevision(this.deps.platform, {
      logId: record.logId,
      key: outboxPlatformKey(record.taskId, record.revision, record.logId),
      entry: Buffer.from(finalEntry, 'utf8'),
      dir: revDir,
      files: manifest.files,
      timeoutMs: upload.timeoutMs,
      concurrency: upload.concurrency,
    })

    const item = revision.items?.find(candidate => candidate.ref === input.ref)
    if (item?.issueId !== undefined) {
      await this.deps.issues.attachUrlsByAi(item.issueId, {
        sampleReportUrl: detailUrl,
        latestReportUrl: detailUrl,
      })
    }

    await this.updateTopicLinksForTask(record.taskId, { [record.logId]: detailUrl })
    return { detailUrl }
  }

  private collectRevisionReportUrls(taskId: string, revision: number): Record<string, string> {
    const out: Record<string, string> = {}
    for (const [, rec] of this.deps.outbox.entries()) {
      if (rec.taskId === taskId && rec.detailUrl !== undefined) {
        if (rec.revision === revision || out[rec.logId] === undefined) {
          out[rec.logId] = rec.detailUrl
        }
      }
    }
    return out
  }

  private async updateTopicLinksForTask(
    taskId: string,
    extraReportUrls: Readonly<Record<string, string>> = {},
  ): Promise<void> {
    const task = this.deps.logTasks.get(taskId)
    if (task?.feishuLaunchKey === undefined) return
    const topics = this.deps.getTopics()
    if (topics === undefined) return

    const latestRev = task.revisions.at(-1)?.revision ?? 1
    const mergedUrls = {
      ...this.collectRevisionReportUrls(taskId, latestRev),
      ...extraReportUrls,
    }

    const rows: TopicCardLink[] = task.inputs.map((input) => {
      const reportUrl = input.logId === undefined ? undefined : mergedUrls[input.logId]
      return {
        name: `${input.ref} · ${input.fileName ?? input.logId ?? 'log'}`,
        ...(input.detailUrl === undefined ? {} : { url: input.detailUrl }),
        ...(reportUrl === undefined ? {} : { extraUrl: reportUrl }),
      }
    })

    await topics.updateLinks(task.feishuLaunchKey, {
      nameHeader: '日志',
      linkHeader: '日志详情',
      extraLinkHeader: '分析报告',
      rows,
    }).catch((error: unknown) => {
      this.deps.logger?.warn?.('logalyze: 更新飞书报告链接表失败（%s）：%s', taskId, messageOf(error))
    })
  }

  // -------------------------------------------------------------------------
  // Recovery, Session/Task Binding & Helpers
  // -------------------------------------------------------------------------

  private async reconcilePendingTopics(): Promise<void> {
    const topics = this.deps.getTopics()
    if (topics === undefined || this.closed) return
    for (const [taskId, task] of this.deps.logTasks.entries()) {
      if (!task.pendingTopicDelivery || task.status !== 'completed') continue
      const latestRev = task.revisions.at(-1)
      if (latestRev === undefined) continue
      const reportUrls = this.collectRevisionReportUrls(taskId, latestRev.revision)
      await this.deliverQuietDoneSummaryTopic(taskId, latestRev, reportUrls)
    }
  }

  private async reconcileRunningTaskOnBoot(taskId: string, task: LogTaskRecord): Promise<boolean> {
    if (task.feishuLaunchKey === undefined) return false
    return await this.reconcileTopicLaunchState(taskId, task.feishuLaunchKey)
  }

  private async reconcileTopicLaunchState(taskId: string, launchKey: string): Promise<boolean> {
    const topics = this.deps.getTopics()
    if (topics === undefined) return false
    const state = topics.state(launchKey)
    if (state === undefined) return false
    await this.applyTopicState(taskId, state)
    return state.status === 'running'
  }

  private findTaskIdByLaunchKey(launchKey: string): string | undefined {
    const cached = this.launchKeyToTaskId.get(launchKey)
    if (cached !== undefined) return cached
    for (const [taskId, rec] of this.deps.logTasks.entries()) {
      if (rec.feishuLaunchKey === launchKey) {
        this.launchKeyToTaskId.set(launchKey, taskId)
        return taskId
      }
    }
    return undefined
  }

  private resolveTaskForSession(
    sessionId: string,
    explicitTaskId?: string,
  ): { readonly taskId: string; readonly task: LogTaskRecord } | undefined {
    if (explicitTaskId !== undefined) {
      const task = this.deps.logTasks.get(explicitTaskId)
      if (task !== undefined) {
        this.indexSessionTask(sessionId, explicitTaskId)
        return { taskId: explicitTaskId, task }
      }
      return undefined
    }

    const launchKey = this.deps.getTopics()?.launchKeyOf(sessionId)
    if (launchKey !== undefined) {
      const fromLaunch = this.findTaskIdByLaunchKey(launchKey)
      if (fromLaunch !== undefined) {
        const rec = this.deps.logTasks.get(fromLaunch)
        if (rec !== undefined) {
          this.indexSessionTask(sessionId, fromLaunch)
          return { taskId: fromLaunch, task: rec }
        }
      }
    }

    const ids = this.sessionToTaskIds.get(sessionId)
    if (ids !== undefined) {
      for (let i = ids.length - 1; i >= 0; i -= 1) {
        const candidateId = ids[i]!
        const rec = this.deps.logTasks.get(candidateId)
        if (rec !== undefined) return { taskId: candidateId, task: rec }
      }
    }

    let matched: { taskId: string; task: LogTaskRecord } | undefined
    for (const [taskId, rec] of this.deps.logTasks.entries()) {
      if (rec.sessionId !== sessionId) continue
      if (
        matched === undefined
        || (rec.updatedAt ?? rec.createdAt ?? 0) >= (matched.task.updatedAt ?? matched.task.createdAt ?? 0)
      ) {
        matched = { taskId, task: rec }
      }
    }
    if (matched !== undefined) {
      this.indexSessionTask(sessionId, matched.taskId)
    }
    return matched
  }

  private async createFeishuTask(input: {
    readonly sessionId: string
    readonly workDir: string
    readonly app: ReadyApp
    readonly inputs: readonly LogTaskInput[]
  }): Promise<{ readonly taskId: string; readonly task: LogTaskRecord }> {
    const now = this.now()
    const taskId = `feishu-${now}-${randomBytes(4).toString('hex')}`
    const record: LogTaskRecord = {
      source: 'feishu',
      appId: input.app.app.id,
      appName: input.app.app.name,
      sessionId: input.sessionId,
      workDir: input.workDir,
      inputs: [...input.inputs],
      status: 'running',
      revisions: [],
      createdAt: now,
      updatedAt: now,
    }
    await this.deps.logTasks.put(taskId, record)
    this.indexSessionTask(input.sessionId, taskId)
    return { taskId, task: this.deps.logTasks.get(taskId)! }
  }

  private updateTask(taskId: string, updater: (current: LogTaskRecord) => LogTaskRecord): Promise<LogTaskRecord> {
    return this.withTaskLock(taskId, async () => {
      const current = this.deps.logTasks.get(taskId)
      if (current === undefined) {
        throw new Error(`未找到日志监管任务：${taskId}`)
      }
      const next = updater(current)
      await this.deps.logTasks.put(taskId, next)
      if (next.sessionId !== undefined) this.indexSessionTask(next.sessionId, taskId)
      if (next.feishuLaunchKey !== undefined) this.launchKeyToTaskId.set(next.feishuLaunchKey, taskId)
      return this.deps.logTasks.get(taskId)!
    })
  }

  private indexSessionTask(sessionId: string, taskId: string): void {
    const list = this.sessionToTaskIds.get(sessionId) ?? []
    if (!list.includes(taskId)) {
      list.push(taskId)
      this.sessionToTaskIds.set(sessionId, list)
    }
  }

  private collectAppBreakers(): BreakerStatusWire[] {
    const out: BreakerStatusWire[] = []
    const seen = new Set<string>()

    for (const status of this.deps.breakers.listTripped()) {
      const appId = extractBreakerAppId(status.key)
      if (appId === undefined) continue
      seen.add(status.key)
      out.push({
        scope: 'log-app',
        key: appId,
        count: status.triggeredCount,
        limit: status.limit,
        tripped: status.tripped,
        ...(status.reason === undefined ? {} : { reason: status.reason }),
        ...(status.trippedUntil === undefined ? {} : { trippedAt: status.windowStartAt }),
      })
    }

    const appIds = new Set<string>()
    for (const app of this.deps.registry.readyApps()) appIds.add(app.app.id)
    for (const [, batch] of this.deps.pendingBatches.entries()) appIds.add(batch.appId)

    for (const appId of appIds) {
      const storageKey = `log:${appId}`
      if (seen.has(storageKey)) continue
      const st = this.deps.breakers.inspect(storageKey)
      if (st.triggeredCount > 0 || st.tripped) {
        seen.add(storageKey)
        out.push({
          scope: 'log-app',
          key: appId,
          count: st.triggeredCount,
          limit: st.limit,
          tripped: st.tripped,
          ...(st.reason === undefined ? {} : { reason: st.reason }),
          ...(st.trippedUntil === undefined ? {} : { trippedAt: st.windowStartAt }),
        })
      }
    }

    return out
  }

  private trackBackground(promise: Promise<unknown>): void {
    const cleanup = (): void => {
      this.backgroundWork.delete(tracked)
    }
    const tracked = promise.then(cleanup, cleanup)
    this.backgroundWork.add(tracked)
  }

  private withBatchLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.batchLocks.get(key) ?? Promise.resolve()
    const next = prev.then(fn, fn)
    const cleanup = (): void => {
      if (this.batchLocks.get(key) === tracked) {
        this.batchLocks.delete(key)
      }
    }
    const tracked = next.then(() => undefined, () => undefined).then(cleanup, cleanup)
    this.batchLocks.set(key, tracked)
    return next
  }

  private withTaskLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.taskLocks.get(key) ?? Promise.resolve()
    const next = prev.then(fn, fn)
    const cleanup = (): void => {
      if (this.taskLocks.get(key) === tracked) {
        this.taskLocks.delete(key)
      }
    }
    const tracked = next.then(() => undefined, () => undefined).then(cleanup, cleanup)
    this.taskLocks.set(key, tracked)
    return next
  }
}

export { UNLABELED_ERROR_CODE }
