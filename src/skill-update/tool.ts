/**
 * `logalyze_improve_skill`：分析子 Agent 记录了 SKILL 不足时，询问用户是否
 * 改进；用户同意后派一个改进子 Agent，把这次问题整理为案例并修改 SKILL，再提交
 * 到新分支、创建合并请求供用户评审。
 *
 * - 只接受本进程中由同一会话派发、且写了 SKILL 不足记录的任务运行目录；应用、
 *   仓库、问题和结论取自派发记录，不取自运行目录里可被 Agent 改写的内容。
 * - 询问经 DSH 审批服务（`ctx.approval`）一次性请求；dsh_channels 把它显示为
 *   飞书决策卡片，DSH Web 显示为审批提示。只有 `allowed-once` 才起草和提交，
 *   之后不再询问；没有审批服务时工具报错。
 * - 改进子 Agent 在应用最新提交的只读快照里工作，首行 `/logalyze-improve`，把
 *   修改写到任务运行目录下的 `improve-<序号>/skill-proposal/`；超时
 *   （`dispatchTimeoutMs`）或调用被取消时停止它。
 * - 修改只能落在 `.agents/skills/<skill>/` 下，必须新增或修改 `cases/` 下的一个
 *   案例；提交以快照的提交为父提交，提交到新分支
 *   `logalyze/skill-<应用 id>-<改动摘要前缀>`，从不提交到已有分支或默认分支。
 * - 提交和创建合并请求经 `dshRepos` 服务完成。子会话中不提供本工具。
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
import { isDelegatedAgent } from '../dispatch/tool.ts'
import type { Agent, ContentBlock, HostApproval, SubagentService, ToolDefinition, ToolRunContext } from '../host.ts'
import type { CommitAuthor } from '../repos/contract.ts'
import { messageOf, requireRepos } from '../repos/lookup.ts'
import { skillDir, skillNameOf } from '../repos/manifest.ts'
import type { RepoRegistry } from '../repos/registry.ts'
import type { AppManifest, EditableSettings } from '../settings/contract.ts'
import { describeFiles, prepareChange } from './change.ts'
import type { FileStat } from './change.ts'
import { askApproval, commitChange } from './commit.ts'
import type { SubmitStatus } from './commit.ts'
import { GAP_FILE, GAP_PREVIEW_CHARS, previewOf, readGap } from './gap.ts'
import type { GapCheck } from './gap.ts'
import { IMPROVE_TOOL_NAME } from './names.ts'
import { DIFF_FILE, PROPOSAL_DIR, ProposalError, readProposal, replaceFile } from './proposal.ts'
import type { Proposal } from './proposal.ts'
import { CASES_DIR, renderImprovePrompt } from './prompt.ts'

/** Longest commit subject and merge request title taken from the reason. */
export const MAX_TITLE_CHARS = 120

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
  /** The analysis task's run directory. */
  workDir: string
  /** The improvement child's run directory; present once the user agreed. */
  improveDir?: string
  /** New branch the change was or would be committed to. */
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
  workDir: z.string().trim().min(1, 'workDir 不能为空'),
}).strict()

const PARAMETERS: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['workDir'],
  properties: {
    workDir: { type: 'string', description: '派发结果中标出「SKILL 不足」的任务运行目录（绝对路径）。' },
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
  required: ['status', 'app', 'repo', 'workDir'],
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
  readonly author?: CommitAuthor
  /** DSH's approval service, when the composition has one. */
  approval(): HostApproval | undefined
  /** What `ctx.get('dshRepos')` returns now. */
  repos(): unknown
  readonly now?: () => Date
}

/**
 * Check that a proposal adds a case and keeps the SKILL loadable.
 * @param proposal - the improvement child's proposal.
 * @param skill - the application's SKILL name.
 * @throws ProposalError when no case file is present or SKILL.md names another skill.
 */
