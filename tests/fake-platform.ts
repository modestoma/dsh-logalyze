import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { analysisIdOf } from '../src/report/store.ts'
import type { AnalysisRecord } from '../src/report/store.ts'
import type { PlatformSettings } from '../src/settings/contract.ts'

/**
 * One log the fake platform knows, in the platform's field names. Mirrors
 * digital_system's `GET /open-api/v1/logs` item, which has no `storage_type`
 * and carries fields the plugin ignores (`request_id`, `client_code`, …).
 */
export interface FakeLog {
  log_id: string
  product_code?: string | null
  product_sn?: string | null
  hw_version?: string | null
  sw_version?: string | null
  component_code: string | null
  component_version?: string | null
  error_code: string | null
  file_name: string
  log_type?: string | null
  status: string
  file_size_bytes?: string | null
  created_at?: string | null
  archived_at?: string | null
  detail_url?: string | null
  request_id?: string
  client_code?: string
  client_name?: string
  factory_code?: string | null
  hw_level?: string | null
  hw_region?: string | null
  file_sha256?: string | null
  last_error?: string | null
}

/** One analysis revision created on the fake platform. */
export interface FakeRevision {
  readonly id: string
  readonly logId: string
  readonly key: string
  readonly body: string
  readonly entry: string
  readonly sizes: ReadonlyMap<string, number>
  readonly files: Map<string, Buffer>
  completed: boolean
}

/** One request the fake platform received. */
export interface FakeRequest {
  readonly method: string
  readonly path: string
  readonly headers: IncomingMessage['headers']
  readonly body: string
}

/**
 * A local stand-in for digital_system's open API: the token endpoint (HTTP
 * Basic only, as digital_system accepts), metadata query (unknown query keys
 * rejected, archive-time filters matching archived logs only), download
 * links, and analysis revisions with presigned uploads. Failures are injected
 * per route with {@link FakePlatform.fail}.
 */
export class FakePlatform {
  readonly logs = new Map<string, FakeLog>()
  readonly contents = new Map<string, string | Buffer | Uint8Array>()
  readonly revisions: FakeRevision[] = []
  readonly requests: FakeRequest[] = []
  /** Secrets accepted by the token endpoint. */
  secret = 'client-secret'
  /** Token lifetime the token endpoint reports, in seconds. */
  expiresIn = 900
  /** Tokens the API accepts; {@link revokeTokens} empties it. */
  private readonly valid = new Set<string>()
  private readonly failures = new Map<string, number[]>()
  private issued = 0
  private server: Server | undefined
  base = ''

  async start(): Promise<void> {
    this.server = createServer((req, res) => { void this.handle(req, res) })
    await new Promise<void>(resolve => this.server?.listen(0, '127.0.0.1', resolve))
    this.base = `http://127.0.0.1:${(this.server.address() as { port: number }).port}`
  }

  async stop(): Promise<void> {
    await new Promise(resolve => this.server?.close(resolve))
  }

  /** Platform settings pointing at this server. */
  settings(overrides: Partial<PlatformSettings> = {}): PlatformSettings {
    return { baseUrl: this.base, tokenUrl: `${this.base}/oauth/token`, clientId: 'supervisor', clientAuth: 'basic', scope: 'log:search log:download log:upload', timeoutMs: 5000, ...overrides }
  }

  /** Add a log with downloadable content. */
  addLog(log: FakeLog, content: string | Buffer | Uint8Array = 'log-content'): void {
    this.logs.set(log.log_id, log)
    this.contents.set(log.log_id, content)
  }

  /**
   * Answer the next requests of one route with the given statuses.
   * @param route - `token`, `logs`, `download`, `create`, `put`, `complete`, or `file`.
   * @param statuses - one status per request; 0 drops the connection.
   */
  fail(route: string, ...statuses: number[]): void {
    this.failures.set(route, [...this.failures.get(route) ?? [], ...statuses])
  }

  /** Make every issued token invalid, as if they expired early. */
  revokeTokens(): void {
    this.valid.clear()
  }

