import { mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CatalogFollower } from '../src/apps/catalog.ts'
import { RepoRegistry } from '../src/apps/registry.ts'
import { MANIFEST_PATH } from '../src/apps/manifest.ts'
import { FakeRepos, repoError } from './fake-repos.ts'
import { commitFile, createAppRepo, git, tempDir } from './helpers.ts'
import { ReposClient } from '../src/deps/repos.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { await Promise.all(cleanups.splice(0).map(cleanup => cleanup())) })

async function setup(): Promise<{ root: string; registry: RepoRegistry; fake: FakeRepos; repos: { value: unknown }; changes: () => number; now: { value: number } }> {
  const { dir, cleanup } = await tempDir()
  cleanups.push(cleanup)
  let changes = 0
  const now = { value: 1_000_000 }
  const fake = new FakeRepos(join(dir, 'mirrors'))
  const repos: { value: unknown } = { value: fake }
  const registry = new RepoRegistry({ repos: new ReposClient(() => repos.value), onChange: () => { changes += 1 }, now: () => now.value })
  return { root: dir, registry, fake, repos, changes: () => changes, now }
}

describe('repository registry', () => {
  it('clones a repository and exposes its application', async () => {
    const { root, registry } = await setup()
    const origin = await createAppRepo(join(root, 'origin'))
    registry.configure([{ url: origin, writable: true }])
    expect(registry.status()[0]?.phase).toBe('pending')
    await registry.syncAll()
    const [status] = registry.status()
    expect(status).toMatchObject({ url: origin, phase: 'ready', available: true, activeRuns: 0 })
    expect(status?.commit).toBe(git(origin, 'rev-parse', 'HEAD').trim())
    expect(registry.readyApps().map(app => app.app.id)).toEqual(['order-service'])
  })

  it('records catalog access without syncing again and keeps repositories without manifests usable', async () => {
    const { root, registry } = await setup()
    const origin = await createAppRepo(join(root, 'origin'))
    const bare = await createAppRepo(join(root, 'bare'))
    git(bare, 'rm', '-q', '.agents/logalyze.yaml')
    git(bare, 'commit', '-qm', 'drop manifest')
    registry.configure([{ url: origin, writable: false }, { url: bare, writable: false }])
    await registry.syncAll()
    expect(registry.status()).toMatchObject([{ url: origin, available: true, writable: false }, { url: bare, available: true, writable: false }])
    expect(registry.readyApp('order-service').writable).toBe(false)
    expect(registry.configure([{ url: origin, writable: true }, { url: bare, writable: true }])).toEqual([])
    expect(registry.readyApp('order-service').writable).toBe(true)
    expect(registry.readyApps()).toHaveLength(2)
  })

  it('updates to the remote head and follows a configured branch', async () => {
    const { root, registry, now } = await setup()
    const origin = await createAppRepo(join(root, 'origin'))
    registry.configure([{ url: origin, writable: true }])
    await registry.syncAll()
    const head = await commitFile(origin, 'NOTES.md', 'v2\n')
    now.value += 1
    await registry.syncAll()
    expect(registry.status()[0]?.commit).toBe(head)

    git(origin, 'checkout', '-qb', 'release')
    const release = await commitFile(origin, 'NOTES.md', 'release\n')
    git(origin, 'checkout', '-q', 'main')
    const changed = registry.configure([{ url: origin, branch: 'release', writable: true }])
    expect(changed).toEqual([origin])
    await registry.syncUrls(changed)
    expect(registry.status()[0]).toMatchObject({ phase: 'ready', branch: 'release', commit: release })
  })

  it('keeps the existing checkout usable when an update fails', async () => {
    const { root, registry } = await setup()
    const origin = await createAppRepo(join(root, 'origin'))
    registry.configure([{ url: origin, writable: true }])
    await registry.syncAll()
    await rm(origin, { recursive: true })
    await registry.syncAll()
    const [status] = registry.status()
    expect(status).toMatchObject({ phase: 'ready', available: true })
    expect(status?.error).toMatch(/^更新失败，继续使用已有提交 [0-9a-f]{8}：/)
  })

  it('reports the provider refusal while no mirror directory is chosen, and syncs once one is', async () => {
    const { root, registry, fake } = await setup()
    const origin = await createAppRepo(join(root, 'origin'))
    fake.mirrorUnset = true
    registry.configure([{ url: origin, writable: true }])
    await registry.syncAll()
    expect(registry.status()[0]).toMatchObject({ phase: 'failed', available: false, error: expect.stringContaining('镜像目录未设置') })
    await expect(registry.acquire(['order-service'])).rejects.toThrow()
    fake.mirrorUnset = false
    await registry.syncAll()
    expect(registry.status()[0]).toMatchObject({ phase: 'ready', available: true })
  })

  it('readies a repository without a manifest or skill', async () => {
    const { root, registry } = await setup()
    const origin = join(root, 'bare-app')
    await mkdir(origin)
    await writeFile(join(origin, 'README.md'), 'x')
    git(origin, 'init', '-q', '-b', 'main')
    git(origin, 'add', '-A')
    git(origin, '-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-qm', 'init')
    registry.configure([{ url: origin, writable: true }])
    await registry.syncAll()
    expect(registry.status()[0]).toMatchObject({ phase: 'ready', available: true })
    expect(registry.readyApps()[0]?.app).toMatchObject({ name: 'bare-app', description: '', aliases: [] })
    expect(registry.readyApps()[0]?.app.skill).toBeUndefined()
  })

  it('reports clone failures', async () => {
    const { root, registry } = await setup()
    registry.configure([{ url: join(root, 'missing'), writable: true }])
    await registry.syncAll()
    expect(registry.status()[0]).toMatchObject({ phase: 'failed', available: false })
    expect(registry.status()[0]?.error).toContain('同步镜像')
  })

  it('reports a missing dshRepos service and syncs once it appears', async () => {
    const { root, registry, repos } = await setup()
    const origin = await createAppRepo(join(root, 'origin'))
    const service = repos.value
    repos.value = undefined
    registry.configure([{ url: origin, writable: true }])
    await registry.syncAll()
    expect(registry.status()[0]).toMatchObject({ phase: 'failed', available: false })
    expect(registry.status()[0]?.error).toContain('请安装 dsh-repo')
    await expect(registry.acquire(['order-service'])).rejects.toThrow('不在应用注册表中')
    repos.value = { version: 1 }
    await registry.resyncAll()
    expect(registry.status()[0]?.error).toContain('与智能监管不兼容')
    repos.value = service
    await registry.resyncAll()
    expect(registry.status()[0]).toMatchObject({ phase: 'ready', available: true })
  })

  it('makes every repository declaring the same application id unavailable', async () => {
    const { root, registry } = await setup()
    const first = await createAppRepo(join(root, 'one'))
    const second = await createAppRepo(join(root, 'two'))
    registry.configure([{ url: first, writable: true }, { url: second, writable: true }])
    await registry.syncAll()
    expect(registry.readyApps()).toEqual([])
    expect(registry.status().map(repo => repo.available)).toEqual([false, false])
    expect(registry.status()[0]?.error).toContain('同时出现在')
  })

  it('updates the catalog while a lease holds an unchanged snapshot, and releases each snapshot once', async () => {
    const { root, registry, fake } = await setup()
    const origin = await createAppRepo(join(root, 'origin'))
    registry.configure([{ url: origin, writable: true }])
    await registry.syncAll()
    const first = registry.status()[0]?.commit as string

    const lease = await registry.acquire(['order-service'])
    const held = lease.apps.get('order-service')
    expect(held).toMatchObject({ commit: first, url: origin })
    // The snapshot holds the plain files of the commit, without git metadata.
    expect(await readFile(join(held!.dir, MANIFEST_PATH), 'utf8')).toBe(git(origin, 'show', `${first}:${MANIFEST_PATH}`))
    await expect(readFile(join(held!.dir, '.git'))).rejects.toThrow()
    expect(registry.status()[0]?.activeRuns).toBe(1)

    const manifest = (await readFile(join(origin, MANIFEST_PATH), 'utf8')).replace('logHints: [', 'logHints: [NewHint, ')
    const head = await commitFile(origin, MANIFEST_PATH, manifest)
    await registry.syncAll()
    expect(registry.status()[0]).toMatchObject({ commit: head, activeRuns: 1 })
    expect(registry.readyApps()[0]?.app.logHints).not.toContain('NewHint')
    expect(await readFile(join(held!.dir, MANIFEST_PATH), 'utf8')).not.toContain('NewHint')

    const next = await registry.acquire(['order-service'])
    expect(next.apps.get('order-service')?.commit).toBe(head)
    expect(next.apps.get('order-service')?.dir).not.toBe(held?.dir)
    expect(fake.heldSnapshots()).toBe(2)
    lease.release()
    lease.release()
    expect(fake.heldSnapshots()).toBe(1)
    expect(registry.status()[0]?.activeRuns).toBe(1)
    next.release()
    expect(fake.heldSnapshots()).toBe(0)
    expect(registry.status()[0]?.activeRuns).toBe(0)
  })

  it('refreshes only repositories whose last sync is old enough', async () => {
    const { root, registry, now } = await setup()
    const origin = await createAppRepo(join(root, 'origin'))
    registry.configure([{ url: origin, writable: true }])
    await registry.refresh(60_000)
    const first = registry.status()[0]?.commit
    expect(first).toBeDefined()
    const head = await commitFile(origin, 'NOTES.md', 'v2\n')
    now.value += 30_000
    await registry.refresh(60_000)
    expect(registry.status()[0]?.commit).toBe(first)
    await registry.refresh(0)
    expect(registry.status()[0]?.commit).toBe(head)
  })

  it('reports a skipped legacy symlink import while keeping code analysis usable', async () => {
    const { root, registry } = await setup()
    const origin = await createAppRepo(join(root, 'origin'))
    await rename(join(origin, MANIFEST_PATH), join(origin, '.agents', 'real.yaml'))
    await symlink('real.yaml', join(origin, MANIFEST_PATH))
    git(origin, 'add', '-A')
    git(origin, 'commit', '-qm', 'link')
    registry.configure([{ url: origin, writable: true }])
    await registry.syncAll()
    expect(registry.status()[0]).toMatchObject({ phase: 'ready', available: true, error: expect.stringContaining(`旧应用配置未迁移：${MANIFEST_PATH} 不是普通文件`) })
  })

  it('releases every application when a snapshot cannot be created', async () => {
    const { root, registry, fake } = await setup()
    const origin = await createAppRepo(join(root, 'origin'))
    const second = await createAppRepo(join(root, 'pay'), { '.agents/logalyze.yaml': 'id: pay-service\nname: 支付服务\ndescription: 支付\nskill: log-analysis\n' })
    registry.configure([{ url: origin, writable: true }, { url: second, writable: true }])
    await registry.syncAll()
    fake.snapshotError = repoError('unavailable', '检出失败')
    await expect(registry.acquire(['order-service', 'pay-service'])).rejects.toThrow('应用「order-service」的代码快照创建失败：检出失败')
    expect(registry.status().map(repo => repo.activeRuns)).toEqual([0, 0])
    fake.snapshotError = undefined
    const lease = await registry.acquire(['order-service'])
    expect(lease.apps.get('order-service')?.commit).toBe(registry.status()[0]?.commit)
    lease.release()
    expect(fake.heldSnapshots()).toBe(0)
  })

  it('rejects unknown application ids with the available ones', async () => {
    const { root, registry } = await setup()
    const origin = await createAppRepo(join(root, 'origin'))
    registry.configure([{ url: origin, writable: true }])
    await registry.syncAll()
    await expect(registry.acquire(['pay-service'])).rejects.toThrow('「pay-service」不在应用注册表中。可用的应用 id：order-service')
    expect(registry.status()[0]?.activeRuns).toBe(0)
  })
})

describe('catalog follower', () => {
  it('reads the catalog again when the service appears after a failed startup read', async () => {
    const { root, registry, fake } = await setup()
    const origin = await createAppRepo(join(root, 'origin'))
    fake.setCatalog([{ url: origin }])
    const follower = new CatalogFollower({ registry, repos: new ReposClient(() => fake), active: () => true, error: () => {} })
    const repoList = fake.repoList.bind(fake)
    fake.repoList = async () => { throw repoError('unavailable', 'catalog unreadable') }
    await expect(follower.load()).rejects.toThrow('catalog unreadable')
    fake.repoList = repoList
    await follower.serviceAppeared()
    expect(registry.readyApps().map(app => app.app.id)).toEqual(['order-service'])
  })
})
