import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply } from '../src/index.ts'
import type { HostContext, SkillProvider, SkillProviderControl, ToolActivationContext, ToolDefinition } from '../src/host.ts'
import type { StateWire } from '../src/settings/contract.ts'
import { FakeRepos } from './fake-repos.ts'
import { commitFile, createAppRepo, tempDir, waitFor } from './helpers.ts'

type Handler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>

interface Harness {
  ctx: HostContext
  /** The `dshRepos` service the context provides, unless the test replaced it. */
  repos: FakeRepos
  tools: { definition: ToolDefinition<unknown>; when?: (context: ToolActivationContext) => boolean | Promise<boolean>; disposed: boolean }[]
  skills: SkillProvider[]
  base: string
  rejection: { value: 401 | 403 | undefined }
  /** Listeners registered for `session/event`. */
  sessionListeners: HostListener[]
  /** Listeners registered for `feishu-topics/status`. */
  statusListeners: HostListener[]
  dispose: () => Promise<void>
}

/** Any listener passed to `ctx.on`. */
type HostListener = (...args: never[]) => void

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { await Promise.all(cleanups.splice(0).map(cleanup => cleanup())) })

/**
 * A plugin context with a web server and a local `dshRepos` stand-in; entries of
 * `services` add or replace context services (`dshRepos: undefined` removes it).
 */
async function harness(services: Record<string, unknown> = {}): Promise<Harness> {
  const { dir, cleanup } = await tempDir('logalyze-repos-')
  const repos = new FakeRepos(dir)
  services = { dshRepos: repos, ...services }
  const routes = new Map<string, Handler>()
  const tools: Harness['tools'] = []
  const skills: SkillProvider[] = []
  const disposers: (() => void)[] = []
  const rejection: Harness['rejection'] = { value: undefined }
  const sessionListeners: Harness['sessionListeners'] = []
  const statusListeners: Harness['statusListeners'] = []
  const webServer = { register: (route: { path: string; handler: Handler }) => { routes.set(route.path, route.handler); return () => { routes.delete(route.path) } } }
  const connection = { requestRejection: () => rejection.value }
  const ctx: HostContext = {
    tools: {
      register: (definition, options) => {
        const entry = { definition: definition as ToolDefinition<unknown>, when: options?.when, disposed: false }
        tools.push(entry)
        return () => { entry.disposed = true }
      },
    },
    skills: {
      registerProvider: (create) => {
        const control: SkillProviderControl = { signal: new AbortController().signal, invalidate: vi.fn() }
        skills.push(create(control))
        return () => {}
      },
    },
    subagents: { getProvider: () => ({}), resolveMaxDepth: () => 1, startActivation: () => Promise.reject(new Error('not used')) },
    get: (name: string) => ({ webServer, connection, ...services } as Record<string, unknown>)[name],
    on: (name: string, listener: HostListener) => {
      const listeners = name === 'session/event' ? sessionListeners : statusListeners
      listeners.push(listener)
      return () => { listeners.splice(listeners.indexOf(listener), 1) }
    },
    effect: (callback) => {
      const dispose = callback()
      const wrapped = (): void => { dispose?.() }
      disposers.push(wrapped)
      return wrapped
    },
    inject: (_deps, callback) => { callback(ctx) },
  }
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
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  return {
    ctx, repos, tools, skills, base, rejection, sessionListeners, statusListeners,
    dispose: async () => {
      for (const dispose of disposers.reverse()) dispose()
      await new Promise(resolve => server.close(resolve))
      await cleanup()
    },
  }
}

async function json<T>(response: Response): Promise<T> {
  return await response.json() as T
}

