/**
 * 跟随 dsh-repo 启用的仓库，执行一次性旧版元数据迁移，并租借固定提交快照。
 * 仓库缺少 manifest 或 SKILL 属于正常状态；仅当应用 id 重复冲突时标记不可用。
 * 已移除或关闭「日志分析」的仓库拒绝新租借，已持有的快照租约保持固定提交不变。
 *
 * @module dsh-logalyze/apps/registry
 */

import { z } from 'zod'
import type { AppRepo, ReposClient } from '../deps/repos.ts'
import type { SnapshotLease } from '../deps/repos-contract.ts'
import type { SkillRegistry } from '../host.ts'
import { ApplicationSettings, applicationKey, applicationMetadataSchema } from '../settings/applications.ts'
import type { ApplicationImport } from '../settings/applications.ts'
import type { AppManifest, MrRepoStatusWire, RepoSpec, RepoStatusWire } from '../settings/contract.ts'
import { SettingsError } from '../settings/controller.ts'
import { SnapshotSkills } from '../skill/snapshot.ts'
import { messageOf } from '../util/errors.ts'
import { MAX_REPO_FILE_BYTES, treeReader } from './tree.ts'

/** Collaborators of the registry. */
export interface RepoRegistryDeps {
  /** The `dshRepos` service, looked up on every use. */
  readonly repos: ReposClient
  /** Called after any status change (sync start/end, configuration, leases). */
  readonly onChange: () => void
  /** Called after `mr-review` repositories are updated from `dsh-repo`. */
  readonly onMrReposChange?: () => void
  readonly now?: () => number
  readonly applications?: ApplicationSettings
  readonly skills?: SkillRegistry
}

/** A usable application at its latest synced commit. */
export interface ReadyApp {
  readonly app: AppManifest
  readonly url: string
  readonly commit: string
  /** Selected analysis branch; independent of the version declared by a log. */
  readonly branch?: string
  /** Whether existing SKILL improvements may push to the repository. */
  readonly writable: boolean
}

/** An application held by one dispatch, with the snapshot its child works in. */
export interface LeasedApp extends ReadyApp {
  /** Read-only checkout of {@link ReadyApp.commit}; unchanged until the lease is released. */
  readonly dir: string
  /** DSH discovery/loading at this held snapshot, including host skills. */
  readonly skills: SnapshotSkills
}

/** Held snapshots of one dispatch; release exactly once. */
export interface RepoLease {
  readonly apps: ReadonlyMap<string, LeasedApp>
  release(): void
}

interface RepoEntry {
  readonly spec: RepoSpec
  writable: boolean
  /** Commit the last successful sync read. */
  commit?: string
  app?: AppManifest
  error?: string
  migrationWarning?: string
  syncedAt?: number
  syncing?: Promise<void>
  activeRuns: number
  /** Removed from the configuration; kept only until in-flight work settles. */
  retired: boolean
}

/** Mirrors, updates, and indexes the configured application and MR-review repositories. */
export class RepoRegistry {
  private entries: RepoEntry[] = []
  private mrEntries: MrRepoStatusWire[] = []
  private readonly now: () => number
  private readonly applications: ApplicationSettings
  private saving: Promise<void> = Promise.resolve()
  private closed = false
  private readonly workAbort = new AbortController()
  private readonly syncing = new Set<Promise<void>>()
  private readonly acquiring = new Set<Promise<RepoLease>>()

  /** @param deps - service lookup and change notification. */
  constructor(private readonly deps: RepoRegistryDeps) {
    this.now = deps.now ?? Date.now
    this.applications = deps.applications ?? new ApplicationSettings()
  }

  /**
   * Replace the configured log-analysis repositories. An address keeps its status when its
   * branch is unchanged; a change of access alone needs no sync.
   * @param repos - configured repositories.
   * @returns addresses that are new or changed and therefore need a sync.
   */
  configure(repos: readonly AppRepo[]): string[] {
    if (this.closed) return []
    const previous = new Map(this.entries.map(entry => [entry.spec.url, entry]))
    const changed: string[] = []
    this.entries = repos.map(({ writable, ...spec }) => {
      const kept = previous.get(spec.url)
      if (kept !== undefined && kept.spec.branch === spec.branch) {
        previous.delete(spec.url)
        kept.writable = writable
        return kept
      }
      changed.push(spec.url)
      return { spec, writable, activeRuns: 0, retired: false }
    })
    for (const entry of previous.values()) entry.retired = true
    this.deps.onChange()
    return changed
  }

