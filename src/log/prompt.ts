/**
 * 观象日志监管提示词、动作提议卡片构造与单日志报告 Markdown 渲染。
 *
 * @module dsh-logalyze/log/prompt
 */

import type { ProposedAction } from '../deps/actions-contract.ts'
import type { TopicCardLink, TopicCardLinks, TopicLaunchSpec } from '../deps/topics-contract.ts'
import type {
  LogTaskInput,
  LogTaskRecord,
  LogTaskRevision,
} from '../runtime/domain.ts'
import type { LogDeliveryMode } from '../settings/contract.ts'
import { UNLABELED_ERROR_CODE } from '../report/render.ts'
import {
  ISSUE_SEARCH_TOOL_NAME,
  LOG_PREPARE_TOOL_NAME,
  LOG_PUSH_MR_TOOL_NAME,
  LOG_SUBMIT_TOOL_NAME,
} from '../tool-names.ts'

const MAX_FOLLOWUP_PROMPT_CHARS = 7_500

function truncate(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1)}…`
}

function cell(value: string): string {
  return value.replace(/[\r\n]+/gu, ' ').replace(/\|/gu, '\\|')
}

/** Render `<app-slug>` consistently across workspace dirs and prompts. */
export function appSlugOf(appId: string): string {
  const normalized = appId
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
  return normalized === '' ? 'app' : normalized
}

/** Build the first-turn prompt for a platform batch (`topic-on-start` or headless Phase 1). */
export function buildPlatformDiagnosisPrompt(params: {
  readonly taskId: string
  readonly appId: string
  readonly appName: string
  readonly errorCode?: string
  readonly inputs: readonly LogTaskInput[]
  readonly mode: LogDeliveryMode
  readonly headless: boolean
}): string {
  const tableRows = params.inputs.map((item) => {
    const label = `${item.ref} · ${item.fileName ?? item.logId ?? 'log'}`
    const meta = [
      item.logId === undefined ? undefined : `log_id=${item.logId}`,
      item.productSn === undefined ? undefined : `SN=${item.productSn}`,
      item.swVersion === undefined ? undefined : `sw=${item.swVersion}`,
      item.componentVersion === undefined ? undefined : `comp=${item.componentVersion}`,
    ].filter(Boolean).join(', ')
    return `- **${label}**${meta === '' ? '' : ` (${meta})`}`
  })

  const actionNote = params.headless
    ? '当前处于后台静默诊断阶段：完成分析后调用 `supervisor_log_submit` 提交结构化结论并结束回合即可（不要调用 `propose_actions`，系统会在投递飞书总结卡时自动挂出推荐操作按钮）。'
    : '当前处于飞书直播话题中：完成 `supervisor_log_submit` 后，若定位为可写仓库的代码缺陷或值得改进分析 SKILL/沉淀案例，请调用 `propose_actions` 主动询问用户下一步动作。'

  return [
    `/log-supervisor`,
    '',
    `收到平台日志异常批次任务 \`${params.taskId}\`：`,
    `- **应用**：${params.appName} (\`${params.appId}\`)`,
    `- **错误码**：${params.errorCode ?? UNLABELED_ERROR_CODE}`,
    `- **待分析日志**（${params.inputs.length} 份）：`,
    ...tableRows,
    '',
    '请按以下步骤执行：',
    `1. 首先调用 \`${LOG_PREPARE_TOOL_NAME}\`（传入 \`taskId: "${params.taskId}"\`）下载并安全解压 \`L1..L${params.inputs.length}\`、检出代码并读取候选已知问题；`,
    `2. 结合日志目录与代码逐份核验（严禁跳过核验或将单份结论盲目复制到整批），需要时调用 \`${ISSUE_SEARCH_TOOL_NAME}\` 核对 \`IssueMemory\`（人工确认结论 \`humanConclusion\` 优先于历史 AI 诊断）；`,
    `3. 完成排查后调用 \`${LOG_SUBMIT_TOOL_NAME}\` 提交覆盖全部 ${params.inputs.length} 份槽位的结构化结论与证据（若归因 \`code_defect\` 须附真实代码文件行号；若某槽位包损坏则提交 \`corrupted_log\`）；`,
    `4. ${actionNote}`,
  ].join('\n')
}

