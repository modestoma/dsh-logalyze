/**
 * 审微 MR 监管工具集（`supervisor_mr_*`）：
 * - 全部工具均使用纯 JSON Schema 声明入参与出参，并在 `execute()` 中通过 Zod 严格校验；
 * - 仅向非委派且绑定了受监管 MR 的会话开放（或显式传入 `repo` + `mrNumber`）；
 * - 严格遵守自触发防护铁律：`supervisor_mr_publish_review` 仅记录 Bot 自身刚发表的评论 ID
 *   与本轮已投递人类评论（`deliveredNoteIds`），绝不抓取回合进行中到达的新人类评论。
 *
 * @module dsh-logalyze/mr/tools
 */

import { z } from 'zod'
import type { DshReposV8, MrDiscussion } from '../deps/repos-contract.ts'
import type { ToolDefinition, ToolRunContext } from '../host.ts'
import type { SupervisedMrRecord } from '../runtime/domain.ts'
import { topLevelAgent } from '../runs/run-dir.ts'
import {
  MR_CHECKPOINT_TOOL_NAME,
  MR_PREPARE_TOOL_NAME,
  MR_PUBLISH_REVIEW_TOOL_NAME,
  MR_REPLY_THREAD_TOOL_NAME,
  MR_RESOLVE_THREAD_TOOL_NAME,
} from '../tool-names.ts'
import {
  MAX_OWN_PUSHED_SHAS,
  MAX_SEEN_NOTE_IDS,
  advanceHumanNoteWatermark,
  appendBoundedUnique,
  canonicalCommentKey,
  canonicalDiscussionNoteKey,
  collectBotNoteKeys,
} from './signals.ts'
import { ensureMrWorkspace } from './workspace.ts'

/** Runtime capabilities required by the `supervisor_mr_*` tools. */
export interface MrToolsRuntime {
  requireV8(): DshReposV8
  workspacesRoot(): string
  resolveForTool(sessionId: string, repo?: string, mrNumber?: number): SupervisedMrRecord
  updateRecord(repo: string, mrNumber: number, updater: (current: SupervisedMrRecord) => SupervisedMrRecord): Promise<SupervisedMrRecord>
}

const MAX_DISCUSSION_PAGES = 100

/** Paginate `mrDiscussions` up to a bounded page count. */
export async function listAllDiscussions(
  repos: DshReposV8,
  repo: string,
  mrNumber: number,
  signal?: AbortSignal,
): Promise<MrDiscussion[]> {
  const all: MrDiscussion[] = []
  let page = 1
  for (let i = 0; i < MAX_DISCUSSION_PAGES; i += 1) {
    const res = await repos.mrDiscussions({ repo, number: mrNumber, page, perPage: 100, signal })
    all.push(...res.items)
    if (res.nextPage === undefined || res.items.length === 0 || res.nextPage <= page) break
    page = res.nextPage
  }
  return all
}

const prepareArgsSchema = z.object({
  repo: z.string().trim().min(1).optional(),
  mrNumber: z.number().int().positive().optional(),
}).strict()

const inlineCommentSchema = z.object({
  path: z.string().trim().min(1),
  newLine: z.number().int().positive().optional(),
  oldLine: z.number().int().positive().optional(),
  body: z.string().trim().min(1),
}).strict().refine(
  c => c.newLine !== undefined || c.oldLine !== undefined,
  '行级评论必须至少提供 newLine 或 oldLine 之一',
)

const publishReviewArgsSchema = z.object({
  repo: z.string().trim().min(1).optional(),
  mrNumber: z.number().int().positive().optional(),
  headSha: z.string().trim().min(1),
  verdict: z.enum(['approve', 'request-changes', 'comment']),
  body: z.string().optional(),
  comments: z.array(inlineCommentSchema).max(50).optional(),
  resolveDiscussionIds: z.array(z.string().trim().min(1)).optional(),
}).strict().refine(
  args => (args.body !== undefined && args.body.trim() !== '') || (args.verdict === 'comment' && (args.comments?.length ?? 0) > 0),
  '非 comment 结论或空行级评论时必须填写 body',
)

const replyThreadArgsSchema = z.object({
  repo: z.string().trim().min(1).optional(),
  mrNumber: z.number().int().positive().optional(),
  discussionId: z.string().trim().min(1),
  body: z.string().trim().min(1),
}).strict()

