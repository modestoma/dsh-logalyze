/**
 * Stateful two-way synchronization between local `IssuesTable` (`IssueMemory`)
 * and a user-configured Feishu Bitable table via `feishuBitable` v1 (`@dsh/channels`).
 *
 * Ownership boundary:
 * - AI-owned columns (`问题ID`, `应用`, `标题`, `匹配特征`, `排除特征`, `AI 诊断结论`,
 *   `AI 状态`, `解决建议`, `首次发现`, `最近出现`, `示例报告`, `最新报告`, `修复 MR`)
 *   are pushed from local `IssuesTable` when `syncDirty === true` or when bound to
 *   a different Bitable table, and NEVER overwrite human-owned columns.
 * - Human-owned columns (`人工确认结论`, `人工状态`, `负责人`) are pulled from
 *   Bitable into local `IssuesTable` via `IssuesTable.syncHumanFields`, strictly
 *   keyed by `问题ID` (never creating duplicate remote rows and never cleared
 *   when optional columns do not exist in the remote table).
 * - Clearing `syncDirty` uses `expectedAiFingerprint` inside `IssuesTable`'s
 *   per-key lock so concurrent `upsertByAi` / `attachUrlsByAi` updates during
 *   remote HTTP calls always remain dirty for the next pass.
 *
 * @module dsh-logalyze/issues/bitable-sync
 */

import { BITABLE_BATCH_MAX_RECORDS, parseBitableUrl } from '../deps/bitable.ts'
import type { LookupBitableResult } from '../deps/bitable.ts'
import type {
  BitableFieldInfo,
  BitableRecord,
  BitableTableSchema,
  FeishuBitableService,
} from '../deps/bitable-contract.ts'
import type { HostLogger } from '../host.ts'
import { computeIssueAiFingerprint } from '../runtime/domain.ts'
import type { IssueRecord, IssuesTable } from '../runtime/domain.ts'
import type {
  BitableColumnCheckWire,
  BitableSchemaCheckWire,
  IssueItemWire,
  IssueOverviewWire,
  IssueSyncSettings,
} from '../settings/contract.ts'
import { messageOf } from '../util/errors.ts'

export type BitableExpectedFieldType = BitableColumnCheckWire['expectedType']

/** Specification of one column in the Known Issues Feishu Bitable table. */
export interface IssueBitableColumnSpec {
  readonly name: string
  readonly key: keyof IssueRecord | 'issueId'
  readonly role: 'ai' | 'human'
  readonly required: boolean
  readonly expectedType: BitableExpectedFieldType
}

/** Canonical 16-column schema shared by two-way sync and schema self-check. */
export const ISSUE_BITABLE_COLUMNS: readonly IssueBitableColumnSpec[] = [
  { name: '问题ID', key: 'issueId', role: 'ai', required: true, expectedType: 'text' },
  { name: '应用', key: 'appId', role: 'ai', required: false, expectedType: 'text' },
  { name: '标题', key: 'title', role: 'ai', required: false, expectedType: 'text' },
  { name: '匹配特征', key: 'matchCriteria', role: 'ai', required: false, expectedType: 'text' },
  { name: '排除特征', key: 'exclusionCriteria', role: 'ai', required: false, expectedType: 'text' },
  { name: 'AI 诊断结论', key: 'aiDiagnosis', role: 'ai', required: false, expectedType: 'text' },
  { name: 'AI 状态', key: 'aiStatus', role: 'ai', required: false, expectedType: 'select' },
  { name: '解决建议', key: 'resolutionAdvice', role: 'ai', required: false, expectedType: 'text' },
  { name: '首次发现', key: 'firstSeenAt', role: 'ai', required: false, expectedType: 'datetime' },
  { name: '最近出现', key: 'lastSeenAt', role: 'ai', required: false, expectedType: 'datetime' },
  { name: '示例报告', key: 'sampleReportUrl', role: 'ai', required: false, expectedType: 'link' },
  { name: '最新报告', key: 'latestReportUrl', role: 'ai', required: false, expectedType: 'link' },
  { name: '修复 MR', key: 'fixMrUrl', role: 'ai', required: false, expectedType: 'link' },
  { name: '人工确认结论', key: 'humanConclusion', role: 'human', required: false, expectedType: 'text' },
  { name: '人工状态', key: 'humanStatus', role: 'human', required: false, expectedType: 'select' },
  { name: '负责人', key: 'assignee', role: 'human', required: false, expectedType: 'user' },
]

const READONLY_FIELD_TYPES = new Set([
  'formula',
  'lookup',
  'created_time',
  'modified_time',
  'created_user',
  'modified_user',
  'auto_number',
  'rollup',
  'button',
])

const COMPATIBLE_ACTUAL_TYPES: Record<BitableExpectedFieldType, ReadonlySet<string>> = {
  text: new Set(['text', 'single_select', 'select']),
  select: new Set(['select', 'single_select', 'multi_select', 'text']),
  datetime: new Set(['datetime', 'date_time', 'number', 'text']),
  link: new Set(['link', 'url', 'text']),
  user: new Set(['user', 'person', 'text', 'select', 'single_select', 'multi_select']),
}

