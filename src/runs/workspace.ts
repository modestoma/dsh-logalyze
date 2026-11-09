/**
 * SKILL 改进和接入起草共用的工作区准备：在运行目录里经 `dshRepos` 从指定提交
 * 创建工作区 `repo/`（推送到观象起好名字的新分支），并把样例日志放进运行目录；
 * 子 Agent 结束后把检查过的改动写成 `changes.diff`。
 *
 * @module dsh-logalyze/runs/workspace
 */

import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { ReposClient } from '../deps/repos.ts'
import type { WorkspaceInfo } from '../deps/repos-contract.ts'
import type { Agent, ToolRunContext } from '../host.ts'
import type { DownloadSettings } from '../settings/contract.ts'
import { messageOf } from '../util/errors.ts'
import { replaceFile } from '../util/files.ts'
import { DIFF_FILE, WORKSPACE_DIR } from './changes.ts'
import { materializeLogs } from './logs.ts'
import type { ChildLog, LogSource } from './logs.ts'

/** One workspace to open. */
export interface WorkspaceRequest {
  readonly repos: ReposClient
  readonly parent: Agent
  readonly exec: ToolRunContext
  /** Catalog address of the repository. */
  readonly repo: string
  /** Branch the work merges into; undefined: the remote's default branch. */
  readonly base: string | undefined
  /** Commit the workspace starts from. */
  readonly commit: string
  /** New remote branch the workspace pushes to. */
  readonly branch: string
  /** Run directory holding the workspace, the logs, and the reason and diff files. */
  readonly workDir: string
  /** Admitted sample logs, downloaded into {@link workDir}. */
  readonly sources: readonly LogSource[]
  readonly download: DownloadSettings
  readonly fetch?: typeof fetch
  /** What is being prepared, named when the workspace cannot be created. */
  readonly subject: string
}

/** An opened workspace. */
export interface OpenedWorkspace {
  readonly workspace: WorkspaceInfo
  /** Absolute workspace directory: {@link WORKSPACE_DIR} in the run directory. */
  readonly repoDir: string
  /** The sample logs as handed to the child. */
  readonly logs: ChildLog[]
}

/**
 * Create the run directory and the workspace, then download the sample logs.
 * @param request - repository, start commit, branch, and logs.
 * @returns the workspace and the logs.
 * @throws the cancellation reason, the workspace failure naming {@link WorkspaceRequest.subject}, or a download failure.
 */
export async function openWorkspace(request: WorkspaceRequest): Promise<OpenedWorkspace> {
  const { exec, workDir } = request
  const repoDir = join(workDir, WORKSPACE_DIR)
  await mkdir(workDir, { recursive: true })
  let workspace: WorkspaceInfo
  try {
    workspace = await request.repos.require().workspaceCreate({
      repo: request.repo,
      path: repoDir,
      ...request.base === undefined ? {} : { base: request.base },
      commit: request.commit,
      branch: request.branch,
      agent: request.parent,
      ...exec.callId === undefined ? {} : { callId: exec.callId },
      signal: exec.signal,
    })
  } catch (error) {
    exec.signal.throwIfAborted()
    throw new Error(`${request.subject}的工作区创建失败：${messageOf(error)}`)
  }
  const logs = await materializeLogs(request.sources, workDir, request.download, exec.signal, request.fetch)
  return { workspace, repoDir, logs }
}

/**
 * Write checked changes as the run directory's diff file.
 * @param workDir - run directory.
 * @param diff - unified diff.
 * @returns the file's absolute path.
 */
export async function writeDiff(workDir: string, diff: string): Promise<string> {
  const path = join(workDir, DIFF_FILE)
  await replaceFile(path, diff)
  return path
}
