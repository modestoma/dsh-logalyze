import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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
    expect(request.headers.authorization).toBe(`Basic ${Buffer.from('logalyze:client-secret').toString('base64')}`)
    expect(new URLSearchParams(request.body).has('client_secret')).toBe(false)

    const wrong = client()
    wrong.secret.value = 'nope'
    await expect(wrong.client.findLogs([logUuid(1)])).rejects.toMatchObject({ retryable: false, message: expect.stringContaining('client_secret') })
    wrong.secret.value = undefined
    await expect(wrong.client.findLogs([logUuid(1)])).rejects.toThrow('未配置 client_secret')
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
    await expect(api.createAnalysis(logUuid(1), 'key-1', 'report.md', [{ path: 'report.md', sizeBytes: 4 }])).rejects.toMatchObject({ status: 409 })
    platform.fail('put', 403)
    await expect(api.put(replayed.uploads[0]!.upload_url, Buffer.from('abc'), 5000)).rejects.toMatchObject({ status: 403, retryable: false })
  })

  it('refuses a response without the agreed fields', async () => {
    platform.addLog(orderLog(1, { file_name: '' }))
    const { client: api } = client()
    await expect(api.findLogs([logUuid(1)])).rejects.toMatchObject({ retryable: false, message: expect.stringContaining('响应字段不符合约定（items.0.file_name') })
  })
})
