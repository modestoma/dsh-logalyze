/**
 * `logalyze_improve_skill`：询问用户是否改进某个应用的日志分析 SKILL；用户
 * 同意后派一个改进子 Agent 修改 SKILL（需要时把问题整理为案例），再提交到新
 * 分支、创建合并请求供用户评审。改进的依据有两种，至少要有一种：
 *
 * - 一次分析：参数 `workDir` 是本进程中同一会话派发并已完成的任务运行目录。
 *   应用、仓库、问题、结论和日志取自派发记录，不取自运行目录里可被 Agent 改写
 *   的内容；分析子 Agent 写了 `skill-gap.md` 时一并交给改进子 Agent。
 * - 用户反馈：参数 `feedback` 是父 Agent 转述的用户纠正或要求。没有分析时用
 *   `app` 指定应用，可附样例日志。
 *
 * 其余规则：
 *
 * - 询问经 DSH 审批服务（`ctx.approval`）一次性请求；dsh_channels 把它显示为
 *   飞书决策卡片，DSH Web 显示为审批提示。只有 `allowed-once` 才起草和提交，
 *   之后不再询问；没有审批服务时工具报错。
 * - 观象在运行目录下的 `improve-<序号>/repo/` 打开应用最新同步提交的可写工作区，
 *   改进子 Agent 以它为工作目录、首行 `/logalyze-improve`，直接修改
 *   `.agents/skills/<skill>/`，改动说明写在工作区之外的 `improve-<序号>/reason.md`；
 *   超时（`dispatchTimeoutMs`）或调用被取消时停止它。
 * - 改动只能是 `.agents/skills/<skill>/` 下新增或修改的文件；依据一次分析时必须
 *   新增或修改 `cases/` 下的一个案例。合格后推送到新分支
 *   `logalyze/skill-<应用 id>-<改动摘要前缀>`，从不推送到已有分支或默认分支。
 * - 工作区、推送和合并请求经 `dshRepos` 服务完成。子会话中不提供本工具。
 *
 * @module dsh-logalyze/skill-update/tool
 */

import { randomBytes } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import { describeIssue } from '../config.ts'
import { runChild } from '../dispatch/child.ts'
import type { ChildOutcome } from '../dispatch/child.ts'
import type { ChildLog } from '../dispatch/prompt.ts'
import { admitLogs, isDelegatedAgent, logSchema, materializeLogs, newRunId, resolveRunBase, RUNS_SEGMENTS } from '../dispatch/tool.ts'
import type { LogSource } from '../dispatch/tool.ts'
import type { Agent, ContentBlock, HostApproval, SubagentService, ToolDefinition, ToolRunContext, WorkingDirectoryService } from '../host.ts'
import type { CommitAuthor } from '../repos/contract.ts'
import { messageOf, requireRepos } from '../repos/lookup.ts'
import { disablesUserInvocation, skillDir, skillNameOf } from '../repos/manifest.ts'
import type { RepoRegistry } from '../repos/registry.ts'
import type { AppManifest, EditableSettings } from '../settings/contract.ts'
import { askApproval, pushChange } from './commit.ts'
import type { SubmitStatus } from './commit.ts'
import { GAP_FILE, GAP_PREVIEW_CHARS, previewOf, readGap } from './gap.ts'
import type { GapCheck } from './gap.ts'
import { IMPROVE_TOOL_NAME, SHOW_TOOL_NAME } from './names.ts'
import { ProposalError, replaceFile } from './files.ts'
import { CASES_DIR, renderImprovePrompt } from './prompt.ts'
import { checkChanges, describeFiles, DIFF_FILE, readReason, WORKSPACE_DIR } from './workspace.ts'
import type { CheckedChanges, FileStat } from './workspace.ts'

/** Longest commit subject and merge request title taken from the reason. */
export const MAX_TITLE_CHARS = 120

/** Longest accepted user feedback. */
export const MAX_FEEDBACK_CHARS = 8000

/** Analyzed tasks remembered for improvement; older ones are forgotten first. */
const MAX_REMEMBERED_TASKS = 256

/** Characters of the analysis conclusion handed to the improvement child. */
const MAX_CONCLUSION_CHARS = 8000

