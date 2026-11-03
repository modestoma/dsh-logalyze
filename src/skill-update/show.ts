/**
 * `logalyze_show_skill`：从 `dshRepos` 镜像只读地读出某个可用应用的日志分析
 * SKILL（`.agents/skills/<skill>/`）在最新同步提交中的文件列表和一个文件的
 * 内容，默认是 `SKILL.md`。用户要纠正或改进 SKILL 时，顶层 Agent 先用它对照
 * 现有内容和用户讨论。不读取 SKILL 目录以外的文件，不改动任何镜像或快照。
 * 子会话中不提供本工具。
 *
 * @module dsh-logalyze/skill-update/show
 */

import { z } from 'zod'
import { describeIssue } from '../config.ts'
import { isDelegatedAgent } from '../dispatch/tool.ts'
import type { ContentBlock, ToolDefinition, ToolRunContext } from '../host.ts'
import { requireRepos } from '../repos/lookup.ts'
import { skillDir } from '../repos/manifest.ts'
import type { RepoRegistry } from '../repos/registry.ts'
import { SHOW_TOOL_NAME } from './names.ts'

/** Characters of the shown file returned to the model; longer files are cut. */
export const MAX_SHOWN_CHARS = 60_000

const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/

const argsSchema = z.object({
  app: z.string().trim().min(1, 'app 不能为空'),
  path: z.string().trim().min(1).refine(value => value.split('/').every(segment => SEGMENT.test(segment)), 'path 只能是 SKILL 目录内的相对路径，例如 references/payment.md').optional(),
}).strict()

/** Canonical tool value. */
export interface ShowSkillValue {
  app: string
  repo: string
  commit: string
  /** SKILL directory from the repository root. */
  dir: string
  /** Files below {@link dir}, relative to it. */
  files: string[]
  /** Shown file, relative to {@link dir}. */
  path: string
  content: string
  /** Whether {@link content} was cut at {@link MAX_SHOWN_CHARS}. */
  truncated: boolean
}

const PARAMETERS: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['app'],
  properties: {
    app: { type: 'string', description: '应用 id。' },
    path: { type: 'string', description: 'SKILL 目录内要查看的文件，例如 references/payment.md 或 cases/2026-10-31-pay-timeout.md；省略时查看 SKILL.md。' },
  },
}

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['app', 'repo', 'commit', 'dir', 'files', 'path', 'content', 'truncated'],
  properties: {
    app: { type: 'string' },
    repo: { type: 'string' },
    commit: { type: 'string' },
    dir: { type: 'string' },
    files: { type: 'array', items: { type: 'string' } },
    path: { type: 'string' },
    content: { type: 'string' },
    truncated: { type: 'boolean' },
  },
} as const

/**
 * Model-facing rendering of a shown SKILL file.
 * @param value - canonical value.
 * @returns text content.
 */
export function renderShowSkillValue(value: ShowSkillValue): ContentBlock[] {
  const cut = value.truncated ? `\n\n（内容超过 ${MAX_SHOWN_CHARS} 个字符，已截断）` : ''
  return [{
    type: 'text',
    text: `应用 ${value.app} 的日志分析 SKILL ${value.dir}/（${value.repo} 提交 ${value.commit.slice(0, 12)}）\n文件：${value.files.join('、')}\n\n## ${value.path}\n\n${value.content}${cut}`,
  }]
}

/** Collaborators of the view tool. */
export interface SkillViewerDeps {
  readonly registry: RepoRegistry
  /** What `ctx.get('dshRepos')` returns now. */
  repos(): unknown
}

/** Reads application SKILLs from the mirror. */
export class SkillViewer {
  /** @param deps - registry and `dshRepos` access. */
  constructor(private readonly deps: SkillViewerDeps) {}

  /**
   * Build the tool definition.
   * @returns the registration.
   */
  definition(): ToolDefinition<ShowSkillValue> {
    return {
      name: SHOW_TOOL_NAME,
      description: '观象：查看某个应用的日志分析 SKILL 在仓库最新提交中的文件列表和一个文件的内容（默认 SKILL.md），只读。'
        + '用户要纠正或改进日志分析 SKILL 时，先用它对照现有内容和用户讨论。',
      parameters: PARAMETERS,
      output: {
        schema: OUTPUT_SCHEMA,
        render: (_args, value) => renderShowSkillValue(value),
      },
      isConcurrencySafe: () => true,
      execute: (args, exec) => this.execute(args, exec),
    }
  }

  /**
   * Read one SKILL file.
   * @param rawArgs - model arguments.
   * @param exec - execution context of the calling agent.
   * @returns the file list and the file.
   * @throws when the arguments, application, file, or `dshRepos` service are unusable.
   */
  async execute(rawArgs: unknown, exec: ToolRunContext): Promise<ShowSkillValue> {
    const parsed = argsSchema.safeParse(rawArgs)
    if (!parsed.success) throw new Error(`${SHOW_TOOL_NAME} 参数不合法：${describeIssue(parsed.error)}`)
    const agent = exec.agent
    if (agent !== undefined && isDelegatedAgent(agent)) throw new Error(`${SHOW_TOOL_NAME} 不能在子 Agent 中调用`)
    const { app, url, commit } = this.deps.registry.readyApp(parsed.data.app)
    const repos = requireRepos(this.deps.repos())
    const dir = skillDir(app.skill)
    const options = { signal: exec.signal }
    const files = (await repos.listMirrorTree(url, commit, dir, options))
      .filter(entry => entry.type === 'file')
      .map(entry => entry.path.slice(dir.length + 1))
      .sort()
    const path = parsed.data.path ?? 'SKILL.md'
    if (!files.includes(path)) throw new Error(`${dir}/${path} 不存在；SKILL 目录中的文件：${files.join('、')}`)
    const text = await repos.readMirrorFile(url, commit, `${dir}/${path}`, options) ?? ''
    const truncated = text.length > MAX_SHOWN_CHARS
    return { app: app.id, repo: url, commit, dir, files, path, content: truncated ? text.slice(0, MAX_SHOWN_CHARS) : text, truncated }
  }
}
