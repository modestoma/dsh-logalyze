/**
 * MR 增量信号分类与自触发防护：
 * - 统一规范 Bot 身份匹配（忽略大小写，兼容 GitHub App `[bot]` 后缀）；
 * - 严格按 `targetBranch`、`ignoreLabels` 与 `skipDraft` 过滤；
 * - 精确计算新提交、新人类讨论、草稿转正式、CI 失败（仅己方 MR）与合并冲突信号；
 * - 仅将已投递的人类评论与 Bot 自身生成的评论写入已读集合，绝不吞掉回合进行中到达的新人类评论。
 *
 * @module dsh-logalyze/mr/signals
 */

import type { CommentInfo, MrDetail, MrDiscussion, MrInfo, MrStatus, RepoUser } from '../deps/repos-contract.ts'
import type { MrPendingSignal, SupervisedMrRecord, SupervisedMrState } from '../runtime/domain.ts'
import type { MrRepoStatusWire, MrReviewSettings } from '../settings/contract.ts'

/** Maximum number of seen note keys retained per MR record to keep storage bounded. */
export const MAX_SEEN_NOTE_IDS = 500

/** Maximum number of own-pushed commit SHAs retained per MR record. */
export const MAX_OWN_PUSHED_SHAS = 100

/** Normalize a username/name handle for bot comparison (case-insensitive, strip `[bot]` suffix). */
export function normalizeBotHandle(value: string): string {
  return value.trim().toLowerCase().replace(/\[bot\]$/u, '')
}

/** Whether a comment/discussion author is the plugin's own bot identity. */
export function isSameBotUser(author: RepoUser | undefined, bot: RepoUser | undefined): boolean {
  if (author === undefined || bot === undefined) return false
  const authorHandle = normalizeBotHandle(author.username)
  const botHandle = normalizeBotHandle(bot.username)
  if (authorHandle !== '' && authorHandle === botHandle) return true
  if (author.webUrl !== undefined && bot.webUrl !== undefined && author.webUrl !== '' && author.webUrl === bot.webUrl) {
    return true
  }
  return false
}

/** Canonical dedupe key for a discussion thread note. */
export function canonicalDiscussionNoteKey(discussionId: string, noteId: string): string {
  return `d:${discussionId}:${noteId}`
}

/** Canonical dedupe key for a top-level MR conversation comment. */
export function canonicalCommentKey(commentId: string): string {
  return `c:${commentId}`
}

/** Append unique keys to a bounded FIFO list (preserving insertion order, retaining newest `limit`). */
export function appendBoundedUnique(existing: readonly string[] | undefined, additions: readonly string[], limit: number): string[] {
  const seen = new Set<string>(existing ?? [])
  for (const item of additions) {
    if (item !== '') seen.add(item)
  }
  const list = [...seen]
  return list.length <= limit ? list : list.slice(list.length - limit)
}

/** Lexicographically maximum ISO-8601 timestamp string, if any. */
export function maxIsoTimestamp(values: readonly (string | undefined)[]): string | undefined {
  let max: string | undefined
  for (const value of values) {
    if (value === undefined || value === '') continue
    if (max === undefined || value > max) max = value
  }
  return max
}

export type MrIgnoreReason = 'target-branch' | 'ignored-label' | 'draft'

/** Decide whether an MR is excluded from review by repo branch filter, labels, or draft status. */
export function evaluateMrFilter(
  mr: MrInfo,
  repo: MrRepoStatusWire,
  settings: Pick<MrReviewSettings, 'skipDraft' | 'ignoreLabels'>,
): { readonly skip: false } | { readonly skip: true; readonly reason: MrIgnoreReason } {
  if (repo.targetBranch !== undefined && mr.targetBranch !== repo.targetBranch) {
    return { skip: true, reason: 'target-branch' }
  }
  if (settings.ignoreLabels.length > 0 && mr.labels.length > 0) {
    const ignored = new Set(settings.ignoreLabels.map(label => label.trim().toLowerCase()).filter(Boolean))
    for (const label of mr.labels) {
      if (ignored.has(label.trim().toLowerCase())) {
        return { skip: true, reason: 'ignored-label' }
      }
    }
  }
  if (settings.skipDraft && mr.draft) {
    return { skip: true, reason: 'draft' }
  }
  return { skip: false }
}

/** Normalized human note extracted from discussions or top-level MR comments. */
export interface HumanNoteEvent {
  readonly key: string
  readonly kind: 'discussion-note' | 'comment'
  readonly discussionId?: string
  readonly noteId: string
  readonly author: string
  readonly body: string
  readonly createdAt: string
  readonly path?: string
  readonly newLine?: number
  readonly oldLine?: number
}

