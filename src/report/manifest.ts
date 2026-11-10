/**
 * 一次报告修订的文件清单：从报告目录里挑出日志平台接受的文件，其余列为
 * 「未上传的文件」并写明原因。平台规则（固定）：相对路径最多
 * {@link REPORT_PATH_MAX_BYTES} 字节、1–{@link REPORT_PATH_MAX_SEGMENTS} 段，每段只含
 * ASCII 字母、数字和 `._-` 且不以点开头，扩展名在 {@link REPORT_EXTENSIONS} 内，
 * 文件不能为空。数量与大小上限来自上传设置。入口 `report.md` 由观象按日志
 * 生成，目录根下的同名文件不在清单里（见 `./files.ts`）。
 *
 * @module dsh-logalyze/report/manifest
 */

import { REPORT_EXTENSIONS, REPORT_PATH_MAX_BYTES, REPORT_PATH_MAX_SEGMENTS } from '../settings/contract.ts'
import type { UploadSettings } from '../settings/contract.ts'
import type { ReportListing } from './files.ts'

/** Bytes kept free for the entry when choosing files, before the entry is rendered. */
export const ENTRY_RESERVE_BYTES = 256 * 1024

const SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/u

/**
 * Why the platform would refuse a path, from the path alone.
 * @param path - `/`-separated path relative to the report directory.
 * @returns the reason, or undefined when the path is acceptable.
 */
export function pathProblem(path: string): string | undefined {
  if (Buffer.byteLength(path) > REPORT_PATH_MAX_BYTES) return `路径超过 ${REPORT_PATH_MAX_BYTES} 字节`
  const segments = path.split('/')
  if (segments.length > REPORT_PATH_MAX_SEGMENTS) return `目录层级超过 ${REPORT_PATH_MAX_SEGMENTS} 段`
  if (segments.some(segment => !SEGMENT.test(segment))) return '路径只能包含英文字母、数字和 . _ -，且每段不能以点开头'
  const extension = /\.([^./]+)$/u.exec(path)?.[1]?.toLowerCase()
  if (extension === undefined || !(REPORT_EXTENSIONS as readonly string[]).includes(extension)) return `扩展名只能是 ${REPORT_EXTENSIONS.join('/')}`
  return undefined
}

/** One file chosen for a revision. */
export interface ManifestFile {
  readonly path: string
  readonly size: number
}

/** Files chosen for a revision and the ones left out. */
export interface Manifest {
  /** Chosen files, sorted by path, without the entry. */
  readonly files: readonly ManifestFile[]
  /** Left-out files as `path：reason`, sorted by path. */
  readonly skipped: readonly string[]
}

/**
 * Choose the files of one revision from a report directory listing.
 * @param listing - the directory listing.
 * @param limits - upload limits.
 * @returns chosen and left-out files.
 */
export function buildManifest(listing: ReportListing, limits: UploadSettings): Manifest {
  const files: ManifestFile[] = []
  const skipped: string[] = [
    ...listing.refused.map(path => `${path}：符号链接或特殊文件`),
  ]
  let total = ENTRY_RESERVE_BYTES
  for (const path of Object.keys(listing.sizes).sort()) {
    const size = listing.sizes[path] ?? 0
    const problem = pathProblem(path)
      ?? (size === 0 ? '空文件' : undefined)
      ?? (size > limits.maxFileBytes ? `超过单文件上限 ${limits.maxFileBytes} 字节` : undefined)
      ?? (path.toLowerCase().endsWith('.md') && size > limits.maxMarkdownBytes ? `超过 Markdown 文件上限 ${limits.maxMarkdownBytes} 字节` : undefined)
      ?? (files.length + 1 >= limits.maxFiles ? `超过文件数上限 ${limits.maxFiles}` : undefined)
      ?? (total + size > limits.maxBytes ? `超过总大小上限 ${limits.maxBytes} 字节` : undefined)
    if (problem !== undefined) {
      skipped.push(`${path}：${problem}`)
      continue
    }
    files.push({ path, size })
    total += size
  }
  return { files, skipped: skipped.sort() }
}
