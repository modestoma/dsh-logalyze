/**
 * 分析请求到飞书渠道插件 `feishuTopics` 服务的转换：根卡片内容、幂等键与
 * 指纹，以及服务结果到 HTTP 响应的映射。
 *
 * 带 `logId` 的请求在提示词后追加「报告文件」一节，说明报告目录的写法。
 *
 * @module dsh-logalyze/analyze/topics
 */

import type { FeishuTopicService, TopicLaunchResult, TopicLaunchSpec } from '../deps/topics-contract.ts'
import { REPORT_DIR, REPORT_ENTRY } from '../settings/contract.ts'
import { analyzeRequestHash } from './contract.ts'
import type { AnalyzeRequest, AnalyzeResponse } from './contract.ts'

/**
 * Section appended to the prompt of a request with `logId`, telling the
 * analysis how to add files to the uploaded report.
 */
export const REPORT_PROMPT_SECTION = `

## 报告文件

本次分析的结论会以 markdown 报告回传给调用方系统，调用方网页端会渲染报告入口和其中引用的文件。

- 每一轮的最终回复都会写入报告入口 \`${REPORT_ENTRY}\`，它由观象生成，不要自己创建或修改。
- 需要附带的其他文件（图片、关键日志片段、较长的分析过程等）写到当前工作目录下的 \`${REPORT_DIR}/\` 目录，可以建子目录，不要用符号链接。
- 在最终回复中用以 \`${REPORT_DIR}/\` 开头的相对路径引用这些文件：图片写成 \`![说明](${REPORT_DIR}/xxx.png)\`，文档写成 \`[说明](${REPORT_DIR}/xxx.md)\`。不要写本机绝对路径或 \`${REPORT_DIR}/\` 以外的路径，调用方打不开。子文档引用同目录下的其他文件时，用相对于该文档的路径。
- 报告会发到外部系统：令牌、密码、密钥等敏感信息要打码。
`

/**
 * The topic one analyze request starts.
 * @param request - the validated request.
 * @param idempotencyKey - the request's `Idempotency-Key`, used unchanged as the launch key.
 * @returns the launch spec.
 */
export function analyzeTopicSpec(request: AnalyzeRequest, idempotencyKey: string): TopicLaunchSpec {
  return {
    key: idempotencyKey,
    fingerprint: analyzeRequestHash(request),
    chatId: request.chatId,
    requesterUserId: request.requesterUserId,
    card: {
      title: '日志分析',
      taskName: '分析',
      lead: [
        { text: `于 ${request.triggeredAt} 发起了对 ` },
        { text: request.app, bold: true },
        { text: ' 应用 ' },
        { text: request.errorCode, bold: true },
        { text: ' 错误码不良日志的分析。' },
      ],
      links: { nameHeader: '日志', linkHeader: '详情页', rows: request.logDetails },
    },
    prompt: request.logId === undefined ? request.prompt : `${request.prompt}${REPORT_PROMPT_SECTION}`,
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
 * Start the analysis topic of one validated request.
 * @param topics - the `feishuTopics` service.
 * @param request - the validated request.
 * @param idempotencyKey - the request's `Idempotency-Key`.
 * @returns the HTTP answer.
 */
export async function launchAnalysis(topics: FeishuTopicService, request: AnalyzeRequest, idempotencyKey: string): Promise<AnalyzeResponse> {
  return analyzeResponseOf(await topics.launch(analyzeTopicSpec(request, idempotencyKey)))
}

function refused(status: number, error: string): AnalyzeResponse {
  return { status, body: { ok: false, error } }
}
