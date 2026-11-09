/**
 * 观象运行时：持有生效设置（cordis.yml + 面板覆盖）、应用注册表、入口
 * SKILL、派发工具、SKILL 查看与改进工具、仓库接入工具的注册和分析报告回传，并为设置面板提供状态与写入口。
 *
 * @module dsh-logalyze/service
 */

import type { DshRepos } from './repos/contract.ts'
import { z } from 'zod'
import { applyOverlay, defaultsOf, describeIssue, editableSettingsSchema } from './config.ts'
import type { LogalyzeConfig, SettingsOverlay } from './config.ts'
import { abortable } from './abort.ts'
import type { AnalyzeRequest } from './analyze/contract.ts'
import { FEISHU_TOPICS_STATUS_EVENT } from './analyze/feishu-topics.ts'
import type { AnalyzeGate } from './analyze/server.ts'
import { FEISHU_TOPICS_SERVICE, lookupTopics } from './analyze/topics.ts'
import type { CommandRunner } from './report/command.ts'
import { defaultReportsDir, ReportStore } from './report/store.ts'
import { ReportTracker } from './report/tracker.ts'
import type { ReportTopics } from './report/tracker.ts'
import { Dispatcher, inRunDirectory, isDelegatedAgent, isInside } from './dispatch/tool.ts'
import { authorize } from './access.ts'
import type { HostApproval, HostContext, HostCredentials, ToolActivationContext, WorkingDirectoryService } from './host.ts'
import { DSH_REPOS_SERVICE, LOG_ANALYSIS_FEATURE, lookupRepos, messageOf, requireRepos } from './repos/lookup.ts'
import { RepoRegistry } from './repos/registry.ts'
import { ANALYZE_ROUTE } from './settings/contract.ts'
import type { AnalyzeWire, EditableSettings, RepoSpec, ReposWire, StateWire, TokenStatusWire } from './settings/contract.ts'
import { diffOverlay, overriddenKeys } from './settings/overlay.ts'
import type { OverlayStore } from './settings/overlay.ts'
import { createEntrySkillProvider } from './skill/entry.ts'
import type { BundledSkill } from './skill/bundled.ts'
import { SkillViewer } from './skill-update/show.ts'
import { SkillImprover } from './skill-update/tool.ts'
import { RepoAdder } from './onboard/add.ts'
import { RepoInitializer } from './onboard/init.ts'

/** A settings write the panel reports as a field error. */
export class SettingsError extends Error {}

/** Longest accepted token; personal access tokens are far shorter. */
const MAX_TOKEN_LENGTH = 4096

const tokenValue = z.string().trim()
  .refine(value => value.length > 0 && value.length <= MAX_TOKEN_LENGTH && !/[\u0000-\u001f\u007f]/.test(value), `令牌不能为空、超过 ${MAX_TOKEN_LENGTH} 个字符或包含换行等控制字符`)
