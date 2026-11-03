/**
 * 读写 Agent 可写目录（运行目录、工作区）中的文件。这些目录里的一切都按不可信
 * 输入处理：不跟随符号链接，只接受普通文件、UTF-8 文本和大小上限。
 *
 * @module dsh-logalyze/skill-update/files
 */

import { randomBytes } from 'node:crypto'
import { lstat, readFile, rename, rm, writeFile } from 'node:fs/promises'

const decoder = new TextDecoder('utf-8', { fatal: true })

/** A proposal that cannot be submitted, with a reason the model and user can act on. */
export class ProposalError extends Error {}

/**
 * Whether a path in an agent-writable directory is missing, a directory, a
 * regular file, or anything else, without following symbolic links.
 * @param path - absolute path.
 * @returns its kind.
 */
export async function kindOf(path: string): Promise<'missing' | 'directory' | 'file' | 'other'> {
  try {
    const info = await lstat(path)
    return info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other'
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'
    throw error
  }
}

/**
 * Read a UTF-8 text file an agent wrote, within a size ceiling.
 * @param path - absolute path of a regular file.
 * @param label - name used in errors.
 * @param maxBytes - size ceiling.
 * @returns the text.
 * @throws ProposalError when the file is too large or not UTF-8 text.
 */
export async function readText(path: string, label: string, maxBytes: number): Promise<string> {
  const info = await lstat(path)
  if (info.size > maxBytes) throw new ProposalError(`${label} 有 ${info.size} 字节，超过上限 ${maxBytes}`)
  const bytes = await readFile(path)
  if (bytes.length > maxBytes) throw new ProposalError(`${label} 超过大小上限 ${maxBytes} 字节`)
  let text: string
  try {
    text = decoder.decode(bytes)
  } catch {
    // TextDecoder reports only that the bytes are not UTF-8.
    throw new ProposalError(`${label} 不是 UTF-8 文本`)
  }
  if (text.includes('\u0000')) throw new ProposalError(`${label} 包含 NUL 字符，不是文本文件`)
  return text
}

/**
 * Write a file in an agent-writable directory without following whatever
 * entry the agent left at its path: the content goes to a new file created
 * exclusively, which then replaces the directory entry.
 * @param path - absolute path.
 * @param content - file content.
 */
export async function replaceFile(path: string, content: string): Promise<void> {
  const temporary = `${path}.${randomBytes(6).toString('hex')}.tmp`
  try {
    await writeFile(temporary, content, { flag: 'wx' })
    await rename(temporary, path)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
}
