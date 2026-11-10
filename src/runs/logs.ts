/**
 * 交给子 Agent 的日志：模型给出的本机路径、下载地址或分析接口话题里的日志
 * 编号先整体校验（路径存在、地址在下载白名单内、编号属于本话题），通过后再
 * 把地址下载到运行目录、按编号向日志平台现取下载链接下载，一律以绝对路径
 * 交给子 Agent。平台的临时下载链接不进入模型可见的内容。
 *
 * @module dsh-logalyze/runs/logs
 */

import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { z } from 'zod'
import type { DownloadSettings } from '../settings/contract.ts'
import { messageOf } from '../util/errors.ts'
import { admitUrl, downloadLog, fileNameFor, safeFileName } from './download.ts'

/** One log item of a model request: a local path or a download URL, with an optional filter. */
export const logSchema = z.union([
  z.object({ path: z.string().trim().min(1), filter: z.string().trim().min(1).optional() }).strict(),
  z.object({ url: z.string().trim().min(1), filter: z.string().trim().min(1).optional() }).strict(),
], { error: '每个日志项必须是 { path } 或 { url } 之一（可带 filter）' })

/** One validated log item. */
export type LogItem = z.output<typeof logSchema>

/** Log number of an analyze API topic (`L1`, `L2`, …). */
export const LOG_REF_PATTERN = /^L[1-9][0-9]{0,2}$/u

/** One dispatch log item: {@link logSchema}, or a log number of the analyze API topic the dispatch runs in. */
export const dispatchLogSchema = z.union([
  z.object({ path: z.string().trim().min(1), filter: z.string().trim().min(1).optional() }).strict(),
  z.object({ url: z.string().trim().min(1), filter: z.string().trim().min(1).optional() }).strict(),
  z.object({ ref: z.string().trim().regex(LOG_REF_PATTERN, 'ref 是首轮消息日志表里的编号，如 L1'), filter: z.string().trim().min(1).optional() }).strict(),
], { error: '每个日志项必须是 { path }、{ url } 或 { ref } 之一（可带 filter）' })

/** One validated dispatch log item. */
export type DispatchLogItem = z.output<typeof dispatchLogSchema>

/** A platform log an analyze API topic names. */
export interface PlatformLogRef {
  /** Log number in the topic (`L1`, …). */
  readonly ref: string
  /** Platform log id. */
  readonly logId: string
  /** Original file name of the log. */
  readonly fileName: string
}

/** Downloads platform logs by id through a fresh temporary link. */
export interface PlatformLogDownloader {
  /**
   * Download one platform log.
   * @param log - the log.
   * @param dir - existing target directory.
   * @param fileName - target file name inside `dir`.
   * @param download - size and time limits.
   * @param signal - cancellation.
   * @returns the saved file's absolute path.
   * @throws when the platform refuses the link or the download fails.
   */
  download(log: PlatformLogRef, dir: string, fileName: string, download: DownloadSettings, signal: AbortSignal): Promise<string>
}

/** JSON-schema parameter of optional sample logs, shared by the improvement and drafting tools. */
export const SAMPLE_LOGS_PARAMETER = {
  type: 'array',
  description: '可选的样例日志。{ "path": 本机绝对路径 } 用于附件和本机文件；{ "url": 下载地址 } 用于对象存储链接（仅白名单域名）。',
  items: {
    type: 'object',
    additionalProperties: false,
    properties: { path: { type: 'string' }, url: { type: 'string' } },
  },
} as const

/** One log handed to a child, always as an absolute local path. */
export interface ChildLog {
  readonly path: string
  /** Original download URL when the plugin fetched the file from a model-given address. */
  readonly url?: string
  /** The platform log this file is, when it was named by log number. */
  readonly platformLog?: PlatformLogRef
  /** How to pick this application's lines out of a mixed log. */
  readonly filter?: string
}

/** A checked log source: an existing local path, an admitted download URL, or a platform log of the topic. */
export type LogSource =
  | { readonly path: string; readonly url?: undefined; readonly platformLog?: undefined; readonly filter?: string | undefined }
  | { readonly url: string; readonly path?: undefined; readonly platformLog?: undefined; readonly filter?: string | undefined }
  | { readonly platformLog: PlatformLogRef; readonly path?: undefined; readonly url?: undefined; readonly filter?: string | undefined }

/**
 * Check log items before anything starts: local paths must exist, URLs must
 * pass the download policy.
 * @param logs - validated log items.
 * @param effectiveDir - directory relative paths resolve against.
 * @param download - download policy.
 * @param refs - resolves a log number of the calling topic; absent refuses log numbers.
 * @returns the sources in order.
 * @throws when a path is unreadable, a URL is not admitted, or a log number is unknown.
 */
export async function admitLogs(
  logs: readonly DispatchLogItem[],
  effectiveDir: string,
  download: DownloadSettings,
  refs?: (ref: string) => PlatformLogRef,
): Promise<LogSource[]> {
  return await Promise.all(logs.map(async (log): Promise<LogSource> => {
    if ('ref' in log) {
      if (refs === undefined) throw new Error(`日志编号 ${log.ref} 只能在分析接口发起的话题中使用`)
      return { platformLog: refs(log.ref), filter: log.filter }
    }
    if ('url' in log) return { url: admitUrl(log.url, download).href, filter: log.filter }
    const path = resolve(effectiveDir, log.path)
    try {
      await stat(path)
    } catch (error) {
      throw new Error(`日志路径不可读：${path}（${(error as NodeJS.ErrnoException).code ?? messageOf(error)}）`)
    }
    return { path, filter: log.filter }
  }))
}

/**
 * Turn admitted sources into local paths, downloading URLs into a run directory.
 * @param sources - admitted sources.
 * @param workDir - run directory receiving downloads.
 * @param download - download policy.
 * @param signal - cancellation.
 * @param fetchImpl - fetch implementation.
 * @param platform - downloads platform logs; required when a source is one.
 * @returns the logs as handed to a child.
 * @throws when a download fails.
 */
export async function materializeLogs(
  sources: readonly LogSource[],
  workDir: string,
  download: DownloadSettings,
  signal: AbortSignal,
  fetchImpl?: typeof fetch,
  platform?: PlatformLogDownloader,
): Promise<ChildLog[]> {
  const logs: ChildLog[] = []
  for (const [position, source] of sources.entries()) {
    const filter = source.filter === undefined ? {} : { filter: source.filter }
    if (source.path !== undefined) {
      logs.push({ path: source.path, ...filter })
      continue
    }
    if (source.platformLog !== undefined) {
      if (platform === undefined) throw new Error('日志平台不可用，无法按编号下载日志')
      const name = `${source.platformLog.ref}-${safeFileName(source.platformLog.fileName)}`
      const path = await platform.download(source.platformLog, workDir, name, download, signal)
      logs.push({ path, platformLog: source.platformLog, ...filter })
      continue
    }
    const name = `${position + 1}-${fileNameFor(new URL(source.url), 'log')}`
    const file = await downloadLog(source.url, workDir, name, download, signal, fetchImpl)
    logs.push({ path: file.path, url: source.url, ...filter })
  }
  return logs
}
