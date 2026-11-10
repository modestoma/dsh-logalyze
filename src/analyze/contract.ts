/**
 * 日志平台分析接口的请求与响应。
 *
 * `POST /open-api/logalyze`（DSH Web 服务器上），带
 * `Authorization: Bearer <令牌>`、`Idempotency-Key` 请求头和 JSON 请求体：
 * 发起方类型与标识、触发时间、目标群（可省略，用设置面板的默认群）、同一
 * 应用同一错误码的一批日志平台 `logIds` 和可选的调用方说明。观象按 log_id
 * 向日志平台查元数据（见 `./batch.ts`），合法请求把分析根卡片发进群并回
 * `202`，分析随后在卡片下的话题里流式进行；每轮结束后每份日志各自收到一份
 * 报告修订（见 `../report/`）。
 *
 * @module dsh-logalyze/analyze/contract
 */

import { createHash } from 'node:crypto'
import { z } from 'zod'

import { MAX_LOGS_LIMIT } from '../config.ts'
import { CHAT_ID_PATTERN } from '../settings/contract.ts'

export { ANALYZE_ROUTE } from '../settings/contract.ts'

/** Largest accepted request body. */
export const ANALYZE_MAX_BODY_BYTES = 256 * 1024

/** Largest `instructions`, in characters. */
export const ANALYZE_MAX_INSTRUCTIONS_CHARS = 20_000

/**
 * `Idempotency-Key` format: 1–200 visible ASCII characters without spaces, so
 * a platform can use a UUID or its own `type:id` token.
 */
export const IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x7E]{1,200}$/u

/** Feishu `user_id`: not an `open_id` (`ou_`), `union_id` (`on_`), or chat id (`oc_`). */
const FEISHU_USER_ID = /^(?!ou_|on_|oc_)[A-Za-z0-9_-]+$/u

/** Platform log id: a UUID. */
const LOG_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u

/**
 * Where an analysis was triggered: `digital` from the digital platform, whose
 * `triggerId` is the person's Feishu `user_id`; `machine` from a platform
 * without Feishu identities, whose `triggerId` is that platform's own id of
 * the trigger.
 */
export const TRIGGER_TYPES = ['digital', 'machine'] as const

/** Longest `machine` trigger id, in characters. */
export const MACHINE_TRIGGER_ID_MAX = 128

/** Characters a `machine` trigger id may not contain (it is shown on one card line). */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/u

/**
 * Body fields of the former request format. A request carrying any of them
 * is refused with this explanation instead of the generic unknown-field
 * message: the logs, the application, and the error code now come from the
 * log platform by `logIds`, and reports are uploaded to each log.
 */
const RETIRED_FIELDS: Readonly<Record<string, string>> = {
  prompt: '提示词由观象按日志生成，补充说明放在 instructions',
  logDetails: '日志详情页由观象从日志平台读取',
  logId: '报告按 logIds 回传到每份日志',
  app: '应用由日志的 component_code 对应到应用别名',
  errorCode: '错误码取自日志元数据',
}

/** JSON body of one analyze request. */
export const analyzeRequestSchema = z.object({
  /** Kind of platform that triggered the analysis; decides what {@link triggerId} is. */
  triggerType: z.enum(TRIGGER_TYPES),
  /** `digital`: the person's Feishu user_id. `machine`: the platform's id of the trigger, shown as `[machine] <id>`. */
  triggerId: z.string().min(1).max(MACHINE_TRIGGER_ID_MAX).refine(value => value.trim() !== '', 'must not be blank'),
  /** When the analysis was started on the platform, shown verbatim on the root card. */
  triggeredAt: z.string().min(1).max(64).refine(value => value.trim() !== '', 'must not be blank'),
  /** Target group chat (`oc_…`) the bot is in; omitted uses the panel's default group. */
  chatId: z.string().regex(CHAT_ID_PATTERN, 'must be a Feishu group chat_id (oc_...)').optional(),
  /** Platform log ids (UUIDs) of one application and one error code; compared in lowercase. */
  logIds: z.array(z.string().transform(value => value.toLowerCase()).pipe(z.string().regex(LOG_ID, 'must be a log UUID')))
    .min(1).max(MAX_LOGS_LIMIT),
  /** The caller's notes for the analysis, shown to the analysis as written. */
  instructions: z.string().max(ANALYZE_MAX_INSTRUCTIONS_CHARS).refine(value => value.trim() !== '', 'must not be blank').optional(),
}).strict().superRefine((request, issues) => {
  if (request.triggerType === 'digital' && !FEISHU_USER_ID.test(request.triggerId)) {
    issues.addIssue({ code: 'custom', path: ['triggerId'], message: 'must be a Feishu user_id when triggerType is digital' })
  }
  if (request.triggerType === 'machine' && CONTROL_CHARS.test(request.triggerId)) {
    issues.addIssue({ code: 'custom', path: ['triggerId'], message: 'must be one line without control characters' })
  }
  const seen = new Set<string>()
  for (const [index, id] of request.logIds.entries()) {
    if (seen.has(id)) issues.addIssue({ code: 'custom', path: ['logIds', index], message: `duplicate log id ${id}` })
    seen.add(id)
  }
})

