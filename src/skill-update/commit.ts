/**
 * 把一组文件提交到新分支并创建合并请求。接入初稿先检查分支、再请求授权、最后
 * 提交（{@link submitChange}）；SKILL 改进在起草前就已经征得用户同意，起草后
 * 直接提交（{@link commitChange}）：
 *
 * - 授权经 DSH 审批服务一次性请求，只有 `allowed-once` 才继续。
 * - 提交用 `newBranch: true`，同名分支已存在时报告 `exists`，从不提交到已有分支。
 * - 提交以基准提交为父提交；分支创建后合并请求失败时报告 `pushed`，由用户手动创建。
 *
 * @module dsh-logalyze/skill-update/commit
 */

import type { Agent, ApprovalOutcome, HostApproval, ToolRunContext } from '../host.ts'
import type { CommitAuthor, DshRepos } from '../repos/contract.ts'
import { messageOf, repoErrorCode } from '../repos/lookup.ts'

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

/** One commit and merge request. */
export interface CommitRequest {
  readonly repos: DshRepos
  readonly exec: ToolRunContext
  /** Repository address. */
  readonly url: string
  /** Full commit id the new branch starts from. */
  readonly base: string
  /** New branch. */
  readonly branch: string
  /** Branch the merge request targets. */
  readonly target: string
  /** Files to write, by repository-relative path; only files that differ from {@link base}. */
  readonly files: readonly { readonly action: 'write'; readonly path: string; readonly content: string }[]
  readonly message: string
  readonly title: string
  readonly body: string
  readonly author?: CommitAuthor
}

/** One submission that asks before committing. */
export interface SubmitRequest extends CommitRequest, ApprovalAsk {}

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
 * Check the branch, ask once, then commit and open the merge request.
 * @param request - repository, change, and approval context.
 * @returns how the submission ended.
 * @throws the cancellation reason when the turn is cancelled, or the commit failure; the branch is not created then.
 */
export async function submitChange(request: SubmitRequest): Promise<SubmitOutcome> {
  const { repos, exec, url, branch } = request
  if (await repos.getBranch(url, branch, { signal: exec.signal }) !== undefined) return { status: 'exists' }
  const outcome = await askApproval(request)
  if (outcome !== 'allowed-once') return { status: outcome }
  return await commitChange(request)
}

/**
 * Commit to a new branch and open the merge request, without asking.
 * @param request - repository and change.
 * @returns `opened`, `pushed`, or `exists`.
 * @throws the cancellation reason when the turn is cancelled, or the commit failure; the branch is not created then.
 */
export async function commitChange(request: CommitRequest): Promise<SubmitOutcome> {
  const { repos, exec, url, branch } = request
  exec.signal.throwIfAborted()
  try {
    await repos.commitFiles(url, {
      branch,
      baseSha: request.base,
      newBranch: true,
      message: request.message,
      files: request.files,
      ...request.author === undefined ? {} : { author: request.author },
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
