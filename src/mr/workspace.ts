/**
 * MR 工作区准备与 Git 同步：
 * - 为每个被监管的 MR 分配隔离目录，复用 `dshRepos.workspaceCreate`；
 * - 外部 MR 以只读/分离头方式同步到 `headSha`；
 * - 己方 MR（`self-fix` / `self-skill`）在工作树干净且可快进时同步，绝不自动 rebase 或丢弃本地未推送提交；
 * - 清理过期目录时严格校验路径位于工作区根目录之内。
 *
 * @module dsh-logalyze/mr/workspace
 */

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import type { DshReposV8, MrInfo } from '../deps/repos-contract.ts'
import type { MrOrigin } from '../runtime/domain.ts'
import { isInside } from '../runs/run-dir.ts'
import { messageOf } from '../util/errors.ts'

const execFileAsync = promisify(execFile)
const GIT_TIMEOUT_MS = 60_000

/** Result of preparing or refreshing a local MR workspace. */
export interface PreparedMrWorkspace {
  readonly workDir: string
  readonly checkedOutSha?: string
  readonly gitWarning?: string
  readonly changedFiles?: readonly string[]
}

async function runGit(cwd: string, args: readonly string[], signal?: AbortSignal): Promise<{ readonly ok: boolean; readonly stdout: string; readonly stderr: string }> {
  try {
    const result = await execFileAsync('git', [...args], {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
      signal,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    })
    return { ok: true, stdout: result.stdout.trim(), stderr: result.stderr.trim() }
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; message?: string }
    return {
      ok: false,
      stdout: (err.stdout ?? '').trim(),
      stderr: (err.stderr ?? err.message ?? messageOf(error)).trim(),
    }
  }
}

/** Compute deterministic workspace directory path under `workspacesRoot` for a repository + MR number. */
export function defaultMrWorkDir(workspacesRoot: string, canonicalRepo: string, mrNumber: number): string {
  const hash = createHash('sha256').update(canonicalRepo).digest('hex').slice(0, 12)
  return join(workspacesRoot, `${hash}-mr-${mrNumber}`)
}

async function ensureRemoteCommitFetched(
  workDir: string,
  mrNumber: number,
  headSha: string,
  signal?: AbortSignal,
): Promise<void> {
  await runGit(workDir, ['fetch', 'origin', '--prune'], signal)
  const hasCommit = await runGit(workDir, ['cat-file', '-e', `${headSha}^{commit}`], signal)
  if (hasCommit.ok) return
  // Fork MRs may live under forge-specific refs (GitHub PR or GitLab MR refs).
  await runGit(workDir, ['fetch', 'origin', `+refs/pull/${mrNumber}/head:refs/remotes/origin/mr-${mrNumber}`], signal)
  const afterGithub = await runGit(workDir, ['cat-file', '-e', `${headSha}^{commit}`], signal)
  if (afterGithub.ok) return
  await runGit(workDir, ['fetch', 'origin', `+refs/merge-requests/${mrNumber}/head:refs/remotes/origin/mr-${mrNumber}`], signal)
}

/**
 * Ensure an MR's workspace exists and reflects the latest remote head cleanly according to its origin.
 */