function checkImprovement(proposal: Proposal, skill: string): void {
  if (!proposal.files.some(file => CASE_PATH.test(file.path))) throw new ProposalError(`修改中没有案例文件 ${CASES_DIR}/<日期>-<slug>.md`)
  const entry = proposal.files.find(file => file.path === 'SKILL.md')
  if (entry === undefined) return
  const name = skillNameOf(entry.content)
  if (name !== skill) throw new ProposalError(`SKILL.md 的 frontmatter name 是${name === undefined ? '（缺失）' : `「${name}」`}，必须保持为「${skill}」`)
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

/** Remembers analyses that found SKILL gaps, asks whether to improve, and drafts and submits improvements. */
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
   * Whether a session has an analysis whose SKILL gap it may offer to improve.
   * @param sessionId - session id.
   * @returns whether a remembered task belongs to the session.
   */
  hasGap(sessionId: string): boolean {
    return [...this.tasks.values()].some(task => task.sessionId === sessionId)
  }

  /**
   * Check a finished task's gap record and remember the task when it has one.
   * @param task - the finished analysis.
   * @returns the check, or undefined when the task wrote no record.
   */
  async inspect(task: AnalyzedTask): Promise<GapCheck | undefined> {
    let gap: string | undefined
    try {
      gap = await readGap(task.workDir, this.deps.settings().skillUpdates.maxFileBytes)
    } catch (error) {
      return { ok: false, error: messageOf(error) }
    }
    if (gap === undefined) return undefined
    this.remember(task)
    return { ok: true, path: join(task.workDir, GAP_FILE), preview: previewOf(gap, GAP_PREVIEW_CHARS) }
  }

  private remember(task: AnalyzedTask): void {
    this.tasks.delete(task.workDir)
    this.tasks.set(task.workDir, task)
    for (const key of this.tasks.keys()) {
      if (this.tasks.size <= MAX_REMEMBERED_TASKS) break
      this.tasks.delete(key)
    }
  }

  /**
   * Build the tool definition.
   * @returns the registration.
   */
  definition(): ToolDefinition<ImproveValue> {
    return {
      name: IMPROVE_TOOL_NAME,
      description: '观象：询问用户是否改进某个应用的日志分析 SKILL。用户同意后，派一个子 Agent 把本次问题整理为案例写入 SKILL 的 cases/ 目录并修改 SKILL，提交到新分支并创建合并请求供用户评审，不会改动默认分支。'
        + '仅在派发结果标出「SKILL 不足」时使用；不要自己用 git 推送。',
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
   * @throws when the arguments, task, gap record, approval service, application, or `dshRepos` service are unusable, or the commit fails; nothing is committed then.
   */
  async execute(rawArgs: unknown, exec: ToolRunContext): Promise<ImproveValue> {
    const parsed = argsSchema.safeParse(rawArgs)
    if (!parsed.success) throw new Error(`${IMPROVE_TOOL_NAME} 参数不合法：${describeIssue(parsed.error)}`)
    const agent = exec.agent
    if (agent === undefined) throw new Error(`${IMPROVE_TOOL_NAME} 需要由 Agent 调用`)
    if (isDelegatedAgent(agent)) throw new Error(`${IMPROVE_TOOL_NAME} 不能在子 Agent 中调用`)
    if (!this.enabled()) throw new Error('观象的 SKILL 改进未开启（设置面板「高级」→「SKILL 改进」）')
    const task = this.tasks.get(resolve(parsed.data.workDir))
    if (task === undefined) throw new Error(`${parsed.data.workDir} 不是本次 DSH 运行中记录了 SKILL 不足的观象派发任务；DSH 重启后需要重新分析`)
    if (task.sessionId !== agent.session.header.id) throw new Error(`${parsed.data.workDir} 不是当前会话派发的任务`)
    if (this.running.has(task.workDir)) throw new Error(`${task.workDir} 的 SKILL 改进正在进行`)
    const approval = this.deps.approval()
    if (approval === undefined) throw new Error('当前 DSH 组合没有审批服务（@deepseek-ai/dsh-user-approval），观象不会在未经同意时改进 SKILL')
    const repos = requireRepos(this.deps.repos())
    const settings = this.deps.settings()
    const gap = await readGap(task.workDir, settings.skillUpdates.maxFileBytes)
    if (gap === undefined) throw new Error(`${task.workDir} 中没有 ${GAP_FILE}`)

    const { app, url } = task
    const target = this.deps.registry.branchOf(url)
    const base = { app: app.id, repo: url, workDir: task.workDir }
    const dir = skillDir(app.skill)
    const preview = previewOf(gap, GAP_PREVIEW_CHARS)
    this.running.add(task.workDir)
    try {
      const outcome = await askApproval({
        approval,
        agent,
        exec,
        toolName: IMPROVE_TOOL_NAME,
        prompt: {
          zh: `观象分析「${app.name}」的日志时发现 SKILL 有不足：${preview}\n是否改进 SKILL？同意后，观象会把这次问题整理为案例写入 ${dir}/${CASES_DIR}/ 并修改 SKILL，然后提交到 ${url} 的新分支、创建合并请求合入 ${target}，由你在合并请求中评审。`,
          en: `Logalyze found a gap in the log-analysis SKILL of ${app.id}. Improve it? Logalyze will record this problem as a case under ${dir}/${CASES_DIR}/, update the SKILL, commit to a new branch of ${url}, and open a merge request into ${target} for review.`,
        },
      })
      if (outcome === 'rejected') this.tasks.delete(task.workDir)
      if (outcome !== 'allowed-once') return { ...base, status: outcome }
      this.tasks.delete(task.workDir)
      const value = await this.improve(task, agent, target, exec)
      if (value.status === 'failed') this.remember(task)
      return value
    } finally {
      this.running.delete(task.workDir)
    }
  }

  private async improve(task: AnalyzedTask, parent: Agent, target: string, exec: ToolRunContext): Promise<ImproveValue> {
    const settings = this.deps.settings()
    const lease = await this.deps.registry.acquire([task.app.id])
    let run: { app: AppManifest; commit: string; improveDir: string; child: ChildOutcome }
    try {
      const leased = lease.apps.get(task.app.id)
      if (leased === undefined) throw new Error(`应用「${task.app.id}」不可用`)
      const { app, commit } = leased
      const improveDir = join(task.workDir, `improve-${randomBytes(3).toString('hex')}`)
      await mkdir(improveDir, { recursive: true })
      const prompt = renderImprovePrompt({
        app,
        commit,
        analyzedCommit: task.commit,
        question: task.question,
        conclusion: task.output.slice(0, MAX_CONCLUSION_CHARS),
        gapPath: join(task.workDir, GAP_FILE),
        analysisDir: task.workDir,
        logs: task.logs,
        workDir: improveDir,
        maxFiles: settings.skillUpdates.maxFiles,
        date: localDate(this.deps.now?.() ?? new Date()),
      })
      const child = await runChild({ subagents: this.deps.subagents, provider: this.deps.provider, parent, label: `${app.name} SKILL 改进`, cwd: leased.dir, prompt, timeoutMs: settings.dispatchTimeoutMs, signal: exec.signal })
      run = { app, commit, improveDir, child }
    } finally {
      lease.release()
    }
    const { app, commit, improveDir, child } = run
    const base = { app: app.id, repo: task.url, workDir: task.workDir, improveDir, target, ...child.output === '' ? {} : { output: child.output } }
    if (child.status !== 'completed') {
      return { ...base, status: 'failed', error: `改进子 Agent 没有完成（${child.status}${child.diagnostic === undefined ? '' : `：${child.diagnostic}`}）` }
    }

    const repos = requireRepos(this.deps.repos())
    const dir = skillDir(app.skill)
    let prepared
    try {
      const proposal = await readProposal(improveDir, settings.skillUpdates)
      if (proposal === undefined) throw new ProposalError(`子 Agent 没有写出修改（${PROPOSAL_DIR}/）`)
      checkImprovement(proposal, app.skill)
      const change = await prepareChange(repos, { url: task.url, base: commit, dir }, proposal.files, exec.signal)
      if (!change.files.some(file => CASE_PATH.test(file.path.slice(dir.length + 1)))) throw new ProposalError(`修改中的案例与提交 ${commit.slice(0, 12)} 中的相同，没有新增案例`)
      const diffPath = join(improveDir, DIFF_FILE)
      await replaceFile(diffPath, change.diff)
      prepared = { proposal, change, diffPath }
    } catch (error) {
      exec.signal.throwIfAborted()
      return { ...base, status: 'failed', error: messageOf(error) }
    }

    const { proposal, change, diffPath } = prepared
    const branch = `logalyze/skill-${app.id}-${change.digest.slice(0, 10)}`
    const title = titleOf(proposal.reason, app)
    // Only files that differ from the snapshot's commit; an unchanged one would be an empty update.
    const changed = new Set(change.files.map(file => file.path))
    const outcome = await commitChange({
      repos,
      exec,
      url: task.url,
      base: commit,
      branch,
      target,
      files: proposal.files
        .map(file => ({ action: 'write' as const, path: `${dir}/${file.path}`, content: file.content }))
        .filter(file => changed.has(file.path)),
      message: `${title}\n\n${proposal.reason}\n\nProposed-by: 观象 Logalyze\nAnalyzed-commit: ${task.commit}\nSession: ${task.sessionId}\n`,
      title,
      body: `由观象在日志分析后经用户同意提出（应用 ${app.id}，分析提交 ${task.commit.slice(0, 12)}，会话 ${task.sessionId}）。请评审案例和 SKILL 修改。\n\n${proposal.reason.slice(0, REASON_DESCRIPTION_CHARS)}`,
      ...this.deps.author === undefined ? {} : { author: this.deps.author },
    })
    return { ...base, branch, files: [...change.files], diffPath, ...outcome }
  }
}
