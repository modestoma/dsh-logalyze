/**
 * `logalyze_add_repo`：在对话中把一个 git 地址加入观象的应用仓库列表，并等待
 * 第一次拉取结束。
 *
 * - 写入与设置面板相同的覆盖文件，面板随即显示该仓库；新增前经 DSH 审批服务
 *   请求一次性授权，只有 `allowed-once` 才写入，没有审批服务时工具报错。
 * - 地址已在列表中时不请求授权、不写入，只重新拉取并报告状态；分支不同时报错，
 *   改分支在设置面板完成。
 * - 取消调用只停止等待，拉取在后台继续。
 * - 结果说明下一步：应用可用；仓库已拉取但缺少应用描述或 SKILL 时用
 *   `logalyze_init_repo` 起草；拉取失败时给出原因。
 * - 子会话中不提供本工具。
 *
 * @module dsh-logalyze/onboard/add
 */

import { abortable } from '../abort.ts'
import { describeIssue, repoSchema } from '../config.ts'
import { isDelegatedAgent } from '../dispatch/tool.ts'
import type { ContentBlock, HostApproval, ToolDefinition, ToolRunContext } from '../host.ts'
import type { RepoRegistry } from '../repos/registry.ts'
import type { RepoSpec, RepoStatusWire } from '../settings/contract.ts'
import { ADD_REPO_TOOL_NAME, INIT_REPO_TOOL_NAME } from './names.ts'

/** How one call ended. */
export type AddRepoStatus = 'added' | 'exists' | 'rejected' | 'cancelled' | 'unavailable'

/**
 * Where the repository stands after the sync: `ready` offers its application,
 * `needs-setup` synced without a usable description or SKILL, `failed` did not
 * sync or its application id conflicts with another repository.
 */
export type RepoSetup = 'ready' | 'needs-setup' | 'failed'

/** Canonical tool value. */
export interface AddRepoValue {
  status: AddRepoStatus
  url: string
  /** Present unless the user declined (`rejected`, `cancelled`, `unavailable`). */
  setup?: RepoSetup
  /** The repository as the panel shows it; present with {@link setup}. */
  repo?: RepoStatusWire
}

const PARAMETERS: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['url'],
  properties: {
    url: { type: 'string', description: '应用代码仓库的 git 地址：https/ssh/git/file URL、user@host:path 或本机绝对路径。' },
    branch: { type: 'string', description: '要跟踪的远端分支；省略时跟随远端默认分支。' },
  },
}

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'url'],
  properties: {
    status: { type: 'string', enum: ['added', 'exists', 'rejected', 'cancelled', 'unavailable'] },
    url: { type: 'string' },
    setup: { type: 'string', enum: ['ready', 'needs-setup', 'failed'] },
    repo: { type: 'object' },
  },
} as const

/**
 * Model-facing rendering of one call.
 * @param value - canonical value.
 * @returns text content.
 */
export function renderAddRepoValue(value: AddRepoValue): ContentBlock[] {
  const declined = {
    rejected: '授权被拒绝，没有添加：用户拒绝了，或会话的审批策略为 never（例如「完全访问」权限模式）。',
    cancelled: '授权请求被撤回，没有添加。',
    unavailable: '当前没有可以回答授权请求的界面，没有添加。',
  }
  if (value.status === 'rejected' || value.status === 'cancelled' || value.status === 'unavailable') return [{ type: 'text', text: declined[value.status] }]
  const head = value.status === 'added' ? `已把 ${value.url} 加入观象的应用仓库列表。` : `${value.url} 已在观象的应用仓库列表中，已重新拉取。`
  const repo = value.repo
  const commit = repo?.commit === undefined ? '' : `（提交 ${repo.commit.slice(0, 12)}）`
  const next = value.setup === 'ready' && repo?.app !== undefined
    ? `应用「${repo.app.name}」（id: ${repo.app.id}）可用${commit}，可以用 /logalyze 分析它的日志。`
    : value.setup === 'needs-setup'
      ? `仓库已拉取${commit}，但还不能用：${repo?.error ?? '缺少应用描述'}。调用 ${INIT_REPO_TOOL_NAME} 起草应用描述和日志分析 SKILL；用户提供了样例日志时一并传入。`
      : `仓库还不能用：${repo?.error ?? '拉取没有完成'}。https 私有仓库需要在 dsh-repo 插件页为该主机配置令牌，配置后观象自动重新拉取；ssh 地址使用本机 SSH key。`
  return [{ type: 'text', text: `${head}${next}` }]
}

