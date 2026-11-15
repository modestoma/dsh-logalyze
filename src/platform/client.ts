/**
 * 日志平台开放 API 的客户端：观象作为 OAuth2 client_credentials 客户端换取
 * 访问令牌，按 log_id 查询日志元数据、取临时下载链接，并为每份日志创建、
 * 直传、完成分析修订。
 *
 * - 令牌缓存在内存里，剩余有效期不足 {@link TOKEN_REFRESH_MARGIN_MS} 时重新换取；
 *   接口返回 401 时丢弃缓存的令牌重换一次再试，仍是 401 就按失败返回。
 * - 每次调用都按当前设置读取平台地址与客户端信息，client_secret 每次换令牌时
 *   从 DSH 凭据库读取，不写日志。
 * - 失败统一抛 {@link PlatformError}：`retryable` 表示网络错误、超时、429 和 5xx，
 *   重试可能成功；其余（凭据无效、4xx、响应字段不符）重试无益。
 *
 * @module dsh-logalyze/platform/client
 */

import { z } from 'zod'
import type { PlatformSettings } from '../settings/contract.ts'
import { messageOf } from '../util/errors.ts'

/** A token with less than this much lifetime left is replaced before use: 60 s. */
export const TOKEN_REFRESH_MARGIN_MS = 60_000

/** Most `log_id` values one metadata query may carry (the platform's limit). */
export const MAX_LOG_IDS_PER_QUERY = 100

/** Characters of a platform error body kept in a message. */
const ERROR_BODY_CHARS = 300

/** A failed platform call; the message is user-facing (Chinese). */
export class PlatformError extends Error {
  /**
   * @param message - readable reason.
   * @param retryable - whether retrying the same call may succeed.
   * @param status - HTTP status of the failed response, when there was one.
   */
  constructor(message: string, readonly retryable: boolean, readonly status?: number) {
    super(message)
  }
}

const nullableText = z.string().nullable().optional().transform(value => value ?? null)

/** One `GET /open-api/v1/logs` item, limited to the fields the plugin reads. */
const logItemSchema = z.object({
  log_id: z.string().min(1),
  product_code: nullableText,
  product_sn: nullableText,
  hw_version: nullableText,
  sw_version: nullableText,
  component_code: nullableText,
  component_version: nullableText,
  error_code: nullableText,
  file_name: z.string().min(1),
  storage_type: z.string(),
  log_type: nullableText,
  status: z.string(),
  file_size_bytes: z.union([z.string(), z.number()]).nullable().optional().transform(value => (value === undefined || value === null ? null : String(value))),
  created_at: nullableText,
  archived_at: nullableText,
  detail_url: nullableText,
})

/** Metadata of one platform log. */
export type PlatformLog = z.output<typeof logItemSchema>

const logPageSchema = z.object({
  items: z.array(logItemSchema),
  next_cursor: z.string().nullable().optional(),
})

const downloadUrlSchema = z.object({
  url: z.string().min(1),
  expires_at: z.string().optional(),
  file_name: z.string().min(1),
})

/** A temporary download link of one log. */
export type PlatformDownload = z.output<typeof downloadUrlSchema>

const createdAnalysisSchema = z.object({
  analysis_id: z.string().min(1),
  status: z.string(),
  expires_at: z.string().optional(),
  uploads: z.array(z.object({ path: z.string().min(1), upload_url: z.string().min(1) })),
})

/** A created (or replayed) analysis revision with its upload links. */
export type PlatformAnalysis = z.output<typeof createdAnalysisSchema>

const completedAnalysisSchema = z.object({
  analysis_id: z.string().min(1),
  detail_url: z.string().min(1),
})

const tokenSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.union([z.number(), z.string()]).optional(),
})

/** One file declared in an analysis revision. */
export interface RevisionFile {
  /** Path relative to the revision root. */
  readonly path: string
  readonly sizeBytes: number
}

/** One incremental `GET /open-api/v1/logs` query page. */
export interface ListLogsPageParams {
  readonly archivedFrom: string
  readonly archivedTo: string
  readonly status?: string
  readonly limit?: number
  readonly cursor?: string
}

/** Result of one incremental `GET /open-api/v1/logs` page. */
export interface PlatformLogPage {
  readonly items: readonly PlatformLog[]
  readonly nextCursor?: string
}

/** Collaborators of the client. */
export interface PlatformClientDeps {
  /** Current platform settings. */
  settings(): PlatformSettings
  /**
   * Read the client secret from DSH's credential store.
   * @returns the secret, or undefined when it is not set.
   */
  secret(): Promise<string | undefined>
  readonly fetch?: typeof fetch
  readonly now?: () => number
}