export async function ensureMrWorkspace(params: {
  readonly repos: DshReposV8
  readonly workspacesRoot: string
  readonly repo: string
  readonly mr: Pick<MrInfo, 'number' | 'sourceBranch' | 'targetBranch' | 'headSha'>
  readonly origin: MrOrigin
  readonly existingWorkDir?: string
  readonly lastReviewedSha?: string
  readonly signal?: AbortSignal
}): Promise<PreparedMrWorkspace> {
  const { repos, workspacesRoot, repo, mr, origin, existingWorkDir, lastReviewedSha, signal } = params
  const workDir = existingWorkDir ?? defaultMrWorkDir(workspacesRoot, repo, mr.number)
  const warnings: string[] = []

  if (!existsSync(join(workDir, '.git'))) {
    await mkdir(dirname(workDir), { recursive: true })
    try {
      await repos.workspaceCreate({
        repo,
        path: workDir,
        base: mr.targetBranch,
        branch: mr.sourceBranch,
        signal,
      })
    } catch (firstError) {
      // Fork PRs may not exist as a branch on the target mirror; retry on base branch and fetch PR ref.
      if (!existsSync(join(workDir, '.git'))) {
        if (existsSync(workDir) && isInside(workDir, workspacesRoot)) {
          await rm(workDir, { recursive: true, force: true })
        }
        try {
          await repos.workspaceCreate({
            repo,
            path: workDir,
            base: mr.targetBranch,
            signal,
          })
        } catch (secondError) {
          return {
            workDir,
            gitWarning: `无法初始化 MR 工作区：${messageOf(secondError)}（原始错误：${messageOf(firstError)}）`,
          }
        }
      }
    }
  }

  await ensureRemoteCommitFetched(workDir, mr.number, mr.headSha, signal)

  if (origin === 'external') {
    await runGit(workDir, ['checkout', '--', '.'], signal)
    const checkout = await runGit(workDir, ['checkout', '--detach', mr.headSha], signal)
    if (!checkout.ok) {
      const fallback = await runGit(workDir, ['checkout', '--detach', `origin/${mr.sourceBranch}`], signal)
      if (!fallback.ok) {
        warnings.push(`检出远端提交 ${mr.headSha.slice(0, 8)} 失败：${checkout.stderr || fallback.stderr}`)
      }
    }
  } else {
    const status = await runGit(workDir, ['status', '--porcelain'], signal)
    if (!status.ok) {
      warnings.push(`检查工作区状态失败：${status.stderr}`)
    } else if (status.stdout !== '') {
      warnings.push('工作区存在未提交改动，已保留现场，未自动覆盖。')
    } else {
      const targetRef = `origin/${mr.sourceBranch}`
      const hasTarget = await runGit(workDir, ['rev-parse', '--verify', targetRef], signal)
      if (hasTarget.ok) {
        const ffCheck = await runGit(workDir, ['merge-base', '--is-ancestor', 'HEAD', targetRef], signal)
        if (ffCheck.ok) {
          const branchCheckout = await runGit(workDir, ['checkout', mr.sourceBranch], signal)
          if (branchCheckout.ok) {
            await runGit(workDir, ['merge', '--ff-only', targetRef], signal)
          } else {
            await runGit(workDir, ['checkout', '-B', mr.sourceBranch, targetRef], signal)
          }
        } else {
          warnings.push('本地分支与远端已分叉，按安全规则未执行自动 rebase，请人工确认。')
        }
      }
    }
  }

  const rev = await runGit(workDir, ['rev-parse', 'HEAD'], signal)
  const checkedOutSha = rev.ok && rev.stdout !== '' ? rev.stdout : undefined
  let changedFiles: string[] | undefined
  if (lastReviewedSha !== undefined && lastReviewedSha !== mr.headSha) {
    const diff = await runGit(workDir, ['diff', '--name-only', `${lastReviewedSha}..${mr.headSha}`], signal)
    if (diff.ok) {
      changedFiles = diff.stdout === '' ? [] : diff.stdout.split('\n').filter(Boolean)
    }
  }

  return {
    workDir,
    ...(checkedOutSha === undefined ? {} : { checkedOutSha }),
    ...(changedFiles === undefined ? {} : { changedFiles }),
    ...(warnings.length === 0 ? {} : { gitWarning: warnings.join(' ') }),
  }
}

/** Safely remove an expired MR workspace directory only if it resides inside `workspacesRoot`. */
export async function removeExpiredMrWorkspace(workspacesRoot: string, workDir: string): Promise<boolean> {
  if (!isInside(workDir, workspacesRoot) || workDir === workspacesRoot) return false
  if (!existsSync(workDir)) return false
  await rm(workDir, { recursive: true, force: true })
  return true
}
