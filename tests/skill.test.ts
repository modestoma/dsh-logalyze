import { describe, expect, it, vi } from 'vitest'
import { abortable } from '../src/abort.ts'
import { createEntrySkillProvider, DESCRIPTION_MAX_CHARS, describeApps, renderCatalog, renderEntrySkill } from '../src/skill/entry.ts'
import type { AppManifest } from '../src/settings/contract.ts'
import { loadBundledSkills, parseBundledSkill } from '../src/skill/bundled.ts'

const bundled = [
  { name: 'logalyze-kit', description: '接入套件', content: '# 观象接入套件' },
  { name: 'logalyze-improve', description: '改进指南', content: '# 观象 SKILL 改进指南' },
] as const
const order: AppManifest = { id: 'order-service', name: '订单服务', description: '下单 | 支付', aliases: ['订单'], logHints: ['OrderController'], skill: 'log-analysis' }

describe('entry skill', () => {
  it('lists usable applications in the catalog', () => {
    expect(renderCatalog([order])).toContain('| `order-service` | 订单服务 | 下单 \\| 支付 | 订单 | `OrderController` |')
    expect(renderCatalog([])).toContain('当前没有可用的应用')
    const body = renderEntrySkill([order], 3, false)
    expect(body).toContain('`logalyze_dispatch`')
    expect(body).toContain('最多 3 个')
    expect(body).not.toContain('logalyze_improve_skill')
    const improving = renderEntrySkill([order], 3, true)
    expect(improving).toContain('派发结果中某个应用标出「SKILL 不足」时：先照常写完汇总回复')
    expect(improving).toContain('先用 `logalyze_show_skill` 查看现有 SKILL 的相关内容')
  })

  it('is user-invocable only and renders the live catalog on each load', async () => {
    let apps: AppManifest[] = []
    const ready = Promise.withResolvers<void>()
    const { factory, invalidate } = createEntrySkillProvider({ prepare: signal => abortable(ready.promise, signal), apps: () => apps, maxAppsPerRequest: () => 4, skillUpdates: () => false, autoInvoke: false, inRepositories: () => false, bundled })
    const control = { signal: new AbortController().signal, invalidate: vi.fn() }
    const provider = factory(control)
    const [candidate] = await provider.list({})
    expect(candidate).toMatchObject({ name: 'logalyze', invocation: { modelInvocable: false, userInvocable: true }, rank: 600 })
    let loaded = false
    const loading = provider.get(candidate!, {}).then((skill) => { loaded = true; return skill })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(loaded).toBe(false)
    ready.resolve()
    expect((await loading)?.content).toContain('当前没有可用的应用')
    const aborted = AbortSignal.abort(new Error('stop'))
    await expect(provider.get(candidate!, { signal: aborted })).rejects.toThrow('stop')
    apps = [order]
    expect((await provider.get(candidate!, {}))?.content).toContain('order-service')
    // Without automatic loading the listed entry does not depend on the applications.
    invalidate()
    expect(control.invalidate).not.toHaveBeenCalled()
  })

  it('lets top-level agents load it when applications are usable, and lists it nowhere inside the repositories', async () => {
    let apps: AppManifest[] = []
    const { factory, invalidate } = createEntrySkillProvider({
      prepare: () => Promise.resolve(),
      apps: () => apps,
      maxAppsPerRequest: () => 4,
      skillUpdates: () => false,
      autoInvoke: true,
      inRepositories: cwd => cwd.startsWith('/repos'),
      bundled,
    })
    const control = { signal: new AbortController().signal, invalidate: vi.fn() }
    const provider = factory(control)
    const [empty] = await provider.list({ cwd: '/project' })
    expect(empty).toMatchObject({ invocation: { modelInvocable: false, userInvocable: true }, whenToUse: '仅在用户输入 /logalyze 时使用。' })

    apps = [order]
    invalidate()
    expect(control.invalidate).toHaveBeenCalledTimes(1)
    const [listed] = await provider.list({ cwd: '/project' })
    expect(listed).toMatchObject({ name: 'logalyze', invocation: { modelInvocable: true, userInvocable: true } })
    expect(listed?.description).toContain('订单服务（order-service、订单、OrderController）')
    expect((await provider.list({ cwd: '/repos/.snapshots/order-service/abc' })).map(skill => skill.name)).toEqual(['logalyze-kit', 'logalyze-improve'])
    invalidate()
    expect(control.invalidate).toHaveBeenCalledTimes(1)
    const skill = await provider.get(listed!, {})
    expect(skill).toMatchObject({ invocation: { modelInvocable: true }, description: listed?.description })
    expect(skill?.content).toContain('按普通方式完成用户的请求')
  })

  it('fits the description within the catalog budget and counts applications left out', () => {
    const many = Array.from({ length: 40 }, (_, index) => ({ ...order, id: `app-${index}`, name: `应用${index}` }))
    const text = describeApps(many)
    expect(text.length).toBeLessThanOrEqual(DESCRIPTION_MAX_CHARS)
    expect(text).toMatch(/；另有 \d+ 个应用。日志与这些应用无关时不要使用。$/)
    expect(text).toContain('应用0（app-0、订单、OrderController）')
    const huge = { ...order, aliases: ['x'.repeat(DESCRIPTION_MAX_CHARS)] }
    expect(describeApps([huge])).toContain('1 个应用')
  })

  it('serves the bundled guides everywhere for users and children, never for model choice', async () => {
    const { factory } = createEntrySkillProvider({ prepare: () => Promise.resolve(), apps: () => [order], maxAppsPerRequest: () => 4, skillUpdates: () => false, autoInvoke: true, inRepositories: cwd => cwd.startsWith('/repos'), bundled })
    const provider = factory({ signal: new AbortController().signal, invalidate: vi.fn() })
    const listed = await provider.list({ cwd: '/project' })
    expect(listed.map(skill => skill.name)).toEqual(['logalyze', 'logalyze-kit', 'logalyze-improve'])
    const [kit, improve] = await provider.list({ cwd: '/repos/x' })
    expect(kit).toMatchObject({ name: 'logalyze-kit', description: '接入套件', invocation: { modelInvocable: false, userInvocable: true }, rank: 600, whenToUse: '仅在用户输入 /logalyze-kit 时使用。' })
    expect(await provider.get(kit!, {})).toMatchObject({ name: 'logalyze-kit', content: '# 观象接入套件' })
    expect(improve).toMatchObject({ name: 'logalyze-improve', invocation: { modelInvocable: false, userInvocable: true }, whenToUse: '仅在用户输入 /logalyze-improve 时使用。' })
    expect(await provider.get(improve!, {})).toMatchObject({ name: 'logalyze-improve', content: '# 观象 SKILL 改进指南' })
  })
})

