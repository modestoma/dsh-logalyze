/**
 * 子 Agent 首条消息。首行的 `/<skill>` 由 DSH 的 skill 手势确定性注入应用的
 * 日志分析 SKILL（子 Agent 首条消息的来源是 user）。
 *
 * @module dsh-logalyze/dispatch/prompt
 */

import type { AppManifest } from '../settings/contract.ts'
import { skillDir } from '../repos/manifest.ts'
import { GAP_FILE } from '../skill-update/gap.ts'

/** One log handed to a child, always as an absolute local path. */
export interface ChildLog {
  readonly path: string
  /** Original download URL when the dispatch tool fetched the file. */
  readonly url?: string
  /** How to pick this application's lines out of a mixed log. */
  readonly filter?: string
}

/** Inputs of one child prompt. */
export interface ChildPromptInput {
  readonly app: AppManifest
  readonly commit: string
  readonly question: string
  readonly logs: readonly ChildLog[]
  /** Writable directory for extraction and scratch files. */
  readonly workDir: string
  /** Whether the child records where the application's SKILL fell short. */
  readonly gaps: boolean
}

function gapSection(skill: string, workDir: string): string {
  return `
## SKILL 不足时

分析完成后，如果本应用的日志分析 SKILL（仓库中的 \`${skillDir(skill)}/\`）没能很好地支撑这次分析，例如日志格式描述不对、缺少这类故障的排查方法或排除规则、代码路径已经过时、你靠自己摸索才找到根因，就在 \`${workDir}/${GAP_FILE}\` 简要记录：

1. SKILL 哪里不足：缺了什么、哪里写错了。
2. 你实际是怎样定位的：关键步骤。
3. 依据：几行关键日志（去掉用户信息、密钥等具体数据）和对应的代码位置。

不要修改 SKILL，是否改进由用户决定。SKILL 足够时不要创建这个文件。
`
}

/**
 * Render the child's first message.
 * @param input - application, question, logs, writable directory, and whether SKILL gaps are recorded.
 * @returns prompt text whose first line is the `/<skill>` gesture.
 */
export function renderChildPrompt(input: ChildPromptInput): string {
  const { app, commit, question, logs, workDir, gaps } = input
  const logLines = logs.map((log) => {
    const origin = log.url === undefined ? '' : `（下载自 ${log.url}）`
    const filter = log.filter === undefined ? '' : `；只看本应用相关部分：${log.filter}`
    return `- \`${log.path}\`${origin}${filter}`
  })
  return `/${app.skill}

你是观象派发的日志分析子任务，负责应用「${app.name}」（id: \`${app.id}\`）。当前工作目录是该应用的代码仓库，检出提交 \`${commit.slice(0, 12)}\`。

## 问题

${question}

## 日志

${logLines.join('\n')}

日志可能是压缩包，按上面加载的日志分析 SKILL 处理；需要解压时解压到运行目录。

## 工作约束

- 应用仓库只读：不要修改、新建或删除仓库中的文件，不要执行任何 git 写操作。
- 解压结果和中间文件只放在运行目录 \`${workDir}\`。
- 日志可能来自与当前代码不同的版本；行号或逻辑对不上时，在结论中说明版本差异。
${gaps ? gapSection(app.skill, workDir) : ''}
## 返回格式

最终回复只包含以下五部分：

1. 结论：根因或当前判断，不确定时说明置信度。
2. 关键证据：日志原文片段（带时间戳）与对应代码位置（文件:行号）。
3. 时间线：关键事件按时间排列，保留请求 id、用户 id 等关联标识。
4. 假设与待验证：尚未确认的推断。
5. 建议：修复或继续排查的下一步。${gaps ? '记录了 SKILL 不足时，在这里用一句话说明。' : ''}
`
}
