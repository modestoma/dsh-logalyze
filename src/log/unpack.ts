/**
 * 纯 Node.js 安全日志归档解包器（支持 `.zip` / `.tar.gz` / `.tgz` / `.tar` / `.gz` / 普通文本日志）：
 * - 严格防护 Zip-Slip（拒绝 `..`、绝对路径、盘符、空字符及越界目标）；
 * - 严格防护符号链接/硬链接/特殊设备文件（TAR 类型位 + ZIP Unix `S_IFLNK` + `lstat` 逐级目录检查 + `O_NOFOLLOW` 写入）；
 * - 严格防护 Zip-Bomb（流式解压字节上限 `maxBytes` 与条目上限 `maxEntries`，超限立即中止，不爆内存）；
 * - 单槽位损坏仅把该槽位标记为 `corrupted` 并写入 `CORRUPTED.txt`，不阻断同批次其他日志槽位。
 *
 * @module dsh-logalyze/log/unpack
 */

import { constants, createReadStream } from 'node:fs'
import { lstat, mkdir, open, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, posix, resolve } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGunzip, createInflateRaw } from 'node:zlib'
import { isInside } from '../runs/run-dir.ts'
import { messageOf } from '../util/errors.ts'

/** Default maximum archive entries unpacked per log slot. */
export const DEFAULT_MAX_UNPACK_ENTRIES = 2_000

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i += 1) {
    let c = i
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) !== 0 ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1)
    }
    table[i] = c >>> 0
  }
  return table
})()

function crc32(data: Uint8Array, initial = 0): number {
  let c = (initial ^ 0xffffffff) >>> 0
  for (let i = 0; i < data.length; i += 1) {
    c = (CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8)) >>> 0
  }
  return (c ^ 0xffffffff) >>> 0
}

/** Result of unpacking one log slot into `destDir`. */
export type UnpackSlotResult =
  | {
    readonly status: 'ok'
    readonly files: readonly string[]
    readonly totalBytes: number
  }
  | {
    readonly status: 'corrupted'
    readonly error: string
    readonly files: readonly string[]
    readonly totalBytes: number
  }

class ArchiveSecurityError extends Error {}
class ArchiveCorruptError extends Error {}

/**
 * Normalize and validate an archive member path. Returns `undefined` for
 * root/empty directory placeholders like `.` or `./`, or throws {@link ArchiveSecurityError}
 * on traversal, absolute paths, drive letters, or NUL bytes.
 */
export function sanitizeArchiveEntryPath(rawPath: string, destDir: string): { readonly rel: string; readonly abs: string } | undefined {
  if (rawPath.includes('\0')) {
    throw new ArchiveSecurityError('归档条目路径包含空字符')
  }
  const slashNormalized = rawPath.replace(/\\/gu, '/')
  if (/^[A-Za-z]:/u.test(slashNormalized) || slashNormalized.startsWith('/')) {
    throw new ArchiveSecurityError(`归档包含绝对路径或盘符条目：${rawPath}`)
  }
  const segments = slashNormalized.split('/').filter(seg => seg !== '' && seg !== '.')
  if (segments.length === 0) return undefined
  if (segments.some(seg => seg === '..')) {
    throw new ArchiveSecurityError(`归档包含路径穿越条目：${rawPath}`)
  }
  const rel = posix.join(...segments)
  const abs = resolve(destDir, ...segments)
  if (!isInside(abs, destDir) || abs === resolve(destDir)) {
    throw new ArchiveSecurityError(`归档条目超出目标目录：${rawPath}`)
  }
  return { rel, abs }
}

async function ensureSafeDir(dirPath: string, rootDir: string): Promise<void> {
  const rootResolved = resolve(rootDir)
  const targetResolved = resolve(dirPath)
  if (targetResolved !== rootResolved && !isInside(targetResolved, rootResolved)) {
    throw new ArchiveSecurityError(`拒绝在目标目录外创建子目录：${dirPath}`)
  }
  if (targetResolved === rootResolved) {
    await mkdir(rootResolved, { recursive: true })
    return
  }
  const relParts = targetResolved.slice(rootResolved.length + 1).split(/[/\\]/u).filter(Boolean)
  let current = rootResolved
  await mkdir(rootResolved, { recursive: true })
  for (const part of relParts) {
    current = join(current, part)
    let info
    try {
      info = await lstat(current)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        await mkdir(current)
        continue
      }
      throw error
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new ArchiveSecurityError(`拒绝经符号链接或非目录写入：${current}`)
    }
  }
}

