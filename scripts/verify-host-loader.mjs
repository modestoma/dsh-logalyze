/**
 * Host bundle smoke test: import the built `lib/index.js` as an installed DSH
 * profile would (plain Node ESM, no TypeScript transform) and check the Cordis
 * plugin surface.
 *
 * Run after `pnpm build:host`: node scripts/verify-host-loader.mjs
 */

import assert from 'node:assert/strict'

const plugin = await import('../lib/index.js')

assert.equal(plugin.name, 'logalyze', 'host bundle must export the Cordis plugin name')
assert.equal(typeof plugin.apply, 'function', 'host bundle must export apply()')
assert.deepEqual([...plugin.inject], ['tools', 'skills', 'subagents'], 'unexpected inject list')
assert.ok(plugin.Config !== undefined, 'host bundle must export the Config schema')

// The Loader validates a composition entry through Config's Standard Schema.
const empty = await plugin.Config['~standard'].validate(undefined)
assert.equal(empty.issues, undefined, 'an omitted config should validate')
const configured = await plugin.Config['~standard'].validate({
  repos: [{ url: 'https://github.com/example/order-service.git' }],
  download: { allowedHosts: ['oss.example.com'] },
})
assert.equal(configured.issues, undefined, 'a typical config should validate')
const invalid = await plugin.Config['~standard'].validate({ repos: [{ url: 'ext::sh -c id' }] })
assert.ok(invalid.issues !== undefined, 'an ext:: transport must be rejected')

console.log('OK: lib/index.js imports as plain ESM and exposes the Cordis plugin surface')
