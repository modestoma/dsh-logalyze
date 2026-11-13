/**
 * `logalyze_improve_skill`：用户在对话中同意改进某个应用的日志分析 SKILL 后，
 * 派一个改进子 Agent 把该应用的所有改进点一次改进完（需要时把问题整理为案例），
 * 再提交到新分支、创建合并请求供用户评审。父 Agent 只在用户于对话中同意后调用；
 * 推送前 dsh-repo 按它的写操作设置可能再请用户批准一次。只改进仓库清单中可写
 * （权限「可改代码」或「可合并」）的应用。改进的依据有两种，至少要有一种：
 *
 * - 分析：本进程中同一会话派发并已完成的该应用的任务。默认取其中记录了
 *   `skill-gap.md`、还没有被改进过的全部任务；参数 `workDirs` 给出时只用这些任务。
 *   应用、仓库、问题、结论和日志取自派发记录，不取自运行目录里可被 Agent 改写
 *   的内容。
 * - 用户反馈：参数 `feedback` 是父 Agent 转述的用户纠正或要求，可附样例日志。
 *
 * 先给结论、每回合每个应用最多一个改进子 Agent，由工具保证而不只靠提示词：
 *
 * - 观象经 `session/event` 数会话结束的回合。该应用有本回合派发的分析时工具
 *   报错：分析回合只写结论和改进建议，用户在之后的消息里同意后才改进。
 * - 同一会话同一应用每回合只发起一次改进，同时只运行一次；发起即把用到的分析
 *   记为已改进（无论成败），之后默认不再取用，用户要求重试时用 `workDirs` 指定。
 *
 * 其余规则：
 *
 * - 观象在新的运行目录 `.logalyze/runs/<runId>/improve-<序号>/repo/` 从应用最新
 *   同步提交创建工作区，推送分支为新的 `logalyze/skill-<应用 id>-<runId>`；改进
 *   子 Agent 以它为工作目录、首行 `/logalyze-improve`，
 *   直接修改 `.agents/skills/<skill>/`，改动说明写在工作区之外的
 *   `improve-<序号>/reason.md`；超时（`dispatchTimeoutMs`）或调用被取消时停止它。
 * - 改动只能是 `.agents/skills/<skill>/` 下新增或修改的文件；依据分析时必须新增
 *   或修改 `cases/` 下至少一个案例。合格后经 dsh-repo 的审批推送到工作区的
 *   分支并创建合并请求，从不推送到已有分支或默认分支。
 * - 工作区、推送和合并请求经 `dshRepos` 服务完成。子会话中不提供本工具。
 *
 * @module dsh-logalyze/improve/tool
 */

import { randomBytes } from 'node:crypto'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import { checkAppManifest, disablesUserInvocation, skillDir, skillNameOf } from '../apps/manifest.ts'
import { MAX_REPO_FILE_BYTES, treeReader } from '../apps/tree.ts'
import type { RepoRegistry } from '../apps/registry.ts'
import { describeIssue } from '../config.ts'
import type { ReposClient } from '../deps/repos.ts'
import type { Agent, ContentBlock, SubagentService, ToolDefinition, ToolRunContext, WorkingDirectoryService } from '../host.ts'
import { checkChanges, describeFiles, readReason } from '../runs/changes.ts'
import type { CheckedChanges, FileStat } from '../runs/changes.ts'
import { runChild } from '../runs/child.ts'
import { admitLogs, logSchema, SAMPLE_LOGS_PARAMETER } from '../runs/logs.ts'
import type { ChildLog, LogSource } from '../runs/logs.ts'
import { pushChange, SKILL_COMMIT_PREFIX } from '../runs/push.ts'
import type { PushStatus } from '../runs/push.ts'
import { newRunId, resolveRunBase, RUNS_SEGMENTS, topLevelAgent } from '../runs/run-dir.ts'
import { openWorkspace, writeDiff } from '../runs/workspace.ts'
import type { AppManifest, EditableSettings } from '../settings/contract.ts'
import { IMPROVE_TOOL_NAME, SHOW_TOOL_NAME } from '../tool-names.ts'
import { messageOf } from '../util/errors.ts'
import { ProposalError } from '../util/files.ts'
import { GAP_FILE, GAP_PREVIEW_CHARS, previewOf, readGap } from './gap.ts'
import type { GapCheck } from './gap.ts'
import { CASES_DIR, renderImprovePrompt } from './prompt.ts'
import type { ImproveAnalysis } from './prompt.ts'

