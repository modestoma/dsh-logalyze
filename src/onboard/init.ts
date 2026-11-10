/**
 * 仓库接入初稿的起草与提交：
 *
 * - `logalyze_init_repo` 只接受已拉取但还没有可用应用、且在仓库清单中可写的仓库：在运行目录
 *   `.logalyze/runs/<runId>/init/repo/` 从最新同步提交创建工作区，推送分支为
 *   新的 `logalyze/init-<runId>`；以工作区为工作目录启动一个起草子 Agent，等待
 *   它结束后检查初稿并写出 diff，不推送任何东西。超时（`dispatchTimeoutMs`）或
 *   调用被取消时停止子 Agent。
 * - `logalyze_submit_init` 只接受本进程中同一会话起草过的运行目录：推送前重新
 *   检查初稿，再经 dsh-repo 的审批推送到工作区的分支并创建合入跟踪分支的合并
 *   请求。同一份初稿只提交一次。
 * - 初稿的文件数和大小上限沿用 SKILL 改进的设置；工作区、推送和合并请求经
 *   `dshRepos` 服务完成。子会话中不提供这两个工具。
 *
 * @module dsh-logalyze/onboard/init
 */

import { join, resolve } from 'node:path'
import { z } from 'zod'
import type { RepoRegistry } from '../apps/registry.ts'
import { describeIssue } from '../config.ts'
import type { ReposClient } from '../deps/repos.ts'
import type { ContentBlock, SubagentService, ToolDefinition, ToolRunContext, WorkingDirectoryService } from '../host.ts'
import { describeFiles, WORKSPACE_DIR } from '../runs/changes.ts'
import type { FileStat } from '../runs/changes.ts'
import { runChild } from '../runs/child.ts'
import { admitLogs, logSchema, SAMPLE_LOGS_PARAMETER } from '../runs/logs.ts'
import { pushChange, SKILL_COMMIT_PREFIX } from '../runs/push.ts'
import type { PushStatus } from '../runs/push.ts'
import { newRunId, resolveRunBase, RUNS_SEGMENTS, topLevelAgent } from '../runs/run-dir.ts'
import { openWorkspace, writeDiff } from '../runs/workspace.ts'
import type { AppManifest, EditableSettings } from '../settings/contract.ts'
import { ADD_REPO_TOOL_NAME, INIT_REPO_TOOL_NAME, SUBMIT_INIT_TOOL_NAME } from '../tool-names.ts'
import { messageOf } from '../util/errors.ts'
import { AGENTS_DIR, checkInitDraft } from './draft.ts'
import type { InitDraft } from './draft.ts'
import { renderInitPrompt } from './prompt.ts'

/** Drafts remembered for submission; older ones are forgotten first. */
const MAX_REMEMBERED_DRAFTS = 64

/** Characters of the explanation sent as the merge request description; the commit message keeps all of it. */
const REASON_DESCRIPTION_CHARS = 2000

const initArgsSchema = z.object({
  url: z.string().trim().min(1, 'url 不能为空'),
  guidance: z.string().trim().min(1).optional(),
  logs: z.array(logSchema).optional(),
}).strict()

const submitArgsSchema = z.object({
  workDir: z.string().trim().min(1, 'workDir 不能为空'),
}).strict()

/** A drafting run as the init tool recorded it. */
interface DraftTask {
  readonly workDir: string
  readonly sessionId: string
  readonly url: string
  /** Branch the workspace pushes to. */
  readonly branch: string
  /** Branch the merge request targets: the workspace's base. */
  readonly target: string
  /** Whether a push of this draft succeeded. */
  submitted: boolean
}

/** A task's draft as the init result reports it. */
export type DraftCheck =
  | { readonly ok: true; readonly app: AppManifest; readonly files: readonly FileStat[]; readonly diffPath: string }
  | { readonly ok: false; readonly error: string }

/** Canonical value of the init tool. */
export interface InitRepoValue {
  url: string
  commit: string
  /** The child's terminal state (`completed`, `timeout`, `aborted`, `failed`, …). */
  status: string
  workDir: string
  /** The child's final answer text. */
  output: string
  diagnostic?: string
  /** Present when the child completed. */
  draft?: DraftCheck
}

/** Canonical value of the submission tool. */
export interface SubmitInitValue {
  status: PushStatus
  app: string
  repo: string
  branch: string
  target: string
  files: FileStat[]
  diffPath: string
  mergeRequestUrl?: string
  mergeRequestError?: string
}

const INIT_PARAMETERS: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['url'],
  properties: {
    url: { type: 'string', description: '应用仓库列表中已拉取、但缺少应用描述或日志分析 SKILL 的 git 地址。' },
    guidance: { type: 'string', description: '用户对仓库、模块划分或日志的说明，原样转给起草子 Agent。' },
    logs: SAMPLE_LOGS_PARAMETER,
  },
}