const DEFAULT_AI_MUTATE_DEBOUNCE_MS = 2_000
const MAX_PANEL_ISSUES = 200
const MAX_PAGINATION_PAGES = 1_000

/** Result of one manual or background `syncNow()` execution. */
export interface IssueSyncRunResult {
  readonly ok: boolean
  readonly pulled: number
  readonly pushed: number
  readonly created: number
  readonly updated: number
  readonly error?: string
}

/** Collaborators for {@link IssueBitableSyncer}. */
export interface IssueBitableSyncerDeps {
  readonly issues: IssuesTable
  readonly getSettings: () => IssueSyncSettings
  readonly getBitable: () => LookupBitableResult
  readonly onChange?: () => void
  readonly now?: () => number
  readonly logger?: HostLogger
  /** Override background periodic polling timer in tests. */
  readonly autoSyncTimer?: boolean
  /** Override post-AI-mutation debounce window in ms (default 2000ms). */
  readonly aiMutateDebounceMs?: number
}

function tableIdentityKey(baseToken: string, tableId: string): string {
  return `${baseToken}:${tableId}`
}

function isCompatibleFieldType(expected: BitableExpectedFieldType, actual: string): boolean {
  const normalized = actual.trim().toLowerCase()
  return COMPATIBLE_ACTUAL_TYPES[expected].has(normalized)
}

function extractTextValue(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null
  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    return trimmed === '' ? null : trimmed
  }
  if (typeof raw === 'number' || typeof raw === 'boolean') {
    return String(raw)
  }
  if (Array.isArray(raw)) {
    const parts: string[] = []
    for (const item of raw) {
      if (typeof item === 'string') {
        const trimmed = item.trim()
        if (trimmed !== '') parts.push(trimmed)
        continue
      }
      if (item !== null && typeof item === 'object') {
        const obj = item as Record<string, unknown>
        if (typeof obj.text === 'string') {
          parts.push(obj.text)
          continue
        }
        const label = pickObjectLabel(obj)
        if (label !== undefined) parts.push(label)
      }
    }
    const joined = parts.join('').trim()
    return joined === '' ? null : joined
  }
  if (typeof raw === 'object') {
    const obj = raw as Record<string, unknown>
    if (typeof obj.text === 'string' && obj.text.trim() !== '') {
      return obj.text.trim()
    }
    if (typeof obj.link === 'string' && obj.link.trim() !== '') {
      return obj.link.trim()
    }
    const label = pickObjectLabel(obj)
    return label ?? null
  }
  return null
}

function extractSelectOrUserValue(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null
  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    return trimmed === '' ? null : trimmed
  }
  if (typeof raw === 'number' || typeof raw === 'boolean') {
    return String(raw)
  }
  if (Array.isArray(raw)) {
    const labels: string[] = []
    for (const item of raw) {
      if (typeof item === 'string') {
        const trimmed = item.trim()
        if (trimmed !== '') labels.push(trimmed)
      } else if (item !== null && typeof item === 'object') {
        const label = pickObjectLabel(item as Record<string, unknown>)
        if (label !== undefined) labels.push(label)
      }
    }
    const unique = [...new Set(labels)]
    return unique.length === 0 ? null : unique.join(', ')
  }
  if (typeof raw === 'object') {
    const label = pickObjectLabel(raw as Record<string, unknown>)
    return label ?? null
  }
  return null
}

function pickObjectLabel(obj: Record<string, unknown>): string | undefined {
  for (const key of ['name', 'en_name', 'option_name', 'text', 'id', 'open_id', 'user_id'] as const) {
    const candidate = obj[key]
    if (typeof candidate === 'string' && candidate.trim() !== '') {
      return candidate.trim()
    }
  }
  return undefined
}

function encodeFieldValue(
  spec: IssueBitableColumnSpec,
  field: BitableFieldInfo,
  issueId: string,
  record: IssueRecord,
): unknown {
  const actualType = field.type.trim().toLowerCase()
  switch (spec.key) {
    case 'issueId':
      return issueId
    case 'appId':
      return record.appId
    case 'title':
      return record.title
    case 'matchCriteria':
      return record.matchCriteria
    case 'exclusionCriteria':
      return record.exclusionCriteria ?? ''
    case 'aiDiagnosis':
      return record.aiDiagnosis
    case 'aiStatus':
      if (actualType === 'select' || actualType === 'single_select' || actualType === 'multi_select') {
        return [record.aiStatus]
      }
      return record.aiStatus
    case 'resolutionAdvice':
      return record.resolutionAdvice
    case 'firstSeenAt':
      return actualType === 'text' ? new Date(record.firstSeenAt).toISOString() : record.firstSeenAt
    case 'lastSeenAt':
      return actualType === 'text' ? new Date(record.lastSeenAt).toISOString() : record.lastSeenAt
    case 'sampleReportUrl':
      return encodeUrlValue(record.sampleReportUrl, actualType)
    case 'latestReportUrl':
      return encodeUrlValue(record.latestReportUrl, actualType)
    case 'fixMrUrl':
      return encodeUrlValue(record.fixMrUrl, actualType)
    default:
      return undefined
  }
}

