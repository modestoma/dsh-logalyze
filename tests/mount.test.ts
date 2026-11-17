import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { defaultsOf, resolveConfig } from '../src/config.ts'
import { AppMounter, renderMountValue } from '../src/dispatch/mount.ts'
import type { Agent } from '../src/host.ts'
import { RepoRegistry } from '../src/apps/registry.ts'
import { ReposClient } from '../src/deps/repos.ts'
import { SessionMounts } from '../src/runs/mounts.ts'
import type { EditableSettings } from '../src/settings/contract.ts'
import { FakeRepos } from './fake-repos.ts'
import { commitFile, createAppRepo, tempDir } from './helpers.ts'

let server: Server
let port = 0
beforeAll(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200)
    res.end('packed-log')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as { port: number }).port
})
afterAll(async () => { await new Promise(resolve => server.close(resolve)) })

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup()))
})

async function setup(holdMs = 60_000) {
  const { dir, cleanup } = await tempDir()
  cleanups.push(cleanup)
  const origin = await createAppRepo(join(dir, 'order-service'))
  const project = join(dir, 'project')
  await createAppRepo(project)
  const repos = new FakeRepos(join(dir, 'mirrors'))
  const registry = new RepoRegistry({ repos: new ReposClient(() => repos), onChange: () => {} })
  registry.configure([{ url: origin, writable: true }])
  await registry.syncAll()
  const mounts = new SessionMounts({ registry, holdMs: () => holdMs })
  cleanups.push(() => mounts.close())
  const settings: EditableSettings = {
    ...defaultsOf(resolveConfig({})),
    maxAppsPerRequest: 2,
    download: { allowedHosts: ['127.0.0.1'], maxBytes: 1024, timeoutMs: 5000 },
  }
  const mounter = new AppMounter({
    mounts,
    settings: () => settings,
    workingDirectory: () => undefined,
    now: () => new Date(2026, 10, 17, 12, 0, 0),
  })
  const parent: Agent = { id: 'parent', session: { header: { id: 'parent', cwd: project } } }
  const exec = { signal: new AbortController().signal, agent: parent }
  return { origin, project, repos, registry, mounts, mounter, parent, exec }
}

describe('supervisor_mount_apps', () => {
  it('mounts the shared snapshot for the session, lists its SKILL, and prepares logs in a run directory', async () => {
    const { project, repos, registry, mounter, exec } = await setup()
    const log = join(project, 'sample-logs', 'order-service.log')
    const value = await mounter.execute({
      apps: ['order-service'],
      logs: [{ path: '../sample-logs/order-service.log' }, { url: `http://127.0.0.1:${port}/bucket/app.tar.gz?sig=x`, filter: 'tag=order' }],
    }, { ...exec, agent: { ...exec.agent, session: { header: { id: 'parent', cwd: join(project, 'sample-logs') } } } })
    const [app] = value.apps
    const { commit } = registry.status()[0]!
    expect(app).toMatchObject({ app: 'order-service', name: '订单服务', commit, writable: true, skill: '.agents/skills/log-analysis' })
    expect(app!.dir.startsWith(join(repos.root, '.snapshots'))).toBe(true)
    expect(app!.skills).toEqual([expect.objectContaining({ name: 'log-analysis', path: '.agents/skills/log-analysis/SKILL.md', source: '.agents/skills' })])
    expect((await stat(join(app!.dir, '.agents', 'skills', 'log-analysis', 'SKILL.md'))).isFile()).toBe(true)
    expect(repos.heldSnapshots()).toBe(1)
    expect(value.runDir).toBe(join(project, 'sample-logs', '.supervisor', 'runs', value.runId))
    expect(value.logs[0]).toEqual({ path: log })
    expect(value.logs[1]).toMatchObject({ url: `http://127.0.0.1:${port}/bucket/app.tar.gz?sig=x`, filter: 'tag=order' })
    expect(await readFile(value.logs[1]!.path, 'utf8')).toBe('packed-log')
    const text = renderMountValue(value)[0]!.text as string
    expect(text).toContain(`代码目录（只读快照）：\`${app!.dir}\``)
    expect(text).toContain('`.agents/skills/log-analysis/SKILL.md` log-analysis')
    expect(text).toContain('不要修改、新建或删除其中的文件')
  })

  it('keeps an unchanged snapshot for the same session and moves to a newer commit', async () => {
    const { origin, repos, registry, mounter, exec } = await setup()
    const first = await mounter.execute({ apps: ['order-service'] }, exec)
    const again = await mounter.execute({ apps: ['order-service'] }, exec)
    expect(again.apps[0]!.dir).toBe(first.apps[0]!.dir)
    expect(repos.heldSnapshots()).toBe(1)
    await commitFile(origin, 'README.md', 'changed\n')
    await registry.syncAll()
    const moved = await mounter.execute({ apps: ['order-service'] }, exec)
    expect(moved.apps[0]!.commit).not.toBe(first.apps[0]!.commit)
    expect(moved.apps[0]!.dir).not.toBe(first.apps[0]!.dir)
    expect(repos.heldSnapshots()).toBe(1)
  })

  it('shares one snapshot between sessions and releases each session after its hold time', async () => {
    const { repos, mounts } = await setup(1000)
    vi.useFakeTimers()
    const [a] = await mounts.mount('a', ['order-service'])
    const [b] = await mounts.mount('b', ['order-service'])
    expect(b!.dir).toBe(a!.dir)
    expect(repos.heldSnapshots()).toBe(2)
    await vi.advanceTimersByTimeAsync(1000)
    expect(repos.heldSnapshots()).toBe(0)
    expect(mounts.held('a')).toEqual([])
  })

  it('refuses unknown apps and too many apps without holding anything, and releases everything on close', async () => {
    const { repos, mounts, mounter, exec } = await setup()
    await expect(mounter.execute({ apps: ['nope'] }, exec)).rejects.toThrow('「nope」不在应用注册表中')
    await expect(mounter.execute({ apps: ['a', 'b', 'c'] }, exec)).rejects.toThrow('一次最多挂载 2 个应用')
    await expect(mounter.execute({ apps: ['order-service'], logs: [{ ref: 'L1' }] }, exec)).rejects.toThrow('日志编号 L1 只能在分析接口发起的话题中使用')
    await expect(mounter.execute({ apps: ['order-service'] }, { ...exec, agent: { id: 'c', session: { header: { id: 'parent', delegationDepth: 1 } } } })).rejects.toThrow('不能在子 Agent 中调用')
    expect(repos.heldSnapshots()).toBe(0)
    repos.snapshotError = new Error('disk full')
    await expect(mounts.mount('parent', ['order-service'])).rejects.toThrow('disk full')
    repos.snapshotError = undefined
    await mounts.mount('parent', ['order-service'])
    expect(repos.heldSnapshots()).toBe(1)
    await mounts.close()
    expect(repos.heldSnapshots()).toBe(0)
    await expect(mounts.mount('parent', ['order-service'])).rejects.toThrow('智能监管已停止')
  })
})
