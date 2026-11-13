import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RepoRegistry } from '../src/apps/registry.ts'
import { ReposClient } from '../src/deps/repos.ts'
import { ApplicationSettings } from '../src/settings/applications.ts'
import type { SkillDefinition, SkillRegistry } from '../src/host.ts'
import { FakeRepos } from './fake-repos.ts'
import { commitFile, createAppRepo, git, tempDir } from './helpers.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { await Promise.all(cleanups.splice(0).map(cleanup => cleanup())) })

async function setup(skills?: SkillRegistry) {
  const { dir, cleanup } = await tempDir()
  cleanups.push(cleanup)
  const fake = new FakeRepos(join(dir, 'mirrors'))
  const path = join(dir, 'applications.json')
  const create = () => new RepoRegistry({ repos: new ReposClient(() => fake), applications: new ApplicationSettings(path), ...(skills === undefined ? {} : { skills }), onChange: () => {} })
  const applications = new ApplicationSettings(path)
  const registry = new RepoRegistry({ repos: new ReposClient(() => fake), applications, ...(skills === undefined ? {} : { skills }), onChange: () => {} })
  return { dir, fake, path, registry, applications, create }
}

describe('application settings', () => {
  it('imports usable fields without requiring skill and keeps panel values after manifest deletion and restart', async () => {
    const { dir, registry, create, path } = await setup()
    const origin = await createAppRepo(join(dir, 'order'))
    await commitFile(origin, '.agents/logalyze.yaml', 'id: order-service\nname: 订单服务\ndescription: 订单与支付\naliases: [订单, ORDER, order, 42]\n')
    registry.configure([{ url: origin, writable: false }])
    await registry.syncAll()
    expect(registry.readyApp('order-service').app).toMatchObject({ description: '订单与支付', aliases: ['订单', 'order'] })
    await registry.saveApplication({ url: origin, description: '新描述', aliases: ['订单平台', 'app_order'] })
    git(origin, 'rm', '-q', '.agents/logalyze.yaml')
    git(origin, 'commit', '-qm', 'remove legacy manifest')
    const restored = create()
    restored.configure([{ url: origin, writable: false }])
    await restored.syncAll()
    expect(restored.resolve(' ＡＰＰ＿ＯＲＤＥＲ ').app).toMatchObject({ id: 'order-service', description: '新描述', aliases: ['订单平台', 'app_order'] })
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ version: 1 })
    expect(await readFile(join(origin, '.agents/skills/log-analysis/SKILL.md'), 'utf8')).toContain('name: log-analysis')
  })

  it('retries a failed legacy import without freezing empty defaults over usable metadata', async () => {
    const { dir, registry } = await setup()
    const origin = await createAppRepo(join(dir, 'order'))
    await commitFile(origin, '.agents/logalyze.yaml', 'broken: [yaml')
    registry.configure([{ url: origin, writable: true }])
    await registry.syncAll()
    expect(registry.status()[0]).toMatchObject({ available: true, error: expect.stringContaining('旧应用配置未迁移') })
    await registry.syncAll()
    expect(registry.status()[0]?.error).toContain('旧应用配置未迁移')
    await commitFile(origin, '.agents/logalyze.yaml', 'id: recovered\nname: 恢复应用\ndescription: 可用描述\naliases: [recover]\nskill: Bad_skill\n')
    await registry.syncAll()
    expect(registry.resolve('recover').app).toMatchObject({ id: 'recovered', description: '可用描述' })
    expect(registry.status()[0]?.error).toBeUndefined()
  })

  it('readies code with no skill or manifest and persists a stable generated identity', async () => {
    const { dir, registry, create } = await setup()
    const origin = await createAppRepo(join(dir, 'code-only'))
    git(origin, 'rm', '-qr', '.agents')
    git(origin, 'commit', '-qm', 'code only')
    registry.configure([{ url: origin, writable: false }])
    await registry.syncAll()
    const first = registry.readyApps()[0]!
    expect(first.app).toMatchObject({ name: 'code-only', description: '', aliases: [] })
    expect(first.app.skill).toBeUndefined()
    const next = create()
    next.configure([{ url: origin, writable: false }])
    await next.syncAll()
    expect(next.readyApps()[0]!.app.id).toBe(first.app.id)
  })

  it('rejects duplicate and cross-application aliases, unknown names and inactive writes without changing stored metadata', async () => {
    const { dir, registry } = await setup()
    const first = await createAppRepo(join(dir, 'order'))
    const second = await createAppRepo(join(dir, 'pay'), { '.agents/logalyze.yaml': 'id: pay-service\nname: 支付服务\ndescription: 支付\naliases: [pay]\n' })
    registry.configure([{ url: first, writable: true }, { url: second, writable: true }])
    await registry.syncAll()
    await expect(registry.saveApplication({ url: first, description: '', aliases: ['Order', 'ＯＲＤＥＲ'] })).rejects.toThrow('别名重复')
    await expect(registry.saveApplication({ url: first, description: '', aliases: ['PAY'] })).rejects.toThrow('已被其他应用使用')
    await expect(registry.saveApplication({ url: first, description: '', aliases: [], skill: 'mandatory' })).rejects.toThrow()
    expect(() => registry.resolve('unknown')).toThrow('没有对应的可用应用')
    const requests = await Promise.allSettled([
      registry.saveApplication({ url: first, description: '', aliases: ['shared'] }),
      registry.saveApplication({ url: second, description: '', aliases: ['SHARED'] }),
    ])
    expect(requests.map(result => result.status)).toEqual(['fulfilled', 'rejected'])
    const held = await registry.acquire(['order-service'])
    registry.configure([{ url: second, writable: true }])
    await expect(registry.acquire(['order-service'])).rejects.toThrow('不在应用注册表中')
    await expect(registry.saveApplication({ url: first, description: 'inactive', aliases: [] })).rejects.toThrow('已移除或关闭')
    expect(await readFile(join(held.apps.get('order-service')!.dir, 'README.md'), 'utf8')).not.toBe('')
    held.release()
  })

  it('diagnoses imported ambiguous aliases and uses unique IDs to retain explicit access', async () => {
    const { dir, registry } = await setup()
    const first = await createAppRepo(join(dir, 'one'))
    const second = await createAppRepo(join(dir, 'two'), { '.agents/logalyze.yaml': 'id: pay-service\nname: 支付\ndescription: 支付\naliases: [ORDER]\n' })
    registry.configure([{ url: first, writable: true }, { url: second, writable: true }])
    await registry.syncAll()
    expect(() => registry.resolve('order')).toThrow('同时对应多个应用')
    expect(registry.status().every(status => status.error?.includes('触发名称冲突'))).toBe(true)
    expect(registry.resolve('order-service').url).toBe(first)
    await registry.saveApplication({ url: second, description: '支付', aliases: ['pay'] })
    expect(registry.status().every(status => status.error === undefined)).toBe(true)
  })

  it.each([false, true])('keeps a saved alias when an older repository refresh publishes afterwards (failed import: %s)', async (failedImport) => {
    const { dir, registry, applications, path } = await setup()
    const origin = await createAppRepo(join(dir, 'order'))
    if (failedImport) await commitFile(origin, '.agents/logalyze.yaml', 'invalid: [yaml')
    registry.configure([{ url: origin, writable: true }])
    await registry.syncAll()
    const entered = Promise.withResolvers<void>()
    const finish = Promise.withResolvers<void>()
    const ensure = applications.ensure.bind(applications)
    vi.spyOn(applications, 'ensure').mockImplementationOnce(async (...args) => {
      const imported = await ensure(...args)
      entered.resolve()
      await finish.promise
      return imported
    })
    const refreshing = registry.syncAll()
    try {
      await entered.promise
      await registry.saveApplication({ url: origin, description: '新描述', aliases: ['latest'] })
    } finally { finish.resolve() }
    await refreshing
    expect(registry.resolve('latest').app.description).toBe('新描述')
    expect(registry.status()[0]?.error).toBeUndefined()
    expect((JSON.parse(await readFile(path, 'utf8')) as { applications: Record<string, { aliases: string[] }> }).applications[origin]?.aliases).toEqual(['latest'])
  })

  it('publishes a save to the current catalog entry after its analysis branch changes', async () => {
    const { dir, registry, applications } = await setup()
    const origin = await createAppRepo(join(dir, 'order'))
    git(origin, 'branch', 'release')
    registry.configure([{ url: origin, branch: 'main', writable: true }])
    await registry.syncAll()
    const entered = Promise.withResolvers<void>()
    const finish = Promise.withResolvers<void>()
    const save = applications.save.bind(applications)
    vi.spyOn(applications, 'save').mockImplementationOnce(async (...args) => {
      entered.resolve()
      await finish.promise
      return save(...args)
    })
    const saving = registry.saveApplication({ url: origin, description: '分支切换后的描述', aliases: ['new-branch'] })
    try {
      await entered.promise
      registry.configure([{ url: origin, branch: 'release', writable: true }])
      await registry.syncAll()
    } finally { finish.resolve() }
    await saving
    expect(registry.resolve('new-branch')).toMatchObject({ branch: 'release', app: { description: '分支切换后的描述' } })
  })

  it('keeps an unreadable new branch unavailable even when its metadata save finishes', async () => {
    const { dir, registry, applications } = await setup()
    const origin = await createAppRepo(join(dir, 'order'))
    registry.configure([{ url: origin, branch: 'main', writable: true }])
    await registry.syncAll()
    const entered = Promise.withResolvers<void>()
    const finish = Promise.withResolvers<void>()
    const save = applications.save.bind(applications)
    vi.spyOn(applications, 'save').mockImplementationOnce(async (...args) => { entered.resolve(); await finish.promise; return save(...args) })
    const saving = registry.saveApplication({ url: origin, description: '新描述', aliases: ['saved'] })
    try {
      await entered.promise
      registry.configure([{ url: origin, branch: 'missing', writable: true }])
      await registry.syncAll()
    } finally { finish.resolve() }
    await saving
    expect(registry.status()[0]).toMatchObject({ phase: 'failed', available: false })
    expect(registry.readyApps()).toEqual([])
  })

  it('drains an admitted metadata write before closing and refuses later writes', async () => {
    const { dir, registry, applications, path } = await setup()
    const origin = await createAppRepo(join(dir, 'order'))
    registry.configure([{ url: origin, writable: true }])
    await registry.syncAll()
    const entered = Promise.withResolvers<void>()
    const finish = Promise.withResolvers<void>()
    const save = applications.save.bind(applications)
    vi.spyOn(applications, 'save').mockImplementationOnce(async (...args) => {
      entered.resolve()
      await finish.promise
      return save(...args)
    })
    const saving = registry.saveApplication({ url: origin, description: '必须保存', aliases: ['retained'] })
    await entered.promise
    let closed = false
    const closing = registry.close().then(() => { closed = true })
    try {
      await expect(registry.saveApplication({ url: origin, description: '不接受', aliases: [] })).rejects.toThrow('已停止')
      await expect(registry.acquire(['order-service'])).rejects.toThrow('已停止')
      expect(closed).toBe(false)
    } finally { finish.resolve() }
    await Promise.all([saving, closing])
    expect((JSON.parse(await readFile(path, 'utf8')) as { applications: Record<string, { description: string }> }).applications[origin]?.description).toBe('必须保存')
    expect(closed).toBe(true)
  })

  it('cancels an uncompleted snapshot acquisition before closing', async () => {
    const { dir, registry, fake } = await setup()
    const origin = await createAppRepo(join(dir, 'order'))
    registry.configure([{ url: origin, writable: true }])
    await registry.syncAll()
    fake.stalled = true
    const acquiring = registry.acquire(['order-service'])
    const rejected = expect(acquiring).rejects.toThrow('已停止')
    await registry.close()
    await rejected
    expect(fake.heldSnapshots()).toBe(0)
    expect(registry.status()[0]?.activeRuns).toBe(0)
  })

  it('cancels and drains a refresh belonging to a replaced catalog entry', async () => {
    const { dir, registry, fake } = await setup()
    const origin = await createAppRepo(join(dir, 'order'))
    registry.configure([{ url: origin, writable: true }])
    await registry.syncAll()
    fake.stalled = true
    const running = registry.syncAll()
    registry.configure([])
    await registry.close()
    await running
    expect(fake.heldSnapshots()).toBe(0)
    expect(registry.configure([{ url: origin, writable: true }])).toEqual([])
    expect(registry.readyApps()).toEqual([])
  })

  it('keeps malformed application storage intact and visibly refuses to use it', async () => {
    const { dir, registry, path } = await setup()
    const origin = await createAppRepo(join(dir, 'order'))
    await writeFile(path, '{broken')
    registry.configure([{ url: origin, writable: true }])
    await registry.syncAll()
    expect(registry.status()[0]).toMatchObject({ available: false, error: expect.stringContaining('未覆盖原文件') })
    expect(await readFile(path, 'utf8')).toBe('{broken')
  })

  it('discovers host and repository skills through DSH, loads on demand, and rejects released paths', async () => {
    const definitions: SkillDefinition[] = ['repo-diagnosis', 'host-unzip', 'manual-only'].map(name => ({
      name,
      description: `${name} description`,
      invocation: { modelInvocable: name !== 'manual-only', userInvocable: true },
      source: 'project-agents',
      provider: 'filesystem',
      content: `# ${name}`,
    }))
    const list = vi.fn(async () => definitions)
    const get = vi.fn(async (name: string) => definitions.find(skill => skill.name === name))
    const { dir, registry, fake } = await setup({ registerProvider: () => () => {}, list, get })
    const origin = await createAppRepo(join(dir, 'order'))
    registry.configure([{ url: origin, branch: 'main', writable: false }])
    await registry.syncAll()
    const lease = await registry.acquire(['order-service'])
    const app = lease.apps.get('order-service')!
    const options = { scope: { id: 'main', session: { header: { id: 'main' } } }, signal: new AbortController().signal }
    expect(app.branch).toBe('main')
    expect((await app.skills.list(options)).map(skill => skill.name)).toEqual(['repo-diagnosis', 'host-unzip'])
    expect(list).toHaveBeenLastCalledWith({ ...options, cwd: app.dir })
    expect(get).not.toHaveBeenCalled()
    expect((await app.skills.load('repo-diagnosis', options))?.content).toBe('# repo-diagnosis')
    expect(get).toHaveBeenLastCalledWith('repo-diagnosis', { ...options, cwd: app.dir })
    expect(await app.skills.load('manual-only')).toBeUndefined()
    expect(await app.skills.load('absent')).toBeUndefined()
    lease.release()
    await expect(app.skills.list()).rejects.toThrow('代码快照已释放')
    await expect(app.skills.load('repo-diagnosis')).rejects.toThrow('代码快照已释放')
    expect(fake.heldSnapshots()).toBe(0)
  })

  it('reports incomplete DSH discovery and never turns it into a no-skill claim', async () => {
    const { dir, registry } = await setup({
      registerProvider: () => () => {},
      list: async () => [],
      snapshot: async () => ({ skills: [], complete: false }),
      get: async () => undefined,
    })
    const origin = await createAppRepo(join(dir, 'order'))
    registry.configure([{ url: origin, writable: true }])
    await registry.syncAll()
    const lease = await registry.acquire(['order-service'])
    try { await expect(lease.apps.get('order-service')!.skills.list()).rejects.toThrow('SKILL 发现未完成') }
    finally { lease.release() }
  })

  it('accepts an empty skill catalog as normal and reports discovery failures instead of inventing an empty catalog', async () => {
    const list = vi.fn(async () => [])
    const { dir, registry } = await setup({ registerProvider: () => () => {}, list, get: async () => undefined })
    const origin = await createAppRepo(join(dir, 'order'))
    registry.configure([{ url: origin, writable: true }])
    await registry.syncAll()
    const lease = await registry.acquire(['order-service'])
    try {
      const skills = lease.apps.get('order-service')!.skills
      expect(await skills.list()).toEqual([])
      list.mockRejectedValueOnce(new Error('discovery unavailable'))
      await expect(skills.list()).rejects.toThrow('discovery unavailable')
    } finally { lease.release() }
  })
})
