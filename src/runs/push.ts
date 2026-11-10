/**
 * 把工作区推送到它的分支并创建合并请求。SKILL 改进和接入初稿都经 `dshRepos` 的
 * `workspacePush` 一步完成：
 *
 * - 授权由 dsh-repo 负责：它为调用的 Agent 发 `access/authorize`，按它的设置
 *   弹出和它自己的推送工具相同的审批卡片，卡片列出要推送的文件、分支和合并
 *   请求。用户没有批准时报告审批结果，不推送。
 * - 推送提交工作区里未提交的改动，从不强推；远端分支已经变化时报告 `exists`。
 * - 分支推送后合并请求没有创建时报告 `pushed`，由用户手动创建。
 *
 * @module dsh-logalyze/runs/push
 */

import type { Agent, ToolRunContext } from '../host.ts'
import { declinedOutcome, repoErrorCode } from '../deps/repos.ts'
import type { DshRepos } from '../deps/repos-contract.ts'

/** Conventional Commits prefix of every SKILL improvement and onboarding commit subject and merge request title; no other type is allowed. */
export const SKILL_COMMIT_PREFIX = 'chore: '

/** How one push ended: pushed (with or without the merge request), the remote branch moved, or the approval outcome that stopped it. */
export type PushStatus = 'opened' | 'pushed' | 'exists' | 'rejected' | 'cancelled' | 'unavailable'

/** One push and merge request. */
export interface PushRequest {
  readonly repos: DshRepos
  readonly exec: ToolRunContext
  /** The calling top-level agent: dsh-repo authorizes for its Session, records it in the commit message, and asks its user to approve. */
  readonly agent: Agent
  /** Workspace directory. */
  readonly dir: string
  readonly message: string
  readonly title: string
  readonly body: string
}

/** Outcome of one push. */
export interface PushOutcome {
  readonly status: PushStatus
  readonly mergeRequestUrl?: string
  /** Why the merge request was not created; only with `pushed`. */
  readonly mergeRequestError?: string
}

/**
 * Push the workspace to its branch and open the merge request into its base, after dsh-repo's approval.
 * @param request - workspace, change, and caller.
 * @returns how the push ended.
 * @throws the cancellation reason when the turn is cancelled, or the push failure; nothing is pushed then.
 */
export async function pushChange(request: PushRequest): Promise<PushOutcome> {
  const { repos, exec } = request
  exec.signal.throwIfAborted()
  let result
  try {
    result = await repos.workspacePush({
      path: request.dir,
      message: request.message,
      mr: { title: request.title, body: request.body },
      agent: request.agent,
      ...exec.callId === undefined ? {} : { callId: exec.callId },
      signal: exec.signal,
    })
  } catch (error) {
    const declined = declinedOutcome(error)
    if (declined === 'cancelled') exec.signal.throwIfAborted()
    if (declined !== undefined) return { status: declined }
    if (repoErrorCode(error) === 'conflict') return { status: 'exists' }
    throw error
  }
  const opened = result.createdMr ?? result.openMrs[0]
  if (opened !== undefined) return { status: 'opened', mergeRequestUrl: opened.webUrl }
  // The branch exists now; report it so the user can open the request by hand.
  return { status: 'pushed', mergeRequestError: result.mrError ?? '仓库不在已配置的代码托管主机上，无法创建合并请求' }
}
