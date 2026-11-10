/**
 * 日志平台分析接口在 DSH Web 服务器上的路由。
 *
 * 只在宿主同时提供 `webServer` 和版本兼容的飞书渠道插件 `feishuTopics`
 * 服务时注册精确路由 `POST /open-api/logalyze`；渠道插件未加载、重载
 * 中或版本不兼容时不注册。
 * 本模块按顺序做传输层检查：路径、开关、方法、Bearer 令牌、
 * `Idempotency-Key`、媒体类型、请求体大小和 JSON 校验；通过后交给
 * `feishuTopics`。带 `logId` 的请求被接受（包括重放）后交给报告回传记录。
 * 请求体、令牌和提示词都不写日志。
 *
 * @module dsh-logalyze/analyze/server
 */

import { createHash, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { HostContext, HostWebServer } from '../host.ts'
import {
  ANALYZE_MAX_BODY_BYTES, ANALYZE_ROUTE, IDEMPOTENCY_KEY_PATTERN, parseAnalyzeRequest,
} from './contract.ts'
import type { AnalyzeRequest, AnalyzeResponse } from './contract.ts'
import { FEISHU_TOPICS_SERVICE, lookupTopics } from '../deps/topics.ts'
import { HttpError, mediaTypeOf, readBody, sendJson } from '../util/http.ts'
import { launchAnalysis } from './topics.ts'

/** The plugin side of the route: switch and token, read per request. */
export interface AnalyzeGate {
  /** @returns whether the API is switched on; false answers every request with 404. */
  enabled(): boolean
  /** Credential reference holding the bearer token, named in the 503 answer while it is unset. */
  tokenEnv(): string
  /**
   * Resolve the expected bearer token.
   * @returns the token, or undefined when it is not configured or cannot be read.
   */
  token(): Promise<string | undefined>
}

/** Everything after transport checks: start the analysis of one validated request. */
export type AnalyzeLaunch = (request: AnalyzeRequest, idempotencyKey: string) => Promise<AnalyzeResponse>

/** Receives every accepted (or replayed) request that carries `logId`. */
export type AnalyzeAccepted = (request: AnalyzeRequest & { readonly logId: string }, idempotencyKey: string) => Promise<void>

function send(res: ServerResponse, response: AnalyzeResponse): void {
  sendJson(res, response.status, response.body)
}

function refuse(res: ServerResponse, status: number, error: string, headers: Record<string, string> = {}): void {
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value)
  send(res, { status, body: { ok: false, error } })
}

/** Constant-time token comparison over fixed-length digests. */
function tokenMatches(presented: string, expected: string): boolean {
  const left = createHash('sha256').update(presented).digest()
  const right = createHash('sha256').update(expected).digest()
  return timingSafeEqual(left, right)
}

/** The bearer credential of one request, or undefined. */
function bearerOf(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization
  if (header === undefined) return undefined
  const match = /^Bearer[ \t]+(\S+)[ \t]*$/iu.exec(header)
  return match?.[1]
}

/**
 * Handle one HTTP request against the analyze API.
 * @param req - the incoming request.
 * @param res - its response.
 * @param gate - switch and token.
 * @param launch - starts the analysis of a validated request.
 */
export async function handleAnalyzeHttp(
  req: IncomingMessage,
  res: ServerResponse,
  gate: AnalyzeGate,
  launch: AnalyzeLaunch,
): Promise<void> {
  const pathname = new URL(req.url ?? '/', 'http://analyze.invalid').pathname
  if (pathname !== ANALYZE_ROUTE) {
    refuse(res, 404, '未知路径')
    return
  }
  if (!gate.enabled()) {
    refuse(res, 404, '日志分析接口未开启，请在观象设置面板「分析接口」打开开关')
    return
  }
  if ((req.method ?? 'GET').toUpperCase() !== 'POST') {
    refuse(res, 405, '只接受 POST', { allow: 'POST' })
    return
  }
  const expected = await gate.token()
  if (expected === undefined || expected === '') {
    refuse(res, 503, `分析接口未配置访问令牌，请在观象设置面板「分析接口」保存令牌（凭据名 ${gate.tokenEnv()}）`)
    return
  }
  const presented = bearerOf(req)
  if (presented === undefined || !tokenMatches(presented, expected)) {
    refuse(res, 401, '访问令牌无效', { 'www-authenticate': 'Bearer' })
    return
  }
  const idempotencyKey = req.headers['idempotency-key']
  if (typeof idempotencyKey !== 'string' || !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
    refuse(res, 400, '缺少或不合法的 Idempotency-Key 请求头（1-200 个可见 ASCII 字符）')
    return
  }
  if (mediaTypeOf(req) !== 'application/json') {
    refuse(res, 415, 'Content-Type 必须是 application/json')
    return
  }
  let raw: unknown
  try {
    raw = JSON.parse(await readBody(req, ANALYZE_MAX_BODY_BYTES))
  } catch (error) {
    if (error instanceof HttpError) {
      refuse(res, error.status, error.message)
      return
    }
    refuse(res, 400, '请求体不是合法的 JSON')
    return
  }
  const parsed = parseAnalyzeRequest(raw)
  if (!parsed.ok) {
    refuse(res, 400, parsed.error)
    return
  }
  send(res, await launch(parsed.value, idempotencyKey))
}

/**
 * Register the route while the host provides both `webServer` and a
 * compatible `feishuTopics`; it is removed when either goes away. Requests skip the DSH
 * login gate on purpose: the bearer token is this API's only credential.
 * @param ctx - the plugin context.
 * @param gate - switch and token.
 * @param accepted - starts report tracking of an accepted request with `logId`; its failure is logged and does not change the answer.
 */
export function mountAnalyzeRoute(ctx: HostContext, gate: AnalyzeGate, accepted: AnalyzeAccepted): void {
  const attach = (scope: HostContext): void => {
    const server = scope.get?.('webServer') as HostWebServer | undefined
    if (server === undefined) return
    const topics = lookupTopics(scope.get?.(FEISHU_TOPICS_SERVICE))
    if (topics.availability !== 'ready') {
      if (topics.availability === 'incompatible') ctx.logger?.warn?.('logalyze: 飞书渠道插件的 feishuTopics 服务版本与观象不兼容，分析接口未注册；请把两者升级到相互兼容的版本')
      return
    }
    const { service } = topics
    const launch: AnalyzeLaunch = async (request, key) => {
      const response = await launchAnalysis(service, request, key)
      const { logId } = request
      if (response.status === 202 && logId !== undefined) {
        await accepted({ ...request, logId }, key).catch((error: unknown) => {
          ctx.logger?.warn?.('logalyze: 记录分析报告回传失败：%s', String(error))
        })
      }
      return response
    }
    scope.effect(() => server.register({
      kind: 'exact',
      path: ANALYZE_ROUTE,
      handler: async (req, res) => {
        try {
          await handleAnalyzeHttp(req, res, gate, launch)
        } catch (error) {
          ctx.logger?.warn?.('logalyze: 分析请求处理失败：%s', String(error))
          if (!res.headersSent) refuse(res, 500, `分析请求处理失败：${String(error)}`)
          else res.destroy()
        }
      },
    }), 'logalyze: analyze route')
  }
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer', FEISHU_TOPICS_SERVICE], attach)
    return
  }
  attach(ctx)
}
