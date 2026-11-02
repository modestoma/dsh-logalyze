/**
 * 分析报告回传：带 `logId` 的分析请求被接受后，观象记录这份报告，并在分析
 * 话题的每一轮结束时更新报告目录（话题工作目录下的 `report/`），再用相同参数
 * 调用回传命令。
 *
 * - 轮次来自 DSH 的 `session/event`：经 `feishuTopics.launchKeyOf` 把 Session
 *   对应到请求，`/renew` 之后的新 Session 也能对上。首轮的最终回复写成「分析
 *   结论」，之后每一轮写成「追问 N」（用户消息加最终回复），只追加不改写。
 * - 首轮之前就失败（话题或 Session 没能建立）或在首轮进行中 DSH 重启时，
 *   `feishu-topics/status` 事件（或加载时的核对）补一节说明原因的「分析结论」。
 * - `report.md` 只由观象生成：每次上传前按记录重写，模型写进目录的同名文件会被
 *   替换。回复里以 `report/` 开头的链接改成相对报告目录的路径；本轮新增或
 *   改动、回复却没有引用的文件追加在该节末尾的「本轮文件」里。
 * - 同一份报告的上传串行执行；上传进行中又有新的轮次时，结束后再上传一次最新
 *   内容。命令失败按退避重试；目录里有符号链接或超过文件数、总大小上限时不上传，
 *   等内容变化或在面板手动重传。
 *
 * @module dsh-logalyze/report/tracker
 */

import { randomUUID } from 'node:crypto'
import { lstat, mkdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AnalyzeRequest } from '../analyze/contract.ts'
import type { TopicLaunchState } from '../analyze/feishu-topics.ts'
import type { SessionEventEnvelope, SessionHeader } from '../host.ts'
import { REPORT_DIR, REPORT_ENTRY } from '../settings/contract.ts'
import type { ReportStatus, ReportWire, UploadPhase, UploadSettings } from '../settings/contract.ts'
import { runCommand, uploadArgv } from './command.ts'
import type { CommandRunner } from './command.ts'
import { changedFiles, listReport } from './files.ts'
import type { ReportListing } from './files.ts'
import { questionOf, renderReport, rewriteReply } from './render.ts'
import type { ReportSection } from './render.ts'
import { reportIdOf } from './store.ts'
import type { ReportRecord, ReportStore } from './store.ts'

/** The `feishuTopics` methods report tracking reads. */
export interface ReportTopics {
  state(key: string): TopicLaunchState | undefined
  launchKeyOf(sessionId: string): string | undefined
}

/** Collaborators of the tracker. */
export interface ReportTrackerDeps {
  readonly store: ReportStore
  /** The launch-state methods of the loaded `feishuTopics`, or undefined while unavailable. */
  topics(): ReportTopics | undefined
  /** Current upload settings. */
  upload(): UploadSettings
  readonly warn: (message: string) => void
  readonly run?: CommandRunner
  readonly now?: () => number
}

/** Reported in the analysis section when DSH restarted during the first turn. */
export const INTERRUPTED_REASON = 'DSH 在首轮分析进行中重启，分析中断；在飞书话题内回复即可继续。'

/** Reported when the first turn ended while the tracker was not listening. */
export const MISSED_REASON = '观象没有记录到首轮回复，请到飞书话题中查看。'

/** Most reports the panel lists. */
export const MAX_LISTED_REPORTS = 50

/** User messages and final reply collected during one turn. */
interface TurnBuffer {
  readonly questions: string[]
  reply: string
}

interface ContentBlockLike {
  readonly type: string
  readonly text?: unknown
}

interface TurnEndData {
  readonly turn: number
  readonly reason: { readonly kind: string; readonly error?: { readonly message?: string } }
}

type UploadOutcome = { readonly ok: true } | { readonly ok: false; readonly error: string; readonly retryable: boolean }

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return (content as readonly ContentBlockLike[])
    .flatMap(block => block.type === 'text' && typeof block.text === 'string' ? [block.text] : [])
    .join('')
}