/** Characters of the reason sent as the merge request description; the commit message keeps all of it. */
const REASON_DESCRIPTION_CHARS = 2000

const CASE_PATH = new RegExp(`^${CASES_DIR}/[^/]+\\.md$`)

/** A finished analysis as the dispatch tool recorded it. */
export interface AnalyzedTask {
  /** Absolute run directory of the task. */
  readonly workDir: string
  /** Session that dispatched the task. */
  readonly sessionId: string
  readonly app: AppManifest
  /** Repository address the application came from. */
  readonly url: string
  /** Commit the child analyzed. */
  readonly commit: string
  /** The question the child received. */
  readonly question: string
  /** The child's final answer. */
  readonly output: string
  /** Absolute log paths handed to the child. */
  readonly logs: readonly string[]
}

/** How one improvement ended: a submission status, or `failed` when no submittable change came out. */
export type ImproveStatus = SubmitStatus | 'failed'

/** Canonical tool value. */
export interface ImproveValue {
  status: ImproveStatus
  app: string
  repo: string
  /** The analysis task's run directory, when the improvement follows an analysis. */
  workDir?: string
  /** The improvement child's run directory; present once the user agreed. */
  improveDir?: string
  /** New branch the change was or would be pushed to. */
  branch?: string
  /** Branch the merge request targets. */
  target?: string
  files?: FileStat[]
  /** Diff file in the improvement run directory. */
  diffPath?: string
  /** The improvement child's summary of its changes. */
  output?: string
  mergeRequestUrl?: string
  /** Why the merge request was not created; only with `pushed`. */
  mergeRequestError?: string
  /** Why no change was submitted; only with `failed`. */
  error?: string
}

const argsSchema = z.object({
  workDir: z.string().trim().min(1).optional(),
  app: z.string().trim().min(1).optional(),
  feedback: z.string().trim().min(1).max(MAX_FEEDBACK_CHARS, `feedback 不能超过 ${MAX_FEEDBACK_CHARS} 个字符`).optional(),
  logs: z.array(logSchema).optional(),
}).strict().refine(args => (args.workDir === undefined) !== (args.app === undefined), 'workDir 和 app 必须给出且只能给出一个')

const PARAMETERS: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    workDir: { type: 'string', description: '本会话中一次已完成的派发任务的运行目录（绝对路径）：改进依据这次分析时填写。' },
    app: { type: 'string', description: '应用 id：本会话没有分析过该应用、改进只依据用户反馈时填写。workDir 与 app 只填一个。' },
    feedback: { type: 'string', description: '用户指出的问题和期望的改法，尽量保留用户原话，写清哪部分不对、正确做法是什么。分析结果没有标出「SKILL 不足」时必填。' },
    logs: {
      type: 'array',
      description: '可选的样例日志。{ "path": 本机绝对路径 } 用于附件和本机文件；{ "url": 下载地址 } 用于对象存储链接（仅白名单域名）。',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: { path: { type: 'string' }, url: { type: 'string' } },
      },
    },
  },
}

const FILE_STAT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['path', 'added', 'removed'],
  properties: { path: { type: 'string' }, added: { type: 'number' }, removed: { type: 'number' } },
} as const

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'app', 'repo'],
  properties: {
    status: { type: 'string', enum: ['opened', 'pushed', 'exists', 'rejected', 'cancelled', 'unavailable', 'failed'] },
    app: { type: 'string' },
    repo: { type: 'string' },
    workDir: { type: 'string' },
    improveDir: { type: 'string' },
    branch: { type: 'string' },
    target: { type: 'string' },
    files: { type: 'array', items: FILE_STAT_SCHEMA },
    diffPath: { type: 'string' },
    output: { type: 'string' },
    mergeRequestUrl: { type: 'string' },
    mergeRequestError: { type: 'string' },
    error: { type: 'string' },
  },
} as const

/**
 * Model-facing rendering of an improvement.
 * @param value - canonical value.
 * @returns text content.
 */
