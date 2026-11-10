/**
 * 观象运行时的组装：生效设置、应用注册表与仓库清单跟随、入口 SKILL、五个
 * 工具的注册条件、分析接口令牌和分析报告回传，并为设置面板提供状态与写入口。
 *
 * @module dsh-logalyze/service
 */

import { AnalyzeToken } from './analyze/token.ts'
import type { AnalyzeGate } from './analyze/server.ts'
import type { AnalyzeRequest } from './analyze/contract.ts'
import { CatalogFollower } from './apps/catalog.ts'
import { RepoRegistry } from './apps/registry.ts'
import type { LogalyzeConfig } from './config.ts'
import { describeIssue } from './config.ts'
import { DSH_REPOS_SERVICE, ReposClient } from './deps/repos.ts'
import type { DshRepos } from './deps/repos-contract.ts'
import { FEISHU_TOPICS_STATUS_EVENT } from './deps/topics-contract.ts'
import { FEISHU_TOPICS_SERVICE, lookupTopics, topicStatesOf } from './deps/topics.ts'
import type { TopicStates } from './deps/topics.ts'
import { Dispatcher } from './dispatch/tool.ts'
import type { HostContext, HostCredentials, ToolActivationContext, ToolDefinition, WorkingDirectoryService } from './host.ts'
import { SkillViewer } from './improve/show.ts'
import { SkillImprover } from './improve/tool.ts'
import { RepoInitializer } from './onboard/init.ts'
import type { CommandRunner } from './report/command.ts'
import { defaultReportsDir, ReportStore } from './report/store.ts'
import { ReportTracker } from './report/tracker.ts'
import { inRunDirectory, isDelegatedAgent, isInside } from './runs/run-dir.ts'
import { ANALYZE_ROUTE } from './settings/contract.ts'
import type { StateWire } from './settings/contract.ts'
import { SettingsController, SettingsError } from './settings/controller.ts'
import type { OverlayStore } from './settings/overlay.ts'
import type { BundledSkill } from './skill/bundled.ts'
import { createEntrySkillProvider } from './skill/entry.ts'
import { abortable } from './util/abort.ts'
import { messageOf } from './util/errors.ts'
import { z } from 'zod'

const reportRetrySchema = z.object({ id: z.string().regex(/^[0-9a-f]{24}$/u, '报告 id 不合法') }).strict()

/** Optional seams for tests. */
export interface ServiceOptions {
  readonly fetch?: typeof fetch
  /** Report record directory; defaults to `$DSH_HOME/logalyze/reports`. */
  readonly reportsDir?: string
  /** Runs the upload command. */
  readonly runCommand?: CommandRunner
}

/** Package files the service serves. */
export interface ServiceAssets {
  /** Bundled guide skills (`/logalyze-kit`, `/logalyze-improve`). */
  readonly bundled: readonly BundledSkill[]
}

