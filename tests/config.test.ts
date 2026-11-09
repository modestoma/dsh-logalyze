import { describe, expect, it } from 'vitest'
import { applyOverlay, defaultsOf, isAcceptedBranch, isAcceptedGitUrl, overlaySchema, resolveConfig } from '../src/config.ts'
import { diffOverlay } from '../src/settings/overlay.ts'

describe('git address policy', () => {
  it.each([
    'https://github.com/example/pay-service.git',
    'https://gitlab.example.com:8443/team/app.git',
    'file:///srv/git/app.git',
    '/srv/git/app',
  ])('accepts %s', (url) => {
    expect(isAcceptedGitUrl(url)).toBe(true)
  })

  it.each([
    'git@github.com:example/order-service.git',
    'ssh://git@git.example.com:2222/team/app.git',
    'git://example.com/a.git',
    'http://example.com/a.git',
    'ext::sh -c id',
    '--upload-pack=touch /tmp/x',
    'relative/path',
    'ftp://example.com/a.git',
    '',
  ])('refuses %s', (url) => {
    expect(isAcceptedGitUrl(url)).toBe(false)
  })

  it('refuses branch names that could be read as options or ranges', () => {
    expect(isAcceptedBranch('release/1.2')).toBe(true)
    expect(isAcceptedBranch('-f')).toBe(false)
    expect(isAcceptedBranch('a..b')).toBe(false)
    expect(isAcceptedBranch('a b')).toBe(false)
  })
})

describe('configuration', () => {
  it('defaults every field', () => {
    const config = resolveConfig(undefined)
    expect(config).toMatchObject({ fetchIntervalMs: 0, maxAppsPerRequest: 4, subagentProvider: 'spawn', refreshWaitMs: 15000 })
    expect(defaultsOf(config).skillUpdates).toEqual({ enabled: true, maxFiles: 16, maxFileBytes: 262144 })
  })

  it('normalizes allowed hosts and rejects schemes', () => {
    expect(resolveConfig({ download: { allowedHosts: [' OSS.Example.com ', '*.cdn.example.com'] } }).download.allowedHosts)
      .toEqual(['oss.example.com', 'cdn.example.com'])
    expect(() => resolveConfig({ download: { allowedHosts: ['https://oss.example.com'] } })).toThrow(/域名不合法/)
  })

  it('refuses the former repos key with where to configure repositories now, and unknown keys', () => {
    expect(() => resolveConfig({ repos: [{ url: '/srv/a' }] })).toThrow(/repos: 应用仓库已改在 dsh-repo 中配置.*打开「日志分析」功能/)
    expect(() => resolveConfig({ repos: [] })).toThrow(/dsh-repo/)
    expect(overlaySchema.safeParse({ repos: [] }).success).toBe(false)
    expect(() => resolveConfig({ repo: [] })).toThrow()
    expect(() => resolveConfig({ gitCredentials: [] })).toThrow()
  })

  it('stores only the fields that differ from the defaults', () => {
    const defaults = defaultsOf(resolveConfig({ maxAppsPerRequest: 3 }))
    const overlay = diffOverlay(defaults, { ...defaults, maxAppsPerRequest: 2 })
    expect(overlay).toEqual({ maxAppsPerRequest: 2 })
    expect(applyOverlay(defaults, overlay)).toEqual({ ...defaults, maxAppsPerRequest: 2 })
  })
})
