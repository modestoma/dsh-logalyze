import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { disablesUserInvocation, parseManifest, readAppManifest } from '../src/repos/manifest.ts'
import { EXAMPLE_APP, tempDir } from './helpers.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { await Promise.all(cleanups.splice(0).map(cleanup => cleanup())) })

describe('application manifest', () => {
  it('reads the example application', async () => {
    const read = await readAppManifest(EXAMPLE_APP)
    expect(read).toEqual({
      ok: true,
      app: {
        id: 'order-service',
        name: '订单服务',
        description: '下单、库存扣减与支付回调',
        aliases: ['订单', '下单', 'order'],
        logHints: ['order-service', 'OrderController', 'OrderService'],
        skill: 'log-analysis',
      },
    })
  })

  it('reports invalid ids and missing fields', () => {
    expect(parseManifest('id: Order_Service\nname: x\ndescription: y\nskill: a')).toMatchObject({ ok: false, error: expect.stringMatching(/^\.agents\/logalyze\.yaml 不合法：id/) })
    expect(parseManifest('id: a\nskill: b')).toMatchObject({ ok: false })
    expect(parseManifest(': : :')).toMatchObject({ ok: false, error: expect.stringContaining('不是合法 YAML') })
  })

  it('reports a missing manifest and a missing or non-invocable skill', async () => {
    const { dir, cleanup } = await tempDir()
    cleanups.push(cleanup)
    expect(await readAppManifest(dir)).toEqual({ ok: false, error: '仓库缺少应用描述 .agents/logalyze.yaml' })
    await mkdir(join(dir, '.agents/skills/log-analysis'), { recursive: true })
    await writeFile(join(dir, '.agents/logalyze.yaml'), 'id: a\nname: A\ndescription: d\nskill: log-analysis\n')
    expect(await readAppManifest(dir)).toEqual({ ok: false, error: '仓库缺少日志分析 SKILL .agents/skills/log-analysis/SKILL.md' })
    await writeFile(join(dir, '.agents/skills/log-analysis/SKILL.md'), '---\nname: log-analysis\nuser-invocable: false\n---\nbody')
    expect(await readAppManifest(dir)).toMatchObject({ ok: false, error: expect.stringContaining('user-invocable: false') })
  })

  it('treats a skill without frontmatter as user-invocable', () => {
    expect(disablesUserInvocation('# plain')).toBe(false)
  })
})
