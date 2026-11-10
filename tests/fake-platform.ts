import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { PlatformSettings } from '../src/settings/contract.ts'

/** One log the fake platform knows, in the platform's field names. */
export interface FakeLog {
  log_id: string
  product_sn?: string | null
  hw_version?: string | null
  sw_version?: string | null
  component_code: string | null
  component_version?: string | null
  error_code: string | null
  file_name: string
  storage_type: string
  log_type?: string | null
  status: string
  file_size_bytes?: string | null
  created_at?: string | null
  detail_url?: string | null
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
 * A local stand-in for the log platform's open API: the token endpoint,
 * metadata query, download links, and analysis revisions with presigned
 * uploads. Failures are injected per route with {@link FakePlatform.fail}.
 */
export class FakePlatform {
  readonly logs = new Map<string, FakeLog>()
  readonly contents = new Map<string, string>()
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
    return { baseUrl: this.base, tokenUrl: `${this.base}/oauth/token`, clientId: 'logalyze', clientAuth: 'body', scope: 'log:search log:download log:upload', timeoutMs: 5000, ...overrides }
  }

  /** Add a log with downloadable content. */
  addLog(log: FakeLog, content = 'log-content'): void {
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
        const ids = url.searchParams.getAll('log_id')
        return send(res, 200, { items: ids.flatMap(id => this.logs.has(id) ? [this.logs.get(id)] : []), next_cursor: null })
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
    const basic = /^Basic (.+)$/u.exec(request.headers.authorization ?? '')?.[1]
    const [id, secret] = basic === undefined
      ? [form.get('client_id'), form.get('client_secret')]
      : Buffer.from(basic, 'base64').toString('utf8').split(':').map(part => decodeURIComponent(part.replace(/\+/gu, ' ')))
    if (form.get('grant_type') !== 'client_credentials' || id !== 'logalyze' || secret !== this.secret) return send(res, 401, { error: 'invalid_client' })
    this.issued += 1
    const token = `token-${this.issued}`
    this.valid.add(token)
    send(res, 200, { access_token: token, token_type: 'Bearer', expires_in: this.expiresIn })
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
      expires_at: '2026-11-10T11:00:00Z',
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
    storage_type: 'fds',
    log_type: 'crash',
    status: 'completed',
    file_size_bytes: '2048',
    created_at: '2026-11-10T08:00:00Z',
    detail_url: `https://logs.example.com/logs/${n}`,
    ...overrides,
  }
}
