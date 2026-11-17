/**
 * 智能监管中心（观象 + 审微）运行时的组装：
 * - 共享监管运行时（`dsh_supervisor` 存储域与 `logPool` / `mrPool` 并发隔离池）；
 * - 生效设置、应用注册表与仓库清单跟随（同时注册 `log-analysis` 与 `mr-review` 功能开关）；
 * - 入口 SKILL、分析派发及旧版 SKILL 工具注册；
 * - 日志平台客户端（client_secret 存在 DSH 凭据库）与已下线分析接口留下的话题的报告回传；
 * - Web 设置面板状态与写入口。
 *
 * @module dsh-supervisor/service
 */

import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { z } from 'zod'
import { SUPERVISOR_APPLICATIONS_SERVICE } from './apps/access.ts'
import type { ApplicationAccess } from './apps/access.ts'
import { CatalogFollower } from './apps/catalog.ts'
import { RepoRegistry } from './apps/registry.ts'
import type { SupervisorConfig } from './config.ts'
import { describeIssue } from './config.ts'
import { FEISHU_ACTIONS_SERVICE, lookupActions } from './deps/actions.ts'
import { FEISHU_BITABLE_SERVICE, lookupBitable } from './deps/bitable.ts'
import { DSH_REPOS_SERVICE, ReposClient } from './deps/repos.ts'
import type { DshRepos } from './deps/repos-contract.ts'
import { FEISHU_TOPICS_STATUS_EVENT } from './deps/topics-contract.ts'
import type { FeishuTopicService } from './deps/topics-contract.ts'
import { FEISHU_TOPICS_SERVICE, lookupTopics } from './deps/topics.ts'
import { Dispatcher } from './dispatch/tool.ts'
import type { HostContext, HostCredentials, ToolActivationContext, ToolDefinition, WorkingDirectoryService } from './host.ts'
import { SkillViewer } from './improve/show.ts'
import { SkillImprover } from './improve/tool.ts'
import { IssueBitableSyncer } from './issues/bitable-sync.ts'
import { IssueMemory } from './issues/memory.ts'
import { LogSupervisor, createHostLogSessionDriver, createLogTools } from './log/index.ts'
import type { LogSessionDriver, LogToolsRuntime } from './log/index.ts'
import { MrSupervisor, createHostMrSessionDriver, createMrTools } from './mr/index.ts'
import type { MrSessionDriver } from './mr/index.ts'
import { PlatformClient, PlatformError, platformProblem } from './platform/client.ts'
import { StoredCredential } from './platform/credential.ts'
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
import type { StateWire } from './settings/contract.ts'
import { SettingsController, SettingsError } from './settings/controller.ts'
import { defaultLegacyDataDir, defaultSupervisorDataDir, migrateLegacyData } from './settings/legacy-migration.ts'
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

const bitableCheckSchema = z.object({
  bitableUrl: z.string().max(2048, '飞书多维表格地址过长').optional(),
  table: z.string().max(200, '数据表名称或 ID 最多 200 个字符').optional(),
}).strict()

/** Optional seams for tests. */
export interface ServiceOptions {
  /** Fetch used for log downloads and the log platform. */
  readonly fetch?: typeof fetch
  /** Analysis record directory; defaults to `$DSH_HOME/supervisor/analyses`. */
  readonly analysesDir?: string
  /** Directory of the former report records; defaults to `$DSH_HOME/supervisor/reports`. */
  readonly legacyReportsDir?: string
  /** Optional legacy `$DSH_HOME/logalyze` directory to migrate from; `null` disables automatic migration. */
  readonly legacyDataDir?: string | null
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
  /** Disable background Bitable issue sync interval timer in tests (`syncIssuesNow()` drives manually). */
  readonly autoIssueSyncTimer?: boolean
  /** Override Bitable push debounce window after AI issue writes in ms (primarily for tests). */
  readonly issueSyncDebounceMs?: number
}

/** Package files the service serves. */
export interface ServiceAssets {
  /** Bundled guide skills (`/supervisor-kit`, `/supervisor-improve`, `/mr-reviewer`, `/log-supervisor`). */
  readonly bundled: readonly BundledSkill[]
}

