import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FeishuTopicService, TopicCardLinks, TopicLaunchResult, TopicLaunchSpec, TopicLaunchState } from '../src/deps/topics-contract.ts'
import { resolveConfig } from '../src/config.ts'
import { lookupTopics } from '../src/deps/topics.ts'
import { apply } from '../src/index.ts'
import type { HostContext, HostCredentials } from '../src/host.ts'
import { analysisCardLinks } from '../src/report/links.ts'
import type { StateWire } from '../src/settings/contract.ts'
import { analysisRecord } from './fake-platform.ts'
import { FakeRepos } from './fake-repos.ts'
import { createAppRepo, tempDir } from './helpers.ts'

type Handler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { await Promise.all(cleanups.splice(0).map(cleanup => cleanup())) })

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
    subagents: { getProvider: () => ({}), startActivation: () => Promise.reject(new Error('not used')) },
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
  const state = async (): Promise<StateWire> => await (await fetch(`${base}/supervisor/state`)).json() as StateWire
  return { base, routes, warn, state }
}

describe('retired analyze API', () => {
  it('never registers /open-api/supervisor, even with feishuTopics and the former analyze settings', async () => {
    const credentials = fakeCredentials()
    const h = await harness({ credentials, feishuTopics: fakeTopics() }, {
      analyzeTokenRef: 'OLD_ANALYZE_TOKEN',
      analyze: { enabled: true, defaultChatId: 'oc_group1', maxLogs: 5 },
    })
    expect(h.routes.has('/open-api/supervisor')).toBe(false)
    const response = await fetch(`${h.base}/open-api/supervisor`, { method: 'POST' })
    expect(response.status).toBe(404)
    const state = await h.state()
    expect(state.settings.analyze).not.toHaveProperty('enabled')
    expect(state.analyze).toEqual({
      secretEnv: 'SUPERVISOR_PLATFORM_CLIENT_SECRET',
      secret: { tokenEnv: 'SUPERVISOR_PLATFORM_CLIENT_SECRET', configured: false, writable: true },
      platformProblem: expect.stringContaining('缺少接口地址、令牌地址、client_id'),
      topics: 'ready',
      actions: 'missing',
      reports: [],
      legacyReports: [],
    })
    expect(state.runtime).not.toHaveProperty('analyzeTokenRef')
    expect(h.warn).toHaveBeenCalledWith(expect.stringContaining('不再生效'), 'analyzeTokenRef、analyze.enabled、analyze.defaultChatId、analyze.maxLogs')
  })

  it('drops the former analyze keys from configuration and panel overlays', () => {
    const config = resolveConfig({ analyzeTokenRef: 'X', analyze: { enabled: true, defaultChatId: 'oc_a', maxLogs: 3, platform: { clientId: 'c' } } })
    expect(config.analyze).toEqual({ platform: expect.objectContaining({ clientId: 'c', clientAuth: 'basic' }), upload: expect.any(Object) })
  })

  it('stores only the platform client secret from the panel', async () => {
    const credentials = fakeCredentials()
    const h = await harness({ credentials })
    const putCredential = (tokenEnv: string, value: string): Promise<Response> => fetch(`${h.base}/supervisor/token`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tokenEnv, value }) })
    expect((await putCredential('SUPERVISOR_ANALYZE_TOKEN', 'x')).status).toBe(400)
    const saved = await putCredential('SUPERVISOR_PLATFORM_CLIENT_SECRET', 'client-secret')
    expect(saved.status).toBe(200)
    expect(await saved.text()).not.toContain('client-secret')
    expect(credentials.stored.get('SUPERVISOR_PLATFORM_CLIENT_SECRET')).toBe('client-secret')
    const cleared = await fetch(`${h.base}/supervisor/token`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tokenEnv: 'SUPERVISOR_PLATFORM_CLIENT_SECRET' }) })
    expect(((await cleared.json()) as { state: StateWire }).state.analyze.secret?.configured).toBe(false)
  })
})

describe('analysis topic links', () => {
  it('lists one row per log and adds the analysis page once a revision completed', () => {
    const analysis = analysisRecord('req-1')
    expect(analysisCardLinks(analysis)).toEqual({
      nameHeader: '日志',
      linkHeader: '详情页',
      extraLinkHeader: '分析报告',
      rows: [
        { name: 'L1 · device-1.tar.gz · SN1', url: 'https://logs.example.com/logs/1' },
        { name: 'L2 · device-2.tar.gz · SN2', url: 'https://logs.example.com/logs/2' },
      ],
    })
    const linked = { ...analysis, logs: analysis.logs.map(log => (log.ref === 'L2' ? { ...log, reportUrl: 'https://logs.example.com/logs/2/analysis' } : log)) }
    expect(analysisCardLinks(linked).rows[1]).toEqual({ name: 'L2 · device-2.tar.gz · SN2', url: 'https://logs.example.com/logs/2', extraUrl: 'https://logs.example.com/logs/2/analysis' })
  })

  it('accepts only a provider of contract version 3 that reports launches and updates links', () => {
    expect(lookupTopics(undefined).availability).toBe('missing')
    expect(lookupTopics({ version: 2, launch: () => undefined }).availability).toBe('incompatible')
    const { updateLinks: _updateLinks, ...older } = fakeTopics()
    expect(lookupTopics(older).availability).toBe('incompatible')
    expect(lookupTopics(fakeTopics()).availability).toBe('ready')
  })
})