function isNewNote(
  key: string,
  createdAt: string,
  seenSet: ReadonlySet<string>,
  pendingNoteKeys: ReadonlySet<string>,
  lastNoteCursor: string | undefined,
): boolean {
  if (seenSet.has(key) || pendingNoteKeys.has(key)) return false
  // When `seenSet` reached its bounded cap, rely on `lastNoteCursor` to avoid replaying ancient history.
  if (seenSet.size >= MAX_SEEN_NOTE_IDS && lastNoteCursor !== undefined && createdAt <= lastNoteCursor) {
    return false
  }
  return true
}

/** Collect unseen human-authored notes from discussions and top-level comments. */
export function collectHumanFeedbackNotes(
  detail: Pick<MrDetail, 'comments'>,
  discussions: readonly MrDiscussion[],
  bot: RepoUser,
  seenNoteIds: readonly string[] | undefined,
  pendingSignals: readonly MrPendingSignal[] | undefined,
  lastNoteCursor: string | undefined,
): HumanNoteEvent[] {
  const seenSet = new Set(seenNoteIds ?? [])
  const pendingKeys = new Set<string>()
  for (const signal of pendingSignals ?? []) {
    if (signal.kind !== 'discussion' || signal.noteId === undefined) continue
    pendingKeys.add(
      signal.discussionId !== undefined
        ? canonicalDiscussionNoteKey(signal.discussionId, signal.noteId)
        : canonicalCommentKey(signal.noteId),
    )
  }

  const found: HumanNoteEvent[] = []
  for (const discussion of discussions) {
    for (const note of discussion.notes) {
      if (isSameBotUser(note.author, bot)) continue
      const key = canonicalDiscussionNoteKey(discussion.id, note.id)
      if (!isNewNote(key, note.createdAt, seenSet, pendingKeys, lastNoteCursor)) continue
      found.push({
        key,
        kind: 'discussion-note',
        discussionId: discussion.id,
        noteId: note.id,
        author: note.author.username,
        body: note.body,
        createdAt: note.createdAt,
        ...(discussion.position?.path === undefined ? {} : { path: discussion.position.path }),
        ...(discussion.position?.newLine === undefined ? {} : { newLine: discussion.position.newLine }),
        ...(discussion.position?.oldLine === undefined ? {} : { oldLine: discussion.position.oldLine }),
      })
    }
  }

  for (const comment of detail.comments) {
    if (isSameBotUser(comment.author, bot)) continue
    const key = canonicalCommentKey(comment.id)
    if (!isNewNote(key, comment.createdAt, seenSet, pendingKeys, lastNoteCursor)) continue
    found.push({
      key,
      kind: 'comment',
      noteId: comment.id,
      author: comment.author.username,
      body: comment.body,
      createdAt: comment.createdAt,
    })
  }

  return found.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}

/** Collect canonical keys for all bot-authored notes currently present on the MR. */
export function collectBotNoteKeys(
  detail: Pick<MrDetail, 'comments'> | undefined,
  discussions: readonly MrDiscussion[],
  bot: RepoUser,
): { readonly keys: string[]; readonly latestTimestamp?: string } {
  const keys: string[] = []
  const timestamps: string[] = []
  for (const discussion of discussions) {
    for (const note of discussion.notes) {
      if (!isSameBotUser(note.author, bot)) continue
      keys.push(canonicalDiscussionNoteKey(discussion.id, note.id))
      timestamps.push(note.createdAt)
    }
  }
  for (const comment of detail?.comments ?? []) {
    if (!isSameBotUser(comment.author, bot)) continue
    keys.push(canonicalCommentKey(comment.id))
    timestamps.push(comment.createdAt)
  }
  const latestTimestamp = maxIsoTimestamp(timestamps)
  return { keys, ...(latestTimestamp === undefined ? {} : { latestTimestamp }) }
}

/** Result of evaluating one polled MR against its stored state. */
export interface PollClassification {
  readonly action: 'skip' | 'update'
  readonly nextState?: SupervisedMrState
  readonly signals: MrPendingSignal[]
  readonly clearPending?: boolean
  readonly resetOwnHeadSeen?: boolean
  readonly notifiedConflictSha?: string
}

