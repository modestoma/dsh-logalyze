/**
 * 跟随 dsh-repo 的仓库清单：应用仓库是清单中打开了「日志分析」功能的仓库。
 *
 * - 启动时读一次清单并拉取全部仓库；之后 dsh-repo 重新加载（服务实例变了）
 *   时重新读清单并全部重新拉取，启动时已经拉取过的同一个实例不再重拉。
 * - 清单变化时只拉取新增或改了分支的仓库；主机、令牌或镜像目录变化时全部
 *   重新拉取，新令牌不用手动同步就能生效。
 * - 在对话中添加仓库经 dsh-repo 写入清单（由 dsh-repo 授权和审批），新条目权限为「可改代码」。
 *
 * @module dsh-logalyze/apps/catalog
 */

import { LOG_ANALYSIS_FEATURE } from '../deps/repos.ts'
import type { ReposClient } from '../deps/repos.ts'
import type { CallerAgent, DshRepos } from '../deps/repos-contract.ts'
import type { RepoSpec } from '../settings/contract.ts'
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
    this.syncedWith = lookup.availability === 'ready' ? lookup.service : undefined
    const { registry } = this.deps
    registry.configure(await this.deps.repos.appRepos())
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
        .catch((error: unknown) => { this.deps.error(`logalyze: 仓库清单变更后同步仓库失败：${messageOf(error)}`) })
    })
    const stopHosts = service.hostOnChange(() => {
      if (!this.deps.active()) return
      void this.deps.registry.resyncAll().catch((error: unknown) => {
        this.deps.error(`logalyze: 主机变更后同步仓库失败：${messageOf(error)}`)
      })
    })
    return () => {
      stopHosts()
      stopCatalog()
      unregister()
    }
  }

  /**
   * Add one repository to the dsh-repo catalog with the log analysis feature
   * turned on, or turn the feature on for the entry holding it. A new entry
   * gets `write` access, which drafting setups and SKILL improvements push
   * with; an existing entry keeps its access. dsh-repo authorizes and, while
   * its settings say so, asks the Agent's user to approve.
   * @param spec - validated repository.
   * @param caller - the Agent the change is made for, its tool call, and cancellation.
   * @returns `exists` when the catalog already had the feature on for it, and the address as the catalog stores it.
   * @throws the dsh-repo failure (`declined`, `forbidden`, `conflict` for another branch, `not-allowed`), or when dsh-repo is missing or incompatible.
   */
  async add(spec: RepoSpec, caller: { readonly agent: CallerAgent; readonly callId?: string; readonly signal: AbortSignal }): Promise<{ readonly status: 'added' | 'exists'; readonly url: string }> {
    const result = await this.deps.repos.require().repoAdd({
      repo: spec.url,
      ...spec.branch === undefined ? {} : { branch: spec.branch },
      access: 'write',
      features: [LOG_ANALYSIS_FEATURE.id],
      agent: caller.agent,
      ...caller.callId === undefined ? {} : { callId: caller.callId },
      signal: caller.signal,
    })
    // The catalog listener has configured the registry already unless it was not subscribed yet.
    if (!this.deps.registry.has(result.repo.url)) this.deps.registry.configure(await this.deps.repos.appRepos())
    return { status: result.status === 'unchanged' ? 'exists' : 'added', url: result.repo.url }
  }
}