function encodeUrlValue(url: string | undefined, actualType: string): unknown {
  if (url === undefined) return undefined
  if (actualType === 'link' || actualType === 'url') {
    return { text: url, link: url }
  }
  return url
}

function buildAiRecordFields(
  issueId: string,
  record: IssueRecord,
  writableAiSpecs: ReadonlyArray<{ readonly spec: IssueBitableColumnSpec; readonly field: BitableFieldInfo }>,
): Record<string, unknown> {
  const fields: Record<string, unknown> = {}
  for (const { spec, field } of writableAiSpecs) {
    const encoded = encodeFieldValue(spec, field, issueId, record)
    if (encoded !== undefined) {
      fields[field.name] = encoded
    }
  }
  return fields
}

function evaluateSchemaMapping(
  schema: BitableTableSchema,
  targetUrl: string,
  table: string | undefined,
  checkedAt: number,
): BitableSchemaCheckWire {
  const byName = new Map(schema.fields.map(field => [field.name, field]))
  const columns: BitableColumnCheckWire[] = []
  const missingRequired: string[] = []
  const missingOptional: string[] = []
  const warnings: string[] = []

  for (const spec of ISSUE_BITABLE_COLUMNS) {
    const field = byName.get(spec.name)
    if (field === undefined) {
      columns.push({
        name: spec.name,
        role: spec.role,
        required: spec.required,
        expectedType: spec.expectedType,
        status: 'missing',
        detail: spec.required ? '缺少必需主键列，无法安全同步' : '可选列未创建，同步时将自动跳过',
      })
      if (spec.required) {
        missingRequired.push(spec.name)
      } else {
        missingOptional.push(spec.name)
      }
      continue
    }

    const normalizedActual = field.type.trim().toLowerCase()
    if (READONLY_FIELD_TYPES.has(normalizedActual)) {
      columns.push({
        name: spec.name,
        role: spec.role,
        required: spec.required,
        expectedType: spec.expectedType,
        status: 'readonly',
        actualType: field.type,
        detail: spec.role === 'ai' ? '目标列为只读计算/系统列，AI 字段无法写入' : '只读列，仅在拉取时读取',
      })
      if (spec.required) {
        missingRequired.push(spec.name)
      } else if (spec.role === 'ai') {
        warnings.push(`列「${spec.name}」为只读类型（${field.type}），写入时将跳过`)
      }
      continue
    }

    if (!isCompatibleFieldType(spec.expectedType, normalizedActual)) {
      columns.push({
        name: spec.name,
        role: spec.role,
        required: spec.required,
        expectedType: spec.expectedType,
        status: 'type_mismatch',
        actualType: field.type,
        detail: `期望类型 ${spec.expectedType}，实际为 ${field.type}`,
      })
      warnings.push(`列「${spec.name}」类型（${field.type}）与建议类型（${spec.expectedType}）不一致，可能影响展示`)
      if (spec.required) {
        missingRequired.push(spec.name)
      }
      continue
    }

    columns.push({
      name: spec.name,
      role: spec.role,
      required: spec.required,
      expectedType: spec.expectedType,
      status: 'matched',
      actualType: field.type,
    })
  }

  return {
    ok: missingRequired.length === 0,
    checkedAt,
    targetUrl,
    ...(table === undefined ? {} : { table }),
    resolvedBaseToken: schema.baseToken,
    resolvedTableId: schema.tableId,
    resolvedTableName: schema.tableName,
    ...(missingRequired.length === 0
      ? {}
      : { error: `必需列不可用：${missingRequired.join('、')}` }),
    columns,
    missingRequired,
    missingOptional,
    warnings,
  }
}

interface PendingPushCandidate {
  readonly issueId: string
  readonly fingerprint: string
  readonly fields: Readonly<Record<string, unknown>>
  readonly remoteRecordId?: string
}

/**
 * Background + on-demand two-way sync orchestrator for Known Issues ↔ Feishu Bitable.
 */
export class IssueBitableSyncer {
  private readonly now: () => number
  private readonly debounceMs: number
  private readonly autoSyncTimer: boolean
  private periodicTimer: ReturnType<typeof setTimeout> | undefined
  private soonTimer: ReturnType<typeof setTimeout> | undefined
  private inFlight: Promise<IssueSyncRunResult> | undefined
  private rerunRequested = false
  private closed = false
  private lastConfigSignature = ''
  private lastSyncAt: number | undefined
  private lastError: string | undefined
  private lastCheck: BitableSchemaCheckWire | undefined
  private unsubscribeAiMutate: (() => void) | undefined
  private unsubscribeBitableChange: (() => void) | undefined
  private trackedBitableService: FeishuBitableService | undefined

  constructor(private readonly deps: IssueBitableSyncerDeps) {
    this.now = deps.now ?? Date.now
    this.debounceMs = Math.max(0, deps.aiMutateDebounceMs ?? DEFAULT_AI_MUTATE_DEBOUNCE_MS)
    this.autoSyncTimer = deps.autoSyncTimer ?? true
    this.lastConfigSignature = this.configSignature(deps.getSettings())
  }

