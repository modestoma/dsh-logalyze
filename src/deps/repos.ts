/**
 * 智能监管中心访问 `dshRepos` 服务的唯一入口：
 * - 基础仓库目录、只读快照与可写工作区兼容 `version === 7 || version === 8`；
 * - MR 自动评审的行级评论与增量感知方法要求 `version === 8`，遇到 v7 时给出明确升级提示；
 * - 同时向 `dsh-repo` 注册两项仓库功能开关：`LOG_ANALYSIS_FEATURE`（`log-analysis`）与 `MR_REVIEW_FEATURE`（`mr-review`）。
 *
 * @module dsh-logalyze/deps/repos
 */

import type { MrRepoStatusWire, RepoSpec, ReposWire } from '../settings/contract.ts'
import type { DshRepos, DshReposReviewVersion, DshReposV8, DshReposVersion, RepoAccess, SnapshotLease } from './repos-contract.ts'

/** Name the service is provided under. */
export const DSH_REPOS_SERVICE = 'dshRepos'

/** Contract versions accepted for repository catalog, snapshots, and workspaces. */
export const DSH_REPOS_COMPATIBLE_VERSIONS = [7, 8] as const satisfies readonly DshReposVersion[]

/** Latest `dshRepos` contract version (required for MR inline review). */
export const DSH_REPOS_VERSION: DshReposReviewVersion = 8

/** `dshRepos` contract version required for MR inline review and discussions. */
export const DSH_REPOS_REVIEW_VERSION: DshReposReviewVersion = 8

/** Log supervision repository switch registered in `dsh-repo`. */
export const LOG_ANALYSIS_FEATURE = {
  id: 'log-analysis',
  title: '日志分析',
  description: '智能监管（观象）从这些仓库读取代码与可选 SKILL；应用描述与触发别名在智能监管面板配置',
} as const

/** MR supervision repository switch registered in `dsh-repo`. */
export const MR_REVIEW_FEATURE = {
  id: 'mr-review',
  title: 'MR 自动评审',
  description: '智能监管（审微）自动发现这些仓库的新合并请求，并在新提交与新评论到来时持续增量重审',
} as const

const V8_REVIEW_METHODS = [
  'mrList',
  'mrGet',
  'mrDiff',
  'mrStatus',
  'mrCompare',
  'mrDiscussions',
  'mrReview',
  'mrDiscussionReply',
  'mrDiscussionResolve',
  'currentBotUser',
] as const satisfies readonly (keyof DshReposV8)[]

/** A catalog repository with the log analysis feature, as the registry follows it. */
export interface AppRepo extends RepoSpec {
  /** Whether the catalog entry's access lets SKILL improvements push (`write` or `merge`). */
  readonly writable: boolean
}

/** A catalog repository with the MR review feature turned on. */
export interface MrReviewRepo extends MrRepoStatusWire {
  readonly id: string
  readonly access: RepoAccess
}

/** Result of looking up base `dshRepos` (v7 or v8). */
export type ReposLookup =
  | { readonly availability: 'ready'; readonly service: DshRepos; readonly version: DshReposVersion }
  | { readonly availability: 'missing' | 'incompatible' }

/** Result of looking up `dshRepos` v8 for MR review operations. */
export type ReposV8Lookup =
  | { readonly availability: 'ready'; readonly service: DshReposV8 }
  | { readonly availability: 'upgrade-required'; readonly currentVersion: 7 }
  | { readonly availability: 'missing' | 'incompatible' }

function isBaseVersion(version: unknown): version is DshReposVersion {
  return version === 7 || version === 8
}

/**
 * Classify `ctx.get('dshRepos')` for base repository catalog / snapshot / workspace calls.
 * Accepts both v7 and v8.
 */
export function lookupRepos(value: unknown): ReposLookup {
  if (value === undefined || value === null) return { availability: 'missing' }
  const version = (value as { version?: unknown }).version
  if (!isBaseVersion(version)) return { availability: 'incompatible' }
  return { availability: 'ready', service: value as DshRepos, version }
}

/**
 * Classify `ctx.get('dshRepos')` for v8 MR review calls.
 * Distinguishes v7 (`upgrade-required`) so callers get a clear upgrade prompt.
 */
export function lookupReposV8(value: unknown): ReposV8Lookup {
  if (value === undefined || value === null) return { availability: 'missing' }
  const candidate = value as Partial<Record<keyof DshReposV8, unknown>>
  if (candidate.version === 7) return { availability: 'upgrade-required', currentVersion: 7 }
  if (candidate.version !== DSH_REPOS_REVIEW_VERSION) return { availability: 'incompatible' }
  for (const method of V8_REVIEW_METHODS) {
    if (typeof candidate[method] !== 'function') {
      return { availability: 'incompatible' }
    }
  }
  return { availability: 'ready', service: value as DshReposV8 }
}

/**
 * Readable error message when base `dshRepos` (v7/v8) cannot be used.
 */
