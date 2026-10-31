/**
 * 检查对仓库某个目录的修改（SKILL 改进、接入初稿）：从 dsh-repo 镜像读取
 * 基准提交中该目录的文件，与提交的文件比较，算出逐文件行数和 unified diff，不
 * 改动任何镜像或快照。改动内容的摘要用作新分支名，提交本身经 dsh-repo 完成。
 *
 * @module dsh-logalyze/skill-update/change
 */

import { createHash } from 'node:crypto'
import { createTwoFilesPatch, structuredPatch } from 'diff'
import type { DshRepos } from '../repos/contract.ts'
import type { ProposedFile } from './proposal.ts'

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

/** A proposal compared with its base commit. */
export interface PreparedChange {
  readonly base: string
  /** Hexadecimal digest of the base commit and the changed files; names the branch. */
  readonly digest: string
  readonly files: readonly FileStat[]
  /** Unified diff from the base commit to the proposal, limited to the target directory. */
  readonly diff: string
}

/** Where a proposal applies. */
export interface ChangeTarget {
  readonly url: string
  /** Commit the change starts from. */
  readonly base: string
  /** Directory the proposed paths are relative to, from the repository root, `/`-separated. */
  readonly dir: string
}

/**
 * Compare the proposed files with the target directory of the base commit.
 * @param repos - the `dshRepos` service holding the mirror.
 * @param target - repository, base commit, and target directory.
 * @param files - proposed files relative to the target directory.
 * @param signal - cancellation.
 * @returns per-file line counts, the diff, and the digest; `files` is empty when nothing changes.
 * @throws when a proposed path replaces a symbolic link, a submodule, or a directory, or the mirror cannot be read.
 */
export async function prepareChange(repos: DshRepos, target: ChangeTarget, files: readonly ProposedFile[], signal?: AbortSignal): Promise<PreparedChange> {
  const { url, base, dir } = target
  const listing = await repos.listMirrorTree(url, base, dir, signal === undefined ? {} : { signal })
  const types = new Map(listing.map(entry => [entry.path, entry.type]))
  const stats: FileStat[] = []
  const patches: string[] = []
  const digest = createHash('sha256').update(`${base}\n`)
  for (const file of [...files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) {
    const path = `${dir}/${file.path}`
    const type = types.get(path)
    if (type === 'symlink') throw new Error(`${path} 在仓库中是符号链接，不能覆盖`)
    if (type === 'dir' || type === 'submodule') throw new Error(`${path} 在仓库中是目录，不能用文件覆盖`)
    const before = type === 'file' ? await repos.readMirrorFile(url, base, path, signal === undefined ? {} : { signal }) ?? '' : undefined
    if (before === file.content) continue
    const structured = structuredPatch(path, path, before ?? '', file.content, undefined, undefined, { context: 3 })
    let added = 0
    let removed = 0
    for (const hunk of structured.hunks) {
      for (const line of hunk.lines) {
        if (line.startsWith('+')) added += 1
        else if (line.startsWith('-')) removed += 1
      }
    }
    stats.push({ path, added, removed })
    const header = `diff --git a/${path} b/${path}\n${before === undefined ? 'new file mode 100644\n' : ''}`
    const patch = createTwoFilesPatch(before === undefined ? '/dev/null' : `a/${path}`, `b/${path}`, before ?? '', file.content, undefined, undefined, { context: 3 })
    // jsdiff starts with an `Index:`-style separator line that git diffs do not have.
    patches.push(header + patch.replace(/^=+\n/, ''))
    digest.update(`${path}\0${file.content}\0`)
  }
  return { base, digest: digest.digest('hex'), files: stats, diff: patches.join('') }
}
