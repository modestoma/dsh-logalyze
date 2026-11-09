/**
 * 交给子 Agent 的日志：模型给出的本机路径或下载地址先整体校验（路径存在、
 * 地址在下载白名单内），通过后再把地址下载到运行目录，一律以绝对路径交给
 * 子 Agent。
 *
 * @module dsh-logalyze/runs/logs
 */

import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { z } from 'zod'
import type { DownloadSettings } from '../settings/contract.ts'
import { messageOf } from '../util/errors.ts'
import { admitUrl, downloadLog, fileNameFor } from './download.ts'

/** One log item of a model request: a local path or a download URL, with an optional filter. */
export const logSchema = z.union([
  z.object({ path: z.string().trim().min(1), filter: z.string().trim().min(1).optional() }).strict(),
  z.object({ url: z.string().trim().min(1), filter: z.string().trim().min(1).optional() }).strict(),
], { error: '每个日志项必须是 { path } 或 { url } 之一（可带 filter）' })

/** One validated log item. */
export type LogItem = z.output<typeof logSchema>

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
  /** Original download URL when the plugin fetched the file. */
  readonly url?: string
  /** How to pick this application's lines out of a mixed log. */
  readonly filter?: string
}

/** A checked log source: an existing local path or an admitted download URL. */
export type LogSource =
  | { readonly path: string; readonly url?: undefined; readonly filter?: string | undefined }
  | { readonly url: string; readonly path?: undefined; readonly filter?: string | undefined }

/**
 * Check log items before anything starts: local paths must exist, URLs must
 * pass the download policy.
 * @param logs - validated log items.
 * @param effectiveDir - directory relative paths resolve against.
 * @param download - download policy.
 * @returns the sources in order.
 * @throws when a path is unreadable or a URL is not admitted.
 */
export async function admitLogs(logs: readonly LogItem[], effectiveDir: string, download: DownloadSettings): Promise<LogSource[]> {
  return await Promise.all(logs.map(async (log): Promise<LogSource> => {
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
 * @returns the logs as handed to a child.
 * @throws when a download fails.
 */
export async function materializeLogs(sources: readonly LogSource[], workDir: string, download: DownloadSettings, signal: AbortSignal, fetchImpl?: typeof fetch): Promise<ChildLog[]> {
  const logs: ChildLog[] = []
  for (const [position, source] of sources.entries()) {
    const filter = source.filter === undefined ? {} : { filter: source.filter }
    if (source.path !== undefined) {
      logs.push({ path: source.path, ...filter })
      continue
    }
    const name = `${position + 1}-${fileNameFor(new URL(source.url), 'log')}`
    const file = await downloadLog(source.url, workDir, name, download, signal, fetchImpl)
    logs.push({ path: file.path, url: source.url, ...filter })
  }
  return logs
}
