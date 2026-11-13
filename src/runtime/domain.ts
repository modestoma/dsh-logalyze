/**
 * `'dsh_supervisor'` 持久化存储域声明与 7 张核心监管表的强类型封装。
 *
 * 严格对应 `docs/supervisor/04-storage-and-operations.md`：
 * 1. `watermarks`：轮询源水位线与暂停/连续失败计数
 * 2. `pending_batches`：日志分组聚合待发车批次
 * 3. `log_tasks`：日志分析任务主记录与结论修订历史
 * 4. `outbox_platform`：日志平台报告幂等回传队列与修订防倒退校核
 * 5. `issues`：本地已知问题库（通过 {@link IssuesTable} 在类型层与运行层双重隔离 AI 写入与人工结论字段）
 * 6. `supervised_mrs`：受监管的 PR/MR 会话与增量游标状态
 * 7. `circuit_breakers`：单应用/单仓库滑动窗口风暴熔断状态
 *
 * @module dsh-logalyze/runtime/domain
 */

import { z } from 'zod'
import { openStorageDomain, StorageDomainError, typedTable } from './storage.ts'
import type { DomainSpec, DomainTable, OpenStorageDomainOptions, RawDomainHandle } from './storage.ts'

/** Canonical storage domain name for the supervision center. */
export const SUPERVISOR_STORAGE_DOMAIN = 'dsh_supervisor'

/** Current schema version of `'dsh_supervisor'`. */
export const SUPERVISOR_STORAGE_VERSION = 1

// ---------------------------------------------------------------------------
// 1. watermarks
// ---------------------------------------------------------------------------

export const watermarkSchema = z.object({
  cursorTime: z.string().min(1).optional(),
  cursorId: z.string().min(1).optional(),
  backfillFrom: z.string().min(1).optional(),
  backfillTo: z.string().min(1).optional(),
  backfillCursor: z.string().min(1).optional(),
  paused: z.boolean(),
  lastPollAt: z.number().int().nonnegative().optional(),
  lastError: z.string().optional(),
  consecutiveFailures: z.number().int().nonnegative(),
}).strict()

export type WatermarkRecord = z.infer<typeof watermarkSchema>

// ---------------------------------------------------------------------------
// 2. pending_batches
// ---------------------------------------------------------------------------

export const logTaskInputSchema = z.object({
  ref: z.string().min(1),
  logId: z.string().min(1).optional(),
  fileName: z.string().min(1).optional(),
  path: z.string().min(1).optional(),
  url: z.string().min(1).optional(),
  detailUrl: z.string().min(1).optional(),
  productCode: z.string().min(1).optional(),
  productSn: z.string().min(1).optional(),
  swVersion: z.string().min(1).optional(),
  componentCode: z.string().min(1).optional(),
  componentVersion: z.string().min(1).optional(),
  errorCode: z.string().min(1).optional(),
  unpackStatus: z.enum(['ok', 'corrupted']).optional(),
  unpackError: z.string().optional(),
}).strict()

export type LogTaskInput = z.infer<typeof logTaskInputSchema>

export const pendingBatchSchema = z.object({
  productCode: z.string().min(1).optional(),
  componentCode: z.string().min(1),
  errorCode: z.string().min(1).optional(),
  appId: z.string().min(1),
  logIds: z.array(z.string().min(1)).min(1),
  logs: z.array(logTaskInputSchema).optional(),
  windowOpenedAt: z.number().int().nonnegative(),
}).strict()

export type PendingBatchRecord = z.infer<typeof pendingBatchSchema>

// ---------------------------------------------------------------------------
// 3. log_tasks
// ---------------------------------------------------------------------------

export const logEvidenceSchema = z.object({
  source: z.string().min(1),
  locator: z.string().min(1),
  excerpt: z.string().min(1),
}).strict()

export type LogEvidence = z.infer<typeof logEvidenceSchema>

export const logRootCauseCategorySchema = z.enum([
  'code_defect',
  'config_or_env',
  'hardware_or_external',
  'usage_error',
  'unknown',
])

