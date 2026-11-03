/**
 * Client bundle smoke test: load lib/client.js through a minimal
 * __ModuleLoader__ + require shim (the browser kernel's module table), then
 * call apply() against a fake slots registry.
 *
 * Run after `pnpm build:client`: node scripts/verify-client-loader.mjs
 */

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

const moduleTable = {
  react: () => require('react'),
  'react/jsx-runtime': () => require('react/jsx-runtime'),
}

let loaded

globalThis.window = {
  __ModuleLoader__: {
    load: ({ id, factory }) => {
      assert.equal(loaded, undefined, 'bundle registered twice')
      loaded = { id, module: factory(name => {
        const resolve = moduleTable[name]
        if (resolve === undefined) throw new Error(`bundle requires unknown module: ${name}`)
        return resolve()
      }) }
    },
  },
}

const styles = []
globalThis.document = {
  querySelector: () => null,
  createElement: () => ({ setAttribute() {}, remove() {}, textContent: '' }),
  head: { append: element => styles.push(element) },
}

await import('../lib/client.js')

assert.ok(loaded, 'bundle did not call window.__ModuleLoader__.load')
assert.equal(loaded.id, 'dsh-logalyze')
const plugin = loaded.module
assert.equal(typeof plugin.apply, 'function', 'bundle did not export apply()')
assert.deepEqual(plugin.inject, ['slots'])

const registrations = []
plugin.apply({
  effect: callback => { callback() },
  slots: {
    inject: (_slot, contribution) => { contribution() },
    register: (declaration, component) => {
      registrations.push({ declaration, component })
      return () => {}
    },
  },
})

assert.equal(styles.length, 1, 'stylesheet was not installed')
assert.deepEqual(registrations.map(({ declaration }) => declaration.name), ['main', 'sidebar.panellist'])
const [page, entry] = registrations
assert.equal(page.declaration.key, 'logalyze')
assert.equal(entry.declaration.id, 'logalyze', 'sidebar row id must address the main page key')
assert.equal(entry.declaration.label(), '观象')
for (const { component } of registrations) assert.equal(typeof component, 'function')

console.log('OK: lib/client.js loads through __ModuleLoader__ and registers the sidebar entry and page')
