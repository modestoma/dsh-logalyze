/**
 * HTTP helpers shared by the settings routes and the analyze route.
 *
 * @module dsh-logalyze/util/http
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

/** A request failure answered with its status and message. */
export class HttpError extends Error {
  /**
   * @param status - HTTP status code.
   * @param message - user-facing reason.
   */
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

/**
 * Answer with a JSON body that is never cached.
 * @param res - the response.
 * @param status - HTTP status code.
 * @param payload - body value.
 */
export function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/**
 * Read a request body within a size ceiling.
 * @param req - the request.
 * @param maxBytes - size ceiling, checked against `Content-Length` first and while reading.
 * @returns the body as UTF-8 text.
 * @throws HttpError 413 when the body is larger.
 */
export async function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  const tooLarge = (): HttpError => new HttpError(413, `请求体超过 ${maxBytes} 字节`)
  const declared = Number(req.headers['content-length'])
  if (Number.isFinite(declared) && declared > maxBytes) throw tooLarge()
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk as Buffer
    size += buffer.length
    if (size > maxBytes) throw tooLarge()
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * The media type of a request without parameters, lowercased.
 * @param req - the request.
 * @returns the media type, or an empty string.
 */
export function mediaTypeOf(req: IncomingMessage): string {
  return (req.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
}
