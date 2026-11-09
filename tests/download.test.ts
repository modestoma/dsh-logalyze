import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeAll, afterAll, describe, expect, it } from 'vitest'
import { admitUrl, downloadLog, fileNameFor, isHostAllowed } from '../src/runs/download.ts'
import type { DownloadSettings } from '../src/settings/contract.ts'
import { tempDir } from './helpers.ts'

let server: Server
let port = 0
beforeAll(async () => {
  server = createServer((req, res) => {
    switch (req.url) {
      case '/logs/app.tar.gz':
        res.writeHead(200, { 'content-length': '5' })
        res.end('hello')
        return
      case '/redirect-ok':
        res.writeHead(302, { location: '/logs/app.tar.gz' })
        res.end()
        return
      case '/redirect-away':
        res.writeHead(302, { location: 'http://evil.example.net/x' })
        res.end()
        return
      case '/big':
        res.writeHead(200)
        res.end('x'.repeat(100))
        return
      case '/slow':
        res.writeHead(200)
        res.write('x')
        return
      default:
        res.writeHead(404)
        res.end()
    }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as { port: number }).port
})
afterAll(async () => {
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
})

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { await Promise.all(cleanups.splice(0).map(cleanup => cleanup())) })

const settings: DownloadSettings = { allowedHosts: ['127.0.0.1'], maxBytes: 50, timeoutMs: 5000 }

async function dir(): Promise<string> {
  const temp = await tempDir()
  cleanups.push(temp.cleanup)
  return temp.dir
}

describe('download policy', () => {
  it('admits allowed hosts and their subdomains only', () => {
    expect(isHostAllowed('oss.example.com', ['example.com'])).toBe(true)
    expect(isHostAllowed('example.com.', ['example.com'])).toBe(true)
    expect(isHostAllowed('badexample.com', ['example.com'])).toBe(false)
  })

  it('refuses non-http schemes, credentials, an empty whitelist, and other hosts', () => {
    expect(() => admitUrl('file:///etc/passwd', settings)).toThrow('只支持 http/https')
    expect(() => admitUrl('http://u:p@127.0.0.1/x', settings)).toThrow('用户名或密码')
    expect(() => admitUrl('http://127.0.0.1/x', { ...settings, allowedHosts: [] })).toThrow('未配置允许下载的域名')
    expect(() => admitUrl('http://10.0.0.1/x', settings)).toThrow('不在下载白名单中')
    expect(() => admitUrl('not a url', settings)).toThrow('不是合法的 URL')
  })

  it('names files after the last path segment', () => {
    expect(fileNameFor(new URL('https://h/a/%E6%97%A5%E5%BF%97.zip?sig=1'), 'log')).toBe('日志.zip')
    expect(fileNameFor(new URL('https://h/'), 'log')).toBe('log')
    expect(fileNameFor(new URL('https://h/..%2F..%2Fx'), 'log')).toBe('_.._x')
  })
})

describe('downloadLog', () => {
  it('saves the body, following same-host redirects', async () => {
    const target = await dir()
    const file = await downloadLog(`http://127.0.0.1:${port}/redirect-ok`, target, 'a.tar.gz', settings, new AbortController().signal)
    expect(file).toEqual({ url: `http://127.0.0.1:${port}/redirect-ok`, path: join(target, 'a.tar.gz'), bytes: 5 })
    expect(await readFile(file.path, 'utf8')).toBe('hello')
  })

  it('re-checks the host of every redirect', async () => {
    await expect(downloadLog(`http://127.0.0.1:${port}/redirect-away`, await dir(), 'x', settings, new AbortController().signal))
      .rejects.toThrow('evil.example.net 不在下载白名单中')
  })

  it('enforces the size ceiling and removes the partial file', async () => {
    const target = await dir()
    await expect(downloadLog(`http://127.0.0.1:${port}/big`, target, 'big', settings, new AbortController().signal)).rejects.toThrow('超过大小上限')
    await expect(readFile(join(target, 'big'))).rejects.toThrow()
  })

  it('reports HTTP failures and timeouts', async () => {
    await expect(downloadLog(`http://127.0.0.1:${port}/nope`, await dir(), 'x', settings, new AbortController().signal)).rejects.toThrow('HTTP 404')
    await expect(downloadLog(`http://127.0.0.1:${port}/slow`, await dir(), 'x', { ...settings, timeoutMs: 200 }, new AbortController().signal)).rejects.toThrow('下载超时')
  })
})