/** Determine state transition and new pending signals for a single polled MR. */
export function classifyMrPollUpdate(input: {
  readonly existing: SupervisedMrRecord | undefined
  readonly mr: MrInfo
  readonly detail: MrDetail
  readonly discussions: readonly MrDiscussion[]
  readonly status: MrStatus
  readonly bot: RepoUser
  readonly repo: MrRepoStatusWire
  readonly settings: Pick<MrReviewSettings, 'skipDraft' | 'ignoreLabels'>
  readonly nowMs: number
}): PollClassification {
  const { existing, mr, detail, discussions, status, bot, repo, settings, nowMs } = input

  if (mr.state === 'merged' || mr.state === 'closed') {
    if (existing === undefined) return { action: 'skip', signals: [] }
    return { action: 'update', nextState: mr.state, signals: [], clearPending: true }
  }

  const filter = evaluateMrFilter(mr, repo, settings)
  if (filter.skip) {
    if (filter.reason === 'draft') {
      return { action: 'update', nextState: 'draft_skipped', signals: [], clearPending: true }
    }
    return { action: 'skip', signals: [] }
  }

  const origin = existing?.origin ?? 'external'
  const signals: MrPendingSignal[] = []
  const existingPending = existing?.pendingSignals ?? []

  if (existing === undefined) {
    // New externally created MR; self-fix/self-skill MRs registered upfront already have a record.
    signals.push({ kind: 'opened', observedAt: nowMs, headSha: mr.headSha })
  } else if (existing.state === 'draft_skipped') {
    signals.push({ kind: 'ready-for-review', observedAt: nowMs, headSha: mr.headSha })
  } else if (mr.headSha !== existing.headSha && mr.headSha !== existing.lastReviewedSha) {
    const ownSet = new Set(existing.ownPushedShas)
    if (!ownSet.has(mr.headSha)) {
      const alreadyPendingPush = existingPending.some(
        sig => (sig.kind === 'push' || sig.kind === 'opened' || sig.kind === 'ready-for-review') && sig.headSha === mr.headSha,
      )
      if (!alreadyPendingPush) {
        signals.push({ kind: 'push', observedAt: nowMs, headSha: mr.headSha })
      }
    }
  }

  // Only detect human feedback once an MR is tracked (initial review reads all existing comments in context).
  if (existing !== undefined && existing.state !== 'draft_skipped') {
    const notes = collectHumanFeedbackNotes(
      detail,
      discussions,
      bot,
      existing.seenNoteIds,
      existingPending,
      existing.lastNoteCursor,
    )
    for (const note of notes) {
      const location = note.path !== undefined
        ? `${note.path}${note.newLine !== undefined ? `:${note.newLine}` : note.oldLine !== undefined ? `:${note.oldLine}` : ''}`
        : undefined
      signals.push({
        kind: 'discussion',
        observedAt: nowMs,
        headSha: mr.headSha,
        ...(note.discussionId === undefined ? {} : { discussionId: note.discussionId }),
        noteId: note.noteId,
        summary: `${note.author}${location !== undefined ? ` (${location})` : ''}: ${note.body.slice(0, 120)}`,
      })
    }
  }

  if ((origin === 'self-fix' || origin === 'self-skill') && status.overall === 'failure' && status.headSha === mr.headSha) {
    const alreadyPendingCi = existingPending.some(sig => sig.kind === 'ci-failed' && sig.headSha === mr.headSha)
    if (!alreadyPendingCi) {
      const failedNames = status.checks.filter(c => c.state === 'failure').map(c => c.name).slice(0, 5)
      signals.push({
        kind: 'ci-failed',
        observedAt: nowMs,
        headSha: mr.headSha,
        summary: failedNames.length > 0 ? failedNames.join(', ') : 'CI check failed',
      })
    }
  }

  let notifiedConflictSha: string | undefined
  if (status.mergeable === false && existing?.notifiedConflictSha !== mr.headSha) {
    const alreadyPendingConflict = existingPending.some(sig => sig.kind === 'conflict' && sig.headSha === mr.headSha)
    if (!alreadyPendingConflict) {
      signals.push({
        kind: 'conflict',
        observedAt: nowMs,
        headSha: mr.headSha,
        summary: `${mr.sourceBranch} -> ${mr.targetBranch} has merge conflicts`,
      })
      notifiedConflictSha = mr.headSha
    }
  }

  return {
    action: 'update',
    nextState: 'open',
    signals,
    ...(notifiedConflictSha === undefined ? {} : { notifiedConflictSha }),
  }
}

/** Merge newly observed signals into existing pending signals, keeping order and deduplicating identical keys. */
export function mergePendingSignals(
  existing: readonly MrPendingSignal[],
  incoming: readonly MrPendingSignal[],
): MrPendingSignal[] {
  const merged = [...existing]
  for (const sig of incoming) {
    const duplicate = merged.some(prev =>
      prev.kind === sig.kind
      && prev.headSha === sig.headSha
      && prev.discussionId === sig.discussionId
      && prev.noteId === sig.noteId,
    )
    if (!duplicate) merged.push(sig)
  }
  return merged
}

/** Canonical note keys represented in a batch of pending signals (for exact seen-note accounting). */
export function signalNoteKeys(signals: readonly MrPendingSignal[]): string[] {
  const keys: string[] = []
  for (const sig of signals) {
    if (sig.kind !== 'discussion' || sig.noteId === undefined) continue
    keys.push(
      sig.discussionId !== undefined
        ? canonicalDiscussionNoteKey(sig.discussionId, sig.noteId)
        : canonicalCommentKey(sig.noteId),
    )
  }
  return keys
}

export function extractCommentSummary(comments: readonly CommentInfo[], bot: RepoUser): string[] {
  return comments
    .filter(c => !isSameBotUser(c.author, bot))
    .map(c => `@${c.author.username} (${c.createdAt}): ${c.body}`)
}