  private configSignature(settings: IssueSyncSettings): string {
    return JSON.stringify([settings.enabled, settings.bitableUrl ?? null, settings.table ?? null, settings.syncIntervalMs])
  }

  /** Subscribe to local AI mutations & Bitable service changes and arm the periodic timer. */
  boot(): void {
    if (this.closed) return
    if (this.unsubscribeAiMutate === undefined) {
      this.unsubscribeAiMutate = this.deps.issues.onAiMutate(() => {
        this.scheduleSoon()
      })
    }
    this.refreshBitableListener()
    this.armPeriodicTimer()
  }

  /** Notify syncer when `feishuBitable` service registers/unregisters or changes state. */
  notifyServiceChanged(): void {
    if (this.closed) return
    this.refreshBitableListener()
    const lookup = this.deps.getBitable()
    if (lookup.status === 'ready') {
      const settings = this.deps.getSettings()
      if (settings.enabled && settings.bitableUrl !== undefined) {
        if (this.lastError !== undefined || this.deps.issues.listDirty().length > 0) {
          this.scheduleSoon()
        }
      }
    }
    this.deps.onChange?.()
  }

  /** Notify syncer after panel settings save/reset. */
  notifyConfigChanged(): void {
    if (this.closed) return
    const settings = this.deps.getSettings()
    const nextSig = this.configSignature(settings)
    const oldParsed = this.lastConfigSignature
    this.lastConfigSignature = nextSig
    if (nextSig !== oldParsed) {
      this.lastError = undefined
      this.lastCheck = undefined
    }
    this.armPeriodicTimer()
    if (settings.enabled && settings.bitableUrl !== undefined) {
      this.scheduleSoon()
    }
    this.deps.onChange?.()
  }

  private refreshBitableListener(): void {
    const lookup = this.deps.getBitable()
    const nextService = lookup.status === 'ready' ? lookup.service : undefined
    if (nextService === this.trackedBitableService) return
    this.unsubscribeBitableChange?.()
    this.unsubscribeBitableChange = undefined
    this.trackedBitableService = nextService
    if (nextService?.onChange !== undefined) {
      this.unsubscribeBitableChange = nextService.onChange(() => {
        if (this.closed) return
        const settings = this.deps.getSettings()
        if (settings.enabled && settings.bitableUrl !== undefined) {
          this.scheduleSoon()
        }
        this.deps.onChange?.()
      })
    }
  }

  private armPeriodicTimer(): void {
    if (this.periodicTimer !== undefined) {
      clearTimeout(this.periodicTimer)
      this.periodicTimer = undefined
    }
    if (this.closed || !this.autoSyncTimer) return
    const settings = this.deps.getSettings()
    if (!settings.enabled || settings.bitableUrl === undefined) return
    const delay = Math.max(5_000, settings.syncIntervalMs)
    this.periodicTimer = setTimeout(() => {
      this.periodicTimer = undefined
      if (this.closed) return
      void this.syncNow().finally(() => {
        if (!this.closed) this.armPeriodicTimer()
      })
    }, delay)
    this.periodicTimer.unref?.()
  }

  /** Schedule a debounced background sync soon after AI issue writes or reconnects. */
  scheduleSoon(): void {
    if (this.closed) return
    const settings = this.deps.getSettings()
    if (!settings.enabled || settings.bitableUrl === undefined) return
    if (this.inFlight !== undefined) {
      this.rerunRequested = true
      return
    }
    if (this.soonTimer !== undefined) {
      clearTimeout(this.soonTimer)
      this.soonTimer = undefined
    }
    this.soonTimer = setTimeout(() => {
      this.soonTimer = undefined
      if (!this.closed) {
        void this.syncNow()
      }
    }, this.debounceMs)
    this.soonTimer.unref?.()
  }

  /** Cancel timers, wait for any in-flight sync pass to finish, and unsubscribe listeners. */
  async drainAndClose(): Promise<void> {
    this.closed = true
    this.rerunRequested = false
    if (this.periodicTimer !== undefined) {
      clearTimeout(this.periodicTimer)
      this.periodicTimer = undefined
    }
    if (this.soonTimer !== undefined) {
      clearTimeout(this.soonTimer)
      this.soonTimer = undefined
    }
    this.unsubscribeAiMutate?.()
    this.unsubscribeAiMutate = undefined
    this.unsubscribeBitableChange?.()
    this.unsubscribeBitableChange = undefined
    this.trackedBitableService = undefined
    if (this.inFlight !== undefined) {
      await this.inFlight.catch(() => undefined)
    }
  }