  /**
   * Replace the configured `mr-review` repositories from `dsh-repo`.
   * @param repos - catalog repositories with `mr-review` enabled.
   */
  configureMrRepos(repos: readonly MrRepoStatusWire[]): void {
    if (this.closed) return
    this.mrEntries = repos.map(repo => ({ ...repo }))
    this.deps.onMrReposChange?.()
    this.deps.onChange()
  }

  /** @returns panel view of repositories with `mr-review` enabled in `dsh-repo`. */
  mrStatus(): MrRepoStatusWire[] {
    return this.mrEntries.map(repo => ({ ...repo }))
  }

  /**
   * Sync every configured repository, in parallel.
   * @returns when every sync settled (failures are recorded in the status).
   */
  async syncAll(): Promise<void> {
    await Promise.all(this.entries.map(entry => this.syncEntry(entry)))
  }

  /**
   * Sync the configured repositories with the given addresses.
   * @param urls - addresses to sync.
   * @returns when those syncs settled.
   */
  async syncUrls(urls: readonly string[]): Promise<void> {
    const wanted = new Set(urls)
    await Promise.all(this.entries.filter(entry => wanted.has(entry.spec.url)).map(entry => this.syncEntry(entry)))
  }

  /**
   * Sync every configured repository again after any sync already running for
   * it, so the new sync sees changes made since that sync started (a host
   * token, for example).
   */
  async resyncAll(): Promise<void> {
    await Promise.all(this.entries.map(entry => entry.syncing === undefined
      ? this.syncEntry(entry)
      : entry.syncing.then(() => undefined, () => undefined).then(() => this.syncEntry(entry))))
  }

  /**
   * Sync the repositories that never synced or whose last sync is at least
   * `maxAgeMs` old, and join syncs already running.
   * @param maxAgeMs - age threshold; 0 syncs every repository.
   */
  async refresh(maxAgeMs: number): Promise<void> {
    const now = this.now()
    await Promise.all(this.entries
      .filter(entry => entry.syncing !== undefined || entry.syncedAt === undefined || now - entry.syncedAt >= maxAgeMs)
      .map(entry => this.syncEntry(entry)))
  }

  /**
   * Whether an address is configured for log analysis.
   */
  has(url: string): boolean {
    return this.entries.some(entry => entry.spec.url === url)
  }

  /** @returns the panel view of every configured log-analysis repository. */
  status(): RepoStatusWire[] {
    const duplicates = this.duplicateIds()
    return this.entries.map((entry) => {
      const duplicate = entry.app !== undefined ? duplicates.get(entry.app.id) : undefined
      const conflict = duplicate !== undefined && duplicate.length > 1
        ? `应用 id「${entry.app?.id}」同时出现在 ${duplicate.join('、')}，这些仓库均不可用`
        : undefined
      const phase = entry.syncing !== undefined
        ? 'syncing'
        : entry.app !== undefined && entry.commit !== undefined
          ? 'ready'
          : entry.error !== undefined
            ? 'failed'
            : 'pending'
      const aliases = this.aliasConflicts(entry)
      const error = conflict ?? ([
        entry.error,
        entry.migrationWarning,
        aliases.length === 0 ? undefined : `触发名称冲突：${aliases.join('、')}；请在智能监管设置中修改别名，不能唯一匹配时不会选择仓库`,
      ].filter(Boolean).join('；') || undefined)
      return {
        url: entry.spec.url,
        ...(entry.spec.branch === undefined ? {} : { branch: entry.spec.branch }),
        phase,
        ...(entry.commit === undefined ? {} : { commit: entry.commit }),
        ...(entry.syncedAt === undefined ? {} : { syncedAt: entry.syncedAt }),
        ...(entry.app === undefined ? {} : { app: entry.app }),
        ...(error === undefined ? {} : { error }),
        available: entry.app !== undefined && entry.commit !== undefined && conflict === undefined,
        writable: entry.writable,
        activeRuns: entry.activeRuns,
      }
    })
  }

  /** @returns usable applications, ordered as configured. */
  readyApps(): ReadyApp[] {
    return this.readyEntries().map(({ ready }) => ready)
  }

