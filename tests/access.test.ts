import { describe, expect, it } from 'vitest'
import { ACCESS_AUTHORIZE_EVENT, authorize } from '../src/deps/access.ts'
import type { AuthorizeEvent } from '../src/deps/access.ts'

const event: AuthorizeEvent = { session: 's1', level: 'admin', action: 'logalyze_add_repo', summary: '加入仓库' }

describe('authorize', () => {
  it('allows when no plugin listens, and dispatches the event otherwise', async () => {
    await expect(authorize({}, event)).resolves.toBeUndefined()
    const seen: unknown[] = []
    await authorize({ parallel: async (name, ...args) => { seen.push(name, args[0]) } }, event)
    expect(seen).toEqual([ACCESS_AUTHORIZE_EVENT, event])
  })

  it('reports every refusing listener by its reason', async () => {
    const parallel = async () => { throw new AggregateError([new Error('张三 不是管理员'), 'down']) }
    await expect(authorize({ parallel }, event)).rejects.toThrow('logalyze_add_repo 未获授权，没有执行：张三 不是管理员；down')
    await expect(authorize({ parallel: async () => { throw new Error('bus down') } }, event)).rejects.toThrow('没有执行：bus down')
  })
})