/** One validated request body, as the caller sent it. */
export type AnalyzeRequestBody = z.infer<typeof analyzeRequestSchema>

/** One validated analyze request with its target group resolved. */
export type AnalyzeRequest = AnalyzeRequestBody & { readonly chatId: string }

/** Body of an accepted (or replayed) request. */
export interface AnalyzeAccepted {
  readonly ok: true
  /** Target group chat id. */
  readonly chatId: string
  /** Root card message id; the analysis topic hangs below it. */
  readonly messageId: string
}

/** Body of a refused request. */
export interface AnalyzeRefused {
  readonly ok: false
  /** Readable reason (Chinese, shown to platform operators). */
  readonly error: string
  /** With status 422: the logs that cannot be analyzed and why. */
  readonly invalidLogs?: readonly { readonly logId: string; readonly reason: string }[]
}

/** One HTTP answer of the analyze handler. */
export interface AnalyzeResponse {
  readonly status: number
  readonly body: AnalyzeAccepted | AnalyzeRefused
}

/**
 * Fingerprint of one validated request, used to tell a retry of the same
 * request from a reused `Idempotency-Key`. Field order is fixed so stored
 * digests stay comparable; the resolved group is hashed, so a retry after the
 * default group changed is a different request. The leading format tag keeps
 * keys used with the former request format from matching.
 * @param request - the validated request.
 * @returns SHA-256 hex digest.
 */
export function analyzeRequestHash(request: AnalyzeRequest): string {
  const canonical = JSON.stringify([
    'logIds-v1', request.triggerType, request.triggerId, request.triggeredAt, request.chatId, request.logIds, request.instructions ?? null,
  ])
  return createHash('sha256').update(canonical).digest('hex')
}

/**
 * Validate one decoded JSON body and resolve its target group.
 * @param raw - the decoded body.
 * @param defaultChatId - the panel's default group, used when the body has no `chatId`.
 * @param maxLogs - most `logIds` one request may name (`analyze.maxLogs`).
 * @returns the request, or a readable reason.
 */
export function parseAnalyzeRequest(raw: unknown, defaultChatId: string | undefined, maxLogs: number): { ok: true; value: AnalyzeRequest } | { ok: false; error: string } {
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
    const retired = Object.keys(raw).filter(key => Object.hasOwn(RETIRED_FIELDS, key))
    if (retired.length > 0) {
      return { ok: false, error: `请求参数不合法：${retired.map(key => `${key} 已不再支持（${RETIRED_FIELDS[key]}）`).join('；')}；请改用 logIds 传日志平台的日志 id` }
    }
  }
  const parsed = analyzeRequestSchema.safeParse(raw)
  if (parsed.success) {
    if (parsed.data.logIds.length > maxLogs) return { ok: false, error: `请求参数不合法：logIds 最多 ${maxLogs} 个，本次 ${parsed.data.logIds.length} 个` }
    const chatId = parsed.data.chatId ?? defaultChatId
    if (chatId === undefined) return { ok: false, error: '请求没有 chatId，观象设置面板「分析接口」也没有设置默认群' }
    return { ok: true, value: { ...parsed.data, chatId } }
  }
  const details = parsed.error.issues
    .map(issue => `${issue.path.join('.') || '(body)'}: ${issue.message}`)
    .join('; ')
  return { ok: false, error: `请求参数不合法：${details}` }
}