export function renderImproveValue(value: ImproveValue): ContentBlock[] {
  const where = `${value.repo} 的分支 ${value.branch ?? ''}（目标 ${value.target ?? ''}）`
  const head = {
    opened: `SKILL 已改进，提交到 ${where}并创建合并请求：${value.mergeRequestUrl ?? ''}`,
    pushed: `SKILL 已改进并提交到 ${where}，但创建合并请求失败（${value.mergeRequestError ?? '未知原因'}）；请在代码托管平台上从该分支手动创建。`,
    exists: `${where} 已存在，同一改动可能已经提交过，本次没有提交。`,
    rejected: '用户不改进这次的 SKILL，没有起草也没有提交（也可能是会话的审批策略为 never，例如「完全访问」权限模式）。',
    cancelled: '询问被撤回，没有起草也没有提交。',
    unavailable: '当前没有可以回答询问的界面，没有起草也没有提交。',
    failed: `SKILL 改进没有完成，没有提交：${value.error ?? '未知原因'}`,
  }[value.status]
  const files = value.files === undefined || value.files.length === 0 ? '' : `\n改动：${describeFiles(value.files)}`
  const diff = value.diffPath === undefined ? '' : `\ndiff：${value.diffPath}`
  const dir = value.status === 'failed' && value.improveDir !== undefined ? `\n运行目录：${value.improveDir}` : ''
  const output = value.output === undefined || value.output.trim() === '' ? '' : `\n\n改进子 Agent 的说明：\n${value.output.trim()}`
  return [{ type: 'text', text: `${head}${files}${diff}${dir}${output}` }]
}

/** Collaborators of the improvement tool. */
export interface SkillImproverDeps {
  readonly registry: RepoRegistry
  readonly subagents: SubagentService
  /** Registered `ctx.subagents` provider the improvement child starts on. */
  readonly provider: string
  settings(): EditableSettings
  /** The working-directory service, when the composition has one. */
  workingDirectory(): WorkingDirectoryService | undefined
  readonly author?: CommitAuthor
  /** DSH's approval service, when the composition has one. */
  approval(): HostApproval | undefined
  /** What `ctx.get('dshRepos')` returns now. */
  repos(): unknown
  readonly fetch?: typeof fetch
  readonly now?: () => Date
}

/** One improvement after its arguments were checked. */
interface ImproveRequest {
  readonly app: AppManifest
  readonly url: string
  readonly sessionId: string
  /** The analysis the improvement follows. */
  readonly task?: AnalyzedTask
  /** Whether the analysis child wrote a gap record. */
  readonly gap: boolean
  readonly feedback?: string
  readonly sources: readonly LogSource[]
  /** Directory the improvement run directory goes in. */
  readonly parentDir: string
  /** Key that keeps two improvements of the same basis from running at once. */
  readonly key: string
}

/**
 * Check that the changes keep the SKILL loadable and, when required, carry a case.
 * @param changes - the checked workspace changes below the SKILL directory.
 * @param skill - the application's SKILL name.
 * @param caseRequired - whether a case file must be added or updated.
 * @throws ProposalError when a required case is missing, or SKILL.md names another skill or disables user invocation.
 */
function checkImprovement(changes: CheckedChanges, skill: string, caseRequired: boolean): void {
  if (caseRequired && !changes.contents.some(file => CASE_PATH.test(file.relative))) throw new ProposalError(`改动中没有新增或修改案例文件 ${CASES_DIR}/<日期>-<slug>.md`)
  const entry = changes.contents.find(file => file.relative === 'SKILL.md')
  if (entry === undefined) return
  const name = skillNameOf(entry.content)
  if (name !== skill) throw new ProposalError(`SKILL.md 的 frontmatter name 是${name === undefined ? '（缺失）' : `「${name}」`}，必须保持为「${skill}」`)
  if (disablesUserInvocation(entry.content)) throw new ProposalError('SKILL.md 不能设置 user-invocable: false，否则派发时无法用 /<skill> 加载')
}