  /** Inspect target Bitable table schema and report column mapping readiness. */
  async checkFieldMapping(override?: { readonly bitableUrl?: string; readonly table?: string }): Promise<BitableSchemaCheckWire> {
    const saved = this.deps.getSettings()
    const rawUrl = override?.bitableUrl !== undefined ? override.bitableUrl.trim() : (saved.bitableUrl ?? '')
    const rawTable = override?.table !== undefined
      ? (override.table.trim() === '' ? undefined : override.table.trim())
      : saved.table
    const checkedAt = this.now()

    if (rawUrl === '' || parseBitableUrl(rawUrl, rawTable) === undefined) {
      const invalid: BitableSchemaCheckWire = {
        ok: false,
        checkedAt,
        targetUrl: rawUrl,
        ...(rawTable === undefined ? {} : { table: rawTable }),
        errorCode: 'invalid-target',
        error: rawUrl === ''
          ? '请先填写飞书多维表格地址'
          : '飞书多维表格地址不合法：请填写 https://…/base/<token> 或 https://…/wiki/<token>',
        columns: [],
        missingRequired: ['问题ID'],
        missingOptional: [],
        warnings: [],
      }
      this.lastCheck = invalid
      this.deps.onChange?.()
      return invalid
    }

    const lookup = this.deps.getBitable()
    if (lookup.status !== 'ready') {
      const detail = lookup.status === 'incompatible'
        ? lookup.detail
        : '飞书多维表格服务（feishuBitable）未就绪，请先启用并连接 @dsh/channels'
      const unavailable: BitableSchemaCheckWire = {
        ok: false,
        checkedAt,
        targetUrl: rawUrl,
        ...(rawTable === undefined ? {} : { table: rawTable }),
        errorCode: lookup.status === 'incompatible' ? 'incompatible' : 'not-connected',
        error: detail,
        columns: [],
        missingRequired: ['问题ID'],
        missingOptional: [],
        warnings: [],
      }
      this.lastCheck = unavailable
      this.deps.onChange?.()
      return unavailable
    }

    const schema = await lookup.service.inspectTable({
      url: rawUrl,
      ...(rawTable === undefined ? {} : { table: rawTable }),
    })
    if (!schema.ok) {
      const failed: BitableSchemaCheckWire = {
        ok: false,
        checkedAt,
        targetUrl: rawUrl,
        ...(rawTable === undefined ? {} : { table: rawTable }),
        errorCode: schema.code,
        error: schema.message,
        columns: [],
        missingRequired: ['问题ID'],
        missingOptional: [],
        warnings: [],
      }
      this.lastCheck = failed
      this.deps.onChange?.()
      return failed
    }

    const checked = evaluateSchemaMapping(schema, rawUrl, rawTable, checkedAt)
    this.lastCheck = checked
    this.deps.onChange?.()
    return checked
  }

  /** Run a singleflight two-way sync pass now. */
  syncNow(): Promise<IssueSyncRunResult> {
    if (this.closed) {
      return Promise.resolve({ ok: false, pulled: 0, pushed: 0, created: 0, updated: 0, error: '多维表格同步器已关闭' })
    }
    if (this.soonTimer !== undefined) {
      clearTimeout(this.soonTimer)
      this.soonTimer = undefined
    }
    if (this.inFlight !== undefined) {
      this.rerunRequested = true
      return this.inFlight
    }
    const run = this.runSingleflightLoop().finally(() => {
      if (this.inFlight === run) {
        this.inFlight = undefined
      }
      this.deps.onChange?.()
    })
    this.inFlight = run
    this.deps.onChange?.()
    return run
  }

  private async runSingleflightLoop(): Promise<IssueSyncRunResult> {
    let aggregate: IssueSyncRunResult = { ok: true, pulled: 0, pushed: 0, created: 0, updated: 0 }
    while (!this.closed) {
      this.rerunRequested = false
      const pass = await this.executeSyncPass()
      aggregate = {
        ok: pass.ok,
        pulled: aggregate.pulled + pass.pulled,
        pushed: aggregate.pushed + pass.pushed,
        created: aggregate.created + pass.created,
        updated: aggregate.updated + pass.updated,
        ...(pass.error === undefined ? {} : { error: pass.error }),
      }
      if (!pass.ok || !this.rerunRequested || this.closed) {
        return aggregate
      }
    }
    return aggregate
  }