/**
 * First-turn outcome of a turn end reason. Unknown kinds (the reason map is
 * merge-extensible) count as completed.
 * @param kind - `TurnEndReason.kind`.
 * @returns the recorded status.
 */
export function statusOfTurnEnd(kind: string): ReportStatus {
  switch (kind) {
    case 'aborted':
    case 'blocked':
      return 'stopped'
    case 'error':
      return 'error'
    case 'interrupted':
    case 'forked':
      return 'interrupted'
    case 'completed':
    case 'max-tokens':
    default:
      return 'done'
  }
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)]
}

/** Records analysis turns and uploads the report directory after each one. */
export class ReportTracker {
  private readonly buffers = new Map<string, TurnBuffer>()
  private readonly locks = new Map<string, Promise<void>>()
  private readonly workers = new Map<string, Promise<void>>()
  private readonly forced = new Set<string>()
  private readonly running = new Set<string>()
  private readonly waiting = new Set<string>()
  private readonly stop = new AbortController()
  private readonly run: CommandRunner
  private readonly now: () => number

  /** @param deps - collaborators. */
  constructor(private readonly deps: ReportTrackerDeps) {
    this.run = deps.run ?? runCommand
    this.now = deps.now ?? Date.now
  }

  /** Load stored records and resume uploads that had not finished. */
  async boot(): Promise<void> {
    await this.deps.store.load()
    for (const record of this.deps.store.all()) {
      if (record.uploadedRevision < record.revision && record.blocked !== true) this.schedule(record.id)
    }
    await this.reconcile()
  }

  /** Stop retry waits; uploads already running finish. */
  shutdown(): void {
    this.stop.abort()
  }

  /**
   * Start tracking one accepted request with `logId`; a replayed request keeps its record.
   * @param request - the validated request.
   * @param key - its `Idempotency-Key`.
   */
  async track(request: AnalyzeRequest & { readonly logId: string }, key: string): Promise<void> {
    const id = reportIdOf(key)
    if (this.deps.store.get(id) === undefined) {
      await this.deps.store.put({
        id, key, logId: request.logId, app: request.app, errorCode: request.errorCode, triggeredAt: request.triggeredAt,
        acceptedAt: this.now(), sections: [], turns: {}, snapshot: {}, warnings: [], revision: 0, uploadedRevision: 0,
      })
    }
    await this.reconcileOne(id)
  }

  /**
   * Check every report still waiting for its first turn against the launch
   * state: called at boot and whenever `feishuTopics` appears.
   */
  async reconcile(): Promise<void> {
    for (const record of this.deps.store.all()) {
      if (!record.sections.some(section => section.kind === 'analysis')) await this.reconcileOne(record.id)
    }
  }

  private async reconcileOne(id: string): Promise<void> {
    const record = this.deps.store.get(id)
    const state = record === undefined ? undefined : this.deps.topics()?.state(record.key)
    if (state === undefined) return
    if (state.status === 'running') {
      if (state.workDir !== undefined && record?.workDir !== state.workDir) await this.mutate(id, current => ({ ...current, workDir: state.workDir }))
      return
    }
    // A settled first turn without a recorded section ended while this
    // plugin was not listening; failures and interruptions carry their own reason.
    const reason = state.status === 'failed' ? state.reason : state.status === 'interrupted' ? INTERRUPTED_REASON : MISSED_REASON
    await this.addAnalysis(id, state, reason)
  }

  /**
   * React to dsh-channels' `feishu-topics/status` event: a launch that failed
   * to start or was interrupted gets an analysis section explaining why.
   * Settled first turns are recorded from their `turn/end`.
   * @param state - the new launch state.
   */
  statusChanged(state: TopicLaunchState): void {
    const id = reportIdOf(state.key)
    if (this.deps.store.get(id) === undefined) return
    if (state.status !== 'failed' && state.status !== 'interrupted') return
    void this.addAnalysis(id, state, state.status === 'failed' ? state.reason : INTERRUPTED_REASON)
  }

