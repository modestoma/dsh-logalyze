/**
 * 日志下载：只下载设置面板白名单内域名的 http(s) 地址，不带任何鉴权信息；
 * 每次重定向都重新校验域名，并限制单文件大小与耗时。下载的文件原样保存
 * （压缩包由应用的日志分析 SKILL 解压）。
 *
 * @module dsh-logalyze/dispatch/download
 */

import { createWriteStream } from 'node:fs'
import { rm } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { DownloadSettings } from '../settings/contract.ts'

/** Redirect hops followed before giving up. */
const MAX_REDIRECTS = 5

/** A download refused by policy or failed in transfer; the message is user-facing. */
export class DownloadError extends Error {}

/**
 * Whether a host name is admitted: equal to an allowed host or one of its subdomains.
 * @param host - URL host name.
 * @param allowedHosts - normalized allowed host names.
 * @returns whether it is admitted.
 */
export function isHostAllowed(host: string, allowedHosts: readonly string[]): boolean {
  const name = host.toLowerCase().replace(/\.$/, '')
  return allowedHosts.some(allowed => name === allowed || name.endsWith(`.${allowed}`))
}

/**
 * Validate one log URL against the policy without fetching it.
 * @param raw - URL text from the model.
 * @param settings - download policy.
 * @returns the parsed URL.
 * @throws DownloadError when the URL is malformed or not admitted.
 */
export function admitUrl(raw: string, settings: DownloadSettings): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new DownloadError(`不是合法的 URL：${raw}`)
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new DownloadError(`只支持 http/https 下载：${raw}`)
  if (url.username !== '' || url.password !== '') throw new DownloadError(`URL 不能包含用户名或密码：${url.host}`)
  if (settings.allowedHosts.length === 0) throw new DownloadError('未配置允许下载的域名，请在「观象」面板的「日志下载」中添加白名单')
  if (!isHostAllowed(url.hostname, settings.allowedHosts)) {
    throw new DownloadError(`域名 ${url.hostname} 不在下载白名单中（允许：${settings.allowedHosts.join('、')}）`)
  }
  return url
}

/**
 * File name for a downloaded URL: its last path segment, restricted to safe
 * characters.
 * @param url - download URL.
 * @param fallback - name used when the path has no usable segment.
 * @returns file name.
 */
export function fileNameFor(url: URL, fallback: string): string {
  let segment = basename(url.pathname)
  try {
    segment = decodeURIComponent(segment)
  } catch {
    // Keep the raw segment when it is not valid percent-encoding.
  }
  const safe = segment.replace(/[^\p{L}\p{N}._-]/gu, '_').replace(/^\.+/, '')
  return safe === '' ? fallback : safe.slice(0, 200)
}

/** One completed download. */
export interface DownloadedFile {
  readonly url: string
  readonly path: string
  readonly bytes: number
}

/**
 * Download one admitted URL into a directory.
 * @param raw - URL text.
 * @param dir - existing target directory.
 * @param fileName - target file name inside `dir`.
 * @param settings - download policy.
 * @param signal - caller cancellation.
 * @param fetchImpl - fetch implementation (tests substitute it).
 * @returns the saved file.
 * @throws DownloadError on policy refusal, HTTP failure, size overflow, or timeout.
 */
export async function downloadLog(
  raw: string,
  dir: string,
  fileName: string,
  settings: DownloadSettings,
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<DownloadedFile> {
  const timeout = AbortSignal.timeout(settings.timeoutMs)
  const combined = AbortSignal.any([signal, timeout])
  let url = admitUrl(raw, settings)
  let response: Response
  for (let hop = 0; ; hop += 1) {
    try {
      response = await fetchImpl(url, { redirect: 'manual', signal: combined })
    } catch (error) {
      throw transferError(error, url, settings, timeout, signal)
    }
    if (response.status < 300 || response.status >= 400 || response.status === 304) break
    const location = response.headers.get('location')
    await response.body?.cancel()
    if (location === null) throw new DownloadError(`${url.hostname} 返回重定向 ${response.status} 但没有 Location`)
    if (hop >= MAX_REDIRECTS) throw new DownloadError(`重定向超过 ${MAX_REDIRECTS} 次：${raw}`)
    url = admitUrl(new URL(location, url).href, settings)
  }
  if (!response.ok) {
    await response.body?.cancel()
    throw new DownloadError(`下载失败：HTTP ${response.status}（${url.hostname}）`)
  }
  const declared = Number(response.headers.get('content-length') ?? Number.NaN)
  if (Number.isFinite(declared) && declared > settings.maxBytes) {
    await response.body?.cancel()
    throw new DownloadError(`文件大小 ${declared} 字节超过上限 ${settings.maxBytes} 字节：${raw}`)
  }
  if (response.body === null) throw new DownloadError(`响应没有内容：${raw}`)
  const path = join(dir, fileName)
  let bytes = 0
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length
      if (bytes > settings.maxBytes) {
        callback(new DownloadError(`文件超过大小上限 ${settings.maxBytes} 字节：${raw}`))
        return
      }
      callback(null, chunk)
    },
  })
  try {
    await pipeline(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream), meter, createWriteStream(path, { flags: 'wx' }), { signal: combined })
  } catch (error) {
    await rm(path, { force: true })
    if (error instanceof DownloadError) throw error
    throw transferError(error, url, settings, timeout, signal)
  }
  return { url: raw, path, bytes }
}

function transferError(error: unknown, url: URL, settings: DownloadSettings, timeout: AbortSignal, signal: AbortSignal): Error {
  if (signal.aborted) return signal.reason instanceof Error ? signal.reason : new Error('下载已取消')
  if (timeout.aborted) return new DownloadError(`下载超时（${settings.timeoutMs} ms）：${url.hostname}`)
  return new DownloadError(`下载失败（${url.hostname}）：${error instanceof Error ? error.message : String(error)}`)
}