const FILE_STAT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['path', 'added', 'removed'],
  properties: { path: { type: 'string' }, added: { type: 'number' }, removed: { type: 'number' } },
} as const

const INIT_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['url', 'commit', 'status', 'workDir', 'output'],
  properties: {
    url: { type: 'string' },
    commit: { type: 'string' },
    status: { type: 'string' },
    workDir: { type: 'string' },
    output: { type: 'string' },
    diagnostic: { type: 'string' },
    draft: {
      type: 'object',
      additionalProperties: false,
      required: ['ok'],
      properties: {
        ok: { type: 'boolean' },
        app: { type: 'object' },
        files: { type: 'array', items: FILE_STAT_SCHEMA },
        diffPath: { type: 'string' },
        error: { type: 'string' },
      },
    },
  },
} as const

const SUBMIT_PARAMETERS: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['workDir'],
  properties: {
    workDir: { type: 'string', description: `${INIT_REPO_TOOL_NAME} 结果中初稿可提交的运行目录（绝对路径）。` },
  },
}

const SUBMIT_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'app', 'repo', 'branch', 'target', 'files', 'diffPath'],
  properties: {
    status: { type: 'string', enum: ['opened', 'pushed', 'exists', 'rejected', 'cancelled', 'unavailable'] },
    app: { type: 'string' },
    repo: { type: 'string' },
    branch: { type: 'string' },
    target: { type: 'string' },
    files: { type: 'array', items: FILE_STAT_SCHEMA },
    diffPath: { type: 'string' },
    mergeRequestUrl: { type: 'string' },
    mergeRequestError: { type: 'string' },
  },
} as const

/**
 * Model-facing rendering of a drafting run.
 * @param value - canonical value.
 * @returns text content.
 */
export function renderInitRepoValue(value: InitRepoValue): ContentBlock[] {
  const body = value.output.trim() === '' ? '（子 Agent 没有给出说明）' : value.output.trim()
  const diagnostic = value.diagnostic === undefined ? '' : `\n\n诊断：${value.diagnostic}`
  const draft = value.draft
  const next = draft === undefined
    ? `\n\n起草没有完成（${value.status}），没有可提交的初稿。`
    : draft.ok
      ? `\n\n初稿可提交：应用「${draft.app.name}」（id: ${draft.app.id}），SKILL /${draft.app.skill}。改动：${describeFiles(draft.files)}。diff 文件：${draft.diffPath}。`
        + `先向用户说明模块划分和需要确认的要点，附上 diff 中的关键内容；然后调用 ${SUBMIT_INIT_TOOL_NAME}（workDir 为 ${value.workDir}），dsh-repo 会请求授权，批准后推送新分支并创建合并请求。`
      : `\n\n初稿不可提交：${draft.error}`
  return [{ type: 'text', text: `观象接入起草 ${value.url}（提交 ${value.commit.slice(0, 12)}）结束，运行目录 ${value.workDir}。\n\n${body}${diagnostic}${next}` }]
}

/**
 * Model-facing rendering of a submission.
 * @param value - canonical value.
 * @returns text content.
 */
export function renderSubmitInitValue(value: SubmitInitValue): ContentBlock[] {
  const where = `${value.repo} 的分支 ${value.branch}（目标 ${value.target}）`
  const text = {
    opened: `已提交到 ${where} 并创建合并请求：${value.mergeRequestUrl ?? ''}。合并后观象下一次加载 /logalyze 时启用应用 ${value.app}。`,
    pushed: `已提交到 ${where}，但创建合并请求失败（${value.mergeRequestError ?? '未知原因'}）；请在代码托管平台上从该分支手动创建。`,
    exists: `${where} 在远端已有其他提交，或这份初稿已经提交过，本次没有提交。`,
    rejected: '授权被拒绝，没有提交：用户拒绝了，或会话的审批策略为 never（例如「完全访问」权限模式）。初稿文件仍在运行目录中，可以手动提交。',
    cancelled: '授权请求被撤回，没有提交。',
    unavailable: '当前没有可以回答授权请求的界面，没有提交。',
  }[value.status]
  return [{ type: 'text', text: `${text}\n改动：${describeFiles(value.files)}\ndiff：${value.diffPath}` }]
}

/** Collaborators of the drafting and submission tools. */
export interface RepoInitializerDeps {
  readonly registry: RepoRegistry
  readonly subagents: SubagentService
  /** Registered `ctx.subagents` provider the drafting child starts on. */
  readonly provider: string
  settings(): EditableSettings
  workingDirectory(): WorkingDirectoryService | undefined
  readonly repos: ReposClient
  readonly fetch?: typeof fetch
  readonly now?: () => Date
}