  private async addAnalysis(id: string, state: TopicLaunchState, reason: string | undefined): Promise<void> {
    let changed = false
    await this.mutate(id, (record) => {
      if (record.sections.some(section => section.kind === 'analysis')) return undefined
      const status: ReportStatus = state.status === 'running' ? 'done' : state.status
      changed = true
      return {
        ...record,
        ...state.workDir === undefined ? {} : { workDir: state.workDir },
        sections: [{ kind: 'analysis', status, ...reason === undefined ? {} : { reason }, reply: '', files: [], at: this.now() }, ...record.sections],
        revision: record.revision + 1,
        blocked: false,
      }
    })
    if (changed) this.schedule(id)
  }

  /**
   * Feed one appended Session event (`session/event`). Only top-level
   * Sessions whose topic is a tracked launch are recorded.
   * @param session - the Session's header.
   * @param event - the appended event.
   */
  sessionEvent(session: { readonly header: SessionHeader }, event: SessionEventEnvelope): void {
    const { header } = session
    if ((header.delegationDepth ?? 0) > 0) return
    switch (event.type) {
      case 'turn/start':
        this.buffers.set(header.id, { questions: [], reply: '' })
        return
      case 'user/message': {
        const message = event.data as { readonly content?: unknown; readonly source?: { readonly kind?: string } } | undefined
        if (message?.source?.kind !== 'user') return
        const text = textOf(message.content)
        if (text !== '') this.bufferOf(header.id).questions.push(text)
        return
      }
      case 'assistant/message': {
        const data = event.data as { readonly message?: { readonly content?: unknown } } | undefined
        const text = textOf(data?.message?.content).trim()
        if (text !== '') this.bufferOf(header.id).reply = text
        return
      }
      case 'turn/end': {
        const buffer = this.buffers.get(header.id) ?? { questions: [], reply: '' }
        this.buffers.delete(header.id)
        void this.turnEnded(header.id, event.data as TurnEndData, buffer).catch((error: unknown) => {
          this.deps.warn(`logalyze: 记录分析轮次失败：${error instanceof Error ? error.message : String(error)}`)
        })
        return
      }
      // Other Session events carry nothing the report records.
      default:
        return
    }
  }

  private bufferOf(sessionId: string): TurnBuffer {
    let buffer = this.buffers.get(sessionId)
    if (buffer === undefined) {
      buffer = { questions: [], reply: '' }
      this.buffers.set(sessionId, buffer)
    }
    return buffer
  }

  private async turnEnded(sessionId: string, data: TurnEndData, buffer: TurnBuffer): Promise<void> {
    const topics = this.deps.topics()
    const key = topics?.launchKeyOf(sessionId)
    if (topics === undefined || key === undefined) return
    const id = reportIdOf(key)
    if (this.deps.store.get(id) === undefined) return
    let changed = false
    await this.mutate(id, async (record) => {
      if ((record.turns[sessionId] ?? 0) >= data.turn) return undefined
      const turns = { ...record.turns, [sessionId]: data.turn }
      const hasAnalysis = record.sections.some(section => section.kind === 'analysis')
      const question = questionOf(buffer.questions)
      // A turn with neither input nor reply (the closer DSH appends when it
      // resumes an interrupted turn) adds no section.
      if (hasAnalysis && question === '' && buffer.reply === '') return { ...record, turns }
      const workDir = topics.state(key)?.workDir ?? record.workDir
      const listing = await this.listing(this.dirOf({ ...record, ...workDir === undefined ? {} : { workDir } }))
      const rewritten = rewriteReply(buffer.reply, path => listing.files[path] !== undefined)
      const files = changedFiles(record.snapshot, listing.files).filter(file => !rewritten.linked.has(file))
      const status = statusOfTurnEnd(data.reason.kind)
      const reason = data.reason.kind === 'error' ? data.reason.error?.message : status === 'interrupted' ? INTERRUPTED_REASON : undefined
      const section: ReportSection = {
        kind: hasAnalysis ? 'followup' : 'analysis',
        status,
        ...reason === undefined ? {} : { reason },
        ...hasAnalysis ? { question } : {},
        reply: rewritten.text,
        files,
        at: this.now(),
      }
      changed = true
      return {
        ...record,
        ...workDir === undefined ? {} : { workDir },
        turns,
        snapshot: { ...listing.files },
        sections: [...record.sections, section],
        warnings: unique([...record.warnings, ...rewritten.warnings]),
        revision: record.revision + 1,
        blocked: false,
      }
    })
    if (changed) this.schedule(id)
  }

