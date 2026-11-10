/**
 * 观象 Logalyze —— DeepSeek Harness 日志分析插件。观其象，知其因。
 *
 * 提供入口 SKILL `/logalyze`（识别日志属于哪个应用；用户显式调用，或在
 * 任务匹配已注册应用时由顶层 Agent 自行加载）和
 * `logalyze_dispatch` 工具（按应用派发子 Agent，工作目录为该应用的代码
 * 仓库，首条消息用 `/<skill>` 加载仓库里的日志分析 SKILL），以及 SKILL 改进
 * 工具：`logalyze_show_skill` 只读查看应用 SKILL；`logalyze_improve_skill` 在
 * 用户于分析结论之后的消息中同意改进时，由一个改进子 Agent 把该应用的所有改进点
 * 在运行目录的可写工作区里按 `/logalyze-improve` 改进 SKILL 并沉淀案例，经
 * `dshRepos` 服务推送到新分支并创建合并请求。应用仓库是 dsh-repo 仓库清单中
 * 打开了「日志分析」功能的仓库，只能在 dsh-repo 的设置页添加，镜像由 dsh-repo
 * 拉取；应用描述来自各仓库日志分析分支上的 `.agents/logalyze.yaml`。顶层 Agent
 * 还可以用 `logalyze_init_repo` / `logalyze_submit_init` 为缺少应用描述
 * 的仓库在工作区里起草并推送接入合并请求。另提供日志平台分析接口 `POST /open-api/logalyze`：
 * 调用方传一批日志平台的 log_id，观象作为 OAuth2 客户端向日志平台查元数据，
 * 经飞书渠道插件的 `feishuTopics` 服务在飞书群话题中开始分析，话题每轮结束后
 * 把报告作为新修订传到每份日志。
 *
 * @module dsh-logalyze
 */

import { mountAnalyzeRoute } from './analyze/server.ts'
import { resolveConfig } from './config.ts'
import { DSH_REPOS_SERVICE, lookupRepos } from './deps/repos.ts'
import { FEISHU_TOPICS_SERVICE } from './deps/topics.ts'
import type { HostContext } from './host.ts'
import { LogalyzeService } from './service.ts'
import type { ServiceOptions } from './service.ts'
import { defaultOverlayPath, OverlayStore } from './settings/overlay.ts'
import { mountSettingsRoutes } from './settings/routes.ts'
import { loadBundledSkills } from './skill/bundled.ts'
import { messageOf } from './util/errors.ts'

export type * from './settings/contract.ts'
export type { LogalyzeConfig } from './config.ts'

/** Cordis plugin name. */
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
 * Install the entry skill, the bundled guide skills, the dispatch, SKILL
 * view and improvement, and repository
 * onboarding tools, the settings routes, and the analyze route, then mirror
 * or update the application repositories (the dsh-repo catalog repositories
 * with the log analysis feature) in the background, again after each catalog
 * or host change in dsh-repo.
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
    return () => { service.shutdown() }
  }, 'logalyze: repositories')
  // Check reports waiting for their first turn whenever the Feishu channel plugin's service appears.
  ctx.inject?.([FEISHU_TOPICS_SERVICE], () => {
    void service.topicsAvailable().catch((error: unknown) => {
      ctx.logger?.error?.('logalyze: 核对分析报告失败：%s', messageOf(error))
    })
  })
  // Whenever dsh-repo's service appears, including after it reloads: register
  // the log analysis feature, follow its catalog and host changes, and take the
  // application repositories from the catalog again.
  ctx.inject?.([DSH_REPOS_SERVICE], (child) => {
    const lookup = lookupRepos(child.get?.(DSH_REPOS_SERVICE))
    if (lookup.availability === 'ready') child.effect(() => service.watchRepos(lookup.service), 'logalyze: dsh-repo catalog')
    void service.reposAvailable().catch((error: unknown) => {
      ctx.logger?.error?.('logalyze: 同步仓库失败：%s', messageOf(error))
    })
  })
}
