/**
 * 设置面板的 HTTP 路由，挂在宿主可选的 `webServer` 上（没有 Web 的组合不挂载）。
 * 每个请求先经宿主 `connection.requestRejection`（与 DSH `/api` 相同的
 * Host/Origin 校验和登录 cookie 鉴权）；写操作另做同源校验。
 *
 * @module dsh-logalyze/settings/routes
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { HostContext, HostRequestGate, HostWebServer } from '../host.ts'
import type { LogalyzeService } from '../service.ts'
import { HttpError, mediaTypeOf, readBody, sendJson } from '../util/http.ts'
import { SettingsError } from './controller.ts'
import { REPORT_UPLOAD_ROUTE, SETTINGS_ROUTE, STATE_ROUTE, SYNC_ROUTE, TOKEN_ROUTE } from './contract.ts'

type WebHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>

/** Request body cap: the settings payload is small. */
const MAX_BODY_BYTES = 256 * 1024

/**
 * Mutating requests must come from the same origin. A missing Origin (curl and
 * other non-browser local clients) is allowed; a mismatched one is refused.
 * @param req - incoming request.
 * @returns whether the write is same-origin.
 */
export function isSameOriginRequest(req: IncomingMessage): boolean {
  const origin = req.headers.origin
  if (origin === undefined || origin === '') return true
  const host = req.headers.host
  if (host === undefined) return false
  try {
    return new URL(origin).host === host
  } catch {
    // An unparsable Origin is not this origin.
    return false
  }
}

async function readJsonBody(req: IncomingMessage, optional: boolean): Promise<unknown> {
  const text = await readBody(req, MAX_BODY_BYTES)
  if (text === '') {
    if (optional) return undefined
    throw new HttpError(400, '请求体为空')
  }
  if (mediaTypeOf(req) !== 'application/json') throw new HttpError(415, '请求体必须是 application/json')
  try {
    return JSON.parse(text)
  } catch {
    // The parse error position is not useful to the panel.
    throw new HttpError(400, '请求体不是合法 JSON')
  }
}

function guarded(gate: HostRequestGate, methods: readonly string[], handler: WebHandler): WebHandler {
  return async (req, res) => {
    const rejection = gate.requestRejection(req)
    if (rejection !== undefined) {
      sendJson(res, rejection, { ok: false, error: rejection === 401 ? '未登录 DSH，请从 DSH 启动链接打开页面' : '请求来源不受信任' })
      return
    }
    const method = (req.method ?? 'GET').toUpperCase()
    if (!methods.includes(method)) {
      res.setHeader('allow', methods.join(', '))
      sendJson(res, 405, { ok: false, error: `方法 ${method} 不受支持` })
      return
    }
    if (method !== 'GET' && method !== 'HEAD' && !isSameOriginRequest(req)) {
      sendJson(res, 403, { ok: false, error: '跨站写入被拒绝（Origin 与 Host 不一致）' })
      return
    }
    try {
      await handler(req, res)
    } catch (error) {
      if (res.headersSent) {
        res.end()
        return
      }
      if (error instanceof HttpError) sendJson(res, error.status, { ok: false, error: error.message })
      else if (error instanceof SettingsError) sendJson(res, 400, { ok: false, error: error.message })
      else sendJson(res, 500, { ok: false, error: `内部错误：${error instanceof Error ? error.message : String(error)}` })
    }
  }
}

/**
 * Register the panel routes.
 * @param server - host web server.
 * @param gate - host request gate.
 * @param service - plugin runtime.
 * @returns disposer removing every route.
 */
export function registerSettingsRoutes(server: HostWebServer, gate: HostRequestGate, service: LogalyzeService): () => void {
  const disposers = [
    server.register({
      kind: 'exact',
      path: STATE_ROUTE,
      handler: guarded(gate, ['GET'], async (_req, res) => { sendJson(res, 200, await service.state()) }),
    }),
    server.register({
      kind: 'exact',
      path: SETTINGS_ROUTE,
      handler: guarded(gate, ['PUT', 'DELETE'], async (req, res) => {
        const state = req.method?.toUpperCase() === 'DELETE'
          ? await service.reset()
          : await service.save(await readJsonBody(req, false))
        sendJson(res, 200, { ok: true, state })
      }),
    }),
    server.register({
      kind: 'exact',
      path: SYNC_ROUTE,
      handler: guarded(gate, ['POST'], async (req, res) => {
        const body = await readJsonBody(req, true)
        const url = typeof body === 'object' && body !== null && typeof (body as { url?: unknown }).url === 'string'
          ? (body as { url: string }).url
          : undefined
        service.sync(url)
        sendJson(res, 200, { ok: true, state: await service.state() })
      }),
    }),
    server.register({
      kind: 'exact',
      path: TOKEN_ROUTE,
      handler: guarded(gate, ['PUT', 'DELETE'], async (req, res) => {
        const body = await readJsonBody(req, false)
        const state = req.method?.toUpperCase() === 'DELETE' ? await service.clearToken(body) : await service.setToken(body)
        sendJson(res, 200, { ok: true, state })
      }),
    }),
    server.register({
      kind: 'exact',
      path: REPORT_UPLOAD_ROUTE,
      handler: guarded(gate, ['POST'], async (req, res) => {
        sendJson(res, 200, { ok: true, state: await service.retryReport(await readJsonBody(req, false)) })
      }),
    }),
  ]
  return () => { for (const dispose of disposers) dispose() }
}

/**
 * Mount the routes while both `webServer` and `connection` are available.
 * @param ctx - plugin context.
 * @param service - plugin runtime.
 */
export function mountSettingsRoutes(ctx: HostContext, service: LogalyzeService): void {
  const attach = (webCtx: HostContext): void => {
    const server = webCtx.get?.('webServer') as HostWebServer | undefined
    const gate = webCtx.get?.('connection') as HostRequestGate | undefined
    if (server === undefined || gate === undefined) return
    webCtx.effect(() => registerSettingsRoutes(server, gate, service), 'logalyze: settings routes')
  }
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer', 'connection'], attach)
    return
  }
  attach(ctx)
}