  private async listing(dir: string): Promise<ReportListing> {
    try {
      return await listReport(dir)
    } catch (error) {
      this.deps.warn(`logalyze: 读取报告目录 ${dir} 失败：${error instanceof Error ? error.message : String(error)}`)
      return { files: {}, count: 0, bytes: 0, refused: [] }
    }
  }

  /**
   * Upload one report now, whether or not its last upload succeeded.
   * @param id - report id.
   * @returns false when no such report exists.
   */
  retry(id: string): boolean {
    if (this.deps.store.get(id) === undefined) return false
    this.schedule(id, true)
    return true
  }

  /** @returns the most recently accepted reports, newest first. */
  list(): ReportWire[] {
    return this.deps.store.all()
      .sort((left, right) => right.acceptedAt - left.acceptedAt)
      .slice(0, MAX_LISTED_REPORTS)
      .map(record => this.wire(record))
  }

  private wire(record: ReportRecord): ReportWire {
    const analysis = record.sections.find(section => section.kind === 'analysis')
    return {
      id: record.id,
      logId: record.logId,
      app: record.app,
      errorCode: record.errorCode,
      triggeredAt: record.triggeredAt,
      acceptedAt: record.acceptedAt,
      ...analysis === undefined ? {} : { status: analysis.status },
      followups: record.sections.filter(section => section.kind === 'followup').length,
      ...record.workDir === undefined && analysis === undefined ? {} : { dir: this.dirOf(record) },
      phase: this.phaseOf(record),
      ...record.lastAttemptAt === undefined ? {} : { lastAttemptAt: record.lastAttemptAt },
      ...record.uploadedAt === undefined ? {} : { uploadedAt: record.uploadedAt },
      ...record.error === undefined ? {} : { error: record.error },
      warnings: record.warnings,
    }
  }

  private phaseOf(record: ReportRecord): UploadPhase {
    if (this.running.has(record.id)) return 'running'
    if (this.waiting.has(record.id)) return 'waiting'
    if (record.revision > 0 && record.uploadedRevision >= record.revision) return 'done'
    if (record.error !== undefined && !this.workers.has(record.id)) return 'failed'
    return 'pending'
  }

  /** Report directory: below the topic's working directory, or below the store for a launch that never got one. */
  private dirOf(record: Pick<ReportRecord, 'id' | 'workDir'>): string {
    return record.workDir === undefined ? join(this.deps.store.dir, record.id, REPORT_DIR) : join(record.workDir, REPORT_DIR)
  }

  /** Apply one read-modify-write to a record, serialized per record; `undefined` keeps it unchanged. */
  private async mutate(id: string, change: (record: ReportRecord) => ReportRecord | undefined | Promise<ReportRecord | undefined>): Promise<void> {
    const previous = this.locks.get(id) ?? Promise.resolve()
    const next = previous.then(async () => {
      const record = this.deps.store.get(id)
      if (record === undefined) return
      const updated = await change(record)
      if (updated !== undefined) await this.deps.store.put(updated)
    })
    const settled = next.catch((error: unknown) => {
      this.deps.warn(`logalyze: 更新回传记录失败：${error instanceof Error ? error.message : String(error)}`)
    })
    this.locks.set(id, settled)
    await settled
    if (this.locks.get(id) === settled) this.locks.delete(id)
  }