export type LogRootCauseCategory = z.infer<typeof logRootCauseCategorySchema>

export const logItemStatusSchema = z.enum([
  'diagnosed',
  'insufficient_evidence',
  'corrupted_log',
])

export type LogItemStatus = z.infer<typeof logItemStatusSchema>

export const logRevisionItemSchema = z.object({
  ref: z.string().min(1),
  status: logItemStatusSchema,
  rootCauseCategory: logRootCauseCategorySchema,
  conclusion: z.string().min(1),
  evidences: z.array(logEvidenceSchema),
  issueId: z.string().min(1).optional(),
}).strict()

export type LogRevisionItem = z.infer<typeof logRevisionItemSchema>

export const logTaskRevisionSchema = z.object({
  revision: z.number().int().positive(),
  summary: z.string().min(1),
  rootCause: z.string().optional(),
  confidence: z.enum(['high', 'medium', 'low']).optional(),
  issueId: z.string().min(1).optional(),
  evidence: z.array(z.string()).optional(),
  items: z.array(logRevisionItemSchema).optional(),
  attachments: z.array(z.string().min(1)).optional(),
  actionCardKey: z.string().min(1).optional(),
  reportDir: z.string().min(1).optional(),
  createdAt: z.number().int().nonnegative(),
}).strict()

export type LogTaskRevision = z.infer<typeof logTaskRevisionSchema>

export const logTaskStatusSchema = z.enum(['running', 'completed', 'failed', 'interrupted'])
export type LogTaskStatus = z.infer<typeof logTaskStatusSchema>

export const logTaskSchema = z.object({
  source: z.enum(['platform', 'feishu']),
  appId: z.string().min(1),
  appName: z.string().min(1).optional(),
  batchKey: z.string().min(1).optional(),
  errorCode: z.string().min(1).optional(),
  sessionId: z.string().min(1).optional(),
  workDir: z.string().min(1).optional(),
  feishuLaunchKey: z.string().min(1).optional(),
  deliveryMode: z.enum(['quiet-until-done', 'topic-on-start']).optional(),
  feishuChatId: z.string().min(1).optional(),
  pendingTopicDelivery: z.boolean().optional(),
  lastError: z.string().optional(),
  inputs: z.array(logTaskInputSchema),
  status: logTaskStatusSchema,
  revisions: z.array(logTaskRevisionSchema),
  createdAt: z.number().int().nonnegative().optional(),
  updatedAt: z.number().int().nonnegative().optional(),
}).strict()

export type LogTaskRecord = z.infer<typeof logTaskSchema>

// ---------------------------------------------------------------------------
// 4. outbox_platform
// ---------------------------------------------------------------------------

export const outboxStatusSchema = z.enum(['pending', 'uploading', 'done', 'dead'])
export type OutboxStatus = z.infer<typeof outboxStatusSchema>

export const outboxPlatformSchema = z.object({
  taskId: z.string().min(1),
  revision: z.number().int().positive(),
  logId: z.string().min(1),
  status: outboxStatusSchema,
  analysisId: z.string().min(1).optional(),
  detailUrl: z.string().min(1).optional(),
  attempts: z.number().int().nonnegative(),
  nextRetryAt: z.number().int().nonnegative(),
  lastError: z.string().optional(),
}).strict()

export type OutboxPlatformRecord = z.infer<typeof outboxPlatformSchema>

/**
 * Canonical primary key of `outbox_platform`: `'<taskId>:rev<N>:<logId>'`.
 */
export function outboxPlatformKey(taskId: string, revision: number, logId: string): string {
  return `${taskId}:rev${revision}:${logId}`
}

// ---------------------------------------------------------------------------
// 5. issues (with strict AI vs Human write separation)
// ---------------------------------------------------------------------------

export const issueAiStatusSchema = z.enum(['located', 'pending', 'fixed'])
export type IssueAiStatus = z.infer<typeof issueAiStatusSchema>

