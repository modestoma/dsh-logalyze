/**
 * 应用仓库中的可选 SKILL 清单：扫描 `.dsh/skills/*\/SKILL.md` 与
 * `.agents/skills/*\/SKILL.md`，读出 frontmatter 的 `name` 与 `description`。
 * 主会话读取代码快照或工作区时，DSH 不会在那里发现 SKILL，模型按这里给出的
 * 路径直接读取。
 *
 * @module dsh-supervisor/apps/repo-skills
 */

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'

/** Discovered optional skill inside a checked-out application repository. */
export interface DiscoveredRepoSkill {
  readonly name: string
  readonly description: string
  readonly path: string
  readonly source: '.dsh/skills' | '.agents/skills'
}

/**
 * List the optional skills of a repository checkout.
 * @param repoDir - repository root (snapshot or workspace).
 * @returns the skills found, sorted by directory within each root; unreadable entries are skipped.
 */
export async function scanRepoSkills(repoDir: string): Promise<DiscoveredRepoSkill[]> {
  const found: DiscoveredRepoSkill[] = []
  const roots: ReadonlyArray<{ rel: string; source: '.dsh/skills' | '.agents/skills' }> = [
    { rel: '.dsh/skills', source: '.dsh/skills' },
    { rel: '.agents/skills', source: '.agents/skills' },
  ]
  for (const root of roots) {
    const absRoot = join(repoDir, root.rel)
    let names: string[]
    try {
      names = await readdir(absRoot)
    } catch {
      continue
    }
    for (const entry of names.sort()) {
      const skillFile = join(absRoot, entry, 'SKILL.md')
      try {
        const content = await readFile(skillFile, 'utf8')
        const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(content)
        const parsed = match === null ? {} : (parseYaml(match[1] ?? '') as Record<string, unknown> | null ?? {})
        const name = typeof parsed.name === 'string' && parsed.name.trim() !== '' ? parsed.name.trim() : entry
        const description = typeof parsed.description === 'string' ? parsed.description.trim() : ''
        found.push({
          name,
          description,
          path: `${root.rel}/${entry}/SKILL.md`,
          source: root.source,
        })
      } catch {
        // Ignore subdirectories without a readable SKILL.md
      }
    }
  }
  return found
}
