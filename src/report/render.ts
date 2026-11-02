/**
 * 报告入口 `report.md` 的生成：把记录下的首轮回复与追问逐节写出，把回复里
 * 以 `report/` 开头的链接改成相对报告目录的路径，检查调用方打不开的链接，
 * 并为回复没有引用的本轮新文件补一段「本轮文件」。只做字符串处理，不读写文件。
 *
 * @module dsh-logalyze/report/render
 */

import { posix } from 'node:path'
import { REPORT_DIR } from '../settings/contract.ts'
import type { ReportStatus } from '../settings/contract.ts'
import type { ReportRecord } from './store.ts'

/** One recorded turn of an analysis topic (see `reportRecordSchema`). */
export type ReportSection = ReportRecord['sections'][number]

/** Request facts shown in the report header. */
export interface ReportHeader {
  readonly app: string
  readonly errorCode: string
  readonly triggeredAt: string
}

const STATUS_TEXT: Readonly<Record<ReportStatus, string>> = {
  done: '已完成',
  stopped: '已停止',
  error: '失败',
  failed: '未能开始',
  interrupted: '已中断',
}

/**
 * Display text of a first-turn outcome.
 * @param status - recorded outcome.
 * @returns Chinese label.
 */
export function statusText(status: ReportStatus): string {
  return STATUS_TEXT[status]
}

/** Inline links and images: `[text](target)` and `![alt](target)`; group 2 is the target. */
const INLINE_LINK = /(!?\[[^\]\n]*\]\(\s*)(<[^>\n]*>|[^)\s]+)/g
/** Reference definitions: `[label]: target`. */
const REFERENCE_LINK = /^( {0,3}\[[^\]\n]+\]:[ \t]*)(<[^>\n]*>|\S+)/gm
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/
const WINDOWS_PATH = /^[A-Za-z]:[\\/]/

/** A reply rewritten for the report entry. */
export interface RewrittenReply {
  /** Reply with `report/` links made relative to the report directory. */
  readonly text: string
  /** Linked files inside the report directory, normalized relative paths. */
  readonly linked: ReadonlySet<string>
  /** Linked targets the caller cannot open, as readable warnings. */
  readonly warnings: readonly string[]
}

function unwrap(target: string): { inner: string; wrapped: boolean } {
  return target.startsWith('<') && target.endsWith('>') ? { inner: target.slice(1, -1), wrapped: true } : { inner: target, wrapped: false }
}

function decode(value: string): string {
  try {
    return decodeURI(value)
  } catch {
    // A malformed escape is kept as written; the link check reports it as missing.
    return value
  }
}

/**
 * Rewrite one reply for `report.md`: `report/x` and `./report/x` become `x`;
 * local absolute paths and relative paths outside `report/` are reported.
 * @param reply - final reply of a turn, as the model wrote it.
 * @param exists - whether a normalized relative path exists in the report directory.
 * @returns rewritten text, linked files, and warnings.
 */
