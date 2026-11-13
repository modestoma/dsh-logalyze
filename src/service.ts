/**
 * 智能监管中心（观象 + 审微）运行时的组装：
 * - 共享监管运行时（`dsh_supervisor` 存储域与 `logPool` / `mrPool` 并发隔离池）；
 * - 生效设置、应用注册表与仓库清单跟随（同时注册 `log-analysis` 与 `mr-review` 功能开关）；
 * - 入口 SKILL、分析派发及旧版 SKILL 工具注册；
 * - 分析接口令牌、日志平台客户端、分析请求受理与报告回传；
 * - Web 设置面板状态与写入口。
 *
 * @module dsh-logalyze/service
 */

import { dirname, join } from 'node:path'
import { z } from 'zod'
import { resolveBatch } from './analyze/batch.ts'
import { analyzeRequestHash } from './analyze/contract.ts'
import type { AnalyzeRequest, AnalyzeResponse } from './analyze/contract.ts'
import { newAnalysisRecord } from './analyze/record.ts'
import type { AnalyzeGate } from './analyze/server.ts'
import { StoredCredential } from './analyze/token.ts'
import { analysisTopicSpec, analyzeResponseOf, refused } from './analyze/topics.ts'
import { LOGALYZE_APPLICATIONS_SERVICE } from './apps/access.ts'
import type { ApplicationAccess } from './apps/access.ts'
import { CatalogFollower } from './apps/catalog.ts'
import { RepoRegistry } from './apps/registry.ts'
import type { LogalyzeConfig } from './config.ts'
import { describeIssue } from './config.ts'
import { FEISHU_ACTIONS_SERVICE, lookupActions } from './deps/actions.ts'
import { DSH_REPOS_SERVICE, ReposClient } from './deps/repos.ts'
import type { DshRepos } from './deps/repos-contract.ts'
import { FEISHU_TOPICS_STATUS_EVENT } from './deps/topics-contract.ts'
import type { FeishuTopicService } from './deps/topics-contract.ts'
import { FEISHU_TOPICS_SERVICE, lookupTopics } from './deps/topics.ts'
import { Dispatcher } from './dispatch/tool.ts'
import type { HostContext, HostCredentials, ToolActivationContext, ToolDefinition, WorkingDirectoryService } from './host.ts'
import { SkillViewer } from './improve/show.ts'
import { SkillImprover } from './improve/tool.ts'
import { IssueMemory } from './issues/memory.ts'
import { LogSupervisor, createHostLogSessionDriver, createLogTools } from './log/index.ts'
import type { LogSessionDriver, LogToolsRuntime } from './log/index.ts'
import { MrSupervisor, createHostMrSessionDriver, createMrTools } from './mr/index.ts'
import type { MrSessionDriver } from './mr/index.ts'
import { PlatformClient, PlatformError, platformProblem } from './platform/client.ts'
import { LegacyReports, legacyReportsDir } from './report/legacy.ts'
import { AnalysisStore, defaultAnalysesDir } from './report/store.ts'
import { ReportTracker } from './report/tracker.ts'
import { admitPlatformUrl, downloadLog, DownloadError } from './runs/download.ts'
import type { PlatformLogDownloader, PlatformLogRef } from './runs/logs.ts'
import { inRunDirectory, isDelegatedAgent, isInside } from './runs/run-dir.ts'
import { CircuitBreakerRegistry } from './runtime/breaker.ts'
import { openSupervisorDomain } from './runtime/domain.ts'
import type { SupervisorDomain } from './runtime/domain.ts'
import { createSupervisionPools } from './runtime/pool.ts'
import type { SupervisionPools } from './runtime/pool.ts'
import { ApplicationSettings } from './settings/applications.ts'
import { ANALYZE_ROUTE } from './settings/contract.ts'
import type { StateWire } from './settings/contract.ts'
import { SettingsController, SettingsError } from './settings/controller.ts'
import type { OverlayStore } from './settings/overlay.ts'
import type { BundledSkill } from './skill/bundled.ts'
import { createEntrySkillProvider } from './skill/entry.ts'
import { abortable } from './util/abort.ts'
import { messageOf } from './util/errors.ts'