export function unavailableMessage(availability: 'missing' | 'incompatible'): string {
  return availability === 'missing'
    ? `智能监管需要 dsh-repo 插件提供的 ${DSH_REPOS_SERVICE} 服务来读取仓库和提交修改；请安装 dsh-repo`
    : `dsh-repo 的 ${DSH_REPOS_SERVICE} 服务与智能监管不兼容（需要服务版本 7 或 8）；请升级 dsh-repo`
}

/**
 * Readable error message when `dshRepos` v8 MR review capabilities cannot be used.
 */
export function unavailableV8Message(availability: 'missing' | 'incompatible' | 'upgrade-required'): string {
  if (availability === 'missing') {
    return `MR 自动评审需要 dsh-repo 插件提供的 ${DSH_REPOS_SERVICE} 服务；请安装 dsh-repo（服务版本 ${DSH_REPOS_REVIEW_VERSION}）`
  }
  if (availability === 'upgrade-required') {
    return `dsh-repo 当前服务版本为 7，MR 自动评审需要 ${DSH_REPOS_SERVICE} 服务版本 ${DSH_REPOS_REVIEW_VERSION}（支持行级评论与讨论线程）；请升级 dsh-repo`
  }
  return `dsh-repo 的 ${DSH_REPOS_SERVICE} 服务与 MR 自动评审不兼容（需要服务版本 ${DSH_REPOS_REVIEW_VERSION}）；请升级 dsh-repo`
}

/**
 * The failure class of a `dshRepos` rejection.
 */
export function repoErrorCode(error: unknown): string | undefined {
  if (!(error instanceof Error) || error.name !== 'RepoError') return undefined
  const code = (error as Error & { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

/**
 * The approval outcome of a `declined` rejection.
 */
export function declinedOutcome(error: unknown): 'rejected' | 'cancelled' | 'unavailable' | undefined {
  if (repoErrorCode(error) !== 'declined') return undefined
  const outcome = (error as Error & { outcome?: unknown }).outcome
  return outcome === 'cancelled' || outcome === 'unavailable' ? outcome : 'rejected'
}

/** Runtime accessor for `dshRepos`, looked up dynamically on each call. */
export class ReposClient {
  /** @param get - returns what `ctx.get('dshRepos')` returns now. */
  constructor(private readonly get: () => unknown) {}

  /** @returns usable v7/v8 service, or why there is none. */
  lookup(): ReposLookup {
    return lookupRepos(this.get())
  }

  /** @returns usable v8 review service, or why there is none. */
  lookupV8(): ReposV8Lookup {
    return lookupReposV8(this.get())
  }

  /**
   * Require base `dshRepos` (v7 or v8).
   * @throws Error with {@link unavailableMessage} when missing or incompatible.
   */
  require(): DshRepos {
    const lookup = this.lookup()
    if (lookup.availability !== 'ready') throw new Error(unavailableMessage(lookup.availability))
    return lookup.service
  }

  /**
   * Require `dshRepos` v8 for MR review operations.
   * @throws Error with {@link unavailableV8Message} when missing, incompatible, or still on v7.
   */
  requireV8(): DshReposV8 {
    const lookup = this.lookupV8()
    if (lookup.availability !== 'ready') throw new Error(unavailableV8Message(lookup.availability))
    return lookup.service
  }

  /**
   * Catalog repositories with the `log-analysis` feature turned on.
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

  /**
   * Catalog repositories with the `mr-review` feature turned on.
   */
  async mrReviewRepos(): Promise<MrReviewRepo[]> {
    const lookup = this.lookup()
    if (lookup.availability !== 'ready') return []
    const repos = await lookup.service.repoList({ feature: MR_REVIEW_FEATURE.id })
    return repos.map((repo) => {
      const branch = repo.features.find(feature => feature.id === MR_REVIEW_FEATURE.id)?.branch ?? repo.base
      return {
        id: repo.id,
        url: repo.url,
        ...(branch === undefined ? {} : { branch }),
        ...(repo.base === undefined ? {} : { base: repo.base }),
        access: repo.access,
        writable: repo.access !== 'read',
      }
    })
  }

  /** @returns the provider's mirror directory, or undefined while unavailable. */
  mirrorDir(): string | undefined {
    const lookup = this.lookup()
    return lookup.availability === 'ready' ? lookup.service.settingsGet().mirrorDir : undefined
  }

  /** @returns the panel view of the `dshRepos` provider (including v8 MR review readiness). */
  panelState(): ReposWire {
    const lookup = this.lookup()
    if (lookup.availability !== 'ready') return { availability: lookup.availability }
    const { mirrorDir, mirrorProblem } = lookup.service.settingsGet()
    const v8 = this.lookupV8()
    return {
      availability: 'ready',
      version: lookup.version,
      mrReviewReady: v8.availability === 'ready',
      ...(v8.availability === 'ready' ? {} : { mrReviewProblem: unavailableV8Message(v8.availability) }),
      ...(mirrorDir === undefined ? {} : { mirrorDir }),
      ...(mirrorProblem === undefined ? {} : { mirrorProblem }),
    }
  }

  /**
   * Hold a snapshot while `use` runs, always releasing it afterwards.
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