  private readyEntries(): { entry: RepoEntry; ready: ReadyApp }[] {
    const duplicates = this.duplicateIds()
    const ready: { entry: RepoEntry; ready: ReadyApp }[] = []
    for (const entry of this.entries) {
      if (entry.app === undefined || entry.commit === undefined) continue
      if ((duplicates.get(entry.app.id)?.length ?? 0) > 1) continue
      ready.push({
        entry,
        ready: {
          app: entry.app,
          url: entry.spec.url,
          commit: entry.commit,
          ...(entry.spec.branch === undefined ? {} : { branch: entry.spec.branch }),
          writable: entry.writable,
        },
      })
    }
    return ready
  }

  /**
   * Find one usable application.
   * @param id - application id.
   */
  readyApp(id: string): ReadyApp {
    const found = this.readyApps().find(ready => ready.app.id === id)
    if (found === undefined) throw new Error(this.unknownMessage([id]))
    return found
  }

  /**
   * Hold a snapshot of each requested application's latest synced commit for
   * one dispatch. Every id must resolve to a usable application, or nothing is held.
   */
  acquire(ids: readonly string[]): Promise<RepoLease> {
    if (this.closed) return Promise.reject(new Error('智能监管已停止，不能取得新的应用快照'))
    const pending = this.acquireReady(ids).finally(() => { this.acquiring.delete(pending) })
    this.acquiring.add(pending)
    return pending
  }

  private async acquireReady(ids: readonly string[]): Promise<RepoLease> {
    const unique = [...new Set(ids)]
    const ready = new Map(this.readyEntries().map(item => [item.ready.app.id, item]))
    const missing = unique.filter(id => !ready.has(id))
    if (missing.length > 0) throw new Error(this.unknownMessage(missing))
    const service = this.deps.repos.require()
    const held = unique.map((id) => {
      const { entry, ready: app } = ready.get(id) as { entry: RepoEntry; ready: ReadyApp }
      entry.activeRuns += 1
      return { id, entry, app, snapshot: service.snapshotAcquire({ repo: app.url, ref: app.commit, signal: this.workAbort.signal }) }
    })
    this.deps.onChange()
    const outcomes = await Promise.allSettled(held.map(item => item.snapshot))
    const leases = outcomes.flatMap(outcome => outcome.status === 'fulfilled' ? [outcome.value] : [])
    let released = false
    const release = (): void => {
      if (released) return
      released = true
      for (const lease of leases) lease.release()
      for (const { entry } of held) entry.activeRuns -= 1
      this.deps.onChange()
    }
    if (this.closed) {
      release()
      throw new Error('智能监管已停止，未交付新的应用快照')
    }
    for (const [index, outcome] of outcomes.entries()) {
      if (outcome.status === 'fulfilled') continue
      release()
      throw new Error(`应用「${held[index]?.id}」的代码快照创建失败：${messageOf(outcome.reason)}`)
    }
    return {
      apps: new Map(held.map(({ id, app }, index) => {
        const dir = (leases[index] as SnapshotLease).path
        return [id, { ...app, dir, skills: new SnapshotSkills(this.deps.skills, dir, () => !released) }]
      })),
      release,
    }
  }

  /**
   * The panel view of one configured repository.
   */
  statusOf(url: string): RepoStatusWire | undefined {
    return this.status().find(repo => repo.url === url)
  }

  /** Resolve a Feishu name or raw platform component code without guessing. */
  resolve(name: string): ReadyApp {
    const key = applicationKey(name)
    const matches = this.readyApps().filter(({ app }) =>
      [app.id, app.name, ...app.aliases].some(value => applicationKey(value) === key),
    )
    if (matches.length === 1) return matches[0]!
    if (matches.length > 1) {
      throw new Error(`「${name}」同时对应多个应用（${matches.map(item => item.app.id).join('、')}）；请在智能监管设置中移除冲突别名，或提供唯一应用 id`)
    }
    throw new Error(`「${name}」没有对应的可用应用；请在智能监管设置中添加触发别名，并确认 dsh-repo 中已打开「日志分析」且仓库读取成功`)
  }

  /** Validate and save only description/aliases for a currently enabled repository. */
  saveApplication(raw: unknown): Promise<void> {
    if (this.closed) return Promise.reject(new SettingsError('智能监管已停止，不能保存新的应用设置'))
    const operation = this.saving.then(() => this.updateApplication(raw))
    this.saving = operation.catch((_error: unknown) => { /* The caller receives the failure; later saves remain possible. */ })
    return operation
  }