/** Drafts and submits application descriptions and SKILLs for repositories that lack them. */
export class RepoInitializer {
  private readonly drafts = new Map<string, DraftTask>()

  /** @param deps - registry, subagents, settings, and `dshRepos` access. */
  constructor(private readonly deps: RepoInitializerDeps) {}

  /**
   * Whether a session drafted something it may submit.
   * @param sessionId - session id.
   * @returns whether a remembered draft belongs to the session.
   */
  hasDraft(sessionId: string): boolean {
    return [...this.drafts.values()].some(task => task.sessionId === sessionId)
  }

  /**
   * Build the drafting tool definition.
   * @returns the registration.
   */
  initDefinition(): ToolDefinition<InitRepoValue> {
    return {
      name: INIT_REPO_TOOL_NAME,
      description: '观象：为应用仓库列表中缺少应用描述或日志分析 SKILL 的仓库起草 .agents/logalyze.yaml 和 SKILL。'
        + '启动一个子 Agent 读仓库代码（可附样例日志），等待它写完初稿后返回检查结果和 diff，不会推送；提交用 ' + SUBMIT_INIT_TOOL_NAME + '。',
      parameters: INIT_PARAMETERS,
      output: {
        schema: INIT_OUTPUT_SCHEMA,
        render: (_args, value) => renderInitRepoValue(value),
      },
      isConcurrencySafe: () => false,
      execute: (args, exec) => this.draft(args, exec),
    }
  }

  /**
   * Build the submission tool definition.
   * @returns the registration.
   */
  submitDefinition(): ToolDefinition<SubmitInitValue> {
    return {
      name: SUBMIT_INIT_TOOL_NAME,
      description: `观象：把 ${INIT_REPO_TOOL_NAME} 起草的应用描述和 SKILL 提交为合并请求。dsh-repo 先请求用户授权，批准后推送到新分支并创建合并请求，不会直接改动默认分支。不要自己修改或推送初稿文件。`,
      parameters: SUBMIT_PARAMETERS,
      output: {
        schema: SUBMIT_OUTPUT_SCHEMA,
        render: (_args, value) => renderSubmitInitValue(value),
      },
      isConcurrencySafe: () => false,
      execute: (args, exec) => this.submit(args, exec),
    }
  }

  /**
   * Run one drafting child and check what it wrote.
   * @param rawArgs - model arguments.
   * @param exec - execution context of the calling agent.
   * @returns the child's outcome and the draft check.
   * @throws when the arguments, repository, logs, or `dshRepos` service are unusable; no child is started then.
   */
  async draft(rawArgs: unknown, exec: ToolRunContext): Promise<InitRepoValue> {
    const parsed = initArgsSchema.safeParse(rawArgs)
    if (!parsed.success) throw new Error(`${INIT_REPO_TOOL_NAME} 参数不合法：${describeIssue(parsed.error)}`)
    const { url, guidance } = parsed.data
    const parent = topLevelAgent(exec, INIT_REPO_TOOL_NAME)
    const { registry } = this.deps
    const status = registry.statusOf(url)
    if (status === undefined) throw new Error(`${url} 不在观象的应用仓库列表中，先用 ${ADD_REPO_TOOL_NAME} 添加`)
    if (status.available) throw new Error(`${url} 的应用「${status.app?.id ?? ''}」已经可用；改进它的 SKILL 走派发结果中的 SKILL 改进`)
    if (!status.writable) throw new Error(`${url} 在 dsh-repo 仓库清单中的权限是「只读」，不能推送接入草稿；请在 dsh-repo「代码仓库 → 仓库」把权限改为「可改代码」`)
    if (!registry.setupPending().includes(url)) throw new Error(`${url} 还不能起草：${status.error ?? status.phase}`)
    this.deps.repos.require()
    const settings = this.deps.settings()
    const { effectiveDir, baseDir } = await resolveRunBase(parent, this.deps.workingDirectory(), exec.signal)
    const sources = await admitLogs(parsed.data.logs ?? [], effectiveDir, settings.download)

    // `setupPending` lists only repositories with a synced commit.
    const commit = status.commit as string
    const runId = newRunId(this.deps.now?.() ?? new Date())
    const workDir = join(baseDir, ...RUNS_SEGMENTS, runId, 'init')
    const { workspace, repoDir, logs } = await openWorkspace({
      repos: this.deps.repos,
      parent,
      exec,
      repo: url,
      base: registry.branchOf(url),
      commit,
      branch: `logalyze/init-${runId}`,
      workDir,
      sources,
      download: settings.download,
      ...this.deps.fetch === undefined ? {} : { fetch: this.deps.fetch },
      subject: `仓库 ${url} `,
    })
    const prompt = renderInitPrompt({
      url,
      commit,
      ...status.error === undefined ? {} : { problem: status.error },
      ...guidance === undefined ? {} : { guidance },
      logs,
      workDir,
      maxFiles: settings.skillUpdates.maxFiles,
    })
    const child = await runChild({ subagents: this.deps.subagents, provider: this.deps.provider, parent, label: '观象接入起草', cwd: repoDir, prompt, timeoutMs: settings.dispatchTimeoutMs, signal: exec.signal })
    exec.signal.throwIfAborted()
    const value: InitRepoValue = { url, commit, workDir, status: child.status, output: child.output, ...child.diagnostic === undefined ? {} : { diagnostic: child.diagnostic } }
    if (child.status !== 'completed') return value
    const task: DraftTask = { workDir, sessionId: parent.session.header.id, url, branch: workspace.branch, target: workspace.base, submitted: false }
    this.remember(task)
    try {
      const prepared = await this.prepare(task, exec.signal)
      value.draft = { ok: true, app: prepared.draft.app, files: [...prepared.draft.changes.files], diffPath: prepared.diffPath }
    } catch (error) {
      exec.signal.throwIfAborted()
      value.draft = { ok: false, error: messageOf(error) }
    }
    return value
  }