/** The plugin's long-lived state. */
export class LogalyzeService {
  readonly registry: RepoRegistry
  private readonly settings: SettingsController
  private readonly repos: ReposClient
  private readonly catalog: CatalogFollower
  private readonly token: AnalyzeToken
  private readonly dispatcher: Dispatcher
  private readonly improver: SkillImprover
  private readonly viewer: SkillViewer
  private readonly initializer: RepoInitializer
  private readonly skill: ReturnType<typeof createEntrySkillProvider>
  private readonly reports: ReportTracker
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
    this.settings = new SettingsController(config, store, warn)
    this.refreshWaitMs = config.refreshWaitMs
    this.repos = new ReposClient(() => ctx.get?.(DSH_REPOS_SERVICE))
    this.token = new AnalyzeToken(config.analyzeTokenRef, () => ctx.get?.('credentials') as HostCredentials | undefined, warn)
    this.registry = new RepoRegistry({ repos: this.repos, onChange: () => { this.onRegistryChange() } })
    this.catalog = new CatalogFollower({
      registry: this.registry,
      repos: this.repos,
      active: () => this.active,
      error: (message) => { ctx.logger?.error?.(message) },
    })
    const children = { registry: this.registry, subagents: ctx.subagents, provider: config.subagentProvider, settings, workingDirectory, ...fetchSeam }
    this.improver = new SkillImprover({ ...children, repos: this.repos })
    this.viewer = new SkillViewer({ registry: this.registry, repos: this.repos })
    this.dispatcher = new Dispatcher({ ...children, gaps: this.improver })
    this.initializer = new RepoInitializer({ ...children, repos: this.repos })
    this.reports = new ReportTracker({
      store: new ReportStore(options.reportsDir ?? defaultReportsDir(), warn),
      topics: () => this.reportTopics(),
      upload: () => this.settings.get().analyze.upload,
      warn,
      ...options.runCommand === undefined ? {} : { run: options.runCommand },
    })
    this.skill = createEntrySkillProvider({
      prepare: signal => this.prepareCatalog(signal),
      apps: () => this.registry.readyApps().map(ready => ready.app),
      setupPending: () => this.registry.setupPending(),
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

  /** Register the entry skill provider; called once from `apply()`. */
  registerSkill(): void {
    this.ctx.effect(() => this.ctx.skills.registerProvider(this.skill.factory), 'logalyze: entry skill')
  }

  /**
   * Register the five tools and the Session listeners they need; called once
   * from `apply()`. The definitions stay fixed because a step drops a tool
   * whose registration changed after the step resolved its tools. The
   * improvement tool counts finished turns from `turn/end` Session events.
   */
  registerTools(): void {
    this.ctx.on('session/event', (session, event) => {
      if (event.type === 'turn/end') this.improver.turnEnded(session.header.id)
      this.reports.sessionEvent(session, event)
    })
    this.ctx.on(FEISHU_TOPICS_STATUS_EVENT, (state) => { this.reports.statusChanged(state) })
    const hasApps = (): boolean => this.registry.readyApps().length > 0
    const register = <V>(definition: ToolDefinition<V>, condition: (context: ToolActivationContext) => boolean, label: string): void => {
      this.ctx.effect(() => this.ctx.tools.register(definition, { when: context => this.offers(context, condition) }), `logalyze: ${label} tool`)
    }
    register(this.dispatcher.definition(), hasApps, 'dispatch')
    register(this.improver.definition(), () => this.settings.get().skillUpdates.enabled && this.registry.readyApps().some(ready => ready.writable), 'skill improvement')
    register(this.viewer.definition(), hasApps, 'skill view')
    register(this.initializer.initDefinition(), () => this.registry.setupPending().length > 0, 'draft repository setup')
    register(this.initializer.submitDefinition(), context => this.initializer.hasDraft(context.agent.session.header.id), 'submit repository setup')
  }

  /**
   * Offer a tool to top-level agents once the first sync settled and the
   * tool's own condition holds.
   * @param context - the preparing step.
   * @param condition - the tool's condition, read after the first sync.
   * @returns whether the step may call the tool.
   */
  private async offers(context: ToolActivationContext, condition: (context: ToolActivationContext) => boolean): Promise<boolean> {
    if (isDelegatedAgent(context.agent)) return false
    await abortable(this.booted.promise, context.signal)
    return this.active && condition(context)
  }

  /**
   * Wait for the first sync, then sync the repositories older than
   * `fetchIntervalMs`, waiting at most `refreshWaitMs` for them; a refresh
   * still running then finishes in the background.
   * @param signal - entry skill load cancellation.
   * @throws the signal's reason when the load is cancelled.
   */
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
   * Load the panel overlay and the report records, take the application
   * repositories from the dsh-repo catalog, and sync every repository.
   * @returns when the first sync round settled.
   */
  async boot(): Promise<void> {
    try {
      await this.settings.load()
      await this.reports.boot().catch((error: unknown) => {
        this.ctx.logger?.error?.('logalyze: 读取回传记录失败：%s', messageOf(error))
      })
      await this.catalog.load()
    } finally {
      this.booted.resolve()
    }
  }

  /**
   * React to dsh-repo becoming available after boot or reloading.
   * @returns when the syncs settled.
   */
  async reposAvailable(): Promise<void> {
    await this.booted.promise
    if (!this.active) return
    await this.catalog.serviceAppeared()
  }

  /**
   * Register the log analysis feature with dsh-repo and follow its catalog and host changes.
   * @param repos - the `dshRepos` service.
   * @returns disposer that withdraws the feature and stops watching.
   */
  watchRepos(repos: DshRepos): () => void {
    return this.catalog.watch(repos)
  }

  /** Stop registering tools and retrying uploads; in-flight syncs and uploads finish without side effects on the host. */
  shutdown(): void {
    this.active = false
    this.reports.shutdown()
    this.booted.resolve()
  }

  /**
   * Check reports waiting for their first turn against `feishuTopics`; called
   * whenever the service appears.
   * @returns when the check settled.
   */
  async topicsAvailable(): Promise<void> {
    await this.booted.promise
    if (!this.active) return
    await this.reports.reconcile()
  }

  /**
   * Start tracking the report of an accepted analyze request with `logId`.
   * @param request - the validated request.
   * @param key - its `Idempotency-Key`.
   */
  async trackReport(request: AnalyzeRequest & { readonly logId: string }, key: string): Promise<void> {
    await this.booted.promise
    await this.reports.track(request, key)
  }

  /**
   * Upload one report again now.
   * @param raw - request body `{ id }`.
   * @returns the new panel state.
   * @throws SettingsError when the body is invalid or the report is unknown.
   */
  async retryReport(raw: unknown): Promise<StateWire> {
    const parsed = reportRetrySchema.safeParse(raw)
    if (!parsed.success) throw new SettingsError(describeIssue(parsed.error))
    if (!this.reports.retry(parsed.data.id)) throw new SettingsError(`没有这份报告：${parsed.data.id}`)
    return await this.state()
  }

  /** The launch-state methods of the loaded `feishuTopics`. */
  private reportTopics(): TopicStates | undefined {
    return topicStatesOf(lookupTopics(this.ctx.get?.(FEISHU_TOPICS_SERVICE)))
  }

  /** @returns the panel state. */
  async state(): Promise<StateWire> {
    const token = await this.token.status()
    return {
      ...this.settings.panel(),
      repos: this.registry.status(),
      dshRepo: this.repos.panelState(),
      credentialsAvailable: this.token.available(),
      analyze: {
        route: ANALYZE_ROUTE,
        tokenEnv: this.token.ref,
        ...token === undefined ? {} : { token },
        topics: lookupTopics(this.ctx.get?.(FEISHU_TOPICS_SERVICE)).availability,
        reportsSupported: this.reportTopics() !== undefined,
        reports: this.reports.list(),
      },
    }
  }

  /** @returns the analyze route's switch and bearer token, read per request. */
  analyzeGate(): AnalyzeGate {
    return {
      enabled: () => this.settings.get().analyze.enabled,
      tokenEnv: () => this.token.ref,
      defaultChatId: () => this.settings.get().analyze.defaultChatId,
      token: () => this.token.value(),
    }
  }

  /**
   * Store the analyze API's bearer token in DSH's credential store.
   * @param raw - request body `{ tokenEnv, value }`.
   * @returns the new panel state.
   * @throws SettingsError when the body is invalid, the name is not `analyzeTokenRef`, or no credential store is loaded.
   */
  async setToken(raw: unknown): Promise<StateWire> {
    await this.token.set(raw)
    return await this.state()
  }

  /**
   * Remove the stored analyze token.
   * @param raw - request body `{ tokenEnv }`.
   * @returns the new panel state.
   * @throws SettingsError on the same conditions as {@link setToken}.
   */
  async clearToken(raw: unknown): Promise<StateWire> {
    await this.token.clear(raw)
    return await this.state()
  }

  /**
   * Validate and persist a complete settings payload from the panel.
   * @param raw - request body.
   * @returns the new panel state.
   * @throws SettingsError when the payload is invalid.
   */
  async save(raw: unknown): Promise<StateWire> {
    await this.settings.save(raw)
    return await this.state()
  }

  /**
   * Remove every panel override.
   * @returns the new panel state.
   */
  async reset(): Promise<StateWire> {
    await this.settings.reset()
    return await this.state()
  }

  private onRegistryChange(): void {
    if (!this.active) return
    this.skill.invalidate()
  }
}