/** Title for the commit and merge request: the reason's first line without Markdown heading marks. */
function titleOf(reason: string, app: AppManifest): string {
  const line = (reason.split(/\r?\n/).find(text => text.trim() !== '') ?? '').replace(/^#+\s*/, '').trim()
  const title = line === '' ? `改进${app.name}日志分析 SKILL` : line
  return title.length <= MAX_TITLE_CHARS ? title : `${title.slice(0, MAX_TITLE_CHARS - 1)}…`
}

function localDate(now: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/** Remembers finished analyses, asks whether to improve a SKILL, and drafts and submits improvements. */
export class SkillImprover {
  private readonly tasks = new Map<string, AnalyzedTask>()
  private readonly running = new Set<string>()

  /** @param deps - registry, subagents, settings, approval, and `dshRepos` access. */
  constructor(private readonly deps: SkillImproverDeps) {}

  /** @returns whether SKILL improvement is enabled in the current settings. */
  enabled(): boolean {
    return this.deps.settings().skillUpdates.enabled
  }

  /**
   * Remember a finished task and check its gap record.
   * @param task - the finished analysis.
   * @returns the check, or undefined when the task wrote no record.
   */
  async inspect(task: AnalyzedTask): Promise<GapCheck | undefined> {
    this.tasks.delete(task.workDir)
    this.tasks.set(task.workDir, task)
    for (const key of this.tasks.keys()) {
      if (this.tasks.size <= MAX_REMEMBERED_TASKS) break
      this.tasks.delete(key)
    }
    let gap: string | undefined
    try {
      gap = await readGap(task.workDir, this.deps.settings().skillUpdates.maxFileBytes)
    } catch (error) {
      return { ok: false, error: messageOf(error) }
    }
    if (gap === undefined) return undefined
    return { ok: true, path: join(task.workDir, GAP_FILE), preview: previewOf(gap, GAP_PREVIEW_CHARS) }
  }

  /**
   * Build the tool definition.
   * @returns the registration.
   */
  definition(): ToolDefinition<ImproveValue> {
    return {
      name: IMPROVE_TOOL_NAME,
      description: '观象：询问用户是否改进某个应用的日志分析 SKILL。用户同意后，派一个子 Agent 修改 SKILL（需要时把问题整理为案例写入 SKILL 的 cases/ 目录），推送到新分支并创建合并请求供用户评审，不会改动默认分支。'
        + '在两种情况下使用：派发结果标出了「SKILL 不足」；或用户要纠正、改进某个应用的 SKILL（不论本会话是否分析过）。'
        + `后一种情况先用 ${SHOW_TOOL_NAME} 查看现有 SKILL，和用户确认哪部分不对、正确做法是什么、有没有样例日志，问清后再调用，并把用户的纠正写进 feedback。不要自己修改或推送 SKILL 文件。`,
      parameters: PARAMETERS,
      output: {
        schema: OUTPUT_SCHEMA,
        render: (_args, value) => renderImproveValue(value),
      },
      isConcurrencySafe: () => false,
      execute: (args, exec) => this.execute(args, exec),
    }
  }

  /**
   * Ask, then draft and submit one improvement.
   * @param rawArgs - model arguments.
   * @param exec - execution context of the calling agent.
   * @returns how the improvement ended.
   * @throws when the arguments, task, application, logs, approval service, or `dshRepos` service are unusable, the workspace cannot be opened, or the push fails; nothing is pushed then.
   */
  async execute(rawArgs: unknown, exec: ToolRunContext): Promise<ImproveValue> {
    const parsed = argsSchema.safeParse(rawArgs)
    if (!parsed.success) throw new Error(`${IMPROVE_TOOL_NAME} 参数不合法：${describeIssue(parsed.error)}`)
    const agent = exec.agent
    if (agent === undefined) throw new Error(`${IMPROVE_TOOL_NAME} 需要由 Agent 调用`)
    if (isDelegatedAgent(agent)) throw new Error(`${IMPROVE_TOOL_NAME} 不能在子 Agent 中调用`)
    if (!this.enabled()) throw new Error('观象的 SKILL 改进未开启（设置面板「高级」→「SKILL 改进」）')
    const request = await this.resolve(parsed.data, agent, exec.signal)
    if (this.running.has(request.key)) throw new Error(`应用「${request.app.id}」的这次 SKILL 改进正在进行`)
    const approval = this.deps.approval()
    if (approval === undefined) throw new Error('当前 DSH 组合没有审批服务（@deepseek-ai/dsh-user-approval），观象不会在未经同意时改进 SKILL')
    requireRepos(this.deps.repos())

    const { app, url, task } = request
    const target = this.deps.registry.branchOf(url)
    const base = { app: app.id, repo: url, ...task === undefined ? {} : { workDir: task.workDir } }
    this.running.add(request.key)
    try {
      const outcome = await askApproval({ approval, agent, exec, toolName: IMPROVE_TOOL_NAME, prompt: await this.prompt(request, target) })
      if (outcome !== 'allowed-once') return { ...base, status: outcome }
      return await this.improve(request, agent, target, exec)
    } finally {
      this.running.delete(request.key)
    }
  }

  /** Check the arguments against the session's analyses and the registry, and admit the logs. */
  private async resolve(args: z.output<typeof argsSchema>, agent: Agent, signal: AbortSignal): Promise<ImproveRequest> {
    const sessionId = agent.session.header.id
    const settings = this.deps.settings()
    const { feedback } = args
    let task: AnalyzedTask | undefined
    let gap = false
    if (args.workDir !== undefined) {
      task = this.tasks.get(resolve(args.workDir))
      if (task === undefined) throw new Error(`${args.workDir} 不是本次 DSH 运行中已完成的观象派发任务；DSH 重启后需要重新分析，或改用 app 和 feedback`)
      if (task.sessionId !== sessionId) throw new Error(`${args.workDir} 不是当前会话派发的任务`)
      gap = await readGap(task.workDir, settings.skillUpdates.maxFileBytes) !== undefined
      if (!gap && feedback === undefined) throw new Error(`这次分析没有 ${GAP_FILE}，需要在 feedback 中写明用户指出的问题和期望的改法`)
    } else if (feedback === undefined) {
      throw new Error('按 app 改进时需要 feedback：写明用户指出的问题和期望的改法')
    }
    // The schema guarantees `app` whenever `workDir` is absent.
    const { app, url } = task ?? this.deps.registry.readyApp(args.app as string)
    const { effectiveDir, baseDir } = await resolveRunBase(agent, this.deps.workingDirectory(), signal)
    const sources = await admitLogs(args.logs ?? [], effectiveDir, settings.download)
    const parentDir = task?.workDir ?? join(baseDir, ...RUNS_SEGMENTS, newRunId(this.deps.now?.() ?? new Date()))
    const key = task?.workDir ?? `${sessionId}\0${app.id}`
    return { app, url, sessionId, gap, sources, parentDir, key, ...task === undefined ? {} : { task }, ...feedback === undefined ? {} : { feedback } }
  }

  private async prompt(request: ImproveRequest, target: string): Promise<{ zh: string; en: string }> {
    const { app, url, task, feedback } = request
    const dir = skillDir(app.skill)
    const basis: string[] = []
    if (task !== undefined && request.gap) {
      const gap = await readGap(task.workDir, this.deps.settings().skillUpdates.maxFileBytes) ?? ''
      basis.push(`观象分析「${app.name}」的日志时发现 SKILL 有不足：${previewOf(gap, GAP_PREVIEW_CHARS)}`)
    }
    if (feedback !== undefined) basis.push(`用户要求改进「${app.name}」的日志分析 SKILL：${previewOf(feedback, GAP_PREVIEW_CHARS)}`)
    const what = task === undefined ? '按反馈修改 SKILL' : `把这次问题整理为案例写入 ${dir}/${CASES_DIR}/ 并修改 SKILL`
    return {
      zh: `${basis.join('\n')}\n是否改进 SKILL？同意后，观象会${what}，然后推送到 ${url} 的新分支、创建合并请求合入 ${target}，由你在合并请求中评审。`,
      en: `Improve the log-analysis SKILL of ${app.id}? Logalyze will update ${dir}/${task === undefined ? '' : ` and record a case under ${dir}/${CASES_DIR}/`}, push to a new branch of ${url}, and open a merge request into ${target} for review.`,
    }
  }

  private async improve(request: ImproveRequest, parent: Agent, target: string, exec: ToolRunContext): Promise<ImproveValue> {
    const settings = this.deps.settings()
    const { task, feedback } = request
    const caseRequired = task !== undefined
    const { app, url, commit } = this.deps.registry.readyApp(request.app.id)
    const improveDir = join(request.parentDir, `improve-${randomBytes(3).toString('hex')}`)
    const repoDir = join(improveDir, WORKSPACE_DIR)
    await mkdir(improveDir, { recursive: true })
    try {
      await requireRepos(this.deps.repos()).openWorkspace(url, { dir: repoDir, baseBranch: target, commit, signal: exec.signal })
    } catch (error) {
      exec.signal.throwIfAborted()
      throw new Error(`应用「${app.id}」的工作区创建失败：${messageOf(error)}`)
    }
    const extra = await materializeLogs(request.sources, improveDir, settings.download, exec.signal, this.deps.fetch)
    const logs: ChildLog[] = [...(task?.logs ?? []).map(path => ({ path })), ...extra]
    const prompt = renderImprovePrompt({
      app,
      commit,
      ...task === undefined
        ? {}
        : {
            analysis: {
              commit: task.commit,
              question: task.question,
              conclusion: task.output.slice(0, MAX_CONCLUSION_CHARS),
              dir: task.workDir,
              ...request.gap ? { gapPath: join(task.workDir, GAP_FILE) } : {},
            },
          },
      ...feedback === undefined ? {} : { feedback },
      logs,
      workDir: improveDir,
      maxFiles: settings.skillUpdates.maxFiles,
      caseRequired,
      date: localDate(this.deps.now?.() ?? new Date()),
    })
    const child: ChildOutcome = await runChild({ subagents: this.deps.subagents, provider: this.deps.provider, parent, label: `${app.name} SKILL 改进`, cwd: repoDir, prompt, timeoutMs: settings.dispatchTimeoutMs, signal: exec.signal })
    const base = { app: app.id, repo: url, ...task === undefined ? {} : { workDir: task.workDir }, improveDir, target, ...child.output === '' ? {} : { output: child.output } }
    if (child.status !== 'completed') {
      return { ...base, status: 'failed', error: `改进子 Agent 没有完成（${child.status}${child.diagnostic === undefined ? '' : `：${child.diagnostic}`}）` }
    }

    // The service may have reloaded while the child ran.
    const repos = requireRepos(this.deps.repos())
    const dir = skillDir(app.skill)
    let prepared: { changes: CheckedChanges; reason: string; diffPath: string }
    try {
      const changes = await checkChanges(
        await repos.workspaceChanges(repoDir, { signal: exec.signal }),
        { root: dir, allows: () => true, description: `${dir}/` },
        settings.skillUpdates,
      )
      checkImprovement(changes, app.skill, caseRequired)
      const reason = await readReason(improveDir, settings.skillUpdates.maxFileBytes, '改动说明')
      const diffPath = join(improveDir, DIFF_FILE)
      await replaceFile(diffPath, changes.diff)
      prepared = { changes, reason, diffPath }
    } catch (error) {
      exec.signal.throwIfAborted()
      return { ...base, status: 'failed', error: messageOf(error) }
    }

    const { changes, reason, diffPath } = prepared
    const branch = `logalyze/skill-${app.id}-${changes.digest.slice(0, 10)}`
    const title = titleOf(reason, app)
    const origin = task === undefined
      ? `由观象按用户反馈提出（应用 ${app.id}，会话 ${request.sessionId}）`
      : `由观象在日志分析后经用户同意提出（应用 ${app.id}，分析提交 ${task.commit.slice(0, 12)}，会话 ${request.sessionId}）`
    const outcome = await pushChange({
      repos,
      exec,
      url,
      dir: repoDir,
      branch,
      target,
      message: `${title}\n\n${reason}\n\nProposed-by: 观象 Logalyze\n${task === undefined ? '' : `Analyzed-commit: ${task.commit}\n`}`,
      session: request.sessionId,
      title,
      body: `${origin}。请评审${caseRequired ? '案例和 ' : ' '}SKILL 修改。\n\n${reason.slice(0, REASON_DESCRIPTION_CHARS)}`,
      ...this.deps.author === undefined ? {} : { author: this.deps.author },
    })
    return { ...base, branch, files: [...changes.files], diffPath, ...outcome }
  }
}