  private async executeSyncPass(): Promise<IssueSyncRunResult> {
    const settings = this.deps.getSettings()
    if (!settings.enabled) {
      return { ok: false, pulled: 0, pushed: 0, created: 0, updated: 0, error: '多维表格自动同步未启用' }
    }
    if (settings.bitableUrl === undefined) {
      return { ok: false, pulled: 0, pushed: 0, created: 0, updated: 0, error: '尚未配置飞书多维表格地址' }
    }
    const lookup = this.deps.getBitable()
    if (lookup.status !== 'ready') {
      const error = lookup.status === 'incompatible'
        ? lookup.detail
        : '飞书多维表格服务（feishuBitable）未就绪，等待 @dsh/channels 连接后自动恢复'
      this.lastError = error
      return { ok: false, pulled: 0, pushed: 0, created: 0, updated: 0, error }
    }

    try {
      const schema = await lookup.service.inspectTable({
        url: settings.bitableUrl,
        ...(settings.table === undefined ? {} : { table: settings.table }),
      })
      if (!schema.ok) {
        this.lastError = schema.message
        return { ok: false, pulled: 0, pushed: 0, created: 0, updated: 0, error: schema.message }
      }

      const checked = evaluateSchemaMapping(schema, settings.bitableUrl, settings.table, this.now())
      this.lastCheck = checked
      if (!checked.ok) {
        const error = checked.error ?? '目标多维表格缺少必需的「问题ID」列'
        this.lastError = error
        return { ok: false, pulled: 0, pushed: 0, created: 0, updated: 0, error }
      }

      const tableKey = tableIdentityKey(schema.baseToken, schema.tableId)
      const fieldByName = new Map(schema.fields.map(field => [field.name, field]))
      const writableAiSpecs = ISSUE_BITABLE_COLUMNS
        .filter(spec => spec.role === 'ai')
        .flatMap((spec) => {
          const field = fieldByName.get(spec.name)
          if (field === undefined || READONLY_FIELD_TYPES.has(field.type.trim().toLowerCase())) return []
          return [{ spec, field }]
        })
      const humanColumns = ISSUE_BITABLE_COLUMNS
        .filter(spec => spec.role === 'human' && fieldByName.has(spec.name))

      // If no issues exist locally, verifying schema connectivity suffices.
      if (this.deps.issues.size === 0) {
        this.lastError = undefined
        this.lastSyncAt = this.now()
        return { ok: true, pulled: 0, pushed: 0, created: 0, updated: 0 }
      }

      const remoteRows = await this.fetchAllRemoteRows(lookup.service, settings, ['问题ID', ...humanColumns.map(c => c.name)])
      if (!remoteRows.ok) {
        this.lastError = remoteRows.error
        return { ok: false, pulled: 0, pushed: 0, created: 0, updated: 0, error: remoteRows.error }
      }

      const canonicalRemoteByIssueId = new Map<string, BitableRecord>()
      let duplicateIssueRows = 0
      for (const row of remoteRows.records) {
        const remoteIssueId = extractTextValue(row.fields['问题ID'])
        if (remoteIssueId === null) continue
        if (canonicalRemoteByIssueId.has(remoteIssueId)) {
          duplicateIssueRows += 1
          continue
        }
        canonicalRemoteByIssueId.set(remoteIssueId, row)
      }
      if (duplicateIssueRows > 0) {
        this.deps.logger?.warn?.(
          'logalyze: 飞书多维表格中存在 %d 行重复「问题ID」，已按首条记录去重',
          duplicateIssueRows,
        )
      }

      const staleTableIssueIds = new Set<string>()
      for (const [issueId, local] of this.deps.issues.entries()) {
        if (local.bitableTableKey !== tableKey) {
          staleTableIssueIds.add(issueId)
        }
      }

      // 1. Pull human columns from Bitable into local IssuesTable.
      const pulled = await this.pullHumanColumns(canonicalRemoteByIssueId, humanColumns, remoteRows.ignoredFields, tableKey)

      // 2. Push local AI changes (syncDirty === true or bound to a different tableKey) to Bitable.
      const { created, updated, error: pushError } = await this.pushAiColumns(
        lookup.service,
        settings,
        tableKey,
        writableAiSpecs,
        canonicalRemoteByIssueId,
        staleTableIssueIds,
      )
      if (pushError !== undefined) {
        this.lastError = pushError
        return { ok: false, pulled, pushed: created + updated, created, updated, error: pushError }
      }

      this.lastError = undefined
      this.lastSyncAt = this.now()
      return {
        ok: true,
        pulled,
        pushed: created + updated,
        created,
        updated,
      }
    } catch (error) {
      const msg = `多维表格同步异常：${messageOf(error)}`
      this.lastError = msg
      this.deps.logger?.warn?.('logalyze: %s', msg)
      return { ok: false, pulled: 0, pushed: 0, created: 0, updated: 0, error: msg }
    }
  }

  private async fetchAllRemoteRows(
    service: FeishuBitableService,
    settings: IssueSyncSettings,
    fields: readonly string[],
  ): Promise<{ readonly ok: true; readonly records: readonly BitableRecord[]; readonly ignoredFields: ReadonlySet<string> } | { readonly ok: false; readonly error: string }> {
    const records: BitableRecord[] = []
    const ignored = new Set<string>()
    let offset = 0
    for (let pageIndex = 0; pageIndex < MAX_PAGINATION_PAGES; pageIndex += 1) {
      if (this.closed) return { ok: false, error: '多维表格同步器已关闭' }
      const page = await service.listRecords({
        url: settings.bitableUrl!,
        ...(settings.table === undefined ? {} : { table: settings.table }),
        fields,
        offset,
        limit: BITABLE_BATCH_MAX_RECORDS,
      })
      if (!page.ok) {
        return { ok: false, error: page.message }
      }
      records.push(...page.records)
      for (const name of page.ignoredFields) ignored.add(name)
      if (!page.hasMore) {
        return { ok: true, records, ignoredFields: ignored }
      }
      const next = page.nextOffset ?? (offset + page.records.length)
      if (next <= offset) {
        return { ok: true, records, ignoredFields: ignored }
      }
      offset = next
    }
    return { ok: true, records, ignoredFields: ignored }
  }

