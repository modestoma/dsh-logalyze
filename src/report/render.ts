/**
 * 每份日志的报告入口 `report.md` 的生成：开头是这份日志与整批的信息，接着
 * 是这份日志自己的结论（`report/logs/<编号>.md`）、首轮回复（整批结论）和
 * 每轮追问，最后列出没有上传的文件。回复里以 `report/` 开头的链接改成相对
 * 报告目录的路径，检查调用方打不开的链接，并为回复没有引用的本轮新文件补一段
 * 「本轮文件」。只做字符串处理，不读写文件。
 *
 * @module dsh-logalyze/report/render
 */

import { posix } from 'node:path'
import { REPORT_DIR } from '../settings/contract.ts'
import type { ReportStatus } from '../settings/contract.ts'
import type { AnalysisLog, AnalysisRecord } from './store.ts'

/** One recorded turn of an analysis topic (see `analysisRecordSchema`). */
export type ReportSection = AnalysisRecord['sections'][number]

/** Shown where the platform has no error code for the batch. */
export const UNLABELED_ERROR_CODE = '未标注'

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
 * Render the `report.md` of one log.
 * @param record - the analysis, its `analysis` section first when present.
 * @param log - the log the report is for.
 * @param skipped - files of the report directory left out of the upload, with the reason.
 * @returns Markdown text ending with one newline.
 */
export function renderLogReport(record: AnalysisRecord, log: AnalysisLog, skipped: readonly string[]): string {
  const { sections } = record
  const analysis = sections.find(section => section.kind === 'analysis')
  const status = analysis === undefined ? '分析中' : statusText(analysis.status)
  const batch = record.logs.length > 1
  const facts = [
    `日志 id \`${log.logId}\``,
    ...log.productSn === null ? [] : [`设备 SN ${cell(log.productSn)}`],
    ...log.swVersion === null ? [] : [`软件版本 ${cell(log.swVersion)}`],
    ...log.componentVersion === null ? [] : [`组件版本 ${cell(log.componentVersion)}`],
  ]
  const out = [
    '# 日志分析报告',
    [
      '| 日志 | 应用 | 错误码 | 发起时间 | 状态 |',
      '| --- | --- | --- | --- | --- |',
      `| ${cell(`${log.ref} · ${log.fileName}`)} | ${cell(record.appName)} | ${cell(record.errorCode ?? UNLABELED_ERROR_CODE)} | ${cell(record.triggeredAt)} | ${status} |`,
    ].join('\n'),
    facts.join('；'),
  ]
  if (batch) {
    const others = record.logs.filter(other => other.ref !== log.ref).map(other => other.ref)
    out.push(`本次与另外 ${others.length} 份日志（${others.join('、')}）集中分析，「整批结论」适用于整批日志。`)
    out.push('## 本日志结论')
    out.push(log.conclusion !== undefined && log.conclusion.trim() !== ''
      ? log.conclusion.trim()
      : analysis === undefined ? '分析进行中，结论会在首轮结束后更新。' : '本次没有这份日志单独的结论，见「整批结论」。')
    out.push('## 整批结论')
  } else {
    out.push('## 分析结论')
  }
  out.push(analysis === undefined ? '分析进行中，结论会在首轮结束后更新。' : sectionBody(analysis, '（本轮没有回复）'))
  let round = 0
  for (const section of sections) {
    if (section.kind !== 'followup') continue
    round += 1
    out.push(`## 追问 ${round}`)
    if (section.question !== undefined && section.question.trim() !== '') out.push(quote(section.question.trim()))
    out.push(sectionBody(section, '（本轮没有回复）'))
  }
  if (skipped.length > 0) {
    out.push('## 未上传的文件')
    out.push(skipped.map(item => `- ${item}`).join('\n'))
  }
  return `${out.join('\n\n')}\n`
}

function cell(value: string): string {
  return value.replace(/[\r\n]+/gu, ' ').replace(/\|/g, '\\|')
}

/** Most characters of a follow-up question kept in the report. */
export const MAX_QUESTION_CHARS = 4000

/**
 * Readable question of a follow-up turn: the user messages' text without the
 * `<feishu_…>` context blocks the Feishu channel plugin adds.
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
