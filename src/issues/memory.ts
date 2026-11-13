/**
 * 本地已知问题库（`IssueMemory`）：
 * - NFKC + 忽略大小写分词匹配检索，优先返回 `humanConclusion` / `humanStatus` 人工确认结论；
 * - 序列化分配稳定可复用的 `ISS-<app-slug>-NNNN` 编号，支持同批内新建问题标题去重；
 * - 所有 AI 写入严格经 {@link IssuesTable.upsertByAi}，绝不覆盖人工字段。
 *
 * @module dsh-logalyze/issues/memory
 */

import type { AiIssueUpsertInput, IssueAiStatus, IssueRecord, IssuesTable } from '../runtime/domain.ts'

/** One matched known issue returned by {@link searchIssues}. */
export interface SearchedIssue {
  readonly issueId: string
  readonly appId: string
  readonly title: string
  readonly matchCriteria: string
  readonly exclusionCriteria?: string
  readonly aiDiagnosis: string
  readonly aiStatus: IssueAiStatus
  readonly resolutionAdvice: string
  /** Human-confirmed root-cause/workaround conclusion (takes precedence over AI diagnosis). */
  readonly humanConclusion?: string
  readonly humanStatus?: string
  readonly assignee?: string
  readonly firstSeenAt: number
  readonly lastSeenAt: number
  readonly sampleReportUrl?: string
  readonly latestReportUrl?: string
  readonly fixMrUrl?: string
  readonly score: number
}

/** Input to {@link IssueMemory.upsertNewOrReuseByTitle}. */
export interface NewIssueDraft {
  readonly appId: string
  readonly title: string
  readonly matchCriteria: string
  readonly exclusionCriteria?: string
  readonly aiDiagnosis: string
  readonly aiStatus: IssueAiStatus
  readonly resolutionAdvice: string
  readonly seenAt: number
}

/** Normalize text with Unicode NFKC + trim + lowercase for reliable CJK/ASCII matching. */
export function normalizeSearchText(value: string): string {
  return value.normalize('NFKC').trim().toLowerCase()
}

/** Sanitize an application id into a lowercase ASCII slug for `ISS-<slug>-NNNN`. */
export function issueAppSlug(appId: string): string {
  const slug = appId
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 32)
  return slug === '' ? 'app' : slug
}