/** Longest commit subject and merge request title, including {@link SKILL_COMMIT_PREFIX}. */
export const MAX_TITLE_CHARS = 120

/** A leading Conventional Commits type such as `feat:` or `fix(skill)!:`, removed from the reason's title. */
const COMMIT_TYPE = /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([^()\r\n]*\))?!?\s*[:：]\s*/i

/** Longest accepted user feedback. */
export const MAX_FEEDBACK_CHARS = 8000

/** Analyzed tasks remembered for improvement; older ones are forgotten first. */
const MAX_REMEMBERED_TASKS = 256

/** Sessions whose finished turns are counted; older ones are forgotten first. */
const MAX_TRACKED_SESSIONS = 1024

/** Characters of each analysis conclusion handed to the improvement child. */
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

/** How one improvement ended: a push status (including the approval outcome that stopped it), or `failed` when no submittable change came out. */
export type ImproveStatus = PushStatus | 'failed'

/** Canonical tool value. */
export interface ImproveValue {
  status: ImproveStatus
  app: string
  repo: string
  /** Run directories of the analyses the improvement is based on, oldest first; absent when it rests on feedback alone. */
  workDirs?: string[]
  /** The improvement child's run directory. */
  improveDir: string
  /** New branch the change was or would be pushed to. */
  branch?: string
  /** Branch the merge request targets. */
  target: string
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
  app: z.string().trim().min(1, 'app 不能为空'),
  workDirs: z.array(z.string().trim().min(1)).min(1, 'workDirs 给出时不能为空').optional(),
  feedback: z.string().trim().min(1).max(MAX_FEEDBACK_CHARS, `feedback 不能超过 ${MAX_FEEDBACK_CHARS} 个字符`).optional(),
  logs: z.array(logSchema).optional(),
}).strict()