async function writeFileSafely(filePath: string, rootDir: string, content: Uint8Array): Promise<void> {
  await ensureSafeDir(dirname(filePath), rootDir)
  const handle = await open(filePath, constants.O_CREAT | constants.O_TRUNC | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
  try {
    await handle.writeFile(content)
  } finally {
    await handle.close()
  }
}

async function readFileBounded(sourcePath: string, maxBytes: number): Promise<Buffer> {
  const info = await lstat(sourcePath)
  if (!info.isFile()) {
    throw new ArchiveSecurityError(`输入路径不是普通文件：${sourcePath}`)
  }
  if (info.size > maxBytes) {
    throw new ArchiveSecurityError(`原始日志大小 (${info.size} B) 超过解压上限 (${maxBytes} B)`)
  }
  return await readFile(sourcePath)
}

async function decompressWithLimit(
  streamFactory: () => NodeJS.ReadWriteStream,
  input: Buffer,
  maxBytes: number,
  label: string,
): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      total += chunk.length
      if (total > maxBytes) {
        callback(new ArchiveSecurityError(`${label} 解压超过大小上限 (${maxBytes} B)`))
        return
      }
      chunks.push(chunk)
      callback()
    },
  })
  async function* source(): AsyncGenerator<Buffer> {
    yield input
  }
  try {
    await pipeline(source, streamFactory(), limiter)
  } catch (error) {
    if (error instanceof ArchiveSecurityError) throw error
    throw new ArchiveCorruptError(`${label} 解压失败：${messageOf(error)}`)
  }
  return Buffer.concat(chunks)
}

async function streamGunzipLimited(sourcePath: string, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      total += chunk.length
      if (total > maxBytes) {
        callback(new ArchiveSecurityError(`gzip 解压累计超过上限 (${maxBytes} B)`))
        return
      }
      chunks.push(chunk)
      callback()
    },
  })
  try {
    await pipeline(createReadStream(sourcePath), createGunzip(), limiter)
  } catch (error) {
    if (error instanceof ArchiveSecurityError) throw error
    throw new ArchiveCorruptError(`gzip 解压失败：${messageOf(error)}`)
  }
  return Buffer.concat(chunks)
}

function isZeroBlock(buf: Uint8Array, offset: number): boolean {
  for (let i = 0; i < 512; i += 1) {
    if (buf[offset + i] !== 0) return false
  }
  return true
}

function parseOctal(buf: Uint8Array, start: number, length: number): number {
  const raw = Buffer.from(buf.subarray(start, start + length))
    .toString('utf8')
    .replace(/\0.*$/u, '')
    .trim()
  if (raw === '') return 0
  if (!/^[0-7]+$/u.test(raw)) {
    throw new ArchiveCorruptError(`TAR 头部八进制字段非法：${raw}`)
  }
  return Number.parseInt(raw, 8)
}

function readTarString(buf: Uint8Array, start: number, length: number): string {
  const slice = buf.subarray(start, start + length)
  const nul = slice.indexOf(0)
  return Buffer.from(nul === -1 ? slice : slice.subarray(0, nul)).toString('utf8')
}

function verifyTarChecksum(buf: Uint8Array, offset: number): boolean {
  const stored = parseOctal(buf, offset + 148, 8)
  let sum = 0
  for (let i = 0; i < 512; i += 1) {
    sum += (i >= 148 && i < 156) ? 32 : (buf[offset + i] ?? 0)
  }
  return sum === stored
}

function parsePaxRecords(data: Uint8Array): Record<string, string> {
  const text = Buffer.from(data).toString('utf8')
  const out: Record<string, string> = {}
  let pos = 0
  while (pos < text.length) {
    const space = text.indexOf(' ', pos)
    if (space === -1) break
    const len = Number.parseInt(text.slice(pos, space), 10)
    if (!Number.isInteger(len) || len <= 0) break
    const record = Buffer.from(text, 'utf8').subarray(Buffer.byteLength(text.slice(0, pos))).subarray(0, len).toString('utf8')
    const eq = record.indexOf('=')
    if (eq !== -1) {
      const key = record.slice(record.indexOf(' ') + 1, eq)
      const value = record.slice(eq + 1).replace(/\n$/u, '')
      out[key] = value
    }
    pos += record.length
  }
  return out
}