  /** Requests of one route kind. */
  calls(route: string): FakeRequest[] {
    return this.requests.filter(request => routeOf(request.method, request.path) === route)
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const raw = Buffer.concat(chunks)
    const url = new URL(req.url ?? '/', this.base)
    const request: FakeRequest = { method: req.method ?? 'GET', path: `${url.pathname}${url.search}`, headers: req.headers, body: raw.toString('utf8') }
    this.requests.push(request)
    const route = routeOf(request.method, url.pathname)
    const injected = this.failures.get(route)?.shift()
    if (injected === 0) {
      req.socket.destroy()
      return
    }
    if (injected !== undefined) return send(res, injected, { message: `injected ${injected}` })
    if (route === 'token') return this.token(request, res)
    if (route === 'put') return this.put(url.pathname, req, raw, res)
    if (route === 'file') {
      const content = this.contents.get(decodeURIComponent(url.pathname.slice('/files/'.length)))
      if (content === undefined) return send(res, 404, {})
      res.writeHead(200)
      res.end(content)
      return
    }
    const token = /^Bearer (.+)$/u.exec(req.headers.authorization ?? '')?.[1]
    if (token === undefined || !this.valid.has(token)) return send(res, 401, { message: 'invalid token' })
    const segments = url.pathname.split('/').slice(4).map(decodeURIComponent)
    switch (route) {
      case 'logs': {
        if (url.searchParams.has('log_id')) {
          const ids = url.searchParams.getAll('log_id')
          return send(res, 200, { items: ids.flatMap(id => this.logs.has(id) ? [this.logs.get(id)] : []), next_cursor: null })
        }
        return this.queryLogs(url.searchParams, res)
      }
      case 'download': {
        const log = this.logs.get(segments[0] ?? '')
        if (log === undefined) return send(res, 404, { message: 'no log' })
        return send(res, 200, { url: `${this.base}/files/${encodeURIComponent(log.log_id)}?sig=secret`, expires_at: '2026-11-10T10:10:00Z', file_name: log.file_name })
      }
      case 'create': return this.create(segments[0] ?? '', request, res)
      case 'complete': return this.complete(segments[0] ?? '', segments[2] ?? '', res)
      default: return send(res, 404, {})
    }
  }

  private token(request: FakeRequest, res: ServerResponse): void {
    const form = new URLSearchParams(request.body)
    // digital_system: credentials only in the Basic header; a body credential is invalid_request.
    if (form.has('client_id') || form.has('client_secret')) return send(res, 400, { error: 'invalid_request' })
    const basic = /^Basic (.+)$/u.exec(request.headers.authorization ?? '')?.[1]
    if (basic === undefined) return send(res, 401, { error: 'invalid_client' })
    const [id, secret] = Buffer.from(basic, 'base64').toString('utf8').split(':').map(part => decodeURIComponent(part.replace(/\+/gu, ' ')))
    if (form.get('grant_type') !== 'client_credentials') return send(res, 400, { error: 'unsupported_grant_type' })
    if ((form.get('scope') ?? '') === '') return send(res, 400, { error: 'invalid_scope' })
    if (id !== 'supervisor' || secret !== this.secret) return send(res, 401, { error: 'invalid_client' })
    this.issued += 1
    const token = `token-${this.issued}`
    this.valid.add(token)
    send(res, 200, { access_token: token, token_type: 'Bearer', expires_in: this.expiresIn, scope: form.get('scope') })
  }

  private create(logId: string, request: FakeRequest, res: ServerResponse): void {
    const key = request.headers['idempotency-key']
    if (typeof key !== 'string') return send(res, 400, { message: 'missing Idempotency-Key' })
    if (!this.logs.has(logId)) return send(res, 404, { message: 'no log' })
    const existing = this.revisions.find(revision => revision.logId === logId && revision.key === key)
    if (existing !== undefined) {
      if (existing.body !== request.body) return send(res, 409, { message: 'key reused with another body' })
      return send(res, existing.completed ? 200 : 201, this.created(existing))
    }
    const body = JSON.parse(request.body) as { entry_path: string; files: { path: string; size_bytes: string }[] }
    const revision: FakeRevision = {
      id: `an-${this.revisions.length + 1}`,
      logId,
      key,
      body: request.body,
      entry: body.entry_path,
      sizes: new Map(body.files.map(file => [file.path, Number(file.size_bytes)])),
      files: new Map(),
      completed: false,
    }
    this.revisions.push(revision)
    send(res, 201, this.created(revision))
  }

