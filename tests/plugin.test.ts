import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
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
  dispose: () => Promise<void>
}

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
    ctx, repos, tools, skills, base, rejection,
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
  it('registers the entry skill, clones repositories, and offers the dispatch tool to top-level agents only', async () => {
    const { dir, cleanup } = await tempDir()
    cleanups.push(cleanup)
    const origin = await createAppRepo(join(dir, 'order-service'))
    const h = await harness()
    cleanups.push(h.dispose)
    apply(h.ctx, { repos: [{ url: origin }] }, { overlayPath: join(dir, 'settings.json') })
    expect(h.skills.map(skill => skill.name)).toEqual(['dsh-logalyze'])
    expect(h.tools.map(tool => tool.definition.name)).toEqual(['logalyze_dispatch', 'logalyze_improve_skill', 'logalyze_add_repo', 'logalyze_init_repo', 'logalyze_submit_init'])
    const [tool, improve, add, init, submit] = h.tools
    const signal = new AbortController().signal
    const step = (depth?: number) => ({ agent: { id: 'a', session: { header: { id: 'a', ...depth === undefined ? {} : { delegationDepth: depth } } } }, signal })
    // The condition waits for the first sync, so a step prepared during startup still sees the cloned application.
    expect(await tool!.when?.(step())).toBe(true)
    expect(await tool!.when?.(step(1))).toBe(false)
    // SKILL improvement is offered only after a dispatch in the session recorded a SKILL gap.
    expect(await improve!.when?.(step())).toBe(false)
    // Adding is always offered at the top level; drafting needs a repository without an application, submitting a draft.
    expect(await add!.when?.(step())).toBe(true)
    expect(await add!.when?.(step(1))).toBe(false)
    expect(await init!.when?.(step())).toBe(false)
    expect(await submit!.when?.(step())).toBe(false)
    const [candidate] = await h.skills[0]!.list({})
    expect((await h.skills[0]!.get(candidate!, {}))?.content).toContain('`order-service`')
  })

  it('mentions SKILL improvement in /logalyze unless it is turned off', async () => {
    const { dir, cleanup } = await tempDir()
    cleanups.push(cleanup)
    const origin = await createAppRepo(join(dir, 'order-service'))
    for (const enabled of [true, false]) {
      const h = await harness()
      cleanups.push(h.dispose)
      apply(h.ctx, { repos: [{ url: origin }], skillUpdates: { enabled } }, { overlayPath: join(dir, `settings-${enabled}.json`) })
      const [candidate] = await h.skills[0]!.list({})
      const content = (await h.skills[0]!.get(candidate!, {}))?.content
      if (enabled) expect(content).toContain('调用一次 `logalyze_improve_skill`')
      else expect(content).not.toContain('logalyze_improve_skill')
    }
  })

  it('adds a repository from a conversation into the panel settings and offers drafting while it lacks a description', async () => {
    const { dir, cleanup } = await tempDir()
    cleanups.push(cleanup)
    const origin = await createAppRepo(join(dir, 'order-service'))
    await commitFile(origin, '.agents/logalyze.yaml', 'not: [valid')
    const approval = { request: vi.fn(async () => 'allowed-once' as const) }
    const h = await harness({ approval })
    cleanups.push(h.dispose)
    const overlayPath = join(dir, 'settings.json')
    apply(h.ctx, {}, { overlayPath })
    const [, , add, init] = h.tools
    const step = { agent: { id: 'a', session: { header: { id: 'a' } } }, signal: new AbortController().signal }
    expect(await init!.when?.(step)).toBe(false)
    const value = await add!.definition.execute({ url: origin }, step)
    expect(value).toMatchObject({ status: 'added', setup: 'needs-setup' })
    expect(JSON.parse(await readFile(overlayPath, 'utf8'))).toEqual({ repos: [{ url: origin }] })
    const state = await json<StateWire>(await fetch(`${h.base}/logalyze/state`))
    expect(state.repos).toMatchObject([{ url: origin, available: false }])
    expect(await init!.when?.(step)).toBe(true)

    // Additions from two conversations at once both persist.
    const [first, second] = await Promise.all([join(dir, 'a'), join(dir, 'b')].map(path => createAppRepo(path)))
    await Promise.all([first, second].map(url => add!.definition.execute({ url }, step)))
    expect(JSON.parse(await readFile(overlayPath, 'utf8'))).toEqual({ repos: [{ url: origin }, { url: first }, { url: second }] })
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
    apply(h.ctx, { repos: [{ url: origin }], refreshWaitMs: 2000 }, { overlayPath: join(dir, 'settings.json') })
    const provider = h.skills[0]!
    const [candidate] = await provider.list({})
    expect((await provider.get(candidate!, {}))?.content).not.toContain('PushedHint')

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
      apply(h.ctx, { repos: [{ url: origin }], autoInvoke }, { overlayPath: join(dir, `settings-${autoInvoke}.json`) })
      const provider = h.skills[0]!
      const [candidate] = await provider.list({ cwd: dir })
      await provider.get(candidate!, {})
      const [listed] = await provider.list({ cwd: dir })
      expect(listed?.invocation.modelInvocable).toBe(autoInvoke)
      if (autoInvoke) expect(listed?.description).toContain('订单服务（order-service')
      // Inside the repositories only the bundled guides are listed.
      expect((await provider.list({ cwd: join(h.repos.mirrorSettings().dir, '.snapshots', 'local', 'x') })).map(skill => skill.name)).toEqual(['logalyze-kit', 'logalyze-improve'])
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
      body: JSON.stringify({ ...initial.settings, repos: [{ url: origin }], download: { ...initial.settings.download, allowedHosts: ['OSS.example.com'] } }),
    })
    expect(saved.status).toBe(200)
    const state = (await json<{ ok: true; state: StateWire }>(saved)).state
    expect(state.overridden).toEqual(['repos', 'download'])
    expect(JSON.parse(await readFile(overlayPath, 'utf8'))).toEqual({ repos: [{ url: origin }], download: { ...initial.settings.download, allowedHosts: ['oss.example.com'] } })
    const step = { agent: { id: 'a', session: { header: { id: 'a' } } }, signal: new AbortController().signal }
    expect(await h.tools[0]!.when?.(step)).toBe(false)
    await waitFor(async () => await h.tools[0]!.when?.(step) === true)

    const invalid = await fetch(`${h.base}/logalyze/settings`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...initial.settings, maxAppsPerRequest: 0 }) })
    expect(invalid.status).toBe(400)
    expect((await json<{ error: string }>(invalid)).error).toMatch(/^maxAppsPerRequest: /)

    const crossSite = await fetch(`${h.base}/logalyze/sync`, { method: 'POST', headers: { origin: 'https://evil.example' } })
    expect(crossSite.status).toBe(403)
    const unknown = await fetch(`${h.base}/logalyze/sync`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: '/nope' }) })
    expect(unknown.status).toBe(400)
    expect((await fetch(`${h.base}/logalyze/state`, { method: 'POST' })).status).toBe(405)

    const reset = await fetch(`${h.base}/logalyze/settings`, { method: 'DELETE' })
    expect((await json<{ state: StateWire }>(reset)).state).toMatchObject({ repos: [], overridden: [] })
    expect(await h.tools[0]!.when?.(step)).toBe(false)
  })

  it('pulls every repository again after a dshRepos host or token change', async () => {
    const { dir, cleanup } = await tempDir()
    cleanups.push(cleanup)
    const origin = await createAppRepo(join(dir, 'order-service'))
    const h = await harness()
    cleanups.push(h.dispose)
    apply(h.ctx, { repos: [{ url: origin }] }, { overlayPath: join(dir, 'settings.json') })
    const state = async (): Promise<StateWire> => await json<StateWire>(await fetch(`${h.base}/logalyze/state`))

    await waitFor(async () => (await state()).repos[0]?.available === true)
    expect((await state()).dshRepo).toEqual({ availability: 'ready', mirrorDir: h.repos.mirrorSettings().dir })
    expect((await fetch(`${h.base}/logalyze/hosts`, { method: 'POST' })).status).not.toBe(200)
    expect((await fetch(`${h.base}/logalyze/token`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tokenEnv: 'GITLAB_TOKEN', value: 'x' }) })).status).toBe(400)

    const head = await commitFile(origin, 'NOTES.md', 'v2\n')
    h.repos.emitHostsChange()
    await waitFor(async () => (await state()).repos[0]?.commit === head)
  })

  it('reports a missing dshRepos service instead of pulling', async () => {
    const { dir, cleanup } = await tempDir()
    cleanups.push(cleanup)
    const h = await harness({ dshRepos: undefined })
    cleanups.push(h.dispose)
    apply(h.ctx, { repos: [{ url: 'https://gitlab.invalid/team/app.git' }] }, { overlayPath: join(dir, 'settings.json') })
    const state = async (): Promise<StateWire> => await json<StateWire>(await fetch(`${h.base}/logalyze/state`))
    await waitFor(async () => (await state()).repos[0]?.phase === 'failed')
    const current = await state()
    expect(current.dshRepo).toEqual({ availability: 'missing' })
    expect(current.repos[0]?.error).toContain('请安装 dsh-repo')
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
