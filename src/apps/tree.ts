/**
 * Reading files of a checked-out tree (a `dshRepos` snapshot or workspace)
 * by repository path. Nothing is followed through a symbolic link, so a link
 * committed to the repository cannot make a read leave the tree.
 *
 * @module dsh-logalyze/apps/tree
 */

import { lstat, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { RepoFileReader } from './manifest.ts'
import { ProposalError, readText } from '../util/files.ts'

/** Largest repository file read from a snapshot (application descriptions and SKILL files). */
export const MAX_REPO_FILE_BYTES = 1024 * 1024

/**
 * Split a repository path into segments.
 * @param path - `/`-separated path from the tree root.
 * @returns the segments.
 * @throws ProposalError for an empty, `.`, or `..` segment.
 */
function segmentsOf(path: string): string[] {
  const segments = path.split('/')
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) throw new ProposalError(`${path} 不是仓库内的相对路径`)
  return segments
}

/**
 * The kind of a repository path, without following symbolic links on the way.
 * @param root - tree directory.
 * @param path - `/`-separated path from the root.
 * @returns `missing`, `directory`, `file`, or `other` (a symbolic link or a special file at or above the path).
 */
export async function treeKind(root: string, path: string): Promise<'missing' | 'directory' | 'file' | 'other'> {
  let current = root
  const segments = segmentsOf(path)
  for (const [index, segment] of segments.entries()) {
    current = join(current, segment)
    let info
    try {
      info = await lstat(current)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR') return 'missing'
      throw error
    }
    if (index === segments.length - 1) return info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other'
    if (!info.isDirectory()) return info.isSymbolicLink() ? 'other' : 'missing'
  }
  return 'missing'
}

/**
 * A reader of a tree's files that accepts only regular UTF-8 files within a ceiling.
 * @param root - tree directory.
 * @param maxBytes - size ceiling.
 * @returns the reader; it yields undefined for a missing path.
 */
export function treeReader(root: string, maxBytes: number): RepoFileReader {
  return async (path) => {
    const kind = await treeKind(root, path)
    if (kind === 'missing') return undefined
    if (kind !== 'file') throw new ProposalError(`${path} 不是普通文件（不接受符号链接等）`)
    return await readText(join(root, path), path, maxBytes)
  }
}

/**
 * The regular files below a directory of a tree, recursively; symbolic links are left out and not followed.
 * @param root - tree directory.
 * @param dir - `/`-separated directory from the root.
 * @returns paths relative to `dir`, sorted; empty when `dir` is not a directory.
 */
export async function treeFiles(root: string, dir: string): Promise<string[]> {
  if (await treeKind(root, dir) !== 'directory') return []
  const found: string[] = []
  const walk = async (relative: string): Promise<void> => {
    for (const entry of await readdir(join(root, dir, relative), { withFileTypes: true })) {
      const path = relative === '' ? entry.name : `${relative}/${entry.name}`
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile()) found.push(path)
    }
  }
  await walk('')
  return found.sort()
}