const reportRetrySchema = z.object({ id: z.string().regex(/^[0-9a-f]{24}$/u, '分析 id 不合法') }).strict()
const credentialNameSchema = z.object({ tokenEnv: z.string() }).loose()
const breakerResetSchema = z.object({
  scope: z.enum(['mr', 'mr-repo', 'log-app', 'mr-fix']),
  key: z.string().trim().min(1, '熔断器 key 不能为空'),
}).strict()

/** Optional seams for tests. */
export interface ServiceOptions {
  /** Fetch used for log downloads and the log platform. */
  readonly fetch?: typeof fetch
  /** Analysis record directory; defaults to `$DSH_HOME/logalyze/analyses`. */
  readonly analysesDir?: string
  /** Directory of the former report records; defaults to `$DSH_HOME/logalyze/reports`. */
  readonly legacyReportsDir?: string
  /** Local fallback directory for `dsh_supervisor` when host `storageDomain` is absent. */
  readonly supervisorDir?: string
  /** Local directory where per-MR review workspaces are created. */
  readonly mrWorkspacesDir?: string
  /** Local directory where per-log supervision workspaces are created. */
  readonly logWorkspacesDir?: string
  /** Custom MR session turn driver (used by tests and embedding hosts). */
  readonly mrSessionDriver?: MrSessionDriver
  /** Custom log supervision session turn driver (used by tests and embedding hosts). */
  readonly logSessionDriver?: LogSessionDriver
  /** Deterministic clock seam for tests. */
  readonly now?: () => number
  /** Disable background MR poll interval timer in tests (`pollNow()` drives manually). */
  readonly autoMrPollTimer?: boolean
  /** Disable background log poll interval timer in tests (`pollNow()` drives manually). */
  readonly autoLogPollTimer?: boolean
}

/** Package files the service serves. */
export interface ServiceAssets {
  /** Bundled guide skills (`/logalyze-kit`, `/logalyze-improve`). */
  readonly bundled: readonly BundledSkill[]
}

/** The plugin's long-lived state. */
export class LogalyzeService {
  readonly registry: RepoRegistry
  readonly pools: SupervisionPools
  private readonly settings: SettingsController
  private readonly repos: ReposClient
  private readonly catalog: CatalogFollower
  private readonly token: StoredCredential
  private readonly secret: StoredCredential
  private readonly platform: PlatformClient
  private readonly legacy: LegacyReports
  /** Idempotency key → acceptance in progress (concurrent retries wait for it). */
  private readonly accepting = new Map<string, Promise<AnalyzeResponse>>()
  private readonly dispatcher: Dispatcher
  private readonly improver: SkillImprover
  private readonly viewer: SkillViewer
  private readonly skill: ReturnType<typeof createEntrySkillProvider>
  private readonly reports: ReportTracker
  private readonly supervisorDir: string
  private readonly mrWorkspacesDir: string
  private readonly logWorkspacesDir: string
  private readonly clock: () => number
  private readonly autoMrPollTimer: boolean
  private readonly autoLogPollTimer: boolean
  private readonly hostMrDriver: ReturnType<typeof createHostMrSessionDriver> | undefined
  private readonly mrSessionDriver: MrSessionDriver
  private readonly hostLogDriver: ReturnType<typeof createHostLogSessionDriver> | undefined
  private readonly logSessionDriver: LogSessionDriver
  private readonly fetchImpl: typeof fetch | undefined
  private breakers: CircuitBreakerRegistry | undefined
  private issueMemory: IssueMemory | undefined
  private mrSupervisor: MrSupervisor | undefined
  private logSupervisor: LogSupervisor | undefined
  private supervisorPromise: Promise<SupervisorDomain> | undefined
  private active = true
  private readonly refreshWaitMs: number
  private readonly booted = Promise.withResolvers<void>()