export const issueSchema = z.object({
  appId: z.string().min(1),
  title: z.string().min(1),
  matchCriteria: z.string().min(1),
  exclusionCriteria: z.string().optional(),
  aiDiagnosis: z.string().min(1),
  aiStatus: issueAiStatusSchema,
  resolutionAdvice: z.string().min(1),
  humanConclusion: z.string().optional(),
  humanStatus: z.string().optional(),
  assignee: z.string().optional(),
  firstSeenAt: z.number().int().nonnegative(),
  lastSeenAt: z.number().int().nonnegative(),
  sampleReportUrl: z.string().min(1).optional(),
  latestReportUrl: z.string().min(1).optional(),
  fixMrUrl: z.string().min(1).optional(),
  bitableRecordId: z.string().min(1).optional(),
  syncDirty: z.boolean(),
}).strict()

export type IssueRecord = z.infer<typeof issueSchema>

/**
 * Compile-time fence prohibiting AI write paths from carrying any human-owned columns.
 */
export interface ForbiddenHumanIssueFields {
  readonly humanConclusion?: never
  readonly humanStatus?: never
  readonly assignee?: never
}

/**
 * Input accepted by {@link IssuesTable.upsertByAi}. Human-owned columns are
 * physically typed as `never` and stripped at run time.
 */
export interface AiIssueUpsertInput extends ForbiddenHumanIssueFields {
  readonly issueId: string
  readonly appId: string
  readonly title: string
  readonly matchCriteria: string
  readonly exclusionCriteria?: string
  readonly aiDiagnosis: string
  readonly aiStatus: IssueAiStatus
  readonly resolutionAdvice: string
  /** Observation timestamp (epoch ms); sets `firstSeenAt` on insert and advances `lastSeenAt`. */
  readonly seenAt?: number
  readonly firstSeenAt?: number
  readonly lastSeenAt?: number
  readonly sampleReportUrl?: string
  readonly latestReportUrl?: string
  readonly fixMrUrl?: string
}

/**
 * Input accepted by {@link IssuesTable.syncHumanFields} (used by Bitable pull / manual review).
 * Pass `null` to clear a human column, `undefined` to keep its existing value.
 */
export interface HumanIssueSyncPatch {
  readonly humanConclusion?: string | null
  readonly humanStatus?: string | null
  readonly assignee?: string | null
  readonly bitableRecordId?: string
  /** Explicit dirty state after sync; defaults to keeping the existing `syncDirty` flag. */
  readonly syncDirty?: boolean
}

function resolveHumanField(patchValue: string | null | undefined, existingValue: string | undefined): string | undefined {
  if (patchValue === null) return undefined
  if (patchValue === undefined) return existingValue
  const trimmed = patchValue.trim()
  return trimmed === '' ? undefined : trimmed
}

/**
 * Safe domain façade over the `issues` table. Raw `put`/`update` are intentionally
 * hidden so every caller must go through {@link upsertByAi} or {@link syncHumanFields}.
 */
export class IssuesTable {
  private readonly locks = new Map<string, Promise<unknown>>()
  private readonly now: () => number
  private closed = false

  constructor(
    private readonly table: DomainTable<IssueRecord>,
    now: () => number = Date.now,
  ) {
    this.now = now
  }

  private rejectClosed(): Promise<never> {
    return Promise.reject(new StorageDomainError('closed', `存储域 "${SUPERVISOR_STORAGE_DOMAIN}" 已关闭`))
  }

  private withKeyLock<T>(issueId: string, fn: () => Promise<T>): Promise<T> {
    if (this.closed) {
      return this.rejectClosed()
    }
    const previous = this.locks.get(issueId) ?? Promise.resolve()
    const next = previous.then(fn, fn)
    const tracked = next.then(() => undefined, () => undefined).finally(() => {
      if (this.locks.get(issueId) === tracked) {
        this.locks.delete(issueId)
      }
    })
    this.locks.set(issueId, tracked)
    return next
  }

