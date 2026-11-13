/**
 * 跟随 dsh-repo 的仓库清单：
 * - 「日志分析」（`log-analysis`）仓库作为观象应用仓库同步与租借快照；
 * - 「MR 自动评审」（`mr-review`）仓库作为审微监管仓库跟踪并在面板展示。
 *
 * 仓库地址、分支、权限与镜像拉取均归 dsh-repo 管理；本模块在 dsh-repo 服务可用时同时注册
 * `LOG_ANALYSIS_FEATURE` 与 `MR_REVIEW_FEATURE` 两项开关。
 *
 * @module dsh-logalyze/apps/catalog
 */

import { LOG_ANALYSIS_FEATURE, MR_REVIEW_FEATURE } from '../deps/repos.ts'
import type { MrReviewRepo, ReposClient } from '../deps/repos.ts'
import type { DshRepos } from '../deps/repos-contract.ts'
import type { MrRepoStatusWire } from '../settings/contract.ts'
import { messageOf } from '../util/errors.ts'
import type { RepoRegistry } from './registry.ts'

/** Collaborators of the follower. */
export interface CatalogFollowerDeps {
  readonly registry: RepoRegistry
  readonly repos: ReposClient
  /** Whether the plugin is still running; nothing is started after it stops. */
  active(): boolean
  readonly error: (message: string) => void
}

function toMrWire(repos: readonly MrReviewRepo[]): MrRepoStatusWire[] {
  return repos.map(({ url, branch, base, writable }) => ({
    url,
    ...(branch === undefined ? {} : { branch }),
    ...(base === undefined ? {} : { base }),
    writable,
  }))
}

/** Keeps the registry's log-analysis and mr-review repositories synced with `dsh-repo`. */
export class CatalogFollower {
  /** The service instance the repositories were last fully synced against. */
  private syncedWith: DshRepos | undefined

  /** @param deps - registry, `dshRepos`, and lifecycle. */
  constructor(private readonly deps: CatalogFollowerDeps) {}

  /**
   * Read the catalog and sync every repository; called once at boot.
   * @returns when every sync settled.
   */
  async load(): Promise<void> {
    await this.reload(false)
  }

  /**
   * React to dsh-repo appearing after boot or reloading: read the catalog and
   * sync every repository again, unless boot already did so with the same service.
   * @returns when the syncs settled.
   */
  async serviceAppeared(): Promise<void> {
    const lookup = this.deps.repos.lookup()
    if (lookup.availability === 'ready' && lookup.service === this.syncedWith) return
    await this.reload(true)
  }

  private async reload(resync: boolean): Promise<void> {
    const lookup = this.deps.repos.lookup()
    const { registry } = this.deps
    this.syncedWith = undefined
    const [appSpecs, mrSpecs] = await Promise.all([
      this.deps.repos.appRepos(),
      this.deps.repos.mrReviewRepos(),
    ])
    registry.configure(appSpecs)
    registry.configureMrRepos(toMrWire(mrSpecs))
    // Only a catalog that was read counts as synced, so a failed read is retried when the service appears again.
    this.syncedWith = lookup.availability === 'ready' ? lookup.service : undefined
    await (resync ? registry.resyncAll() : registry.syncAll())
  }

  /**
   * Register both `log-analysis` and `mr-review` features with dsh-repo and follow its catalog and host changes.
   * @param service - the `dshRepos` service.
   * @returns disposer that withdraws both features and stops watching.
   */
  watch(service: DshRepos): () => void {
    const unregisterLog = service.featureRegister(LOG_ANALYSIS_FEATURE)
    const unregisterMr = service.featureRegister(MR_REVIEW_FEATURE)
    const stopCatalog = service.repoOnChange(() => {
      if (!this.deps.active()) return
      void Promise.all([this.deps.repos.appRepos(), this.deps.repos.mrReviewRepos()])
        .then(([appSpecs, mrSpecs]) => {
          if (!this.deps.active()) return undefined
          this.deps.registry.configureMrRepos(toMrWire(mrSpecs))
          return this.deps.registry.syncUrls(this.deps.registry.configure(appSpecs))
        })
        .catch((error: unknown) => { this.deps.error(`logalyze: 仓库清单变更后读取仓库失败：${messageOf(error)}`) })
    })
    const stopHosts = service.hostOnChange(() => {
      if (!this.deps.active()) return
      void this.deps.registry.resyncAll().catch((error: unknown) => {
        this.deps.error(`logalyze: 主机变更后读取仓库失败：${messageOf(error)}`)
      })
    })
    return () => {
      stopHosts()
      stopCatalog()
      unregisterMr()
      unregisterLog()
    }
  }
}