  /**
   * @param ctx - plugin context.
   * @param config - validated plugin configuration.
   * @param store - panel overlay file.
   * @param assets - package files the service serves.
   * @param options - test seams.
   */
  constructor(
    private readonly ctx: HostContext,
    config: LogalyzeConfig,
    store: OverlayStore,
    assets: ServiceAssets,
    options: ServiceOptions = {},
  ) {
    const warn = (message: string): void => { ctx.logger?.warn?.(message) }
    const settings = (): ReturnType<SettingsController['get']> => this.settings.get()
    const workingDirectory = (): WorkingDirectoryService | undefined => ctx.get?.('workingDirectory') as WorkingDirectoryService | undefined
    const fetchSeam = options.fetch === undefined ? {} : { fetch: options.fetch }
    this.supervisorDir = options.supervisorDir ?? join(dirname(store.path), 'supervisor')
    this.mrWorkspacesDir = options.mrWorkspacesDir ?? join(dirname(store.path), 'mr-workspaces')
    this.logWorkspacesDir = options.logWorkspacesDir ?? join(dirname(store.path), 'log-workspaces')
    this.clock = options.now ?? Date.now
    this.autoMrPollTimer = options.autoMrPollTimer ?? true
    this.autoLogPollTimer = options.autoLogPollTimer ?? true
    this.hostMrDriver = options.mrSessionDriver === undefined ? createHostMrSessionDriver(ctx) : undefined
    this.mrSessionDriver = options.mrSessionDriver ?? this.hostMrDriver!
    this.hostLogDriver = options.logSessionDriver === undefined ? createHostLogSessionDriver(ctx) : undefined
    this.logSessionDriver = options.logSessionDriver ?? this.hostLogDriver!
    this.fetchImpl = options.fetch
    this.pools = createSupervisionPools()
    this.settings = new SettingsController(config, store, warn)
    this.refreshWaitMs = config.refreshWaitMs
    this.repos = new ReposClient(() => ctx.get?.(DSH_REPOS_SERVICE))
    const credentials = (): HostCredentials | undefined => ctx.get?.('credentials') as HostCredentials | undefined
    this.token = new StoredCredential(config.analyzeTokenRef, '分析接口令牌', credentials, warn)
    this.secret = new StoredCredential(config.platformSecretRef, '日志平台 client_secret', credentials, warn)
    this.platform = new PlatformClient({ settings: () => this.settings.get().analyze.platform, secret: () => this.secret.value(), now: this.clock, ...fetchSeam })
    this.legacy = new LegacyReports(options.legacyReportsDir ?? legacyReportsDir(), warn)
    this.registry = new RepoRegistry({
      repos: this.repos,
      applications: new ApplicationSettings(join(dirname(store.path), 'applications.json')),
      skills: ctx.skills,
      onChange: () => { this.onRegistryChange() },
      onMrReposChange: () => { this.mrSupervisor?.notifyConfigOrReposChanged() },
    })
    this.catalog = new CatalogFollower({
      registry: this.registry,
      repos: this.repos,
      active: () => this.active,
      error: (message) => { ctx.logger?.error?.(message) },
    })
    const children = { registry: this.registry, subagents: ctx.subagents, provider: config.subagentProvider, settings, workingDirectory, ...fetchSeam }
    this.improver = new SkillImprover({ ...children, repos: this.repos })
    this.viewer = new SkillViewer({ registry: this.registry, repos: this.repos })
    this.dispatcher = new Dispatcher({ ...children, gaps: this.improver, platformLogs: sessionId => this.platformLogsOf(sessionId), platform: this.platformDownloader(options.fetch) })
    this.reports = new ReportTracker({
      store: new AnalysisStore(options.analysesDir ?? defaultAnalysesDir(), warn),
      topics: () => this.topicsService(),
      platform: this.platform,
      upload: () => this.settings.get().analyze.upload,
      warn,
    })
    this.skill = createEntrySkillProvider({
      prepare: signal => this.prepareCatalog(signal),
      apps: () => this.registry.readyApps().map(ready => ready.app),
      maxAppsPerRequest: () => this.settings.get().maxAppsPerRequest,
      skillUpdates: () => this.settings.get().skillUpdates.enabled,
      autoInvoke: config.autoInvoke,
      bundled: assets.bundled,
      inRepositories: (cwd) => {
        if (inRunDirectory(cwd)) return true
        const mirrors = this.repos.mirrorDir()
        return mirrors !== undefined && isInside(cwd, mirrors)
      },
    })
  }

  /** Open or return the initialized `dsh_supervisor` storage domain. */
  supervisorDomain(): Promise<SupervisorDomain> {
    if (this.supervisorPromise === undefined) {
      this.supervisorPromise = openSupervisorDomain({
        ctx: this.ctx,
        fallbackDir: this.supervisorDir,
        now: this.clock,
      })
    }
    return this.supervisorPromise
  }