export function rewriteReply(reply: string, exists: (path: string) => boolean): RewrittenReply {
  const linked = new Set<string>()
  const warnings: string[] = []
  const rewrite = (prefix: string, target: string): string => {
    const { inner, wrapped } = unwrap(target)
    if (inner === '' || inner.startsWith('#') || (SCHEME.test(inner) && !inner.toLowerCase().startsWith('file:'))) return prefix + target
    if (inner.startsWith('/') || inner.startsWith('~') || WINDOWS_PATH.test(inner) || inner.toLowerCase().startsWith('file:')) {
      warnings.push(`引用了本机路径 ${inner}`)
      return prefix + target
    }
    const path = inner.replace(/^\.\//, '')
    if (!path.startsWith(`${REPORT_DIR}/`)) {
      warnings.push(`引用了 ${REPORT_DIR}/ 以外的路径 ${inner}`)
      return prefix + target
    }
    const relative = path.slice(REPORT_DIR.length + 1)
    const file = posix.normalize(decode(relative.split(/[?#]/u)[0] ?? ''))
    if (file.startsWith('../') || file === '..') warnings.push(`引用了 ${REPORT_DIR}/ 以外的路径 ${inner}`)
    else if (!exists(file)) warnings.push(`引用的文件不存在：${inner}`)
    else linked.add(file)
    return prefix + (wrapped ? `<${relative}>` : relative)
  }
  const text = reply
    .replace(INLINE_LINK, (_match, prefix: string, target: string) => rewrite(prefix, target))
    .replace(REFERENCE_LINK, (_match, prefix: string, target: string) => rewrite(prefix, target))
  return { text, linked, warnings }
}

const IMAGE = /\.(png|jpe?g|gif|svg|webp|bmp)$/iu

function linkTarget(path: string): string {
  return path.split('/').map(segment => encodeURIComponent(segment)).join('/')
}

function fileList(files: readonly string[]): string {
  const lines = files.map(file => IMAGE.test(file) ? `- ![${file}](${linkTarget(file)})` : `- [${file}](${linkTarget(file)})`)
  return `**本轮文件**\n\n${lines.join('\n')}`
}

function quote(text: string): string {
  return text.split('\n').map(line => line === '' ? '>' : `> ${line}`).join('\n')
}

function sectionBody(section: ReportSection, empty: string): string {
  const parts: string[] = []
  if (section.status !== 'done') parts.push(quote(`⚠️ 本轮${statusText(section.status)}${section.reason === undefined ? '' : `：${section.reason}`}`))
  else if (section.reason !== undefined) parts.push(quote(section.reason))
  parts.push(section.reply.trim() === '' ? empty : section.reply.trim())
  if (section.files.length > 0) parts.push(fileList(section.files))
  return parts.join('\n\n')
}

/**
 * Render `report.md`.
 * @param header - request facts.
 * @param sections - recorded turns, the `analysis` section first when present.
 * @returns Markdown text ending with one newline.
 */
export function renderReport(header: ReportHeader, sections: readonly ReportSection[]): string {
  const analysis = sections.find(section => section.kind === 'analysis')
  const status = analysis === undefined ? '分析中' : statusText(analysis.status)
  const out = [
    '# 日志分析报告',
    [
      '| 应用 | 错误码 | 发起时间 | 状态 |',
      '| --- | --- | --- | --- |',
      `| ${cell(header.app)} | ${cell(header.errorCode)} | ${cell(header.triggeredAt)} | ${status} |`,
    ].join('\n'),
    '## 分析结论',
    analysis === undefined ? '分析进行中，结论会在首轮结束后更新。' : sectionBody(analysis, '（本轮没有回复）'),
  ]
  let round = 0
  for (const section of sections) {
    if (section.kind !== 'followup') continue
    round += 1
    out.push(`## 追问 ${round}`)
    if (section.question !== undefined && section.question.trim() !== '') out.push(quote(section.question.trim()))
    out.push(sectionBody(section, '（本轮没有回复）'))
  }
  return `${out.join('\n\n')}\n`
}

function cell(value: string): string {
  return value.replace(/\|/g, '\\|')
}

/** Most characters of a follow-up question kept in the report. */
export const MAX_QUESTION_CHARS = 4000

/**
 * Readable question of a follow-up turn: the user messages' text without the
 * `<feishu_…>` context blocks dsh-channels adds.
 * @param texts - text of the turn's user messages.
 * @returns the question, cut to {@link MAX_QUESTION_CHARS}.
 */
export function questionOf(texts: readonly string[]): string {
  const question = texts
    .map(text => text.replace(/<(feishu_[a-z_]+)\b[^>]*>[\s\S]*?<\/\1>/g, '').trim())
    .filter(text => text !== '')
    .join('\n\n')
  return question.length <= MAX_QUESTION_CHARS ? question : `${question.slice(0, MAX_QUESTION_CHARS - 1)}…`
}
