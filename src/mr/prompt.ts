/**
 * 审微（MR 监督）会话提示词构造：
 * - 区分外部 MR（只评审与回复讨论，不推送代码）与己方 MR（`self-fix`/`self-skill`，可修复 CI 与人类反馈）；
 * - 首审、增量重审、纯讨论回复、草稿转正、CI 失败与合并冲突均有清晰提示与工具约束。
 *
 * @module dsh-logalyze/mr/prompt
 */

import type { MrDetail, MrStatus } from '../deps/repos-contract.ts'
import type { MrPendingSignal, SupervisedMrRecord } from '../runtime/domain.ts'
import {
  MR_CHECKPOINT_TOOL_NAME,
  MR_PREPARE_TOOL_NAME,
  MR_PUBLISH_REVIEW_TOOL_NAME,
  MR_REPLY_THREAD_TOOL_NAME,
  MR_RESOLVE_THREAD_TOOL_NAME,
} from '../tool-names.ts'

export interface MrWakePromptInput {
  readonly record: SupervisedMrRecord
  readonly mr: MrDetail
  readonly status: MrStatus
  readonly signals: readonly MrPendingSignal[]
  readonly maxAutoFixAttempts: number
}

/** Build the incremental wake prompt sent to the persistent MR session. */
export function buildMrWakePrompt(input: MrWakePromptInput): string {
  const { record, mr, status, signals, maxAutoFixAttempts } = input
  const isSelf = record.origin === 'self-fix' || record.origin === 'self-skill'
  const kinds = new Set(signals.map(s => s.kind))
  const isInitial = kinds.has('opened') || kinds.has('ready-for-review') || record.lastReviewedSha === undefined
  const hasPush = kinds.has('push')
  const hasDiscussion = kinds.has('discussion')
  const hasCiFailed = kinds.has('ci-failed')
  const hasConflict = kinds.has('conflict') || status.mergeable === false

  const lines: string[] = [
    `/mr-reviewer`,
    '',
    `## MR 监督唤醒（${record.repo} #${record.mrNumber}）`,
    '',
    `- **标题**: ${mr.title}`,
    `- **来源类型**: \`${record.origin}\`（${isSelf ? '己方发起的 MR，允许修复代码并推送源分支' : '外部 MR，仅评审与讨论，禁止推送提交'}）`,
    `- **分支**: \`${mr.sourceBranch}\` → \`${mr.targetBranch}\``,
    `- **最新提交 (\`headSha\`)**: \`${mr.headSha}\``,
    `- **上次已审提交 (\`lastReviewedSha\`)**: ${record.lastReviewedSha === undefined ? '无（首次评审）' : `\`${record.lastReviewedSha}\``}`,
    `- **链接**: ${mr.webUrl}`,
    `- **CI 总状态**: \`${status.overall}\`${hasConflict ? ' | **注意：存在合并冲突 (`mergeable === false`)**' : ''}`,
    '',
    '### 本次触发信号',
  ]

  for (const sig of signals) {
    lines.push(`- [${sig.kind}] ${sig.summary ?? (sig.headSha !== undefined ? `commit ${sig.headSha.slice(0, 8)}` : '信号更新')}`)
  }

  lines.push('', '### 执行步骤与要求')
  lines.push(`1. 先调用 \`${MR_PREPARE_TOOL_NAME}\` 拉取并同步本地工作区到最新提交，查看增量 diff 与完整讨论上下文。`)

  if (hasConflict) {
    lines.push('2. **合并冲突提醒**：当前 MR 与目标分支存在冲突。**禁止自动执行 git rebase 或强推**；请在回复/飞书通知中明确指出冲突文件（如可判断）并请人工处理。')
  }

  if (isSelf) {
    if (hasCiFailed) {
      const remaining = Math.max(0, maxAutoFixAttempts - record.autoFixAttempts)
      lines.push(`- **CI 失败自修**（已尝试 ${record.autoFixAttempts}/${maxAutoFixAttempts}，本次后剩余 ${Math.max(0, remaining - 1)} 次）：定位失败原因，修改代码并运行相关测试后推送到 \`${mr.sourceBranch}\`；推送完成后务必调用 \`${MR_CHECKPOINT_TOOL_NAME}\` 登记 \`ownPushedSha\`。`)
    }
    if (hasDiscussion) {
      lines.push(`- **人类反馈处理**：逐条核实讨论内容；若无需修改直接用 \`${MR_REPLY_THREAD_TOOL_NAME}\` 回复，若需要修改则修复验证并推送新提交，之后回复对应 \`discussionId\`，全部完成后可酌情调用 \`${MR_RESOLVE_THREAD_TOOL_NAME}\`（以及 \`${MR_CHECKPOINT_TOOL_NAME}\` 记录游标与 \`ownPushedSha\`）。`)
    }
    if (!hasCiFailed && !hasDiscussion) {
      lines.push(`- 若仅需同步状态或做补充说明，完成后调用 \`${MR_CHECKPOINT_TOOL_NAME}\` 更新已读游标，以免重复触发。`)
    }
  } else {
    if (isInitial || hasPush) {
      const rangeNote = record.lastReviewedSha !== undefined && record.lastReviewedSha !== mr.headSha
        ? `重点检查 \`${record.lastReviewedSha.slice(0, 8)}..${mr.headSha.slice(0, 8)}\` 的增量变更，同时确认历史问题是否已被修复。`
        : '对本次 MR 完整变更进行全面代码审查。'
      lines.push(`- **代码评审**：${rangeNote}所有行级评论必须在本地工作区核对文件路径与准确行号后，通过 \`${MR_PUBLISH_REVIEW_TOOL_NAME}\` 发布（` + '`headSha`' + ` 传入 \`${mr.headSha}\`）。`)
    }
    if (hasDiscussion) {
      lines.push(`- **讨论回复**：对新增的人类问题/反馈使用 \`${MR_REPLY_THREAD_TOOL_NAME}\` 明确答复；对于确认已修复的线程可用 \`${MR_RESOLVE_THREAD_TOOL_NAME}\` 解决。`)
    }
    if (!isInitial && !hasPush && hasDiscussion) {
      lines.push(`- 若本轮仅回复/解决了讨论且未调用 \`${MR_PUBLISH_REVIEW_TOOL_NAME}\`，结束前务必调用 \`${MR_CHECKPOINT_TOOL_NAME}\` 以标记已读人类评论。`)
    }
  }

  return lines.join('\n')
}