  /** Register the entry skill provider and `logalyzeApplications` service; called once from `apply()`. */
  registerSkill(): void {
    if (typeof this.ctx.provide === 'function') {
      const access: ApplicationAccess = {
        list: async () => { await this.prepared(); return this.registry.readyApps() },
        resolve: async name => { await this.prepared(); return this.registry.resolve(name) },
        acquire: async ids => { await this.prepared(); return this.registry.acquire(ids) },
      }
      this.ctx.effect(() => this.ctx.provide?.(LOGALYZE_APPLICATIONS_SERVICE, access), 'logalyze: application access')
    }
    this.ctx.effect(() => this.ctx.skills.registerProvider(this.skill.factory), 'logalyze: entry skill')
  }

  /**
   * Register the analysis and legacy SKILL tools and the Session listeners they need; called once
   * from `apply()`. The definitions stay fixed because a step drops a tool
   * whose registration changed after the step resolved its tools.
   */
  registerTools(): void {
    this.ctx.on('session/event', (session, event) => {
      if (event.type === 'turn/end') this.improver.turnEnded(session.header.id)
      this.hostMrDriver?.onSessionEvent(session.header.id, event.type, event.data)
      this.hostLogDriver?.onSessionEvent(session.header.id, event.type, event.data)
      this.logSupervisor?.onSessionEvent(session.header.id, event.type, event.data)
      this.reports.sessionEvent(session, event)
    })
    this.ctx.on(FEISHU_TOPICS_STATUS_EVENT, (state) => {
      this.reports.statusChanged(state)
      this.logSupervisor?.onTopicStatusChanged(state)
    })
    const hasApps = (): boolean => this.registry.readyApps().length > 0
    const register = <V>(definition: ToolDefinition<V>, condition: (context: ToolActivationContext) => boolean, label: string): void => {
      this.ctx.effect(() => this.ctx.tools.register(definition, { when: context => this.offers(context, condition) }), `logalyze: ${label} tool`)
    }
    register(this.dispatcher.definition(), hasApps, 'dispatch')
    register(this.improver.definition(), () => this.settings.get().skillUpdates.enabled && this.registry.readyApps().some(ready => ready.writable && ready.app.skill !== undefined), 'skill improvement')
    register(this.viewer.definition(), () => this.registry.readyApps().some(ready => ready.app.skill !== undefined), 'skill view')

    const mrTools = createMrTools({
      requireV8: () => this.repos.requireV8(),
      workspacesRoot: () => this.mrWorkspacesDir,
      resolveForTool: (sessionId, repo, mrNumber) => {
        if (this.mrSupervisor === undefined) throw new Error('审微 MR 监管运行时尚未就绪')
        return this.mrSupervisor.resolveForTool(sessionId, repo, mrNumber)
      },
      updateRecord: (repo, mrNumber, updater) => {
        if (this.mrSupervisor === undefined) return Promise.reject(new Error('审微 MR 监管运行时尚未就绪'))
        return this.mrSupervisor.updateRecord(repo, mrNumber, updater)
      },
    })
    for (const tool of mrTools) {
      register(tool, context => this.mrSupervisor?.isMrSession(context.agent.session.header.id) === true, tool.name)
    }

    const logTools = createLogTools(this.logToolsRuntimeAdapter())
    for (const tool of logTools) {
      register(
        tool,
        context => this.logSupervisor?.isLogSession(context.agent.session.header.id) === true || hasApps(),
        tool.name,
      )
    }
  }

  private async offers(context: ToolActivationContext, condition: (context: ToolActivationContext) => boolean): Promise<boolean> {
    if (isDelegatedAgent(context.agent)) return false
    await abortable(this.booted.promise, context.signal)
    return this.active && condition(context)
  }

  private async prepareCatalog(signal: AbortSignal | undefined): Promise<void> {
    await abortable(this.booted.promise, signal)
    if (!this.active) return
    const limit = AbortSignal.timeout(this.refreshWaitMs)
    try {
      await abortable(this.registry.refresh(this.settings.get().fetchIntervalMs), signal === undefined ? limit : AbortSignal.any([signal, limit]))
    } catch (error) {
      if (signal?.aborted === true || !limit.aborted) throw error
      // The wait limit passed: render the catalog synced so far.
    }
  }

