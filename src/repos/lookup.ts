/**
 * `dshRepos` 服务的查找。观象经它读取应用仓库的只读快照、在主机或令牌变更后
 * 重新拉取，并在工作区中起草 SKILL 改进与接入初稿、推送到新分支并创建合并请求
 * （GitLab MR 或 GitHub PR）。
 *
 * 观象需要的方法见 `./contract.ts`；服务在运行时经 `ctx.get('dshRepos')`
 * 取得，服务版本不符时不调用。
 *
 * @module dsh-logalyze/repos/lookup
 */

import type { DshRepos, DshReposVersion } from './contract.ts'

/** Name the service is provided under. */
export const DSH_REPOS_SERVICE = 'dshRepos'

/** The `dshRepos` contract version this plugin speaks. */
export const DSH_REPOS_VERSION: DshReposVersion = 6

/** The feature this plugin registers; it uses the catalog repositories that have it turned on. */
export const LOG_ANALYSIS_FEATURE = { id: 'log-analysis', title: '日志分析', description: '观象从这些仓库读取应用描述和日志分析 SKILL，并在派发时读取代码' } as const

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
 * Why the service cannot be used, as one line for the panel and tool errors.
 * @param availability - lookup outcome other than `ready`.
 * @returns the reason and the fix.
 */
export function unavailableMessage(availability: 'missing' | 'incompatible'): string {
  return availability === 'missing'
    ? `观象需要 dsh-repo 插件提供的 ${DSH_REPOS_SERVICE} 服务来拉取仓库和提交 SKILL 修改；请安装 dsh-repo`
    : `dsh-repo 的 ${DSH_REPOS_SERVICE} 服务与观象不兼容（需要服务版本 ${DSH_REPOS_VERSION}）；请换用兼容的 dsh-repo`
}

/**
 * The usable service, or a thrown error saying why there is none.
 * @param value - the looked-up service, or undefined.
 * @returns the service.
 * @throws Error with {@link unavailableMessage} when it is missing or incompatible.
 */
export function requireRepos(value: unknown): DshRepos {
  const lookup = lookupRepos(value)
  if (lookup.availability !== 'ready') throw new Error(unavailableMessage(lookup.availability))
  return lookup.service
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

/**
 * Readable message of a `dshRepos` rejection or any other thrown value.
 * @param error - the rejection.
 * @returns its message.
 */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