/** Collaborators of the tool. */
export interface AddRepoDeps {
  readonly registry: RepoRegistry
  /** DSH's approval service, when the composition has one. */
  approval(): HostApproval | undefined
  /**
   * Persist the repository in the panel settings and start syncing it.
   * @returns `exists` when it was already configured.
   */
  addRepo(spec: RepoSpec): Promise<'added' | 'exists'>
}

/** Adds repositories from a conversation. */
export class RepoAdder {
  /** @param deps - registry, approval, and settings access. */
  constructor(private readonly deps: AddRepoDeps) {}

  /**
   * Build the tool definition.
   * @returns the registration.
   */
  definition(): ToolDefinition<AddRepoValue> {
    return {
      name: ADD_REPO_TOOL_NAME,
      description: '观象：把一个应用代码仓库加入观象的应用仓库列表并等待拉取完成。用户要把仓库接入观象、用观象分析某个仓库的日志而它还没接入时使用。'
        + '工具先请求用户授权；结果说明应用是否可用，缺少应用描述或 SKILL 时提示起草。',
      parameters: PARAMETERS,
      output: {
        schema: OUTPUT_SCHEMA,
        render: (_args, value) => renderAddRepoValue(value),
      },
      isConcurrencySafe: () => false,
      execute: (args, exec) => this.execute(args, exec),
    }
  }

  /**
   * Add one repository and wait for its sync.
   * @param rawArgs - model arguments.
   * @param exec - execution context of the calling agent.
   * @returns how the call ended and where the repository stands.
   * @throws when the arguments are invalid, the address is configured with another branch, or no approval service is loaded; nothing is written then.
   */
  async execute(rawArgs: unknown, exec: ToolRunContext): Promise<AddRepoValue> {
    const parsed = repoSchema.safeParse(rawArgs)
    if (!parsed.success) throw new Error(`${ADD_REPO_TOOL_NAME} 参数不合法：${describeIssue(parsed.error)}`)
    const spec: RepoSpec = parsed.data.branch === undefined ? { url: parsed.data.url } : { url: parsed.data.url, branch: parsed.data.branch }
    const agent = exec.agent
    if (agent === undefined) throw new Error(`${ADD_REPO_TOOL_NAME} 需要由 Agent 调用`)
    if (isDelegatedAgent(agent)) throw new Error(`${ADD_REPO_TOOL_NAME} 不能在子 Agent 中调用`)
    const { registry } = this.deps

    const existing = registry.statusOf(spec.url)
    if (existing !== undefined) {
      if (spec.branch !== undefined && spec.branch !== existing.branch) {
        throw new Error(`${spec.url} 已在应用仓库列表中，跟踪${existing.branch === undefined ? '远端默认分支' : `分支 ${existing.branch}`}；改分支请在设置面板「应用仓库」中修改`)
      }
      return await this.settle('exists', spec.url, exec.signal)
    }

    const approval = this.deps.approval()
    if (approval === undefined) throw new Error('当前 DSH 组合没有审批服务（@deepseek-ai/dsh-user-approval），观象不会在未经授权时添加仓库')
    const branch = spec.branch === undefined ? '远端默认分支' : `分支 ${spec.branch}`
    const zh = `观象将把 ${spec.url}（${branch}）加入应用仓库列表并拉取，之后派发的子 Agent 会读取它的代码。`
    const en = `Logalyze will add ${spec.url} (${spec.branch ?? 'default branch'}) to its application repositories and mirror it; dispatched agents will read its code.`
    const outcome = await approval.request({
      agent,
      toolName: ADD_REPO_TOOL_NAME,
      ...exec.callId === undefined ? {} : { callId: exec.callId },
      reason: zh,
      displayReason: { en, zh },
      signal: exec.signal,
    })
    if (outcome === 'cancelled') exec.signal.throwIfAborted()
    if (outcome !== 'allowed-once') return { status: outcome, url: spec.url }
    exec.signal.throwIfAborted()
    return await this.settle(await this.deps.addRepo(spec), spec.url, exec.signal)
  }

  private async settle(status: 'added' | 'exists', url: string, signal: AbortSignal): Promise<AddRepoValue> {
    const { registry } = this.deps
    await abortable(registry.syncUrls([url]), signal)
    const repo = registry.statusOf(url)
    if (repo === undefined) throw new Error(`仓库 ${url} 已不在配置中`)
    const setup: RepoSetup = repo.available ? 'ready' : registry.setupPending().includes(url) ? 'needs-setup' : 'failed'
    return { status, url, setup, repo }
  }
}