  /**
   * Open the supervision storage domain, load panel overlay & report records,
   * take configured repositories from `dsh-repo`, and sync every repository.
   */
  async boot(): Promise<void> {
    try {
      const domain = await this.supervisorDomain().catch((error: unknown) => {
        this.ctx.logger?.error?.('logalyze: 打开监管存储域失败：%s', messageOf(error))
        return undefined
      })
      await this.settings.load()
      if (domain !== undefined) {
        this.breakers = new CircuitBreakerRegistry({
          table: domain.circuitBreakers,
          resolvePolicy: (key) => {
            const mr = this.settings.get().mrReview
            const log = this.settings.get().logSupervision
            if (key.startsWith('mr-repo:')) return { windowMs: 60 * 60_000, limit: mr.repoHourlyTurnLimit, cooldownMs: 60 * 60_000 }
            if (key.startsWith('mr:')) return { windowMs: 24 * 60 * 60_000, limit: mr.dailyMrTurnLimit, cooldownMs: 24 * 60 * 60_000 }
            if (key.startsWith('mr-fix:')) return { windowMs: 365 * 24 * 60 * 60_000, limit: Math.max(1, mr.maxAutoFixAttempts), cooldownMs: 24 * 60 * 60_000 }
            if (key.startsWith('log:')) return { windowMs: 60 * 60_000, limit: log.appHourlyBatchLimit, cooldownMs: 60 * 60_000 }
            return undefined
          },
          now: this.clock,
          onError: (error) => { this.ctx.logger?.warn?.('logalyze: 熔断通知失败：%s', messageOf(error)) },
        })
        this.issueMemory = new IssueMemory(domain.issues)
        this.mrSupervisor = new MrSupervisor({
          table: domain.supervisedMrs,
          breakers: this.breakers,
          issues: domain.issues,
          repos: this.repos,
          mrPool: this.pools.mrPool,
          workspacesRoot: this.mrWorkspacesDir,
          sessionDriver: this.mrSessionDriver,
          getSettings: () => this.settings.get().mrReview,
          getMrRepos: () => this.registry.mrStatus(),
          now: this.clock,
          logger: this.ctx.logger,
          autoPollTimer: this.autoMrPollTimer,
        })
        this.logSupervisor = new LogSupervisor({
          watermarks: domain.watermarks,
          pendingBatches: domain.pendingBatches,
          logTasks: domain.logTasks,
          outbox: domain.outboxPlatform,
          issues: domain.issues,
          issueMemory: this.issueMemory,
          breakers: this.breakers,
          logPool: this.pools.logPool,
          platform: this.platform,
          registry: this.registry,
          repos: this.repos,
          workspacesRoot: this.logWorkspacesDir,
          sessionDriver: this.logSessionDriver,
          getSettings: () => this.settings.get().logSupervision,
          getPlatformSettings: () => this.settings.get().analyze.platform,
          getDownloadSettings: () => this.settings.get().download,
          getUploadSettings: () => this.settings.get().analyze.upload,
          getTopics: () => this.topicsService(),
          getActions: () => {
            const lookup = lookupActions(this.ctx.get?.(FEISHU_ACTIONS_SERVICE))
            return lookup.availability === 'ready' ? lookup.service : undefined
          },
          registerSelfMr: async (input) => {
            if (this.mrSupervisor === undefined) throw new Error('审微 MR 监管运行时尚未就绪')
            await this.mrSupervisor.registerSelfMr(input)
          },
          ...(this.fetchImpl === undefined ? {} : { fetch: this.fetchImpl }),
          now: this.clock,
          logger: this.ctx.logger,
          autoPollTimer: this.autoLogPollTimer,
        })
      }
      await this.reports.boot().catch((error: unknown) => {
        this.ctx.logger?.error?.('logalyze: 读取分析记录失败：%s', messageOf(error))
      })
      await this.legacy.load(Date.now()).catch((error: unknown) => {
        this.ctx.logger?.error?.('logalyze: 读取旧版回传记录失败：%s', messageOf(error))
      })
      await this.catalog.load()
      await this.mrSupervisor?.boot()
      await this.logSupervisor?.boot()
    } finally {
      this.booted.resolve()
    }
  }