  private async updateApplication(raw: unknown): Promise<void> {
    const parsed = z.object({ url: z.string().min(1), ...applicationMetadataSchema.shape }).strict().safeParse(raw)
    if (!parsed.success) throw new SettingsError(parsed.error.issues[0]?.message ?? '应用设置不合法')
    const metadata = applicationMetadataSchema.safeParse({ description: parsed.data.description, aliases: parsed.data.aliases })
    if (!metadata.success) throw new SettingsError(metadata.error.issues[0]?.message ?? '应用设置不合法')
    const entry = this.entries.find(candidate => candidate.spec.url === parsed.data.url)
    if (entry === undefined || entry.retired) throw new SettingsError('仓库已移除或关闭「日志分析」；请到 dsh-repo 检查')
    const conflicts = metadata.data.aliases.filter(alias =>
      this.entries.some(other =>
        other !== entry
        && other.app !== undefined
        && [other.app.id, other.app.name, ...other.app.aliases].some(value => applicationKey(value) === applicationKey(alias)),
      ),
    )
    if (conflicts.length > 0) throw new SettingsError(`别名「${conflicts.join('、')}」已被其他应用使用；请使用唯一别名`)
    const app = await this.applications.save(entry.spec.url, metadata.data, entry.app)
    const current = this.entries.find(candidate => candidate.spec.url === entry.spec.url)
    if (current !== undefined) {
      current.app = app
      current.migrationWarning = undefined
    }
    this.deps.onChange()
  }

  /** Stop new metadata work and wait for admitted writes and all commit refreshes, including retired entries. */
  async close(): Promise<void> {
    this.closed = true
    this.workAbort.abort(new Error('智能监管已停止读取应用仓库'))
    await Promise.allSettled([this.saving, ...this.syncing, ...this.acquiring])
  }

  private unknownMessage(ids: readonly string[]): string {
    const status = new Map(this.status().flatMap(repo => repo.app === undefined ? [] : [[repo.app.id, repo] as const]))
    const details = ids.map((id) => {
      const repo = status.get(id)
      return repo === undefined ? `「${id}」不在应用注册表中` : `「${id}」不可用：${repo.error ?? repo.phase}`
    })
    const available = this.readyApps().map(app => app.app.id)
    return `${details.join('；')}。可用的应用 id：${available.length === 0 ? '（无）' : available.join('、')}`
  }

  private aliasConflicts(entry: RepoEntry): string[] {
    if (entry.app === undefined) return []
    return [...new Set([entry.app.id, entry.app.name, ...entry.app.aliases])].filter(name =>
      this.entries.some(other =>
        other !== entry
        && other.app !== undefined
        && [other.app.id, other.app.name, ...other.app.aliases].some(value => applicationKey(value) === applicationKey(name)),
      ),
    )
  }

  private duplicateIds(): Map<string, string[]> {
    const urls = new Map<string, string[]>()
    for (const entry of this.entries) {
      if (entry.app === undefined) continue
      urls.set(entry.app.id, [...urls.get(entry.app.id) ?? [], entry.spec.url])
    }
    return urls
  }

  private syncEntry(entry: RepoEntry): Promise<void> {
    if (this.closed) return Promise.resolve()
    if (entry.syncing !== undefined) return entry.syncing
    const run = this.runSync(entry).finally(() => {
      entry.syncing = undefined
      this.syncing.delete(run)
      this.deps.onChange()
    })
    entry.syncing = run
    this.syncing.add(run)
    this.deps.onChange()
    return run
  }

  private async runSync(entry: RepoEntry): Promise<void> {
    if (entry.retired) return
    let head: { commit: string; imported: ApplicationImport }
    try {
      head = await this.deps.repos.withSnapshot(entry.spec.url, entry.spec.branch, this.workAbort.signal, async lease => ({
        commit: lease.commit,
        imported: await this.applications.ensure(entry.spec.url, treeReader(lease.path, MAX_REPO_FILE_BYTES)),
      }))
    } catch (error) {
      entry.syncedAt = this.now()
      entry.error = entry.commit !== undefined && entry.app !== undefined
        ? `更新失败，继续使用已有提交 ${entry.commit.slice(0, 8)}：${messageOf(error)}`
        : messageOf(error)
      return
    }
    const { imported } = head
    entry.syncedAt = this.now()
    entry.commit = head.commit
    const current = this.applications.current(entry.spec.url)
    entry.app = current ?? imported.app
    entry.error = undefined
    entry.migrationWarning = current === undefined ? imported.warning : undefined
  }
}