async function unpackTarBuffer(
  tarBytes: Buffer,
  destDir: string,
  maxBytes: number,
  maxEntries: number,
): Promise<{ readonly files: string[]; readonly totalBytes: number }> {
  const files: string[] = []
  let totalBytes = 0
  let entryCount = 0
  let offset = 0
  let paxPath: string | undefined
  let gnuLongName: string | undefined
  let zeroBlocks = 0

  while (offset + 512 <= tarBytes.length) {
    if (isZeroBlock(tarBytes, offset)) {
      zeroBlocks += 1
      offset += 512
      if (zeroBlocks >= 2) break
      continue
    }
    zeroBlocks = 0
    if (!verifyTarChecksum(tarBytes, offset)) {
      throw new ArchiveCorruptError('TAR 文件头校验和错误')
    }
    const typeFlagByte = tarBytes[offset + 156] ?? 0
    const typeFlag = typeFlagByte === 0 ? '0' : String.fromCharCode(typeFlagByte)
    const size = parseOctal(tarBytes, offset + 124, 12)
    const dataStart = offset + 512
    const paddedSize = Math.ceil(size / 512) * 512
    if (dataStart + size > tarBytes.length) {
      throw new ArchiveCorruptError('TAR 文件内容截断')
    }
    const content = tarBytes.subarray(dataStart, dataStart + size)
    offset = dataStart + paddedSize

    if (typeFlag === 'x') {
      const recs = parsePaxRecords(content)
      if (typeof recs.path === 'string') paxPath = recs.path
      continue
    }
    if (typeFlag === 'g') {
      continue
    }
    if (typeFlag === 'L') {
      gnuLongName = Buffer.from(content).toString('utf8').replace(/\0.*$/u, '')
      continue
    }
    if (typeFlag === 'K') {
      // Long link target — any symlink/hardlink immediately after will still be rejected.
      continue
    }

    const namePart = readTarString(tarBytes, offset - 512 - paddedSize, 100)
    const prefixPart = readTarString(tarBytes, offset - 512 - paddedSize + 345, 155)
    const defaultName = prefixPart !== '' ? `${prefixPart}/${namePart}` : namePart
    const memberPath = paxPath ?? gnuLongName ?? defaultName
    paxPath = undefined
    gnuLongName = undefined

    if (typeFlag === '1' || typeFlag === '2' || typeFlag === '3' || typeFlag === '4' || typeFlag === '6') {
      throw new ArchiveSecurityError(`TAR 包含不安全的符号链接或特殊条目 (type=${typeFlag})：${memberPath}`)
    }

    entryCount += 1
    if (entryCount > maxEntries) {
      throw new ArchiveSecurityError(`归档条目数超过上限 (${maxEntries})`)
    }

    const resolved = sanitizeArchiveEntryPath(memberPath, destDir)
    if (resolved === undefined) continue

    if (typeFlag === '5') {
      await ensureSafeDir(resolved.abs, destDir)
      continue
    }

    if (typeFlag !== '0' && typeFlag !== '7') {
      throw new ArchiveCorruptError(`不支持的 TAR 条目类型 (${typeFlag})：${memberPath}`)
    }

    totalBytes += size
    if (totalBytes > maxBytes) {
      throw new ArchiveSecurityError(`归档解压累计大小超过上限 (${maxBytes} B)`)
    }

    await writeFileSafely(resolved.abs, destDir, content)
    files.push(resolved.rel)
  }

  return { files, totalBytes }
}

function findZipEocd(buf: Buffer): number {
  const minOffset = Math.max(0, buf.length - 22 - 0xffff)
  for (let i = buf.length - 22; i >= minOffset; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      const commentLen = buf.readUInt16LE(i + 20)
      if (i + 22 + commentLen <= buf.length) {
        return i
      }
    }
  }
  throw new ArchiveCorruptError('ZIP 缺少 End-of-Central-Directory 记录')
}