  /** React to dsh-repo becoming available after boot or reloading. */
  async reposAvailable(): Promise<void> {
    await this.booted.promise
    if (!this.active) return
    await this.catalog.serviceAppeared()
    this.mrSupervisor?.notifyConfigOrReposChanged()
    this.logSupervisor?.notifyConfigOrReposChanged()
  }

  /** Register both features with dsh-repo and follow its catalog and host changes. */
  watchRepos(repos: DshRepos): () => void {
    return this.catalog.watch(repos)
  }

  /** Stop admission, drain pools and metadata writes/refreshes, and close the supervision storage domain. */
  async shutdown(): Promise<void> {
    this.active = false
    this.reports.shutdown()
    this.booted.resolve()
    await Promise.allSettled([
      this.logSupervisor?.drainAndClose(),
      this.mrSupervisor?.drainAndClose(),
      this.pools.drainAndClose({ cancelQueued: true, abortActive: true }),
      this.registry.close(),
    ])
    if (this.supervisorPromise !== undefined) {
      await this.supervisorPromise.then(domain => domain.close(), () => undefined)
    }
  }

  /** Check reports waiting for their first turn against `feishuTopics`; called whenever the service appears. */
  async topicsAvailable(): Promise<void> {
    await this.booted.promise
    if (!this.active) return
    await this.reports.reconcile()
    await this.logSupervisor?.onTopicsAvailable()
  }

  /** Accept one validated analyze request with idempotency protection. */
  async acceptAnalysis(topics: FeishuTopicService, request: AnalyzeRequest, key: string): Promise<AnalyzeResponse> {
    const pending = this.accepting.get(key)
    if (pending !== undefined) {
      await pending.catch(() => undefined)
      return await this.acceptAnalysis(topics, request, key)
    }
    const accepting = this.acceptOnce(topics, request, key)
    this.accepting.set(key, accepting)
    try {
      return await accepting
    } finally {
      this.accepting.delete(key)
    }
  }

  private async acceptOnce(topics: FeishuTopicService, request: AnalyzeRequest, key: string): Promise<AnalyzeResponse> {
    await this.booted.promise
    const settings = this.settings.get().analyze
    const fingerprint = analyzeRequestHash(request)
    const existing = this.reports.byKey(key)
    if (existing !== undefined) {
      if (existing.fingerprint !== fingerprint) return refused(409, 'Idempotency-Key 已被内容不同的请求使用')
      return analyzeResponseOf(await topics.launch(analysisTopicSpec(existing, settings.upload)))
    }
    const problem = platformProblem(settings.platform)
    if (problem !== undefined) return refused(503, problem)
    let found
    try {
      found = await this.platform.findLogs(request.logIds)
    } catch (error) {
      if (!(error instanceof PlatformError)) throw error
      return refused(error.retryable ? 503 : 502, error.message)
    }
    const batch = resolveBatch(request.logIds, found, this.registry.readyApps().map(ready => ready.app))
    if (!batch.ok) return { status: 422, body: { ok: false, error: batch.error, ...batch.invalidLogs === undefined ? {} : { invalidLogs: batch.invalidLogs } } }
    const record = newAnalysisRecord(request, key, fingerprint, batch.value, Date.now())
    await this.reports.accept(record)
    let response: AnalyzeResponse
    try {
      response = analyzeResponseOf(await topics.launch(analysisTopicSpec(record, settings.upload)))
    } catch (error) {
      await this.reports.forget(record.id)
      throw error
    }
    if (response.status === 202) await this.reports.launched(record.id)
    else await this.reports.forget(record.id)
    return response
  }

  private platformLogsOf(sessionId: string): ((ref: string) => PlatformLogRef) | undefined {
    const key = this.topicsService()?.launchKeyOf(sessionId)
    const record = key === undefined ? undefined : this.reports.byKey(key)
    if (record === undefined) return undefined
    return (ref) => {
      const log = record.logs.find(item => item.ref === ref)
      if (log === undefined) throw new Error(`本话题没有日志 ${ref}（可用：${record.logs.map(item => item.ref).join('、')}）`)
      return { ref: log.ref, logId: log.logId, fileName: log.fileName }
    }
  }

