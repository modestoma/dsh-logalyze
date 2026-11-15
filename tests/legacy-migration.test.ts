import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { analyzeRequestHash } from '../src/analyze/contract.ts'
import type { AnalyzeRequest } from '../src/analyze/contract.ts'
import { analysisIdOf } from '../src/report/store.ts'
import type { AnalysisRecord } from '../src/report/store.ts'
import { defaultsOf, resolveConfig } from '../src/config.ts'
import type { FeishuTopicService, TopicCardLinks, TopicLaunchResult, TopicLaunchSpec, TopicLaunchState } from '../src/deps/topics-contract.ts'
import type { HostContext, HostCredentials } from '../src/host.ts'
import { apply } from '../src/index.ts'
import { LOG_TASK_RETENTION_MS } from '../src/log/index.ts'
import { removeExpiredMrWorkspace } from '../src/mr/workspace.ts'
import { SupervisorService } from '../src/service.ts'
import type { StateWire } from '../src/settings/contract.ts'
import { defaultOverlayPath, OverlayStore } from '../src/settings/overlay.ts'
import { loadBundledSkills } from '../src/skill/bundled.ts'
import { FakePlatform, logUuid, orderLog } from './fake-platform.ts'
import { FakeRepos } from './fake-repos.ts'
import { createAppRepo, tempDir, waitFor } from './helpers.ts'

type Handler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>

const cleanups: (() => Promise<void>)[] = []
const originalDshHome = process.env.DSH_HOME

afterEach(async () => {
  if (originalDshHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = originalDshHome
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup()))
})

function fakeCredentials(initial: Record<string, { value: string; source: string; writable?: boolean }> = {}): HostCredentials & {
  stored: Map<string, { value: string; source: string; writable: boolean }>
} {
  const stored = new Map(
    Object.entries(initial).map(([key, item]) => [key, { value: item.value, source: item.source, writable: item.writable ?? true }]),
  )
  return {
    stored,
    resolve: async (ref) => {
      const entry = stored.get(ref)
      return entry === undefined ? undefined : { value: entry.value, source: entry.source }
    },
    describe: async (ref) => {
      const entry = stored.get(ref)
      return entry === undefined
        ? { configured: false, writable: true }
        : { configured: true, source: entry.source, writable: entry.writable }
    },
    set: async (ref, value) => {
      stored.set(ref, { value, source: 'file', writable: true })
    },
    unset: async (ref) => {
      stored.delete(ref)
    },
  }
}

function fakeTopics(): FeishuTopicService {
  const states = new Map<string, TopicLaunchState>()
  return {
    version: 3 as const,
    launch: async (spec: TopicLaunchSpec): Promise<TopicLaunchResult> => {
      states.set(spec.key, { key: spec.key, status: 'running' })
      return { ok: true, replayed: false, chatId: spec.chatId, messageId: 'om_new' }
    },
    state: (key: string): TopicLaunchState | undefined => states.get(key),
    launchKeyOf: (): string | undefined => undefined,
    updateLinks: async (_key: string, _links: TopicCardLinks) => ({ ok: true }),
  }
}

