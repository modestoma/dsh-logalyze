import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FeishuTopicService, TopicCardLinks, TopicLaunchResult, TopicLaunchSpec, TopicLaunchState } from '../src/deps/topics-contract.ts'
import { resolveBatch } from '../src/analyze/batch.ts'
import { analyzeRequestHash, parseAnalyzeRequest } from '../src/analyze/contract.ts'
import type { AnalyzeRequest } from '../src/analyze/contract.ts'
import { analysisPrompt } from '../src/analyze/prompt.ts'
import { newAnalysisRecord } from '../src/analyze/record.ts'
import { analysisCardLinks, analysisTopicSpec, analyzeRequester, analyzeResponseOf } from '../src/analyze/topics.ts'
import { defaultsOf, resolveConfig } from '../src/config.ts'
import { lookupTopics } from '../src/deps/topics.ts'
import { apply } from '../src/index.ts'
import type { HostContext, HostCredentials } from '../src/host.ts'
import type { PlatformLog } from '../src/platform/client.ts'
import type { AppManifest, StateWire } from '../src/settings/contract.ts'
import { FakePlatform, logUuid, orderLog } from './fake-platform.ts'
import type { FakeLog } from './fake-platform.ts'
import { FakeRepos } from './fake-repos.ts'
import { createAppRepo, tempDir, waitFor } from './helpers.ts'

type Handler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>

const REQUEST: AnalyzeRequest = {
  triggerType: 'digital',
  triggerId: 'u_alice',
  triggeredAt: '2026-10-28 09:30',
  chatId: 'oc_group1',
  logIds: [logUuid(1), logUuid(2)],
  instructions: '重点看支付回调',
}

const UPLOAD = defaultsOf(resolveConfig({})).analyze.upload

const ORDER: AppManifest = { id: 'order-service', name: '订单服务', description: '', aliases: ['order'], logHints: [], skill: 'log-analysis' }
const PAY: AppManifest = { id: 'pay-service', name: '支付服务', description: '', aliases: ['pay'], logHints: [], skill: 'log-analysis' }

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { await Promise.all(cleanups.splice(0).map(cleanup => cleanup())) })

/** Platform metadata as the client returns it. */
function platformLog(log: FakeLog): PlatformLog {
  return {
    product_code: null, product_sn: null, hw_version: null, sw_version: null, component_version: null, log_type: null, file_size_bytes: null, created_at: null, archived_at: null, detail_url: null,
    ...log,
  }
}

type FakeTopics = FeishuTopicService & { specs: TopicLaunchSpec[]; next: TopicLaunchResult; links: { key: string; links: TopicCardLinks | undefined }[] }

