import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FeishuTopicService, TopicLaunchResult, TopicLaunchSpec } from '../src/analyze/feishu-topics.ts'
import { ANALYZE_MAX_PROMPT_CHARS, analyzeRequestHash, parseAnalyzeRequest, REPORT_PROMPT_RESERVE } from '../src/analyze/contract.ts'
import type { AnalyzeRequest } from '../src/analyze/contract.ts'
import { analyzeResponseOf, analyzeTopicSpec, lookupTopics, REPORT_PROMPT_SECTION } from '../src/analyze/topics.ts'
import { apply } from '../src/index.ts'
import type { HostContext, HostCredentials } from '../src/host.ts'
import type { StateWire } from '../src/settings/contract.ts'
import { tempDir } from './helpers.ts'

type Handler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>

const REQUEST: AnalyzeRequest = {
  requesterUserId: 'u_alice',
  triggeredAt: '2026-10-28 09:30',
  app: 'order-service',
  errorCode: 'E1001',
  logDetails: [{ name: '日志 1', url: 'https://logs.example.com/d/1' }],
  chatId: 'oc_group1',
  prompt: '/logalyze 分析这些日志',
}

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { await Promise.all(cleanups.splice(0).map(cleanup => cleanup())) })

function fakeTopics(result: TopicLaunchResult = { ok: true, replayed: false, chatId: 'oc_group1', messageId: 'om_root' }): FeishuTopicService & { specs: TopicLaunchSpec[]; next: TopicLaunchResult } {
  const service = {
    version: 1 as const,
    specs: [] as TopicLaunchSpec[],
    next: result,
    launch: async (spec: TopicLaunchSpec) => { service.specs.push(spec); return service.next },
  }
  return service
}

function fakeCredentials(): HostCredentials & { stored: Map<string, string> } {
  const stored = new Map<string, string>()
  return {
    stored,
    resolve: async (ref) => { const value = stored.get(ref); return value === undefined ? undefined : { value, source: 'file' } },
    describe: async ref => stored.has(ref) ? { configured: true, source: 'file', writable: true } : { configured: false, writable: true },
    set: async (ref, value) => { stored.set(ref, value) },
    unset: async (ref) => { stored.delete(ref) },
  }
}