  /** Reject subsequent mutations and wait for already-admitted per-key operations to settle. */
  async drainAndClose(): Promise<void> {
    this.closed = true
    while (this.locks.size > 0) {
      await Promise.allSettled([...this.locks.values()])
    }
  }

  get size(): number {
    return this.table.size
  }

  has(issueId: string): boolean {
    return this.table.has(issueId)
  }

  get(issueId: string): IssueRecord | undefined {
    return this.table.get(issueId)
  }

  entries(): [string, IssueRecord][] {
    return this.table.entries()
  }

  values(): IssueRecord[] {
    return this.table.values()
  }

  keys(): string[] {
    return this.table.keys()
  }

  /** List all issues belonging to one application (`appId`). */
  listByApp(appId: string): [string, IssueRecord][] {
    return this.table.entries().filter(([, record]) => record.appId === appId)
  }

  /** List all issues with `syncDirty === true` awaiting Bitable push. */
  listDirty(): [string, IssueRecord][] {
    return this.table.entries().filter(([, record]) => record.syncDirty)
  }

  /**
   * Insert or update AI diagnosis fields for `input.issueId`.
   *
   * Guarantees at BOTH compile time (`ForbiddenHumanIssueFields`) and run time
   * (explicit AI-only destructuring under per-key serialization) that existing
   * `humanConclusion`, `humanStatus`, and `assignee` are never overwritten or cleared.
   */
  upsertByAi(input: AiIssueUpsertInput): Promise<IssueRecord> {
    if (this.closed) {
      return this.rejectClosed()
    }
    const issueId = input.issueId.trim()
    if (issueId === '') {
      return Promise.reject(new TypeError('issues.upsertByAi: issueId 不能为空'))
    }
    return this.withKeyLock(issueId, async () => {
      const existing = this.table.get(issueId)
      if (existing !== undefined && existing.appId !== input.appId) {
        throw new Error(`已知问题 "${issueId}" 已归属应用 "${existing.appId}"，不能被应用 "${input.appId}" 覆盖`)
      }
      const now = this.now()
      const candidateFirstSeen = input.firstSeenAt ?? input.seenAt ?? now
      const candidateLastSeen = input.lastSeenAt ?? input.seenAt ?? now
      const firstSeenAt = existing === undefined
        ? candidateFirstSeen
        : Math.min(existing.firstSeenAt, candidateFirstSeen)
      const lastSeenAt = existing === undefined
        ? Math.max(firstSeenAt, candidateLastSeen)
        : Math.max(existing.lastSeenAt, candidateLastSeen, firstSeenAt)

      const sampleReportUrl = input.sampleReportUrl ?? existing?.sampleReportUrl
      const latestReportUrl = input.latestReportUrl ?? existing?.latestReportUrl
      const fixMrUrl = input.fixMrUrl ?? existing?.fixMrUrl
      const exclusionCriteria = input.exclusionCriteria ?? existing?.exclusionCriteria

      const next: IssueRecord = {
        appId: input.appId,
        title: input.title,
        matchCriteria: input.matchCriteria,
        ...(exclusionCriteria === undefined ? {} : { exclusionCriteria }),
        aiDiagnosis: input.aiDiagnosis,
        aiStatus: input.aiStatus,
        resolutionAdvice: input.resolutionAdvice,
        // Strictly preserve human-owned columns from existing record only!
        ...(existing?.humanConclusion === undefined ? {} : { humanConclusion: existing.humanConclusion }),
        ...(existing?.humanStatus === undefined ? {} : { humanStatus: existing.humanStatus }),
        ...(existing?.assignee === undefined ? {} : { assignee: existing.assignee }),
        firstSeenAt,
        lastSeenAt,
        ...(sampleReportUrl === undefined ? {} : { sampleReportUrl }),
        ...(latestReportUrl === undefined ? {} : { latestReportUrl }),
        ...(fixMrUrl === undefined ? {} : { fixMrUrl }),
        ...(existing?.bitableRecordId === undefined ? {} : { bitableRecordId: existing.bitableRecordId }),
        syncDirty: true,
      }
      await this.table.put(issueId, next)
      return this.table.get(issueId)!
    })
  }

