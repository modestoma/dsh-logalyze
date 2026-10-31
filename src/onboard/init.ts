/**
 * 仓库接入初稿的起草与提交：
 *
 * - `logalyze_init_repo` 只接受已拉取但还没有可用应用的仓库：在最新提交的只读
 *   快照里启动一个起草子 Agent，等待它结束后检查初稿并写出 diff，不提交任何东西。
 *   超时（`dispatchTimeoutMs`）或调用被取消时停止子 Agent。
 * - `logalyze_submit_init` 只接受本进程中同一会话起草过的运行目录：仓库和基准
 *   提交取自起草记录，初稿在提交前重新检查；经用户一次性授权后提交到新分支
 *   `logalyze/init-<应用 id>-<改动摘要前缀>` 并创建合入跟踪分支的合并请求。
 * - 初稿的文件数和大小上限沿用 SKILL 改进的设置；提交经 dsh-repo 的 `dshRepos`
 *   服务完成。子会话中不提供这两个工具。
 *
 * @module dsh-logalyze/onboard/init
 */

import { mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import { describeIssue } from '../config.ts'
import { admitLogs, isDelegatedAgent, logSchema, materializeLogs, newRunId, resolveRunBase } from '../dispatch/tool.ts'
import { runChild } from '../dispatch/child.ts'
import type { Agent, ContentBlock, HostApproval, SubagentService, ToolDefinition, ToolRunContext, WorkingDirectoryService } from '../host.ts'
import type { CommitAuthor } from '../repos/contract.ts'
import { messageOf, requireRepos } from '../repos/lookup.ts'
import type { RepoRegistry } from '../repos/registry.ts'
import type { AppManifest, EditableSettings } from '../settings/contract.ts'
import { describeFiles, prepareChange } from '../skill-update/change.ts'
import type { FileStat, PreparedChange } from '../skill-update/change.ts'
import { submitChange } from '../skill-update/commit.ts'
import type { SubmitStatus } from '../skill-update/commit.ts'
import { replaceFile } from '../skill-update/proposal.ts'
import { AGENTS_DIR, checkInitDraft, INIT_DIFF_FILE, readInitDraft } from './draft.ts'
import type { InitDraft } from './draft.ts'
import { ADD_REPO_TOOL_NAME, INIT_REPO_TOOL_NAME, SUBMIT_INIT_TOOL_NAME } from './names.ts'
import { renderInitPrompt } from './prompt.ts'

/** Drafts remembered for submission; older ones are forgotten first. */
const MAX_REMEMBERED_DRAFTS = 64

/** Characters of the explanation shown on an approval prompt. */
const REASON_PREVIEW_CHARS = 300

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
  /** Commit the draft was written against. */
  readonly commit: string
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
  status: SubmitStatus
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
        + `先向用户说明模块划分和需要确认的要点，附上 diff 中的关键内容；然后调用 ${SUBMIT_INIT_TOOL_NAME}（workDir 为 ${value.workDir}），工具会请求授权，批准后提交新分支并创建合并请求。`
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
    exists: `${where} 已存在，同一初稿可能已经提交过，本次没有提交。`,
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
  /** DSH's approval service, when the composition has one. */
  approval(): HostApproval | undefined
  /** What `ctx.get('dshRepos')` returns now. */
  repos(): unknown
  readonly author?: CommitAuthor
  readonly fetch?: typeof fetch
  readonly now?: () => Date
}

function topLevelAgent(exec: ToolRunContext, tool: string): Agent {
  const agent = exec.agent
  if (agent === undefined) throw new Error(`${tool} 需要由 Agent 调用`)
  if (isDelegatedAgent(agent)) throw new Error(`${tool} 不能在子 Agent 中调用`)
  return agent
}

/** Drafts and submits application descriptions and SKILLs for repositories that lack them. */
export class RepoInitializer {
  private readonly drafts = new Map<string, DraftTask>()

  /** @param deps - registry, subagents, settings, approval, and `dshRepos` access. */
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
        + '启动一个子 Agent 读仓库代码（可附样例日志），等待它写完初稿后返回检查结果和 diff，不会提交；提交用 ' + SUBMIT_INIT_TOOL_NAME + '。',
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
      description: `观象：把 ${INIT_REPO_TOOL_NAME} 起草的应用描述和 SKILL 提交为合并请求。工具先请求用户授权，批准后提交到新分支并创建合并请求，不会直接改动默认分支。不要自己用 git 推送。`,
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
    if (!registry.setupPending().includes(url)) throw new Error(`${url} 还不能起草：${status.error ?? status.phase}`)
    requireRepos(this.deps.repos())
    const settings = this.deps.settings()
    const { effectiveDir, baseDir } = await resolveRunBase(parent, this.deps.workingDirectory(), exec.signal)
    const sources = await admitLogs(parsed.data.logs ?? [], effectiveDir, settings.download)

