/**
 * `logalyze_dispatch` 派发工具：校验应用与日志，下载 URL 日志，按应用并行
 * 启动子 Agent（工作目录为应用仓库），等待全部结束后一次返回各应用结论。
 *
 * - 应用 id 必须与注册表一一对应且仓库可用，否则整次调用被拒绝、不启动任何子 Agent。
 * - 日志一律以绝对路径交给子 Agent；URL 先下载到本次运行目录
 *   `<父会话目录>/.logalyze/runs/<runId>/<序号>-<应用 id>/`，该目录也是子 Agent
 *   解压日志的可写目录。分析接口话题里的日志编号（`{ ref: "L1" }`）按本话题的
 *   分析记录找到日志平台的 log_id，派发时现取临时下载链接下载到同一目录；
 *   链接不进入模型可见的内容。
 * - 超时（`dispatchTimeoutMs`）或调用被取消时停止全部仍在运行的子 Agent。
 * - 开启 SKILL 改进时，可写仓库（dsh-repo 权限「可改代码」或「可合并」）的子 Agent
 *   在 SKILL 不足时于运行目录写 `skill-gap.md`；派发结束后检查已完成任务的记录，
 *   并在结果中标出 SKILL 不足，供父 Agent 在汇总回复末尾给出改进建议，用户在之后
 *   的消息里同意后再改进。只读仓库的子 Agent 不记录。
 * - 每个任务的结果带上应用仓库地址和分析的提交，后续修复代码可以从同一仓库和
 *   提交开始。
 * - 子会话（委派深度大于 0）中不提供本工具。
 *
 * @module dsh-logalyze/dispatch/tool
 */

import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type { LeasedApp, RepoRegistry } from '../apps/registry.ts'
import { describeIssue } from '../config.ts'
import type { ContentBlock, SubagentService, ToolDefinition, ToolRunContext, WorkingDirectoryService } from '../host.ts'
import type { GapCheck } from '../improve/gap.ts'
import type { AnalyzedTask } from '../improve/tool.ts'
import { runChild } from '../runs/child.ts'
import type { ChildStatus } from '../runs/child.ts'
import { admitLogs, dispatchLogSchema, materializeLogs } from '../runs/logs.ts'
import type { PlatformLogDownloader, PlatformLogRef } from '../runs/logs.ts'
import { newRunId, resolveRunBase, RUNS_SEGMENTS, topLevelAgent } from '../runs/run-dir.ts'
import type { EditableSettings } from '../settings/contract.ts'
import { DISPATCH_TOOL_NAME, IMPROVE_TOOL_NAME } from '../tool-names.ts'
import { renderChildPrompt } from './prompt.ts'

const argsSchema = z.object({
  tasks: z.array(z.object({
    app: z.string().trim().min(1),
    question: z.string().trim().min(1, 'question 不能为空'),
    logs: z.array(dispatchLogSchema).min(1, '每个任务至少需要一份日志'),
  }).strict()).min(1, '至少需要一个任务'),
}).strict()

/** Validated dispatch arguments. */
export type DispatchArgs = z.output<typeof argsSchema>


/** One application's outcome. */
export interface TaskResult {
  app: string
  name: string
  /** Repository address of the application. */
  url: string
  /** Commit the child analyzed. */
  commit: string
  status: ChildStatus
  childId?: string
  /** The child's final answer text (possibly partial when not completed). */
  output: string
  /** Failure detail separate from the child's own words. */
  diagnostic?: string
  /** Writable run directory of this task. */
  workDir: string
  /** Absolute log paths handed to the child. */
  logs: string[]
  /** The SKILL gap record the child wrote, when SKILL improvement is enabled, the repository is writable, and the child wrote one. */
  skillGap?: GapCheck
}

/** Canonical tool value. */
export interface DispatchValue {
  runId: string
  runDir: string
  results: TaskResult[]
}

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['runId', 'runDir', 'results'],
  properties: {
    runId: { type: 'string' },
    runDir: { type: 'string' },
    results: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['app', 'name', 'url', 'commit', 'status', 'output', 'workDir', 'logs'],
        properties: {
          app: { type: 'string' },
          name: { type: 'string' },
          url: { type: 'string' },
          commit: { type: 'string' },
          status: { type: 'string' },
          childId: { type: 'string' },
          output: { type: 'string' },
          diagnostic: { type: 'string' },
          workDir: { type: 'string' },
          logs: { type: 'array', items: { type: 'string' } },
          skillGap: {
            type: 'object',
            additionalProperties: false,
            required: ['ok'],
            properties: {
              ok: { type: 'boolean' },
              path: { type: 'string' },
              preview: { type: 'string' },
              error: { type: 'string' },
            },
          },
        },
      },
    },
  },
} as const