/** Build the Phase-2 Feishu topic summary prompt after headless `quiet-until-done` diagnosis succeeds. */
export function buildQuietDoneTopicPrompt(params: {
  readonly task: LogTaskRecord
  readonly taskId: string
  readonly revision: LogTaskRevision
  readonly reportUrls?: Readonly<Record<string, string>>
}): string {
  const appLabel = params.task.appName ?? params.task.appId
  const itemLines = (params.revision.items ?? []).map((item) => {
    const input = params.task.inputs.find(i => i.ref === item.ref)
    const reportUrl = input?.logId === undefined ? undefined : params.reportUrls?.[input.logId]
    const linkSuffix = reportUrl === undefined ? '' : ` · [平台报告](${reportUrl})`
    const issueSuffix = item.issueId === undefined ? '' : ` · 问题 \`${item.issueId}\``
    return `- **${item.ref}** (${item.status} / ${item.rootCauseCategory}${issueSuffix}${linkSuffix}): ${item.conclusion}`
  })

  return [
    '本次异常日志后台静默诊断已完成，请直接向群内成员用简洁、清晰的 Markdown 总结以下已核验结论，不要重复重新分析或再次调用 `supervisor_log_submit`；若后续成员在话题中追问，可先调用 `supervisor_log_prepare`（传入相同 `taskId`）继续深入排查或修复。',
    '',
    `- **任务 ID**：\`${params.taskId}\` · **修订**：rev ${params.revision.revision}`,
    `- **应用**：${appLabel} (\`${params.task.appId}\`) · **错误码**：${params.task.errorCode ?? UNLABELED_ERROR_CODE}`,
    `- **总体结论**：${params.revision.summary}`,
    '',
    '**逐份日志结论**：',
    ...itemLines,
  ].join('\n')
}

/** Build the self-contained followUpPrompt submitted when user clicks `[🔧 修复代码并提 MR]`. */
export function buildFixCodeFollowUpPrompt(params: {
  readonly taskId: string
  readonly appId: string
  readonly appName: string
  readonly repoUrl: string
  readonly baseCommit?: string
  readonly summary: string
  readonly evidences: readonly { readonly source: string; readonly locator: string; readonly excerpt: string }[]
  readonly issueId?: string
}): string {
  const slug = appSlugOf(params.appId)
  const evidenceText = params.evidences.length === 0
    ? '（见前序诊断会话与 logs/）'
    : params.evidences.slice(0, 6).map(e => `- \`${e.source}\` (${e.locator}): ${e.excerpt}`).join('\n')
  const raw = [
    '用户已授权并点击「🔧 修复代码并提 MR」，请基于已完成的日志诊断上下文执行代码修复：',
    `- **任务 ID**：\`${params.taskId}\` · **应用**：${params.appName} (\`${params.appId}\`)`,
    `- **仓库地址**：\`${params.repoUrl}\`${params.baseCommit === undefined ? '' : ` · **基准提交**：\`${params.baseCommit.slice(0, 12)}\``}`,
    params.issueId === undefined ? undefined : `- **关联 Issue**：\`${params.issueId}\``,
    `- **根因摘要**：${params.summary}`,
    '- **关键证据**：',
    evidenceText,
    '',
    '请按以下步骤执行：',
    `1. 调用 \`${LOG_PREPARE_TOOL_NAME}\`（传入 \`taskId: "${params.taskId}"\`, \`workspace: "diagnosis"\`）确认工作区 \`repos/${slug}\` 就绪；`,
    `2. 在 \`repos/${slug}\` 中定位并修复代码缺陷，同时补充回归单元测试；`,
    '3. 在 `repos/' + slug + '` 运行项目测试与类型检查，确保全部通过；',
    `4. 调用 \`${LOG_PUSH_MR_TOOL_NAME}\`（\`kind: "fix_code"\`、附上清晰的 \`commitMessage\`、\`mrTitle\`、\`mrBody\`${params.issueId === undefined ? '' : ` 与 \`issueId: "${params.issueId}"\``}）推送修复分支、发起 MR、关联 \`IssueMemory\` 并自动登记审微 MR 监管。`,
  ].filter(Boolean).join('\n')
  return truncate(raw, MAX_FOLLOWUP_PROMPT_CHARS)
}

