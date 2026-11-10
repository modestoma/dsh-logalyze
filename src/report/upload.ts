/**
 * 把一份报告作为一个分析修订传到日志平台的一份日志：创建修订（带幂等键），
 * 按返回的直传链接上传入口和清单里的文件（同时最多 `concurrency` 个），再
 * 完成修订，得到这份日志固定的分析页地址。
 *
 * 同一幂等键再次创建会拿回同一个修订，并重新签发还没上传的文件的链接，所以
 * 链接过期、上传中断或完成时缺文件，都用同一个键重试即可。文件不跟随符号
 * 链接读取，大小与清单不符（上传期间被改动）时本次失败。
 *
 * @module dsh-logalyze/report/upload
 */

import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import { PlatformError } from '../platform/client.ts'
import type { PlatformClient } from '../platform/client.ts'
import { REPORT_ENTRY } from '../settings/contract.ts'
import type { ManifestFile } from './manifest.ts'

/** The platform calls one upload makes. */
export type RevisionPlatform = Pick<PlatformClient, 'createAnalysis' | 'completeAnalysis' | 'put'>

/** One revision to upload. */
export interface RevisionUpload {
  /** Platform log id. */
  readonly logId: string
  /** `Idempotency-Key` of the revision. */
  readonly key: string
  /** Rendered entry Markdown. */
  readonly entry: Uint8Array
  /** Absolute report directory the files are read from. */
  readonly dir: string
  /** Files besides the entry. */
  readonly files: readonly ManifestFile[]
  /** Timeout of one file upload, in milliseconds. */
  readonly timeoutMs: number
  /** Files uploaded at the same time. */
  readonly concurrency: number
}

/**
 * Read one regular file without following a symbolic link, checking its size.
 * @param path - absolute path.
 * @param size - size the manifest declared.
 * @returns the bytes.
 * @throws PlatformError (retryable) when the file changed or disappeared.
 */
async function readDeclared(path: string, size: number): Promise<Uint8Array> {
  let handle
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (error) {
    throw new PlatformError(`读取报告文件 ${path} 失败：${(error as NodeJS.ErrnoException).code ?? String(error)}`, true)
  }
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size !== size) throw new PlatformError(`报告文件 ${path} 在上传期间被改动，稍后重传`, true)
    return await handle.readFile()
  } finally {
    await handle.close()
  }
}

/**
 * Run tasks with at most `limit` running at once; the first failure rejects
 * after the running tasks settle.
 * @param tasks - task starters.
 * @param limit - most concurrent tasks.
 */
async function runLimited(tasks: readonly (() => Promise<void>)[], limit: number): Promise<void> {
  let next = 0
  let failure: unknown
  const worker = async (): Promise<void> => {
    while (failure === undefined && next < tasks.length) {
      const task = tasks[next]
      next += 1
      try {
        await task?.()
      } catch (error) {
        failure ??= error
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker))
  if (failure !== undefined) throw failure
}

/**
 * Upload one revision to one log.
 * @param platform - the platform client.
 * @param upload - what to upload.
 * @returns the log's analysis page (`detail_url`).
 * @throws PlatformError; status 409 from the creation means the key was used with other files.
 */
export async function uploadRevision(platform: RevisionPlatform, upload: RevisionUpload): Promise<string> {
  const declared = [{ path: REPORT_ENTRY, sizeBytes: upload.entry.byteLength }, ...upload.files.map(file => ({ path: file.path, sizeBytes: file.size }))]
  const created = await platform.createAnalysis(upload.logId, upload.key, REPORT_ENTRY, declared)
  if (created.status !== 'completed') {
    const sizes = new Map(upload.files.map(file => [file.path, file.size]))
    const tasks = created.uploads.map(target => async (): Promise<void> => {
      let content: Uint8Array
      if (target.path === REPORT_ENTRY) {
        content = upload.entry
      } else {
        const size = sizes.get(target.path)
        if (size === undefined) throw new PlatformError(`日志平台要求上传清单外的文件 ${target.path}`, false)
        content = await readDeclared(join(upload.dir, target.path), size)
      }
      await platform.put(target.upload_url, content, upload.timeoutMs)
    })
    await runLimited(tasks, upload.concurrency)
  }
  return await platform.completeAnalysis(upload.logId, created.analysis_id)
}