interface CachedToken {
  readonly value: string
  readonly expiresAt: number
  /** Settings the token was issued under; a change discards it. */
  readonly identity: string
}

/** Default token lifetime when the token response omits `expires_in`: the platform's 15 minutes. */
const DEFAULT_TOKEN_LIFETIME_S = 15 * 60

/**
 * What is missing for the platform to be usable, from the settings alone.
 * @param settings - platform settings.
 * @returns a readable reason, or undefined when address, token endpoint, and client id are set.
 */
export function platformProblem(settings: PlatformSettings): string | undefined {
  const missing = [
    settings.baseUrl === undefined ? '接口地址' : undefined,
    settings.tokenUrl === undefined ? '令牌地址' : undefined,
    settings.clientId === undefined ? 'client_id' : undefined,
  ].filter(item => item !== undefined)
  return missing.length === 0 ? undefined : `日志平台未配置：缺少${missing.join('、')}，请在观象设置面板「分析接口」填写`
}

/** Calls the log platform's open API as an OAuth2 client. */
export class PlatformClient {
  private token: CachedToken | undefined
  private pendingToken: Promise<CachedToken> | undefined
  private readonly fetch: typeof fetch
  private readonly now: () => number

  /** @param deps - settings, secret, and I/O seams. */
  constructor(private readonly deps: PlatformClientDeps) {
    this.fetch = deps.fetch ?? fetch
    this.now = deps.now ?? Date.now
  }

  /**
   * Read the metadata of the given logs. Ids the platform does not know or
   * does not let this client see are absent from the result.
   * @param logIds - platform log ids in lowercase, at most {@link MAX_LOG_IDS_PER_QUERY}.
   * @returns the found logs, in the platform's order.
   * @throws PlatformError when the platform cannot be queried.
   */
  async findLogs(logIds: readonly string[]): Promise<PlatformLog[]> {
    const found = new Map<string, PlatformLog>()
    let cursor: string | undefined
    // The platform defaults `limit` to the number of ids, so one page normally holds them all.
    for (let page = 0; page < 10; page += 1) {
      const query = new URLSearchParams()
      for (const id of logIds) query.append('log_id', id)
      query.set('limit', String(Math.min(MAX_LOG_IDS_PER_QUERY, logIds.length)))
      if (cursor !== undefined) query.set('cursor', cursor)
      const body = await this.call('GET', `/open-api/v1/logs?${query.toString()}`, logPageSchema, '查询日志')
      for (const item of body.items) {
        const id = item.log_id.toLowerCase()
        if (logIds.includes(id)) found.set(id, item)
      }
      cursor = body.next_cursor ?? undefined
      if (cursor === undefined || found.size >= logIds.length) break
    }
    return [...found.values()]
  }

  /**
   * Poll one page of archived logs in `[archivedFrom, archivedTo)`.
   * Sends only `LogQuery`-accepted query fields (`archived_from`, `archived_to`,
   * `status`, `limit`, `cursor`) so strict OpenAPI servers never reject unknown fields.
   */
  async listLogsPage(params: ListLogsPageParams): Promise<PlatformLogPage> {
    const query = new URLSearchParams()
    query.set('archived_from', params.archivedFrom)
    query.set('archived_to', params.archivedTo)
    query.set('status', params.status ?? 'completed')
    const limit = Math.min(MAX_LOG_IDS_PER_QUERY, Math.max(1, Math.trunc(params.limit ?? MAX_LOG_IDS_PER_QUERY)))
    query.set('limit', String(limit))
    if (params.cursor !== undefined) query.set('cursor', params.cursor)
    const body = await this.call('GET', `/open-api/v1/logs?${query.toString()}`, logPageSchema, '增量拉取归档日志')
    const nextCursor = body.next_cursor ?? undefined
    return {
      items: body.items,
      ...(nextCursor === undefined || nextCursor === '' ? {} : { nextCursor }),
    }
  }

  /**
   * Get a fresh temporary download link of one log.
   * @param logId - platform log id.
   * @returns the link and the log's file name.
   * @throws PlatformError when the platform refuses or cannot be reached.
   */
  async downloadUrl(logId: string): Promise<PlatformDownload> {
    return await this.call('GET', `/open-api/v1/logs/${encodeURIComponent(logId)}/download-url`, downloadUrlSchema, '获取日志下载链接')
  }

