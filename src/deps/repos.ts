/**
 * 观象访问 `dshRepos` 服务的唯一入口：按名称查找服务并核对约定版本，把
 * 仓库清单换成观象的应用仓库，持有快照，并分类服务的失败。
 *
 * 观象需要的方法见 `./repos-contract.ts`；服务在运行时经
 * `ctx.get('dshRepos')` 取得，每次使用时重新查找，服务版本不符时不调用。
 *
 * @module dsh-logalyze/deps/repos
 */

import type { RepoSpec, ReposWire } from '../settings/contract.ts'
import type { DshRepos, DshReposVersion, SnapshotLease } from './repos-contract.ts'

/** Name the service is provided under. */
export const DSH_REPOS_SERVICE = 'dshRepos'

/** The `dshRepos` contract version this plugin speaks. */
export const DSH_REPOS_VERSION: DshReposVersion = 7

/** The feature this plugin registers; it uses the catalog repositories that have it turned on. */
export const LOG_ANALYSIS_FEATURE = { id: 'log-analysis', title: '日志分析', description: '观象从这些仓库读取应用描述和日志分析 SKILL，并在派发时读取代码' } as const

/** A catalog repository with the log analysis feature, as the registry follows it. */
export interface AppRepo extends RepoSpec {
  /** Whether the catalog entry's access lets drafting setups and SKILL improvements push (`write` or `merge`). */
  readonly writable: boolean
}

/** Result of looking the service up. */
export type ReposLookup =
  | { readonly availability: 'ready'; readonly service: DshRepos }
  | { readonly availability: 'missing' | 'incompatible' }

/**
 * Classify the value `ctx.get('dshRepos')` returned. The provider is another
 * package, so its contract version is checked at run time.
 * @param value - the looked-up service, or undefined.
 * @returns the usable service, or why there is none.
 */
export function lookupRepos(value: unknown): ReposLookup {
  if (value === undefined || value === null) return { availability: 'missing' }
  if ((value as { version?: unknown }).version !== DSH_REPOS_VERSION) return { availability: 'incompatible' }
  return { availability: 'ready', service: value as DshRepos }
}

/**
 * Why the service cannot be used, as one line for the panel and tool errors.
 * @param availability - lookup outcome other than `ready`.
 * @returns the reason and the fix.
 */
export function unavailableMessage(availability: 'missing' | 'incompatible'): string {
  return availability === 'missing'
    ? `观象需要 dsh-repo 插件提供的 ${DSH_REPOS_SERVICE} 服务来读取仓库和提交 SKILL 修改；请安装 dsh-repo`
    : `dsh-repo 的 ${DSH_REPOS_SERVICE} 服务与观象不兼容（需要服务版本 ${DSH_REPOS_VERSION}）；请换用兼容的 dsh-repo`
}

/**
 * The failure class of a `dshRepos` rejection.
 * @param error - the rejection.
 * @returns its `code` when it is a `RepoError`.
 */
export function repoErrorCode(error: unknown): string | undefined {
  if (!(error instanceof Error) || error.name !== 'RepoError') return undefined
  const code = (error as Error & { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

/**
 * The approval outcome of a `declined` rejection: the user refused, withdrew the request, or no interface could answer it.
 * @param error - the rejection.
 * @returns the outcome, or undefined for any other failure.
 */
export function declinedOutcome(error: unknown): 'rejected' | 'cancelled' | 'unavailable' | undefined {
  if (repoErrorCode(error) !== 'declined') return undefined
  const outcome = (error as Error & { outcome?: unknown }).outcome
  return outcome === 'cancelled' || outcome === 'unavailable' ? outcome : 'rejected'
}

/** The `dshRepos` service as this plugin uses it, looked up on every call. */
export class ReposClient {
  /** @param get - returns what `ctx.get('dshRepos')` returns now. */
  constructor(private readonly get: () => unknown) {}

  /** @returns the usable service, or why there is none. */
  lookup(): ReposLookup {
    return lookupRepos(this.get())
  }

  /**
   * The usable service.
   * @returns the service.
   * @throws Error with {@link unavailableMessage} when it is missing or incompatible.
   */
  require(): DshRepos {
    const lookup = this.lookup()
    if (lookup.availability !== 'ready') throw new Error(unavailableMessage(lookup.availability))
    return lookup.service
  }

  /**
   * The application repositories: the catalog repositories with the log
   * analysis feature turned on, each read at the feature's branch, else the
   * entry's baseline branch.
   * @returns them in catalog order; empty while the service is missing or incompatible.
   */
  async appRepos(): Promise<AppRepo[]> {
    const lookup = this.lookup()
    if (lookup.availability !== 'ready') return []
    const repos = await lookup.service.repoList({ feature: LOG_ANALYSIS_FEATURE.id })
    return repos.map((repo) => {
      const branch = repo.features.find(feature => feature.id === LOG_ANALYSIS_FEATURE.id)?.branch ?? repo.base
      return { url: repo.url, ...branch === undefined ? {} : { branch }, writable: repo.access !== 'read' }
    })
  }

  /** @returns the provider's mirror directory, or undefined while the service or the directory is unavailable. */
  mirrorDir(): string | undefined {
    const lookup = this.lookup()
    return lookup.availability === 'ready' ? lookup.service.settingsGet().mirrorDir : undefined
  }

  /** @returns the panel view of the provider. */
  panelState(): ReposWire {
    const lookup = this.lookup()
    if (lookup.availability !== 'ready') return { availability: lookup.availability }
    const { mirrorDir, mirrorProblem } = lookup.service.settingsGet()
    return { availability: 'ready', ...mirrorDir === undefined ? {} : { mirrorDir }, ...mirrorProblem === undefined ? {} : { mirrorProblem } }
  }

  /**
   * Hold a snapshot while `use` runs.
   * @param repo - catalog address.
   * @param ref - branch, tag, or commit; undefined: the catalog entry's baseline branch.
   * @param signal - cancellation.
   * @param use - work on the held snapshot.
   * @returns what `use` returned; the snapshot is released afterwards.
   * @throws when the service is unavailable, the snapshot cannot be created, or `use` throws.
   */
  async withSnapshot<T>(repo: string, ref: string | undefined, signal: AbortSignal | undefined, use: (lease: SnapshotLease) => Promise<T>): Promise<T> {
    const lease = await this.require().snapshotAcquire({ repo, ...ref === undefined ? {} : { ref }, ...signal === undefined ? {} : { signal } })
    try {
      return await use(lease)
    } finally {
      lease.release()
    }
  }
}
