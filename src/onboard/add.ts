/**
 * `logalyze_add_repo`：在对话中把一个 git 地址加入 dsh-repo 的仓库清单并打开
 * 「日志分析」功能，使它成为观象的应用仓库，并等待第一次拉取结束。
 *
 * - 仓库清单归 dsh-repo 所有：工具调用 `dshRepos.repoAdd`，新条目的权限为
 *   「可改代码」（起草接入和改进 SKILL 要推送分支），已有条目只打开功能、权限
 *   不变。调用带上当前 Agent：dsh-repo 发 `access/authorize`（级别 `admin`），
 *   按它的写操作设置弹出审批卡片；用户没有批准时报告审批结果，dsh-repo 关闭写
 *   操作或授权被拒绝时工具报错。
 * - 只接受 https 地址。
 * - 地址已是应用仓库时不调用 dsh-repo，只重新拉取并报告状态；分支不同时报错，
 *   改分支在 dsh-repo 的仓库清单中完成。
 * - 取消调用只停止等待，拉取在后台继续。
 * - 结果说明下一步：应用可用；仓库已拉取但缺少应用描述或 SKILL 时用
 *   `logalyze_init_repo` 起草（只读仓库提示在 dsh-repo 改权限）；拉取失败时给出原因。
 * - 子会话中不提供本工具。
 *
 * @module dsh-logalyze/onboard/add
 */

import type { RepoRegistry } from '../apps/registry.ts'
import { describeIssue, repoSchema } from '../config.ts'
import { declinedOutcome } from '../deps/repos.ts'
import type { Agent, ContentBlock, ToolDefinition, ToolRunContext } from '../host.ts'
import { topLevelAgent } from '../runs/run-dir.ts'
import type { RepoSpec, RepoStatusWire } from '../settings/contract.ts'
import { ADD_REPO_TOOL_NAME, INIT_REPO_TOOL_NAME } from '../tool-names.ts'
import { abortable } from '../util/abort.ts'

/** How one call ended. */
export type AddRepoStatus = 'added' | 'exists' | 'rejected' | 'cancelled' | 'unavailable'

/**
 * Where the repository stands after the sync: `ready` offers its application,
 * `needs-setup` synced without a usable description or SKILL, `read-only`
 * synced without one while its catalog access forbids pushing a draft,
 * `failed` did not sync or its application id conflicts with another repository.
 */
export type RepoSetup = 'ready' | 'needs-setup' | 'read-only' | 'failed'

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
    url: { type: 'string', description: '应用代码仓库的 https 地址（例如 https://github.com/example/order-service.git），主机须已在 dsh-repo 中配置；不接受 ssh 地址和本机路径。' },
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
    setup: { type: 'string', enum: ['ready', 'needs-setup', 'read-only', 'failed'] },
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
      : value.setup === 'read-only'
        ? `仓库已拉取${commit}，但还不能用：${repo?.error ?? '缺少应用描述'}。它在 dsh-repo 仓库清单中的权限是「只读」，观象不能为它起草；请在 dsh-repo「代码仓库 → 仓库」把权限改为「可改代码」后再起草，或由仓库维护者自己添加应用描述和 SKILL。`
        : `仓库还不能用：${repo?.error ?? '拉取没有完成'}。https 私有仓库需要在 dsh-repo 插件页为该主机配置令牌，配置后观象自动重新拉取。`
  return [{ type: 'text', text: `${head}${next}` }]
}

/** Collaborators of the tool. */
export interface AddRepoDeps {
  readonly registry: RepoRegistry
  /**
   * Add the repository to the dsh-repo catalog with the log analysis feature; dsh-repo authorizes and approves it for the Agent.
   * @returns `exists` when the feature was already on, and the address as the catalog stores it.
   * @throws the dsh-repo failure, `declined` when the user did not approve.
   */
  addRepo(spec: RepoSpec, caller: { readonly agent: Agent; readonly callId?: string; readonly signal: AbortSignal }): Promise<{ readonly status: 'added' | 'exists'; readonly url: string }>
}

/** Adds repositories from a conversation. */
export class RepoAdder {
  /** @param deps - registry and the catalog write. */
  constructor(private readonly deps: AddRepoDeps) {}

  /**
   * Build the tool definition.
   * @returns the registration.
   */
  definition(): ToolDefinition<AddRepoValue> {
    return {
      name: ADD_REPO_TOOL_NAME,
      description: '观象：把一个应用代码仓库加入 dsh-repo 仓库清单、打开日志分析并等待拉取完成。用户要把仓库接入观象、用观象分析某个仓库的日志而它还没接入时使用。'
        + '只接受 https 地址；dsh-repo 可能先请用户批准。结果说明应用是否可用，缺少应用描述或 SKILL 时提示起草。',
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
   * @throws when the arguments are invalid, the address is configured with another branch, or dsh-repo refused the addition (writes turned off, `access/authorize` refused, no approval service); nothing is written then.
   */
  async execute(rawArgs: unknown, exec: ToolRunContext): Promise<AddRepoValue> {
    const parsed = repoSchema.safeParse(rawArgs)
    if (!parsed.success) throw new Error(`${ADD_REPO_TOOL_NAME} 参数不合法：${describeIssue(parsed.error)}`)
    const spec: RepoSpec = parsed.data.branch === undefined ? { url: parsed.data.url } : { url: parsed.data.url, branch: parsed.data.branch }
    const agent = topLevelAgent(exec, ADD_REPO_TOOL_NAME)
    const { registry } = this.deps

    const existing = registry.statusOf(spec.url)
    if (existing !== undefined) {
      if (spec.branch !== undefined && spec.branch !== existing.branch) {
        throw new Error(`${spec.url} 已是观象的应用仓库，跟踪${existing.branch === undefined ? '远端默认分支' : `分支 ${existing.branch}`}；改分支请在 dsh-repo「代码仓库 → 仓库」中修改`)
      }
      return await this.settle('exists', spec.url, exec.signal)
    }

    let added: { readonly status: 'added' | 'exists'; readonly url: string }
    try {
      added = await this.deps.addRepo(spec, { agent, ...exec.callId === undefined ? {} : { callId: exec.callId }, signal: exec.signal })
    } catch (error) {
      const declined = declinedOutcome(error)
      if (declined === 'cancelled') exec.signal.throwIfAborted()
      if (declined !== undefined) return { status: declined, url: spec.url }
      throw error
    }
    return await this.settle(added.status, added.url, exec.signal)
  }

  private async settle(status: 'added' | 'exists', url: string, signal: AbortSignal): Promise<AddRepoValue> {
    const { registry } = this.deps
    await abortable(registry.syncUrls([url]), signal)
    const repo = registry.statusOf(url)
    if (repo === undefined) throw new Error(`仓库 ${url} 已不在 dsh-repo 仓库清单中，或没有打开日志分析`)
    const setup: RepoSetup = repo.available
      ? 'ready'
      : registry.setupPending().includes(url) ? 'needs-setup' : !repo.writable && repo.commit !== undefined && repo.phase !== 'syncing' ? 'read-only' : 'failed'
    return { status, url, setup, repo }
  }
}