const resolveThreadArgsSchema = z.object({
  repo: z.string().trim().min(1).optional(),
  mrNumber: z.number().int().positive().optional(),
  discussionId: z.string().trim().min(1),
  resolved: z.boolean().default(true),
}).strict()

const checkpointArgsSchema = z.object({
  repo: z.string().trim().min(1).optional(),
  mrNumber: z.number().int().positive().optional(),
  reviewedSha: z.string().trim().min(1).optional(),
  ownPushedSha: z.string().trim().min(1).optional(),
  markDeliveredNotesSeen: z.boolean().default(true),
}).strict()

function parseOrThrow<T>(schema: z.ZodType<T>, raw: unknown, toolName: string): T {
  const parsed = schema.safeParse(raw ?? {})
  if (!parsed.success) {
    const first = parsed.error.issues[0]
    const where = first?.path.length ? `${first.path.join('.')}: ` : ''
    throw new Error(`${toolName} 参数不合法：${where}${first?.message ?? parsed.error.message}`)
  }
  return parsed.data
}

function targetPropsJson(): Record<string, unknown> {
  return {
    repo: { type: 'string', description: '可选：仓库地址（默认自动解析当前会话绑定的 MR）。' },
    mrNumber: { type: 'integer', minimum: 1, description: '可选：MR 编号（默认自动解析当前会话绑定的 MR）。' },
  }
}

function resolveTarget(runtime: MrToolsRuntime, exec: ToolRunContext, toolName: string, requested?: { repo?: string; mrNumber?: number }): SupervisedMrRecord {
  const agent = topLevelAgent(exec, toolName)
  return runtime.resolveForTool(agent.session.header.id, requested?.repo, requested?.mrNumber)
}

