/**
 * 把工作区推送到新分支并创建合并请求。接入初稿先请求授权、再推送
 * （{@link submitChange}）；SKILL 改进在起草前就已经征得用户同意，起草后直接
 * 推送（{@link pushChange}）：
 *
 * - 授权经 DSH 审批服务一次性请求，只有 `allowed-once` 才继续；授权后重新检查
 *   工作区，改动与提问时不同则不推送。
 * - 推送经 `dshRepos` 的 `pushWorkspace` 完成，提交工作区里未提交的改动，从不
 *   强推；远端已有同名分支时报告 `exists`。
 * - 分支推送后合并请求失败时报告 `pushed`，由用户手动创建。
 *
 * @module dsh-logalyze/skill-update/commit
 */

import type { Agent, ApprovalOutcome, HostApproval, ToolRunContext } from '../host.ts'
import type { CommitAuthor, DshRepos } from '../repos/contract.ts'
import { messageOf, repoErrorCode } from '../repos/lookup.ts'
import { ProposalError } from './files.ts'

/** How one submission ended. */
export type SubmitStatus = 'opened' | 'pushed' | 'exists' | 'rejected' | 'cancelled' | 'unavailable'

/** One approval request about a tool call. */
export interface ApprovalAsk {
  readonly approval: HostApproval
  /** The calling top-level agent. */
  readonly agent: Agent
  readonly exec: ToolRunContext
  /** Tool the approval request is about. */
  readonly toolName: string
  /** Approval prompt text. */
  readonly prompt: { readonly zh: string; readonly en: string }
}

/** One push and merge request. */
export interface PushRequest {
  readonly repos: DshRepos
  readonly exec: ToolRunContext
  /** Repository address. */
  readonly url: string
  /** Workspace directory. */
  readonly dir: string
  /** New branch. */
  readonly branch: string
  /** Branch the merge request targets. */
  readonly target: string
  readonly message: string
  readonly title: string
  readonly body: string
  readonly author?: CommitAuthor
  /** Session recorded in the commit message by `dshRepos`. */
  readonly session: string
}

/** One submission that asks before pushing. */
export interface SubmitRequest extends PushRequest, ApprovalAsk {
  /** Digest of the checked changes the prompt describes. */
  readonly digest: string
  /** Checks the workspace again and returns its current digest. */
  readonly recheck: () => Promise<string>
}

/** Outcome of one submission. */
export interface SubmitOutcome {
  readonly status: SubmitStatus
  readonly mergeRequestUrl?: string
  /** Why the merge request was not created; only with `pushed`. */
  readonly mergeRequestError?: string
}

/**
 * Ask the user once.
 * @param ask - approval service, caller, and prompt.
 * @returns the outcome other than a cancellation of the turn.
 * @throws the cancellation reason when the turn is cancelled.
 */
export async function askApproval(ask: ApprovalAsk): Promise<ApprovalOutcome> {
  const { exec } = ask
  const outcome = await ask.approval.request({
    agent: ask.agent,
    toolName: ask.toolName,
    ...exec.callId === undefined ? {} : { callId: exec.callId },
    reason: ask.prompt.zh,
    displayReason: { en: ask.prompt.en, zh: ask.prompt.zh },
    signal: exec.signal,
  })
  if (outcome === 'cancelled') exec.signal.throwIfAborted()
  return outcome
}

/**
 * Ask once, then push and open the merge request.
 * @param request - workspace, change, and approval context.
 * @returns how the submission ended.
 * @throws the cancellation reason when the turn is cancelled, ProposalError when the changes differ from the approved ones or no longer pass the checks, or the push failure; the branch is not created then.
 */
export async function submitChange(request: SubmitRequest): Promise<SubmitOutcome> {
  const outcome = await askApproval(request)
  if (outcome !== 'allowed-once') return { status: outcome }
  // The workspace stays writable while the user decides.
  if (await request.recheck() !== request.digest) throw new ProposalError('等待授权期间工作区的改动变了，没有推送；请重新提交，按新的改动重新请求授权')
  return await pushChange(request)
}

/**
 * Push the workspace to a new branch and open the merge request, without asking.
 * @param request - workspace and change.
 * @returns `opened`, `pushed`, or `exists`.
 * @throws the cancellation reason when the turn is cancelled, or the push failure; the branch is not created then.
 */
export async function pushChange(request: PushRequest): Promise<SubmitOutcome> {
  const { repos, exec, url, branch } = request
  exec.signal.throwIfAborted()
  try {
    await repos.pushWorkspace(request.dir, {
      branch,
      message: request.message,
      ...request.author === undefined ? {} : { author: request.author },
      session: request.session,
      signal: exec.signal,
    })
  } catch (error) {
    if (repoErrorCode(error) === 'conflict') return { status: 'exists' }
    throw error
  }
  try {
    const opened = await repos.createChange(url, { title: request.title, body: request.body, sourceBranch: branch, targetBranch: request.target, signal: exec.signal })
    return { status: 'opened', mergeRequestUrl: opened.webUrl }
  } catch (error) {
    // The branch exists now; report it so the user can open the request by hand.
    return { status: 'pushed', mergeRequestError: messageOf(error) }
  }
}
