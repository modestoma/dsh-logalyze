import { describe, expect, it } from 'vitest'
import { collectGroupStats, GROUP_STATS_MAX_PAGES } from '../src/log/group-stats.ts'
import type { ListLogsPageParams, PlatformLog, PlatformLogPage } from '../src/platform/client.ts'

function log(id: string, fields: Partial<PlatformLog> = {}): PlatformLog {
  return {
    log_id: id,
    product_code: null,
    product_sn: null,
    hw_version: null,
    sw_version: null,
    component_code: 'order',
    component_version: null,
    error_code: null,
    file_name: `${id}.log`,
    log_type: null,
    status: 'completed',
    file_size_bytes: null,
    created_at: null,
    archived_at: '2026-11-10T08:00:00.000Z',
    detail_url: null,
    ...fields,
  }
}

const window = { archivedFrom: '2026-11-01T00:00:00.000Z', archivedTo: '2026-11-12T00:00:00.000Z' }

describe('collectGroupStats', () => {
  it('sends only the codes the group carries and matches missing codes against empty ones', async () => {
    const queries: ListLogsPageParams[] = []
    const stats = await collectGroupStats({ componentCode: 'order' }, window, async (params) => {
      queries.push(params)
      return {
        items: [
          log('a'),
          log('b', { error_code: '  ' }),
          log('c', { error_code: 'E1' }),
          log('d', { product_code: 'P1' }),
          log('e', { archived_at: null }),
        ],
      }
    })
    expect(queries).toEqual([{ ...window, status: 'completed', componentCode: 'order' }])
    expect(stats.group).toEqual({ productCode: null, componentCode: 'order', errorCode: null })
    expect(stats.count).toBe(2)
  })

  it('follows cursors up to the page cap and marks the count as a lower bound', async () => {
    let calls = 0
    const stats = await collectGroupStats({ componentCode: 'order', productCode: 'P1', errorCode: 'E1' }, window, async (params): Promise<PlatformLogPage> => {
      calls += 1
      expect(params).toMatchObject({ productCode: 'P1', errorCode: 'E1' })
      return { items: [log(`l${calls}`, { product_code: 'P1', error_code: 'E1', sw_version: `V${calls}` })], nextCursor: `c${calls}` }
    })
    expect(calls).toBe(GROUP_STATS_MAX_PAGES)
    expect(stats).toMatchObject({ count: GROUP_STATS_MAX_PAGES, truncated: true })
    expect(stats.swVersions.top).toHaveLength(10)
    expect(stats.swVersions.otherCount).toBe(0)
  })

  it('lists the ten most frequent versions and sums the rest', async () => {
    const items = Array.from({ length: 13 }, (_, index) => log(`v${index}`, { sw_version: `V${index}`, archived_at: `2026-11-0${(index % 9) + 1}T00:00:00.000Z` }))
    items.push(log('dup', { sw_version: 'V12' }))
    const stats = await collectGroupStats({ componentCode: 'order' }, window, async () => ({ items }))
    expect(stats.swVersions.top[0]).toEqual({ value: 'V12', count: 2 })
    expect(stats.swVersions.top).toHaveLength(10)
    expect(stats.swVersions.otherCount).toBe(3)
    expect(stats.firstArchivedAt).toBe('2026-11-01T00:00:00.000Z')
    expect(stats.lastArchivedAt).toBe('2026-11-10T08:00:00.000Z')
  })
})