function tokenizeQuery(normalizedQuery: string): string[] {
  const parts = normalizedQuery
    .split(/[\s,;|(){}[\]<>"'`]+/gu)
    .map(part => part.trim())
    .filter(part => part.length > 0)
  return [...new Set(parts)]
}

function toSearchedIssue(issueId: string, record: IssueRecord, score: number): SearchedIssue {
  return {
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
    score,
  }
}

/**
 * Search `issues` using NFKC-normalized keyword ranking.
 * Always surfaces human-confirmed columns (`humanConclusion`, `humanStatus`, `assignee`).
 */
export function searchIssues(
  issues: IssuesTable,
  params: { readonly appId?: string; readonly query: string; readonly limit?: number },
): SearchedIssue[] {
  const limit = Math.min(30, Math.max(1, Math.trunc(params.limit ?? 10)))
  const candidates = params.appId === undefined
    ? issues.entries()
    : issues.listByApp(params.appId)

  const normQuery = normalizeSearchText(params.query)
  if (normQuery === '') {
    return candidates
      .sort((a, b) => b[1].lastSeenAt - a[1].lastSeenAt)
      .slice(0, limit)
      .map(([id, rec]) => toSearchedIssue(id, rec, 0))
  }

  const tokens = tokenizeQuery(normQuery)
  const scored: SearchedIssue[] = []

  for (const [id, rec] of candidates) {
    const idNorm = normalizeSearchText(id)
    const titleNorm = normalizeSearchText(rec.title)
    const matchNorm = normalizeSearchText(rec.matchCriteria)
    const exclNorm = normalizeSearchText(rec.exclusionCriteria ?? '')
    const diagNorm = normalizeSearchText(rec.aiDiagnosis)
    const adviceNorm = normalizeSearchText(rec.resolutionAdvice)
    const humanNorm = normalizeSearchText(rec.humanConclusion ?? '')

    let score = 0
    if (idNorm === normQuery) score += 100
    else if (idNorm.includes(normQuery)) score += 45

    if (titleNorm.includes(normQuery)) score += 40
    if (matchNorm.includes(normQuery)) score += 30
    if (humanNorm !== '' && humanNorm.includes(normQuery)) score += 35
    if (diagNorm.includes(normQuery)) score += 18

    for (const token of tokens) {
      let tokenMatched = false
      if (idNorm.includes(token)) {
        score += 25
        tokenMatched = true
      }
      if (titleNorm.includes(token)) {
        score += 15
        tokenMatched = true
      }
      if (matchNorm.includes(token)) {
        score += 12
        tokenMatched = true
      }
      if (humanNorm !== '' && humanNorm.includes(token)) {
        score += 15
        tokenMatched = true
      }
      if (diagNorm.includes(token)) {
        score += 8
        tokenMatched = true
      }
      if (adviceNorm.includes(token)) {
        score += 6
        tokenMatched = true
      }
      if (exclNorm !== '' && exclNorm.includes(token)) {
        score += 4
        tokenMatched = true
      }
      if (tokenMatched && rec.humanConclusion !== undefined) {
        score += 2
      }
    }

    if (score > 0) {
      scored.push(toSearchedIssue(id, rec, score))
    }
  }

  return scored
    .sort((a, b) => (b.score !== a.score ? b.score - a.score : b.lastSeenAt - a.lastSeenAt))
    .slice(0, limit)
}

/**
 * Compute the next monotonic `ISS-<app-slug>-NNNN` identifier for `appId`.
 * Callers creating records concurrently should serialize through {@link IssueMemory}.
 */
export function allocateIssueId(issues: IssuesTable, appId: string): string {
  const slug = issueAppSlug(appId)
  const prefix = `ISS-${slug}-`
  let maxNum = 0
  for (const key of issues.keys()) {
    if (!key.startsWith(prefix)) continue
    const suffix = key.slice(prefix.length)
    if (!/^\d+$/u.test(suffix)) continue
    const num = Number.parseInt(suffix, 10)
    if (Number.isSafeInteger(num) && num > maxNum) {
      maxNum = num
    }
  }
  return `${prefix}${String(maxNum + 1).padStart(4, '0')}`
}

/** Concurrency-safe coordinator around {@link IssuesTable} for issue search, id allocation, and AI upserts. */
export class IssueMemory {
  private readonly appLocks = new Map<string, Promise<unknown>>()

  constructor(readonly table: IssuesTable) {}

  private withAppLock<T>(appId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.appLocks.get(appId) ?? Promise.resolve()
    const next = previous.then(fn, fn)
    const cleanup = (): void => {
      if (this.appLocks.get(appId) === tracked) {
        this.appLocks.delete(appId)
      }
    }
    const tracked = next.then(() => undefined, () => undefined).then(cleanup, cleanup)
    this.appLocks.set(appId, tracked)
    return next
  }

  search(params: { readonly appId?: string; readonly query: string; readonly limit?: number }): SearchedIssue[] {
    return searchIssues(this.table, params)
  }

  /** Touch/update an existing issue via AI fields while strictly preserving human-owned fields. */
  async touchExisting(input: AiIssueUpsertInput): Promise<IssueRecord> {
    return this.table.upsertByAi(input)
  }

  /**
   * Allocate a new `ISS-<slug>-NNNN` or reuse an existing issue of the same `appId`
   * whose normalized title matches `draft.title` (preventing duplicate creations within
   * one batch or concurrent submits).
   */
  upsertNewOrReuseByTitle(draft: NewIssueDraft): Promise<{ readonly issueId: string; readonly record: IssueRecord; readonly created: boolean }> {
    return this.withAppLock(draft.appId, async () => {
      const normalizedTitle = normalizeSearchText(draft.title)
      for (const [existingId, existingRec] of this.table.listByApp(draft.appId)) {
        if (normalizeSearchText(existingRec.title) === normalizedTitle) {
          const updated = await this.table.upsertByAi({
            issueId: existingId,
            appId: draft.appId,
            title: existingRec.title,
            matchCriteria: existingRec.matchCriteria,
            ...(existingRec.exclusionCriteria === undefined ? {} : { exclusionCriteria: existingRec.exclusionCriteria }),
            aiDiagnosis: draft.aiDiagnosis,
            aiStatus: draft.aiStatus,
            resolutionAdvice: draft.resolutionAdvice,
            seenAt: draft.seenAt,
          })
          return { issueId: existingId, record: updated, created: false }
        }
      }
      const issueId = allocateIssueId(this.table, draft.appId)
      const created = await this.table.upsertByAi({
        issueId,
        appId: draft.appId,
        title: draft.title,
        matchCriteria: draft.matchCriteria,
        ...(draft.exclusionCriteria === undefined ? {} : { exclusionCriteria: draft.exclusionCriteria }),
        aiDiagnosis: draft.aiDiagnosis,
        aiStatus: draft.aiStatus,
        resolutionAdvice: draft.resolutionAdvice,
        seenAt: draft.seenAt,
      })
      return { issueId, record: created, created: true }
    })
  }
}