function fakeTopics(result: TopicLaunchResult = { ok: true, replayed: false, chatId: 'oc_group1', messageId: 'om_root' }): FakeTopics {
  const service: FakeTopics = {
    version: 3 as const,
    specs: [],
    next: result,
    links: [],
    launch: async (spec: TopicLaunchSpec) => { service.specs.push(spec); return service.next },
    state: (_key: string): TopicLaunchState | undefined => undefined,
    launchKeyOf: (_sessionId: string): string | undefined => undefined,
    updateLinks: async (key, links) => { service.links.push({ key, links }); return { ok: true } },
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

interface RouteHarness {
  base: string
  routes: Map<string, Handler>
  warn: ReturnType<typeof vi.fn>
  state: () => Promise<StateWire>
}

/**
 * The plugin with a web server, a `dshRepos` stand-in serving the example
 * application (component code alias `order`), and the given services.
 */
async function harness(services: Record<string, unknown>, config: Record<string, unknown> = {}): Promise<RouteHarness> {
  const { dir, cleanup } = await tempDir()
  const repos = new FakeRepos(join(dir, 'mirrors'))
  repos.setCatalog([{ url: await createAppRepo(join(dir, 'order-service')) }])
  const routes = new Map<string, Handler>()
  const disposers: (() => Promise<void>)[] = []
  const warn = vi.fn()
  const webServer = {
    register: (route: { path: string; handler: Handler }) => {
      if (routes.has(route.path)) throw new Error(`already registered: ${route.path}`)
      routes.set(route.path, route.handler)
      return () => { routes.delete(route.path) }
    },
  }
  const all: Record<string, unknown> = { webServer, dshRepos: repos, connection: { requestRejection: () => undefined }, ...services }
  const ctx: HostContext = {
    tools: { register: () => () => {} },
    skills: { registerProvider: () => () => {} },
    subagents: { getProvider: () => ({}), resolveMaxDepth: () => 1, startActivation: () => Promise.reject(new Error('not used')) },
    logger: { warn },
    get: (name: string) => all[name],
    on: () => () => {},
    provide: (name, value) => { all[name] = value; return () => { delete all[name] } },
    effect: (callback) => {
      const dispose = callback()
      const wrapped = async (): Promise<void> => { await dispose?.() }
      disposers.push(wrapped)
      return () => { void wrapped() }
    },
    // Like Cordis, the callback runs only once every dependency is present.
    inject: (deps, callback) => { if (deps.every(dep => all[dep] !== undefined)) callback(ctx) },
  }
  apply(ctx, config, { overlayPath: join(dir, 'settings.json'), analysesDir: join(dir, 'analyses'), legacyReportsDir: join(dir, 'reports'), supervisorDir: join(dir, 'supervisor') })
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
    for (const dispose of disposers.reverse()) await dispose()
    await new Promise(resolve => server.close(resolve))
    await cleanup()
  })
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const state = async (): Promise<StateWire> => await (await fetch(`${base}/logalyze/state`)).json() as StateWire
  return { base, routes, warn, state }
}

/** A harness whose analyze route is on, with both credentials stored and the platform configured. */
async function readyHarness(platform: FakePlatform, topics: FakeTopics, analyze: Record<string, unknown> = {}): Promise<RouteHarness & { credentials: ReturnType<typeof fakeCredentials> }> {
  const credentials = fakeCredentials()
  credentials.stored.set('LOGALYZE_ANALYZE_TOKEN', 'secret-token')
  credentials.stored.set('LOGALYZE_PLATFORM_CLIENT_SECRET', platform.secret)
  const h = await harness({ credentials, feishuTopics: topics }, { analyze: { enabled: true, platform: platform.settings(), ...analyze } })
  await waitFor(async () => (await h.state()).repos[0]?.phase === 'ready')
  return { ...h, credentials }
}

async function startPlatform(): Promise<FakePlatform> {
  const platform = new FakePlatform()
  await platform.start()
  cleanups.push(async () => { await platform.stop() })
  return platform
}

