/**
 * 运行目录：派发、SKILL 改进和接入起草在调用方会话目录下的
 * `.logalyze/runs/<runId>/` 中工作，并只在顶层 Agent 中提供。
 *
 * @module dsh-logalyze/runs/run-dir
 */

import { randomBytes } from 'node:crypto'
import { isAbsolute, relative, sep } from 'node:path'
import type { Agent, ToolRunContext, WorkingDirectoryService } from '../host.ts'

/** Path segments of the run directories below a base directory. */
export const RUNS_SEGMENTS = ['.logalyze', 'runs'] as const

/**
 * Whether a session is a delegated child, where this plugin's tools are not offered.
 * @param agent - calling agent.
 * @returns whether its delegation depth is above zero.
 */
export function isDelegatedAgent(agent: Agent): boolean {
  return (agent.session.header.delegationDepth ?? 0) > 0
}

/**
 * The calling top-level agent of a tool execution.
 * @param exec - execution context.
 * @param tool - tool name, named in the errors.
 * @returns the agent.
 * @throws when no agent calls, or the caller is a delegated child.
 */
export function topLevelAgent(exec: ToolRunContext, tool: string): Agent {
  const agent = exec.agent
  if (agent === undefined) throw new Error(`${tool} 需要由 Agent 调用`)
  if (isDelegatedAgent(agent)) throw new Error(`${tool} 不能在子 Agent 中调用`)
  return agent
}

/**
 * A new run id: local timestamp plus a random suffix.
 * @param now - current time.
 * @returns `YYYYMMDD-HHMMSS-xxxxxx`.
 */
export function newRunId(now: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  return `${stamp}-${randomBytes(3).toString('hex')}`
}

/**
 * Whether a path is a directory or a descendant of another.
 * @param child - candidate path.
 * @param parent - containing directory.
 * @returns whether `child` lies in `parent`.
 */
export function isInside(child: string, parent: string): boolean {
  const path = relative(parent, child)
  return path === '' || (!path.startsWith('..') && !isAbsolute(path))
}

/**
 * Whether a path lies in a run directory, where improvement and drafting
 * children work in their workspaces.
 * @param path - absolute path.
 * @returns whether the path has a `.logalyze/runs/` segment pair.
 */
export function inRunDirectory(path: string): boolean {
  const segments = path.split(sep)
  return segments.some((segment, index) => segment === RUNS_SEGMENTS[0] && segments[index + 1] === RUNS_SEGMENTS[1])
}

/** Where a top-level agent's run directories live. */
export interface RunBase {
  /** The agent's effective working directory; relative log paths resolve against it. */
  readonly effectiveDir: string
  /** Directory holding `.logalyze/runs/`: the effective directory when it lies in the project directory, else the project directory. */
  readonly baseDir: string
}

/**
 * Resolve where an agent's run directories go.
 * @param parent - calling top-level agent.
 * @param workingDirectory - the working-directory service, when the composition has one.
 * @param signal - cancellation.
 * @returns the effective and base directories.
 * @throws when the session has no project directory.
 */
export async function resolveRunBase(parent: Agent, workingDirectory: WorkingDirectoryService | undefined, signal: AbortSignal): Promise<RunBase> {
  const projectDir = parent.session.header.cwd
  if (projectDir === undefined) throw new Error('当前会话没有项目目录，无法创建运行目录')
  const effectiveDir = await workingDirectory?.ensure(parent, signal) ?? projectDir
  return { effectiveDir, baseDir: isInside(effectiveDir, projectDir) ? effectiveDir : projectDir }
}