/** Build the 5 `supervisor_mr_*` tool definitions. */
export function createMrTools(runtime: MrToolsRuntime): ToolDefinition[] {
  const prepareTool: ToolDefinition<{
    readonly repo: string
    readonly mrNumber: number
    readonly origin: SupervisedMrRecord['origin']
    readonly workDir: string
    readonly headSha: string
    readonly lastReviewedSha?: string
    readonly hasConflicts: boolean
    readonly overallCi: string
    readonly incrementalDiff?: string
    readonly fullDiff: string
    readonly diffTruncated: boolean
    readonly discussions: readonly MrDiscussion[]
    readonly gitWarning?: string
  }> = {
    name: MR_PREPARE_TOOL_NAME,
    description: '准备或刷新当前受监管 MR 的本地 Git 工作区，并获取增量 diff、全量 diff、CI 状态与未解决讨论线程。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: targetPropsJson(),
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          repo: { type: 'string' },
          mrNumber: { type: 'integer' },
          origin: { type: 'string' },
          workDir: { type: 'string' },
          headSha: { type: 'string' },
          lastReviewedSha: { type: 'string' },
          hasConflicts: { type: 'boolean' },
          overallCi: { type: 'string' },
          incrementalDiff: { type: 'string' },
          fullDiff: { type: 'string' },
          diffTruncated: { type: 'boolean' },
          discussions: { type: 'array' },
          gitWarning: { type: 'string' },
        },
        required: ['repo', 'mrNumber', 'origin', 'workDir', 'headSha', 'hasConflicts', 'overallCi', 'fullDiff', 'diffTruncated', 'discussions'],
      },
      render(_args, value) {
        const lines = [
          `已准备 MR 工作区：\`${value.workDir}\``,
          `- 仓库：${value.repo} #${value.mrNumber}（${value.origin}）`,
          `- 提交：\`${value.headSha}\`${value.lastReviewedSha === undefined ? '（首次评审）' : `（上次已审 \`${value.lastReviewedSha}\`）`}`,
          `- CI 总状态：\`${value.overallCi}\` | 合并冲突：${value.hasConflicts ? '是（禁止自动 rebase）' : '否'}`,
        ]
        if (value.gitWarning !== undefined) lines.push(`- 工作区提示：${value.gitWarning}`)
        lines.push(`- 讨论线程数：${value.discussions.length}（未解决：${value.discussions.filter(d => d.resolvable && !d.resolved).length}）`)
        if (value.incrementalDiff !== undefined) {
          lines.push('', '### 增量 Diff (`lastReviewedSha..headSha`)', '```diff', value.incrementalDiff.slice(0, 12000), '```')
        }
        if (value.discussions.length > 0) {
          lines.push('', '### 讨论线程摘要')
          for (const d of value.discussions.slice(0, 30)) {
            const loc = d.position !== undefined
              ? `${d.position.path}${d.position.newLine !== undefined ? `:${d.position.newLine}` : d.position.oldLine !== undefined ? `:${d.position.oldLine}` : ''}`
              : '顶层讨论'
            const latest = d.notes[d.notes.length - 1]
            lines.push(`- [${d.resolved ? '已解决' : '未解决'}] id=\`${d.id}\` (${loc}) ${latest === undefined ? '' : `@${latest.author.username}: ${latest.body.slice(0, 160)}`}`)
          }
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(raw, exec) {
      const args = parseOrThrow(prepareArgsSchema, raw, MR_PREPARE_TOOL_NAME)
      const record = resolveTarget(runtime, exec, MR_PREPARE_TOOL_NAME, args)
      const repos = runtime.requireV8()
      const [mr, status, discussions, fullDiffRes] = await Promise.all([
        repos.mrGet({ repo: record.repo, number: record.mrNumber, signal: exec.signal }),
        repos.mrStatus({ repo: record.repo, number: record.mrNumber, signal: exec.signal }),
        listAllDiscussions(repos, record.repo, record.mrNumber, exec.signal),
        repos.mrDiff({ repo: record.repo, number: record.mrNumber, signal: exec.signal }),
      ])
      let incrementalDiff: string | undefined
      if (record.lastReviewedSha !== undefined && record.lastReviewedSha !== mr.headSha) {
        try {
          const cmp = await repos.mrCompare({
            repo: record.repo,
            baseSha: record.lastReviewedSha,
            headSha: mr.headSha,
            signal: exec.signal,
          })
          incrementalDiff = cmp.diff
        } catch {
          // Force-push or unreachable base commit falls back cleanly to full diff.
          incrementalDiff = undefined
        }
      }
      const ws = await ensureMrWorkspace({
        repos,
        workspacesRoot: runtime.workspacesRoot(),
        repo: record.repo,
        mr,
        origin: record.origin,
        existingWorkDir: record.workDir,
        lastReviewedSha: record.lastReviewedSha,
        signal: exec.signal,
      })
      await runtime.updateRecord(record.repo, record.mrNumber, current => ({
        ...current,
        workDir: ws.workDir,
        title: mr.title || current.title,
        url: mr.webUrl || current.url,
        sourceBranch: mr.sourceBranch || current.sourceBranch,
        author: mr.author.username || current.author,
        updatedAt: Date.now(),
      }))
      return {
        repo: record.repo,
        mrNumber: record.mrNumber,
        origin: record.origin,
        workDir: ws.workDir,
        headSha: mr.headSha,
        ...(record.lastReviewedSha === undefined ? {} : { lastReviewedSha: record.lastReviewedSha }),
        hasConflicts: status.mergeable === false,
        overallCi: status.overall,
        ...(incrementalDiff === undefined ? {} : { incrementalDiff }),
        fullDiff: fullDiffRes.diff,
        diffTruncated: fullDiffRes.truncated,
        discussions,
        ...(ws.gitWarning === undefined ? {} : { gitWarning: ws.gitWarning }),
      }
    },
  }

  const publishReviewTool: ToolDefinition<{
    readonly verdict: string
    readonly downgradedVerdict?: boolean
    readonly postedComments: number
    readonly fallbackInlineCount: number
    readonly webUrl?: string
    readonly recordedLastReviewedSha: string
  }> = {
    name: MR_PUBLISH_REVIEW_TOOL_NAME,
    description: '向 GitHub/GitLab 发布结构化 MR 代码评审结论与行级评论，并原子登记 Bot 自身评论 ID 与已审提交游标。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['headSha', 'verdict'],
      properties: {
        ...targetPropsJson(),
        headSha: { type: 'string', description: '本次评审对应的 head commit SHA。' },
        verdict: { type: 'string', enum: ['approve', 'request-changes', 'comment'] },
        body: { type: 'string', description: '总体评审总结（Markdown）。' },
        comments: {
          type: 'array',
          maxItems: 50,
          description: '行级代码评论列表（最多 50 条）。',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['path', 'body'],
            properties: {
              path: { type: 'string' },
              newLine: { type: 'integer', minimum: 1 },
              oldLine: { type: 'integer', minimum: 1 },
              body: { type: 'string' },
            },
          },
        },
        resolveDiscussionIds: {
          type: 'array',
          items: { type: 'string' },
          description: '可选：同时标为已解决的讨论线程 ID 列表。',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          verdict: { type: 'string' },
          downgradedVerdict: { type: 'boolean' },
          postedComments: { type: 'integer' },
          fallbackInlineCount: { type: 'integer' },
          webUrl: { type: 'string' },
          recordedLastReviewedSha: { type: 'string' },
        },
        required: ['verdict', 'postedComments', 'fallbackInlineCount', 'recordedLastReviewedSha'],
      },
      render(_args, value) {
        return [{
          type: 'text',
          text: `已发布 MR 评审：verdict=${value.verdict}${value.downgradedVerdict ? '（己方 MR 自动降级为 comment）' : ''}，行级评论 ${value.postedComments} 条（折叠回退 ${value.fallbackInlineCount} 条），已更新 lastReviewedSha=${value.recordedLastReviewedSha.slice(0, 8)}。`,
        }]
      },
    },
    async execute(raw, exec) {
      const args = parseOrThrow(publishReviewArgsSchema, raw, MR_PUBLISH_REVIEW_TOOL_NAME)
      const record = resolveTarget(runtime, exec, MR_PUBLISH_REVIEW_TOOL_NAME, args)
      const repos = runtime.requireV8()
      const reviewRes = await repos.mrReview({
        repo: record.repo,
        number: record.mrNumber,
        headSha: args.headSha,
        verdict: args.verdict,
        ...(args.body === undefined ? {} : { body: args.body }),
        ...(args.comments === undefined ? {} : { comments: args.comments }),
        signal: exec.signal,
      })

      for (const discussionId of args.resolveDiscussionIds ?? []) {
        await repos.mrDiscussionResolve({
          repo: record.repo,
          number: record.mrNumber,
          discussionId,
          resolved: true,
          signal: exec.signal,
        })
      }

      // Self-trigger iron law: record ONLY bot-authored note keys + deliveredNoteIds from this turn.
      const [botRes, discRes, detailRes] = await Promise.allSettled([
        repos.currentBotUser({ repo: record.repo, signal: exec.signal }),
        listAllDiscussions(repos, record.repo, record.mrNumber, exec.signal),
        repos.mrGet({ repo: record.repo, number: record.mrNumber, signal: exec.signal }),
      ])

      const botNotes = botRes.status === 'fulfilled' && discRes.status === 'fulfilled'
        ? collectBotNoteKeys(detailRes.status === 'fulfilled' ? detailRes.value : undefined, discRes.value, botRes.value)
        : { keys: [] as string[], latestTimestamp: undefined }

      await runtime.updateRecord(record.repo, record.mrNumber, (current) => {
        const nextSeen = appendBoundedUnique(
          current.seenNoteIds,
          [...botNotes.keys, ...(current.deliveredNoteIds ?? [])],
          MAX_SEEN_NOTE_IDS,
        )
        const nextSeenSet = new Set(nextSeen)
        const nextPending = current.pendingSignals.filter((sig) => {
          if (sig.kind === 'opened' || sig.kind === 'ready-for-review' || sig.kind === 'push' || sig.kind === 'conflict') {
            return sig.headSha !== undefined && sig.headSha !== args.headSha && sig.headSha !== current.reviewedHeadSha
          }
          if (sig.kind === 'discussion' && sig.noteId !== undefined) {
            const noteKey = sig.discussionId !== undefined
              ? canonicalDiscussionNoteKey(sig.discussionId, sig.noteId)
              : canonicalCommentKey(sig.noteId)
            return !nextSeenSet.has(noteKey)
          }
          return true
        })
        const nextCursor = botRes.status === 'fulfilled' && discRes.status === 'fulfilled' && detailRes.status === 'fulfilled'
          ? advanceHumanNoteWatermark({
              detail: detailRes.value,
              discussions: discRes.value,
              bot: botRes.value,
              previousSeenNoteIds: current.seenNoteIds,
              nextSeenNoteIds: nextSeen,
              pendingSignals: nextPending,
              deliveredNoteIds: undefined,
              previousCursor: current.lastNoteCursor,
            })
          : current.lastNoteCursor
        return {
          ...current,
          lastReviewedSha: args.headSha,
          reviewedHeadSha: args.headSha,
          ...(nextSeen.length === 0 ? {} : { seenNoteIds: nextSeen }),
          ...(nextCursor === undefined ? {} : { lastNoteCursor: nextCursor }),
          deliveredNoteIds: undefined,
          pendingSignals: nextPending,
          dueAt: nextPending.length > 0 ? current.dueAt : undefined,
          updatedAt: Date.now(),
        }
      })

      return {
        verdict: reviewRes.verdict,
        ...(reviewRes.downgradedVerdict === undefined ? {} : { downgradedVerdict: reviewRes.downgradedVerdict }),
        postedComments: reviewRes.postedComments,
        fallbackInlineCount: reviewRes.fallbackInlineCount,
        ...(reviewRes.webUrl === undefined ? {} : { webUrl: reviewRes.webUrl }),
        recordedLastReviewedSha: args.headSha,
      }
    },
  }

  const replyThreadTool: ToolDefinition<{ readonly discussionId: string; readonly noteId: string; readonly createdAt: string }> = {
    name: MR_REPLY_THREAD_TOOL_NAME,
    description: '回复 MR 中的指定讨论线程，并立刻将 Bot 生成的 noteId 写入已读集合以避免自触发。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['discussionId', 'body'],
      properties: {
        ...targetPropsJson(),
        discussionId: { type: 'string' },
        body: { type: 'string' },
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          discussionId: { type: 'string' },
          noteId: { type: 'string' },
          createdAt: { type: 'string' },
        },
        required: ['discussionId', 'noteId', 'createdAt'],
      },
      render(_args, value) {
        return [{ type: 'text', text: `已回复讨论线程 \`${value.discussionId}\`（noteId=\`${value.noteId}\`）。` }]
      },
    },
    async execute(raw, exec) {
      const args = parseOrThrow(replyThreadArgsSchema, raw, MR_REPLY_THREAD_TOOL_NAME)
      const record = resolveTarget(runtime, exec, MR_REPLY_THREAD_TOOL_NAME, args)
      const repos = runtime.requireV8()
      const note = await repos.mrDiscussionReply({
        repo: record.repo,
        number: record.mrNumber,
        discussionId: args.discussionId,
        body: args.body,
        signal: exec.signal,
      })
      const noteKey = canonicalDiscussionNoteKey(args.discussionId, note.id)
      await runtime.updateRecord(record.repo, record.mrNumber, (current) => {
        const nextSeen = appendBoundedUnique(current.seenNoteIds, [noteKey], MAX_SEEN_NOTE_IDS)
        return {
          ...current,
          seenNoteIds: nextSeen,
          updatedAt: Date.now(),
        }
      })
      return { discussionId: args.discussionId, noteId: note.id, createdAt: note.createdAt }
    },
  }

  const resolveThreadTool: ToolDefinition<{ readonly discussionId: string; readonly resolved: boolean }> = {
    name: MR_RESOLVE_THREAD_TOOL_NAME,
    description: '在复核通过或回应完毕后，将指定 MR 讨论线程标记为已解决（或重新打开）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['discussionId'],
      properties: {
        ...targetPropsJson(),
        discussionId: { type: 'string' },
        resolved: { type: 'boolean', default: true },
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          discussionId: { type: 'string' },
          resolved: { type: 'boolean' },
        },
        required: ['discussionId', 'resolved'],
      },
      render(_args, value) {
        return [{ type: 'text', text: `讨论线程 \`${value.discussionId}\` 已${value.resolved ? '标记为已解决' : '重新打开'}。` }]
      },
    },
    async execute(raw, exec) {
      const args = parseOrThrow(resolveThreadArgsSchema, raw, MR_RESOLVE_THREAD_TOOL_NAME)
      const record = resolveTarget(runtime, exec, MR_RESOLVE_THREAD_TOOL_NAME, args)
      const repos = runtime.requireV8()
      await repos.mrDiscussionResolve({
        repo: record.repo,
        number: record.mrNumber,
        discussionId: args.discussionId,
        resolved: args.resolved,
        signal: exec.signal,
      })
      await runtime.updateRecord(record.repo, record.mrNumber, current => ({ ...current, updatedAt: Date.now() }))
      return { discussionId: args.discussionId, resolved: args.resolved }
    },
  }

  const checkpointTool: ToolDefinition<{
    readonly lastReviewedSha?: string
    readonly ownPushedCount: number
    readonly seenCount: number
  }> = {
    name: MR_CHECKPOINT_TOOL_NAME,
    description: '记录已查看的人类讨论游标与己方推送的提交 SHA（ownPushedSha），避免自触发循环或重复重审。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ...targetPropsJson(),
        reviewedSha: { type: 'string', description: '可选：标记为已核查的提交 SHA。' },
        ownPushedSha: { type: 'string', description: '可选：己方刚推送的新提交 SHA，加入自触发防护白名单。' },
        markDeliveredNotesSeen: { type: 'boolean', default: true, description: '是否将本轮投递的人类评论标记为已读。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          lastReviewedSha: { type: 'string' },
          ownPushedCount: { type: 'integer' },
          seenCount: { type: 'integer' },
        },
        required: ['ownPushedCount', 'seenCount'],
      },
      render(_args, value) {
        return [{
          type: 'text',
          text: `已更新 MR 检查点（ownPushedShas=${value.ownPushedCount}，seenNoteIds=${value.seenCount}${value.lastReviewedSha === undefined ? '' : `，lastReviewedSha=${value.lastReviewedSha.slice(0, 8)}`}）。`,
        }]
      },
    },
    async execute(raw, exec) {
      const args = parseOrThrow(checkpointArgsSchema, raw, MR_CHECKPOINT_TOOL_NAME)
      const record = resolveTarget(runtime, exec, MR_CHECKPOINT_TOOL_NAME, args)
      const updated = await runtime.updateRecord(record.repo, record.mrNumber, (current) => {
        const nextOwn = args.ownPushedSha === undefined
          ? current.ownPushedShas
          : appendBoundedUnique(current.ownPushedShas, [args.ownPushedSha], MAX_OWN_PUSHED_SHAS)
        const nextSeen = args.markDeliveredNotesSeen
          ? appendBoundedUnique(current.seenNoteIds, current.deliveredNoteIds ?? [], MAX_SEEN_NOTE_IDS)
          : (current.seenNoteIds ?? [])
        const nextSeenSet = new Set(nextSeen)
        const nextSha = args.reviewedSha ?? current.lastReviewedSha
        const nextPending = current.pendingSignals.filter((sig) => {
          if (args.markDeliveredNotesSeen && sig.kind === 'discussion' && sig.noteId !== undefined) {
            const noteKey = sig.discussionId !== undefined
              ? canonicalDiscussionNoteKey(sig.discussionId, sig.noteId)
              : canonicalCommentKey(sig.noteId)
            if (nextSeenSet.has(noteKey)) return false
          }
          if (
            args.reviewedSha !== undefined
            && (sig.kind === 'opened' || sig.kind === 'ready-for-review' || sig.kind === 'push' || sig.kind === 'conflict')
            && (sig.headSha === undefined || sig.headSha === args.reviewedSha)
          ) {
            return false
          }
          return true
        })
        return {
          ...current,
          ...(nextSha === undefined ? {} : { lastReviewedSha: nextSha, reviewedHeadSha: nextSha }),
          ownPushedShas: nextOwn,
          ...(nextSeen.length === 0 ? {} : { seenNoteIds: nextSeen }),
          ...(args.markDeliveredNotesSeen ? { deliveredNoteIds: undefined } : {}),
          pendingSignals: nextPending,
          dueAt: nextPending.length > 0 ? current.dueAt : undefined,
          updatedAt: Date.now(),
        }
      })
      return {
        ...(updated.lastReviewedSha === undefined ? {} : { lastReviewedSha: updated.lastReviewedSha }),
        ownPushedCount: updated.ownPushedShas.length,
        seenCount: updated.seenNoteIds?.length ?? 0,
      }
    },
  }

  return [prepareTool, publishReviewTool, replyThreadTool, resolveThreadTool, checkpointTool]
}
