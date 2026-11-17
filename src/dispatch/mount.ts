/**
 * `supervisor_mount_apps`：`/supervisor` 默认流程中，主会话自己读日志和代码。
 * 工具为当前会话挂载各应用最新同步提交的只读代码快照（dsh-repo 按提交共享，
 * 多个会话读同一提交时共用同一份文件），并把日志准备到运行目录。
 *
 * - 应用 id 必须都可用，否则整次调用被拒绝、不挂载也不下载。
 * - 日志校验与下载与 `supervisor_dispatch` 相同：本机路径原样返回；URL 与
 *   分析接口话题的日志编号下载到 `<会话目录>/.supervisor/runs/<runId>/`，
 *   该目录也是解压日志和中间文件的可写目录。平台的临时下载链接不进入模型
 *   可见的内容。
 * - 快照由会话持有，空闲 `snapshotHoldMs` 后释放（见 `runs/mounts.ts`）；同一
 *   会话再次调用时沿用未变的快照。
 * - 主会话的 SKILL 目录不包含快照里的仓库 SKILL，结果按路径列出它们。
 * - 子会话中不提供本工具。
 *
 * @module dsh-supervisor/dispatch/mount
 */

import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { skillDir } from '../apps/manifest.ts'
import { scanRepoSkills } from '../apps/repo-skills.ts'
import type { DiscoveredRepoSkill } from '../apps/repo-skills.ts'
import { describeIssue } from '../config.ts'
import type { ContentBlock, ToolDefinition, ToolRunContext, WorkingDirectoryService } from '../host.ts'
import { admitLogs, dispatchLogSchema, materializeLogs } from '../runs/logs.ts'
import type { PlatformLogDownloader, PlatformLogRef } from '../runs/logs.ts'
import type { SessionMounts } from '../runs/mounts.ts'
import { newRunId, resolveRunBase, RUNS_SEGMENTS, topLevelAgent } from '../runs/run-dir.ts'
import type { EditableSettings } from '../settings/contract.ts'
import { DISPATCH_TOOL_NAME, MOUNT_TOOL_NAME } from '../tool-names.ts'

const argsSchema = z.object({
  apps: z.array(z.string().trim().min(1)).min(1, '至少需要一个应用'),
  logs: z.array(dispatchLogSchema).optional(),
}).strict()

/** One mounted application in the tool value. */
export interface MountedAppValue {
  app: string
  name: string
  /** Repository address. */
  url: string
  /** Commit of the snapshot. */
  commit: string
  /** Analysis branch, when the repository names one. */
  branch?: string
  /** Whether the repository accepts SKILL improvements and code changes. */
  writable: boolean
  /** Absolute read-only snapshot directory. */
  dir: string
  /** Repository-relative directory of the application's analysis SKILL, when it has one. */
  skill?: string
  /** Optional skills found in the snapshot, with repository-relative `SKILL.md` paths. */
  skills: DiscoveredRepoSkill[]
}

/** One prepared log in the tool value. */
export interface MountedLogValue {
  /** Absolute local path. */
  path: string
  /** Model-given download address the file came from. */
  url?: string
  /** Analyze API log number the file came from. */
  ref?: string
  /** How to pick one application's lines out of a mixed log. */
  filter?: string
}

/** Canonical tool value. */
export interface MountValue {
  runId: string
  runDir: string
  apps: MountedAppValue[]
  logs: MountedLogValue[]
}

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['runId', 'runDir', 'apps', 'logs'],
  properties: {
    runId: { type: 'string' },
    runDir: { type: 'string' },
    apps: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['app', 'name', 'url', 'commit', 'writable', 'dir', 'skills'],
        properties: {
          app: { type: 'string' },
          name: { type: 'string' },
          url: { type: 'string' },
          commit: { type: 'string' },
          branch: { type: 'string' },
          writable: { type: 'boolean' },
          dir: { type: 'string' },
          skill: { type: 'string' },
          skills: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['name', 'description', 'path', 'source'],
              properties: { name: { type: 'string' }, description: { type: 'string' }, path: { type: 'string' }, source: { type: 'string' } },
            },
          },
        },
      },
    },
    logs: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['path'],
        properties: { path: { type: 'string' }, url: { type: 'string' }, ref: { type: 'string' }, filter: { type: 'string' } },
      },
    },
  },
} as const

