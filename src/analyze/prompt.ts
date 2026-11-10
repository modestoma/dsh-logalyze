/**
 * 分析接口话题的首轮消息：以 `/logalyze` 开头，列出应用、错误码和日志表
 * （编号 L1…Ln 与日志平台元数据），附上调用方说明、集中分析的要求和报告
 * 文件的规则。日志的下载地址不写进消息，派发时按编号由观象现取。
 *
 * @module dsh-logalyze/analyze/prompt
 */

import { DISPATCH_TOOL_NAME } from '../tool-names.ts'
import { UNLABELED_ERROR_CODE } from '../report/render.ts'
import type { AnalysisRecord } from '../report/store.ts'
import { REPORT_DIR, REPORT_ENTRY, REPORT_EXTENSIONS, REPORT_LOGS_DIR, REPORT_PATH_MAX_SEGMENTS } from '../settings/contract.ts'
import type { UploadSettings } from '../settings/contract.ts'

const MIB = 1024 * 1024

/** A table cell: one line, pipes escaped, `—` when empty. */
function cell(value: string | null): string {
  if (value === null || value.trim() === '') return '—'
  return value.replace(/[\r\n]+/gu, ' ').replace(/\|/gu, '\\|')
}

/** A byte count for people: `12.3 MiB`, `456 KiB`, `789 B`. */
function size(bytes: string | null): string {
  const value = bytes === null ? Number.NaN : Number(bytes)
  if (!Number.isFinite(value)) return '—'
  if (value >= MIB) return `${(value / MIB).toFixed(1)} MiB`
  if (value >= 1024) return `${Math.round(value / 1024)} KiB`
  return `${value} B`
}

function mib(bytes: number): string {
  return `${Number((bytes / MIB).toFixed(1))} MiB`
}

function quote(text: string): string {
  return text.trim().split('\n').map(line => line === '' ? '>' : `> ${line}`).join('\n')
}

/**
 * The first message of an analysis topic.
 * @param record - the accepted analysis.
 * @param limits - upload limits named in the report rules.
 * @returns prompt text whose first line is `/logalyze`.
 */
export function analysisPrompt(record: AnalysisRecord, limits: UploadSettings): string {
  const count = record.logs.length
  const batch = count > 1
  const refs = record.logs.map(log => log.ref)
  const rows = record.logs.map(log => `| ${log.ref} | ${cell(log.fileName)} | ${cell(log.productSn)} | ${cell(log.hwVersion)} | ${cell(log.swVersion)} | ${cell(log.componentVersion)} | ${cell(log.logType)} | ${size(log.sizeBytes)} | ${cell(log.createdAt)} |`)
  const parts = [
    '/logalyze',
    `观象分析接口发起的日志分析。下面${batch ? ` ${count} 份` : '的'}日志来自日志平台，${batch ? '属于同一应用、同一错误码' : '已确定应用和错误码'}。`,
    [
      `- 应用：${record.appName}（id: \`${record.app}\`，由日志的 component_code \`${record.componentCode}\` 对应）`,
      `- 错误码：${record.errorCode ?? `${UNLABELED_ERROR_CODE}（日志平台没有错误码）`}`,
      `- 发起时间：${record.triggeredAt}`,
    ].join('\n'),
    '## 日志',
    [
      '| 编号 | 文件名 | 设备 SN | 硬件版本 | 软件版本 | 组件版本 | 类型 | 大小 | 上传时间 |',
      '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
      ...rows,
    ].join('\n'),
    `派发时每份日志写成 \`{ "ref": "${refs[0] ?? 'L1'}" }\` 这样的编号：观象会向日志平台现取下载链接并下载，不要自己找下载地址。`,
  ]
  if (record.instructions !== undefined) parts.push('## 调用方说明', quote(record.instructions))
  parts.push('## 分析要求', [
    `- 应用已确定，不要再按日志内容判断应用：调用一次 \`${DISPATCH_TOOL_NAME}\`，一个任务，app 为 \`${record.app}\`，logs 列出${batch ? `全部 ${count} 个编号（${refs.join('、')}）` : ` \`{ "ref": "L1" }\``}。`,
    ...batch
      ? [
          '- 判断这些日志是不是同一个根因；不是时按根因分组，说明每组包含哪些日志和依据。无法判断归属的日志单独列出。',
          '- 最终回复是整批结论，末尾附「日志归属」表，每份日志一行：| 编号 | 根因分组 | 一句话说明 |。',
        ]
      : [],
  ].join('\n'))
  parts.push('## 报告文件', [
    `本次结论会作为报告回传到日志平台${batch ? '每份日志' : '这份日志'}的详情页，平台网页渲染报告入口和其中引用的文件。`,
    '',
    `- 报告入口 \`${REPORT_ENTRY}\` 由观象为每份日志生成，内容是${batch ? '这份日志自己的结论、' : ''}你每一轮的最终回复和每轮追问；不要自己创建或修改 \`${REPORT_DIR}/${REPORT_ENTRY}\`。`,
    ...batch
      ? [`- 首轮结束前，为每份日志写一份简短结论到 \`${REPORT_DIR}/${REPORT_LOGS_DIR}/<编号>.md\`（如 \`${REPORT_DIR}/${REPORT_LOGS_DIR}/L1.md\`）：属于哪个根因分组、关键证据、和整批结论不同的地方。它会嵌入这份日志的报告入口；之后的追问改变了某份日志的结论时，同步更新对应文件。`]
      : [],
    `- 需要附带的其他文件（图片、关键日志片段、较长的分析过程等）写到当前工作目录下的 \`${REPORT_DIR}/\` 目录，可以建子目录，不要用符号链接。平台只接受：路径最多 ${REPORT_PATH_MAX_SEGMENTS} 层，每段只用英文字母、数字和 \`. _ -\` 且不以点开头；扩展名为 ${REPORT_EXTENSIONS.join('/')}；文件不能为空，单个不超过 ${mib(limits.maxFileBytes)}（Markdown 不超过 ${mib(limits.maxMarkdownBytes)}）；每份报告最多 ${limits.maxFiles} 个文件、共 ${mib(limits.maxBytes)}。不符合的文件不会上传，会列在报告末尾。`,
    `- 在最终回复${batch ? `和 \`${REPORT_DIR}/${REPORT_LOGS_DIR}/\` 下的结论文件` : ''}里，用以 \`${REPORT_DIR}/\` 开头的相对路径引用这些文件：图片写成 \`![说明](${REPORT_DIR}/xxx.png)\`，文档写成 \`[说明](${REPORT_DIR}/xxx.md)\`。不要写本机绝对路径或 \`${REPORT_DIR}/\` 以外的路径，平台打不开。其他子文档引用同目录下的文件时，用相对于该文档的路径。`,
    '- 报告会发到外部系统：令牌、密码、密钥等敏感信息要打码。',
  ].join('\n'))
  return `${parts.join('\n\n')}\n`
}
