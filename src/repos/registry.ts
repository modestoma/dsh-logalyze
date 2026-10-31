/**
 * 应用注册表：经 dsh-repo 的本地镜像拉取设置中的 git 地址，从远端分支最新提交
 * 读取各仓库的应用描述，对外提供「已就绪的应用」，并为每次派发持有该提交的
 * 只读代码快照。
 *
 * - 镜像、快照和令牌都由 dsh-repo 管理：镜像只做 fetch，不检出；应用描述与
 *   SKILL 直接从提交读取，所以随时可以更新，不受正在进行的分析影响。快照在
 *   所有持有者释放后由 dsh-repo 清理。
 * - dsh-repo 不可用或更新失败时继续使用已有提交，并在状态里给出原因；应用描述
 *   或 SKILL 不合法时该应用不可用。
 * - 多个仓库声明同一个应用 id 时，这些仓库全部不可用。
 *
 * @module dsh-logalyze/repos/registry
 */

import type { DshRepos, SnapshotLease } from './contract.ts'
import type { AppManifest, RepoSpec, RepoStatusWire } from '../settings/contract.ts'
import { messageOf, requireRepos } from './lookup.ts'
import { checkAppManifest } from './manifest.ts'

/** Collaborators of the registry. */
export interface RepoRegistryDeps {
  /** The current `ctx.get('dshRepos')` value, looked up on every use. */
  readonly repos: () => unknown
  /** Called after any status change (sync start/end, configuration, leases). */
  readonly onChange: () => void
  readonly now?: () => number
}

/** A usable application at its latest synced commit. */
export interface ReadyApp {
  readonly app: AppManifest
  readonly url: string
  readonly commit: string
}

/** An application held by one dispatch, with the snapshot its child works in. */
export interface LeasedApp extends ReadyApp {
  /** Read-only checkout of {@link ReadyApp.commit}; unchanged until the lease is released. */
  readonly dir: string
}

/** Held snapshots of one dispatch; release exactly once. */
export interface RepoLease {
  readonly apps: ReadonlyMap<string, LeasedApp>
  release(): void
}

interface RepoEntry {
  readonly spec: RepoSpec
  /** Mirror directory reported by the last successful sync. */
  dir?: string
  /** Branch the last successful sync resolved. */
  branch?: string
  commit?: string
  commitTime?: string
  app?: AppManifest
  error?: string
  syncedAt?: number
  syncing?: Promise<void>
  activeRuns: number
  /** Removed from the configuration; kept only until in-flight work settles. */
  retired: boolean
}

/** Mirrors, updates, and indexes the configured application repositories. */
export class RepoRegistry {
  private entries: RepoEntry[] = []
  private readonly now: () => number

  /** @param deps - service lookup and change notification. */
  constructor(private readonly deps: RepoRegistryDeps) {
    this.now = deps.now ?? Date.now
  }

  /**
   * Replace the configured repositories. An address keeps its status when its
   * branch is unchanged.
   * @param repos - configured repositories.
   * @returns addresses that are new or changed and therefore need a sync.
   */
  configure(repos: readonly RepoSpec[]): string[] {
    const previous = new Map(this.entries.map(entry => [entry.spec.url, entry]))
    const changed: string[] = []
    this.entries = repos.map((spec) => {
      const kept = previous.get(spec.url)
      if (kept !== undefined && kept.spec.branch === spec.branch) {
        previous.delete(spec.url)
        return kept
      }
      changed.push(spec.url)
      return { spec: { ...spec }, activeRuns: 0, retired: false }
    })
    for (const entry of previous.values()) entry.retired = true
    this.deps.onChange()
    return changed
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
   * token, for example). An idle repository starts syncing before this
   * returns, so its status reads `syncing` at once.
   * @returns when those syncs settled.
   */
  async resyncAll(): Promise<void> {
    await Promise.all(this.entries.map(entry => entry.syncing === undefined
      ? this.syncEntry(entry)
      // The running sync's outcome is superseded by the one started after it.
      : entry.syncing.then(() => undefined, () => undefined).then(() => this.syncEntry(entry))))
  }