async function unpackZipBuffer(
  buf: Buffer,
  destDir: string,
  maxBytes: number,
  maxEntries: number,
): Promise<{ readonly files: string[]; readonly totalBytes: number }> {
  const eocdOffset = findZipEocd(buf)
  const diskNum = buf.readUInt16LE(eocdOffset + 4)
  const cdDisk = buf.readUInt16LE(eocdOffset + 6)
  if (diskNum !== 0 || cdDisk !== 0) {
    throw new ArchiveCorruptError('不支持分卷 ZIP 归档')
  }
  const entryTotal = buf.readUInt16LE(eocdOffset + 10)
  const cdSize = buf.readUInt32LE(eocdOffset + 12)
  const cdOffset = buf.readUInt32LE(eocdOffset + 16)
  if (entryTotal > maxEntries) {
    throw new ArchiveSecurityError(`ZIP 条目数 (${entryTotal}) 超过上限 (${maxEntries})`)
  }
  if (cdOffset + cdSize > eocdOffset) {
    throw new ArchiveCorruptError('ZIP Central Directory 越界')
  }

  const files: string[] = []
  let totalBytes = 0
  let ptr = cdOffset
  for (let i = 0; i < entryTotal; i += 1) {
    if (ptr + 46 > cdOffset + cdSize || buf.readUInt32LE(ptr) !== 0x02014b50) {
      throw new ArchiveCorruptError('ZIP Central Directory 条目损坏')
    }
    const versionMadeBy = buf.readUInt16LE(ptr + 4)
    const flags = buf.readUInt16LE(ptr + 8)
    const method = buf.readUInt16LE(ptr + 10)
    const expectedCrc = buf.readUInt32LE(ptr + 16)
    const compSize = buf.readUInt32LE(ptr + 20)
    const uncompSize = buf.readUInt32LE(ptr + 24)
    const nameLen = buf.readUInt16LE(ptr + 28)
    const extraLen = buf.readUInt16LE(ptr + 30)
    const commentLen = buf.readUInt16LE(ptr + 32)
    const externalAttr = buf.readUInt32LE(ptr + 38)
    const localHeaderOffset = buf.readUInt32LE(ptr + 42)
    const nameEnd = ptr + 46 + nameLen
    const entryEnd = nameEnd + extraLen + commentLen
    if (entryEnd > cdOffset + cdSize) {
      throw new ArchiveCorruptError('ZIP Central Directory 条目长度越界')
    }
    const rawName = buf.subarray(ptr + 46, nameEnd).toString('utf8')
    ptr = entryEnd

    if ((flags & 0x01) !== 0) {
      throw new ArchiveCorruptError(`不支持加密的 ZIP 条目：${rawName}`)
    }

    // Unix creator (made-by upper byte === 3): reject S_IFLNK (0o120000) or non-dir special files.
    const creatorOs = (versionMadeBy >>> 8) & 0xff
    if (creatorOs === 3) {
      const unixMode = (externalAttr >>> 16) & 0o170000
      if (unixMode === 0o120000) {
        throw new ArchiveSecurityError(`ZIP 包含不安全的符号链接条目：${rawName}`)
      }
      if (unixMode !== 0 && unixMode !== 0o100000 && unixMode !== 0o040000) {
        throw new ArchiveSecurityError(`ZIP 包含不支持的特殊文件条目：${rawName}`)
      }
    }

    if (localHeaderOffset + 30 > cdOffset || buf.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
      throw new ArchiveCorruptError(`ZIP Local File Header 损坏：${rawName}`)
    }
    const lfhNameLen = buf.readUInt16LE(localHeaderOffset + 26)
    const lfhExtraLen = buf.readUInt16LE(localHeaderOffset + 28)
    const dataStart = localHeaderOffset + 30 + lfhNameLen + lfhExtraLen
    const dataEnd = dataStart + compSize
    if (dataEnd > cdOffset) {
      throw new ArchiveCorruptError(`ZIP 压缩数据越界：${rawName}`)
    }

    const isDirectory = rawName.endsWith('/') || (((versionMadeBy >>> 8) === 3) && (((externalAttr >>> 16) & 0o170000) === 0o040000))
    const resolved = sanitizeArchiveEntryPath(rawName, destDir)
    if (resolved === undefined) continue

    if (isDirectory) {
      await ensureSafeDir(resolved.abs, destDir)
      continue
    }

    const remainingBudget = maxBytes - totalBytes
    if (uncompSize > remainingBudget) {
      throw new ArchiveSecurityError(`ZIP 解压累计大小超过上限 (${maxBytes} B)：${rawName}`)
    }

    const compressed = buf.subarray(dataStart, dataEnd)
    let uncompressed: Buffer
    if (method === 0) {
      uncompressed = Buffer.from(compressed)
    } else if (method === 8) {
      uncompressed = await decompressWithLimit(() => createInflateRaw(), compressed, remainingBudget, rawName)
    } else {
      throw new ArchiveCorruptError(`不支持的 ZIP 压缩方式 (${method})：${rawName}`)
    }

    if (uncompressed.length !== uncompSize) {
      throw new ArchiveCorruptError(`ZIP 条目解压长度不匹配：${rawName}`)
    }
    if (crc32(uncompressed) !== expectedCrc) {
      throw new ArchiveCorruptError(`ZIP 条目 CRC32 校验失败：${rawName}`)
    }

    totalBytes += uncompressed.length
    if (totalBytes > maxBytes) {
      throw new ArchiveSecurityError(`ZIP 解压累计大小超过上限 (${maxBytes} B)`)
    }

    await writeFileSafely(resolved.abs, destDir, uncompressed)
    files.push(resolved.rel)
  }

  return { files, totalBytes }
}

