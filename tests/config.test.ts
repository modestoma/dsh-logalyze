import { describe, expect, it } from 'vitest'
import { applyOverlay, defaultsOf, overlaySchema, resolveConfig } from '../src/config.ts'
import { diffOverlay } from '../src/settings/overlay.ts'

describe('configuration', () => {
  it('defaults every field', () => {
    const config = resolveConfig(undefined)
    expect(config).toMatchObject({ fetchIntervalMs: 0, maxAppsPerRequest: 4, subagentProvider: 'spawn', refreshWaitMs: 15000 })
    expect(defaultsOf(config).skillUpdates).toEqual({ enabled: true, maxFiles: 16, maxFileBytes: 262144 })
    expect(defaultsOf(config).mrReview).toEqual({
      enabled: true,
      pollIntervalMs: 60_000,
      debounceMs: 45_000,
      maxConcurrentSessions: 3,
      skipDraft: true,
      ignoreLabels: [],
      maxAutoFixAttempts: 2,
      dailyMrTurnLimit: 12,
      repoHourlyTurnLimit: 30,
    })
    expect(defaultsOf(config).logSupervision).toEqual({
      enabled: false,
      pollIntervalMs: 60_000,
      batchSizeThreshold: 5,
      maxBatchSize: 20,
      batchWindowMs: 300_000,
      maxConcurrentBatches: 4,
      appHourlyBatchLimit: 15,
      deliveryMode: 'quiet-until-done',
      maxUnpackBytes: 512 * 1024 * 1024,
    })
    expect(defaultsOf(config).issueSync).toEqual({
      enabled: true,
      syncIntervalMs: 300_000,
    })
  })

  it('validates mrReview optional fields and issueSync bitable URLs', () => {
    const custom = resolveConfig({
      mrReview: {
        customInstructions: '  注意检查权限校验与并发锁。 ',
        feishuChatId: ' oc_mr_team_1 ',
      },
      issueSync: {
        enabled: true,
        bitableUrl: 'https://mi.feishu.cn/base/appBase123?table=tblIssues',
        table: ' tblIssues ',
        syncIntervalMs: 10_000,
      },
    })
    expect(custom.mrReview.customInstructions).toBe('注意检查权限校验与并发锁。')
    expect(custom.mrReview.feishuChatId).toBe('oc_mr_team_1')
    expect(custom.issueSync.bitableUrl).toBe('https://mi.feishu.cn/base/appBase123?table=tblIssues')
    expect(custom.issueSync.table).toBe('tblIssues')

    const cleared = resolveConfig({
      mrReview: { customInstructions: '   ', feishuChatId: '' },
      issueSync: { bitableUrl: '', table: '   ' },
    })
    expect(cleared.mrReview.customInstructions).toBeUndefined()
    expect(cleared.mrReview.feishuChatId).toBeUndefined()
    expect(cleared.issueSync.bitableUrl).toBeUndefined()
    expect(cleared.issueSync.table).toBeUndefined()

    expect(() => resolveConfig({ mrReview: { feishuChatId: 'bad_chat' } })).toThrow(/chat_id/)
    expect(() => resolveConfig({ issueSync: { bitableUrl: 'https://example.com/not-bitable' } })).toThrow(/飞书多维表格地址/)
    expect(() => resolveConfig({ issueSync: { syncIntervalMs: 1000 } })).toThrow(/issueSync\.syncIntervalMs/)
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
