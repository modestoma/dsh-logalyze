/**
 * 观象日志监管（`log-supervisor`）的 4 个核心模型工具：
 * 1. `supervisor_log_prepare`：幂等准备 `<workDir>/{logs,repos,scratch}`（兼容平台自动任务与飞书人工附件/URL），检出可检索代码与仓库 SKILL，并预检索 `IssueMemory`；
 * 2. `supervisor_issue_search`：在分析中随时检索本地已知问题库（`humanConclusion` 人工结论优先展示）；
 * 3. `supervisor_log_submit`：1:1 槽位覆盖校验 + 证据路径真实性校验 + 附件快照，原子写入 `log_tasks` 修订并触发 `IssueMemory` 更新与 `OutboxRunner` 回传；
 * 4. `supervisor_log_push_mr`：携带调用者 `agent` / `callId` 经 `dshRepos.workspacePush` 提交 `fix_code` 或隔离工作区 `improve_skill` MR，回填 `IssueMemory.fixMrUrl` 并登记进「审微」MR 监管队列。
 *
 * @module dsh-logalyze/log/tools
 */

import { constants } from 'node:fs'
import { copyFile, cp, lstat, mkdir, open, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import { parse as parseYaml } from 'yaml'
import type { ReadyApp } from '../apps/registry.ts'
import type { DshRepos } from '../deps/repos-contract.ts'
import type { ContentBlock, ToolDefinition, ToolRunContext } from '../host.ts'
import type { IssueMemory, SearchedIssue } from '../issues/memory.ts'
import type { RegisterSelfMrInput } from '../mr/supervisor.ts'
import { pathProblem } from '../report/manifest.ts'
import { admitUrl, downloadLog, fileNameFor, safeFileName } from '../runs/download.ts'
import { isInside } from '../runs/run-dir.ts'
import type {
  LogEvidence,
  LogRevisionItem,
  LogTaskInput,
  LogTaskRecord,
  LogTaskRevision,
} from '../runtime/domain.ts'
import {
  REPORT_DIR,
  type DownloadSettings,
  type UploadSettings,
} from '../settings/contract.ts'
import {
  ISSUE_SEARCH_TOOL_NAME,
  LOG_PREPARE_TOOL_NAME,
  LOG_PUSH_MR_TOOL_NAME,
  LOG_SUBMIT_TOOL_NAME,
} from '../tool-names.ts'
import { messageOf } from '../util/errors.ts'
import { appSlugOf, buildDefaultActionsForRevision } from './prompt.ts'
import { unpackLogSlot } from './unpack.ts'

const MAX_PREPARED_LOGS = 20
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024

/** Discovered optional skill inside a checked-out application repository. */
export interface DiscoveredRepoSkill {
  readonly name: string
  readonly description: string
  readonly path: string
  readonly source: '.dsh/skills' | '.agents/skills'
}

/** Local manifest written to `<workDir>/logs/manifest.json`. */
export interface LogSlotManifestEntry extends LogTaskInput {
  readonly dir: string
  readonly files: readonly string[]
  readonly totalBytes: number
  readonly unpackStatus: 'ok' | 'corrupted'
  readonly unpackError?: string
}

export interface LogWorkspaceManifest {
  readonly taskId: string
  readonly source: 'platform' | 'feishu'
  readonly appId: string
  readonly appName: string
  readonly errorCode?: string
  readonly slots: readonly LogSlotManifestEntry[]
}

/** Runtime callbacks supplied to log supervision tools by `LogSupervisor` & `LogalyzeService`. */
export interface LogToolsRuntime {
  resolveApp(appOrAlias: string): ReadyApp
  readyApp(appId: string): ReadyApp
  requireRepos(): DshRepos
  downloadSettings(): DownloadSettings
  uploadSettings(): UploadSettings
  maxUnpackBytes(): number
  issueMemory(): IssueMemory
  platformDownload(
    log: { readonly ref: string; readonly logId: string; readonly fileName: string },
    dir: string,
    fileName: string,
    download: DownloadSettings,
    signal: AbortSignal,
  ): Promise<string>
  readonly fetch?: typeof fetch
  resolveTaskForSession(sessionId: string, taskId?: string): { readonly taskId: string; readonly task: LogTaskRecord } | undefined
  createFeishuTask(input: {
    readonly sessionId: string
    readonly workDir: string
    readonly app: ReadyApp
    readonly inputs: readonly LogTaskInput[]
  }): Promise<{ readonly taskId: string; readonly task: LogTaskRecord }>
  updateTask(taskId: string, updater: (current: LogTaskRecord) => LogTaskRecord): Promise<LogTaskRecord>
  withTaskOperation<T>(taskId: string, fn: () => Promise<T>): Promise<T>
  onRevisionSubmitted(params: {
    readonly taskId: string
    readonly task: LogTaskRecord
    readonly revision: LogTaskRevision
    readonly app: ReadyApp
  }): Promise<{ readonly enqueuedOutboxKeys: readonly string[]; readonly detailUrlBackfilled: boolean }>
  registerSelfMr?(input: RegisterSelfMrInput): Promise<void>
  logWorkspacesRoot(): string
  now(): number
}

const prepareArgsSchema = z.object({
  taskId: z.string().trim().min(1).optional(),
  app: z.string().trim().min(1).optional(),
  logs: z.array(
    z.union([
      z.object({ path: z.string().trim().min(1) }).strict(),
      z.object({ url: z.string().trim().min(1) }).strict(),
    ]),
  ).max(MAX_PREPARED_LOGS).optional(),
  workspace: z.enum(['diagnosis', 'knowledge']).default('diagnosis'),
}).strict()

const issueSearchArgsSchema = z.object({
  query: z.string().trim().min(1, '检索关键词不能为空'),
  app: z.string().trim().min(1).optional(),
  limit: z.number().int().min(1).max(30).optional(),
}).strict()

const issueLinkSchema = z.union([
  z.object({
    mode: z.literal('existing'),
    issueId: z.string().trim().min(1, '已有 issueId 不能为空'),
  }).strict(),
  z.object({
    mode: z.literal('new'),
    title: z.string().trim().min(1, '新问题标题不能为空').max(200),
    matchCriteria: z.string().trim().min(1, '匹配特征不能为空').max(2000),
    exclusionCriteria: z.string().trim().max(1000).optional(),
    resolutionAdvice: z.string().trim().min(1, '处置建议不能为空').max(2000),
  }).strict(),
])

const submitArgsSchema = z.object({
  taskId: z.string().trim().min(1).optional(),
  summary: z.string().trim().min(1, '批次总体摘要不能为空').max(8000),
  items: z.array(
    z.object({
      ref: z.string().trim().min(1),
      status: z.enum(['diagnosed', 'insufficient_evidence', 'corrupted_log']),
      rootCauseCategory: z.enum(['code_defect', 'config_or_env', 'hardware_or_external', 'usage_error', 'unknown']),
      conclusion: z.string().trim().min(1, '单日志结论不能为空').max(12_000),
      evidences: z.array(
        z.object({
          source: z.string().trim().min(1, '证据路径不能为空'),
          locator: z.string().trim().min(1, '证据行号/时间戳不能为空'),
          excerpt: z.string().trim().min(1, '证据摘录不能为空').max(2000),
        }).strict(),
      ).max(30),
      issueLink: issueLinkSchema.optional(),
    }).strict(),
  ).min(1),
  attachments: z.array(z.string().trim().min(1)).max(20).optional(),
}).strict()

const pushMrArgsSchema = z.object({
  kind: z.enum(['fix_code', 'improve_skill']),
  taskId: z.string().trim().min(1).optional(),
  workspaceDir: z.string().trim().min(1).optional(),
  commitMessage: z.string().trim().min(1, '提交信息不能为空').max(2000),
  mrTitle: z.string().trim().min(1, 'MR 标题不能为空').max(300),
  mrBody: z.string().trim().max(16_000).optional(),
  issueId: z.string().trim().min(1).optional(),
}).strict()

function textBlock(data: unknown): ContentBlock[] {
  return [{ type: 'text', text: JSON.stringify(data, null, 2) }]
}

function sessionIdOf(exec: ToolRunContext): string {
  const id = exec.agent?.session?.header?.id
  if (id === undefined || id === '') {
    throw new Error('缺少当前会话标识（agent.session.header.id），无法定位工作区与绑定任务')
  }
  return id
}

function workspaceRootOf(exec: ToolRunContext, runtime: LogToolsRuntime, boundWorkDir?: string): string {
  const sessionCwd = exec.agent?.session?.header?.cwd
  if (sessionCwd !== undefined && sessionCwd !== '') return resolve(sessionCwd)
  if (boundWorkDir !== undefined && boundWorkDir !== '') return resolve(boundWorkDir)
  const sessionId = sessionIdOf(exec)
  return resolve(runtime.logWorkspacesRoot(), sessionId.replace(/[^A-Za-z0-9._-]+/gu, '_'))
}

async function pathExists(target: string): Promise<boolean> {
  return await stat(target).then(() => true, () => false)
}

async function copyIfRegularFile(src: string, dest: string): Promise<void> {
  const info = await lstat(src)
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(`日志路径不是普通文件（拒绝符号链接或目录）：${src}`)
  }
  await copyFile(src, dest)
}