/** Build the self-contained followUpPrompt submitted when user clicks `[📚 改进分析流程 / 沉淀案例]`. */
export function buildImproveSkillFollowUpPrompt(params: {
  readonly taskId: string
  readonly appId: string
  readonly appName: string
  readonly summary: string
  readonly issueId?: string
}): string {
  const slug = appSlugOf(params.appId)
  const caseFileHint = params.issueId !== undefined
    ? `\`cases/${params.issueId}.md\``
    : '按问题 ID 或日期在 `cases/` 沉淀/更新案例'
  const raw = [
    '用户已授权并点击「📚 改进分析流程 / 沉淀案例」，请在**独立的知识改进工作区**完成 SKILL / 案例库改进，绝不把文档改动混入代码修复分支：',
    `- **任务 ID**：\`${params.taskId}\` · **应用**：${params.appName} (\`${params.appId}\`)`,
    params.issueId === undefined ? undefined : `- **关联 Issue**：\`${params.issueId}\``,
    `- **本次分析摘要**：${params.summary}`,
    '',
    '请按以下步骤执行：',
    `1. **必须先调用** \`${LOG_PREPARE_TOOL_NAME}\`（传入 \`taskId: "${params.taskId}"\`, \`workspace: "knowledge"\`）创建隔离的知识改进工作区 \`repos/${slug}-knowledge\`；`,
    `2. 在 \`repos/${slug}-knowledge\` 中完善 \`.agents/skills/\` 下的日志分析 SKILL（或初始化结构化 SKILL，并可沉淀可复用 \`scripts/\` 解析脚本与 ${caseFileHint} 案例文档）；`,
    `3. 完成后调用 \`${LOG_PUSH_MR_TOOL_NAME}\`（\`kind: "improve_skill"\`、使用 \`docs:\` 或 \`chore:\` 提交与 MR 标题${params.issueId === undefined ? '' : `，附带 \`issueId: "${params.issueId}"\``}）发起独立 MR 并登记审微监管。`,
  ].filter(Boolean).join('\n')
  return truncate(raw, MAX_FOLLOWUP_PROMPT_CHARS)
}

/** Derive default Feishu action buttons (`fix_code` / `improve_skill`) for a submitted revision when repo is writable. */
export function buildDefaultActionsForRevision(params: {
  readonly taskId: string
  readonly appId: string
  readonly appName: string
  readonly repoUrl: string
  readonly baseCommit?: string
  readonly writable: boolean
  readonly revision: LogTaskRevision
}): ProposedAction[] {
  if (!params.writable) return []
  const items = params.revision.items ?? []
  const actions: ProposedAction[] = []
  const codeItems = items.filter(item => item.rootCauseCategory === 'code_defect')
  if (codeItems.length > 0) {
    const primaryIssueId = codeItems.find(i => i.issueId !== undefined)?.issueId ?? params.revision.issueId
    actions.push({
      id: 'fix_code',
      label: '🔧 修复代码并提 MR',
      style: 'primary',
      requiredAccess: 'code-write',
      independent: true,
      followUpPrompt: buildFixCodeFollowUpPrompt({
        taskId: params.taskId,
        appId: params.appId,
        appName: params.appName,
        repoUrl: params.repoUrl,
        ...(params.baseCommit === undefined ? {} : { baseCommit: params.baseCommit }),
        summary: codeItems.map(i => `[${i.ref}] ${i.conclusion}`).join('；'),
        evidences: codeItems.flatMap(i => i.evidences),
        ...(primaryIssueId === undefined ? {} : { issueId: primaryIssueId }),
      }),
    })
  }
  const diagnosedOrUseful = items.some(item => item.status === 'diagnosed')
  if (diagnosedOrUseful) {
    const primaryIssueId = items.find(i => i.issueId !== undefined)?.issueId ?? params.revision.issueId
    actions.push({
      id: 'improve_skill',
      label: '📚 改进分析流程 / 沉淀案例',
      style: 'default',
      requiredAccess: 'code-write',
      independent: true,
      followUpPrompt: buildImproveSkillFollowUpPrompt({
        taskId: params.taskId,
        appId: params.appId,
        appName: params.appName,
        summary: params.revision.summary,
        ...(primaryIssueId === undefined ? {} : { issueId: primaryIssueId }),
      }),
    })
  }
  return actions
}

/** Build the Feishu topic root card for either `topic-on-start` or `quiet-until-done`. */
export function buildLogTopicLaunchSpec(params: {
  readonly launchKey: string
  readonly fingerprint: string
  readonly chatId: string
  readonly task: LogTaskRecord
  readonly taskId: string
  readonly prompt: string
  readonly reportUrls?: Readonly<Record<string, string>>
  readonly phase: 'starting' | 'completed'
}): TopicLaunchSpec {
  const appLabel = params.task.appName ?? params.task.appId
  const rows: TopicCardLink[] = params.task.inputs.map((input) => {
    const reportUrl = input.logId === undefined ? undefined : params.reportUrls?.[input.logId]
    return {
      name: `${input.ref} · ${input.fileName ?? input.logId ?? 'log'}`,
      ...(input.detailUrl === undefined ? {} : { url: input.detailUrl }),
      ...(reportUrl === undefined ? {} : { extraUrl: reportUrl }),
    }
  })

  const links: TopicCardLinks = {
    nameHeader: '日志',
    linkHeader: '日志详情',
    ...(params.task.inputs.some(i => i.logId !== undefined) ? { extraLinkHeader: '分析报告' } : {}),
    rows,
  }

  return {
    key: params.launchKey,
    fingerprint: params.fingerprint,
    chatId: params.chatId,
    requester: { kind: 'external', label: '日志平台自动监管（观象）' },
    card: {
      title: `日志异常监管：${appLabel}`,
      taskName: params.phase === 'completed' ? '汇总' : '分析',
      lead: [
        { text: '已触发异常日志批次分析：应用 ' },
        { text: appLabel, bold: true },
        { text: ' · 错误码 ' },
        { text: params.task.errorCode ?? UNLABELED_ERROR_CODE, bold: true },
        { text: `（共 ${params.task.inputs.length} 份日志）` },
      ],
      ...(rows.length > 0 ? { links } : {}),
    },
    prompt: params.prompt,
  }
}

/**
 * Render per-log `report.md` uploaded via `uploadRevision` from a structured
 * `LogTaskRevision` snapshot. Pure string formatting, no file I/O.
 */
export function renderSupervisorLogReport(params: {
  readonly task: LogTaskRecord
  readonly taskId: string
  readonly input: LogTaskInput
  readonly revision: LogTaskRevision
  readonly skipped: readonly string[]
  readonly uploadedFiles?: ReadonlySet<string>
}): string {
  const { task, input, revision, skipped, uploadedFiles } = params
  const appLabel = task.appName ?? task.appId
  const item = revision.items?.find(candidate => candidate.ref === input.ref)
  const triggeredAt = new Date(task.createdAt ?? revision.createdAt).toISOString()
  const facts = [
    ...(input.logId === undefined ? [] : [`日志 id \`${input.logId}\``]),
    ...(input.productCode === undefined ? [] : [`产品 ${cell(input.productCode)}`]),
    ...(input.productSn === undefined ? [] : [`设备 SN ${cell(input.productSn)}`]),
    ...(input.swVersion === undefined ? [] : [`软件版本 ${cell(input.swVersion)}`]),
    ...(input.componentVersion === undefined ? [] : [`组件版本 ${cell(input.componentVersion)}`]),
  ]

  const out: string[] = [
    '# 日志分析报告',
    [
      '| 日志 | 应用 | 错误码 | 触发来源 | 修订 |',
      '| --- | --- | --- | --- | --- |',
      `| ${cell(`${input.ref} · ${input.fileName ?? input.logId ?? 'log'}`)} | ${cell(appLabel)} | ${cell(task.errorCode ?? UNLABELED_ERROR_CODE)} | ${cell(`${task.source} (${triggeredAt})`)} | rev ${revision.revision} |`,
    ].join('\n'),
  ]
  if (facts.length > 0) out.push(facts.join('；'))

  if (item !== undefined) {
    out.push('## 本日志结论')
    out.push([
      `- **状态**：${item.status}`,
      `- **根因分类**：${item.rootCauseCategory}`,
      ...(item.issueId === undefined ? [] : [`- **关联已知问题**：\`${item.issueId}\``]),
      '',
      item.conclusion.trim(),
    ].join('\n'))

    if (item.evidences.length > 0) {
      out.push('## 关键证据')
      out.push(item.evidences.map(ev => `- \`${ev.source}\` (${ev.locator}): ${ev.excerpt}`).join('\n'))
    }
  }

  out.push('## 批次总体摘要')
  out.push(revision.summary.trim())

  const attachmentsToLink = (revision.attachments ?? []).filter(
    file => uploadedFiles === undefined || uploadedFiles.has(file),
  )
  if (attachmentsToLink.length > 0) {
    out.push('## 附带报告文件')
    out.push(attachmentsToLink.map(file => `- [${file}](${file.split('/').map(s => encodeURIComponent(s)).join('/')})`).join('\n'))
  }

  if (skipped.length > 0) {
    out.push('## 未上传的文件')
    out.push(skipped.map(entry => `- ${entry}`).join('\n'))
  }

  return `${out.join('\n\n')}\n`
}
