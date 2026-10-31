import { describe, expect, it, vi } from 'vitest'
import { abortable } from '../src/abort.ts'
import { createEntrySkillProvider, DESCRIPTION_MAX_CHARS, describeApps, renderCatalog, renderEntrySkill } from '../src/skill/entry.ts'
import type { AppManifest } from '../src/settings/contract.ts'
import { loadKitSkill, parseKitSkill } from '../src/skill/kit.ts'

const kit = { description: '接入套件', content: '# 观象接入套件' }
const order: AppManifest = { id: 'order-service', name: '订单服务', description: '下单 | 支付', aliases: ['订单'], logHints: ['OrderController'], skill: 'log-analysis' }

describe('entry skill', () => {
  it('lists usable applications in the catalog', () => {
    expect(renderCatalog([order])).toContain('| `order-service` | 订单服务 | 下单 \\| 支付 | 订单 | `OrderController` |')
    expect(renderCatalog([])).toContain('当前没有可用的应用')
    const body = renderEntrySkill([order], 3, false)
    expect(body).toContain('`logalyze_dispatch`')
    expect(body).toContain('最多 3 个')
    expect(body).not.toContain('logalyze_propose_skill')
    expect(renderEntrySkill([order], 3, true)).toContain('然后调用 `logalyze_propose_skill`')
  })

  it('is user-invocable only and renders the live catalog on each load', async () => {
    let apps: AppManifest[] = []
    const ready = Promise.withResolvers<void>()
    const { factory, invalidate } = createEntrySkillProvider({ prepare: signal => abortable(ready.promise, signal), apps: () => apps, maxAppsPerRequest: () => 4, skillUpdates: () => false, autoInvoke: false, inRepositories: () => false, kit })
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
      kit,
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
    expect((await provider.list({ cwd: '/repos/.snapshots/order-service/abc' })).map(skill => skill.name)).toEqual(['logalyze-kit'])
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

  it('serves /logalyze-kit everywhere for users and the drafting child, never for model choice', async () => {
    const { factory } = createEntrySkillProvider({ prepare: () => Promise.resolve(), apps: () => [order], maxAppsPerRequest: () => 4, skillUpdates: () => false, autoInvoke: true, inRepositories: cwd => cwd.startsWith('/repos'), kit })
    const provider = factory({ signal: new AbortController().signal, invalidate: vi.fn() })
    const listed = await provider.list({ cwd: '/project' })
    expect(listed.map(skill => skill.name)).toEqual(['logalyze', 'logalyze-kit'])
    const [inRepo] = await provider.list({ cwd: '/repos/x' })
    expect(inRepo).toMatchObject({ name: 'logalyze-kit', description: '接入套件', invocation: { modelInvocable: false, userInvocable: true }, rank: 600 })
    expect(await provider.get(inRepo!, {})).toMatchObject({ name: 'logalyze-kit', content: '# 观象接入套件' })
  })
})

describe('logalyze-kit', () => {
  it('ships a valid SKILL.md that covers the description, the SKILL, and references', () => {
    const shipped = loadKitSkill(new URL('../skills/logalyze-kit/SKILL.md', import.meta.url))
    expect(shipped.description).toContain('logalyze.yaml')
    expect(shipped.content).toContain('references/<领域>.md')
    expect(shipped.content).not.toMatch(/^---/)
  })

  it('rejects a file that would not register as /logalyze-kit', () => {
    expect(() => parseKitSkill('# no frontmatter')).toThrow('缺少 frontmatter')
    expect(() => parseKitSkill('---\nname: other\ndescription: x\n---\nbody')).toThrow('name 必须是 logalyze-kit')
    expect(() => parseKitSkill('---\nname: logalyze-kit\n---\nbody')).toThrow('缺少 description 或正文')
    expect(parseKitSkill('---\nname: logalyze-kit\ndescription: 套件\n---\n\n# 正文\n')).toEqual({ description: '套件', content: '# 正文' })
  })
})
