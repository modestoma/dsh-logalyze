/**
 * 观象 Logalyze —— DeepSeek Harness 日志分析插件。观其象，知其因。
 *
 * 提供入口 SKILL `/logalyze`（识别日志属于哪个应用；用户显式调用，或在
 * 任务匹配已注册应用时由顶层 Agent 自行加载）和
 * `logalyze_dispatch` 工具（按应用派发子 Agent，工作目录为该应用的代码
 * 仓库，首条消息用 `/<skill>` 加载仓库里的日志分析 SKILL），以及开启 SKILL
 * 改进时的 `logalyze_propose_skill` 工具（经用户授权后经 dsh-repo 把子 Agent
 * 的 SKILL 修改提议提交到新分支并创建合并请求）。应用仓库在设置
 * 面板中只填 git 地址，由插件拉取；应用描述来自各仓库的
 * `.agents/logalyze.yaml`。顶层 Agent 还可以用 `logalyze_add_repo` 在对话中
 * 添加仓库，并用 `logalyze_init_repo` / `logalyze_submit_init` 为缺少应用描述
 * 的仓库起草并提交接入合并请求。另提供日志平台分析接口 `POST /open-api/logalyze`，
 * 经 dsh-channels 的 `feishuTopics` 服务在飞书群话题中开始分析。
 *
 * @module dsh-logalyze
 */

import { mountAnalyzeRoute } from './analyze/server.ts'
import { resolveConfig } from './config.ts'
import type { HostContext } from './host.ts'
import { DSH_REPOS_SERVICE, lookupRepos } from './repos/lookup.ts'
import { LogalyzeService } from './service.ts'
import type { ServiceOptions } from './service.ts'
import { defaultOverlayPath, OverlayStore } from './settings/overlay.ts'
import { mountSettingsRoutes } from './settings/routes.ts'
import { loadKitSkill } from './skill/kit.ts'

export type * from './settings/contract.ts'
export type { LogalyzeConfig, SettingsOverlay } from './config.ts'
export { pluginConfigSchema, resolveConfig } from './config.ts'
export { DISPATCH_TOOL_NAME, Dispatcher } from './dispatch/tool.ts'
export type { DispatchValue, TaskResult } from './dispatch/tool.ts'
export { renderChildPrompt } from './dispatch/prompt.ts'
export { PROPOSE_TOOL_NAME, SkillUpdater } from './skill-update/tool.ts'
export type { DispatchedTask, ProposalCheck, ProposeStatus, ProposeValue } from './skill-update/tool.ts'
export { ADD_REPO_TOOL_NAME, INIT_REPO_TOOL_NAME, SUBMIT_INIT_TOOL_NAME } from './onboard/names.ts'
export { RepoAdder } from './onboard/add.ts'
export type { AddRepoStatus, AddRepoValue, RepoSetup } from './onboard/add.ts'
export { RepoInitializer } from './onboard/init.ts'
export type { DraftCheck, InitRepoValue, SubmitInitValue } from './onboard/init.ts'
export { ENTRY_SKILL_NAME, renderEntrySkill } from './skill/entry.ts'
export { KIT_SKILL_NAME } from './skill/kit.ts'
export { RepoRegistry } from './repos/registry.ts'
export { readAppManifest, MANIFEST_PATH } from './repos/manifest.ts'
export { LogalyzeService } from './service.ts'
export { ANALYZE_ROUTE, SETTINGS_ROUTE, STATE_ROUTE, SYNC_ROUTE } from './settings/contract.ts'
export { analyzeRequestHash, parseAnalyzeRequest } from './analyze/contract.ts'
export type { AnalyzeAccepted, AnalyzeRefused, AnalyzeRequest } from './analyze/contract.ts'

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
 * Install the entry skill, the dispatch, SKILL proposal, and repository
 * onboarding tools, the settings routes, and the analyze route, then mirror
 * or update the configured repositories in the background and again after
 * each dsh-repo host change.
 * @param ctx - plugin context.
 * @param config - loader-validated configuration.
 * @param options - test seams.
 */
export function apply(ctx: HostContext, config?: unknown, options: LogalyzePluginOptions = {}): void {
  const kit = loadKitSkill(new URL('../skills/logalyze-kit/SKILL.md', import.meta.url))
  const service = new LogalyzeService(ctx, resolveConfig(config), new OverlayStore(options.overlayPath ?? defaultOverlayPath()), { kit }, options)
  service.registerSkill()
  service.registerTool()
  mountSettingsRoutes(ctx, service)
  mountAnalyzeRoute(ctx, service.analyzeGate())
  ctx.effect(() => {
    void service.boot().catch((error: unknown) => {
      ctx.logger?.error?.('logalyze: 启动失败：%s', error instanceof Error ? error.message : String(error))
    })
    return () => { service.shutdown() }
  }, 'logalyze: repositories')
  // Sync again whenever dsh-repo's service appears, including after it reloads,
  // and after every host or token change made in it.
  ctx.inject?.([DSH_REPOS_SERVICE], (child) => {
    void service.reposAvailable().catch((error: unknown) => {
      ctx.logger?.error?.('logalyze: 同步仓库失败：%s', error instanceof Error ? error.message : String(error))
    })
    const lookup = lookupRepos(child.get?.(DSH_REPOS_SERVICE))
    if (lookup.availability === 'ready') child.effect(() => service.watchHosts(lookup.service), 'logalyze: dsh-repo host changes')
  })
}