  private created(revision: FakeRevision): unknown {
    const pending = [...revision.sizes.keys()].filter(path => !revision.files.has(path))
    return {
      analysis_id: revision.id,
      status: revision.completed ? 'completed' : 'pending',
      // digital_system: a replay of a completed revision has no links and `expires_at: null`.
      expires_at: revision.completed ? null : '2026-11-10T11:00:00Z',
      uploads: revision.completed ? [] : pending.map(path => ({ path, upload_url: `${this.base}/upload/${revision.id}/${path}?sig=x` })),
    }
  }

  private put(pathname: string, req: IncomingMessage, raw: Buffer, res: ServerResponse): void {
    const [, , id, ...rest] = pathname.split('/')
    const revision = this.revisions.find(item => item.id === id)
    const path = rest.join('/')
    if (revision === undefined || !revision.sizes.has(path)) return send(res, 404, {})
    if (req.headers.authorization !== undefined || req.headers['content-type'] !== 'application/octet-stream') return send(res, 400, { message: 'bad upload headers' })
    revision.files.set(path, raw)
    res.writeHead(200)
    res.end()
  }

  private complete(logId: string, id: string, res: ServerResponse): void {
    const revision = this.revisions.find(item => item.id === id && item.logId === logId)
    if (revision === undefined) return send(res, 404, {})
    const missing = [...revision.sizes].filter(([path, size]) => revision.files.get(path)?.byteLength !== size).map(([path]) => path)
    if (missing.length > 0) return send(res, 409, { message: `missing ${missing.join(',')}` })
    revision.completed = true
    send(res, 200, { analysis_id: id, log_id: logId, status: 'completed', completed_at: '2026-11-10T10:00:00Z', detail_url: `${this.base}/logs/${logId}/analysis` })
  }

  /** The uploaded entry of a revision. */
  entryOf(revision: FakeRevision): string {
    return revision.files.get(revision.entry)?.toString('utf8') ?? ''
  }

  private queryLogs(searchParams: URLSearchParams, res: ServerResponse): void {
    const allowedParams = new Set([
      'limit',
      'cursor',
      'archived_from',
      'archived_to',
      'created_from',
      'created_to',
      'product_code',
      'factory_code',
      'product_sn',
      'sw_version',
      'component_code',
      'component_version',
      'error_code',
      'status',
    ])
    for (const key of searchParams.keys()) {
      if (!allowedParams.has(key)) {
        return send(res, 400, { message: `unknown query parameter: ${key}` })
      }
    }
    const archivedFrom = searchParams.get('archived_from')
    const archivedTo = searchParams.get('archived_to')
    const status = searchParams.get('status')
    const productCode = searchParams.get('product_code')
    const componentCode = searchParams.get('component_code')
    const errorCode = searchParams.get('error_code')
    const limitRaw = searchParams.get('limit')
    const limit = limitRaw === null ? 100 : Number(limitRaw)
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      return send(res, 400, { message: 'invalid limit' })
    }
    const fromMs = archivedFrom === null ? undefined : Date.parse(archivedFrom)
    const toMs = archivedTo === null ? undefined : Date.parse(archivedTo)
    if ((fromMs !== undefined && Number.isNaN(fromMs)) || (toMs !== undefined && Number.isNaN(toMs))) {
      return send(res, 400, { message: 'invalid timestamp' })
    }
    if (fromMs !== undefined && toMs !== undefined && fromMs >= toMs) {
      return send(res, 400, { message: 'archived_from must be strictly before archived_to' })
    }

    const sig = createHash('sha256')
      .update(JSON.stringify({ archivedFrom, archivedTo, status, productCode, componentCode, errorCode }))
      .digest('hex')
      .slice(0, 12)
    let offset = 0
    const cursor = searchParams.get('cursor')
    if (cursor !== null && cursor !== '') {
      const match = /^cursor:([a-f0-9]+):(\d+)$/u.exec(cursor)
      if (match === null || match[1] !== sig) {
        return send(res, 400, { message: 'cursor does not match query filters' })
      }
      offset = Number(match[2])
    }

