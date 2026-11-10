/**
 * 报告目录的文件清单：逐个 `lstat`，不跟随符号链接，统计文件数与总大小，
 * 并给出每个文件的指纹（大小与修改时间）用来找出本轮新增或改动的文件。
 *
 * @module dsh-logalyze/report/files
 */

import { lstat, readdir } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { REPORT_ENTRY } from '../settings/contract.ts'

/** Files of one report directory. */
export interface ReportListing {
  /** Relative path (`/`-separated) → `size:mtimeMs`; excludes {@link REPORT_ENTRY}. */
  readonly files: Readonly<Record<string, string>>
  /** Relative path → size in bytes, for the same files as {@link files}. */
  readonly sizes: Readonly<Record<string, number>>
  /** Number of regular files, including {@link REPORT_ENTRY}. */
  readonly count: number
  /** Total size of the regular files in bytes. */
  readonly bytes: number
  /** Symbolic links and other non-regular entries, as relative paths. */
  readonly refused: readonly string[]
}

/**
 * List a report directory. A missing directory lists as empty.
 * @param dir - absolute report directory.
 * @returns the listing.
 * @throws when an entry cannot be read for another reason than not existing.
 */
export async function listReport(dir: string): Promise<ReportListing> {
  const files: Record<string, string> = {}
  const sizes: Record<string, number> = {}
  const refused: string[] = []
  let count = 0
  let bytes = 0
  const walk = async (current: string): Promise<void> => {
    let names: string[]
    try {
      names = await readdir(current)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    for (const name of names.sort()) {
      const path = join(current, name)
      const info = await lstat(path)
      const rel = relative(dir, path).split(sep).join('/')
      if (info.isDirectory()) {
        await walk(path)
      } else if (info.isFile()) {
        count += 1
        bytes += info.size
        if (rel !== REPORT_ENTRY) {
          files[rel] = `${info.size}:${Math.trunc(info.mtimeMs)}`
          sizes[rel] = info.size
        }
      } else {
        refused.push(rel)
      }
    }
  }
  await walk(dir)
  return { files, sizes, count, bytes, refused }
}

/**
 * Files new or changed since an earlier listing.
 * @param before - fingerprints of the earlier listing.
 * @param after - fingerprints now.
 * @returns changed relative paths, sorted.
 */
export function changedFiles(before: Readonly<Record<string, string>>, after: Readonly<Record<string, string>>): string[] {
  return Object.keys(after).filter(path => before[path] !== after[path]).sort()
}