const tokenClearSchema = z.object({ tokenEnv: z.string() }).strict()
const tokenSetSchema = tokenClearSchema.extend({ value: tokenValue }).strict()
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
  private readonly defaults: EditableSettings
  private overlay: SettingsOverlay = {}
  private overlayError: string | undefined
  private current: EditableSettings
  private readonly dispatcher: Dispatcher
  private readonly improver: SkillImprover
  private readonly viewer: SkillViewer
  private readonly adder: RepoAdder
  private readonly initializer: RepoInitializer
  private readonly skill: ReturnType<typeof createEntrySkillProvider>
  private readonly reports: ReportTracker
  private active = true
  private readonly refreshWaitMs: number
  private readonly analyzeTokenRef: string
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
    private readonly store: OverlayStore,
    assets: ServiceAssets,
    options: ServiceOptions = {},
  ) {
    this.defaults = defaultsOf(config)
    this.refreshWaitMs = config.refreshWaitMs
    this.analyzeTokenRef = config.analyzeTokenRef
    this.current = this.defaults
    this.registry = new RepoRegistry({
      repos: () => ctx.get?.(DSH_REPOS_SERVICE),
      onChange: () => { this.onRegistryChange() },
    })
    this.improver = new SkillImprover({
      registry: this.registry,
      subagents: ctx.subagents,
      provider: config.subagentProvider,
      settings: () => this.current,
      workingDirectory: () => ctx.get?.('workingDirectory') as WorkingDirectoryService | undefined,
      repos: () => ctx.get?.(DSH_REPOS_SERVICE),
      ...options.fetch === undefined ? {} : { fetch: options.fetch },
    })
    this.viewer = new SkillViewer({ registry: this.registry, repos: () => ctx.get?.(DSH_REPOS_SERVICE) })
    this.dispatcher = new Dispatcher({
      registry: this.registry,
      gaps: this.improver,
      subagents: ctx.subagents,
      settings: () => this.current,
      provider: config.subagentProvider,
      workingDirectory: () => ctx.get?.('workingDirectory') as WorkingDirectoryService | undefined,
      ...options.fetch === undefined ? {} : { fetch: options.fetch },
    })
    this.adder = new RepoAdder({
      registry: this.registry,
      approval: () => ctx.get?.('approval') as HostApproval | undefined,
      authorize: event => authorize(ctx, event),
      addRepo: (spec, session) => this.addRepo(spec, session),
    })
    this.initializer = new RepoInitializer({
      registry: this.registry,
      subagents: ctx.subagents,
      provider: config.subagentProvider,
      settings: () => this.current,
      workingDirectory: () => ctx.get?.('workingDirectory') as WorkingDirectoryService | undefined,
      approval: () => ctx.get?.('approval') as HostApproval | undefined,
      repos: () => ctx.get?.(DSH_REPOS_SERVICE),
      ...options.fetch === undefined ? {} : { fetch: options.fetch },
    })
    this.reports = new ReportTracker({
      store: new ReportStore(options.reportsDir ?? defaultReportsDir(), message => ctx.logger?.warn?.(message)),
      topics: () => this.reportTopics(),
      upload: () => this.current.analyze.upload,
      warn: message => ctx.logger?.warn?.(message),
      ...options.runCommand === undefined ? {} : { run: options.runCommand },
    })
    this.skill = createEntrySkillProvider({
      prepare: signal => this.prepareCatalog(signal),
      apps: () => this.registry.readyApps().map(ready => ready.app),
      maxAppsPerRequest: () => this.current.maxAppsPerRequest,
      skillUpdates: () => this.current.skillUpdates.enabled,
      autoInvoke: config.autoInvoke,
      bundled: assets.bundled,
      inRepositories: (cwd) => {
        if (inRunDirectory(cwd)) return true
        const lookup = lookupRepos(ctx.get?.(DSH_REPOS_SERVICE))
        if (lookup.availability !== 'ready') return false
        const mirrors = lookup.service.mirrorSettings().dir
        return mirrors !== undefined && isInside(cwd, mirrors)
      },
    })
  }

  /** Register the entry skill provider; called once from `apply()`. */
  registerSkill(): void {
    this.ctx.effect(() => this.ctx.skills.registerProvider(this.skill.factory), 'logalyze: entry skill')
  }

  /**
   * Register the dispatch, SKILL improvement and view, and repository onboarding tools;
   * called once from `apply()`. The definitions stay fixed because a step
   * drops a tool whose registration changed after the step resolved its tools.
   * The improvement tool counts finished turns from `turn/end` Session events.
   */
  registerTool(): void {
    this.ctx.on('session/event', (session, event) => {
      if (event.type === 'turn/end') this.improver.turnEnded(session.header.id)
      this.reports.sessionEvent(session, event)
    })
    this.ctx.on(FEISHU_TOPICS_STATUS_EVENT, (state) => { this.reports.statusChanged(state) })
    this.ctx.effect(
      () => this.ctx.tools.register(this.dispatcher.definition(), { when: context => this.offersTool(context) }),
      'logalyze: dispatch tool',
    )
    this.ctx.effect(
      () => this.ctx.tools.register(this.improver.definition(), { when: async context => this.current.skillUpdates.enabled && await this.offersTool(context) }),
      'logalyze: skill improvement tool',
    )
    this.ctx.effect(
      () => this.ctx.tools.register(this.viewer.definition(), { when: context => this.offersTool(context) }),
      'logalyze: skill view tool',
    )
    this.ctx.effect(
      () => this.ctx.tools.register(this.adder.definition(), { when: context => this.offersTopLevel(context, () => true) }),
      'logalyze: add repository tool',
    )
    this.ctx.effect(
      () => this.ctx.tools.register(this.initializer.initDefinition(), { when: context => this.offersTopLevel(context, () => this.registry.setupPending().length > 0) }),
      'logalyze: draft repository setup tool',
    )
    this.ctx.effect(
      () => this.ctx.tools.register(this.initializer.submitDefinition(), { when: context => this.offersTopLevel(context, () => this.initializer.hasDraft(context.agent.session.header.id)) }),
      'logalyze: submit repository setup tool',
    )
  }

  /**
   * Offer a tool to top-level agents once the first sync settled and the
   * tool's own condition holds.
   * @param context - the preparing step.
   * @param condition - the tool's condition, read after the first sync.
   * @returns whether the step may call the tool.
   */
  private async offersTopLevel({ agent, signal }: ToolActivationContext, condition: () => boolean): Promise<boolean> {
    if (isDelegatedAgent(agent)) return false
    await abortable(this.booted.promise, signal)
    return this.active && condition()
  }

  /**
   * Offer the dispatch and SKILL tools to top-level agents once the first
   * sync settled and at least one application is usable.
   * @param context - the preparing step.
   * @returns whether the step may call the tool.
   */
  private async offersTool(context: ToolActivationContext): Promise<boolean> {
    return await this.offersTopLevel(context, () => this.registry.readyApps().length > 0)
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
      await abortable(this.registry.refresh(this.current.fetchIntervalMs), signal === undefined ? limit : AbortSignal.any([signal, limit]))
    } catch (error) {
      if (signal?.aborted === true || !limit.aborted) throw error
      // The wait limit passed: render the catalog synced so far.
    }
  }

  /**
   * Load the panel overlay, take the application repositories from the
   * dsh-repo catalog, and sync every repository.
   * @returns when the first sync round settled.
   */
  async boot(): Promise<void> {
    try {
      await this.bootOnce()
    } finally {
      this.booted.resolve()
    }
  }

  private async bootOnce(): Promise<void> {
    const read = await this.store.read()
    if (read.ok) {
      this.overlay = read.overlay
    } else {
      this.overlayError = read.error
      this.ctx.logger?.warn?.('logalyze: 忽略面板设置：%s', read.error)
    }
    this.current = applyOverlay(this.defaults, this.overlay)
    await this.reports.boot().catch((error: unknown) => {
      this.ctx.logger?.error?.('logalyze: 读取回传记录失败：%s', messageOf(error))
    })
    this.registry.configure(this.catalogRepos())
    await this.registry.syncAll()
  }

  /**
   * The application repositories: the dsh-repo catalog repositories with the
   * log analysis feature turned on, following the catalog branch. Empty while
   * dsh-repo is missing or incompatible.
   */
  private catalogRepos(): RepoSpec[] {
    const lookup = lookupRepos(this.ctx.get?.(DSH_REPOS_SERVICE))
    if (lookup.availability !== 'ready') return []
    return lookup.service.listRepos({ feature: LOG_ANALYSIS_FEATURE.id }).map(repo => repo.branch === undefined ? { url: repo.url } : { url: repo.url, branch: repo.branch })
  }

  /**
   * React to dsh-repo becoming available (or reloading): take the application
   * repositories from its catalog again and sync every repository.
   * @returns when the syncs settled.
   */
  async reposAvailable(): Promise<void> {
    await this.booted.promise
    if (!this.active) return
    this.registry.configure(this.catalogRepos())
    await this.registry.resyncAll()
  }

  /**
   * Register the log analysis feature with dsh-repo, follow its catalog (new,
   * removed, or re-branched repositories are configured and synced at once),
   * and sync every repository again after each host or token change so a new
   * token reaches the mirrors without a manual sync.
   * @param repos - the `dshRepos` service.
   * @returns disposer that withdraws the feature and stops watching.
   */
  watchRepos(repos: DshRepos): () => void {
    const unregister = repos.registerFeature(LOG_ANALYSIS_FEATURE)
    const stopCatalog = repos.onReposChange(() => {
      if (!this.active) return
      void this.registry.syncUrls(this.registry.configure(this.catalogRepos())).catch((error: unknown) => {
        this.ctx.logger?.error?.('logalyze: 仓库清单变更后同步仓库失败：%s', messageOf(error))
      })
    })
    const stopHosts = repos.onHostsChange(() => {
      if (!this.active) return
      void this.registry.resyncAll().catch((error: unknown) => {
        this.ctx.logger?.error?.('logalyze: 主机变更后同步仓库失败：%s', messageOf(error))
      })
    })
    return () => {
      stopHosts()
      stopCatalog()
      unregister()
    }
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

  /** The launch-state methods of the loaded `feishuTopics`, when it has them. */
  private reportTopics(): ReportTopics | undefined {
    const lookup = lookupTopics(this.ctx.get?.(FEISHU_TOPICS_SERVICE))
    if (lookup.availability !== 'ready') return undefined
    const { service } = lookup
    if (typeof service.state !== 'function' || typeof service.launchKeyOf !== 'function') return undefined
    return { state: key => service.state?.(key), launchKeyOf: sessionId => service.launchKeyOf?.(sessionId) }
  }

  /** @returns current effective settings. */
  settings(): EditableSettings {
    return this.current
  }

  /** @returns the panel state. */
  async state(): Promise<StateWire> {
    return {
      settings: this.current,
      defaults: this.defaults,
      overridden: overriddenKeys(this.overlay),
      ...this.overlayError === undefined ? {} : { overlayError: this.overlayError },
      repos: this.registry.status(),
      dshRepo: this.reposState(),
      credentialsAvailable: this.credentialStore() !== undefined,
      analyze: await this.analyzeState(),
    }
  }

  /** @returns the analyze route's switch and bearer token, read per request. */
  analyzeGate(): AnalyzeGate {
    return {
      enabled: () => this.current.analyze.enabled,
      tokenEnv: () => this.analyzeTokenRef,
      token: async () => {
        try {
          return (await this.credentialStore()?.resolve(this.analyzeTokenRef))?.value
        } catch (error) {
          this.ctx.logger?.warn?.('logalyze: 读取分析接口令牌 %s 失败：%s', this.analyzeTokenRef, error instanceof Error ? error.message : String(error))
          return undefined
        }
      },
    }
  }

  private async analyzeState(): Promise<AnalyzeWire> {
    const store = this.credentialStore()
    return {
      route: ANALYZE_ROUTE,
      tokenEnv: this.analyzeTokenRef,
      ...store === undefined ? {} : { token: await describeToken(store, this.analyzeTokenRef) },
      topics: lookupTopics(this.ctx.get?.(FEISHU_TOPICS_SERVICE)).availability,
      reportsSupported: this.reportTopics() !== undefined,
      reports: this.reports.list(),
    }
  }

  private credentialStore(): HostCredentials | undefined {
    return this.ctx.get?.('credentials') as HostCredentials | undefined
  }

  private reposState(): ReposWire {
    const lookup = lookupRepos(this.ctx.get?.(DSH_REPOS_SERVICE))
    if (lookup.availability !== 'ready') return { availability: lookup.availability }
    const mirror = lookup.service.mirrorSettings()
    return { availability: 'ready', ...mirror.dir === undefined ? {} : { mirrorDir: mirror.dir }, ...mirror.problem === undefined ? {} : { mirrorProblem: mirror.problem } }
  }

  /**
   * Store the analyze API's bearer token (`analyzeTokenRef`) in DSH's
   * credential store; it applies from the next request.
   * @param raw - request body `{ tokenEnv, value }`.
   * @returns the new panel state.
   * @throws SettingsError when the body is invalid, the name is not `analyzeTokenRef`, or no credential store is loaded.
   */
  async setToken(raw: unknown): Promise<StateWire> {
    const parsed = tokenSetSchema.safeParse(raw)
    if (!parsed.success) throw new SettingsError(describeIssue(parsed.error))
    return await this.writeToken(parsed.data.tokenEnv, parsed.data.value)
  }

  /**
   * Remove the stored analyze token; an environment variable of the same name
   * applies again afterwards.
   * @param raw - request body `{ tokenEnv }`.
   * @returns the new panel state.
   * @throws SettingsError on the same conditions as {@link setToken}.
   */
  async clearToken(raw: unknown): Promise<StateWire> {
    const parsed = tokenClearSchema.safeParse(raw)
    if (!parsed.success) throw new SettingsError(describeIssue(parsed.error))
    return await this.writeToken(parsed.data.tokenEnv, undefined)
  }

  private async writeToken(tokenEnv: string, value: string | undefined): Promise<StateWire> {
    if (tokenEnv !== this.analyzeTokenRef) throw new SettingsError(`${tokenEnv} 不是分析接口令牌的名称`)
    const store = this.credentialStore()
    if (store === undefined) throw new SettingsError('当前 DSH 组合没有凭据服务（@deepseek-ai/dsh-credentials-local），无法保存令牌')
    if (value === undefined) await store.unset(tokenEnv)
    else await store.set(tokenEnv, value)
    return await this.state()
  }

  /**
   * Validate and persist a complete settings payload from the panel.
   * @param raw - request body.
   * @returns the new panel state.
   * @throws SettingsError when the payload is invalid.
   */
  async save(raw: unknown): Promise<StateWire> {
    const parsed = editableSettingsSchema.safeParse(raw)
    if (!parsed.success) throw new SettingsError(describeIssue(parsed.error))
    const overlay = diffOverlay(this.defaults, applyOverlay(this.defaults, parsed.data))
    await this.store.write(overlay)
    this.apply(overlay)
    return await this.state()
  }

  /**
   * Add one repository to the dsh-repo catalog with the log analysis feature
   * turned on, or turn the feature on for the entry holding it. A new entry
   * gets `write` access, which drafting setups and SKILL improvements push
   * with; an existing entry keeps its access. dsh-repo asks `access/authorize`
   * (level `admin`) for the Session before it changes the catalog, and the
   * catalog change reconfigures the registry.
   * @param spec - validated repository.
   * @param session - the calling Session.
   * @returns `exists` when the catalog already had the feature on for it, and the address as the catalog stores it.
   * @throws the dsh-repo failure (`conflict` for another branch, `forbidden`, `not-allowed`), or when dsh-repo is missing or incompatible.
   */
  async addRepo(spec: RepoSpec, session: string): Promise<{ readonly status: 'added' | 'exists'; readonly url: string }> {
    const repos = requireRepos(this.ctx.get?.(DSH_REPOS_SERVICE))
    const result = await repos.addRepo(spec.url, { ...spec.branch === undefined ? {} : { branch: spec.branch }, access: 'write', features: [LOG_ANALYSIS_FEATURE.id], session })
    // The catalog listener has configured the registry already unless it was not subscribed yet.
    if (!this.registry.has(result.repo.url)) this.registry.configure(this.catalogRepos())
    return { status: result.status === 'unchanged' ? 'exists' : 'added', url: result.repo.url }
  }

  /**
   * Remove every panel override.
   * @returns the new panel state.
   */
  async reset(): Promise<StateWire> {
    await this.store.write({})
    this.apply({})
    return await this.state()
  }

  /**
   * Re-sync one application repository, or all of them.
   * @param url - address to sync; omitted syncs every repository.
   * @throws SettingsError when the address is not configured.
   */
  sync(url?: string): void {
    if (url !== undefined && !this.registry.has(url)) throw new SettingsError(`仓库清单中没有打开「${LOG_ANALYSIS_FEATURE.title}」的仓库：${url}`)
    void (url === undefined ? this.registry.syncAll() : this.registry.syncUrls([url]))
  }

  /** Make an overlay effective. */
  private apply(overlay: SettingsOverlay): void {
    this.overlay = overlay
    this.overlayError = undefined
    this.current = applyOverlay(this.defaults, overlay)
  }

  private onRegistryChange(): void {
    if (!this.active) return
    this.skill.invalidate()
  }
}

async function describeToken(store: HostCredentials, tokenEnv: string): Promise<TokenStatusWire> {
  try {
    const info = await store.describe(tokenEnv)
    return { tokenEnv, configured: info.configured, ...info.source === undefined ? {} : { source: info.source }, writable: info.writable }
  } catch (error) {
    return { tokenEnv, configured: false, writable: false, error: error instanceof Error ? error.message : String(error) }
  }
}