/**
 * Model-facing rendering of a mount value.
 * @param value - canonical value.
 * @returns text content.
 */
export function renderMountValue(value: MountValue): ContentBlock[] {
  const apps = value.apps.map((app) => {
    const skills = app.skills.length === 0
      ? '仓库里没有可选 SKILL，直接结合日志与代码分析。'
      : `仓库 SKILL（按需读取对应的 SKILL.md 并按其中的方法分析，相对路径都在代码目录下）：\n${app.skills.map(skill => `  - \`${skill.path}\` ${skill.name}${skill.description === '' ? '' : `：${skill.description}`}`).join('\n')}`
    const main = app.skill === undefined ? '' : `\n- 日志分析 SKILL：\`${app.skill}/SKILL.md\``
    return `### ${app.name}（${app.app}）\n\n- 代码目录（只读快照）：\`${app.dir}\`\n- 仓库 ${app.url}，提交 ${app.commit.slice(0, 12)}${app.branch === undefined ? '' : `，分支 ${app.branch}`}${app.writable ? '' : '，只读仓库'}${main}\n- ${skills}`
  })
  const logs = value.logs.length === 0
    ? '（本次没有准备日志）'
    : value.logs.map((log) => {
        const origin = log.ref !== undefined ? `（日志 ${log.ref}）` : log.url === undefined ? '' : `（下载自 ${log.url}）`
        return `- \`${log.path}\`${origin}${log.filter === undefined ? '' : `；只看相关部分：${log.filter}`}`
      }).join('\n')
  return [{
    type: 'text',
    text: `观象已挂载应用代码，运行目录 \`${value.runDir}\`。\n\n${apps.join('\n\n')}\n\n## 日志\n\n${logs}\n\n`
      + '代码目录是多个会话共享的只读快照：只读取和搜索，不要修改、新建或删除其中的文件，不要执行 git 写操作。解压结果和中间文件放在运行目录。'
      + `代码目录在空闲一段时间后释放；之后读取失败时再调用一次 \`${MOUNT_TOOL_NAME}\`。`,
  }]
}

/** Raw JSON-schema parameters; application ids and the ceiling come from the entry skill and are enforced by `execute`. */
export const MOUNT_PARAMETERS: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['apps'],
  properties: {
    apps: {
      type: 'array',
      description: '要读取代码的应用 id，取自入口 SKILL 的应用目录，项数不超过入口 SKILL 给出的上限。',
      items: { type: 'string' },
    },
    logs: {
      type: 'array',
      description: '要准备的日志。{ "path": 本机绝对路径 } 用于附件和本机文件；{ "url": 下载地址 } 用于对象存储链接（仅白名单域名）；{ "ref": "L1" } 用于分析接口话题首轮消息日志表里的编号（由观象向日志平台取链接下载）。',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', description: '本机日志文件或目录的绝对路径。' },
          url: { type: 'string', description: '日志下载地址。' },
          ref: { type: 'string', description: '分析接口话题的日志编号，如 L1。' },
          filter: { type: 'string', description: '混合日志中相关行的识别方式，例如 tag 或进程名。' },
        },
      },
    },
  },
}

/** Collaborators of the mount tool. */
export interface MountDeps {
  readonly mounts: Pick<SessionMounts, 'mount'>
  /** Current effective settings. */
  settings(): EditableSettings
  /** The working-directory service, when the composition has one. */
  workingDirectory(): WorkingDirectoryService | undefined
  /**
   * The platform logs of the analyze API topic a top-level Session belongs to.
   * @returns a resolver of log numbers, or undefined when the Session is not such a topic (log numbers are refused).
   */
  platformLogs?(sessionId: string): ((ref: string) => PlatformLogRef) | undefined
  /** Downloads platform logs named by log number. */
  readonly platform?: PlatformLogDownloader
  readonly fetch?: typeof fetch
  readonly now?: () => Date
}