const STATUS_LABELS: Record<string, string> = {
  completed: '完成',
  aborted: '已取消',
  error: '出错',
  'max-tokens': '输出超长被截断',
  refusal: '拒绝执行',
  timeout: '超时被停止',
  failed: '未能启动',
}

function renderGap(result: TaskResult): string {
  const gap = result.skillGap
  if (gap === undefined) return ''
  if (!gap.ok) return `\n\nSKILL 不足记录不可用：${gap.error}`
  return `\n\nSKILL 不足（记录在 ${gap.path}）：${gap.preview}\n在汇总回复末尾的「SKILL 改进建议」中用一两句说明，并问用户是否改进。本回合不要调用 ${IMPROVE_TOOL_NAME}（工具会拒绝）；用户同意后再调用，app 为 ${result.app}。`
}

/**
 * Model-facing rendering of a dispatch value.
 * @param value - canonical value.
 * @returns text content.
 */
export function renderDispatchValue(value: DispatchValue): ContentBlock[] {
  const sections = value.results.map((result) => {
    const label = STATUS_LABELS[result.status] ?? result.status
    const body = result.output.trim() === '' ? '（子 Agent 没有给出结论）' : result.output.trim()
    const diagnostic = result.diagnostic === undefined ? '' : `\n\n诊断：${result.diagnostic}`
    return `### ${result.name}（${result.app}）— ${label}\n\n仓库 ${result.url}，提交 ${result.commit.slice(0, 12)}\n\n${body}${diagnostic}${renderGap(result)}`
  })
  return [{ type: 'text', text: `观象派发 ${value.runId} 结束，运行目录 ${value.runDir}。\n\n${sections.join('\n\n')}` }]
}

/**
 * Raw JSON-schema parameters. Application ids and the task ceiling change
 * with the registry and settings, so the entry skill lists them and
 * `execute` enforces them; the definition itself stays fixed for the
 * plugin's lifetime.
 */
export const DISPATCH_PARAMETERS: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['tasks'],
  properties: {
    tasks: {
      type: 'array',
      description: '要分析的任务，每个应用一项，项数不超过入口 SKILL 给出的上限。',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['app', 'question', 'logs'],
        properties: {
          app: { type: 'string', description: '应用 id，取自入口 SKILL 的应用目录。' },
          question: { type: 'string', description: '给子 Agent 的完整问题：现象、时间范围、关键标识与用户原话要点。子 Agent 看不到当前对话。' },
          logs: {
            type: 'array',
            description: '日志位置。{ "path": 本机绝对路径 } 用于附件和本机文件；{ "url": 下载地址 } 用于对象存储链接（仅白名单域名）；{ "ref": "L1" } 用于分析接口话题首轮消息日志表里的编号（由观象向日志平台取链接下载）。',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string', description: '本机日志文件或目录的绝对路径。' },
                url: { type: 'string', description: '日志下载地址。' },
                ref: { type: 'string', description: '分析接口话题的日志编号，如 L1。' },
                filter: { type: 'string', description: '混合日志中本应用相关行的识别方式，例如 tag 或进程名。' },
              },
            },
          },
        },
      },
    },
  },
}

/** Collaborators of the dispatch tool. */
export interface DispatchDeps {
  readonly registry: RepoRegistry
  readonly subagents: SubagentService
  /** Current effective settings. */
  settings(): EditableSettings
  /** Registered `ctx.subagents` provider name. */
  readonly provider: string
  /** The working-directory service, when the composition has one. */
  workingDirectory(): WorkingDirectoryService | undefined
  /** SKILL gap records; omitted never mentions them to children. */
  readonly gaps?: GapInbox
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

/** Where finished tasks go to have their SKILL gap records checked. */
export interface GapInbox {
  /** Whether children are told to record SKILL gaps. */
  enabled(): boolean
  /**
   * Check a finished task's gap record and remember the task when it has one.
   * @param task - the finished analysis.
   * @returns the check, or undefined when the task wrote no record.
   */
  inspect(task: AnalyzedTask): Promise<GapCheck | undefined>
}

/** Runs dispatches; one instance serves every registration of the tool. */
export class Dispatcher {
  /** @param deps - registry, subagent service, settings, and I/O seams. */
  constructor(private readonly deps: DispatchDeps) {}

