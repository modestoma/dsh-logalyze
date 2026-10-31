/**
 * 分析子 Agent 写在运行目录里的 SKILL 不足记录 `skill-gap.md`：SKILL 哪里没有
 * 覆盖这次问题、子 Agent 实际是怎样定位的、依据的日志行与代码位置。派发结束后
 * 读取它，父 Agent 据此询问用户是否改进 SKILL，改进子 Agent 据此起草。
 *
 * 运行目录对 Agent 可写，记录按不可信输入读取：只接受普通文件、UTF-8 文本和
 * 大小上限。
 *
 * @module dsh-logalyze/skill-update/gap
 */

import { join } from 'node:path'
import { kindOf, ProposalError, readText } from './proposal.ts'

/** Gap record inside a task's run directory. */
export const GAP_FILE = 'skill-gap.md'

/** Characters of the record shown in the dispatch result and the approval prompt. */
export const GAP_PREVIEW_CHARS = 300

/** A task's gap record as the dispatch result reports it. */
export type GapCheck =
  | { readonly ok: true; readonly path: string; readonly preview: string }
  | { readonly ok: false; readonly error: string }

/**
 * Collapse whitespace and cut a text to a preview.
 * @param text - full text.
 * @param chars - preview length.
 * @returns one line of at most `chars` characters plus an ellipsis when cut.
 */
export function previewOf(text: string, chars: number): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length <= chars ? line : `${line.slice(0, chars)}…`
}

/**
 * Read one task's gap record.
 * @param workDir - the task's run directory.
 * @param maxBytes - size ceiling.
 * @returns the text, or undefined when the task wrote none.
 * @throws ProposalError when the record exists but is not a non-empty UTF-8 file within the ceiling.
 */
export async function readGap(workDir: string, maxBytes: number): Promise<string | undefined> {
  const path = join(workDir, GAP_FILE)
  const kind = await kindOf(path)
  if (kind === 'missing') return undefined
  if (kind !== 'file') throw new ProposalError(`${GAP_FILE} 不是普通文件`)
  const text = (await readText(path, GAP_FILE, maxBytes)).trim()
  if (text === '') throw new ProposalError(`${GAP_FILE} 是空的`)
  return text
}