  /** Downloads platform logs through a fresh temporary link each time. */
  private platformDownloader(fetchImpl: typeof fetch | undefined): PlatformLogDownloader {
    return {
      download: async (log, dir, fileName, download, signal) => {
        let link
        try {
          link = await this.platform.downloadUrl(log.logId)
        } catch (error) {
          if (error instanceof PlatformError) throw new DownloadError(`日志 ${log.ref}：${error.message}`)
          throw error
        }
        const file = await downloadLog(link.url, dir, fileName, download, signal, fetchImpl, { admit: admitPlatformUrl, label: `日志 ${log.ref}（${log.fileName}）` })
        return file.path
      },
    }
  }

  /** Upload one analysis's reports again now. */
  async retryReport(raw: unknown): Promise<StateWire> {
    const parsed = reportRetrySchema.safeParse(raw)
    if (!parsed.success) throw new SettingsError(describeIssue(parsed.error))
    if (!this.reports.retry(parsed.data.id)) throw new SettingsError(`没有这次分析：${parsed.data.id}`)
    return await this.state()
  }

  /** The loaded `feishuTopics`, when compatible. */
  private topicsService(): FeishuTopicService | undefined {
    const lookup = lookupTopics(this.ctx.get?.(FEISHU_TOPICS_SERVICE))
    return lookup.availability === 'ready' ? lookup.service : undefined
  }

  /** @returns the panel state. */
  async state(): Promise<StateWire> {
    const [token, secret] = await Promise.all([this.token.status(), this.secret.status()])
    const problem = platformProblem(this.settings.get().analyze.platform)
    return {
      ...this.settings.panel(),
      repos: this.registry.status(),
      mrRepos: this.registry.mrStatus(),
      dshRepo: this.repos.panelState(),
      credentialsAvailable: this.token.available(),
      analyze: {
        route: ANALYZE_ROUTE,
        tokenEnv: this.token.ref,
        ...(token === undefined ? {} : { token }),
        secretEnv: this.secret.ref,
        ...(secret === undefined ? {} : { secret }),
        ...(problem === undefined ? {} : { platformProblem: problem }),
        topics: lookupTopics(this.ctx.get?.(FEISHU_TOPICS_SERVICE)).availability,
        actions: lookupActions(this.ctx.get?.(FEISHU_ACTIONS_SERVICE)).availability,
        reports: this.reports.list(),
        legacyReports: this.legacy.list(),
      },
      ...(this.mrSupervisor === undefined ? {} : { mrSupervision: this.mrSupervisor.panelState() }),
      ...(this.logSupervisor === undefined ? {} : { logSupervision: this.logSupervisor.panelState() }),
    }
  }

  /** @returns the analyze route's switch, limits, and bearer token, read per request. */
  analyzeGate(): AnalyzeGate {
    return {
      enabled: () => this.settings.get().analyze.enabled,
      tokenEnv: () => this.token.ref,
      defaultChatId: () => this.settings.get().analyze.defaultChatId,
      maxLogs: () => this.settings.get().analyze.maxLogs,
      token: () => this.token.value(),
    }
  }

  /** Store the analyze API's bearer token or the platform client secret in DSH's credential store. */
  async setToken(raw: unknown): Promise<StateWire> {
    await this.credentialOf(raw).set(raw)
    this.platform.reset()
    return await this.state()
  }

  /** Remove a stored credential. */
  async clearToken(raw: unknown): Promise<StateWire> {
    await this.credentialOf(raw).clear(raw)
    this.platform.reset()
    return await this.state()
  }

  /** The credential a token route body names. */
  private credentialOf(raw: unknown): StoredCredential {
    const parsed = credentialNameSchema.safeParse(raw)
    if (!parsed.success) throw new SettingsError(describeIssue(parsed.error))
    const slot = [this.token, this.secret].find(candidate => candidate.ref === parsed.data.tokenEnv)
    if (slot === undefined) throw new SettingsError(`${parsed.data.tokenEnv} 不是观象管理的凭据名称`)
    return slot
  }

  /** Validate and persist a complete settings payload from the panel. */
  async save(raw: unknown): Promise<StateWire> {
    await this.settings.save(raw)
    this.mrSupervisor?.notifyConfigOrReposChanged()
    this.logSupervisor?.notifyConfigOrReposChanged()
    return await this.state()
  }

