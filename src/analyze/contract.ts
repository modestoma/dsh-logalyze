/**
 * 日志平台分析接口的请求与响应。
 *
 * `POST /open-api/logalyze`（DSH Web 服务器上），带
 * `Authorization: Bearer <令牌>`、`Idempotency-Key` 请求头和 JSON 请求体：
 * 发起方类型与标识、触发时间、应用与错误码、日志详情页、目标群（可省略，
 * 用设置面板的默认群）和提示词。合法请求把分析根卡片发进群并回 `202`，
 * 分析随后在卡片下的话题里流式进行。日志包由
 * 提示词调用的分析 SKILL 自行获取，详情页只列在卡片上。带 `logId` 的请求在
 * 分析结束后把报告目录交给回传命令（见 `../report/`）。
 *
 * @module dsh-logalyze/analyze/contract
 */

import { createHash } from 'node:crypto'
import { z } from 'zod'

import { CHAT_ID_PATTERN } from '../settings/contract.ts'

export { ANALYZE_ROUTE } from '../settings/contract.ts'

/** Largest accepted request body (the prompt dominates it). */
export const ANALYZE_MAX_BODY_BYTES = 1024 * 1024

/** Largest accepted prompt, in characters. */
export const ANALYZE_MAX_PROMPT_CHARS = 100_000

/**
 * Characters kept free in the prompt of a request with `logId` for the
 * report section appended to it, so the launched prompt stays within the
 * `feishuTopics` limit of {@link ANALYZE_MAX_PROMPT_CHARS}.
 */
export const REPORT_PROMPT_RESERVE = 2000

/**
 * `Idempotency-Key` format: 1–200 visible ASCII characters without spaces, so
 * a platform can use a UUID or its own `type:id` token.
 */
export const IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x7E]{1,200}$/u

/** Feishu `user_id`: not an `open_id` (`ou_`), `union_id` (`on_`), or chat id (`oc_`). */
const FEISHU_USER_ID = /^(?!ou_|on_|oc_)[A-Za-z0-9_-]+$/u

/**
 * Application / error-code segment: it names a workspace directory
 * (`<baseDir>/analyze/<app>/<errorCode>` below the Feishu channel's
 * `baseDir`), so only path-safe characters pass.
 */
const SUBJECT_SEGMENT = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,128}$/u

/** Most detail pages one request may list on its root card. */
export const ANALYZE_MAX_LOG_DETAILS = 50


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
 * Caller-side id of the analysis, passed to the upload command as one
 * argument: path-safe characters only, never starting with `-` or `.`.
 */
export const LOG_ID_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/u

/** JSON body of one analyze request. */
export const analyzeRequestSchema = z.object({
  /** Kind of platform that triggered the analysis; decides what {@link triggerId} is. */
  triggerType: z.enum(TRIGGER_TYPES),
  /** `digital`: the person's Feishu user_id. `machine`: the platform's id of the trigger, shown as `[machine] <id>`. */
  triggerId: z.string().min(1).max(MACHINE_TRIGGER_ID_MAX).refine(value => value.trim() !== '', 'must not be blank'),
  /** When the analysis was started on the platform, shown verbatim on the root card. */
  triggeredAt: z.string().min(1).max(64).refine(value => value.trim() !== '', 'must not be blank'),
  /** Application the logs belong to (workspace directory segment). */
  app: z.string().regex(SUBJECT_SEGMENT, 'must be 1-128 of A-Z a-z 0-9 . _ -'),
  /** Error code of the logs (workspace directory segment). */
  errorCode: z.string().regex(SUBJECT_SEGMENT, 'must be 1-128 of A-Z a-z 0-9 . _ -'),
  /** Log-platform detail pages of the logs that triggered the analysis (listed on the root card). */
  logDetails: z.array(z.object({
    /** Row label. */
    name: z.string().min(1).max(200).refine(value => value.trim() !== '', 'must not be blank'),
    /** Detail page address. */
    url: z.url({ protocol: /^https?$/u, error: 'must be an http(s) URL' }).max(2048),
  }).strict()).min(1).max(ANALYZE_MAX_LOG_DETAILS),
  /** Target group chat (`oc_…`) the bot is in; omitted uses the panel's default group. */
  chatId: z.string().regex(CHAT_ID_PATTERN, 'must be a Feishu group chat_id (oc_...)').optional(),
  /** Prompt forwarded verbatim as the analysis Session's first user message. */
  prompt: z.string().min(1).max(ANALYZE_MAX_PROMPT_CHARS)
    .refine(value => value.trim() !== '', 'must not be blank'),
  /** Caller-side analysis id; present means the report is uploaded after every turn. */
  logId: z.string().regex(LOG_ID_PATTERN, 'must be 1-128 of A-Z a-z 0-9 . _ - and start with a letter, digit, or _').optional(),
}).strict().superRefine((request, issues) => {
  if (request.triggerType === 'digital' && !FEISHU_USER_ID.test(request.triggerId)) {
    issues.addIssue({ code: 'custom', path: ['triggerId'], message: 'must be a Feishu user_id when triggerType is digital' })
  }
  if (request.triggerType === 'machine' && CONTROL_CHARS.test(request.triggerId)) {
    issues.addIssue({ code: 'custom', path: ['triggerId'], message: 'must be one line without control characters' })
  }
  if (request.logId !== undefined && request.prompt.length > ANALYZE_MAX_PROMPT_CHARS - REPORT_PROMPT_RESERVE) {
    issues.addIssue({ code: 'custom', path: ['prompt'], message: `must be at most ${ANALYZE_MAX_PROMPT_CHARS - REPORT_PROMPT_RESERVE} characters when logId is given` })
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
 * default group changed is a different request; `logId` is appended only
 * when present.
 * @param request - the validated request.
 * @returns SHA-256 hex digest.
 */
export function analyzeRequestHash(request: AnalyzeRequest): string {
  const canonical = JSON.stringify([
    request.triggerType, request.triggerId, request.triggeredAt, request.app, request.errorCode,
    request.logDetails.map(detail => [detail.name, detail.url]), request.chatId, request.prompt,
    ...request.logId === undefined ? [] : [request.logId],
  ])
  return createHash('sha256').update(canonical).digest('hex')
}

/**
 * Validate one decoded JSON body and resolve its target group.
 * @param raw - the decoded body.
 * @param defaultChatId - the panel's default group, used when the body has no `chatId`.
 * @returns the request, or a readable reason.
 */
export function parseAnalyzeRequest(raw: unknown, defaultChatId: string | undefined): { ok: true; value: AnalyzeRequest } | { ok: false; error: string } {
  const parsed = analyzeRequestSchema.safeParse(raw)
  if (parsed.success) {
    const chatId = parsed.data.chatId ?? defaultChatId
    if (chatId === undefined) return { ok: false, error: '请求没有 chatId，观象设置面板「分析接口」也没有设置默认群' }
    return { ok: true, value: { ...parsed.data, chatId } }
  }
  const details = parsed.error.issues
    .map(issue => `${issue.path.join('.') || '(body)'}: ${issue.message}`)
    .join('; ')
  return { ok: false, error: `请求参数不合法：${details}` }
}
