/**
 * 观象运行时：持有生效设置（cordis.yml + 面板覆盖）、应用注册表、入口
 * SKILL、派发工具、SKILL 改进工具与仓库接入工具的注册，并为设置面板提供状态与写入口。
 *
 * @module dsh-logalyze/service
 */

import type { DshRepos } from './repos/contract.ts'
import { z } from 'zod'
import { applyOverlay, defaultsOf, describeIssue, editableSettingsSchema } from './config.ts'
import type { LogalyzeConfig, SettingsOverlay } from './config.ts'
import { abortable } from './abort.ts'
import type { AnalyzeGate } from './analyze/server.ts'
import { FEISHU_TOPICS_SERVICE, lookupTopics } from './analyze/topics.ts'
import { Dispatcher, isDelegatedAgent, isInside } from './dispatch/tool.ts'
import type { HostApproval, HostContext, HostCredentials, ToolActivationContext, WorkingDirectoryService } from './host.ts'
import { DSH_REPOS_SERVICE, lookupRepos, messageOf } from './repos/lookup.ts'
import { RepoRegistry } from './repos/registry.ts'
import { ANALYZE_ROUTE } from './settings/contract.ts'
import type { AnalyzeWire, EditableSettings, RepoSpec, ReposWire, StateWire, TokenStatusWire } from './settings/contract.ts'
import { diffOverlay, overriddenKeys } from './settings/overlay.ts'
import type { OverlayStore } from './settings/overlay.ts'
import { createEntrySkillProvider } from './skill/entry.ts'
import type { BundledSkill } from './skill/bundled.ts'
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

/** Optional seams for tests. */
export interface ServiceOptions {
  readonly fetch?: typeof fetch
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
  private readonly adder: RepoAdder
  private readonly initializer: RepoInitializer
  private readonly skill: ReturnType<typeof createEntrySkillProvider>
  private active = true
  private readonly refreshWaitMs: number
  private readonly analyzeTokenRef: string
  private readonly booted = Promise.withResolvers<void>()
  private additions: Promise<void> = Promise.resolve()

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
      ...config.skillUpdateAuthor === undefined ? {} : { author: config.skillUpdateAuthor },
      approval: () => ctx.get?.('approval') as HostApproval | undefined,
      repos: () => ctx.get?.(DSH_REPOS_SERVICE),
    })
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
      addRepo: spec => this.addRepo(spec),
    })
    this.initializer = new RepoInitializer({
      registry: this.registry,
      subagents: ctx.subagents,
      provider: config.subagentProvider,
      settings: () => this.current,
      workingDirectory: () => ctx.get?.('workingDirectory') as WorkingDirectoryService | undefined,
      approval: () => ctx.get?.('approval') as HostApproval | undefined,
      repos: () => ctx.get?.(DSH_REPOS_SERVICE),
      ...config.skillUpdateAuthor === undefined ? {} : { author: config.skillUpdateAuthor },
      ...options.fetch === undefined ? {} : { fetch: options.fetch },
    })
    this.skill = createEntrySkillProvider({
      prepare: signal => this.prepareCatalog(signal),
      apps: () => this.registry.readyApps().map(ready => ready.app),
      maxAppsPerRequest: () => this.current.maxAppsPerRequest,
      skillUpdates: () => this.current.skillUpdates.enabled,
      autoInvoke: config.autoInvoke,
      bundled: assets.bundled,
      inRepositories: (cwd) => {
        const lookup = lookupRepos(ctx.get?.(DSH_REPOS_SERVICE))
        return lookup.availability === 'ready' && isInside(cwd, lookup.service.mirrorSettings().dir)
      },
    })
  }

  /** Register the entry skill provider; called once from `apply()`. */
  registerSkill(): void {
    this.ctx.effect(() => this.ctx.skills.registerProvider(this.skill.factory), 'logalyze: entry skill')
  }

  /**
   * Register the dispatch, SKILL improvement, and repository onboarding tools;
   * called once from `apply()`. The definitions stay fixed because a step
   * drops a tool whose registration changed after the step resolved its tools.
   */
  registerTool(): void {
    this.ctx.effect(
      () => this.ctx.tools.register(this.dispatcher.definition(), { when: context => this.offersTool(context) }),
      'logalyze: dispatch tool',
    )
    this.ctx.effect(
      () => this.ctx.tools.register(this.improver.definition(), { when: context => this.offersTopLevel(context, () => this.current.skillUpdates.enabled && this.improver.hasGap(context.agent.session.header.id)) }),
      'logalyze: skill improvement tool',
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
   * Offer the dispatch tool to top-level agents once the first
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
   * Load the panel overlay, configure the registry, and sync every repository.
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
    this.registry.configure(this.current.repos)
    await this.registry.syncAll()
  }

  /**
   * React to dsh-repo becoming available (or reloading): sync every
   * repository again.
   * @returns when the syncs settled.
   */
  async reposAvailable(): Promise<void> {
    await this.booted.promise
    if (!this.active) return
    await this.registry.resyncAll()
  }

  /**
   * Re-sync every repository after each host or token change in dsh-repo, so a
   * new token reaches the mirrors without a manual sync.
   * @param repos - the `dshRepos` service.
   * @returns disposer that stops watching.
   */
  watchHosts(repos: DshRepos): () => void {
    return repos.onHostsChange(() => {
      if (!this.active) return
      void this.registry.resyncAll().catch((error: unknown) => {
        this.ctx.logger?.error?.('logalyze: 主机变更后同步仓库失败：%s', messageOf(error))
      })
    })
  }

  /** Stop registering tools; in-flight syncs finish without side effects on the host. */
  shutdown(): void {
    this.active = false
    this.booted.resolve()
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
    }
  }

  private credentialStore(): HostCredentials | undefined {
    return this.ctx.get?.('credentials') as HostCredentials | undefined
  }

  private reposState(): ReposWire {
    const lookup = lookupRepos(this.ctx.get?.(DSH_REPOS_SERVICE))
    if (lookup.availability !== 'ready') return { availability: lookup.availability }
    return { availability: 'ready', mirrorDir: lookup.service.mirrorSettings().dir }
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
   * Validate and persist a complete settings payload from the panel, then
   * sync repositories whose address or branch changed.
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
   * Append one repository to the panel settings, as a panel save would, and
   * start syncing it. Concurrent additions are applied in call order.
   * @param spec - validated repository.
   * @returns `exists` without writing when the address is already configured.
   * @throws SettingsError when the resulting settings are invalid.
   */
  async addRepo(spec: RepoSpec): Promise<'added' | 'exists'> {
    // Additions run one at a time so each one reads the settings the previous one saved.
    const added = this.additions.then(async () => {
      if (this.registry.has(spec.url)) return 'exists' as const
      await this.save({ ...this.current, repos: [...this.current.repos, spec] })
      return 'added' as const
    })
    this.additions = added.then(() => undefined, () => undefined)
    return await added
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
   * Re-sync one configured repository, or all of them.
   * @param url - address to sync; omitted syncs every repository.
   * @throws SettingsError when the address is not configured.
   */
  sync(url?: string): void {
    if (url !== undefined && !this.registry.has(url)) throw new SettingsError(`未配置的仓库：${url}`)
    void (url === undefined ? this.registry.syncAll() : this.registry.syncUrls([url]))
  }

  /** Make an overlay effective and sync the repositories whose address or branch changed. */
  private apply(overlay: SettingsOverlay): void {
    this.overlay = overlay
    this.overlayError = undefined
    this.current = applyOverlay(this.defaults, overlay)
    void this.registry.syncUrls(this.registry.configure(this.current.repos))
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