function post(base: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${base}/open-api/logalyze`, {
    method: 'POST',
    headers: { 'authorization': 'Bearer secret-token', 'idempotency-key': 'req-1', 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

async function bodyOf(response: Response): Promise<{ ok: boolean; error?: string; invalidLogs?: { logId: string; reason: string }[] }> {
  return await response.json() as { ok: boolean; error?: string }
}

async function errorOf(response: Response): Promise<string> {
  return (await bodyOf(response)).error ?? ''
}

describe('analyze contract', () => {
  it('keeps a stable request fingerprint over the fields that identify a request', () => {
    expect(analyzeRequestHash(REQUEST)).toBe('1035ca982b644b6b2c4a45e471c5ff5a802e9bdcfcec709325c5e14a8efa2b25')
    expect(analyzeRequestHash({ ...REQUEST, logIds: [logUuid(2), logUuid(1)] })).not.toBe(analyzeRequestHash(REQUEST))
    const { instructions: _instructions, ...plain } = REQUEST
    expect(analyzeRequestHash(plain)).not.toBe(analyzeRequestHash(REQUEST))
  })

  it('lists every invalid field and explains the retired ones', () => {
    const parsed = parseAnalyzeRequest({ ...REQUEST, triggerId: 'ou_open', logIds: ['nope'], extra: 1 }, undefined, 10)
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.error).toMatch(/^请求参数不合法：/)
    for (const field of ['triggerId', 'logIds.0', '(body)']) expect(parsed.error).toContain(field)
    const retired = parseAnalyzeRequest({ ...REQUEST, prompt: '/logalyze', app: 'order-service' }, undefined, 10)
    expect(retired.ok === false && retired.error).toContain('prompt 已不再支持（提示词由观象按日志生成，补充说明放在 instructions）')
    expect(retired.ok === false && retired.error).toContain('app 已不再支持')
    const removed = parseAnalyzeRequest({ ...REQUEST, requesterUserId: 'u_alice' }, undefined, 10)
    expect(removed.ok === false && removed.error).toContain('requesterUserId')
  })

  it('validates the trigger by type', () => {
    expect(parseAnalyzeRequest({ ...REQUEST, triggerType: 'machine', triggerId: 'ou_any id/1' }, undefined, 10).ok).toBe(true)
    for (const [triggerType, triggerId] of [['digital', 'ou_open'], ['digital', 'on_union'], ['machine', 'a\nb'], ['machine', '  '], ['machine', 'x'.repeat(129)], ['robot', 'x']]) {
      const parsed = parseAnalyzeRequest({ ...REQUEST, triggerType, triggerId }, undefined, 10)
      expect(parsed.ok, `${triggerType} ${triggerId}`).toBe(false)
    }
  })

  it('reads log ids as lowercase UUIDs, refuses duplicates, and caps their number', () => {
    const upper = parseAnalyzeRequest({ ...REQUEST, logIds: [logUuid(1).toUpperCase()] }, undefined, 10)
    expect(upper.ok && upper.value.logIds).toEqual([logUuid(1)])
    const duplicate = parseAnalyzeRequest({ ...REQUEST, logIds: [logUuid(1), logUuid(1).toUpperCase()] }, undefined, 10)
    expect(duplicate.ok === false && duplicate.error).toContain(`logIds.1: duplicate log id ${logUuid(1)}`)
    expect(parseAnalyzeRequest({ ...REQUEST, logIds: [] }, undefined, 10).ok).toBe(false)
    const many = parseAnalyzeRequest(REQUEST, undefined, 1)
    expect(many.ok === false && many.error).toBe('请求参数不合法：logIds 最多 1 个，本次 2 个')
    expect(parseAnalyzeRequest({ ...REQUEST, instructions: '  ' }, undefined, 10).ok).toBe(false)
    // One root card row per log: the card holds at most 50.
    expect(() => resolveConfig({ analyze: { maxLogs: 51 } })).toThrow()
    expect(resolveConfig({ analyze: { maxLogs: 50 } }).analyze.maxLogs).toBe(50)
  })

  it('falls back to the default group only when the body has no chatId', () => {
    const { chatId: _chatId, ...noChat } = REQUEST
    expect(parseAnalyzeRequest(noChat, 'oc_default', 10)).toEqual({ ok: true, value: { ...REQUEST, chatId: 'oc_default' } })
    expect(parseAnalyzeRequest(REQUEST, 'oc_default', 10)).toEqual({ ok: true, value: REQUEST })
    const missing = parseAnalyzeRequest(noChat, undefined, 10)
    expect(missing.ok === false && missing.error).toContain('默认群')
    expect(analyzeRequestHash({ ...REQUEST, chatId: 'oc_default' })).not.toBe(analyzeRequestHash(REQUEST))
  })
})

describe('analysis batch', () => {
  const found = [platformLog(orderLog(2)), platformLog(orderLog(1, { log_id: logUuid(1).toUpperCase() }))]

  it('resolves the application by alias and keeps the request order', () => {
    const resolved = resolveBatch([logUuid(1), logUuid(2)], found, [ORDER, PAY])
    expect(resolved.ok && resolved.value.app.id).toBe('order-service')
    expect(resolved.ok && resolved.value.logs.map(log => log.product_sn)).toEqual(['SN1', 'SN2'])
    expect(resolved.ok && resolved.value).toMatchObject({ componentCode: 'order', errorCode: 'E1001' })
    const byId = resolveBatch([logUuid(1)], [platformLog(orderLog(1, { component_code: 'pay-service' }))], [ORDER, PAY])
    expect(byId.ok && byId.value.app.id).toBe('pay-service')
    const fullwidth = resolveBatch([logUuid(1)], [platformLog(orderLog(1, { component_code: ' ＯＲＤＥＲ ' }))], [ORDER, PAY])
    expect(fullwidth.ok && fullwidth.value.app.id).toBe('order-service')
  })

  it('lists every log that cannot be analyzed', () => {
    const resolved = resolveBatch([logUuid(1), logUuid(3), logUuid(4), logUuid(5)], [
      platformLog(orderLog(1)),
      platformLog(orderLog(4, { storage_type: 'ftp' })),
      platformLog(orderLog(5, { component_code: null })),
    ], [ORDER])
    expect(resolved.ok).toBe(false)
    if (resolved.ok) return
    expect(resolved.error).toMatch(/^有 3 份日志不能分析：/)
    expect(resolved.invalidLogs?.map(item => item.logId)).toEqual([logUuid(3), logUuid(4), logUuid(5)])
    expect(resolved.invalidLogs?.[0]?.reason).toContain('日志平台没有这份日志')
    expect(resolved.invalidLogs?.[1]?.reason).toContain('storage_type=ftp')
    expect(resolved.invalidLogs?.[2]?.reason).toContain('没有 component_code')
  })

  it('requires one component code and one error code per batch, allowing none for every log', () => {
    const mixed = resolveBatch([logUuid(1), logUuid(2), logUuid(3)], [platformLog(orderLog(1)), platformLog(orderLog(2, { component_code: 'pay' })), platformLog(orderLog(3))], [ORDER, PAY])
    expect(mixed.ok === false && mixed.error).toBe('这批日志的 component_code 不一致：order（2 份）、pay（1 份）；一次请求只能分析同一应用的日志')
    const codes = resolveBatch([logUuid(1), logUuid(2)], [platformLog(orderLog(1)), platformLog(orderLog(2, { error_code: null }))], [ORDER])
    expect(codes.ok === false && codes.error).toContain('error_code 不一致：E1001（1 份）、（空）（1 份）')
    const none = resolveBatch([logUuid(1), logUuid(2)], [platformLog(orderLog(1, { error_code: null })), platformLog(orderLog(2, { error_code: null }))], [ORDER])
    expect(none.ok && none.value.errorCode).toBeNull()
  })

  it('refuses a component code with no application or with several', () => {
    const none = resolveBatch([logUuid(1)], [platformLog(orderLog(1))], [PAY])
    expect(none.ok === false && none.error).toContain('component_code order 没有对应的应用：请在智能监管设置的应用触发别名中加上它')
    const several = resolveBatch([logUuid(1)], [platformLog(orderLog(1))], [ORDER, { ...PAY, aliases: ['ORDER'] }])
    expect(several.ok === false && several.error).toContain('同时对应多个应用（order-service、pay-service）')
  })
})

describe('analysis topic', () => {
  function record(request: AnalyzeRequest = REQUEST, logs: FakeLog[] = [orderLog(1), orderLog(2)]) {
    const batch = resolveBatch(request.logIds, logs.map(platformLog), [ORDER])
    if (!batch.ok) throw new Error(batch.error)
    return newAnalysisRecord(request, 'req-1', analyzeRequestHash(request), batch.value, 1000)
  }

  it('shows a machine trigger as text and a digital trigger as the Feishu user', () => {
    expect(analyzeRequester({ triggerType: 'machine', triggerId: 'app-7' })).toEqual({ kind: 'external', label: '[machine] app-7' })
    expect(analyzeRequester(REQUEST)).toEqual({ kind: 'feishu-user', userId: 'u_alice' })
  })

  it('numbers the logs and keeps only http(s) detail pages', () => {
    const logs = record(REQUEST, [orderLog(1), orderLog(2, { detail_url: 'javascript:alert(1)', product_sn: null })]).logs
    expect(logs.map(log => [log.ref, log.logId, log.detailUrl])).toEqual([['L1', logUuid(1), 'https://logs.example.com/logs/1'], ['L2', logUuid(2), undefined]])
    expect(logs[0]).toMatchObject({ uploadedRevision: 0, generation: 0 })
  })

  it('builds the root card with one row per log and the raw key', () => {
    const analysis = record()
    const spec = analysisTopicSpec(analysis, UPLOAD)
    expect(spec).toMatchObject({ key: 'req-1', fingerprint: analyzeRequestHash(REQUEST), chatId: 'oc_group1', requester: { kind: 'feishu-user', userId: 'u_alice' } })
    expect(spec.card).toEqual({
      title: '日志分析',
      taskName: '分析',
      lead: [
        { text: '于 2026-10-28 09:30 发起了对 ' },
        { text: '订单服务', bold: true },
        { text: ' 应用 ' },
        { text: 'E1001', bold: true },
        { text: ' 错误码 2 份日志的分析。' },
      ],
      links: {
        nameHeader: '日志',
        linkHeader: '详情页',
        extraLinkHeader: '分析报告',
        rows: [
          { name: 'L1 · device-1.tar.gz · SN1', url: 'https://logs.example.com/logs/1' },
          { name: 'L2 · device-2.tar.gz · SN2', url: 'https://logs.example.com/logs/2' },
        ],
      },
    })
    const linked = { ...analysis, logs: analysis.logs.map(log => (log.ref === 'L2' ? { ...log, reportUrl: 'https://logs.example.com/logs/2/analysis' } : log)) }
    expect(analysisCardLinks(linked).rows[1]).toEqual({ name: 'L2 · device-2.tar.gz · SN2', url: 'https://logs.example.com/logs/2', extraUrl: 'https://logs.example.com/logs/2/analysis' })
    const unlabeled = record({ ...REQUEST, logIds: [logUuid(1)] }, [orderLog(1, { error_code: null })])
    expect(analysisTopicSpec(unlabeled, UPLOAD).card.lead[3]).toEqual({ text: '未标注', bold: true })
  })

  it('writes the first prompt with the log table, the caller notes, and the report rules, without download links', () => {
    const prompt = analysisPrompt(record(), UPLOAD)
    expect(prompt.split('\n')[0]).toBe('/logalyze')
    expect(prompt).toContain('- 应用：订单服务（id: `order-service`，由日志的 component_code `order` 对应）')
    expect(prompt).toContain('| L1 | device-1.tar.gz | SN1 | H1 | 2.0.1 | 1.4.0 | crash | 2 KiB | 2026-11-10T08:00:00Z |')
    expect(prompt).toContain('## 调用方说明\n\n> 重点看支付回调')
    expect(prompt).toContain('logs 列出全部 2 个编号（L1、L2）')
    expect(prompt).toContain('report/logs/<编号>.md')
    expect(prompt).toContain('单个不超过 50 MiB（Markdown 不超过 20 MiB）；每份报告最多 50 个文件、共 100 MiB')
    expect(prompt).not.toContain('logs.example.com')
    const single = analysisPrompt(record({ ...REQUEST, logIds: [logUuid(1)], instructions: undefined }, [orderLog(1, { error_code: null })]), UPLOAD)
    expect(single).not.toContain('调用方说明')
    expect(single).not.toContain('report/logs/')
    expect(single).toContain('- 错误码：未标注（日志平台没有错误码）')
  })

  it('maps launch results to HTTP answers', () => {
    expect(analyzeResponseOf({ ok: true, replayed: true, chatId: 'oc_a', messageId: 'om_a' })).toEqual({ status: 202, body: { ok: true, chatId: 'oc_a', messageId: 'om_a' } })
    const status = (code: Exclude<TopicLaunchResult, { ok: true }>['code']): number => analyzeResponseOf({ ok: false, code, message: 'x' }).status
    expect([status('not-connected'), status('forbidden-chat'), status('key-conflict'), status('send-failed'), status('invalid')]).toEqual([503, 403, 409, 502, 500])
  })

  it('accepts only a provider of contract version 3 that reports launches and updates links', () => {
    expect(lookupTopics(undefined).availability).toBe('missing')
    expect(lookupTopics({ version: 2, launch: () => undefined }).availability).toBe('incompatible')
    const { updateLinks: _updateLinks, ...older } = fakeTopics()
    expect(lookupTopics(older).availability).toBe('incompatible')
    expect(lookupTopics(fakeTopics()).availability).toBe('ready')
  })
})

describe('analyze route', () => {
  it('is not registered without feishuTopics', async () => {
    const h = await harness({ credentials: fakeCredentials() }, { analyze: { enabled: true } })
    expect(h.routes.has('/open-api/logalyze')).toBe(false)
    expect((await h.state()).analyze).toEqual({
      route: '/open-api/logalyze',
      tokenEnv: 'LOGALYZE_ANALYZE_TOKEN',
      token: { tokenEnv: 'LOGALYZE_ANALYZE_TOKEN', configured: false, writable: true },
      secretEnv: 'LOGALYZE_PLATFORM_CLIENT_SECRET',
      secret: { tokenEnv: 'LOGALYZE_PLATFORM_CLIENT_SECRET', configured: false, writable: true },
      platformProblem: expect.stringContaining('缺少接口地址、令牌地址、client_id'),
      topics: 'missing',
      actions: 'missing',
      reports: [],
      legacyReports: [],
    })
  })

  it('is not registered for an incompatible provider', async () => {
    const h = await harness({ feishuTopics: { version: 3, launch: () => undefined } })
    expect(h.routes.has('/open-api/logalyze')).toBe(false)
    expect(h.warn).toHaveBeenCalledWith(expect.stringContaining('版本与观象不兼容'))
    expect((await h.state()).analyze.topics).toBe('incompatible')
  })

  it('answers 404 until the panel switches it on', async () => {
    const h = await harness({ credentials: fakeCredentials(), feishuTopics: fakeTopics() })
    const off = await post(h.base, REQUEST)
    expect(off.status).toBe(404)
    expect(await errorOf(off)).toContain('「分析接口」')
    const state = await h.state()
    const saved = await fetch(`${h.base}/logalyze/settings`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...state.settings, analyze: { ...state.settings.analyze, enabled: true } }) })
    expect(((await saved.json()) as { state: StateWire }).state.overridden).toEqual(['analyze'])
    expect((await post(h.base, REQUEST)).status).toBe(503)
  })

  it('checks the token, headers, and body, and stores both credentials from the panel', async () => {
    const credentials = fakeCredentials()
    const topics = fakeTopics()
    const h = await harness({ credentials, feishuTopics: topics }, { analyze: { enabled: true } })

    const unset = await post(h.base, REQUEST)
    expect(unset.status).toBe(503)
    expect(await errorOf(unset)).toContain('LOGALYZE_ANALYZE_TOKEN')

    const putCredential = (tokenEnv: string, value: string): Promise<Response> => fetch(`${h.base}/logalyze/token`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tokenEnv, value }) })
    expect((await putCredential('DEEPSEEK_API_KEY', 'x')).status).toBe(400)
    const saved = await putCredential('LOGALYZE_ANALYZE_TOKEN', 'secret-token')
    expect(saved.status).toBe(200)
    expect(await saved.text()).not.toContain('secret-token')
    const secret = await putCredential('LOGALYZE_PLATFORM_CLIENT_SECRET', 'client-secret')
    expect(((await secret.json()) as { state: StateWire }).state.analyze.secret).toEqual({ tokenEnv: 'LOGALYZE_PLATFORM_CLIENT_SECRET', configured: true, source: 'file', writable: true })

    expect((await fetch(`${h.base}/open-api/logalyze`)).status).toBe(405)
    const wrong = await post(h.base, REQUEST, { authorization: 'Bearer nope' })
    expect(wrong.status).toBe(401)
    expect(wrong.headers.get('www-authenticate')).toBe('Bearer')
    expect((await post(h.base, REQUEST, { 'idempotency-key': 'has space' })).status).toBe(400)
    expect((await post(h.base, REQUEST, { 'content-type': 'text/plain' })).status).toBe(415)
    expect((await post(h.base, '{')).status).toBe(400)
    expect(await errorOf(await post(h.base, { ...REQUEST, logDetails: [] }))).toContain('logDetails 已不再支持')
    expect((await post(h.base, { ...REQUEST, instructions: 'x'.repeat(300 * 1024) })).status).toBe(413)

    const unconfigured = await post(h.base, REQUEST)
    expect(unconfigured.status).toBe(503)
    expect(await errorOf(unconfigured)).toContain('日志平台未配置')
    expect(topics.specs).toEqual([])

    const cleared = await fetch(`${h.base}/logalyze/token`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tokenEnv: 'LOGALYZE_ANALYZE_TOKEN' }) })
    expect(cleared.status).toBe(200)
    expect([...credentials.stored.keys()]).toEqual(['LOGALYZE_PLATFORM_CLIENT_SECRET'])
  })

  it('reads the logs from the platform, launches the topic, and replays the same key', async () => {
    const platform = await startPlatform()
    platform.addLog(orderLog(1))
    platform.addLog(orderLog(2))
    const topics = fakeTopics()
    const h = await readyHarness(platform, topics)

    const accepted = await post(h.base, REQUEST)
    expect(accepted.status).toBe(202)
    expect(await accepted.json()).toEqual({ ok: true, chatId: 'oc_group1', messageId: 'om_root' })
    expect(topics.specs).toHaveLength(1)
    expect(topics.specs[0]?.prompt).toContain('| L2 | device-2.tar.gz | SN2 |')
    expect(platform.calls('logs')[0]?.path).toContain(`log_id=${logUuid(1)}&log_id=${logUuid(2)}`)
    const [listed] = (await h.state()).analyze.reports
    expect(listed).toMatchObject({ app: 'order-service', appName: '订单服务', errorCode: 'E1001', followups: 0, logs: [{ ref: 'L1', logId: logUuid(1), phase: 'pending' }, { ref: 'L2', phase: 'pending' }] })

    expect((await post(h.base, REQUEST)).status).toBe(202)
    expect(topics.specs[1]).toEqual(topics.specs[0])
    expect(platform.calls('logs')).toHaveLength(1)
    const conflict = await post(h.base, { ...REQUEST, instructions: '别的说明' })
    expect(conflict.status).toBe(409)
    expect(platform.calls('logs')).toHaveLength(1)
  })

  it('refuses a batch the platform cannot back with 422 and lists the logs', async () => {
    const platform = await startPlatform()
    platform.addLog(orderLog(1))
    platform.addLog(orderLog(2, { status: 'uploading' }))
    platform.addLog(orderLog(3, { component_code: 'unknown' }))
    const topics = fakeTopics()
    const h = await readyHarness(platform, topics)

    const invalid = await post(h.base, { ...REQUEST, logIds: [logUuid(1), logUuid(2), logUuid(9)] })
    expect(invalid.status).toBe(422)
    expect((await bodyOf(invalid)).invalidLogs?.map(item => item.logId)).toEqual([logUuid(2), logUuid(9)])
    const unmatched = await post(h.base, { ...REQUEST, logIds: [logUuid(3)] }, { 'idempotency-key': 'req-2' })
    expect(unmatched.status).toBe(422)
    expect(await errorOf(unmatched)).toContain('component_code unknown 没有对应的应用')
    expect(topics.specs).toEqual([])
    expect((await h.state()).analyze.reports).toEqual([])
  })

  it('answers 503 or 502 when the platform fails, and forgets an analysis whose topic was refused', async () => {
    const platform = await startPlatform()
    platform.addLog(orderLog(1))
    platform.addLog(orderLog(2))
    const topics = fakeTopics()
    const h = await readyHarness(platform, topics)

    platform.fail('logs', 503)
    const unavailable = await post(h.base, REQUEST)
    expect(unavailable.status).toBe(503)
    expect(await errorOf(unavailable)).toContain('查询日志失败：HTTP 503')
    platform.fail('logs', 400)
    expect((await post(h.base, REQUEST)).status).toBe(502)
    platform.secret = 'rotated'
    platform.revokeTokens()
    const rejected = await post(h.base, REQUEST)
    expect(rejected.status).toBe(502)
    expect(await errorOf(rejected)).toContain('client_secret')
    platform.secret = 'client-secret'

    topics.next = { ok: false, code: 'forbidden-chat', message: '发起人没有对话权限' }
    const forbidden = await post(h.base, REQUEST)
    expect(forbidden.status).toBe(403)
    expect(await errorOf(forbidden)).toBe('发起人没有对话权限')
    expect((await h.state()).analyze.reports).toEqual([])
    topics.next = { ok: true, replayed: false, chatId: 'oc_group1', messageId: 'om_root' }
    expect((await post(h.base, { ...REQUEST, instructions: '别的说明' })).status).toBe(202)
  })

  it('sends a request without chatId to the default group, and refuses it while none is set', async () => {
    const platform = await startPlatform()
    platform.addLog(orderLog(1))
    platform.addLog(orderLog(2))
    const topics = fakeTopics()
    const h = await readyHarness(platform, topics)
    const { chatId: _chatId, ...noChat } = REQUEST
    const missing = await post(h.base, noChat)
    expect(missing.status).toBe(400)
    expect(await errorOf(missing)).toContain('默认群')

    const state = await h.state()
    const put = (analyze: Record<string, unknown>): Promise<Response> => fetch(`${h.base}/logalyze/settings`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...state.settings, analyze: { ...state.settings.analyze, ...analyze } }) })
    expect((await put({ defaultChatId: 'ou_user' })).status).toBe(400)
    expect((await put({ defaultChatId: 'oc_default', maxLogs: 1 })).status).toBe(200)
    const tooMany = await post(h.base, noChat)
    expect(await errorOf(tooMany)).toContain('logIds 最多 1 个')
    expect((await put({ defaultChatId: 'oc_default', maxLogs: 10 })).status).toBe(200)
    expect((await post(h.base, noChat)).status).toBe(202)
    expect(topics.specs.at(-1)?.chatId).toBe('oc_default')
  })

  it('answers 500 when the topic service throws', async () => {
    const platform = await startPlatform()
    platform.addLog(orderLog(1))
    platform.addLog(orderLog(2))
    const topics = fakeTopics()
    topics.launch = async () => { throw new Error('boom') }
    const h = await readyHarness(platform, topics)
    const failed = await post(h.base, REQUEST)
    expect(failed.status).toBe(500)
    expect(await errorOf(failed)).toContain('boom')
    expect(h.warn).toHaveBeenCalled()
    expect((await h.state()).analyze.reports).toEqual([])
  })
})