  /**
   * Sync the repositories that never synced or whose last sync is at least
   * `maxAgeMs` old, and join syncs already running.
   * @param maxAgeMs - age threshold; 0 syncs every repository.
   * @returns when those syncs settled.
   */
  async refresh(maxAgeMs: number): Promise<void> {
    const now = this.now()
    await Promise.all(this.entries
      .filter(entry => entry.syncing !== undefined || entry.syncedAt === undefined || now - entry.syncedAt >= maxAgeMs)
      .map(entry => this.syncEntry(entry)))
  }

  /**
   * Whether an address is configured.
   * @param url - git address.
   * @returns whether it is in the current configuration.
   */
  has(url: string): boolean {
    return this.entries.some(entry => entry.spec.url === url)
  }

  /** @returns the panel view of every configured repository. */
  status(): RepoStatusWire[] {
    const duplicates = this.duplicateIds()
    return this.entries.map((entry) => {
      const duplicate = entry.app !== undefined ? duplicates.get(entry.app.id) : undefined
      const conflict = duplicate !== undefined && duplicate.length > 1
        ? `应用 id「${entry.app?.id}」同时出现在 ${duplicate.join('、')}，这些仓库均不可用`
        : undefined
      const phase = entry.syncing !== undefined ? 'syncing' : entry.app !== undefined ? 'ready' : entry.error !== undefined ? 'failed' : 'pending'
      const error = conflict ?? entry.error
      return {
        url: entry.spec.url,
        ...entry.spec.branch === undefined ? {} : { branch: entry.spec.branch },
        ...entry.dir === undefined ? {} : { dir: entry.dir },
        phase,
        ...entry.commit === undefined ? {} : { commit: entry.commit },
        ...entry.commitTime === undefined ? {} : { commitTime: entry.commitTime },
        ...entry.syncedAt === undefined ? {} : { syncedAt: entry.syncedAt },
        ...entry.app === undefined ? {} : { app: entry.app },
        ...error === undefined ? {} : { error },
        available: entry.app !== undefined && conflict === undefined,
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
      ready.push({ entry, ready: { app: entry.app, url: entry.spec.url, commit: entry.commit } })
    }
    return ready
  }

  /**
   * Find one usable application.
   * @param id - application id.
   * @returns the application with its repository and latest synced commit.
   * @throws when the id does not name a usable application; the message says why and lists the usable ids.
   */
  readyApp(id: string): ReadyApp {
    const found = this.readyApps().find(ready => ready.app.id === id)
    if (found === undefined) throw new Error(this.unknownMessage([id]))
    return found
  }

  /**
   * Hold a snapshot of each requested application's latest synced commit for
   * one dispatch. Every id must resolve to a usable application, or nothing is
   * held.
   * @param ids - requested application ids (duplicates allowed).
   * @returns the lease.
   * @throws when an id is unknown, its repository is not usable, dsh-repo is unavailable, or a snapshot cannot be created.
   */
  async acquire(ids: readonly string[]): Promise<RepoLease> {
    const unique = [...new Set(ids)]
    const ready = new Map(this.readyEntries().map(item => [item.ready.app.id, item]))
    const missing = unique.filter(id => !ready.has(id))
    if (missing.length > 0) throw new Error(this.unknownMessage(missing))
    const service = requireRepos(this.deps.repos())
    const held = unique.map((id) => {
      const { entry, ready: app } = ready.get(id) as { entry: RepoEntry; ready: ReadyApp }
      entry.activeRuns += 1
      return { id, entry, app, snapshot: service.acquireSnapshot(app.url, app.commit) }
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
    for (const [index, outcome] of outcomes.entries()) {
      if (outcome.status === 'fulfilled') continue
      release()
      throw new Error(`应用「${held[index]?.id}」的代码快照创建失败：${messageOf(outcome.reason)}`)
    }
    return {
      apps: new Map(held.map(({ id, app }, index) => [id, { ...app, dir: (leases[index] as SnapshotLease).dir }])),
      release,
    }
  }

  /**
   * The panel view of one configured repository.
   * @param url - git address.
   * @returns its status, or undefined when it is not configured.
   */
  statusOf(url: string): RepoStatusWire | undefined {
    return this.status().find(repo => repo.url === url)
  }

  /**
   * Addresses that synced but have no application: the description or its
   * SKILL is missing or invalid at the latest synced commit.
   * @returns those addresses, ordered as configured.
   */
  setupPending(): string[] {
    return this.entries.filter(entry => entry.commit !== undefined && entry.app === undefined && entry.syncing === undefined).map(entry => entry.spec.url)
  }

  /**
   * Hold a snapshot of a configured repository's latest synced commit.
   * @param url - configured repository address.
   * @returns the commit, its read-only checkout, and the release; release exactly once.
   * @throws when the address is not configured or never synced, dsh-repo is unavailable, or the snapshot cannot be created.
   */
  async acquireRepo(url: string): Promise<{ readonly commit: string; readonly dir: string; release(): void }> {
    const entry = this.entries.find(item => item.spec.url === url)
    if (entry === undefined) throw new Error(`仓库 ${url} 不在应用仓库列表中`)
    const commit = entry.commit
    if (commit === undefined) throw new Error(`仓库 ${url} 还没有同步成功${entry.error === undefined ? '' : `：${entry.error}`}`)
    const service = requireRepos(this.deps.repos())
    entry.activeRuns += 1
    this.deps.onChange()
    let lease: SnapshotLease
    try {
      lease = await service.acquireSnapshot(url, commit)
    } catch (error) {
      entry.activeRuns -= 1
      this.deps.onChange()
      throw new Error(`仓库 ${url} 的代码快照创建失败：${messageOf(error)}`)
    }
    let released = false
    return {
      commit,
      dir: lease.dir,
      release: () => {
        if (released) return
        released = true
        lease.release()
        entry.activeRuns -= 1
        this.deps.onChange()
      },
    }
  }

  /**
   * The branch the last successful sync of a configured address resolved: the
   * configured branch, or the remote's default branch when none is configured.
   * @param url - configured repository address.
   * @returns the branch.
   * @throws when the address is not configured or has not synced yet.
   */
  branchOf(url: string): string {
    const entry = this.entries.find(item => item.spec.url === url)
    if (entry === undefined) throw new Error(`仓库 ${url} 已不在配置中`)
    if (entry.branch === undefined) throw new Error(`仓库 ${url} 还没有同步成功`)
    return entry.branch
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

  private duplicateIds(): Map<string, string[]> {
    const urls = new Map<string, string[]>()
    for (const entry of this.entries) {
      if (entry.app === undefined) continue
      urls.set(entry.app.id, [...urls.get(entry.app.id) ?? [], entry.spec.url])
    }
    return urls
  }

  private syncEntry(entry: RepoEntry): Promise<void> {
    if (entry.syncing !== undefined) return entry.syncing
    const run = this.runSync(entry).finally(() => {
      entry.syncing = undefined
      this.deps.onChange()
    })
    entry.syncing = run
    this.deps.onChange()
    return run
  }

  private async runSync(entry: RepoEntry): Promise<void> {
    if (entry.retired) return
    let service: DshRepos
    let head: { dir: string; branch: string; commit: string; commitTime: string }
    try {
      service = requireRepos(this.deps.repos())
      head = await service.syncMirror(entry.spec.url, entry.spec.branch === undefined ? {} : { branch: entry.spec.branch })
    } catch (error) {
      entry.syncedAt = this.now()
      entry.error = entry.commit !== undefined && entry.app !== undefined
        ? `更新失败，继续使用已有提交 ${entry.commit.slice(0, 8)}：${messageOf(error)}`
        : messageOf(error)
      return
    }
    const manifest = await checkAppManifest(path => service.readMirrorFile(entry.spec.url, head.commit, path))
    entry.syncedAt = this.now()
    entry.dir = head.dir
    entry.branch = head.branch
    entry.commit = head.commit
    entry.commitTime = head.commitTime
    if (manifest.ok) {
      entry.app = manifest.app
      entry.error = undefined
    } else {
      entry.app = undefined
      entry.error = manifest.error
    }
  }
}