  private async pullHumanColumns(
    canonicalRemoteByIssueId: ReadonlyMap<string, BitableRecord>,
    humanColumns: readonly IssueBitableColumnSpec[],
    ignoredFields: ReadonlySet<string>,
    tableKey: string,
  ): Promise<number> {
    let pulled = 0
    const hasConclusion = humanColumns.some(c => c.name === '人工确认结论') && !ignoredFields.has('人工确认结论')
    const hasStatus = humanColumns.some(c => c.name === '人工状态') && !ignoredFields.has('人工状态')
    const hasAssignee = humanColumns.some(c => c.name === '负责人') && !ignoredFields.has('负责人')

    for (const [issueId, local] of this.deps.issues.entries()) {
      if (this.closed) break
      const remote = canonicalRemoteByIssueId.get(issueId)
      if (remote === undefined) continue

      const nextConclusion = hasConclusion ? extractTextValue(remote.fields['人工确认结论']) : undefined
      const nextStatus = hasStatus ? extractSelectOrUserValue(remote.fields['人工状态']) : undefined
      const nextAssignee = hasAssignee ? extractSelectOrUserValue(remote.fields['负责人']) : undefined

      const conclusionChanged = hasConclusion && (nextConclusion ?? undefined) !== local.humanConclusion
      const statusChanged = hasStatus && (nextStatus ?? undefined) !== local.humanStatus
      const assigneeChanged = hasAssignee && (nextAssignee ?? undefined) !== local.assignee
      const bindingChanged = local.bitableRecordId !== remote.recordId || local.bitableTableKey !== tableKey

      if (!conclusionChanged && !statusChanged && !assigneeChanged && !bindingChanged) {
        continue
      }

      await this.deps.issues.syncHumanFields(issueId, {
        ...(conclusionChanged ? { humanConclusion: nextConclusion } : {}),
        ...(statusChanged ? { humanStatus: nextStatus } : {}),
        ...(assigneeChanged ? { assignee: nextAssignee } : {}),
        bitableRecordId: remote.recordId,
        bitableTableKey: tableKey,
      })
      if (conclusionChanged || statusChanged || assigneeChanged) {
        pulled += 1
      }
    }
    return pulled
  }

  private async pushAiColumns(
    service: FeishuBitableService,
    settings: IssueSyncSettings,
    tableKey: string,
    writableAiSpecs: ReadonlyArray<{ readonly spec: IssueBitableColumnSpec; readonly field: BitableFieldInfo }>,
    canonicalRemoteByIssueId: ReadonlyMap<string, BitableRecord>,
    staleTableIssueIds: ReadonlySet<string>,
  ): Promise<{ readonly created: number; readonly updated: number; readonly error?: string }> {
    const toUpdate: PendingPushCandidate[] = []
    const toCreate: PendingPushCandidate[] = []

    for (const [issueId, local] of this.deps.issues.entries()) {
      const tableSwitched = staleTableIssueIds.has(issueId) || local.bitableTableKey !== tableKey
      if (!local.syncDirty && !tableSwitched) continue

      const remote = canonicalRemoteByIssueId.get(issueId)
      const sameTableBoundId = local.bitableTableKey === tableKey ? local.bitableRecordId : undefined
      const targetRecordId = remote?.recordId ?? sameTableBoundId

      const candidate: PendingPushCandidate = {
        issueId,
        fingerprint: computeIssueAiFingerprint(local),
        fields: buildAiRecordFields(issueId, local, writableAiSpecs),
        ...(targetRecordId === undefined ? {} : { remoteRecordId: targetRecordId }),
      }
      if (targetRecordId !== undefined) {
        toUpdate.push(candidate)
      } else {
        toCreate.push(candidate)
      }
    }

    let updated = 0
    for (let start = 0; start < toUpdate.length; start += BITABLE_BATCH_MAX_RECORDS) {
      if (this.closed) return { created: 0, updated, error: '多维表格同步器已关闭' }
      const chunk = toUpdate.slice(start, start + BITABLE_BATCH_MAX_RECORDS)
      const outcome = await this.updateChunkWithDeletedFallback(
        service,
        settings,
        tableKey,
        chunk,
        canonicalRemoteByIssueId,
      )
      if (outcome.error !== undefined) {
        return { created: 0, updated: updated + outcome.updated, error: outcome.error }
      }
      updated += outcome.updated
      for (const fallbackCreate of outcome.requeueForCreate) {
        toCreate.push(fallbackCreate)
      }
    }

    let created = 0
    for (let start = 0; start < toCreate.length; start += BITABLE_BATCH_MAX_RECORDS) {
      if (this.closed) return { created, updated, error: '多维表格同步器已关闭' }
      const chunk = toCreate.slice(start, start + BITABLE_BATCH_MAX_RECORDS)
      const result = await service.createRecords({
        url: settings.bitableUrl!,
        ...(settings.table === undefined ? {} : { table: settings.table }),
        records: chunk.map(item => item.fields),
      })
      if (!result.ok) {
        return { created, updated, error: result.message }
      }
      if (result.recordIds.length !== chunk.length) {
        return {
          created,
          updated,
          error: `飞书多维表格 createRecords 返回记录数不匹配（期望 ${chunk.length}，实际 ${result.recordIds.length}）`,
        }
      }
      for (let i = 0; i < chunk.length; i += 1) {
        const candidate = chunk[i]!
        const recordId = result.recordIds[i]!
        await this.deps.issues.syncHumanFields(candidate.issueId, {
          bitableRecordId: recordId,
          bitableTableKey: tableKey,
          syncDirty: false,
          expectedAiFingerprint: candidate.fingerprint,
        })
        created += 1
      }
    }

    return { created, updated }
  }

