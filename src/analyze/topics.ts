/**
 * 一次分析到飞书渠道插件 `feishuTopics` 服务的转换：分析记录生成的根卡片
 * （每份日志一行，链接到日志详情页，回传后第二列补「分析报告」）、首轮消息、
 * 幂等键与指纹，以及服务结果到 HTTP 响应的映射。
 *
 * @module dsh-logalyze/analyze/topics
 */

import type { TopicCardLinks, TopicLaunchResult, TopicLaunchSpec, TopicRequester } from '../deps/topics-contract.ts'
import { UNLABELED_ERROR_CODE } from '../report/render.ts'
import type { AnalysisRecord } from '../report/store.ts'
import type { UploadSettings } from '../settings/contract.ts'
import type { AnalyzeRequest, AnalyzeResponse } from './contract.ts'
import { analysisPrompt } from './prompt.ts'

/** Longest row label the card accepts. */
const ROW_NAME_MAX = 200

/**
 * The root card requester of one request: a `digital` trigger is the Feishu
 * user it names, a `machine` trigger is shown as `[machine] <triggerId>`.
 * @param request - the validated request.
 * @returns the requester.
 */
export function analyzeRequester(request: Pick<AnalyzeRequest, 'triggerType' | 'triggerId'>): TopicRequester {
  switch (request.triggerType) {
    case 'digital': return { kind: 'feishu-user', userId: request.triggerId }
    case 'machine': return { kind: 'external', label: `[machine] ${request.triggerId}` }
    default: return assertNever(request.triggerType)
  }
}

function assertNever(value: never): never {
  throw new Error(`unexpected trigger type: ${String(value)}`)
}

/**
 * The root card's link table: one row per log, linking its platform page and,
 * once its first revision completed, its analysis page.
 * @param record - the analysis.
 * @returns the table.
 */
export function analysisCardLinks(record: AnalysisRecord): TopicCardLinks {
  return {
    nameHeader: '日志',
    linkHeader: '详情页',
    extraLinkHeader: '分析报告',
    rows: record.logs.map((log) => {
      const label = [log.ref, log.fileName, log.productSn].filter(part => part !== null && part !== '').join(' · ')
      return {
        name: label.length > ROW_NAME_MAX ? `${label.slice(0, ROW_NAME_MAX - 1)}…` : label,
        ...log.detailUrl === undefined ? {} : { url: log.detailUrl },
        ...log.reportUrl === undefined ? {} : { extraUrl: log.reportUrl },
      }
    }),
  }
}

/**
 * The topic one analysis starts.
 * @param record - the accepted analysis.
 * @param limits - upload limits named in the prompt's report rules.
 * @returns the launch spec; the analysis key is the launch key unchanged.
 */
export function analysisTopicSpec(record: AnalysisRecord, limits: UploadSettings): TopicLaunchSpec {
  return {
    key: record.key,
    fingerprint: record.fingerprint,
    chatId: record.chatId,
    requester: analyzeRequester(record),
    card: {
      title: '日志分析',
      taskName: '分析',
      lead: [
        { text: `于 ${record.triggeredAt} 发起了对 ` },
        { text: record.appName, bold: true },
        { text: ' 应用 ' },
        { text: record.errorCode ?? UNLABELED_ERROR_CODE, bold: true },
        { text: ` 错误码 ${record.logs.length} 份日志的分析。` },
      ],
      links: analysisCardLinks(record),
    },
    prompt: analysisPrompt(record, limits),
  }
}

/**
 * HTTP answer of one launch result.
 * @param result - what the service answered.
 * @returns status and body.
 */
export function analyzeResponseOf(result: TopicLaunchResult): AnalyzeResponse {
  if (result.ok) return { status: 202, body: { ok: true, chatId: result.chatId, messageId: result.messageId } }
  switch (result.code) {
    case 'not-connected': return refused(503, result.message)
    case 'forbidden-chat': return refused(403, result.message)
    case 'key-conflict': return refused(409, 'Idempotency-Key 已被内容不同的请求使用')
    case 'send-failed': return refused(502, result.message)
    // The request passed this plugin's own validation, so a refused spec is a
    // disagreement between the two plugins, not a client error.
    case 'invalid': return refused(500, `分析请求处理失败：${result.message}`)
    default: return refused(500, `分析请求处理失败：${String((result as { message?: unknown }).message)}`)
  }
}

/**
 * A refused answer.
 * @param status - HTTP status.
 * @param error - readable reason.
 * @returns status and body.
 */
export function refused(status: number, error: string): AnalyzeResponse {
  return { status, body: { ok: false, error } }
}
