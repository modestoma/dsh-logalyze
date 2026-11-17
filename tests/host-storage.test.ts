import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { inject } from '../src/index.ts'
import { openSupervisorDomain, supervisorDomainSpec } from '../src/runtime/index.ts'
import type { DomainSpec, RawDomainHandle, RawTable, SupervisorDomain } from '../src/runtime/index.ts'

/** Mirrors DSH `storageDomain` tables: `entries()` and `keys()` return iterators. */
function createIteratorTable(): RawTable {
  const records = new Map<string, unknown>()
  return {
    get size() { return records.size },
    get: key => records.get(key),
    entries: () => [...records.entries()][Symbol.iterator](),
    keys: () => [...records.keys()][Symbol.iterator](),
    put: async (key, value) => { records.set(key, value) },
    update: async (key, fn) => {
      if (!records.has(key)) throw new Error(`no record '${key}'`)
      const next = fn(records.get(key))
      records.set(key, next)
      return next
    },
    delete: async key => records.delete(key),
  }
}

function createHostFacility(): { open(spec: DomainSpec): Promise<RawDomainHandle>; opened: string[] } {
  const opened: string[] = []
  return {
    opened,
    open: async (spec) => {
      opened.push(spec.name)
      const tables = new Map(Object.keys(spec.tables).map(name => [name, createIteratorTable()]))
      return {
        table: (name) => {
          const table = tables.get(name)
          if (table === undefined) throw new Error(`domain '${spec.name}' declares no table '${name}'`)
          return table
        },
        close: async () => {},
      }
    },
  }
}

/** Load a probe plugin with the given `inject` under real Cordis and open the supervisor domain from its context. */
function openFromPlugin(declared: readonly string[]): { facility: ReturnType<typeof createHostFacility>; domain: Promise<SupervisorDomain> } {
  const root = new Context()
  const facility = createHostFacility()
  // Host services come from sibling plugins, as in a DSH composition.
  root.plugin({
    name: 'host-services',
    apply: (ctx: Context) => {
      for (const name of ['tools', 'skills', 'subagents']) ctx.provide(name, {})
      ctx.provide('storageDomain', facility)
    },
  })
  let resolve!: (domain: Promise<SupervisorDomain>) => void
  const domain = new Promise<Promise<SupervisorDomain>>((done) => { resolve = done }).then(opened => opened)
  root.plugin({
    name: 'supervisor-probe',
    inject: [...declared],
    apply: (ctx: Context) => {
      // Defer like `SupervisorService.boot()`, which opens the domain from an effect after `apply()`.
      setTimeout(() => { resolve(openSupervisorDomain({ ctx })) }, 0)
    },
  })
  return { facility, domain }
}

describe('supervisor storage under real Cordis', () => {
  it('opens the host storageDomain from the plugin inject list', async () => {
    expect(inject).toContain('storageDomain')
    const { facility, domain } = openFromPlugin(inject)
    const opened = await domain
    expect(facility.opened).toEqual([supervisorDomainSpec.name])

    await opened.watermarks.put('platform', { paused: false, consecutiveFailures: 0 })
    expect(opened.watermarks.entries()).toEqual([['platform', { paused: false, consecutiveFailures: 0 }]])
    expect(opened.watermarks.values()).toEqual([{ paused: false, consecutiveFailures: 0 }])
    expect(opened.watermarks.keys()).toEqual(['platform'])
    expect(opened.issues.entries()).toEqual([])
    await opened.close()
  })

  it('rejects host storage access when storageDomain is not injected', async () => {
    const { facility, domain } = openFromPlugin(['tools', 'skills', 'subagents'])
    await expect(domain).rejects.toThrow(/storageDomain/u)
    expect(facility.opened).toEqual([])
  })
})