  /**
   * Create an analysis revision of one log, or replay the one created under
   * the same idempotency key (with its pending upload links signed again).
   * @param logId - platform log id.
   * @param idempotencyKey - `Idempotency-Key` header value.
   * @param entryPath - entry Markdown path, one of `files`.
   * @param files - every file of the revision.
   * @returns the revision id, status, and upload links in `files` order.
   * @throws PlatformError; status 409 means the key was used with other files.
   */
  async createAnalysis(logId: string, idempotencyKey: string, entryPath: string, files: readonly RevisionFile[]): Promise<PlatformAnalysis> {
    return await this.call('POST', `/open-api/v1/logs/${encodeURIComponent(logId)}/analyses`, createdAnalysisSchema, '创建分析修订', {
      body: { entry_path: entryPath, files: files.map(file => ({ path: file.path, size_bytes: String(file.sizeBytes) })) },
      headers: { 'idempotency-key': idempotencyKey },
    })
  }

  /**
   * Complete an analysis revision after every file was uploaded.
   * @param logId - platform log id.
   * @param analysisId - the revision id.
   * @returns the log's analysis page, fixed per log.
   * @throws PlatformError when a file is missing or the platform cannot be reached.
   */
  async completeAnalysis(logId: string, analysisId: string): Promise<string> {
    const body = await this.call('POST', `/open-api/v1/logs/${encodeURIComponent(logId)}/analyses/${encodeURIComponent(analysisId)}/complete`, completedAnalysisSchema, '完成分析修订')
    return body.detail_url
  }