async function scanRepoSkills(repoDir: string): Promise<DiscoveredRepoSkill[]> {
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

function shortTaskSlug(taskId: string): string {
  const cleaned = taskId.replace(/[^A-Za-z0-9]/gu, '').toLowerCase()
  return cleaned.slice(-8) || 'task'
}

async function ensureAppWorkspace(params: {
  readonly repos: DshRepos
  readonly repoDir: string
  readonly app: ReadyApp
  readonly taskId: string
  readonly mode: 'diagnosis' | 'knowledge'
  readonly exec: ToolRunContext
}): Promise<string> {
  const { repos, repoDir, app, taskId, mode, exec } = params
  if (await pathExists(join(repoDir, '.git'))) {
    return repoDir
  }
  const dirEntries = await readdir(repoDir).catch(() => [] as string[])
  if (dirEntries.length > 0) {
    throw new Error(`工作区目录 ${repoDir} 非空且不是 Git 仓库，拒绝覆盖`)
  }
  const slug = appSlugOf(app.app.id)
  const suffix = shortTaskSlug(taskId)
  const branch = mode === 'knowledge' ? `docs/skill-${slug}-${suffix}` : `fix/log-${slug}-${suffix}`
  await mkdir(repoDir, { recursive: true })
  await repos.workspaceCreate({
    repo: app.url,
    path: repoDir,
    ...(app.branch === undefined ? {} : { base: app.branch }),
    commit: app.commit,
    branch,
    ...(exec.agent === undefined ? {} : { agent: exec.agent }),
    signal: exec.signal,
  })
  return repoDir
}

async function resolveExistingEvidencePath(workDir: string, slug: string, source: string): Promise<string | undefined> {
  const trimmed = source.trim()
  if (trimmed === '' || trimmed.includes('\0')) return undefined
  const candidates: string[] = []
  if (isAbsolute(trimmed)) {
    candidates.push(resolve(trimmed))
  } else {
    candidates.push(resolve(workDir, trimmed))
    candidates.push(resolve(workDir, 'repos', slug, trimmed))
  }
  for (const candidate of candidates) {
    if (!isInside(candidate, workDir)) continue
    try {
      const info = await lstat(candidate)
      if (info.isFile() && !info.isSymbolicLink()) return candidate
    } catch {
      // Try next candidate
    }
  }
  return undefined
}

async function readLocalManifest(manifestPath: string): Promise<LogWorkspaceManifest | undefined> {
  try {
    const raw = await readFile(manifestPath, 'utf8')
    return JSON.parse(raw) as LogWorkspaceManifest
  } catch {
    return undefined
  }
}

async function prepareLogDirectory(params: {
  readonly runtime: LogToolsRuntime
  readonly workDir: string
  readonly taskId: string
  readonly task: LogTaskRecord
  readonly app: ReadyApp
  readonly signal: AbortSignal
}): Promise<{ readonly manifest: LogWorkspaceManifest; readonly inputs: LogTaskInput[]; readonly reused: boolean }> {
  const { runtime, workDir, taskId, task, app, signal } = params
  const logsDir = join(workDir, 'logs')
  const manifestPath = join(logsDir, 'manifest.json')
  const scratchDir = join(workDir, 'scratch')
  await mkdir(logsDir, { recursive: true })
  await mkdir(scratchDir, { recursive: true })

  // If this session transitioned from headless Phase 1 to a new Feishu topic workDir, reuse prepared files!
  if (task.workDir !== undefined && resolve(task.workDir) !== resolve(workDir)) {
    if (
      !(await pathExists(manifestPath))
      && (await pathExists(join(task.workDir, 'logs', 'manifest.json')))
    ) {
      await cp(join(task.workDir, 'logs'), logsDir, { recursive: true })
    }
    if (await pathExists(join(task.workDir, 'scratch'))) {
      await cp(join(task.workDir, 'scratch'), scratchDir, { recursive: true, force: false })
    }
  }

  const existingManifest = await readLocalManifest(manifestPath)
  if (existingManifest !== undefined && existingManifest.taskId === taskId) {
    return { manifest: existingManifest, inputs: [...task.inputs], reused: true }
  }

  const downloadSettings = runtime.downloadSettings()
  const maxUnpackBytes = runtime.maxUnpackBytes()
  const stagingRoot = join(workDir, '.staging-logs')
  await rm(stagingRoot, { recursive: true, force: true })
  await mkdir(stagingRoot, { recursive: true })

  const slots: LogSlotManifestEntry[] = []
  const updatedInputs: LogTaskInput[] = []

  try {
    for (const input of task.inputs) {
      const slotDir = join(logsDir, input.ref)
      const stageDir = join(stagingRoot, input.ref)
      await mkdir(stageDir, { recursive: true })
      const rawName = input.fileName
        ?? (input.path !== undefined ? basename(input.path) : undefined)
        ?? (input.url !== undefined ? fileNameFor(admitUrl(input.url, downloadSettings), `${input.ref}.log`) : `${input.ref}.log`)
      const fileName = safeFileName(rawName) || `${input.ref}.log`
      let stagedPath: string
      if (input.logId !== undefined) {
        stagedPath = await runtime.platformDownload(
          { ref: input.ref, logId: input.logId, fileName },
          stageDir,
          fileName,
          downloadSettings,
          signal,
        )
      } else if (input.url !== undefined) {
        const admitted = admitUrl(input.url, downloadSettings)
        const downloaded = await downloadLog(admitted.href, stageDir, fileName, downloadSettings, signal, runtime.fetch)
        stagedPath = downloaded.path
      } else if (input.path !== undefined) {
        const target = join(stageDir, fileName)
        await copyIfRegularFile(input.path, target)
        stagedPath = target
      } else {
        throw new Error(`日志槽位 ${input.ref} 缺少 logId、path 或 url`)
      }

      const unpack = await unpackLogSlot({
        archivePath: stagedPath,
        fileName,
        destDir: slotDir,
        maxBytes: maxUnpackBytes,
      })

      const enrichedInput: LogTaskInput = {
        ...input,
        fileName,
        path: `logs/${input.ref}`,
        unpackStatus: unpack.status,
        ...(unpack.status === 'corrupted' ? { unpackError: unpack.error } : {}),
      }
      updatedInputs.push(enrichedInput)
      slots.push({
        ...enrichedInput,
        dir: `logs/${input.ref}`,
        files: unpack.status === 'ok' ? unpack.files : ['CORRUPTED.txt'],
        totalBytes: unpack.totalBytes,
        unpackStatus: unpack.status,
        ...(unpack.status === 'corrupted' ? { unpackError: unpack.error } : {}),
      })
    }
  } finally {
    await rm(stagingRoot, { recursive: true, force: true })
  }

  const manifest: LogWorkspaceManifest = {
    taskId,
    source: task.source,
    appId: app.app.id,
    appName: app.app.name,
    ...(task.errorCode === undefined ? {} : { errorCode: task.errorCode }),
    slots,
  }
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  return { manifest, inputs: updatedInputs, reused: false }
}

function defaultSearchQuery(task: LogTaskRecord, app: ReadyApp): string {
  const parts = [
    task.errorCode,
    app.app.id,
    ...task.inputs.map(item => item.fileName),
    ...task.inputs.map(item => item.componentCode),
  ].filter((v): v is string => typeof v === 'string' && v.trim() !== '')
  return [...new Set(parts)].join(' ')
}

function formatIssueCandidates(issues: readonly SearchedIssue[]): unknown[] {
  return issues.map(issue => ({
    issueId: issue.issueId,
    title: issue.title,
    aiStatus: issue.aiStatus,
    ...(issue.humanConclusion !== undefined
      ? {
          PRIORITY_HUMAN_CONCLUSION: issue.humanConclusion,
          humanConclusion: issue.humanConclusion,
        }
      : {}),
    ...(issue.humanStatus !== undefined ? { humanStatus: issue.humanStatus } : {}),
    ...(issue.assignee !== undefined ? { assignee: issue.assignee } : {}),
    matchCriteria: issue.matchCriteria,
    ...(issue.exclusionCriteria !== undefined ? { exclusionCriteria: issue.exclusionCriteria } : {}),
    aiDiagnosis: issue.aiDiagnosis,
    resolutionAdvice: issue.resolutionAdvice,
    ...(issue.fixMrUrl !== undefined ? { fixMrUrl: issue.fixMrUrl } : {}),
    lastSeenAt: new Date(issue.lastSeenAt).toISOString(),
  }))
}

/** Create the 4 unified `log-supervisor` tools. */
export function createLogTools(runtime: LogToolsRuntime): ToolDefinition<unknown>[] {
  const prepareTool: ToolDefinition<{
    readonly taskId: string
    readonly source: 'platform' | 'feishu'
    readonly appId: string
    readonly appName: string
    readonly writable: boolean
    readonly baseCommit: string
    readonly workDir: string
    readonly logsDir: string
    readonly manifestPath: string
    readonly repoDir: string
    readonly scratchDir: string
    readonly workspaceKind: 'diagnosis' | 'knowledge'
    readonly reused: boolean
    readonly slots: readonly LogSlotManifestEntry[]
    readonly repoSkills: readonly DiscoveredRepoSkill[]
    readonly candidateIssues: readonly unknown[]
  }> = {
    name: LOG_PREPARE_TOOL_NAME,
    description: '准备或刷新当前日志监管会话的工作区：<workDir>/logs/L1..Ln（安全解包与损坏隔离）、<workDir>/repos/<app-slug>（或 knowledge 隔离工作区）、<workDir>/scratch、仓库可选 SKILL 清单及本地已知问题库候选（humanConclusion 优先）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        taskId: { type: 'string', description: '平台自动批次分配的 taskId；已在当前会话绑定过任务时可省略' },
        app: { type: 'string', description: '飞书人工发起分析时的应用名称、别名或 id' },
        logs: {
          type: 'array',
          description: '飞书人工发起分析时的日志列表，每项为 { "path": 本机路径 } 或 { "url": 白名单下载地址 }',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              path: { type: 'string' },
              url: { type: 'string' },
            },
          },
        },
        workspace: {
          type: 'string',
          enum: ['diagnosis', 'knowledge'],
          description: '默认为 diagnosis（检出 <app-slug>）；在点击「改进分析流程/沉淀案例」时必须传 knowledge（检出独立的 <app-slug>-knowledge）',
        },
      },
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => textBlock(value),
    },
    async execute(rawArgs, exec) {
      const parsed = prepareArgsSchema.safeParse(rawArgs ?? {})
      if (!parsed.success) {
        throw new Error(`supervisor_log_prepare 参数无效：${parsed.error.issues[0]?.message ?? parsed.error.message}`)
      }
      const args = parsed.data
      const sessionId = sessionIdOf(exec)
      let bound = runtime.resolveTaskForSession(sessionId, args.taskId)

      let app: ReadyApp
      if (bound !== undefined) {
        app = runtime.readyApp(bound.task.appId)
      } else {
        if (args.taskId !== undefined) {
          throw new Error(`找不到日志监管任务 "${args.taskId}"`)
        }
        if (args.app === undefined) {
          throw new Error('当前会话尚未绑定日志任务，请在首次调用 supervisor_log_prepare 时传入 app（应用名/别名/id）与 logs')
        }
        if (args.logs === undefined || args.logs.length === 0) {
          throw new Error('飞书人工分析首次调用 supervisor_log_prepare 时必须提供至少一份 logs（path 或 url）')
        }
        app = runtime.resolveApp(args.app)
        const workDir = workspaceRootOf(exec, runtime)
        const baseDir = exec.agent?.session.header.cwd ?? workDir
        const inputs: LogTaskInput[] = []
        const downloadSettings = runtime.downloadSettings()
        for (const [index, log] of args.logs.entries()) {
          const ref = `L${index + 1}`
          if ('path' in log) {
            const absPath = resolve(baseDir, log.path)
            const info = await lstat(absPath).catch((err: unknown) => {
              throw new Error(`日志路径不可读：${absPath}（${messageOf(err)}）`)
            })
            if (!info.isFile() || info.isSymbolicLink()) {
              throw new Error(`日志路径必须是普通文件（拒绝符号链接）：${absPath}`)
            }
            inputs.push({ ref, path: absPath, fileName: basename(absPath) })
          } else {
            const admitted = admitUrl(log.url, downloadSettings)
            inputs.push({ ref, url: admitted.href, fileName: fileNameFor(admitted, `${ref}.log`) })
          }
        }
        bound = await runtime.createFeishuTask({ sessionId, workDir, app, inputs })
      }

      const initialTaskId = bound.taskId
      return await runtime.withTaskOperation(initialTaskId, async () => {
        const currentBound = runtime.resolveTaskForSession(sessionId, initialTaskId)
        if (currentBound === undefined) {
          throw new Error(`找不到日志监管任务 "${initialTaskId}"`)
        }
        const currentApp = runtime.readyApp(currentBound.task.appId)
        const workDir = workspaceRootOf(exec, runtime, currentBound.task.workDir)
        await mkdir(join(workDir, 'repos'), { recursive: true })
        await mkdir(join(workDir, 'scratch'), { recursive: true })

        const preparedLogs = await prepareLogDirectory({
          runtime,
          workDir,
          taskId: currentBound.taskId,
          task: currentBound.task,
          app: currentApp,
          signal: exec.signal,
        })

        const slug = appSlugOf(currentApp.app.id)
        const repoDir = join(workDir, 'repos', args.workspace === 'knowledge' ? `${slug}-knowledge` : slug)
        await ensureAppWorkspace({
          repos: runtime.requireRepos(),
          repoDir,
          app: currentApp,
          taskId: currentBound.taskId,
          mode: args.workspace,
          exec,
        })

        await runtime.updateTask(currentBound.taskId, cur => ({
          ...cur,
          sessionId,
          workDir: resolve(cur.workDir ?? '') === workDir ? cur.workDir : workDir,
          inputs: preparedLogs.inputs,
          updatedAt: runtime.now(),
        }))

        const repoSkills = await scanRepoSkills(repoDir)
        const query = defaultSearchQuery(currentBound.task, currentApp)
        const matched = runtime.issueMemory().search({ appId: currentApp.app.id, query, limit: 8 })
        const seenIds = new Set(matched.map(c => c.issueId))
        const candidates: SearchedIssue[] = [...matched]
        if (candidates.length < 8) {
          const extra = runtime
            .issueMemory()
            .table.listByApp(currentApp.app.id)
            .filter(([issueId]) => !seenIds.has(issueId))
            .sort(([, a], [, b]) => {
              const aHuman = a.humanConclusion !== undefined ? 1 : 0
              const bHuman = b.humanConclusion !== undefined ? 1 : 0
              if (aHuman !== bHuman) return bHuman - aHuman
              return b.lastSeenAt - a.lastSeenAt
            })
          for (const [issueId, record] of extra) {
            if (candidates.length >= 8) break
            candidates.push({ issueId, ...record, score: 0 })
          }
        }

        return {
          taskId: currentBound.taskId,
          source: currentBound.task.source,
          appId: currentApp.app.id,
          appName: currentApp.app.name,
          writable: currentApp.writable,
          baseCommit: currentApp.commit,
          workDir,
          logsDir: join(workDir, 'logs'),
          manifestPath: join(workDir, 'logs', 'manifest.json'),
          repoDir,
          scratchDir: join(workDir, 'scratch'),
          workspaceKind: args.workspace,
          reused: preparedLogs.reused,
          slots: preparedLogs.manifest.slots,
          repoSkills,
          candidateIssues: formatIssueCandidates(candidates),
        }
      })
    },
  }

  const issueSearchTool: ToolDefinition<{
    readonly appId?: string
    readonly query: string
    readonly count: number
    readonly issues: readonly unknown[]
  }> = {
    name: ISSUE_SEARCH_TOOL_NAME,
    description: '按关键字或错误码检索本地已知问题库（IssueMemory），用于排查中核对历史同类问题、匹配/排除条件与人工确认结论（humanConclusion 优先级最高）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['query'],
      properties: {
        query: { type: 'string', description: '异常关键字、错误码、类名或 issueId' },
        app: { type: 'string', description: '可选：应用名称/别名/id；不传时默认限定当前会话绑定的应用' },
        limit: { type: 'integer', minimum: 1, maximum: 30, description: '返回条数上限（默认 10）' },
      },
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => textBlock(value),
    },
    async execute(rawArgs, exec) {
      const parsed = issueSearchArgsSchema.safeParse(rawArgs)
      if (!parsed.success) {
        throw new Error(`supervisor_issue_search 参数无效：${parsed.error.issues[0]?.message ?? parsed.error.message}`)
      }
      const args = parsed.data
      let appId: string | undefined
      if (args.app !== undefined) {
        appId = runtime.resolveApp(args.app).app.id
      } else {
        const sessionId = exec.agent?.session?.header?.id
        if (sessionId !== undefined) {
          appId = runtime.resolveTaskForSession(sessionId)?.task.appId
        }
      }
      const hits = runtime.issueMemory().search({
        ...(appId === undefined ? {} : { appId }),
        query: args.query,
        ...(args.limit === undefined ? {} : { limit: args.limit }),
      })
      return {
        ...(appId === undefined ? {} : { appId }),
        query: args.query,
        count: hits.length,
        issues: formatIssueCandidates(hits),
      }
    },
  }

  const submitTool: ToolDefinition<{
    readonly taskId: string
    readonly revision: number
    readonly appId: string
    readonly writable: boolean
    readonly issueIds: readonly string[]
    readonly outboxEnqueued: readonly string[]
    readonly detailUrlBackfilled: boolean
    readonly skippedAttachments: readonly string[]
    readonly suggestedActions: readonly { readonly id: string; readonly label: string }[]
  }> = {
    name: LOG_SUBMIT_TOOL_NAME,
    description: '显式提交或修订结构化逐日志分析结论：校验 L1..Ln 1:1 覆盖与证据文件真实性，原子落盘新修订、更新 IssueMemory（不覆盖人工结论），并异步幂等回传日志平台。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['summary', 'items'],
      properties: {
        taskId: { type: 'string', description: '可选：当前会话绑定的日志任务 ID' },
        summary: { type: 'string', description: '本次批次总体摘要' },
        items: {
          type: 'array',
          description: '逐份日志结论，必须严格 1:1 覆盖 manifest 中的所有 L1..Ln',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['ref', 'status', 'rootCauseCategory', 'conclusion', 'evidences'],
            properties: {
              ref: { type: 'string' },
              status: { type: 'string', enum: ['diagnosed', 'insufficient_evidence', 'corrupted_log'] },
              rootCauseCategory: {
                type: 'string',
                enum: ['code_defect', 'config_or_env', 'hardware_or_external', 'usage_error', 'unknown'],
              },
              conclusion: { type: 'string' },
              evidences: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['source', 'locator', 'excerpt'],
                  properties: {
                    source: { type: 'string' },
                    locator: { type: 'string' },
                    excerpt: { type: 'string' },
                  },
                },
              },
              issueLink: {
                type: 'object',
                description: '关联已有 issueId（{ mode: "existing", issueId }）或登记新问题（{ mode: "new", title, matchCriteria, resolutionAdvice }）',
              },
            },
          },
        },
        attachments: {
          type: 'array',
          description: '可选：位于 scratch/ 下要随平台报告一并上传的额外文件相对路径',
          items: { type: 'string' },
        },
      },
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => textBlock(value),
    },
    async execute(rawArgs, exec) {
      const parsed = submitArgsSchema.safeParse(rawArgs)
      if (!parsed.success) {
        const first = parsed.error.issues[0]
        throw new Error(`supervisor_log_submit 参数无效（${first?.path.join('.') || 'body'}）：${first?.message ?? parsed.error.message}`)
      }
      const args = parsed.data
      const sessionId = sessionIdOf(exec)
      const initialBound = runtime.resolveTaskForSession(sessionId, args.taskId)
      if (initialBound === undefined) {
        throw new Error('当前会话尚未绑定任何日志监管任务，请先调用 supervisor_log_prepare')
      }

      return await runtime.withTaskOperation(initialBound.taskId, async () => {
        const bound = runtime.resolveTaskForSession(sessionId, initialBound.taskId)
        if (bound === undefined) {
          throw new Error(`找不到日志监管任务 "${initialBound.taskId}"`)
        }
        const { taskId, task } = bound
        const workDir = task.workDir ?? workspaceRootOf(exec, runtime)
        const app = runtime.readyApp(task.appId)
        const slug = appSlugOf(app.app.id)

        // 1. Validate 1:1 ref alignment
        const expectedRefs = task.inputs.map(i => i.ref)
        const seenRefs = new Set<string>()
        for (const item of args.items) {
          if (!expectedRefs.includes(item.ref)) {
            throw new Error(`提交包含未知的日志槽位 "${item.ref}"（本任务有效槽位：${expectedRefs.join('、')}）`)
          }
          if (seenRefs.has(item.ref)) {
            throw new Error(`日志槽位 "${item.ref}" 重复提交；每个槽位只能提交一条结论`)
          }
          seenRefs.add(item.ref)
        }
        const missingRefs = expectedRefs.filter(ref => !seenRefs.has(ref))
        if (missingRefs.length > 0) {
          throw new Error(`提交缺少以下日志槽位结论（禁止漏项）：${missingRefs.join('、')}`)
        }

        // 2. Validate evidence presence & real file existence inside <workDir>
        const reposDir = join(workDir, 'repos')
        for (const item of args.items) {
          if (item.status === 'diagnosed' && item.evidences.length === 0) {
            throw new Error(`槽位 ${item.ref} 标记为 diagnosed，必须提供至少一条可追溯的 evidences`)
          }
          let hasRepoEvidence = false
          for (const ev of item.evidences) {
            const resolved = await resolveExistingEvidencePath(workDir, slug, ev.source)
            if (resolved === undefined) {
              throw new Error(`槽位 ${item.ref} 的证据路径 "${ev.source}" 在工作区 "${workDir}" 中不存在或非普通文件；请填写真实可读的文件路径`)
            }
            if (isInside(resolved, reposDir)) {
              hasRepoEvidence = true
            }
          }
          if (item.status === 'diagnosed' && item.rootCauseCategory === 'code_defect' && !hasRepoEvidence) {
            throw new Error(`槽位 ${item.ref} 归因为 code_defect，必须包含至少一条指向 repos/ 代码仓库文件的证据`)
          }
        }

        // 3. Validate & snapshot attachments into report/revisions/rev-N/
        const nextRevNumber = (task.revisions.reduce((max, r) => Math.max(max, r.revision), 0)) + 1
        const revDir = join(workDir, REPORT_DIR, 'revisions', `rev-${nextRevNumber}`)
        await rm(revDir, { recursive: true, force: true })
        await mkdir(revDir, { recursive: true })

        const savedAttachments: string[] = []
        const skippedAttachments: string[] = []
        for (const relRaw of args.attachments ?? []) {
          const cleanRel = relRaw.replace(/\\/gu, '/').replace(/^\.\//u, '').replace(/^scratch\//u, '')
          const problem = pathProblem(cleanRel)
          if (problem !== undefined) {
            throw new Error(`附件 "${relRaw}" 不符合日志平台命名限制：${problem}`)
          }
          const candidates = [
            resolve(workDir, relRaw),
            resolve(workDir, 'scratch', cleanRel),
          ]
          let srcPath: string | undefined
          for (const candidate of candidates) {
            if (!isInside(candidate, workDir)) continue
            const info = await lstat(candidate).catch(() => undefined)
            if (info?.isFile() && !info.isSymbolicLink()) {
              srcPath = candidate
              break
            }
          }
          if (srcPath === undefined) {
            throw new Error(`附件 "${relRaw}" 在工作区 scratch/ 中不存在或非普通文件`)
          }
          const info = await stat(srcPath)
          if (info.size === 0 || info.size > MAX_ATTACHMENT_BYTES) {
            skippedAttachments.push(`${cleanRel}：大小不合法 (${info.size} B)`)
            continue
          }
          const destPath = resolve(revDir, cleanRel)
          if (!isInside(destPath, revDir)) {
            throw new Error(`附件路径越界：${relRaw}`)
          }
          await mkdir(resolve(destPath, '..'), { recursive: true })
          const fh = await open(srcPath, constants.O_RDONLY | constants.O_NOFOLLOW)
          try {
            const bytes = await fh.readFile()
            await writeFile(destPath, bytes)
          } finally {
            await fh.close()
          }
          savedAttachments.push(cleanRel)
        }

        // 4. Upsert IssueMemory entries (preserving humanConclusion / humanStatus / assignee)
        const now = runtime.now()
        const issueMem = runtime.issueMemory()
        const itemIssueIds = new Map<string, string>()
        const createdOrUsedIssues = new Set<string>()

        for (const item of args.items) {
          if (item.issueLink === undefined) continue
          if (item.issueLink.mode === 'existing') {
            const existing = issueMem.table.get(item.issueLink.issueId)
            if (existing === undefined) {
              throw new Error(`槽位 ${item.ref} 引用的已知问题 "${item.issueLink.issueId}" 不存在`)
            }
            if (existing.appId !== app.app.id) {
              throw new Error(`已知问题 "${item.issueLink.issueId}" 属于应用 ${existing.appId}，与当前应用 ${app.app.id} 不匹配`)
            }
            await issueMem.touchExisting({
              issueId: item.issueLink.issueId,
              appId: app.app.id,
              title: existing.title,
              matchCriteria: existing.matchCriteria,
              ...(existing.exclusionCriteria === undefined ? {} : { exclusionCriteria: existing.exclusionCriteria }),
              aiDiagnosis: item.conclusion,
              aiStatus: existing.aiStatus === 'fixed' ? 'fixed' : 'located',
              resolutionAdvice: existing.resolutionAdvice,
              seenAt: now,
            })
            itemIssueIds.set(item.ref, item.issueLink.issueId)
            createdOrUsedIssues.add(item.issueLink.issueId)
          } else {
            const res = await issueMem.upsertNewOrReuseByTitle({
              appId: app.app.id,
              title: item.issueLink.title,
              matchCriteria: item.issueLink.matchCriteria,
              ...(item.issueLink.exclusionCriteria === undefined ? {} : { exclusionCriteria: item.issueLink.exclusionCriteria }),
              aiDiagnosis: item.conclusion,
              aiStatus: 'located',
              resolutionAdvice: item.issueLink.resolutionAdvice,
              seenAt: now,
            })
            itemIssueIds.set(item.ref, res.issueId)
            createdOrUsedIssues.add(res.issueId)
          }
        }

        const normalizedItems: LogRevisionItem[] = args.items.map((item) => {
          const linkedIssue = itemIssueIds.get(item.ref)
          const evidences: LogEvidence[] = item.evidences.map(ev => ({
            source: ev.source,
            locator: ev.locator,
            excerpt: ev.excerpt,
          }))
          return {
            ref: item.ref,
            status: item.status,
            rootCauseCategory: item.rootCauseCategory,
            conclusion: item.conclusion,
            evidences,
            ...(linkedIssue === undefined ? {} : { issueId: linkedIssue }),
          }
        })

        const primaryIssueId = normalizedItems.find(i => i.issueId !== undefined)?.issueId
        const flatEvidence = normalizedItems.flatMap(i => i.evidences.map(e => `${i.ref}:${e.source}:${e.locator}`))
        const revision: LogTaskRevision = {
          revision: nextRevNumber,
          summary: args.summary,
          ...(primaryIssueId === undefined ? {} : { issueId: primaryIssueId }),
          ...(flatEvidence.length === 0 ? {} : { evidence: flatEvidence }),
          items: normalizedItems,
          ...(savedAttachments.length === 0 ? {} : { attachments: savedAttachments }),
          reportDir: revDir,
          createdAt: now,
        }

        // Persist the revision before marking completed; onRevisionSubmitted() enqueues durable
        // outbox rows first and atomically commits status='completed' (plus pendingTopicDelivery).
        const taskWithRevision = await runtime.updateTask(taskId, cur => ({
          ...cur,
          revisions: [...cur.revisions, revision],
          updatedAt: now,
        }))

        const postSubmit = await runtime.onRevisionSubmitted({
          taskId,
          task: taskWithRevision,
          revision,
          app,
        })

        const suggestedActions = buildDefaultActionsForRevision({
          taskId,
          appId: app.app.id,
          appName: app.app.name,
          repoUrl: app.url,
          baseCommit: app.commit,
          writable: app.writable,
          revision,
        }).map(a => ({ id: a.id, label: a.label }))

        return {
          taskId,
          revision: revision.revision,
          appId: app.app.id,
          writable: app.writable,
          issueIds: [...createdOrUsedIssues],
          outboxEnqueued: postSubmit.enqueuedOutboxKeys,
          detailUrlBackfilled: postSubmit.detailUrlBackfilled,
          skippedAttachments,
          suggestedActions,
        }
      })
    },
  }

  const pushMrTool: ToolDefinition<{
    readonly kind: 'fix_code' | 'improve_skill'
    readonly repo: string
    readonly workspacePath: string
    readonly branch: string
    readonly commit: string
    readonly mrNumber?: number
    readonly mrUrl?: string
    readonly mrError?: string
    readonly fixMrLinkedIssueId?: string
    readonly mrSupervisionRegistered: boolean
  }> = {
    name: LOG_PUSH_MR_TOOL_NAME,
    description: '将代码修复（fix_code）或隔离工作区的 SKILL/案例改进（improve_skill）经 dshRepos.workspacePush 推送并创建 MR，自动关联 IssueMemory.fixMrUrl 并登记到审微 MR 监管队列。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'commitMessage', 'mrTitle'],
      properties: {
        kind: { type: 'string', enum: ['fix_code', 'improve_skill'] },
        taskId: { type: 'string', description: '可选：当前会话绑定的日志任务 ID' },
        workspaceDir: { type: 'string', description: '可选：工作区目录；不传时按 kind 自动定位 repos/<app-slug> 或 repos/<app-slug>-knowledge' },
        commitMessage: { type: 'string', description: 'Git 提交说明' },
        mrTitle: { type: 'string', description: '合并请求标题' },
        mrBody: { type: 'string', description: '合并请求正文说明' },
        issueId: { type: 'string', description: '可选：关联的已知问题 issueId' },
      },
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => textBlock(value),
    },
    async execute(rawArgs, exec) {
      const parsed = pushMrArgsSchema.safeParse(rawArgs)
      if (!parsed.success) {
        throw new Error(`supervisor_log_push_mr 参数无效：${parsed.error.issues[0]?.message ?? parsed.error.message}`)
      }
      const args = parsed.data
      const agent = exec.agent
      if (agent === undefined) {
        throw new Error('supervisor_log_push_mr 必须由携带身份的 Agent 会话调用，以确保触发 dsh-repo 写权限审批与作者归属')
      }
      const sessionId = sessionIdOf(exec)
      const initialBound = runtime.resolveTaskForSession(sessionId, args.taskId)
      if (initialBound === undefined) {
        throw new Error('当前会话尚未绑定任何日志监管任务，无法确定目标应用仓库')
      }

      return await runtime.withTaskOperation(initialBound.taskId, async () => {
        const bound = runtime.resolveTaskForSession(sessionId, initialBound.taskId)
        if (bound === undefined) {
          throw new Error(`找不到日志监管任务 "${initialBound.taskId}"`)
        }
        const { taskId, task } = bound
        const app = runtime.readyApp(task.appId)
        if (!app.writable) {
          throw new Error(`应用 ${app.app.id} 的代码仓库为只读权限，禁止推送代码修复或 SKILL 改进`)
        }

        const workDir = task.workDir ?? workspaceRootOf(exec, runtime)
        const slug = appSlugOf(app.app.id)
        const expectedRepoDir = join(workDir, 'repos', args.kind === 'improve_skill' ? `${slug}-knowledge` : slug)
        const workspacePath = args.workspaceDir !== undefined ? resolve(workDir, args.workspaceDir) : expectedRepoDir
        if (!isInside(workspacePath, workDir)) {
          throw new Error(`工作区路径 ${workspacePath} 必须位于当前会话目录 ${workDir} 之内`)
        }
        if (!(await pathExists(join(workspacePath, '.git')))) {
          throw new Error(`工作区 ${workspacePath} 尚未初始化；请先调用 supervisor_log_prepare（workspace: "${args.kind === 'improve_skill' ? 'knowledge' : 'diagnosis'}"）`)
        }

        const repos = runtime.requireRepos()
        const status = await repos.workspaceStatus({ path: workspacePath, signal: exec.signal })
        if (status.files.length === 0) {
          throw new Error(`工作区 ${workspacePath} 相对于基准提交没有改动，无需推送`)
        }

        const latestRevision = task.revisions.at(-1)
        const resolvedIssueId = args.issueId
          ?? latestRevision?.items?.find(i => i.issueId !== undefined)?.issueId
          ?? latestRevision?.issueId
        const footerLines = [
          `- Log Supervision Task: \`${taskId}\``,
          resolvedIssueId === undefined ? undefined : `- Issue Memory: \`${resolvedIssueId}\``,
          latestRevision?.summary === undefined ? undefined : `- Summary: ${latestRevision.summary}`,
        ].filter(Boolean)
        const mrBody = [args.mrBody?.trim(), footerLines.join('\n')].filter(Boolean).join('\n\n')

        const pushed = await repos.workspacePush({
          path: workspacePath,
          message: args.commitMessage,
          mr: { title: args.mrTitle, ...(mrBody === '' ? {} : { body: mrBody }) },
          agent,
          ...(exec.callId === undefined ? {} : { callId: exec.callId }),
          signal: exec.signal,
        })

        const mr = pushed.createdMr ?? pushed.openMrs[0]
        let fixMrLinkedIssueId: string | undefined
        if (args.kind === 'fix_code' && mr?.webUrl !== undefined && resolvedIssueId !== undefined) {
          const existingIssue = runtime.issueMemory().table.get(resolvedIssueId)
          if (existingIssue?.appId === app.app.id) {
            await runtime.issueMemory().table.attachUrlsByAi(resolvedIssueId, { fixMrUrl: mr.webUrl })
            fixMrLinkedIssueId = resolvedIssueId
          }
        }

        let mrSupervisionRegistered = false
        if (mr !== undefined && runtime.registerSelfMr !== undefined) {
          await runtime.registerSelfMr({
            repo: app.url,
            mrNumber: mr.number,
            origin: args.kind === 'fix_code' ? 'self-fix' : 'self-skill',
            headSha: pushed.commit,
            sessionId,
            workDir: workspacePath,
            ...(task.feishuLaunchKey === undefined ? {} : { feishuLaunchKey: task.feishuLaunchKey }),
            ...(resolvedIssueId === undefined ? {} : { issueId: resolvedIssueId }),
            title: args.mrTitle,
            url: mr.webUrl,
            sourceBranch: pushed.branch,
            ...(app.branch === undefined ? {} : { targetBranch: app.branch }),
          })
          mrSupervisionRegistered = true
        }

        return {
          kind: args.kind,
          repo: app.url,
          workspacePath,
          branch: pushed.branch,
          commit: pushed.commit,
          ...(mr === undefined ? {} : { mrNumber: mr.number, mrUrl: mr.webUrl }),
          ...(pushed.mrError === undefined ? {} : { mrError: pushed.mrError }),
          ...(fixMrLinkedIssueId === undefined ? {} : { fixMrLinkedIssueId }),
          mrSupervisionRegistered,
        }
      })
    },
  }

  return [
    prepareTool as ToolDefinition<unknown>,
    issueSearchTool as ToolDefinition<unknown>,
    submitTool as ToolDefinition<unknown>,
    pushMrTool as ToolDefinition<unknown>,
  ]
}
