import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { treeFiles, treeKind, treeReader } from '../src/repos/snapshot.ts'
import { tempDir } from './helpers.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { await Promise.all(cleanups.splice(0).map(cleanup => cleanup())) })

describe('tree reading', () => {
  it('reads regular files and never follows a symbolic link on the way', async () => {
    const { dir, cleanup } = await tempDir()
    cleanups.push(cleanup)
    const root = join(dir, 'tree')
    const outside = join(dir, 'outside')
    await mkdir(join(root, 'skills', 'a', 'references'), { recursive: true })
    await mkdir(outside, { recursive: true })
    await writeFile(join(outside, 'secret.md'), 'secret')
    await writeFile(join(root, 'skills', 'a', 'SKILL.md'), '# a\n')
    await writeFile(join(root, 'skills', 'a', 'references', 'r.md'), 'r')
    await symlink(outside, join(root, 'skills', 'a', 'linked'))
    await symlink(join(outside, 'secret.md'), join(root, 'skills', 'a', 'secret.md'))
    await symlink(outside, join(root, 'escape'))

    const read = treeReader(root, 1024)
    expect(await read('skills/a/SKILL.md')).toBe('# a\n')
    expect(await read('skills/a/missing.md')).toBeUndefined()
    expect(await read('skills/a/SKILL.md/below')).toBeUndefined()
    await expect(read('skills/a/secret.md')).rejects.toThrow('不是普通文件')
    await expect(read('escape/secret.md')).rejects.toThrow('不是普通文件')
    await expect(read('skills/../escape/secret.md')).rejects.toThrow('不是仓库内的相对路径')
    expect(await treeKind(root, 'skills/a')).toBe('directory')
    expect(await treeFiles(root, 'skills/a')).toEqual(['SKILL.md', 'references/r.md'])
    expect(await treeFiles(root, 'escape')).toEqual([])
    expect(await treeFiles(root, 'skills/none')).toEqual([])
  })
})