  /**
   * Synchronize human review columns (`humanConclusion`, `humanStatus`, `assignee`)
   * and external `bitableRecordId` on an existing issue without touching AI fields.
   */
  syncHumanFields(issueId: string, patch: HumanIssueSyncPatch): Promise<IssueRecord> {
    if (this.closed) {
      return this.rejectClosed()
    }
    const key = issueId.trim()
    if (key === '') {
      return Promise.reject(new TypeError('issues.syncHumanFields: issueId 不能为空'))
    }
    return this.withKeyLock(key, async () => {
      const existing = this.table.get(key)
      if (existing === undefined) {
        throw new StorageDomainError('missing-key', `表 "issues" 中不存在主键 "${key}"`)
      }
      const humanConclusion = resolveHumanField(patch.humanConclusion, existing.humanConclusion)
      const humanStatus = resolveHumanField(patch.humanStatus, existing.humanStatus)
      const assignee = resolveHumanField(patch.assignee, existing.assignee)
      const bitableRecordId = patch.bitableRecordId ?? existing.bitableRecordId

      const next: IssueRecord = {
        appId: existing.appId,
        title: existing.title,
        matchCriteria: existing.matchCriteria,
        ...(existing.exclusionCriteria === undefined ? {} : { exclusionCriteria: existing.exclusionCriteria }),
        aiDiagnosis: existing.aiDiagnosis,
        aiStatus: existing.aiStatus,
        resolutionAdvice: existing.resolutionAdvice,
        ...(humanConclusion === undefined ? {} : { humanConclusion }),
        ...(humanStatus === undefined ? {} : { humanStatus }),
        ...(assignee === undefined ? {} : { assignee }),
        firstSeenAt: existing.firstSeenAt,
        lastSeenAt: existing.lastSeenAt,
        ...(existing.sampleReportUrl === undefined ? {} : { sampleReportUrl: existing.sampleReportUrl }),
        ...(existing.latestReportUrl === undefined ? {} : { latestReportUrl: existing.latestReportUrl }),
        ...(existing.fixMrUrl === undefined ? {} : { fixMrUrl: existing.fixMrUrl }),
        ...(bitableRecordId === undefined ? {} : { bitableRecordId }),
        syncDirty: patch.syncDirty ?? existing.syncDirty,
      }
      await this.table.put(key, next)
      return this.table.get(key)!
    })
  }

  /** Mark an issue synced with Bitable (setting `syncDirty: false` and optional `bitableRecordId`). */
  markSynced(issueId: string, bitableRecordId?: string): Promise<IssueRecord> {
    return this.syncHumanFields(issueId, {
      ...(bitableRecordId === undefined ? {} : { bitableRecordId }),
      syncDirty: false,
    })
  }

  /**
   * Attach platform report URLs (`sampleReportUrl` when unset, `latestReportUrl` always)
   * or a linked fix MR URL (`fixMrUrl`) to an existing issue without touching AI diagnosis
   * text or any human-owned columns (`humanConclusion`, `humanStatus`, `assignee`).
   */
  attachUrlsByAi(
    issueId: string,
    urls: {
      readonly sampleReportUrl?: string
      readonly latestReportUrl?: string
      readonly fixMrUrl?: string
    },
  ): Promise<IssueRecord | undefined> {
    if (this.closed) {
      return this.rejectClosed()
    }
    const key = issueId.trim()
    if (key === '') {
      return Promise.reject(new TypeError('issues.attachUrlsByAi: issueId 不能为空'))
    }
    return this.withKeyLock(key, async () => {
      const existing = this.table.get(key)
      if (existing === undefined) return undefined
      const sampleReportUrl = existing.sampleReportUrl ?? urls.sampleReportUrl
      const latestReportUrl = urls.latestReportUrl ?? existing.latestReportUrl
      const fixMrUrl = urls.fixMrUrl ?? existing.fixMrUrl
      if (
        sampleReportUrl === existing.sampleReportUrl
        && latestReportUrl === existing.latestReportUrl
        && fixMrUrl === existing.fixMrUrl
      ) {
        return existing
      }
      const next: IssueRecord = {
        ...existing,
        ...(sampleReportUrl === undefined ? {} : { sampleReportUrl }),
        ...(latestReportUrl === undefined ? {} : { latestReportUrl }),
        ...(fixMrUrl === undefined ? {} : { fixMrUrl }),
        syncDirty: true,
      }
      await this.table.put(key, next)
      return this.table.get(key)!
    })
  }