  /**
   * Upload one file to a presigned link, without the platform's token.
   * @param url - the revision's `upload_url`.
   * @param content - file bytes.
   * @param timeoutMs - per-upload timeout.
   * @throws PlatformError, always retryable: a 4xx usually means the link expired, and recreating the revision signs a new one.
   */
  async put(url: string, content: Uint8Array, timeoutMs: number): Promise<void> {
    let response: Response
    try {
      response = await this.fetch(url, {
        method: 'PUT',
        headers: { 'content-type': 'application/octet-stream' },
        body: content,
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (error) {
      throw new PlatformError(`上传文件失败：${transferMessage(error, timeoutMs)}`, true)
    }
    if (response.ok) {
      await response.body?.cancel()
      return
    }
    // An expired link usually answers 403; a retry creates the revision again
    // under the same key, which signs new links, so every status is retryable.
    throw new PlatformError(`上传文件失败：HTTP ${response.status}${await errorDetail(response)}`, true, response.status)
  }

  /** Forget the cached token, so the next call requests a new one (settings or secret changed). */
  reset(): void {
    this.token = undefined
  }

  private async call<T extends z.ZodType>(
    method: 'GET' | 'POST',
    path: string,
    schema: T,
    action: string,
    options: { readonly body?: unknown; readonly headers?: Readonly<Record<string, string>> } = {},
  ): Promise<z.output<T>> {
    const settings = this.deps.settings()
    const problem = platformProblem(settings)
    if (problem !== undefined) throw new PlatformError(problem, false)
    const url = new URL(path.replace(/^\//u, ''), `${settings.baseUrl?.replace(/\/*$/u, '')}/`).href
    let response = await this.send(method, url, await this.accessToken(settings), settings, options, action)
    if (response.status === 401) {
      await response.body?.cancel()
      this.token = undefined
      response = await this.send(method, url, await this.accessToken(settings), settings, options, action)
      if (response.status === 401) {
        throw new PlatformError(`${action}失败：日志平台拒绝了观象的访问令牌（401），请检查 client_id、client_secret 与授权范围${await errorDetail(response)}`, false, 401)
      }
    }
    if (!response.ok) {
      throw new PlatformError(`${action}失败：HTTP ${response.status}${await errorDetail(response)}`, retryableStatus(response.status), response.status)
    }
    let raw: unknown
    try {
      raw = await response.json()
    } catch (error) {
      throw new PlatformError(`${action}失败：响应不是合法的 JSON（${messageOf(error)}）`, true, response.status)
    }
    const parsed = schema.safeParse(raw)
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      throw new PlatformError(`${action}失败：响应字段不符合约定（${issue === undefined ? '' : `${issue.path.join('.')}: ${issue.message}`}）`, false, response.status)
    }
    return parsed.data
  }

  private async send(
    method: 'GET' | 'POST',
    url: string,
    token: string,
    settings: PlatformSettings,
    options: { readonly body?: unknown; readonly headers?: Readonly<Record<string, string>> },
    action: string,
  ): Promise<Response> {
    const headers: Record<string, string> = { authorization: `Bearer ${token}`, accept: 'application/json', ...options.headers }
    if (options.body !== undefined) headers['content-type'] = 'application/json'
    try {
      return await this.fetch(url, {
        method,
        headers,
        ...options.body === undefined ? {} : { body: JSON.stringify(options.body) },
        redirect: 'error',
        signal: AbortSignal.timeout(settings.timeoutMs),
      })
    } catch (error) {
      throw new PlatformError(`${action}失败：${transferMessage(error, settings.timeoutMs)}`, true)
    }
  }

  /** A valid access token, requesting a new one when the cached one is near expiry or was issued under other settings. */
  private async accessToken(settings: PlatformSettings): Promise<string> {
    const identity = JSON.stringify([settings.tokenUrl, settings.clientId, settings.clientAuth, settings.scope])
    const cached = this.token
    if (cached !== undefined && cached.identity === identity && cached.expiresAt - this.now() > TOKEN_REFRESH_MARGIN_MS) return cached.value
    // Concurrent calls share one token request.
    this.pendingToken ??= this.requestToken(settings, identity).finally(() => { this.pendingToken = undefined })
    const token = await this.pendingToken
    this.token = token
    return token.value
  }

  private async requestToken(settings: PlatformSettings, identity: string): Promise<CachedToken> {
    const secret = await this.deps.secret()
    if (secret === undefined || secret === '') throw new PlatformError('日志平台未配置 client_secret，请在观象设置面板「分析接口」保存', false)
    const clientId = settings.clientId ?? ''
    const form = new URLSearchParams({ grant_type: 'client_credentials' })
    if (settings.scope !== '') form.set('scope', settings.scope)
    const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }
    if (settings.clientAuth === 'basic') {
      // RFC 6749 §2.3.1: both parts are form-encoded before Base64.
      const pair = `${formEncode(clientId)}:${formEncode(secret)}`
      headers.authorization = `Basic ${Buffer.from(pair).toString('base64')}`
    } else {
      form.set('client_id', clientId)
      form.set('client_secret', secret)
    }
    let response: Response
    try {
      response = await this.fetch(settings.tokenUrl ?? '', { method: 'POST', headers, body: form.toString(), redirect: 'error', signal: AbortSignal.timeout(settings.timeoutMs) })
    } catch (error) {
      throw new PlatformError(`换取日志平台访问令牌失败：${transferMessage(error, settings.timeoutMs)}`, true)
    }
    if (!response.ok) {
      const rejected = response.status === 400 || response.status === 401 || response.status === 403
      throw new PlatformError(
        `换取日志平台访问令牌失败：HTTP ${response.status}${rejected ? '，请检查 client_id、client_secret 与授权范围' : ''}${await errorDetail(response)}`,
        retryableStatus(response.status),
        response.status,
      )
    }
    let raw: unknown
    try {
      raw = await response.json()
    } catch (error) {
      throw new PlatformError(`换取日志平台访问令牌失败：响应不是合法的 JSON（${messageOf(error)}）`, true)
    }
    const parsed = tokenSchema.safeParse(raw)
    if (!parsed.success) throw new PlatformError('换取日志平台访问令牌失败：响应没有 access_token', false)
    const seconds = Number(parsed.data.expires_in ?? DEFAULT_TOKEN_LIFETIME_S)
    const lifetime = Number.isFinite(seconds) && seconds > 0 ? seconds : DEFAULT_TOKEN_LIFETIME_S
    return { value: parsed.data.access_token, expiresAt: this.now() + lifetime * 1000, identity }
  }
}

/** `application/x-www-form-urlencoded` encoding of one value. */
function formEncode(value: string): string {
  return new URLSearchParams({ v: value }).toString().slice(2)
}

/**
 * Whether a failed HTTP status may succeed when retried.
 * @param status - response status.
 * @returns true for 408, 429, and 5xx.
 */
export function retryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500
}

function transferMessage(error: unknown, timeoutMs: number): string {
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) return `超过 ${timeoutMs} ms 没有响应`
  const cause = error instanceof Error && error.cause instanceof Error ? `（${error.cause.message}）` : ''
  return `${messageOf(error)}${cause}`
}

/** A short excerpt of an error response: its message field when JSON, else its text, plus the request id. */
async function errorDetail(response: Response): Promise<string> {
  const requestId = response.headers.get('x-request-id')
  let text = ''
  try {
    text = (await response.text()).trim()
  } catch {
    // An unreadable error body leaves only the status.
    text = ''
  }
  let message = text
  try {
    const body = JSON.parse(text) as Record<string, unknown> | null
    const nested = body?.error
    const field = [body?.message, body?.detail, typeof nested === 'object' && nested !== null ? (nested as Record<string, unknown>).message : nested]
      .find(value => typeof value === 'string' && value !== '')
    if (typeof field === 'string') message = field
  } catch {
    // Not JSON: keep the text.
    message = text
  }
  const excerpt = message.length > ERROR_BODY_CHARS ? `${message.slice(0, ERROR_BODY_CHARS)}…` : message
  return `${excerpt === '' ? '' : `：${excerpt}`}${requestId === null ? '' : `（X-Request-Id ${requestId}）`}`
}
