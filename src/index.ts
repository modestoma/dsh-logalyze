/**
 * 智能监管（dsh-logalyze）—— DeepSeek Harness AI 原生智能监管中心底座运行时（观象日志监管 + 审微 MR 监管）。
 *
 * 从 `dsh-repo` 的仓库目录读取启用「日志分析」与「MR 自动评审」的代码仓库，提供：
 * - `dsh_supervisor` 共享监管运行时（7 张强类型状态表、并发池、键控防抖器、滑动窗口熔断器、单调修订 Outbox）；
 * - 跨插件窄契约（`dshRepos` v7/v8 与 `feishuActions` v1）；
 * - 面板归属的应用描述与触发别名设置、可选 DSH SKILL 发现与加载、分析派发与报告回传。
 *
 * 保持包名 `dsh-logalyze` 与 Cordis 插件名 `logalyze` 不变，确保 npm OIDC 发布及宿主装配完全兼容。
 *
 * @module dsh-logalyze
 */

import { mountAnalyzeRoute } from './analyze/server.ts'
import { LOGALYZE_APPLICATIONS_SERVICE } from './apps/access.ts'
import { resolveConfig } from './config.ts'
import { FEISHU_ACTIONS_SERVICE, FEISHU_ACTIONS_VERSION, lookupActions } from './deps/actions.ts'
import { DSH_REPOS_SERVICE, LOG_ANALYSIS_FEATURE, lookupRepos, lookupReposV8, MR_REVIEW_FEATURE } from './deps/repos.ts'
import { FEISHU_TOPICS_SERVICE } from './deps/topics.ts'
import type { HostContext } from './host.ts'
import { LogalyzeService } from './service.ts'
import type { ServiceOptions } from './service.ts'
import { defaultOverlayPath, OverlayStore } from './settings/overlay.ts'
import { mountSettingsRoutes } from './settings/routes.ts'
import { loadBundledSkills } from './skill/bundled.ts'
import { messageOf } from './util/errors.ts'

export type * from './settings/contract.ts'
export type * from './deps/repos-contract.ts'
export type * from './deps/actions-contract.ts'
export * from './runtime/index.ts'
export type { ApplicationAccess } from './apps/access.ts'
export type { LeasedApp, ReadyApp, RepoLease } from './apps/registry.ts'
export {
  DSH_REPOS_SERVICE,
  FEISHU_ACTIONS_SERVICE,
  FEISHU_ACTIONS_VERSION,
  LOG_ANALYSIS_FEATURE,
  LOGALYZE_APPLICATIONS_SERVICE,
  lookupActions,
  lookupRepos,
  lookupReposV8,
  MR_REVIEW_FEATURE,
}
export type { LogalyzeConfig } from './config.ts'

/** Cordis plugin name (kept stable for host loader and `cordis.patch.yml` compatibility). */
export const name = 'logalyze'

/** Host services the plugin needs before `apply()`. */
export const inject = ['tools', 'skills', 'subagents'] as const

/** Standard Schema the loader validates `config` with before `apply()`. */
export { pluginConfigSchema as Config } from './config.ts'

/** Direct-invocation options (tests and embedding hosts). */
export interface LogalyzePluginOptions extends ServiceOptions {
  /** Overlay file path; defaults to `$DSH_HOME/logalyze/settings.json`. */
  readonly overlayPath?: string
}

/**
 * Install the supervision runtime, entry skill, bundled guide skills, analysis and
 * SKILL improvement tools, settings routes, and analyze route, then follow `dsh-repo`
 * catalog and host changes for both `log-analysis` and `mr-review` features.
 * @param ctx - plugin context.
 * @param config - loader-validated configuration.
 * @param options - test seams.
 */
export function apply(ctx: HostContext, config?: unknown, options: LogalyzePluginOptions = {}): void {
  const bundled = loadBundledSkills(new URL('../skills/', import.meta.url))
  const service = new LogalyzeService(ctx, resolveConfig(config), new OverlayStore(options.overlayPath ?? defaultOverlayPath()), { bundled }, options)
  service.registerSkill()
  service.registerTools()
  mountSettingsRoutes(ctx, service)
  mountAnalyzeRoute(ctx, service.analyzeGate(), async (topics, request, key) => await service.acceptAnalysis(topics, request, key))
  ctx.effect(() => {
    void service.boot().catch((error: unknown) => {
      ctx.logger?.error?.('logalyze: 启动失败：%s', messageOf(error))
    })
    return () => service.shutdown()
  }, 'logalyze: repositories')
  // Check reports waiting for their first turn whenever the Feishu channel plugin's service appears.
  ctx.inject?.([FEISHU_TOPICS_SERVICE], () => {
    void service.topicsAvailable().catch((error: unknown) => {
      ctx.logger?.error?.('logalyze: 核对分析报告失败：%s', messageOf(error))
    })
  })
  // Whenever dsh-repo's service appears, including after it reloads: register
  // both `log-analysis` and `mr-review` features, follow catalog and host changes,
  // and take the enabled repositories from the catalog again.
  ctx.inject?.([DSH_REPOS_SERVICE], (child) => {
    const lookup = lookupRepos(child.get?.(DSH_REPOS_SERVICE))
    if (lookup.availability === 'ready') child.effect(() => service.watchRepos(lookup.service), 'logalyze: dsh-repo catalog')
    void service.reposAvailable().catch((error: unknown) => {
      ctx.logger?.error?.('logalyze: 同步仓库失败：%s', messageOf(error))
    })
  })
}
