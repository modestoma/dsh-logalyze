/**
 * SKILL 改进与接入初稿共用的工作区布局和改动检查。观象在运行目录里经
 * `dshRepos` 打开一个可写工作区 `repo/`，子 Agent 在其中直接修改文件，改动说明
 * 写在工作区之外的 `reason.md`；子 Agent 结束后，观象读取工作区相对基准提交的
 * 改动，检查合格后写出 `changes.diff`，再推送到新分支。
 *
 * 工作区对 Agent 可写，改动按不可信输入检查：只接受允许范围内新增或修改的普通
 * 文件，文件名受限，内容是 UTF-8 文本，文件数与大小不超过上限；范围外的任何
 * 改动、删除、重命名或类型变化都让整份改动不合格。文件内容从工作区读取。
 *
 * @module dsh-logalyze/skill-update/workspace
 */

import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { RepoFileReader } from '../repos/manifest.ts'
import type { WorkspaceChanges } from '../repos/contract.ts'
import type { SkillUpdateSettings } from '../settings/contract.ts'
import { kindOf, ProposalError, readText } from './files.ts'

/** Workspace directory inside a run directory. */
export const WORKSPACE_DIR = 'repo'

/** Change description inside a run directory, outside the workspace. */
export const REASON_FILE = 'reason.md'

/** Diff the plugin writes into the run directory, for the user to read. */
export const DIFF_FILE = 'changes.diff'

const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/

/** Line counts of one changed file. */
export interface FileStat {
  /** Path relative to the repository root. */
  readonly path: string
  readonly added: number
  readonly removed: number
}

/**
 * Render line counts as `path（+a −r）`, separated by `、`.
 * @param files - changed files.
 * @returns one line.
 */
export function describeFiles(files: readonly FileStat[]): string {
  return files.map(file => `${file.path}（+${file.added} −${file.removed}）`).join('、')
}

/** Where changes may land. */
export interface ChangeScope {
  /** Directory every change must lie in, from the repository root, `/`-separated. */
  readonly root: string
  /**
   * Whether a path below {@link root} may change.
   * @param relative - path relative to {@link root}.
   */
  allows(relative: string): boolean
  /** The allowed paths, as named in a rejection. */
  readonly description: string
}

/** One changed file with its content as read from the workspace. */
export interface ChangedFile {
  /** Path relative to the repository root. */
  readonly path: string
  /** Path relative to the scope root. */
  readonly relative: string
  readonly content: string
}

/** Workspace changes that passed the checks. */
export interface CheckedChanges {
  /** Commit the workspace started from. */
  readonly base: string
  /** Remote branch an earlier push fixed; absent before the first push. */
  readonly pushedBranch?: string
  readonly files: readonly FileStat[]
  readonly contents: readonly ChangedFile[]
  /** Hexadecimal digest of the base commit and the changed files; names the branch. */
  readonly digest: string
  /** Unified diff from the base commit to the working tree. */
  readonly diff: string
}

/**
 * Check what a workspace changed against a scope and the size ceilings, and
 * read the changed files.
 * @param changes - the workspace's changes as `dshRepos` reported them.
 * @param scope - where changes may land.
 * @param limits - file count and size ceilings.
 * @returns the checked changes.
 * @throws ProposalError when nothing changed, or any change is out of scope, not an added or modified regular UTF-8 file, or over a ceiling.
 */
export async function checkChanges(changes: WorkspaceChanges, scope: ChangeScope, limits: Pick<SkillUpdateSettings, 'maxFiles' | 'maxFileBytes'>): Promise<CheckedChanges> {
  const { workspace } = changes
  const base = workspace.baseCommit
  if (changes.files.length === 0) throw new ProposalError(`工作区与提交 ${base.slice(0, 12)} 相比没有改动`)
  const prefix = `${scope.root}/`
  const outside = (path: string): boolean => {
    if (!path.startsWith(prefix)) return true
    const relative = path.slice(prefix.length)
    return !relative.split('/').every(segment => SEGMENT.test(segment)) || !scope.allows(relative)
  }
  const sorted = [...changes.files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  for (const file of sorted) {
    for (const path of [file.previousPath, file.path]) {
      if (path !== undefined && outside(path)) {
        throw new ProposalError(`工作区改动了 ${path}，只允许新增或修改 ${scope.description} 下的文件（文件名只用字母、数字、. _ -，且不以 . 或 - 开头）`)
      }
    }
    if (file.status === 'deleted') throw new ProposalError(`不能删除 ${file.path}`)
    if (file.status === 'renamed') throw new ProposalError(`不能重命名 ${file.previousPath ?? ''} → ${file.path}`)
    if (file.status === 'type-changed') throw new ProposalError(`${file.path} 改变了文件类型（不接受符号链接等）`)
    if (file.binary) throw new ProposalError(`${file.path} 是二进制文件，只接受 UTF-8 文本`)
  }
  if (sorted.length > limits.maxFiles) throw new ProposalError(`改动了 ${sorted.length} 个文件，超过上限 ${limits.maxFiles}`)

  const reader = workspaceReader(workspace.dir, limits.maxFileBytes)
  const digest = createHash('sha256').update(`${base}\n`)
  const contents: ChangedFile[] = []
  for (const file of sorted) {
    const content = await reader(file.path)
    if (content === undefined) throw new ProposalError(`${file.path} 已不在工作区中`)
    contents.push({ path: file.path, relative: file.path.slice(prefix.length), content })
    digest.update(`${file.path}\0${content}\0`)
  }
  return {
    base,
    ...workspace.branch === undefined ? {} : { pushedBranch: workspace.branch },
    files: sorted.map(file => ({ path: file.path, added: file.additions ?? 0, removed: file.deletions ?? 0 })),
    contents,
    digest: digest.digest('hex'),
    diff: changes.diff,
  }
}

/**
 * A reader of a workspace's files that accepts only regular UTF-8 files within a ceiling.
 * @param dir - workspace directory.
 * @param maxBytes - size ceiling.
 * @returns the reader; it yields undefined for a missing path.
 */
export function workspaceReader(dir: string, maxBytes: number): RepoFileReader {
  return async (path) => {
    const absolute = join(dir, path)
    const kind = await kindOf(absolute)
    if (kind === 'missing') return undefined
    if (kind !== 'file') throw new ProposalError(`${path} 不是普通文件（不接受符号链接等）`)
    return await readText(absolute, path, maxBytes)
  }
}

/**
 * Read the change description a child wrote next to the workspace.
 * @param runDir - run directory holding {@link REASON_FILE}.
 * @param maxBytes - size ceiling.
 * @param what - what the file should say, named when it is missing.
 * @returns the trimmed text.
 * @throws ProposalError when the file is missing, empty, not a regular UTF-8 file, or over the ceiling.
 */
export async function readReason(runDir: string, maxBytes: number, what: string): Promise<string> {
  const path = join(runDir, REASON_FILE)
  if (await kindOf(path) !== 'file') throw new ProposalError(`缺少 ${REASON_FILE}（${what}）`)
  const reason = (await readText(path, REASON_FILE, maxBytes)).trim()
  if (reason === '') throw new ProposalError(`${REASON_FILE} 不能为空`)
  return reason
}