  /**
   * Build the tool definition.
   * @returns the registration.
   */
  definition(): ToolDefinition<DispatchValue> {
    return {
      name: DISPATCH_TOOL_NAME,
      description: '观象：把日志分析任务派发给在对应应用代码仓库中工作的子 Agent，并等待全部完成后返回各应用的结论。'
        + '仅在 /logalyze 入口 SKILL 的流程中使用；一次调用包含所有任务。',
      parameters: DISPATCH_PARAMETERS,
      output: {
        schema: OUTPUT_SCHEMA,
        render: (_args, value) => renderDispatchValue(value),
      },
      isConcurrencySafe: () => false,
      execute: (args, exec) => this.execute(args, exec),
    }
  }

  /**
   * Run one dispatch.
   * @param rawArgs - model arguments.
   * @param exec - execution context of the calling agent.
   * @returns every task's outcome.
   * @throws when arguments, applications, logs, or downloads are invalid; nothing is started then.
   */
  async execute(rawArgs: unknown, exec: ToolRunContext): Promise<DispatchValue> {
    const parsed = argsSchema.safeParse(rawArgs)
    if (!parsed.success) throw new Error(`${DISPATCH_TOOL_NAME} 参数不合法：${describeIssue(parsed.error)}`)
    const { tasks } = parsed.data
    const parent = topLevelAgent(exec, DISPATCH_TOOL_NAME)
    const settings = this.deps.settings()
    if (tasks.length > settings.maxAppsPerRequest) {
      throw new Error(`一次最多派发 ${settings.maxAppsPerRequest} 个任务，本次有 ${tasks.length} 个；请合并或分批`)
    }
    const { effectiveDir, baseDir } = await resolveRunBase(parent, this.deps.workingDirectory(), exec.signal)
    const refs = this.deps.platformLogs?.(parent.session.header.id)
    const sources = await Promise.all(tasks.map(task => admitLogs(task.logs, effectiveDir, settings.download, refs)))

    const lease = await this.deps.registry.acquire(tasks.map(task => task.app))
    try {
      exec.signal.throwIfAborted()
      const runId = newRunId(this.deps.now?.() ?? new Date())
      const runDir = join(baseDir, ...RUNS_SEGMENTS, runId)
      const prepared = await Promise.all(tasks.map(async (task, index) => {
        const ready = lease.apps.get(task.app)
        if (ready === undefined) throw new Error(`应用「${task.app}」不可用`)
        const workDir = join(runDir, `${index + 1}-${task.app}`)
        await mkdir(workDir, { recursive: true })
        const logs = await materializeLogs(sources[index] ?? [], workDir, settings.download, exec.signal, this.deps.fetch, this.deps.platform)
        return { task, ready, workDir, logs }
      }))
      const gaps = this.deps.gaps?.enabled() === true ? this.deps.gaps : undefined
      // Read-only repositories cannot take a SKILL improvement, so their children record no gaps.
      const recordsGaps = (ready: LeasedApp): boolean => gaps !== undefined && ready.writable && ready.app.skill !== undefined
      const results = await Promise.all(prepared.map(async ({ task, ready, workDir, logs }): Promise<TaskResult> => {
        const outcome = await runChild({
          subagents: this.deps.subagents,
          provider: this.deps.provider,
          parent,
          label: `${ready.app.name}分析`,
          cwd: ready.dir,
          prompt: renderChildPrompt({ app: ready.app, commit: ready.commit, question: task.question, logs, workDir, gaps: recordsGaps(ready) }),
          timeoutMs: settings.dispatchTimeoutMs,
          signal: exec.signal,
        })
        return { app: ready.app.id, name: ready.app.name, url: ready.url, commit: ready.commit, workDir, logs: logs.map(log => log.path), ...outcome }
      }))
      exec.signal.throwIfAborted()
      if (gaps !== undefined) {
        await Promise.all(results.map(async (result, index) => {
          const item = prepared[index]
          if (result.status !== 'completed' || item === undefined || !recordsGaps(item.ready)) return
          const check = await gaps.inspect({
            workDir: result.workDir,
            sessionId: parent.session.header.id,
            app: item.ready.app,
            url: item.ready.url,
            commit: item.ready.commit,
            question: item.task.question,
            output: result.output,
            logs: result.logs,
          })
          if (check !== undefined) result.skillGap = check
        }))
      }
      return { runId, runDir, results }
    } finally {
      lease.release()
    }
  }
}