  /** Remove every panel override. */
  async reset(): Promise<StateWire> {
    await this.settings.reset()
    this.mrSupervisor?.notifyConfigOrReposChanged()
    this.logSupervisor?.notifyConfigOrReposChanged()
    return await this.state()
  }

  /** Reset a supervision circuit breaker and resume blocked work. */
  async resetBreaker(raw: unknown): Promise<StateWire> {
    await this.prepared()
    const parsed = breakerResetSchema.safeParse(raw)
    if (!parsed.success) throw new SettingsError(describeIssue(parsed.error))
    if (parsed.data.scope === 'log-app') {
      await this.logSupervisor?.resetBreaker(parsed.data.key)
    } else {
      await this.mrSupervisor?.resetBreaker(parsed.data.scope, parsed.data.key)
    }
    return await this.state()
  }

  /** Pause, resume, or rewind the automatic log-platform polling watermark. */
  async controlLogWatermark(raw: unknown): Promise<StateWire> {
    await this.prepared()
    if (this.logSupervisor === undefined) throw new SettingsError('观象日志监管运行时尚未就绪')
    try {
      await this.logSupervisor.controlWatermark(raw)
    } catch (error) {
      throw new SettingsError(messageOf(error))
    }
    return await this.state()
  }

  /** Retry one dead-letter outbox entry or all dead-letter entries immediately. */
  async retryOutboxDead(raw: unknown): Promise<StateWire> {
    await this.prepared()
    if (this.logSupervisor === undefined) throw new SettingsError('观象日志监管运行时尚未就绪')
    const parsed = z.object({ key: z.string().trim().min(1).optional() }).strict().safeParse(raw)
    if (!parsed.success) throw new SettingsError(describeIssue(parsed.error))
    try {
      await this.logSupervisor.retryOutboxDead(parsed.data.key)
    } catch (error) {
      throw new SettingsError(messageOf(error))
    }
    return await this.state()
  }

  /** Access the active MR supervision coordinator (for tests and internal integrations). */
  mrSupervisorInstance(): MrSupervisor | undefined {
    return this.mrSupervisor
  }

  /** Access the active log supervision coordinator (for tests and internal integrations). */
  logSupervisorInstance(): LogSupervisor | undefined {
    return this.logSupervisor
  }

  /** Save only application metadata; catalog membership is checked on each write. */
  async saveApplication(raw: unknown): Promise<StateWire> {
    await this.prepared()
    await this.registry.saveApplication(raw)
    return await this.state()
  }

  private async prepared(): Promise<void> {
    await this.booted.promise
    if (!this.active) throw new Error('智能监管已停止，不能准备新的应用任务')
  }

  private onRegistryChange(): void {
    if (!this.active) return
    this.skill.invalidate()
    this.logSupervisor?.notifyConfigOrReposChanged()
  }

  private logToolsRuntimeAdapter(): LogToolsRuntime {
    const requireSup = (): LogToolsRuntime => {
      if (this.logSupervisor === undefined) {
        throw new Error('观象日志监管运行时尚未就绪')
      }
      return this.logSupervisor.toolsRuntime()
    }
    return {
      resolveApp: appOrAlias => this.registry.resolve(appOrAlias),
      readyApp: appId => this.registry.readyApp(appId),
      requireRepos: () => this.repos.require(),
      downloadSettings: () => this.settings.get().download,
      uploadSettings: () => this.settings.get().analyze.upload,
      maxUnpackBytes: () => this.settings.get().logSupervision.maxUnpackBytes,
      issueMemory: () => requireSup().issueMemory(),
      ...(this.fetchImpl === undefined ? {} : { fetch: this.fetchImpl }),
      platformDownload: (log, dir, fileName, download, signal) =>
        requireSup().platformDownload(log, dir, fileName, download, signal),
      resolveTaskForSession: (sessionId, taskId) =>
        requireSup().resolveTaskForSession(sessionId, taskId),
      createFeishuTask: input => requireSup().createFeishuTask(input),
      updateTask: (taskId, updater) => requireSup().updateTask(taskId, updater),
      onRevisionSubmitted: params => requireSup().onRevisionSubmitted(params),
      registerSelfMr: async (input) => { await requireSup().registerSelfMr?.(input) },
      logWorkspacesRoot: () => this.logWorkspacesDir,
      now: () => this.clock(),
    }
  }
}