    const matched = [...this.logs.values()]
      .filter((log) => {
        if (status !== null && log.status !== status) return false
        if (productCode !== null && log.product_code !== productCode) return false
        if (componentCode !== null && log.component_code !== componentCode) return false
        if (errorCode !== null && log.error_code !== errorCode) return false
        if (fromMs !== undefined || toMs !== undefined) {
          // Archive-time conditions match archived logs only.
          const archivedStr = log.archived_at
          const archivedMs = archivedStr === undefined || archivedStr === null ? Number.NaN : Date.parse(archivedStr)
          if (Number.isNaN(archivedMs)) return false
          if (fromMs !== undefined && archivedMs < fromMs) return false
          if (toMs !== undefined && archivedMs >= toMs) return false
        }
        return true
      })
      .sort((a, b) => {
        const ca = a.created_at ?? ''
        const cb = b.created_at ?? ''
        if (ca !== cb) return ca < cb ? 1 : -1
        return a.log_id < b.log_id ? 1 : a.log_id > b.log_id ? -1 : 0
      })

    const pageItems = matched.slice(offset, offset + limit)
    const nextOffset = offset + pageItems.length
    const nextCursor = nextOffset < matched.length ? `cursor:${sig}:${nextOffset}` : null
    send(res, 200, { items: pageItems, next_cursor: nextCursor })
  }
}

function routeOf(method: string, pathname: string): string {
  const path = pathname.split('?')[0] ?? ''
  if (path === '/oauth/token') return 'token'
  if (path.startsWith('/upload/')) return 'put'
  if (path.startsWith('/files/')) return 'file'
  if (method === 'GET' && path === '/open-api/v1/logs') return 'logs'
  if (/^\/open-api\/v1\/logs\/[^/]+\/download-url$/u.test(path)) return 'download'
  if (/^\/open-api\/v1\/logs\/[^/]+\/analyses$/u.test(path)) return 'create'
  if (/^\/open-api\/v1\/logs\/[^/]+\/analyses\/[^/]+\/complete$/u.test(path)) return 'complete'
  return 'other'
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'x-request-id': `req-${status}` })
  res.end(JSON.stringify(body))
}

/** A log UUID ending in the given digit. */
export function logUuid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
}

/** A downloadable log of `order-service` / `E1001`. */
export function orderLog(n: number, overrides: Partial<FakeLog> = {}): FakeLog {
  return {
    log_id: logUuid(n),
    product_sn: `SN${n}`,
    hw_version: 'H1',
    sw_version: '2.0.1',
    component_code: 'order',
    component_version: '1.4.0',
    error_code: 'E1001',
    file_name: `device-${n}.tar.gz`,
    log_type: 'crash',
    status: 'completed',
    file_size_bytes: '2048',
    created_at: '2026-11-10T08:00:00Z',
    archived_at: '2026-11-10T08:01:00Z',
    detail_url: `https://logs.example.com/logs/${n}`,
    request_id: `device-${n}-req`,
    client_code: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
    client_name: 'factory-log-uploader',
    factory_code: '',
    hw_level: 'P1',
    hw_region: 'CN',
    file_sha256: '0'.repeat(64),
    last_error: null,
    ...overrides,
  }
}

/**
 * An analysis the retired analyze API accepted for `order-service` / `E1001`,
 * with nothing recorded or uploaded yet.
 * @param key - its `Idempotency-Key`.
 * @param count - number of logs.
 * @param acceptedAt - acceptance time, epoch milliseconds.
 * @returns the record.
 */
export function analysisRecord(key: string, count = 2, acceptedAt = Date.now()): AnalysisRecord {
  const logs = Array.from({ length: count }, (_, index) => orderLog(index + 1))
  return {
    id: analysisIdOf(key),
    key,
    fingerprint: `fp-${key}`,
    triggerType: 'digital',
    triggerId: 'u_alice',
    triggeredAt: '2026-10-28 09:30',
    chatId: 'oc_group1',
    app: 'order-service',
    appName: '订单服务',
    componentCode: 'order',
    errorCode: 'E1001',
    logs: logs.map((log, index) => ({
      ref: `L${index + 1}`,
      logId: log.log_id,
      fileName: log.file_name,
      productSn: log.product_sn ?? null,
      hwVersion: log.hw_version ?? null,
      swVersion: log.sw_version ?? null,
      componentVersion: log.component_version ?? null,
      logType: log.log_type ?? null,
      sizeBytes: log.file_size_bytes ?? null,
      createdAt: log.created_at ?? null,
      ...log.detail_url === null || log.detail_url === undefined ? {} : { detailUrl: log.detail_url },
      uploadedRevision: 0,
      generation: 0,
    })),
    acceptedAt,
    sections: [],
    turns: {},
    snapshot: {},
    warnings: [],
    skipped: [],
    revision: 0,
  }
}