/**
 * Unpack one downloaded or user-attached log file/archive safely into `destDir`.
 * Supports `.zip`, `.tar.gz`, `.tgz`, `.tar`, `.gz`, and plain files.
 * Corrupted archives or security violations never throw or break sibling slots;
 * they clean `destDir`, write `CORRUPTED.txt`, and return `{ status: 'corrupted', ... }`.
 */
export async function unpackLogSlot(params: {
  readonly archivePath: string
  readonly fileName: string
  readonly destDir: string
  readonly maxBytes: number
  readonly maxEntries?: number
}): Promise<UnpackSlotResult> {
  const { archivePath, fileName, destDir, maxBytes, maxEntries = DEFAULT_MAX_UNPACK_ENTRIES } = params
  await rm(destDir, { recursive: true, force: true })
  await mkdir(destDir, { recursive: true })

  const lower = fileName.toLowerCase()
  try {
    if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) {
      const tarBuf = await streamGunzipLimited(archivePath, maxBytes)
      const res = await unpackTarBuffer(tarBuf, destDir, maxBytes, maxEntries)
      return { status: 'ok', files: res.files, totalBytes: res.totalBytes }
    }
    if (lower.endsWith('.tar')) {
      const tarBuf = await readFileBounded(archivePath, maxBytes)
      const res = await unpackTarBuffer(tarBuf, destDir, maxBytes, maxEntries)
      return { status: 'ok', files: res.files, totalBytes: res.totalBytes }
    }
    if (lower.endsWith('.zip')) {
      const zipBuf = await readFileBounded(archivePath, maxBytes)
      const res = await unpackZipBuffer(zipBuf, destDir, maxBytes, maxEntries)
      return { status: 'ok', files: res.files, totalBytes: res.totalBytes }
    }
    if (lower.endsWith('.gz')) {
      const content = await streamGunzipLimited(archivePath, maxBytes)
      const innerRaw = basename(fileName.slice(0, -3)) || 'log.txt'
      const resolved = sanitizeArchiveEntryPath(innerRaw, destDir)
      if (resolved === undefined) {
        throw new ArchiveCorruptError(`无法从文件名推导解压名称：${fileName}`)
      }
      await writeFileSafely(resolved.abs, destDir, content)
      return { status: 'ok', files: [resolved.rel], totalBytes: content.length }
    }
    // Plain file (.log, .txt, .json, etc.)
    const plain = await readFileBounded(archivePath, maxBytes)
    const resolved = sanitizeArchiveEntryPath(basename(fileName) || 'log.txt', destDir)
    if (resolved === undefined) {
      throw new ArchiveCorruptError(`无效日志文件名：${fileName}`)
    }
    await writeFileSafely(resolved.abs, destDir, plain)
    return { status: 'ok', files: [resolved.rel], totalBytes: plain.length }
  } catch (error) {
    const reason = messageOf(error)
    await rm(destDir, { recursive: true, force: true })
    await mkdir(destDir, { recursive: true })
    await writeFile(join(destDir, 'CORRUPTED.txt'), `日志槽位解包失败：${reason}\n`, 'utf8')
    return { status: 'corrupted', error: reason, files: [], totalBytes: 0 }
  }
}
