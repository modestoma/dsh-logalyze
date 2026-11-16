import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/config.ts'
import { PlatformClient, PlatformError, platformProblem, TOKEN_REFRESH_MARGIN_MS } from '../src/platform/client.ts'
import type { PlatformSettings } from '../src/settings/contract.ts'
import { FakePlatform, logUuid, orderLog } from './fake-platform.ts'

let platform: FakePlatform
beforeEach(async () => {
  platform = new FakePlatform()
  await platform.start()
})
afterEach(async () => { await platform.stop() })

function client(overrides: Partial<PlatformSettings> = {}, now = { value: 1_000_000 }): { client: PlatformClient; now: { value: number }; secret: { value: string | undefined } } {
  const secret = { value: platform.secret as string | undefined }
  const settings = platform.settings(overrides)
  return { client: new PlatformClient({ settings: () => settings, secret: async () => secret.value, now: () => now.value }), now, secret }
}

describe('platform client', () => {
  it('names the settings that are missing', () => {
    expect(platformProblem(platform.settings())).toBeUndefined()
    expect(platformProblem({ ...platform.settings(), baseUrl: undefined, clientId: undefined })).toContain('缺少接口地址、client_id')
  })

  it('reuses one token until it nears expiry, then requests another', async () => {
    platform.addLog(orderLog(1))
    const { client: api, now } = client()
    const [first] = await Promise.all([api.findLogs([logUuid(1)]), api.findLogs([logUuid(1)])])
    expect(first.map(log => log.log_id)).toEqual([logUuid(1)])
    expect(platform.calls('token')).toHaveLength(1)
    expect(new URLSearchParams(platform.calls('token')[0]!.body).get('scope')).toBe('log:search log:download log:upload')
    now.value += (platform.expiresIn * 1000) - TOKEN_REFRESH_MARGIN_MS - 1000
    await api.findLogs([logUuid(1)])
    expect(platform.calls('token')).toHaveLength(1)
    now.value += 2000
    await api.findLogs([logUuid(1)])
    expect(platform.calls('token')).toHaveLength(2)
    expect(platform.calls('logs').at(-1)!.headers.authorization).toBe('Bearer token-2')
  })

  it('requests a new token once when the API answers 401', async () => {
    platform.addLog(orderLog(1))
    const { client: api } = client()
    await api.findLogs([logUuid(1)])
    platform.revokeTokens()
    expect(await api.findLogs([logUuid(1)])).toHaveLength(1)
    expect(platform.calls('token')).toHaveLength(2)
    platform.fail('logs', 401, 401)
    const error = await api.findLogs([logUuid(1)]).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(PlatformError)
    expect(error).toMatchObject({ status: 401, retryable: false })
    expect((error as Error).message).toContain('client_id')
  })

  it('authenticates with HTTP Basic when configured and reports a refused secret', async () => {
    platform.addLog(orderLog(1))
    const basic = client({ clientAuth: 'basic' })
    await basic.client.findLogs([logUuid(1)])
    const request = platform.calls('token')[0]!
    expect(request.headers.authorization).toBe(`Basic ${Buffer.from('supervisor:client-secret').toString('base64')}`)
    expect(new URLSearchParams(request.body).has('client_secret')).toBe(false)

    const wrong = client()
    wrong.secret.value = 'nope'
    await expect(wrong.client.findLogs([logUuid(1)])).rejects.toMatchObject({ retryable: false, message: expect.stringContaining('client_secret') })
    wrong.secret.value = undefined
    await expect(wrong.client.findLogs([logUuid(1)])).rejects.toThrow('未配置 client_secret')
  })

  it('authenticates with HTTP Basic by default, as the platform refuses credentials in the body', async () => {
    platform.addLog(orderLog(1))
    const defaults = resolveConfig({ analyze: { platform: { baseUrl: platform.base, tokenUrl: `${platform.base}/oauth/token`, clientId: 'supervisor' } } }).analyze.platform
    const { client: api } = client({ clientAuth: defaults.clientAuth })
    await api.findLogs([logUuid(1)])
    expect(platform.calls('token')[0]!.headers.authorization).toMatch(/^Basic /u)
    const body = client({ clientAuth: 'body' })
    await expect(body.client.findLogs([logUuid(1)])).rejects.toMatchObject({ retryable: false })
  })

  it('sends only the archive window, status, and the filters it was given when listing a page', async () => {
    platform.addLog(orderLog(1))
    platform.addLog(orderLog(2, { error_code: 'E2002' }))
    const { client: api } = client()
    const window = { archivedFrom: '2026-11-10T00:00:00Z', archivedTo: '2026-11-11T00:00:00Z' }
    const page = await api.listLogsPage({ ...window, componentCode: 'order', errorCode: 'E2002', limit: 500 })
    expect(page.items.map(log => log.log_id)).toEqual([logUuid(2)])
    expect(page.nextCursor).toBeUndefined()
    const query = new URLSearchParams(platform.calls('logs')[0]!.path.split('?')[1])
    expect([...query.keys()].sort()).toEqual(['archived_from', 'archived_to', 'component_code', 'error_code', 'limit', 'status'])
    expect(query.get('limit')).toBe('100')
    expect(query.get('status')).toBe('completed')
  })

  it('classifies failures as retryable or not and keeps the request id', async () => {
    platform.addLog(orderLog(1))
    const { client: api } = client()
    platform.fail('logs', 503)
    await expect(api.findLogs([logUuid(1)])).rejects.toMatchObject({ retryable: true, status: 503, message: expect.stringContaining('X-Request-Id req-503') })
    platform.fail('logs', 400)
    await expect(api.findLogs([logUuid(1)])).rejects.toMatchObject({ retryable: false, status: 400, message: expect.stringContaining('injected 400') })
    platform.fail('logs', 0)
    await expect(api.findLogs([logUuid(1)])).rejects.toMatchObject({ retryable: true })
    await expect(api.downloadUrl(logUuid(9))).rejects.toMatchObject({ status: 404 })
    const link = await api.downloadUrl(logUuid(1))
    expect(link).toMatchObject({ file_name: 'device-1.tar.gz' })
  })

  it('matches log ids case-insensitively', async () => {
    platform.addLog(orderLog(1, { log_id: logUuid(1).toUpperCase() }))
    const { client: api } = client()
    expect((await api.findLogs([logUuid(1)])).map(log => log.log_id)).toEqual([logUuid(1).toUpperCase()])
  })

  it('creates, uploads, and completes a revision, replaying it under the same key', async () => {
    platform.addLog(orderLog(1))
    const { client: api } = client()
    const created = await api.createAnalysis(logUuid(1), 'key-1', 'report.md', [{ path: 'report.md', sizeBytes: 3 }])
    expect(JSON.parse(platform.calls('create')[0]!.body)).toEqual({ entry_path: 'report.md', files: [{ path: 'report.md', size_bytes: '3' }] })
    expect(platform.calls('create')[0]!.headers['idempotency-key']).toBe('key-1')
    await expect(api.completeAnalysis(logUuid(1), created.analysis_id)).rejects.toMatchObject({ status: 409 })
    const replayed = await api.createAnalysis(logUuid(1), 'key-1', 'report.md', [{ path: 'report.md', sizeBytes: 3 }])
    expect(replayed.analysis_id).toBe(created.analysis_id)
    await api.put(replayed.uploads[0]!.upload_url, Buffer.from('abc'), 5000)
    expect(await api.completeAnalysis(logUuid(1), created.analysis_id)).toBe(`${platform.base}/logs/${logUuid(1)}/analysis`)
    // A replay of the completed revision answers `expires_at: null` and no upload links.
    const completedReplay = await api.createAnalysis(logUuid(1), 'key-1', 'report.md', [{ path: 'report.md', sizeBytes: 3 }])
    expect(completedReplay).toMatchObject({ analysis_id: created.analysis_id, expires_at: null })
    await expect(api.createAnalysis(logUuid(1), 'key-1', 'report.md', [{ path: 'report.md', sizeBytes: 4 }])).rejects.toMatchObject({ status: 409 })
    platform.fail('put', 403)
    await expect(api.put(replayed.uploads[0]!.upload_url, Buffer.from('abc'), 5000)).rejects.toMatchObject({ status: 403, retryable: true })
  })

  it('refuses a response without the agreed fields', async () => {
    platform.addLog(orderLog(1, { file_name: '' }))
    const { client: api } = client()
    await expect(api.findLogs([logUuid(1)])).rejects.toMatchObject({ retryable: false, message: expect.stringContaining('响应字段不符合约定（items.0.file_name') })
  })
})