  delete(issueId: string): Promise<boolean> {
    return this.withKeyLock(issueId, () => this.table.delete(issueId))
  }
}

// ---------------------------------------------------------------------------
// 6. supervised_mrs
// ---------------------------------------------------------------------------

export const mrOriginSchema = z.enum(['external', 'self-fix', 'self-skill'])
export type MrOrigin = z.infer<typeof mrOriginSchema>

export const supervisedMrStateSchema = z.enum(['open', 'merged', 'closed', 'draft_skipped'])
export type SupervisedMrState = z.infer<typeof supervisedMrStateSchema>

export const mrPendingSignalSchema = z.object({
  kind: z.enum(['opened', 'push', 'discussion', 'ci-failed', 'ready-for-review', 'conflict']),
  observedAt: z.number().int().nonnegative(),
  headSha: z.string().min(1).optional(),
  discussionId: z.string().min(1).optional(),
  noteId: z.string().min(1).optional(),
  summary: z.string().optional(),
}).strict()

export type MrPendingSignal = z.infer<typeof mrPendingSignalSchema>

export const supervisedMrSchema = z.object({
  repo: z.string().min(1),
  mrNumber: z.number().int().positive(),
  origin: mrOriginSchema,
  title: z.string().min(1).optional(),
  url: z.string().min(1).optional(),
  sourceBranch: z.string().min(1).optional(),
  targetBranch: z.string().min(1).optional(),
  author: z.string().min(1).optional(),
  headSha: z.string().min(1).optional(),
  isDraft: z.boolean().optional(),
  issueId: z.string().min(1).optional(),
  sessionId: z.string().min(1).optional(),
  workDir: z.string().min(1).optional(),
  feishuLaunchKey: z.string().min(1).optional(),
  state: supervisedMrStateSchema,
  lastReviewedSha: z.string().min(1).optional(),
  reviewedHeadSha: z.string().min(1).optional(),
  lastNoteCursor: z.string().min(1).optional(),
  notifiedConflictSha: z.string().min(1).optional(),
  seenNoteIds: z.array(z.string().min(1)).optional(),
  deliveredNoteIds: z.array(z.string().min(1)).optional(),
  ownPushedShas: z.array(z.string().min(1)),
  autoFixAttempts: z.number().int().nonnegative(),
  pendingSignals: z.array(mrPendingSignalSchema),
  dueAt: z.number().int().nonnegative().optional(),
  closedAt: z.number().int().nonnegative().optional(),
  updatedAt: z.number().int().nonnegative().optional(),
}).strict()

export type SupervisedMrRecord = z.infer<typeof supervisedMrSchema>

/**
 * Canonical primary key of `supervised_mrs`: `'<canonicalRepoUrl>#<mrNumber>'`.
 */
export function supervisedMrKey(canonicalRepoUrl: string, mrNumber: number): string {
  return `${canonicalRepoUrl}#${mrNumber}`
}

// ---------------------------------------------------------------------------
// 7. circuit_breakers
// ---------------------------------------------------------------------------

export const circuitBreakerSchema = z.object({
  windowStartAt: z.number().int().nonnegative(),
  triggeredCount: z.number().int().nonnegative(),
  /** Timestamps (epoch ms) within the active sliding window for exact pruning. */
  events: z.array(z.number().int().nonnegative()).optional(),
  trippedUntil: z.number().int().nonnegative().optional(),
  reason: z.string().optional(),
}).strict()