describe('bundled skills', () => {
  it('ships valid SKILL.md files for the kit and the improvement guide', () => {
    const [kit, improve] = loadBundledSkills(new URL('../skills/', import.meta.url))
    expect(kit?.name).toBe('logalyze-kit')
    expect(kit?.description).toContain('logalyze.yaml')
    expect(kit?.content).toContain('references/<领域>.md')
    expect(kit?.content).toContain('## 案例索引')
    expect(improve?.name).toBe('logalyze-improve')
    expect(improve?.content).toContain('cases/<YYYY-MM-DD>-<slug>.md')
    expect(improve?.content).toContain('## 案例索引')
    for (const skill of [kit, improve]) expect(skill?.content).not.toMatch(/^---/)
  })

  it('rejects a file that would not register under its name', () => {
    expect(() => parseBundledSkill('# no frontmatter', 'logalyze-kit')).toThrow('缺少 frontmatter')
    expect(() => parseBundledSkill('---\nname: other\ndescription: x\n---\nbody', 'logalyze-improve')).toThrow('name 必须是 logalyze-improve')
    expect(() => parseBundledSkill('---\nname: logalyze-kit\n---\nbody', 'logalyze-kit')).toThrow('缺少 description 或正文')
    expect(parseBundledSkill('---\nname: logalyze-kit\ndescription: 套件\n---\n\n# 正文\n', 'logalyze-kit')).toEqual({ name: 'logalyze-kit', description: '套件', content: '# 正文' })
  })
})