  private async updateChunkWithDeletedFallback(
    service: FeishuBitableService,
    settings: IssueSyncSettings,
    tableKey: string,
    chunk: readonly PendingPushCandidate[],
    canonicalRemoteByIssueId: ReadonlyMap<string, BitableRecord>,
  ): Promise<{ readonly updated: number; readonly requeueForCreate: PendingPushCandidate[]; readonly error?: string }> {
    const updates: Record<string, Readonly<Record<string, unknown>>> = {}
    for (const candidate of chunk) {
      updates[candidate.remoteRecordId!] = candidate.fields
    }
    const result = await service.updateRecords({
      url: settings.bitableUrl!,
      ...(settings.table === undefined ? {} : { table: settings.table }),
      updates,
    })
    if (result.ok) {
      for (const candidate of chunk) {
        await this.deps.issues.syncHumanFields(candidate.issueId, {
          bitableRecordId: candidate.remoteRecordId!,
          bitableTableKey: tableKey,
          syncDirty: false,
          expectedAiFingerprint: candidate.fingerprint,
        })
      }
      return { updated: chunk.length, requeueForCreate: [] }
    }

    // If an optimistic update hit a deleted remote row, split batch to isolate & re-create it cleanly.
    if (result.code === 'not-found') {
      if (chunk.length > 1) {
        let updated = 0
        const requeueForCreate: PendingPushCandidate[] = []
        for (const single of chunk) {
          const res = await this.updateChunkWithDeletedFallback(
            service,
            settings,
            tableKey,
            [single],
            canonicalRemoteByIssueId,
          )
          updated += res.updated
          requeueForCreate.push(...res.requeueForCreate)
          if (res.error !== undefined) {
            return { updated, requeueForCreate, error: res.error }
          }
        }
        return { updated, requeueForCreate }
      }
      const deletedCandidate = chunk[0]!
      if (!canonicalRemoteByIssueId.has(deletedCandidate.issueId)) {
        await this.deps.issues.syncHumanFields(deletedCandidate.issueId, {
          bitableRecordId: null,
          bitableTableKey: null,
        })
        return { updated: 0, requeueForCreate: [deletedCandidate] }
      }
    }

    return { updated: 0, requeueForCreate: [], error: result.message }
  }

  /** Build the panel overview snapshot included in `GET /logalyze/state`. */
  panelState(): IssueOverviewWire {
    const settings = this.deps.getSettings()
    const lookup = this.deps.getBitable()
    const entries = this.deps.issues.entries()
    let dirtyCount = 0
    let linkedCount = 0
    let humanConfirmedCount = 0
    for (const [, record] of entries) {
      if (record.syncDirty) dirtyCount += 1
      if (record.bitableRecordId !== undefined) linkedCount += 1
      if (record.humanConclusion !== undefined || record.humanStatus !== undefined) humanConfirmedCount += 1
    }

    const sortedItems: IssueItemWire[] = entries
      .sort((a, b) => b[1].lastSeenAt - a[1].lastSeenAt)
      .slice(0, MAX_PANEL_ISSUES)
      .map(([issueId, record]) => ({
        issueId,
        appId: record.appId,
        title: record.title,
        matchCriteria: record.matchCriteria,
        ...(record.exclusionCriteria === undefined ? {} : { exclusionCriteria: record.exclusionCriteria }),
        aiDiagnosis: record.aiDiagnosis,
        aiStatus: record.aiStatus,
        resolutionAdvice: record.resolutionAdvice,
        ...(record.humanConclusion === undefined ? {} : { humanConclusion: record.humanConclusion }),
        ...(record.humanStatus === undefined ? {} : { humanStatus: record.humanStatus }),
        ...(record.assignee === undefined ? {} : { assignee: record.assignee }),
        firstSeenAt: record.firstSeenAt,
        lastSeenAt: record.lastSeenAt,
        ...(record.sampleReportUrl === undefined ? {} : { sampleReportUrl: record.sampleReportUrl }),
        ...(record.latestReportUrl === undefined ? {} : { latestReportUrl: record.latestReportUrl }),
        ...(record.fixMrUrl === undefined ? {} : { fixMrUrl: record.fixMrUrl }),
        ...(record.bitableRecordId === undefined ? {} : { bitableRecordId: record.bitableRecordId }),
        syncDirty: record.syncDirty,
      }))

    return {
      enabled: settings.enabled,
      bitableAvailable: lookup.status,
      ...(lookup.status === 'incompatible' ? { bitableDetail: lookup.detail } : {}),
      syncing: this.inFlight !== undefined,
      totalCount: entries.length,
      dirtyCount,
      linkedCount,
      humanConfirmedCount,
      ...(this.lastSyncAt === undefined ? {} : { lastSyncAt: this.lastSyncAt }),
      ...(this.lastError === undefined ? {} : { lastError: this.lastError }),
      ...(this.lastCheck === undefined ? {} : { lastCheck: this.lastCheck }),
      items: sortedItems,
    }
  }
}
