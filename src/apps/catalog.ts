/**
 * 跟随 dsh-repo 的仓库清单：应用仓库是清单中打开了「日志分析」功能的仓库。
 *
 * - 仓库只能在 dsh-repo 的设置页添加；镜像的拉取和拉取状态也归 dsh-repo。观象
 *   只经快照读取各仓库的应用描述。
 * - 启动时读一次清单并读取全部仓库；之后 dsh-repo 重新加载（服务实例变了）
 *   时重新读清单并全部重新读取，启动时已经读取过的同一个实例不再重读。
 * - 清单变化时只读取新增或改了日志分析分支的仓库；主机、令牌或镜像目录变化时
 *   全部重新读取，新令牌不用手动操作就能生效。
 *
 * @module dsh-logalyze/apps/catalog
 */

import { LOG_ANALYSIS_FEATURE } from '../deps/repos.ts'
import type { ReposClient } from '../deps/repos.ts'
import type { DshRepos } from '../deps/repos-contract.ts'
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

/** Keeps the registry's repositories equal to the catalog's log analysis repositories. */
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
    registry.configure(await this.deps.repos.appRepos())
    // Only a catalog that was read counts as synced, so a failed read is retried when the service appears again.
    this.syncedWith = lookup.availability === 'ready' ? lookup.service : undefined
    await (resync ? registry.resyncAll() : registry.syncAll())
  }

  /**
   * Register the log analysis feature with dsh-repo and follow its catalog and host changes.
   * @param service - the `dshRepos` service.
   * @returns disposer that withdraws the feature and stops watching.
   */
  watch(service: DshRepos): () => void {
    const unregister = service.featureRegister(LOG_ANALYSIS_FEATURE)
    const stopCatalog = service.repoOnChange(() => {
      if (!this.deps.active()) return
      void this.deps.repos.appRepos()
        .then(specs => this.deps.active() ? this.deps.registry.syncUrls(this.deps.registry.configure(specs)) : undefined)
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
      unregister()
    }
  }
}