  private remember(task: DraftTask): void {
    this.drafts.delete(task.workDir)
    this.drafts.set(task.workDir, task)
    for (const key of this.drafts.keys()) {
      if (this.drafts.size <= MAX_REMEMBERED_DRAFTS) break
      this.drafts.delete(key)
    }
  }

  /**
   * Check the draft in the run directory's workspace and write the diff file.
   * @throws ProposalError, or an error when the `dshRepos` service is unavailable or cannot report the changes.
   */
  private async prepare(task: DraftTask, signal?: AbortSignal): Promise<{ draft: InitDraft; diffPath: string }> {
    const draft = await checkInitDraft(this.deps.repos, task.workDir, this.deps.settings().skillUpdates, signal)
    // Conflicted applications are not ready but still claim their id.
    const conflict = this.deps.registry.status().find(repo => repo.app?.id === draft.app.id && repo.url !== task.url)
    if (conflict !== undefined) throw new Error(`应用 id「${draft.app.id}」已被 ${conflict.url} 使用，请换一个 id`)
    return { draft, diffPath: await writeDiff(task.workDir, draft.changes.diff) }
  }

  /**
   * Submit one draft.
   * @param rawArgs - model arguments.
   * @param exec - execution context of the calling agent.
   * @returns how the submission ended.
   * @throws when the arguments, draft, approval service, or `dshRepos` service are unusable, or the push fails; nothing is pushed then.
   */
  async submit(rawArgs: unknown, exec: ToolRunContext): Promise<SubmitInitValue> {
    const parsed = submitArgsSchema.safeParse(rawArgs)
    if (!parsed.success) throw new Error(`${SUBMIT_INIT_TOOL_NAME} 参数不合法：${describeIssue(parsed.error)}`)
    const agent = topLevelAgent(exec, SUBMIT_INIT_TOOL_NAME)
    const task = this.drafts.get(resolve(parsed.data.workDir))
    if (task === undefined) throw new Error(`${parsed.data.workDir} 不是本次 DSH 运行中观象起草任务的运行目录；DSH 重启后需要重新起草`)
    if (task.sessionId !== agent.session.header.id) throw new Error(`${parsed.data.workDir} 不是当前会话起草的任务`)
    const repos = this.deps.repos.require()
    const { branch, target } = task

    let prepared: Awaited<ReturnType<RepoInitializer['prepare']>>
    try {
      prepared = await this.prepare(task, exec.signal)
    } catch (error) {
      exec.signal.throwIfAborted()
      throw error
    }
    const { draft, diffPath } = prepared
    const { app, reason, changes } = draft
    const files = [...changes.files]
    const base = { app: app.id, repo: task.url, branch, target, files, diffPath }
    if (task.submitted) return { ...base, status: 'exists' }
    const title = `${SKILL_COMMIT_PREFIX}接入观象日志分析：${app.name}（${app.id}）`
    const outcome = await pushChange({
      repos,
      exec,
      agent,
      dir: join(task.workDir, WORKSPACE_DIR),
      message: `${title}\n\n${reason}\n\nProposed-by: 观象 Logalyze\nBase-commit: ${changes.base}\n`,
      title,
      body: `由观象起草的应用描述 ${AGENTS_DIR}/logalyze.yaml 与日志分析 SKILL ${AGENTS_DIR}/skills/${app.skill}/（基于提交 ${changes.base.slice(0, 12)}，会话 ${task.sessionId}）。合并后观象下一次加载 /logalyze 时启用该应用。说明：${reason.slice(0, REASON_DESCRIPTION_CHARS)}`,
    })
    if (outcome.status === 'opened' || outcome.status === 'pushed') task.submitted = true
    return { ...base, ...outcome }
  }
}