export type CircuitBreakerRecord = z.infer<typeof circuitBreakerSchema>

// ---------------------------------------------------------------------------
// Domain Specification & Handle
// ---------------------------------------------------------------------------

export const supervisorDomainSpec = {
  name: SUPERVISOR_STORAGE_DOMAIN,
  version: SUPERVISOR_STORAGE_VERSION,
  tables: {
    watermarks: { valueSchema: watermarkSchema },
    pending_batches: { valueSchema: pendingBatchSchema },
    log_tasks: { valueSchema: logTaskSchema },
    outbox_platform: { valueSchema: outboxPlatformSchema },
    issues: { valueSchema: issueSchema },
    supervised_mrs: { valueSchema: supervisedMrSchema },
    circuit_breakers: { valueSchema: circuitBreakerSchema },
  },
} as const satisfies DomainSpec

/** Strongly typed handle for all 7 tables in `'dsh_supervisor'`. */
export interface SupervisorDomain {
  readonly raw: RawDomainHandle
  readonly watermarks: DomainTable<WatermarkRecord>
  readonly pendingBatches: DomainTable<PendingBatchRecord>
  readonly logTasks: DomainTable<LogTaskRecord>
  readonly outboxPlatform: DomainTable<OutboxPlatformRecord>
  readonly issues: IssuesTable
  readonly supervisedMrs: DomainTable<SupervisedMrRecord>
  readonly circuitBreakers: DomainTable<CircuitBreakerRecord>
  close(): Promise<void>
}

export interface OpenSupervisorDomainOptions extends OpenStorageDomainOptions {
  readonly now?: () => number
}

function closableTable<V>(table: DomainTable<V>, isClosed: () => boolean): DomainTable<V> {
  const rejectClosed = (): Promise<never> =>
    Promise.reject(new StorageDomainError('closed', `存储域 "${SUPERVISOR_STORAGE_DOMAIN}" 已关闭`))
  return {
    get size() { return table.size },
    has: key => table.has(key),
    get: key => table.get(key),
    entries: () => table.entries(),
    values: () => table.values(),
    keys: () => table.keys(),
    put: (key, value) => (isClosed() ? rejectClosed() : table.put(key, value)),
    update: (key, fn) => (isClosed() ? rejectClosed() : table.update(key, fn)),
    delete: key => (isClosed() ? rejectClosed() : table.delete(key)),
  }
}

/**
 * Open the `'dsh_supervisor'` storage domain (using host `ctx.storageDomain` when
 * present, else local file or in-memory fallback) and return typed table handles.
 */
export async function openSupervisorDomain(options: OpenSupervisorDomainOptions = {}): Promise<SupervisorDomain> {
  const raw = await openStorageDomain(supervisorDomainSpec, options)
  const issues = new IssuesTable(typedTable<IssueRecord>(raw.table('issues')), options.now)
  let domainClosed = false
  let closing: Promise<void> | undefined
  const isClosed = (): boolean => domainClosed
  const closeDomain = (): Promise<void> => {
    domainClosed = true
    closing ??= (async () => {
      await issues.drainAndClose()
      await raw.close()
    })()
    return closing
  }
  return {
    raw: {
      table: name => raw.table(name),
      close: closeDomain,
    },
    watermarks: closableTable(typedTable<WatermarkRecord>(raw.table('watermarks')), isClosed),
    pendingBatches: closableTable(typedTable<PendingBatchRecord>(raw.table('pending_batches')), isClosed),
    logTasks: closableTable(typedTable<LogTaskRecord>(raw.table('log_tasks')), isClosed),
    outboxPlatform: closableTable(typedTable<OutboxPlatformRecord>(raw.table('outbox_platform')), isClosed),
    issues,
    supervisedMrs: closableTable(typedTable<SupervisedMrRecord>(raw.table('supervised_mrs')), isClosed),
    circuitBreakers: closableTable(typedTable<CircuitBreakerRecord>(raw.table('circuit_breakers')), isClosed),
    close: closeDomain,
  }
}