const PARAMETERS: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['app'],
  properties: {
    app: { type: 'string', description: '要改进 SKILL 的应用 id。一个应用的所有改进点放在一次调用里。' },
    workDirs: {
      type: 'array',
      items: { type: 'string' },
      description: '可选：作为依据的分析任务运行目录（绝对路径，本会话之前回合派发的该应用任务）。省略时自动取本会话中该应用记录了 SKILL 不足、还没改进过的全部分析；用户纠正的是某次没有标出不足的分析，或要求重试已经改进过的分析时才填写。',
    },
    feedback: { type: 'string', description: '用户指出的问题、补充的改进点和期望的改法，尽量保留用户原话。没有可用的 SKILL 不足记录时必填。' },
    logs: SAMPLE_LOGS_PARAMETER,
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
  required: ['status', 'app', 'repo', 'improveDir', 'target'],
  properties: {
    status: { type: 'string', enum: ['opened', 'pushed', 'exists', 'rejected', 'cancelled', 'unavailable', 'failed'] },
    app: { type: 'string' },
    repo: { type: 'string' },
    workDirs: { type: 'array', items: { type: 'string' } },
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
  const where = `${value.repo} 的分支 ${value.branch ?? ''}（目标 ${value.target}）`
  const head = {
    opened: `SKILL 已改进，提交到 ${where}并创建合并请求：${value.mergeRequestUrl ?? ''}`,
    pushed: `SKILL 已改进并提交到 ${where}，但创建合并请求失败（${value.mergeRequestError ?? '未知原因'}）；请在代码托管平台上从该分支手动创建。`,
    exists: `${where} 在远端已有其他提交，本次没有提交。`,
    rejected: `SKILL 已改进，但推送授权被拒绝，没有提交：用户拒绝了，或会话的审批策略为 never（例如「完全访问」权限模式）。改动仍在 ${value.improveDir}。`,
    cancelled: '推送授权请求被撤回，没有提交。',
    unavailable: '当前没有可以回答推送授权请求的界面，没有提交。',
    failed: `SKILL 改进没有完成，没有提交：${value.error ?? '未知原因'}`,
  }[value.status]
  const files = value.files === undefined || value.files.length === 0 ? '' : `\n改动：${describeFiles(value.files)}`
  const diff = value.diffPath === undefined ? '' : `\ndiff：${value.diffPath}`
  const dir = value.status === 'failed' ? `\n运行目录：${value.improveDir}` : ''
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
  readonly repos: ReposClient
  readonly fetch?: typeof fetch
  readonly now?: () => Date
}

/** A remembered analysis. */
interface TaskRecord {
  readonly task: AnalyzedTask
  /** Finished turns of the session when the task was recorded; equal to the current count while its turn runs. */
  readonly turn: number
  /** Whether an improvement already used this analysis. */
  improved: boolean
}

/** One analysis an improvement uses, with whether it carries a gap record. */
interface Basis {
  readonly record: TaskRecord
  readonly gap: boolean
}

/** One improvement after its arguments were checked. */
interface ImproveRequest {
  readonly app: AppManifest
  readonly url: string
  readonly sessionId: string
  /** The analyses the improvement is based on, oldest first. */
  readonly bases: readonly Basis[]
  readonly feedback?: string
  readonly sources: readonly LogSource[]
  /** Directory the improvement run directory goes in. */
  readonly parentDir: string
  /** Session and application; at most one improvement of a key runs at once and starts per turn. */
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

/**
 * Title for the commit and merge request: {@link SKILL_COMMIT_PREFIX} followed by the reason's first line without
 * Markdown heading marks or a Conventional Commits type the child wrote.
 */
function titleOf(reason: string, app: AppManifest): string {
  const line = (reason.split(/\r?\n/).find(text => text.trim() !== '') ?? '').replace(/^#+\s*/, '').trim().replace(COMMIT_TYPE, '').trim()
  const title = `${SKILL_COMMIT_PREFIX}${line === '' ? `改进${app.name}日志分析 SKILL` : line}`
  return title.length <= MAX_TITLE_CHARS ? title : `${title.slice(0, MAX_TITLE_CHARS - 1)}…`
}

function localDate(now: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/** Distinct values in first-seen order. */
function distinct(values: readonly string[]): string[] {
  return [...new Set(values)]
}

/** Remembers finished analyses and drafts and submits one improvement per application and turn. */
export class SkillImprover {
  private readonly tasks = new Map<string, TaskRecord>()
  /** Finished turns per session, counted from when the session was first seen. */
  private readonly turns = new Map<string, number>()
  /** The turn count at the latest improvement start, per {@link ImproveRequest.key}. */
  private readonly started = new Map<string, number>()
  private readonly running = new Set<string>()

  /** @param deps - registry, subagents, settings, and `dshRepos` access. */
  constructor(private readonly deps: SkillImproverDeps) {}

  /** @returns whether SKILL improvement is enabled in the current settings. */
  enabled(): boolean {
    return this.deps.settings().skillUpdates.enabled
  }

  /**
   * Count a finished turn of a session; called for every `turn/end` session event.
   * @param sessionId - the session whose turn ended.
   */
  turnEnded(sessionId: string): void {
    const count = this.turns.get(sessionId)
    if (count !== undefined) this.turns.set(sessionId, count + 1)
  }

  /** The session's finished turn count, tracking the session from now on. */
  private turnOf(sessionId: string): number {
    const count = this.turns.get(sessionId)
    if (count !== undefined) return count
    this.turns.set(sessionId, 0)
    for (const key of this.turns.keys()) {
      if (this.turns.size <= MAX_TRACKED_SESSIONS) break
      this.turns.delete(key)
    }
    return 0
  }

  /**
   * Remember a finished task and check its gap record.
   * @param task - the finished analysis.
   * @returns the check, or undefined when the task wrote no record.
   */
  async inspect(task: AnalyzedTask): Promise<GapCheck | undefined> {
    this.tasks.delete(task.workDir)
    this.tasks.set(task.workDir, { task, turn: this.turnOf(task.sessionId), improved: false })
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
      description: '观象：改进某个应用的日志分析 SKILL。派一个子 Agent 把该应用的所有改进点一次改完（需要时把问题整理为案例写入 SKILL 的 cases/ 目录），推送到新分支并创建合并请求供用户评审，不会改动默认分支，需要几分钟。'
        + '只在用户于对话中明确同意改进后调用；推送前 dsh-repo 可能再请用户批准一次。仓库在 dsh-repo 中为只读的应用不能改进（工具会拒绝）。分析结果标出「SKILL 不足」的那一回合不要调用（工具会拒绝）：先写完分析结论，在回复末尾给出 SKILL 改进建议并问用户是否改进。'
        + `每个应用每回合只调用一次，把该应用的所有改进点放进同一次调用。用户主动纠正 SKILL 时，先用 ${SHOW_TOOL_NAME} 查看现有 SKILL，和用户确认哪部分不对、正确做法是什么、有没有样例日志，问清后再调用，并把用户的纠正写进 feedback。不要自己修改或推送 SKILL 文件。`,
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
   * Draft and submit one improvement of an application.
   * @param rawArgs - model arguments.
   * @param exec - execution context of the calling agent.
   * @returns how the improvement ended.
   * @throws when the arguments, analyses, application, logs, or `dshRepos` service are unusable, the application was analyzed in the current turn, an improvement of it already started this turn or is running, the workspace cannot be opened, or the push fails; nothing is pushed then.
   */
  async execute(rawArgs: unknown, exec: ToolRunContext): Promise<ImproveValue> {
    const parsed = argsSchema.safeParse(rawArgs)
    if (!parsed.success) throw new Error(`${IMPROVE_TOOL_NAME} 参数不合法：${describeIssue(parsed.error)}`)
    const agent = topLevelAgent(exec, IMPROVE_TOOL_NAME)
    if (!this.enabled()) throw new Error('观象的 SKILL 改进未开启（设置面板「高级」→「SKILL 改进」）')
    const request = await this.resolve(parsed.data, agent, exec.signal)
    this.deps.repos.require()

    const turn = this.turnOf(request.sessionId)
    if (this.running.has(request.key)) throw new Error(`应用「${request.app.id}」的 SKILL 改进正在进行`)
    if (this.started.get(request.key) === turn) throw new Error(`本回合已经为应用「${request.app.id}」发起过一次 SKILL 改进；同一应用每回合只改进一次，所有改进点要放进同一次调用`)
    this.started.set(request.key, turn)
    for (const basis of request.bases) basis.record.improved = true
    this.running.add(request.key)
    try {
      return await this.improve(request, agent, exec)
    } finally {
      this.running.delete(request.key)
    }
  }

  /** Check the arguments against the session's analyses and the registry, and admit the logs. */
  private async resolve(args: z.output<typeof argsSchema>, agent: Agent, signal: AbortSignal): Promise<ImproveRequest> {
    const sessionId = agent.session.header.id
    const settings = this.deps.settings()
    const { feedback } = args
    const { app, url, writable } = this.deps.registry.readyApp(args.app)
    if (app.skill === undefined) throw new Error(`应用「${app.id}」没有旧版 SKILL 改进目标；仍可直接分析日志与代码，创建初版 SKILL 待知识改进功能接入`)
    if (!writable) throw new Error(`应用「${app.id}」的仓库在 dsh-repo 仓库清单中的权限是「只读」，观象不能推送 SKILL 改进；请在 dsh-repo「代码仓库 → 仓库」把权限改为「可改代码」，或由仓库维护者自己修改 SKILL`)
    const turn = this.turnOf(sessionId)
    const analyzed = [...this.tasks.values()].filter(record => record.task.sessionId === sessionId && record.task.app.id === app.id)
    if (analyzed.some(record => record.turn === turn)) {
      throw new Error(`应用「${app.id}」的分析是本回合派发的：先把分析结论回复给用户，在回复末尾给出 SKILL 改进建议并问用户是否改进，本回合不要改进；用户同意后再调用 ${IMPROVE_TOOL_NAME}`)
    }
    let records: TaskRecord[]
    if (args.workDirs === undefined) {
      records = analyzed.filter(record => !record.improved)
    } else {
      records = distinct(args.workDirs.map(dir => resolve(dir))).map((dir) => {
        const record = this.tasks.get(dir)
        if (record === undefined) throw new Error(`${dir} 不是本次 DSH 运行中已完成的观象派发任务；DSH 重启后需要重新分析，或只用 feedback`)
        if (record.task.sessionId !== sessionId) throw new Error(`${dir} 不是当前会话派发的任务`)
        if (record.task.app.id !== app.id) throw new Error(`${dir} 分析的是应用「${record.task.app.id}」，不是「${app.id}」`)
        return record
      })
    }
    const hasGap = async (record: TaskRecord): Promise<boolean> => await readGap(record.task.workDir, settings.skillUpdates.maxFileBytes) !== undefined
    // Without workDirs only analyses with a usable gap record count, and an unusable record (already reported by the
    // dispatch result) only drops its own analysis; named analyses count even without a record and must read cleanly.
    const bases: Basis[] = args.workDirs === undefined
      ? (await Promise.all(records.map(async record => ({ record, gap: await hasGap(record).catch(() => false) })))).filter(basis => basis.gap)
      : await Promise.all(records.map(async record => ({ record, gap: await hasGap(record) })))
    if (feedback === undefined && !bases.some(basis => basis.gap)) {
      throw new Error(`本会话中应用「${app.id}」没有待改进的 ${GAP_FILE} 记录，需要在 feedback 中写明用户指出的问题和期望的改法`)
    }
    const { effectiveDir, baseDir } = await resolveRunBase(agent, this.deps.workingDirectory(), signal)
    const sources = await admitLogs(args.logs ?? [], effectiveDir, settings.download)
    const parentDir = join(baseDir, ...RUNS_SEGMENTS, newRunId(this.deps.now?.() ?? new Date()))
    return { app, url, sessionId, bases, sources, parentDir, key: `${sessionId}\0${app.id}`, ...feedback === undefined ? {} : { feedback } }
  }

  private async improve(request: ImproveRequest, parent: Agent, exec: ToolRunContext): Promise<ImproveValue> {
    const settings = this.deps.settings()
    const { bases, feedback } = request
    const tasks = bases.map(basis => basis.record.task)
    const caseRequired = tasks.length > 0
    const { app: analyzed, url } = this.deps.registry.readyApp(request.app.id)
    const improveDir = join(request.parentDir, `improve-${randomBytes(3).toString('hex')}`)
    const { workspace, repoDir, logs: extra } = await openWorkspace({
      repos: this.deps.repos,
      parent,
      exec,
      repo: url,
      workDir: improveDir,
      sources: request.sources,
      download: settings.download,
      ...this.deps.fetch === undefined ? {} : { fetch: this.deps.fetch },
      subject: `应用「${analyzed.id}」`,
    })
    // The workspace starts from the baseline branch, whose description may name another SKILL than the analysed branch.
    const baseline = await checkAppManifest(treeReader(repoDir, MAX_REPO_FILE_BYTES))
    if (!baseline.ok) throw new Error(`基线分支 ${workspace.base} 上应用「${analyzed.id}」的描述或 SKILL 不可用：${baseline.error}；先在基线分支上修好再改进 SKILL`)
    if (baseline.app.id !== analyzed.id) throw new Error(`基线分支 ${workspace.base} 上的应用描述声明的是应用「${baseline.app.id}」，不是「${analyzed.id}」；先让两个分支的应用描述一致再改进 SKILL`)
    const { app } = baseline
    const logs: ChildLog[] = [...distinct(tasks.flatMap(task => task.logs)).map(path => ({ path })), ...extra]
    const analyses: ImproveAnalysis[] = bases.map(({ record: { task }, gap }) => ({
      commit: task.commit,
      question: task.question,
      conclusion: task.output.slice(0, MAX_CONCLUSION_CHARS),
      dir: task.workDir,
      ...gap ? { gapPath: join(task.workDir, GAP_FILE) } : {},
    }))
    const prompt = renderImprovePrompt({
      app,
      commit: workspace.baseCommit,
      analyses,
      ...feedback === undefined ? {} : { feedback },
      logs,
      workDir: improveDir,
      maxFiles: settings.skillUpdates.maxFiles,
      caseRequired,
      date: localDate(this.deps.now?.() ?? new Date()),
    })
    const child = await runChild({ subagents: this.deps.subagents, provider: this.deps.provider, parent, label: `${app.name} SKILL 改进`, cwd: repoDir, prompt, timeoutMs: settings.dispatchTimeoutMs, signal: exec.signal })
    exec.signal.throwIfAborted()
    const { branch, base: target } = workspace
    const result = { app: app.id, repo: url, ...tasks.length === 0 ? {} : { workDirs: tasks.map(task => task.workDir) }, improveDir, branch, target, ...child.output === '' ? {} : { output: child.output } }
    if (child.status !== 'completed') {
      return { ...result, status: 'failed', error: `改进子 Agent 没有完成（${child.status}${child.diagnostic === undefined ? '' : `：${child.diagnostic}`}）` }
    }

    // The service may have reloaded while the child ran.
    const repos = this.deps.repos.require()
    const dir = skillDir(app.skill)
    let prepared: { changes: CheckedChanges; reason: string; diffPath: string }
    try {
      const changes = await checkChanges(
        await repos.workspaceStatus({ path: repoDir, signal: exec.signal }),
        { root: dir, allows: () => true, description: `${dir}/` },
        settings.skillUpdates,
      )
      checkImprovement(changes, app.skill, caseRequired)
      const reason = await readReason(improveDir, settings.skillUpdates.maxFileBytes, '改动说明')
      const diffPath = await writeDiff(improveDir, changes.diff)
      prepared = { changes, reason, diffPath }
    } catch (error) {
      exec.signal.throwIfAborted()
      return { ...result, status: 'failed', error: messageOf(error) }
    }

    const { changes, reason, diffPath } = prepared
    const title = titleOf(reason, app)
    const commits = distinct(tasks.map(task => task.commit))
    const origin = tasks.length === 0
      ? `由观象按用户反馈提出（应用 ${app.id}，会话 ${request.sessionId}）`
      : `由观象在日志分析后经用户同意提出（应用 ${app.id}，分析提交 ${commits.map(sha => sha.slice(0, 12)).join('、')}，会话 ${request.sessionId}）`
    const outcome = await pushChange({
      repos,
      exec,
      agent: parent,
      dir: repoDir,
      message: `${title}\n\n${reason}\n\nProposed-by: 观象 Logalyze\n${commits.map(sha => `Analyzed-commit: ${sha}\n`).join('')}`,
      title,
      body: `${origin}。请评审${caseRequired ? '案例和 ' : ' '}SKILL 修改。\n\n${reason.slice(0, REASON_DESCRIPTION_CHARS)}`,
    })
    return { ...result, files: [...changes.files], diffPath, ...outcome }
  }
}
