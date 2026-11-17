/**
 * 智能监管（dsh-supervisor）—— DeepSeek Harness AI 原生智能监管中心底座运行时（观象日志监管 + 审微 MR 监管）。
 *
 * 从 `dsh-repo` 的仓库目录读取启用「日志分析」与「MR 自动评审」的代码仓库，提供：
 * - `dsh_supervisor` 共享监管运行时（7 张强类型状态表、并发池、键控防抖器、滑动窗口熔断器、单调修订 Outbox）；
 * - 跨插件窄契约（`dshRepos` v7/v8 与 `feishuActions` v1）；
 * - 面板归属的应用描述与触发别名设置、可选 DSH SKILL 发现与加载、分析派发、日志平台轮询与报告回传。
 *
 * 插件不对外开放 HTTP 接口：日志由观象定时轮询日志平台取得。
 *
 * Cordis 插件名与配置 ID 为 `supervisor`，npm 包名为 `dsh-supervisor`。
 *
 * @module dsh-supervisor
 */

import { SUPERVISOR_APPLICATIONS_SERVICE } from './apps/access.ts'
import { resolveConfig, retiredConfigKeys } from './config.ts'
import { FEISHU_ACTIONS_SERVICE, FEISHU_ACTIONS_VERSION, lookupActions } from './deps/actions.ts'
import { FEISHU_BITABLE_SERVICE, FEISHU_BITABLE_VERSION, lookupBitable, parseBitableUrl } from './deps/bitable.ts'
import { DSH_REPOS_SERVICE, LOG_ANALYSIS_FEATURE, lookupRepos, lookupReposV8, MR_REVIEW_FEATURE } from './deps/repos.ts'
import { FEISHU_TOPICS_SERVICE } from './deps/topics.ts'
import type { HostContext } from './host.ts'
import { SupervisorService } from './service.ts'
import type { ServiceOptions } from './service.ts'
import { defaultOverlayPath, OverlayStore } from './settings/overlay.ts'
import { mountSettingsRoutes } from './settings/routes.ts'
import { loadBundledSkills } from './skill/bundled.ts'
import { messageOf } from './util/errors.ts'

export type * from './settings/contract.ts'
export type * from './deps/repos-contract.ts'
export type * from './deps/actions-contract.ts'
export type * from './deps/bitable-contract.ts'
export * from './runtime/index.ts'
export * from './issues/memory.ts'
export * from './issues/bitable-sync.ts'
export * from './log/index.ts'
export * from './mr/index.ts'
export type { ApplicationAccess } from './apps/access.ts'
export type { LeasedApp, ReadyApp, RepoLease } from './apps/registry.ts'
export {
  DSH_REPOS_SERVICE,
  FEISHU_ACTIONS_SERVICE,
  FEISHU_ACTIONS_VERSION,
  FEISHU_BITABLE_SERVICE,
  FEISHU_BITABLE_VERSION,
  LOG_ANALYSIS_FEATURE,
  SUPERVISOR_APPLICATIONS_SERVICE,
  lookupActions,
  lookupBitable,
  lookupRepos,
  lookupReposV8,
  MR_REVIEW_FEATURE,
  parseBitableUrl,
}
export type { SupervisorConfig } from './config.ts'

/** Cordis plugin name (matches `id: supervisor` in `cordis.patch.yml`). */
export const name = 'supervisor'

/** Host services the plugin needs before `apply()`. */
export const inject = ['tools', 'skills', 'subagents', 'storageDomain'] as const

/** Standard Schema the loader validates `config` with before `apply()`. */
export { pluginConfigSchema as Config } from './config.ts'

/** Direct-invocation options (tests and embedding hosts). */
export interface SupervisorPluginOptions extends ServiceOptions {
  /** Overlay file path; defaults to `$DSH_HOME/supervisor/settings.json`. */
  readonly overlayPath?: string
}

/**
 * Install the supervision runtime, entry skill, bundled guide skills, analysis and
 * SKILL improvement tools, and settings routes, then follow `dsh-repo`
 * catalog and host changes for both `log-analysis` and `mr-review` features.
 * @param ctx - plugin context.
 * @param config - loader-validated configuration.
 * @param options - test seams.
 */
export function apply(ctx: HostContext, config?: unknown, options: SupervisorPluginOptions = {}): void {
  const bundled = loadBundledSkills(new URL('../skills/', import.meta.url))
  const retired = retiredConfigKeys(config)
  if (retired.length > 0) {
    ctx.logger?.warn?.('supervisor: 日志平台分析接口已下线，配置项 %s 不再生效，可以删除', retired.join('、'))
  }
  const service = new SupervisorService(ctx, resolveConfig(config), new OverlayStore(options.overlayPath ?? defaultOverlayPath()), { bundled }, options)
  service.registerSkill()
  service.registerTools()
  mountSettingsRoutes(ctx, service)
  ctx.effect(() => {
    void service.boot().catch((error: unknown) => {
      ctx.logger?.error?.('supervisor: 启动失败：%s', messageOf(error))
    })
    return () => service.shutdown()
  }, 'supervisor: repositories')
  // Check reports waiting for their first turn whenever the Feishu channel plugin's service appears.
  ctx.inject?.([FEISHU_TOPICS_SERVICE], () => {
    void service.topicsAvailable().catch((error: unknown) => {
      ctx.logger?.error?.('supervisor: 核对分析报告失败：%s', messageOf(error))
    })
  })
  // Retry deferred follow-up action button cards whenever the Feishu actions service appears.
  ctx.inject?.([FEISHU_ACTIONS_SERVICE], () => {
    void service.actionsAvailable().catch((error: unknown) => {
      ctx.logger?.error?.('supervisor: 补发飞书动作按钮卡片失败：%s', messageOf(error))
    })
  })
  // Trigger pending Known Issues Bitable sync when `feishuBitable` registers or reloads.
  ctx.inject?.([FEISHU_BITABLE_SERVICE], () => {
    void service.bitableAvailable().catch((error: unknown) => {
      ctx.logger?.error?.('supervisor: 刷新飞书多维表格同步状态失败：%s', messageOf(error))
    })
  })
  // Whenever dsh-repo's service appears, including after it reloads: register
  // both `log-analysis` and `mr-review` features, follow catalog and host changes,
  // and take the enabled repositories from the catalog again.
  ctx.inject?.([DSH_REPOS_SERVICE], (child) => {
    const lookup = lookupRepos(child.get?.(DSH_REPOS_SERVICE))
    if (lookup.availability === 'ready') child.effect(() => service.watchRepos(lookup.service), 'supervisor: dsh-repo catalog')
    void service.reposAvailable().catch((error: unknown) => {
      ctx.logger?.error?.('supervisor: 同步仓库失败：%s', messageOf(error))
    })
  })
}