async function createPluginHarness(services: Record<string, unknown> = {}) {
  const { dir: mirrorsDir, cleanup } = await tempDir('supervisor-mig-mirrors-')
  const repos = new FakeRepos(mirrorsDir)
  const routes = new Map<string, Handler>()
  const disposers: (() => Promise<void>)[] = []
  const warn = vi.fn()
  const webServer = {
    register: (route: { path: string; handler: Handler }) => {
      routes.set(route.path, route.handler)
      return () => { routes.delete(route.path) }
    },
  }
  const all: Record<string, unknown> = {
    webServer,
    dshRepos: repos,
    connection: { requestRejection: () => undefined },
    ...services,
  }
  const ctx: HostContext = {
    tools: { register: () => () => {} },
    skills: { registerProvider: () => () => {} },
    subagents: { getProvider: () => ({}), resolveMaxDepth: () => 1, startActivation: () => Promise.reject(new Error('not used')) },
    logger: { warn },
    get: (name: string) => all[name],
    on: () => () => {},
    provide: (name, value) => { all[name] = value; return () => { delete all[name] } },
    effect: (callback) => {
      const dispose = callback()
      const wrapped = async (): Promise<void> => { await dispose?.() }
      disposers.push(wrapped)
      return () => { void wrapped() }
    },
    inject: (deps, callback) => {
      if (deps.every(dep => all[dep] !== undefined)) callback(ctx)
    },
  }
  const server: Server = createServer((req, res) => {
    const handler = routes.get(new URL(req.url ?? '/', 'http://x').pathname)
    if (handler === undefined) {
      res.writeHead(404)
      res.end()
      return
    }
    void handler(req, res)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const dispose = async (): Promise<void> => {
    for (const fn of disposers.reverse()) await fn()
    await new Promise(resolve => server.close(resolve))
    await cleanup()
  }
  cleanups.push(dispose)
  return { ctx, repos, base, warn, dispose }
}

describe('legacy logalyze state migration', () => {
  it('migrates settings, application metadata, fallback domain, pending analyses, legacy reports, and credentials from $DSH_HOME/logalyze', async () => {
    const { dir: homeDir, cleanup } = await tempDir('supervisor-legacy-home-')
    cleanups.push(cleanup)
    process.env.DSH_HOME = homeDir

    const platform = new FakePlatform()
    await platform.start()
    cleanups.push(() => platform.stop())
    const log = orderLog(1, { component_code: 'panel-alias' })
    platform.addLog(log)

    const { dir: repoRoot, cleanup: cleanupRepo } = await tempDir('supervisor-legacy-repo-')
    cleanups.push(cleanupRepo)
    const origin = await createAppRepo(join(repoRoot, 'order-service'))

    const legacyDir = join(homeDir, 'logalyze')
    const supervisorDir = join(homeDir, 'supervisor')
    await mkdir(join(legacyDir, 'supervisor'), { recursive: true })
    await mkdir(join(legacyDir, 'reports'), { recursive: true })

    const defaults = defaultsOf(resolveConfig({}))
    await writeFile(join(legacyDir, 'settings.json'), JSON.stringify({
      maxAppsPerRequest: 2,
      analyze: {
        ...defaults.analyze,
        enabled: true,
        defaultChatId: 'oc_migrated_group',
        platform: platform.settings(),
      },
    }))

    await writeFile(join(legacyDir, 'applications.json'), JSON.stringify({
      version: 1,
      applications: {
        [origin]: {
          id: 'custom-panel-id',
          name: '面板应用名称',
          description: '面板手动维护的描述',
          aliases: ['panel-alias', '订单别名'],
          logHints: [],
          skill: 'log-analysis',
        },
      },
    }))

    await writeFile(join(legacyDir, 'supervisor', 'dsh_supervisor.json'), JSON.stringify({
      version: 1,
      tables: {
        watermarks: {
          log_platform: {
            cursorTime: '2026-11-10T00:00:00Z',
            cursorId: 'cursor-migrated-1',
            paused: false,
            consecutiveFailures: 0,
          },
        },
        issues: {
          'iss-legacy-1': {
            appId: 'custom-panel-id',
            title: '历史已知问题',
            matchCriteria: 'OutOfMemoryError',
            aiDiagnosis: '堆内存泄漏',
            aiStatus: 'located',
            resolutionAdvice: '检查缓存淘汰策略',
            firstSeenAt: 1000,
            lastSeenAt: 2000,
            syncDirty: false,
          },
        },
      },
    }))

    const nowMs = Date.now()
    const analysisKey = 'legacy-pending-key'
    const analysisId = analysisIdOf(analysisKey)
    const pendingReq: AnalyzeRequest = {
      triggerType: 'digital',
      triggerId: 'u_alice',
      triggeredAt: '2026-11-14 10:00',
      chatId: 'oc_migrated_group',
      logIds: [log.log_id],
    }
    const analysisRecord: AnalysisRecord = {
      id: analysisId,
      key: analysisKey,
      fingerprint: analyzeRequestHash(pendingReq),
      triggerType: 'digital',
      triggerId: 'u_alice',
      triggeredAt: '2026-11-14 10:00',
      chatId: 'oc_migrated_group',
      app: 'custom-panel-id',
      appName: '面板应用名称',
      componentCode: 'panel-alias',
      errorCode: 'E1001',
      logs: [{
        ref: 'L1',
        logId: log.log_id,
        fileName: log.file_name,
        productSn: 'SN1',
        hwVersion: '1.0',
        swVersion: '2.0.1',
        componentVersion: '1.4.0',
        logType: 'device',
        sizeBytes: '1024',
        createdAt: '2026-11-14 09:50',
        uploadedRevision: 0,
        generation: 0,
      }],
      acceptedAt: nowMs - 10_000,
      sections: [{
        kind: 'analysis',
        status: 'done',
        reply: '结论见附图 ![图](report/chart.png)',
        files: ['chart.png'],
        at: nowMs - 5_000,
      }],
      turns: {},
      snapshot: {},
      warnings: [],
      skipped: [],
      revision: 1,
    }
    await mkdir(join(legacyDir, 'analyses', analysisId, 'report'), { recursive: true })
    await writeFile(join(legacyDir, 'analyses', analysisId, 'report', 'chart.png'), 'png-bytes')
    await writeFile(join(legacyDir, 'analyses', `${analysisId}.json`), JSON.stringify(analysisRecord))

    const legacyReportId = 'abcdef0123456789abcdef01'
    await writeFile(join(legacyDir, 'reports', `${legacyReportId}.json`), JSON.stringify({
      id: legacyReportId,
      logId: logUuid(9),
      app: 'custom-panel-id',
      errorCode: 'E9001',
      triggeredAt: '2026-11-14 08:00',
      acceptedAt: nowMs - 60_000,
      uploadedAt: nowMs - 30_000,
    }))

    const credentials = fakeCredentials({
      LOGALYZE_ANALYZE_TOKEN: { value: 'legacy-api-token', source: 'file' },
      LOGALYZE_PLATFORM_CLIENT_SECRET: { value: platform.secret, source: 'file' },
    })
    const topics = fakeTopics()
    const h = await createPluginHarness({ credentials, feishuTopics: topics })
    h.repos.setCatalog([{ url: origin }])

    apply(h.ctx, {}, { autoMrPollTimer: false, autoLogPollTimer: false, autoIssueSyncTimer: false })

    await waitFor(async () => {
      const state = await (await fetch(`${h.base}/supervisor/state`)).json() as StateWire
      return state.repos[0]?.phase === 'ready'
        && state.analyze.reports.some(report => report.id === analysisId && report.logs[0]?.phase === 'done')
    })

    const state = await (await fetch(`${h.base}/supervisor/state`)).json() as StateWire
    expect(state.overridden).toEqual(['maxAppsPerRequest', 'analyze'])
    expect(state.settings.maxAppsPerRequest).toBe(2)
    expect(state.settings.analyze.enabled).toBe(true)
    expect(state.settings.analyze.defaultChatId).toBe('oc_migrated_group')
    expect(state.repos[0]?.app).toMatchObject({
      id: 'custom-panel-id',
      name: '面板应用名称',
      description: '面板手动维护的描述',
      aliases: ['panel-alias', '订单别名'],
    })
    expect(state.analyze.legacyReports).toMatchObject([{ id: legacyReportId, app: 'custom-panel-id', errorCode: 'E9001' }])
    expect(state.issues?.totalCount).toBe(1)
    expect(state.issues?.items[0]?.title).toBe('历史已知问题')
    expect(state.logSupervision?.watermark?.cursorTime).toBe('2026-11-10T00:00:00Z')
    expect(state.analyze.token).toMatchObject({ tokenEnv: 'SUPERVISOR_ANALYZE_TOKEN', configured: true, source: 'file' })
    expect(state.analyze.secret).toMatchObject({ tokenEnv: 'SUPERVISOR_PLATFORM_CLIENT_SECRET', configured: true, source: 'file' })

    // Pending analysis upload resumed from migrated `$DSH_HOME/supervisor/analyses`.
    expect(platform.revisions).toHaveLength(1)
    expect(platform.revisions[0]?.completed).toBe(true)
    expect([...platform.revisions[0]!.files.keys()].sort()).toEqual(['chart.png', 'report.md'])

    // Credentials were migrated to `SUPERVISOR_*`.
    expect(credentials.stored.get('SUPERVISOR_ANALYZE_TOKEN')?.value).toBe('legacy-api-token')
    expect(credentials.stored.get('SUPERVISOR_PLATFORM_CLIENT_SECRET')?.value).toBe(platform.secret)
    expect(credentials.stored.has('LOGALYZE_ANALYZE_TOKEN')).toBe(false)
    expect(credentials.stored.has('LOGALYZE_PLATFORM_CLIENT_SECRET')).toBe(false)

    // Persisted files now live under `$DSH_HOME/supervisor` (and fallback `domain/dsh_supervisor.json`).
    expect(JSON.parse(await readFile(join(supervisorDir, 'settings.json'), 'utf8'))).toMatchObject({ maxAppsPerRequest: 2 })
    expect(JSON.parse(await readFile(join(supervisorDir, 'applications.json'), 'utf8'))).toMatchObject({
      applications: { [origin]: { id: 'custom-panel-id' } },
    })
    expect(JSON.parse(await readFile(join(supervisorDir, 'domain', 'dsh_supervisor.json'), 'utf8'))).toMatchObject({
      tables: { issues: { 'iss-legacy-1': { title: '历史已知问题' } } },
    })
    await expect(stat(join(supervisorDir, 'analyses', `${analysisId}.json`))).resolves.toBeDefined()
    await expect(stat(join(supervisorDir, 'reports', `${legacyReportId}.json`))).resolves.toBeDefined()

    // Analyze API works with the migrated bearer token and default group.
    const postRes = await fetch(`${h.base}/open-api/supervisor`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer legacy-api-token',
        'idempotency-key': 'post-migration-req',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        triggerType: 'digital',
        triggerId: 'u_bob',
        triggeredAt: '2026-11-15 12:00',
        logIds: [log.log_id],
      }),
    })
    expect(postRes.status).toBe(202)
  })

  it('never overwrites existing files in $DSH_HOME/supervisor and never resurrects pruned legacy records on restart', async () => {
    const { dir: homeDir, cleanup } = await tempDir('supervisor-partial-mig-')
    cleanups.push(cleanup)
    process.env.DSH_HOME = homeDir

    const legacyDir = join(homeDir, 'logalyze')
    const supervisorDir = join(homeDir, 'supervisor')
    await mkdir(join(legacyDir, 'supervisor'), { recursive: true })
    await mkdir(join(legacyDir, 'reports'), { recursive: true })
    await mkdir(supervisorDir, { recursive: true })

    // Target already has newer settings.json, while applications.json & domain are still in legacy dir.
    await writeFile(join(supervisorDir, 'settings.json'), JSON.stringify({ maxAppsPerRequest: 6 }))
    await writeFile(join(legacyDir, 'settings.json'), JSON.stringify({ maxAppsPerRequest: 2 }))
    await writeFile(join(legacyDir, 'supervisor', 'dsh_supervisor.json'), JSON.stringify({
      version: 1,
      tables: {
        issues: {
          'iss-keep': {
            appId: 'app-1',
            title: '从部分状态恢复的问题',
            matchCriteria: 'panic',
            aiDiagnosis: '空指针',
            aiStatus: 'located',
            resolutionAdvice: '判空',
            firstSeenAt: 1000,
            lastSeenAt: 1000,
            syncDirty: false,
          },
        },
      },
    }))

    // Expired legacy report (> 30 days) in legacy dir should be moved and pruned once, never resurrected later.
    const expiredId = '0123456789abcdef01234567'
    const nowMs = Date.now()
    await mkdir(join(legacyDir, 'reports', expiredId), { recursive: true })
    await writeFile(join(legacyDir, 'reports', expiredId, 'note.txt'), 'old')
    await writeFile(join(legacyDir, 'reports', `${expiredId}.json`), JSON.stringify({
      id: expiredId,
      logId: logUuid(7),
      app: 'app-1',
      errorCode: 'E404',
      triggeredAt: '2026-09-01 00:00',
      acceptedAt: nowMs - 31 * 24 * 60 * 60 * 1000,
    }))

    const h1 = await createPluginHarness()
    const svc1 = new SupervisorService(h1.ctx, resolveConfig({}), new OverlayStore(defaultOverlayPath()), { bundled: loadBundledSkills(new URL('../skills/', import.meta.url)) }, {
      autoMrPollTimer: false,
      autoLogPollTimer: false,
      autoIssueSyncTimer: false,
      now: () => nowMs,
    })
    await svc1.boot()
    const state1 = await svc1.state()
    expect(state1.settings.maxAppsPerRequest).toBe(6)
    expect(state1.issues?.totalCount).toBe(1)
    expect(state1.analyze.legacyReports).toEqual([])
    await expect(stat(join(supervisorDir, 'reports', `${expiredId}.json`))).rejects.toThrow()
    await expect(stat(join(legacyDir, 'reports', `${expiredId}.json`))).rejects.toThrow()
    await svc1.shutdown()

    // Second startup leaves settings untouched and does not resurrect expired records.
    const h2 = await createPluginHarness()
    const svc2 = new SupervisorService(h2.ctx, resolveConfig({}), new OverlayStore(defaultOverlayPath()), { bundled: loadBundledSkills(new URL('../skills/', import.meta.url)) }, {
      autoMrPollTimer: false,
      autoLogPollTimer: false,
      autoIssueSyncTimer: false,
      now: () => nowMs,
    })
    await svc2.boot()
    const state2 = await svc2.state()
    expect(state2.settings.maxAppsPerRequest).toBe(6)
    expect(state2.issues?.totalCount).toBe(1)
    expect(state2.analyze.legacyReports).toEqual([])
    await svc2.shutdown()
  })

  it('migrates nested <dataDir>/supervisor domain files to <dataDir>/domain and supports retention cleanup for legacy workspaces', async () => {
    const { dir, cleanup } = await tempDir('supervisor-nested-ws-')
    cleanups.push(cleanup)

    const nestedLegacyDomain = join(dir, 'custom', 'supervisor')
    await mkdir(nestedLegacyDomain, { recursive: true })
    await writeFile(join(nestedLegacyDomain, 'dsh_supervisor.json'), JSON.stringify({
      version: 1,
      tables: {
        issues: {
          'iss-nested': {
            appId: 'app-nested',
            title: '同级目录迁移问题',
            matchCriteria: 'timeout',
            aiDiagnosis: '连接池耗尽',
            aiStatus: 'located',
            resolutionAdvice: '增大连接池',
            firstSeenAt: 1000,
            lastSeenAt: 1000,
            syncDirty: false,
          },
        },
      },
    }))

    const h = await createPluginHarness()
    const svc = new SupervisorService(
      h.ctx,
      resolveConfig({}),
      new OverlayStore(join(dir, 'custom', 'settings.json')),
      { bundled: loadBundledSkills(new URL('../skills/', import.meta.url)) },
      {
        autoMrPollTimer: false,
        autoLogPollTimer: false,
        autoIssueSyncTimer: false,
      },
    )
    await svc.boot()
    const state = await svc.state()
    expect(state.issues?.totalCount).toBe(1)
    expect(state.issues?.items[0]?.title).toBe('同级目录迁移问题')
    await expect(stat(join(dir, 'custom', 'domain', 'dsh_supervisor.json'))).resolves.toBeDefined()
    await svc.shutdown()

    // MR legacy workspace retention cleanup allows both current and legacy roots, never outside directories.
    const currentMrRoot = join(dir, 'supervisor', 'mr-workspaces')
    const legacyMrRoot = join(dir, 'logalyze', 'mr-workspaces')
    const legacyMrWs = join(legacyMrRoot, 'abc123-mr-1')
    const outsideDir = join(dir, 'outside-do-not-delete')
    await mkdir(legacyMrWs, { recursive: true })
    await mkdir(outsideDir, { recursive: true })
    await writeFile(join(legacyMrWs, 'marker.txt'), 'mr')
    await writeFile(join(outsideDir, 'keep.txt'), 'keep')

    expect(await removeExpiredMrWorkspace([currentMrRoot, legacyMrRoot], outsideDir)).toBe(false)
    await expect(stat(outsideDir)).resolves.toBeDefined()
    expect(await removeExpiredMrWorkspace([currentMrRoot, legacyMrRoot], legacyMrWs)).toBe(true)
    await expect(stat(legacyMrWs)).rejects.toThrow()

    // LogSupervisor retention sweep cleans expired workspaces located inside legacyDataDir/log-workspaces.
    const legacyHome = join(dir, 'legacy-logalyze-ws')
    const legacyTaskDir = join(legacyHome, 'log-workspaces', 'task-expired-1')
    const externalTaskDir = join(dir, 'unmanaged-ws', 'task-expired-2')
    await mkdir(legacyTaskDir, { recursive: true })
    await mkdir(externalTaskDir, { recursive: true })

    let currentNow = 200 * 24 * 60 * 60 * 1000
    const platform = new FakePlatform()
    await platform.start()
    cleanups.push(() => platform.stop())

    const hLog = await createPluginHarness()
    const svcLog = new SupervisorService(
      hLog.ctx,
      resolveConfig({
        logSupervision: { enabled: true },
        analyze: { platform: platform.settings() },
      }),
      new OverlayStore(join(dir, 'supervisor-ws', 'settings.json')),
      { bundled: loadBundledSkills(new URL('../skills/', import.meta.url)) },
      {
        legacyDataDir: legacyHome,
        autoMrPollTimer: false,
        autoLogPollTimer: false,
        autoIssueSyncTimer: false,
        now: () => currentNow,
      },
    )
    await svcLog.boot()
    const domain = await svcLog.supervisorDomain()
    const expiredAt = currentNow - LOG_TASK_RETENTION_MS - 1_000
    await domain.logTasks.put('task-expired-1', {
      source: 'platform',
      appId: 'app-1',
      workDir: legacyTaskDir,
      inputs: [{ ref: 'L1', logId: logUuid(1) }],
      status: 'completed',
      revisions: [{ revision: 1, summary: 'done', createdAt: expiredAt }],
      createdAt: expiredAt,
      updatedAt: expiredAt,
    })
    await domain.logTasks.put('task-expired-2', {
      source: 'feishu',
      appId: 'app-1',
      workDir: externalTaskDir,
      inputs: [{ ref: 'L1', logId: logUuid(2) }],
      status: 'completed',
      revisions: [{ revision: 1, summary: 'done', createdAt: expiredAt }],
      createdAt: expiredAt,
      updatedAt: expiredAt,
    })
    // Trigger retention sweep via pollNow(); watermark is missing/empty and FakePlatform has 0 archived logs.
    await svcLog.logSupervisorInstance()!.pollNow()
    expect(domain.logTasks.get('task-expired-1')).toBeUndefined()
    expect(domain.logTasks.get('task-expired-2')).toBeUndefined()
    await expect(stat(legacyTaskDir)).rejects.toThrow()
    await expect(stat(externalTaskDir)).resolves.toBeDefined()
    await svcLog.shutdown()
  })
})