  private schedule(id: string, force = false): void {
    if (force) this.forced.add(id)
    if (this.workers.has(id)) return
    const work = this.work(id).catch((error: unknown) => {
      this.deps.warn(`logalyze: 上传报告失败：${error instanceof Error ? error.message : String(error)}`)
    }).finally(() => { this.workers.delete(id) })
    this.workers.set(id, work)
  }

  /** Upload until the stored revision is covered, retrying failed runs with backoff. */
  private async work(id: string): Promise<void> {
    let failures = 0
    while (!this.stop.signal.aborted) {
      const record = this.deps.store.get(id)
      if (record === undefined) return
      const forced = this.forced.delete(id)
      if (!forced && (record.uploadedRevision >= record.revision || record.blocked === true)) return
      this.running.add(id)
      let outcome: UploadOutcome
      try {
        outcome = await this.uploadOnce(record)
      } finally {
        this.running.delete(id)
      }
      const at = this.now()
      await this.mutate(id, current => outcome.ok
        ? { ...current, uploadedRevision: Math.max(current.uploadedRevision, record.revision), uploadedAt: at, lastAttemptAt: at, error: undefined, blocked: false }
        : { ...current, lastAttemptAt: at, error: outcome.error, blocked: !outcome.retryable })
      if (outcome.ok) {
        failures = 0
        continue
      }
      if (!outcome.retryable) return
      failures += 1
      const settings = this.deps.upload()
      if (failures > settings.retries) return
      this.waiting.add(id)
      try {
        await this.sleep(settings.retryDelayMs * 2 ** (failures - 1))
      } finally {
        this.waiting.delete(id)
      }
    }
  }

  private async sleep(ms: number): Promise<void> {
    const signal = this.stop.signal
    if (signal.aborted) return
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, Math.min(ms, 2_147_483_647))
      function done(): void {
        clearTimeout(timer)
        signal.removeEventListener('abort', done)
        resolve()
      }
      signal.addEventListener('abort', done, { once: true })
    })
  }

  /** Write `report.md`, check the directory, and run the upload command once. */
  private async uploadOnce(record: ReportRecord): Promise<UploadOutcome> {
    const settings = this.deps.upload()
    const dir = this.dirOf(record)
    try {
      await mkdir(dir, { recursive: true })
      if (!(await lstat(dir)).isDirectory()) return { ok: false, retryable: false, error: `报告目录 ${dir} 不是普通目录（可能是符号链接），没有上传` }
      const entry = join(dir, REPORT_ENTRY)
      // The directory is agent-writable: create the temporary file exclusively
      // under a fresh name, so an existing entry (a symbolic link included) is never followed.
      const temporary = join(dir, `.${REPORT_ENTRY}.${randomUUID()}.tmp`)
      await writeFile(temporary, renderReport(record, record.sections), { encoding: 'utf8', flag: 'wx' })
      // Renaming replaces whatever the agent left under the entry name, a symbolic link included.
      await rename(temporary, entry)
      const listing = await listReport(dir)
      if (listing.refused.length > 0) return { ok: false, retryable: false, error: `报告目录里有符号链接或特殊文件，没有上传：${listing.refused.slice(0, 5).join('、')}` }
      if (listing.count > settings.maxFiles) return { ok: false, retryable: false, error: `报告目录有 ${listing.count} 个文件，超过上限 ${settings.maxFiles}，没有上传` }
      if (listing.bytes > settings.maxBytes) return { ok: false, retryable: false, error: `报告目录共 ${listing.bytes} 字节，超过上限 ${settings.maxBytes}，没有上传` }
    } catch (error) {
      return { ok: false, retryable: true, error: `准备报告目录失败：${error instanceof Error ? error.message : String(error)}` }
    }
    const result = await this.run(uploadArgv(settings.command, { logId: record.logId, dir }), { timeoutMs: settings.timeoutMs, cwd: dir })
    return result.ok ? { ok: true } : { ok: false, retryable: true, error: result.error }
  }
}