describe('plugin', () => {
  it('syncs each repository once at startup and again when dsh-repo reloads', async () => {
    const { dir, cleanup } = await tempDir()
    cleanups.push(cleanup)
    const origin = await createAppRepo(join(dir, 'order-service'))
    const h = await harness()
    cleanups.push(h.dispose)
    h.repos.setCatalog([{ url: origin }])
    const injected: ((child: HostContext) => void)[] = []
    let current: FakeRepos = h.repos
    const { inject, get } = h.ctx
    h.ctx = {
      ...h.ctx,
      get: name => name === 'dshRepos' ? current : get?.(name),
      inject: (deps, callback) => { if (deps.includes('dshRepos')) injected.push(callback); return inject?.(deps, callback) },
    }
    apply(h.ctx, {}, { overlayPath: join(dir, 'settings.json') })
    const ready = async (): Promise<boolean> => (await json<StateWire>(await fetch(`${h.base}/logalyze/state`))).repos[0]?.phase === 'ready'
    await waitFor(ready)
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(h.repos.acquires.map(call => call.repo)).toEqual([origin])
    // A reloaded dsh-repo is a new service instance.
    current = Object.create(h.repos) as FakeRepos
    for (const callback of injected) callback(h.ctx)
    await waitFor(async () => h.repos.acquires.length === 2 && await ready())
  })

  it('registers the entry skill, clones repositories, and offers the dispatch tool to top-level agents only', async () => {
    const { dir, cleanup } = await tempDir()
    cleanups.push(cleanup)
    const origin = await createAppRepo(join(dir, 'order-service'))
    const h = await harness()
    cleanups.push(h.dispose)
    h.repos.setCatalog([{ url: origin }])
    apply(h.ctx, {}, { overlayPath: join(dir, 'settings.json') })
    expect(h.skills.map(skill => skill.name)).toEqual(['dsh-logalyze'])
    expect(h.tools.map(tool => tool.definition.name)).toEqual(['logalyze_dispatch', 'logalyze_improve_skill', 'logalyze_show_skill', 'logalyze_init_repo', 'logalyze_submit_init'])
    const [tool, improve, show, init, submit] = h.tools
    const signal = new AbortController().signal
    const step = (depth?: number) => ({ agent: { id: 'a', session: { header: { id: 'a', ...depth === undefined ? {} : { delegationDepth: depth } } } }, signal })
    // The condition waits for the first sync, so a step prepared during startup still sees the cloned application.
    expect(await tool!.when?.(step())).toBe(true)
    expect(await tool!.when?.(step(1))).toBe(false)
    // The SKILL tools are offered to top-level agents while an application is usable.
    expect(await improve!.when?.(step())).toBe(true)
    expect(await improve!.when?.(step(1))).toBe(false)
    expect(await show!.when?.(step())).toBe(true)
    expect(await show!.when?.(step(1))).toBe(false)
    // Drafting needs a repository without an application, submitting a draft.
    expect(await init!.when?.(step())).toBe(false)
    expect(await submit!.when?.(step())).toBe(false)
    const [candidate] = await h.skills[0]!.list({})
    expect((await h.skills[0]!.get(candidate!, {}))?.content).toContain('`order-service`')
    // The improvement tool and report tracking read the Session event feed; reports also follow launch states.
    expect(h.sessionListeners).toHaveLength(1)
    expect(h.statusListeners).toHaveLength(1)
    // The log analysis feature is registered with dsh-repo while the plugin runs.
    expect(h.repos.features.get('log-analysis')).toMatchObject({ id: 'log-analysis', title: '日志分析' })
    // A repository the catalog lists as read-only is analyzed, but its SKILL cannot be improved.
    h.repos.catalog = h.repos.catalog.map(repo => ({ ...repo, access: 'read' }))
    h.repos.emitReposChange()
    await waitFor(async () => await improve!.when?.(step()) === false)
    expect(await tool!.when?.(step())).toBe(true)
  })

  it('mentions SKILL improvement in /logalyze unless it is turned off', async () => {
    const { dir, cleanup } = await tempDir()
    cleanups.push(cleanup)
    const origin = await createAppRepo(join(dir, 'order-service'))
    for (const enabled of [true, false]) {
      const h = await harness()
      cleanups.push(h.dispose)
      h.repos.setCatalog([{ url: origin }])
      apply(h.ctx, { skillUpdates: { enabled } }, { overlayPath: join(dir, `settings-${enabled}.json`) })
      const [candidate] = await h.skills[0]!.list({})
      const content = (await h.skills[0]!.get(candidate!, {}))?.content
      if (enabled) expect(content).toContain('先用 `logalyze_show_skill` 查看现有 SKILL 的相关内容')
      else expect(content).not.toContain('logalyze_improve_skill')
    }
  })

  it('offers drafting while a writable catalog repository lacks a description', async () => {
    const { dir, cleanup } = await tempDir()
    cleanups.push(cleanup)
    const local = await createAppRepo(join(dir, 'order-service'))
    await commitFile(local, '.agents/logalyze.yaml', 'not: [valid')
    const origin = 'https://git.example.com/shop/order-service.git'
    const h = await harness()
    cleanups.push(h.dispose)
    h.repos.origins.set(origin, local)
    h.repos.setCatalog([{ url: origin }])
    apply(h.ctx, {}, { overlayPath: join(dir, 'settings.json') })
    const [, , , init] = h.tools
    const step = { agent: { id: 'a', session: { header: { id: 'a' } } }, signal: new AbortController().signal, callId: 'call-1' }
    expect(await init!.when?.(step)).toBe(true)
    const state = await json<StateWire>(await fetch(`${h.base}/logalyze/state`))
    expect(state.repos).toMatchObject([{ url: origin, available: false, writable: true }])
    expect(state.settings).not.toHaveProperty('repos')

    // A read-only entry is analyzed only, so nothing is drafted for it.
    h.repos.catalog = h.repos.catalog.map(repo => ({ ...repo, access: 'read' }))
    h.repos.emitReposChange()
    await waitFor(async () => await init!.when?.(step) === false)
  })

  it('follows the dsh-repo catalog: repositories with the log analysis feature are the application repositories', async () => {
    const { dir, cleanup } = await tempDir()
    cleanups.push(cleanup)
    const origin = await createAppRepo(join(dir, 'order-service'))
    const other = await createAppRepo(join(dir, 'other'))
    const h = await harness()
    cleanups.push(h.dispose)
    h.repos.setCatalog([{ url: other }], [])
    apply(h.ctx, {}, { overlayPath: join(dir, 'settings.json') })
    const state = async (): Promise<StateWire> => await json<StateWire>(await fetch(`${h.base}/logalyze/state`))
    const step = { agent: { id: 'a', session: { header: { id: 'a' } } }, signal: new AbortController().signal }
    expect(await h.tools[0]!.when?.(step)).toBe(false)
    expect((await state()).repos).toEqual([])

    // The analysis reads the feature's branch, else the baseline branch.
    h.repos.catalog = [{ id: '000000000001', url: origin, base: 'dev', access: 'read', features: [{ id: 'log-analysis', branch: 'main' }] }, ...h.repos.catalog]
    h.repos.emitReposChange()
    await waitFor(async () => await h.tools[0]!.when?.(step) === true)
    expect((await state()).repos).toMatchObject([{ url: origin, branch: 'main', phase: 'ready' }])
    h.repos.catalog = [{ id: '000000000001', url: origin, base: 'main', access: 'read', features: [{ id: 'log-analysis' }] }, ...h.repos.catalog.slice(1)]
    h.repos.emitReposChange()
    await waitFor(async () => (await state()).repos[0]?.branch === 'main' && (await state()).repos[0]?.phase === 'ready')

    h.repos.setCatalog([{ url: origin }, { url: other }], [])
    expect((await state()).repos).toEqual([])
    expect(await h.tools[0]!.when?.(step)).toBe(false)
  })

  it('refreshes repositories before rendering /logalyze, waiting at most refreshWaitMs', async () => {
    const { dir, cleanup } = await tempDir()
    cleanups.push(cleanup)
    const origin = await createAppRepo(join(dir, 'order-service'))
    const manifestPath = join(origin, '.agents', 'logalyze.yaml')
    const addHint = async (hint: string): Promise<void> => {
      await commitFile(origin, '.agents/logalyze.yaml', (await readFile(manifestPath, 'utf8')).replace('logHints: [', `logHints: [${hint}, `))
    }
    const h = await harness()
    cleanups.push(h.dispose)
    h.repos.setCatalog([{ url: origin }])
    apply(h.ctx, { refreshWaitMs: 2000 }, { overlayPath: join(dir, 'settings.json') })
    const provider = h.skills[0]!
    const [candidate] = await provider.list({})
    expect((await provider.get(candidate!, {}))?.content).not.toContain('PushedHint')
    // A sync still running from startup would be joined instead of fetching the new commit.
    await waitFor(async () => (await json<StateWire>(await fetch(`${h.base}/logalyze/state`))).repos[0]?.phase === 'ready')

    await addHint('PushedHint')
    expect((await provider.get(candidate!, {}))?.content).toContain('`PushedHint`')

    h.repos.stalled = true
    await addHint('LateHint')
    const started = Date.now()
    const content = (await provider.get(candidate!, {}))?.content
    expect(Date.now() - started).toBeLessThan(5000)
    expect(content).toContain('`PushedHint`')
    expect(content).not.toContain('LateHint')
    await expect(provider.get(candidate!, { signal: AbortSignal.abort(new Error('stop')) })).rejects.toThrow('stop')
  })

  it('offers the entry skill to the model outside the repositories unless autoInvoke is off', async () => {
    const { dir, cleanup } = await tempDir()
    cleanups.push(cleanup)
    const origin = await createAppRepo(join(dir, 'order-service'))
    for (const autoInvoke of [true, false]) {
      const h = await harness()
      cleanups.push(h.dispose)
      h.repos.setCatalog([{ url: origin }])
      apply(h.ctx, { autoInvoke }, { overlayPath: join(dir, `settings-${autoInvoke}.json`) })
      const provider = h.skills[0]!
      const [candidate] = await provider.list({ cwd: dir })
      await provider.get(candidate!, {})
      const [listed] = await provider.list({ cwd: dir })
      expect(listed?.invocation.modelInvocable).toBe(autoInvoke)
      if (autoInvoke) expect(listed?.description).toContain('订单服务（order-service')
      // Inside the repositories and the run directories' workspaces only the bundled guides are listed.
      for (const cwd of [join(h.repos.root, '.snapshots', 'local', 'x'), join(dir, '.logalyze', 'runs', 'r1', 'init', 'repo')]) {
        expect((await provider.list({ cwd })).map(skill => skill.name)).toEqual(['logalyze-kit', 'logalyze-improve'])
      }
    }
  })

  it('serves the panel state and persists only overridden settings', async () => {
    const { dir, cleanup } = await tempDir()
    cleanups.push(cleanup)
    const origin = await createAppRepo(join(dir, 'order-service'))
    const overlayPath = join(dir, 'settings.json')
    const h = await harness()
    cleanups.push(h.dispose)
    apply(h.ctx, {}, { overlayPath })
    const initial = await json<StateWire>(await fetch(`${h.base}/logalyze/state`))
    expect(initial).toMatchObject({ repos: [], overridden: [] })

    const saved = await fetch(`${h.base}/logalyze/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...initial.settings, download: { ...initial.settings.download, allowedHosts: ['OSS.example.com'] } }),
    })
    expect(saved.status).toBe(200)
    const state = (await json<{ ok: true; state: StateWire }>(saved)).state
    expect(state.overridden).toEqual(['download'])
    expect(JSON.parse(await readFile(overlayPath, 'utf8'))).toEqual({ download: { ...initial.settings.download, allowedHosts: ['oss.example.com'] } })
    const withRepos = await fetch(`${h.base}/logalyze/settings`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...initial.settings, repos: [{ url: origin }] }) })
    expect(withRepos.status).toBe(400)

    const invalid = await fetch(`${h.base}/logalyze/settings`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...initial.settings, maxAppsPerRequest: 0 }) })
    expect(invalid.status).toBe(400)
    expect((await json<{ error: string }>(invalid)).error).toMatch(/^maxAppsPerRequest: /)

    const crossSite = await fetch(`${h.base}/logalyze/settings`, { method: 'PUT', headers: { origin: 'https://evil.example' } })
    expect(crossSite.status).toBe(403)
    expect((await fetch(`${h.base}/logalyze/sync`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(404)
    expect((await fetch(`${h.base}/logalyze/state`, { method: 'POST' })).status).toBe(405)

    const reset = await fetch(`${h.base}/logalyze/settings`, { method: 'DELETE' })
    expect((await json<{ state: StateWire }>(reset)).state).toMatchObject({ repos: [], overridden: [] })
  })

  it('reports a panel settings file that still holds repos and where repositories are configured now', async () => {
    const { dir, cleanup } = await tempDir()
    cleanups.push(cleanup)
    const overlayPath = join(dir, 'settings.json')
    await writeFile(overlayPath, JSON.stringify({ repos: [{ url: '/srv/a' }], maxAppsPerRequest: 2 }))
    const h = await harness()
    cleanups.push(h.dispose)
    apply(h.ctx, {}, { overlayPath })
    await waitFor(async () => (await json<StateWire>(await fetch(`${h.base}/logalyze/state`))).overlayError !== undefined)
    const state = await json<StateWire>(await fetch(`${h.base}/logalyze/state`))
    expect(state.overlayError).toMatch(/repos: 应用仓库已改在 dsh-repo 中配置/)
    expect(state.settings.maxAppsPerRequest).toBe(4)
  })

  it('pulls every repository again after a dshRepos host or token change', async () => {
    const { dir, cleanup } = await tempDir()
    cleanups.push(cleanup)
    const origin = await createAppRepo(join(dir, 'order-service'))
    const h = await harness()
    cleanups.push(h.dispose)
    h.repos.setCatalog([{ url: origin }])
    apply(h.ctx, {}, { overlayPath: join(dir, 'settings.json') })
    const state = async (): Promise<StateWire> => await json<StateWire>(await fetch(`${h.base}/logalyze/state`))

    await waitFor(async () => (await state()).repos[0]?.available === true)
    expect((await state()).dshRepo).toEqual({ availability: 'ready', mirrorDir: h.repos.root })
    h.repos.mirrorUnset = true
    expect((await state()).dshRepo).toEqual({ availability: 'ready' })
    h.repos.mirrorUnset = false
    expect((await fetch(`${h.base}/logalyze/hosts`, { method: 'POST' })).status).not.toBe(200)
    expect((await fetch(`${h.base}/logalyze/token`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tokenEnv: 'GITLAB_TOKEN', value: 'x' }) })).status).toBe(400)

    const head = await commitFile(origin, 'NOTES.md', 'v2\n')
    h.repos.emitHostsChange()
    await waitFor(async () => (await state()).repos[0]?.commit === head)
  })

  it('reports a missing dshRepos service and has no application repositories without it', async () => {
    const { dir, cleanup } = await tempDir()
    cleanups.push(cleanup)
    const h = await harness({ dshRepos: undefined })
    cleanups.push(h.dispose)
    apply(h.ctx, {}, { overlayPath: join(dir, 'settings.json') })
    const current = await json<StateWire>(await fetch(`${h.base}/logalyze/state`))
    expect(current.dshRepo).toEqual({ availability: 'missing' })
    expect(current.repos).toEqual([])
  })

  it('answers the host gate rejection before touching the request', async () => {
    const { dir, cleanup } = await tempDir()
    cleanups.push(cleanup)
    const h = await harness()
    cleanups.push(h.dispose)
    apply(h.ctx, {}, { overlayPath: join(dir, 'settings.json') })
    h.rejection.value = 401
    const response = await fetch(`${h.base}/logalyze/state`)
    expect(response.status).toBe(401)
  })

  it('reports an invalid overlay file instead of applying it', async () => {
    const { dir, cleanup } = await tempDir()
    cleanups.push(cleanup)
    const overlayPath = join(dir, 'settings.json')
    await import('node:fs/promises').then(fs => fs.writeFile(overlayPath, '{"maxAppsPerRequest": "many"}'))
    const h = await harness()
    cleanups.push(h.dispose)
    apply(h.ctx, {}, { overlayPath })
    await waitFor(() => false, 50).catch(() => undefined)
    const state = await json<StateWire>(await fetch(`${h.base}/logalyze/state`))
    expect(state.overlayError).toContain('内容不合法')
    expect(state.settings.maxAppsPerRequest).toBe(4)
  })
})
