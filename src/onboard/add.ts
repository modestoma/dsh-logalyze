/**
 * `logalyze_add_repo`：在对话中把一个 git 地址加入 dsh-repo 的仓库清单并打开
 * 「日志分析」功能，使它成为观象的应用仓库，并等待第一次拉取结束。
 *
 * - 仓库清单归 dsh-repo 所有：工具调用 `dshRepos.addRepo`，新条目的权限为
 *   「可改代码」（起草接入和改进 SKILL 要推送分支），已有条目只打开功能、权限
 *   不变。调用前先发 `access/authorize`（级别 `admin`）问其他插件这个会话能不能
 *   改仓库清单，被拒绝时工具报错、不问用户；再经 DSH 审批服务请求一次性授权，
 *   只有 `allowed-once` 才调用，没有审批服务时工具报错。dsh-repo 改动清单前
 *   会以同一级别再问一次。
 * - 地址已是应用仓库时不请求授权、不调用，只重新拉取并报告状态；分支不同时报错，
 *   改分支在 dsh-repo 的仓库清单中完成。
 * - 取消调用只停止等待，拉取在后台继续。
 * - 结果说明下一步：应用可用；仓库已拉取但缺少应用描述或 SKILL 时用
 *   `logalyze_init_repo` 起草；拉取失败时给出原因。
 * - 子会话中不提供本工具。
 *
 * @module dsh-logalyze/onboard/add
 */

import { abortable } from '../abort.ts'
import type { AuthorizeEvent } from '../access.ts'
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
    url: { type: 'string', description: '应用代码仓库的 https 地址（例如 https://github.com/example/order-service.git），主机须已在 dsh-repo 中配置；也接受 file URL 或本机绝对路径，不接受 ssh 地址。' },
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
  const head = value.status === 'added' ? `已把 ${value.url} 加入 dsh-repo 仓库清单并打开日志分析。` : `${value.url} 已是观象的应用仓库，已重新拉取。`
  const repo = value.repo
  const commit = repo?.commit === undefined ? '' : `（提交 ${repo.commit.slice(0, 12)}）`
  const next = value.setup === 'ready' && repo?.app !== undefined
    ? `应用「${repo.app.name}」（id: ${repo.app.id}）可用${commit}，可以用 /logalyze 分析它的日志。`
    : value.setup === 'needs-setup'
      ? `仓库已拉取${commit}，但还不能用：${repo?.error ?? '缺少应用描述'}。调用 ${INIT_REPO_TOOL_NAME} 起草应用描述和日志分析 SKILL；用户提供了样例日志时一并传入。`
      : `仓库还不能用：${repo?.error ?? '拉取没有完成'}。https 私有仓库需要在 dsh-repo 插件页为该主机配置令牌，配置后观象自动重新拉取。`
  return [{ type: 'text', text: `${head}${next}` }]
}

/** Collaborators of the tool. */
export interface AddRepoDeps {
  readonly registry: RepoRegistry
  /** DSH's approval service, when the composition has one. */
  approval(): HostApproval | undefined
  /**
   * Ask the `access/authorize` listeners whether the calling Session may
   * change the repository catalog; rejects with the reason. Absent means every
   * Session may.
   */
  authorize?(event: AuthorizeEvent): Promise<void>
  /**
   * Add the repository to the dsh-repo catalog with the log analysis feature for the Session.
   * @returns `exists` when the feature was already on, and the address as the catalog stores it.
   */
  addRepo(spec: RepoSpec, session: string): Promise<{ readonly status: 'added' | 'exists'; readonly url: string }>
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
      description: '观象：把一个应用代码仓库加入 dsh-repo 仓库清单、打开日志分析并等待拉取完成。用户要把仓库接入观象、用观象分析某个仓库的日志而它还没接入时使用。'
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
   * @throws when the arguments are invalid, the address is configured with another branch, an `access/authorize` listener refused, no approval service is loaded, or dsh-repo refused the addition; nothing is written then.
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
        throw new Error(`${spec.url} 已是观象的应用仓库，跟踪${existing.branch === undefined ? '远端默认分支' : `分支 ${existing.branch}`}；改分支请在 dsh-repo「代码仓库 → 仓库」中修改`)
      }
      return await this.settle('exists', spec.url, exec.signal)
    }

    const branch = spec.branch === undefined ? '远端默认分支' : `分支 ${spec.branch}`
    const zh = `观象将把 ${spec.url}（${branch}）加入 dsh-repo 仓库清单（新加入时权限为可改代码）并打开日志分析，之后派发的子 Agent 会读取它的代码。`
    const en = `Logalyze will add ${spec.url} (${spec.branch ?? 'default branch'}) to the dsh-repo catalog (write access when new) with log analysis turned on; dispatched agents will read its code.`
    await this.deps.authorize?.({ session: agent.session.header.id, level: 'admin', action: ADD_REPO_TOOL_NAME, summary: zh })
    const approval = this.deps.approval()
    if (approval === undefined) throw new Error('当前 DSH 组合没有审批服务（@deepseek-ai/dsh-user-approval），观象不会在未经授权时添加仓库')
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
    const added = await this.deps.addRepo(spec, agent.session.header.id)
    return await this.settle(added.status, added.url, exec.signal)
  }

  private async settle(status: 'added' | 'exists', url: string, signal: AbortSignal): Promise<AddRepoValue> {
    const { registry } = this.deps
    await abortable(registry.syncUrls([url]), signal)
    const repo = registry.statusOf(url)
    if (repo === undefined) throw new Error(`仓库 ${url} 已不在 dsh-repo 仓库清单中，或没有打开日志分析`)
    const setup: RepoSetup = repo.available ? 'ready' : registry.setupPending().includes(url) ? 'needs-setup' : 'failed'
    return { status, url, setup, repo }
  }
}