/** The plugin's long-lived state. */
export class SupervisorService {
  readonly registry: RepoRegistry
  readonly pools: SupervisionPools
  private readonly settings: SettingsController
  private readonly repos: ReposClient
  private readonly catalog: CatalogFollower
  private readonly secret: StoredCredential
  private readonly platform: PlatformClient
  private readonly legacy: LegacyReports
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
  private readonly autoIssueSyncTimer: boolean
  private readonly issueSyncDebounceMs: number | undefined
  private readonly hostMrDriver: ReturnType<typeof createHostMrSessionDriver> | undefined
  private readonly mrSessionDriver: MrSessionDriver
  private readonly hostLogDriver: ReturnType<typeof createHostLogSessionDriver> | undefined
  private readonly logSessionDriver: LogSessionDriver
  private readonly fetchImpl: typeof fetch | undefined
  private breakers: CircuitBreakerRegistry | undefined
  private issueMemory: IssueMemory | undefined
  private issueSyncer: IssueBitableSyncer | undefined
  private mrSupervisor: MrSupervisor | undefined
  private logSupervisor: LogSupervisor | undefined
  private supervisorPromise: Promise<SupervisorDomain> | undefined
  private migrationPromise: Promise<void> | undefined
  private settingsLoadPromise: Promise<void> | undefined
  private readonly legacyDataDir: string | undefined
  private readonly nestedLegacySupervisorDir: string | undefined
  private readonly overlayPath: string
  private readonly applicationsPath: string
  private readonly analysesDir: string
  private readonly legacyReportsDir: string
  private readonly warnFn: (message: string) => void
  private active = true
  private readonly refreshWaitMs: number
  private readonly subagentProvider: string
  private readonly subagentMaxDepth: number | 'provider-managed'
  private readonly autoInvoke: boolean
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
    config: SupervisorConfig,
    store: OverlayStore,
    assets: ServiceAssets,
    options: ServiceOptions = {},
  ) {
    const warn = (message: string): void => { ctx.logger?.warn?.(message) }
    this.warnFn = warn
    const settings = (): ReturnType<SettingsController['get']> => this.settings.get()
    const workingDirectory = (): WorkingDirectoryService | undefined => ctx.get?.('workingDirectory') as WorkingDirectoryService | undefined
    const fetchSeam = options.fetch === undefined ? {} : { fetch: options.fetch }
    const dataDir = dirname(store.path)
    const isDefaultDataDir = resolve(dataDir) === resolve(defaultSupervisorDataDir())
    this.overlayPath = store.path
    this.applicationsPath = join(dataDir, 'applications.json')
    this.legacyDataDir = options.legacyDataDir !== undefined
      ? (options.legacyDataDir ?? undefined)
      : (isDefaultDataDir ? defaultLegacyDataDir() : undefined)
    this.nestedLegacySupervisorDir = options.supervisorDir === undefined ? join(dataDir, 'supervisor') : undefined
    this.supervisorDir = options.supervisorDir ?? join(dataDir, 'domain')
    this.mrWorkspacesDir = options.mrWorkspacesDir ?? join(dataDir, 'mr-workspaces')
    this.logWorkspacesDir = options.logWorkspacesDir ?? join(dataDir, 'log-workspaces')
    this.analysesDir = options.analysesDir ?? (isDefaultDataDir ? defaultAnalysesDir() : join(dataDir, 'analyses'))
    this.legacyReportsDir = options.legacyReportsDir ?? (isDefaultDataDir ? legacyReportsDir() : join(dataDir, 'reports'))
    this.clock = options.now ?? Date.now
    this.autoMrPollTimer = options.autoMrPollTimer ?? true
    this.autoLogPollTimer = options.autoLogPollTimer ?? true
    this.autoIssueSyncTimer = options.autoIssueSyncTimer ?? true
    this.issueSyncDebounceMs = options.issueSyncDebounceMs
    this.hostMrDriver = options.mrSessionDriver === undefined ? createHostMrSessionDriver(ctx) : undefined
    this.mrSessionDriver = options.mrSessionDriver ?? this.hostMrDriver!
    this.hostLogDriver = options.logSessionDriver === undefined ? createHostLogSessionDriver(ctx) : undefined
    this.logSessionDriver = options.logSessionDriver ?? this.hostLogDriver!
    this.fetchImpl = options.fetch
    this.pools = createSupervisionPools()
    this.settings = new SettingsController(config, store, warn)
    this.refreshWaitMs = config.refreshWaitMs
    this.subagentProvider = config.subagentProvider
    this.subagentMaxDepth = config.subagentMaxDepth
    this.autoInvoke = config.autoInvoke
    this.repos = new ReposClient(() => ctx.get?.(DSH_REPOS_SERVICE))
    const credentials = (): HostCredentials | undefined => ctx.get?.('credentials') as HostCredentials | undefined
    const legacySecretRef = config.platformSecretRef === 'SUPERVISOR_PLATFORM_CLIENT_SECRET' ? 'LOGALYZE_PLATFORM_CLIENT_SECRET' : undefined
    this.secret = new StoredCredential(config.platformSecretRef, '日志平台 client_secret', credentials, warn, legacySecretRef)
    this.platform = new PlatformClient({ settings: () => this.settings.get().analyze.platform, secret: () => this.secret.value(), now: this.clock, ...fetchSeam })
    this.legacy = new LegacyReports(this.legacyReportsDir, warn)
    this.registry = new RepoRegistry({
      repos: this.repos,
      applications: new ApplicationSettings(this.applicationsPath),
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
    const children = { registry: this.registry, subagents: ctx.subagents, provider: config.subagentProvider, maxDepth: config.subagentMaxDepth, settings, workingDirectory, ...fetchSeam }
    this.improver = new SkillImprover({ ...children, repos: this.repos })
    this.viewer = new SkillViewer({ registry: this.registry, repos: this.repos })
    this.dispatcher = new Dispatcher({ ...children, gaps: this.improver, platformLogs: sessionId => this.platformLogsOf(sessionId), platform: this.platformDownloader(options.fetch) })
    this.reports = new ReportTracker({
      store: new AnalysisStore(this.analysesDir, warn),
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

  private ensureMigrated(): Promise<void> {
    this.migrationPromise ??= migrateLegacyData({
      legacyDataDir: this.legacyDataDir,
      overlayPath: this.overlayPath,
      applicationsPath: this.applicationsPath,
      supervisorDir: this.supervisorDir,
      nestedLegacySupervisorDir: this.nestedLegacySupervisorDir,
      analysesDir: this.analysesDir,
      legacyReportsDir: this.legacyReportsDir,
      warn: this.warnFn,
    })
    return this.migrationPromise
  }

  private ensureSettingsLoaded(): Promise<void> {
    this.settingsLoadPromise ??= this.ensureMigrated().then(() => this.settings.load())
    return this.settingsLoadPromise
  }

  /** Open or return the initialized `dsh_supervisor` storage domain. */
  supervisorDomain(): Promise<SupervisorDomain> {
    this.supervisorPromise ??= this.ensureMigrated().then(() => openSupervisorDomain({
      ctx: this.ctx,
      fallbackDir: this.supervisorDir,
      now: this.clock,
    }))
    return this.supervisorPromise
  }

  /** Register the entry skill provider and `supervisorApplications` service; called once from `apply()`. */
  registerSkill(): void {
    if (typeof this.ctx.provide === 'function') {
      const access: ApplicationAccess = {
        list: async () => { await this.prepared(); return this.registry.readyApps() },
        resolve: async name => { await this.prepared(); return this.registry.resolve(name) },
        acquire: async ids => { await this.prepared(); return this.registry.acquire(ids) },
      }
      this.ctx.effect(() => this.ctx.provide?.(SUPERVISOR_APPLICATIONS_SERVICE, access), 'supervisor: application access')
    }
    this.ctx.effect(() => this.ctx.skills.registerProvider(this.skill.factory), 'supervisor: entry skill')
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
      this.ctx.effect(() => this.ctx.tools.register(definition, { when: context => this.offers(context, condition) }), `supervisor: ${label} tool`)
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
      await this.ensureSettingsLoaded()
      const domain = await this.supervisorDomain().catch((error: unknown) => {
        this.ctx.logger?.error?.('supervisor: 打开监管存储域失败：%s', messageOf(error))
        return undefined
      })
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
          onError: (error) => { this.ctx.logger?.warn?.('supervisor: 熔断通知失败：%s', messageOf(error)) },
        })
        this.issueMemory = new IssueMemory(domain.issues)
        this.issueSyncer = new IssueBitableSyncer({
          issues: domain.issues,
          getSettings: () => this.settings.get().issueSync,
          getBitable: () => lookupBitable(this.ctx.get?.(FEISHU_BITABLE_SERVICE)),
          now: this.clock,
          logger: this.ctx.logger,
          autoSyncTimer: this.autoIssueSyncTimer,
          ...(this.issueSyncDebounceMs === undefined ? {} : { aiMutateDebounceMs: this.issueSyncDebounceMs }),
        })
        this.mrSupervisor = new MrSupervisor({
          table: domain.supervisedMrs,
          breakers: this.breakers,
          issues: domain.issues,
          repos: this.repos,
          mrPool: this.pools.mrPool,
          workspacesRoot: this.mrWorkspacesDir,
          ...(this.legacyDataDir === undefined ? {} : { legacyWorkspacesRoot: join(this.legacyDataDir, 'mr-workspaces') }),
          sessionDriver: this.mrSessionDriver,
          getSettings: () => this.settings.get().mrReview,
          getMrRepos: () => this.registry.mrStatus(),
          notifyHuman: async (input) => {
            const chatId = this.settings.get().mrReview.feishuChatId
            const topics = this.topicsService()
            if (chatId === undefined || topics === undefined) return
            const bucket = Math.floor(this.clock() / (60 * 60_000))
            const digest = createHash('sha256')
              .update(`${input.repo}#${input.mrNumber ?? 0}:${bucket}:${input.text}`)
              .digest('hex')
              .slice(0, 24)
            const key = `mr-alert:${digest}`
            const targetLabel = input.mrNumber === undefined ? input.repo : `${input.repo} #${input.mrNumber}`
            await topics.launch({
              key,
              fingerprint: key,
              chatId,
              requester: { kind: 'external', label: '审微告警' },
              card: {
                title: `审微告警：${targetLabel}`,
                taskName: '告警',
                lead: [{ text: input.text }],
              },
              prompt: `${input.text}\n\n请向值班研发同步该 MR 监管状态，等待人工处理后再恢复；不要自动修改或强推代码。`,
            }).catch((error: unknown) => {
              this.ctx.logger?.warn?.('supervisor: 审微飞书告警发送失败：%s', messageOf(error))
            })
          },
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
          supervisedMrs: domain.supervisedMrs,
          issueMemory: this.issueMemory,
          breakers: this.breakers,
          logPool: this.pools.logPool,
          platform: this.platform,
          registry: this.registry,
          repos: this.repos,
          workspacesRoot: this.logWorkspacesDir,
          ...(this.legacyDataDir === undefined ? {} : { legacyWorkspacesRoot: join(this.legacyDataDir, 'log-workspaces') }),
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
        this.ctx.logger?.error?.('supervisor: 读取分析记录失败：%s', messageOf(error))
      })
      await this.legacy.load(this.clock()).catch((error: unknown) => {
        this.ctx.logger?.error?.('supervisor: 读取旧版回传记录失败：%s', messageOf(error))
      })
      await this.catalog.load()
      this.issueSyncer?.boot()
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
      this.issueSyncer?.drainAndClose(),
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

  /** Retry deferred follow-up action cards whenever `feishuActions` appears or reloads. */
  async actionsAvailable(): Promise<void> {
    await this.booted.promise
    if (!this.active) return
    await this.logSupervisor?.onActionsAvailable()
  }

  /** Re-subscribe and schedule pending Bitable sync whenever `feishuBitable` appears or reloads. */
  async bitableAvailable(): Promise<void> {
    await this.booted.promise
    if (!this.active) return
    this.issueSyncer?.notifyServiceChanged()
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
    await this.prepared()
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
    await this.ensureSettingsLoaded()
    const secret = await this.secret.status()
    const problem = platformProblem(this.settings.get().analyze.platform)
    return {
      ...this.settings.panel(),
      repos: this.registry.status(),
      mrRepos: this.registry.mrStatus(),
      dshRepo: this.repos.panelState(),
      credentialsAvailable: this.secret.available(),
      analyze: {
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
      ...(this.issueSyncer === undefined ? {} : { issues: this.issueSyncer.panelState() }),
      runtime: {
        platformSecretRef: this.secret.ref,
        subagentProvider: this.subagentProvider,
        subagentMaxDepth: this.subagentMaxDepth,
        refreshWaitMs: this.refreshWaitMs,
        autoInvoke: this.autoInvoke,
      },
    }
  }

  /** Store the platform client secret in DSH's credential store. */
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
    if (parsed.data.tokenEnv !== this.secret.ref) throw new SettingsError(`${parsed.data.tokenEnv} 不是观象管理的凭据名称`)
    return this.secret
  }

  /** Validate and persist a complete settings payload from the panel. */
  async save(raw: unknown): Promise<StateWire> {
    await this.ensureSettingsLoaded()
    await this.settings.save(raw)
    this.mrSupervisor?.notifyConfigOrReposChanged()
    this.logSupervisor?.notifyConfigOrReposChanged()
    this.issueSyncer?.notifyConfigChanged()
    return await this.state()
  }

  /** Remove every panel override. */
  async reset(): Promise<StateWire> {
    await this.ensureSettingsLoaded()
    await this.settings.reset()
    this.mrSupervisor?.notifyConfigOrReposChanged()
    this.logSupervisor?.notifyConfigOrReposChanged()
    this.issueSyncer?.notifyConfigChanged()
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

  /** Manually run one two-way synchronization pass between IssueMemory and Feishu Bitable. */
  async syncIssuesNow(): Promise<StateWire> {
    await this.prepared()
    if (this.issueSyncer === undefined) throw new SettingsError('已知问题库同步运行时尚未就绪')
    const outcome = await this.issueSyncer.syncNow()
    if (!outcome.ok) {
      throw new SettingsError(outcome.error ?? '飞书多维表格同步失败')
    }
    return await this.state()
  }

  /** Inspect a Feishu Bitable table schema and store the field-mapping diagnostic report. */
  async checkIssuesBitable(raw: unknown): Promise<StateWire> {
    await this.prepared()
    if (this.issueSyncer === undefined) throw new SettingsError('已知问题库同步运行时尚未就绪')
    const parsed = bitableCheckSchema.safeParse(raw ?? {})
    if (!parsed.success) throw new SettingsError(describeIssue(parsed.error))
    await this.issueSyncer.checkFieldMapping(parsed.data)
    return await this.state()
  }

  /** Access the active Bitable issue syncer (for tests). */
  issueSyncerInstance(): IssueBitableSyncer | undefined {
    return this.issueSyncer
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
      listPlatformLogs: params => requireSup().listPlatformLogs(params),
      platformDownload: (log, dir, fileName, download, signal) =>
        requireSup().platformDownload(log, dir, fileName, download, signal),
      resolveTaskForSession: (sessionId, taskId) =>
        requireSup().resolveTaskForSession(sessionId, taskId),
      withSessionOperation: (sessionId, fn) =>
        requireSup().withSessionOperation(sessionId, fn),
      createFeishuTask: input => requireSup().createFeishuTask(input),
      discardFeishuTask: input => requireSup().discardFeishuTask(input),
      updateTask: (taskId, updater) => requireSup().updateTask(taskId, updater),
      withTaskOperation: (taskId, fn) => requireSup().withTaskOperation(taskId, fn),
      onRevisionSubmitted: params => requireSup().onRevisionSubmitted(params),
      registerSelfMr: async (input) => { await requireSup().registerSelfMr?.(input) },
      logWorkspacesRoot: () => this.logWorkspacesDir,
      now: () => this.clock(),
    }
  }
}