    const lease = await registry.acquireRepo(url)
    try {
      exec.signal.throwIfAborted()
      const workDir = join(baseDir, '.logalyze', 'runs', newRunId(this.deps.now?.() ?? new Date()), 'init')
      await mkdir(workDir, { recursive: true })
      const logs = await materializeLogs(sources, workDir, settings.download, exec.signal, this.deps.fetch)
      const prompt = renderInitPrompt({
        url,
        commit: lease.commit,
        ...status.error === undefined ? {} : { problem: status.error },
        ...guidance === undefined ? {} : { guidance },
        logs,
        workDir,
        maxFiles: settings.skillUpdates.maxFiles,
      })
      const outcome = await runChild({ subagents: this.deps.subagents, provider: this.deps.provider, parent, label: '观象接入起草', cwd: lease.dir, prompt, timeoutMs: settings.dispatchTimeoutMs, signal: exec.signal })
      const value: InitRepoValue = { url, commit: lease.commit, workDir, ...outcome }
      if (outcome.status !== 'completed') return value
      const task: DraftTask = { workDir, sessionId: parent.session.header.id, url, commit: lease.commit }
      this.remember(task)
      try {
        const prepared = await this.prepare(task, exec.signal)
        value.draft = { ok: true, app: prepared.draft.app, files: prepared.change.files, diffPath: prepared.diffPath }
      } catch (error) {
        exec.signal.throwIfAborted()
        value.draft = { ok: false, error: messageOf(error) }
      }
      return value
    } finally {
      lease.release()
    }
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
   * Read and check the draft, compare it with the base commit, and write the diff file.
   * @throws ProposalError, or an error when dsh-repo is unavailable or the mirror cannot be read.
   */
  private async prepare(task: DraftTask, signal?: AbortSignal): Promise<{ draft: InitDraft; change: PreparedChange; diffPath: string }> {
    const repos = requireRepos(this.deps.repos())
    const options = signal === undefined ? {} : { signal }
    const draft = await readInitDraft(task.workDir, this.deps.settings().skillUpdates)
    await checkInitDraft(draft, path => repos.readMirrorFile(task.url, task.commit, path, options))
    // Conflicted applications are not ready but still claim their id.
    const conflict = this.deps.registry.status().find(repo => repo.app?.id === draft.app.id && repo.url !== task.url)
    if (conflict !== undefined) throw new Error(`应用 id「${draft.app.id}」已被 ${conflict.url} 使用，请换一个 id`)
    const change = await prepareChange(repos, { url: task.url, base: task.commit, dir: AGENTS_DIR }, draft.files, signal)
    if (change.files.length === 0) throw new Error(`初稿与提交 ${task.commit.slice(0, 12)} 中的文件相同，没有改动`)
    const diffPath = join(task.workDir, INIT_DIFF_FILE)
    await replaceFile(diffPath, change.diff)
    return { draft, change, diffPath }
  }

  /**
   * Submit one draft.
   * @param rawArgs - model arguments.
   * @param exec - execution context of the calling agent.
   * @returns how the submission ended.
   * @throws when the arguments, draft, approval service, or `dshRepos` service are unusable, or the commit fails; nothing is committed then.
   */
  async submit(rawArgs: unknown, exec: ToolRunContext): Promise<SubmitInitValue> {
    const parsed = submitArgsSchema.safeParse(rawArgs)
    if (!parsed.success) throw new Error(`${SUBMIT_INIT_TOOL_NAME} 参数不合法：${describeIssue(parsed.error)}`)
    const agent = topLevelAgent(exec, SUBMIT_INIT_TOOL_NAME)
    const task = this.drafts.get(resolve(parsed.data.workDir))
    if (task === undefined) throw new Error(`${parsed.data.workDir} 不是本次 DSH 运行中观象起草任务的运行目录；DSH 重启后需要重新起草`)
    if (task.sessionId !== agent.session.header.id) throw new Error(`${parsed.data.workDir} 不是当前会话起草的任务`)
    const approval = this.deps.approval()
    if (approval === undefined) throw new Error('当前 DSH 组合没有审批服务（@deepseek-ai/dsh-user-approval），观象不会在未经授权时提交')
    const repos = requireRepos(this.deps.repos())
    const target = this.deps.registry.branchOf(task.url)

    let prepared: Awaited<ReturnType<RepoInitializer['prepare']>>
    try {
      prepared = await this.prepare(task, exec.signal)
    } catch (error) {
      exec.signal.throwIfAborted()
      throw error
    }
    const { draft, change, diffPath } = prepared
    const { app, reason } = draft
    const branch = `logalyze/init-${app.id}-${change.digest.slice(0, 10)}`
    const changed = new Set(change.files.map(file => file.path))
    const title = `接入观象日志分析：${app.name}（${app.id}）`
    const preview = reason.replace(/\s+/g, ' ').slice(0, REASON_PREVIEW_CHARS)
    const outcome = await submitChange({
      repos,
      approval,
      agent,
      exec,
      toolName: SUBMIT_INIT_TOOL_NAME,
      url: task.url,
      base: task.commit,
      branch,
      target,
      // Only files that differ from the base commit; an unchanged one would be an empty update.
      files: draft.files
        .map(file => ({ action: 'write' as const, path: `${AGENTS_DIR}/${file.path}`, content: file.content }))
        .filter(file => changed.has(file.path)),
      message: `${title}\n\n${reason}\n\nProposed-by: 观象 Logalyze\nBase-commit: ${task.commit}\nSession: ${task.sessionId}\n`,
      title,
      body: `由观象起草的应用描述 ${AGENTS_DIR}/logalyze.yaml 与日志分析 SKILL ${AGENTS_DIR}/skills/${app.skill}/（基于提交 ${task.commit.slice(0, 12)}，会话 ${task.sessionId}）。合并后观象下一次加载 /logalyze 时启用该应用。说明：${reason.slice(0, REASON_DESCRIPTION_CHARS)}`,
      ...this.deps.author === undefined ? {} : { author: this.deps.author },
      prompt: {
        zh: `观象将在 ${task.url} 提交新分支 ${branch}，并创建合并请求合入 ${target}，接入应用「${app.name}」（${app.id}）。改动：${describeFiles(change.files)}。说明：${preview}`,
        en: `Logalyze will commit branch ${branch} to ${task.url} and open a merge request into ${target} to onboard application ${app.id}. Files: ${change.files.map(file => file.path).join(', ')}`,
      },
    })
    return { app: app.id, repo: task.url, branch, target, files: [...change.files], diffPath, ...outcome }
  }
}