async function harness(services: Record<string, unknown>, config: Record<string, unknown> = {}): Promise<{ base: string; routes: Map<string, Handler>; warn: ReturnType<typeof vi.fn> }> {
  const routes = new Map<string, Handler>()
  const disposers: (() => void)[] = []
  const warn = vi.fn()
  const webServer = {
    register: (route: { path: string; handler: Handler }) => {
      if (routes.has(route.path)) throw new Error(`already registered: ${route.path}`)
      routes.set(route.path, route.handler)
      return () => { routes.delete(route.path) }
    },
  }
  const all: Record<string, unknown> = { webServer, connection: { requestRejection: () => undefined }, ...services }
  const ctx: HostContext = {
    tools: { register: () => () => {} },
    skills: { registerProvider: () => () => {} },
    subagents: { getProvider: () => ({}), resolveMaxDepth: () => 1, startActivation: () => Promise.reject(new Error('not used')) },
    logger: { warn },
    get: (name: string) => all[name],
    on: () => () => {},
    effect: (callback) => {
      const dispose = callback()
      const wrapped = (): void => { dispose?.() }
      disposers.push(wrapped)
      return wrapped
    },
    // Like Cordis, the callback runs only once every dependency is present.
    inject: (deps, callback) => { if (deps.every(dep => all[dep] !== undefined)) callback(ctx) },
  }
  const { dir, cleanup } = await tempDir()
  apply(ctx, config, { overlayPath: join(dir, 'settings.json'), reportsDir: join(dir, 'reports') })
  const server: Server = createServer((req, res) => {
    const handler = routes.get(new URL(req.url ?? '/', 'http://x').pathname)
    if (handler === undefined) {
      res.writeHead(404)
      res.end()
      return
    }
    void handler(req, res)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(async () => {
    for (const dispose of disposers.reverse()) dispose()
    await new Promise(resolve => server.close(resolve))
    await cleanup()
  })
  return { base: `http://127.0.0.1:${(server.address() as { port: number }).port}`, routes, warn }
}

function post(base: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${base}/open-api/logalyze`, {
    method: 'POST',
    headers: { 'authorization': 'Bearer secret-token', 'idempotency-key': 'req-1', 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

async function errorOf(response: Response): Promise<string> {
  return (await response.json() as { error: string }).error
}

describe('analyze contract', () => {
  it('keeps a stable request fingerprint', () => {
    expect(analyzeRequestHash(REQUEST)).toBe('8f934b9451fb62025000db4c0e24800a8d6f6e88330b3350d0fc3c8c32fdf454')
  })

  it('lists every invalid field', () => {
    const parsed = parseAnalyzeRequest({ ...REQUEST, requesterUserId: 'ou_open', app: '..', logDetails: [], extra: 1 })
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.error).toMatch(/^请求参数不合法：/)
    for (const field of ['requesterUserId', 'app', 'logDetails', '(body)']) expect(parsed.error).toContain(field)
  })

  it('builds the analysis topic with the card, workspace, and the raw key', () => {
    expect(analyzeTopicSpec(REQUEST, 'req-1')).toEqual({
      key: 'req-1',
      fingerprint: analyzeRequestHash(REQUEST),
      chatId: 'oc_group1',
      requesterUserId: 'u_alice',
      card: {
        title: '日志分析',
        taskName: '分析',
        lead: [
          { text: '于 2026-10-28 09:30 发起了对 ' },
          { text: 'order-service', bold: true },
          { text: ' 应用 ' },
          { text: 'E1001', bold: true },
          { text: ' 错误码不良日志的分析。' },
        ],
        links: { nameHeader: '日志', linkHeader: '详情页', rows: REQUEST.logDetails },
      },
      workspace: { segments: ['analyze', 'order-service', 'E1001'], title: '日志分析 · order-service · E1001' },
      prompt: REQUEST.prompt,
    })
  })

  it('adds logId to the fingerprint only when present and asks for report files in the prompt', () => {
    const withLogId = { ...REQUEST, logId: 'L-1' }
    expect(analyzeRequestHash(withLogId)).not.toBe(analyzeRequestHash(REQUEST))
    expect(parseAnalyzeRequest(withLogId)).toEqual({ ok: true, value: withLogId })
    for (const logId of ['-x', '.x', 'a b', 'a/b', '']) expect(parseAnalyzeRequest({ ...REQUEST, logId }).ok).toBe(false)
    const long = parseAnalyzeRequest({ ...withLogId, prompt: 'x'.repeat(ANALYZE_MAX_PROMPT_CHARS - REPORT_PROMPT_RESERVE + 1) })
    expect(long.ok === false && long.error).toContain('prompt')
    expect(REPORT_PROMPT_SECTION.length).toBeLessThan(REPORT_PROMPT_RESERVE)
    expect(analyzeTopicSpec(withLogId, 'req-1').prompt).toBe(`${REQUEST.prompt}${REPORT_PROMPT_SECTION}`)
    expect(REPORT_PROMPT_SECTION).toContain('report/')
  })

  it('maps launch results to HTTP answers', () => {
    expect(analyzeResponseOf({ ok: true, replayed: true, chatId: 'oc_a', messageId: 'om_a' })).toEqual({ status: 202, body: { ok: true, chatId: 'oc_a', messageId: 'om_a' } })
    const status = (code: Exclude<TopicLaunchResult, { ok: true }>['code']): number => analyzeResponseOf({ ok: false, code, message: 'x' }).status
    expect([status('not-connected'), status('forbidden-chat'), status('key-conflict'), status('send-failed'), status('invalid')]).toEqual([503, 403, 409, 502, 500])
    expect(analyzeResponseOf({ ok: false, code: 'key-conflict', message: 'x' }).body).toEqual({ ok: false, error: 'Idempotency-Key 已被内容不同的请求使用' })
  })

  it('accepts only a provider of contract version 1', () => {
    expect(lookupTopics(undefined).availability).toBe('missing')
    expect(lookupTopics({ version: 2, launch: () => undefined }).availability).toBe('incompatible')
    expect(lookupTopics(fakeTopics()).availability).toBe('ready')
  })
})

describe('analyze route', () => {
  it('is not registered without feishuTopics', async () => {
    const credentials = fakeCredentials()
    const h = await harness({ credentials }, { analyze: { enabled: true } })
    expect(h.routes.has('/open-api/logalyze')).toBe(false)
    const state = await (await fetch(`${h.base}/logalyze/state`)).json() as StateWire
    expect(state.analyze).toEqual({ route: '/open-api/logalyze', tokenEnv: 'LOGALYZE_ANALYZE_TOKEN', token: { tokenEnv: 'LOGALYZE_ANALYZE_TOKEN', configured: false, writable: true }, topics: 'missing', reportsSupported: false, reports: [] })
  })

  it('is not registered for an incompatible provider', async () => {
    const h = await harness({ feishuTopics: { version: 2, launch: () => undefined } })
    expect(h.routes.has('/open-api/logalyze')).toBe(false)
    expect(h.warn).toHaveBeenCalledWith(expect.stringContaining('版本与观象不兼容'))
    const state = await (await fetch(`${h.base}/logalyze/state`)).json() as StateWire
    expect(state.analyze.topics).toBe('incompatible')
  })

  it('answers 404 until the panel switches it on', async () => {
    const credentials = fakeCredentials()
    const topics = fakeTopics()
    const h = await harness({ credentials, feishuTopics: topics })
    const off = await post(h.base, REQUEST)
    expect(off.status).toBe(404)
    expect(await errorOf(off)).toContain('「分析接口」')

    const state = await (await fetch(`${h.base}/logalyze/state`)).json() as StateWire
    const saved = await fetch(`${h.base}/logalyze/settings`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...state.settings, analyze: { enabled: true } }) })
    expect(((await saved.json()) as { state: StateWire }).state.overridden).toEqual(['analyze'])
    expect((await post(h.base, REQUEST)).status).toBe(503)
  })

  it('checks the token, headers, and body before launching the topic', async () => {
    const credentials = fakeCredentials()
    const topics = fakeTopics()
    const h = await harness({ credentials, feishuTopics: topics }, { analyze: { enabled: true } })

    const unset = await post(h.base, REQUEST)
    expect(unset.status).toBe(503)
    expect(await errorOf(unset)).toContain('LOGALYZE_ANALYZE_TOKEN')

    const putToken = (tokenEnv: string, value: string): Promise<Response> => fetch(`${h.base}/logalyze/token`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tokenEnv, value }) })
    expect((await putToken('DEEPSEEK_API_KEY', 'x')).status).toBe(400)
    const saved = await putToken('LOGALYZE_ANALYZE_TOKEN', 'secret-token')
    expect(saved.status).toBe(200)
    const savedText = await saved.text()
    expect(savedText).not.toContain('secret-token')
    expect((JSON.parse(savedText) as { state: StateWire }).state.analyze.token).toEqual({ tokenEnv: 'LOGALYZE_ANALYZE_TOKEN', configured: true, source: 'file', writable: true })

    expect((await fetch(`${h.base}/open-api/logalyze`)).status).toBe(405)
    const wrong = await post(h.base, REQUEST, { authorization: 'Bearer nope' })
    expect(wrong.status).toBe(401)
    expect(wrong.headers.get('www-authenticate')).toBe('Bearer')
    expect((await post(h.base, REQUEST, { 'idempotency-key': 'has space' })).status).toBe(400)
    expect((await post(h.base, REQUEST, { 'content-type': 'text/plain' })).status).toBe(415)
    expect((await post(h.base, '{')).status).toBe(400)
    expect(await errorOf(await post(h.base, { ...REQUEST, chatId: 'ou_x' }))).toContain('chatId')
    expect((await post(h.base, { ...REQUEST, prompt: 'x'.repeat(1024 * 1024) })).status).toBe(413)
    expect(topics.specs).toEqual([])

    const accepted = await post(h.base, REQUEST)
    expect(accepted.status).toBe(202)
    expect(await accepted.json()).toEqual({ ok: true, chatId: 'oc_group1', messageId: 'om_root' })
    expect(topics.specs).toEqual([analyzeTopicSpec(REQUEST, 'req-1')])

    topics.next = { ok: false, code: 'forbidden-chat', message: '目标群未授权' }
    const forbidden = await post(h.base, REQUEST)
    expect(forbidden.status).toBe(403)
    expect(await errorOf(forbidden)).toBe('目标群未授权')

    const cleared = await fetch(`${h.base}/logalyze/token`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tokenEnv: 'LOGALYZE_ANALYZE_TOKEN' }) })
    expect(cleared.status).toBe(200)
    expect(credentials.stored.size).toBe(0)
    expect((await post(h.base, REQUEST)).status).toBe(503)
  })

  it('tracks the report of every accepted request with logId', async () => {
    const credentials = fakeCredentials()
    credentials.stored.set('LOGALYZE_ANALYZE_TOKEN', 'secret-token')
    const topics = Object.assign(fakeTopics(), { state: () => undefined, launchKeyOf: () => undefined })
    const h = await harness({ credentials, feishuTopics: topics }, { analyze: { enabled: true } })
    expect((await post(h.base, REQUEST)).status).toBe(202)
    expect((await post(h.base, { ...REQUEST, logId: 'L-1' }, { 'idempotency-key': 'req-2' })).status).toBe(202)
    expect(topics.specs.at(-1)?.prompt).toBe(`${REQUEST.prompt}${REPORT_PROMPT_SECTION}`)
    const state = await (await fetch(`${h.base}/logalyze/state`)).json() as StateWire
    expect(state.analyze.reportsSupported).toBe(true)
    expect(state.analyze.reports).toEqual([expect.objectContaining({ logId: 'L-1', app: 'order-service', errorCode: 'E1001', phase: 'pending', followups: 0, warnings: [] })])
    const retried = await fetch(`${h.base}/logalyze/reports/upload`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'f'.repeat(24) }) })
    expect(retried.status).toBe(400)
  })

  it('reads the token from the configured reference and answers 500 when the service throws', async () => {
    const credentials = fakeCredentials()
    credentials.stored.set('LOG_PLATFORM_TOKEN', 'secret-token')
    const topics = fakeTopics()
    topics.launch = async () => { throw new Error('boom') }
    const h = await harness({ credentials, feishuTopics: topics }, { analyze: { enabled: true }, analyzeTokenRef: 'LOG_PLATFORM_TOKEN' })
    const failed = await post(h.base, REQUEST)
    expect(failed.status).toBe(500)
    expect(await errorOf(failed)).toContain('boom')
    expect(h.warn).toHaveBeenCalled()
  })
})