/** Runs mounts; one instance serves every registration of the tool. */
export class AppMounter {
  /** @param deps - session mounts, settings, and I/O seams. */
  constructor(private readonly deps: MountDeps) {}

  /**
   * Build the tool definition.
   * @returns the registration.
   */
  definition(): ToolDefinition<MountValue> {
    return {
      name: MOUNT_TOOL_NAME,
      description: '观象：为当前会话挂载应用的只读代码快照（多会话共享），并把日志准备到运行目录，供你自己读取日志和代码分析。'
        + `仅在 /supervisor 入口 SKILL 的流程中使用；需要并行交给子 Agent 时改用 ${DISPATCH_TOOL_NAME}。`,
      parameters: MOUNT_PARAMETERS,
      output: {
        schema: OUTPUT_SCHEMA,
        render: (_args, value) => renderMountValue(value),
      },
      isConcurrencySafe: () => false,
      execute: (args, exec) => this.execute(args, exec),
    }
  }

  /**
   * Mount the applications and prepare the logs.
   * @param rawArgs - model arguments.
   * @param exec - execution context of the calling agent.
   * @returns the mounted applications and prepared logs.
   * @throws when arguments, applications, logs, or downloads are invalid.
   */
  async execute(rawArgs: unknown, exec: ToolRunContext): Promise<MountValue> {
    const parsed = argsSchema.safeParse(rawArgs)
    if (!parsed.success) throw new Error(`${MOUNT_TOOL_NAME} 参数不合法：${describeIssue(parsed.error)}`)
    const apps = [...new Set(parsed.data.apps)]
    const parent = topLevelAgent(exec, MOUNT_TOOL_NAME)
    const settings = this.deps.settings()
    if (apps.length > settings.maxAppsPerRequest) {
      throw new Error(`一次最多挂载 ${settings.maxAppsPerRequest} 个应用，本次有 ${apps.length} 个；请分批`)
    }
    const { effectiveDir, baseDir } = await resolveRunBase(parent, this.deps.workingDirectory(), exec.signal)
    const refs = this.deps.platformLogs?.(parent.session.header.id)
    const sources = await admitLogs(parsed.data.logs ?? [], effectiveDir, settings.download, refs)
    // Mounting before the downloads refuses unusable applications without downloading anything.
    await this.deps.mounts.mount(parent.session.header.id, apps)
    exec.signal.throwIfAborted()
    const runId = newRunId(this.deps.now?.() ?? new Date())
    const runDir = join(baseDir, ...RUNS_SEGMENTS, runId)
    await mkdir(runDir, { recursive: true })
    const logs = await materializeLogs(sources, runDir, settings.download, exec.signal, this.deps.fetch, this.deps.platform)
    // Mounting again after the downloads restarts the hold period, and acquires the snapshots again when a long download outlasted it.
    const mounted = await this.deps.mounts.mount(parent.session.header.id, apps)
    return {
      runId,
      runDir,
      apps: await Promise.all(mounted.map(async ready => ({
        app: ready.app.id,
        name: ready.app.name,
        url: ready.url,
        commit: ready.commit,
        ...ready.branch === undefined ? {} : { branch: ready.branch },
        writable: ready.writable,
        dir: ready.dir,
        ...ready.app.skill === undefined ? {} : { skill: skillDir(ready.app.skill) },
        skills: await scanRepoSkills(ready.dir),
      }))),
      logs: logs.map(log => ({
        path: log.path,
        ...log.url === undefined ? {} : { url: log.url },
        ...log.platformLog === undefined ? {} : { ref: log.platformLog.ref },
        ...log.filter === undefined ? {} : { filter: log.filter },
      })),
    }
  }
}
