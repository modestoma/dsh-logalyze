/**
 * 分析记录的持久化：每次分析一个 JSON 文件
 * `$DSH_HOME/logalyze/analyses/<id>.json`，写入先落临时文件再改名；读到的
 * 内容按 {@link analysisRecordSchema} 校验，不合格的文件记日志后跳过。
 *
 * 保留最近活动（接受请求或记录一轮）在 {@link REPORT_RETENTION_MS} 之内的记录，
 * 最多 {@link MAX_REPORT_RECORDS} 份；清理时删除记录文件和存储目录下的报告目录
 * `<id>/`，话题工作目录里的报告目录归话题所有，不删除。
 *
 * @module dsh-logalyze/report/store
 */

import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { resolveDshHome } from '../config.ts'
import { replaceFile } from '../util/files.ts'

const STATUS = z.enum(['done', 'stopped', 'error', 'failed', 'interrupted'])

const sectionSchema = z.object({
  /** `analysis` is the first turn (or the failure that replaced it); later turns are `followup`. */
  kind: z.enum(['analysis', 'followup']),
  status: STATUS,
  /** Failure or interruption reason shown above the reply. */
  reason: z.string().optional(),
  /** The follow-up question (user messages of the turn); absent for `analysis`. */
  question: z.string().optional(),
  /** Final reply with links already relative to the report directory. */
  reply: z.string(),
  /** Files new or changed in the turn that the reply does not link, relative to the report directory. */
  files: z.array(z.string()),
  /** Epoch ms when the turn ended. */
  at: z.number(),
}).strict()

const nullableText = z.string().nullable()

/** One log of a tracked analysis, with its upload state. */
const analysisLogSchema = z.object({
  /** Log number in the prompt and the reports (`L1`, `L2`, …). */
  ref: z.string().min(1),
  /** Platform log id. */
  logId: z.string().min(1),
  fileName: z.string().min(1),
  productSn: nullableText,
  hwVersion: nullableText,
  swVersion: nullableText,
  componentVersion: nullableText,
  logType: nullableText,
  /** Declared file size in bytes, as the platform's decimal string. */
  sizeBytes: nullableText,
  createdAt: nullableText,
  /** The log's page on the platform. */
  detailUrl: z.string().optional(),
  /** The log's own conclusion (`report/logs/<ref>.md` at the latest turn), links already relative to the report directory. */
  conclusion: z.string().optional(),
  /** The log's analysis page, returned by its first completed revision; fixed per log. */
  reportUrl: z.string().optional(),
  /** Whether the root card links {@link reportUrl}. */
  linked: z.boolean().optional(),
  /** Latest record revision uploaded to this log. */
  uploadedRevision: z.number().int().nonnegative(),
  /** Incremented when the platform refuses an idempotency key reused with other files; part of the next key. */
  generation: z.number().int().nonnegative(),
  lastAttemptAt: z.number().optional(),
  uploadedAt: z.number().optional(),
  error: z.string().optional(),
  /** Whether the last attempt failed and retrying cannot help until the content changes. */
  blocked: z.boolean().optional(),
}).strict()

/** One tracked log of an analysis. */
export type AnalysisLog = z.infer<typeof analysisLogSchema>

/** One analysis started through the analyze API. */
export const analysisRecordSchema = z.object({
  /** Stable id: SHA-256 prefix of {@link key}; also the file name. */
  id: z.string().regex(/^[0-9a-f]{24}$/u),
  /** The request's `Idempotency-Key` (the `feishuTopics` launch key). */
  key: z.string().min(1),
  /** The request's fingerprint, compared when the key is used again. */
  fingerprint: z.string().min(1),
  triggerType: z.enum(['digital', 'machine']),
  triggerId: z.string().min(1),
  triggeredAt: z.string().min(1),
  chatId: z.string().min(1),
  instructions: z.string().optional(),
  /** Application id, display name, and project skill as resolved at acceptance. */
  app: z.string().min(1),
  appName: z.string().min(1),
  componentCode: z.string().min(1),
  /** The batch's error code; null when the platform has none. */
  errorCode: nullableText,
  logs: z.array(analysisLogSchema).min(1),
  acceptedAt: z.number(),
  /** Topic working directory once known. */
  workDir: z.string().optional(),
  sections: z.array(sectionSchema),
  /** Last turn number recorded per Session id. */
  turns: z.record(z.string(), z.number()),
  /** File fingerprints of the report directory at the last recorded turn. */
  snapshot: z.record(z.string(), z.string()),
  /** Links of the recorded replies and conclusions the caller cannot open. */
  warnings: z.array(z.string()),
  /** Files the last upload left out, with the reason. */
  skipped: z.array(z.string()),
  /** Incremented on every content change; an upload covers the revision it started from. */
  revision: z.number().int().nonnegative(),
}).strict()

/** One tracked analysis. */
export type AnalysisRecord = z.infer<typeof analysisRecordSchema>

/** Most records kept; the least recently active are dropped first. */
export const MAX_REPORT_RECORDS = 200

/** Records with no activity for this long are dropped: 30 days. */
export const REPORT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

/**
 * When a record last changed: its acceptance or its latest recorded turn.
 * @param record - the record.
 * @returns epoch milliseconds.
 */
export function lastActivityOf(record: Pick<AnalysisRecord, 'acceptedAt' | 'sections'>): number {
  return Math.max(record.acceptedAt, ...record.sections.map(section => section.at))
}

/**
 * Analysis id of one request.
 * @param key - the request's `Idempotency-Key`.
 * @returns 24 hex characters.
 */
export function analysisIdOf(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 24)
}

/**
 * Default analysis store directory.
 * @param env - process environment.
 * @returns `$DSH_HOME/logalyze/analyses`.
 */
export function defaultAnalysesDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveDshHome(env), 'logalyze', 'analyses')
}

/** Reads and writes the analysis records of one directory. */
export class AnalysisStore {
  private readonly records = new Map<string, AnalysisRecord>()

  /**
   * @param dir - absolute store directory.
   * @param warn - receives unreadable record files.
   */
  constructor(readonly dir: string, private readonly warn: (message: string) => void) {}

  /** Read every record file; a missing directory holds none. */
  async load(): Promise<void> {
    let names: string[]
    try {
      names = await readdir(this.dir)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const path = join(this.dir, name)
      try {
        const record = analysisRecordSchema.parse(JSON.parse(await readFile(path, 'utf8')))
        if (`${record.id}.json` === name && !this.records.has(record.id)) this.records.set(record.id, record)
      } catch (error) {
        this.warn(`logalyze: 跳过无法读取的回传记录 ${path}：${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  /**
   * @param id - report id.
   * @returns the record, or undefined.
   */
  get(id: string): AnalysisRecord | undefined {
    return this.records.get(id)
  }

  /** @returns every record. */
  all(): AnalysisRecord[] {
    return [...this.records.values()]
  }

  /**
   * Replace one record in memory and on disk.
   * @param record - the record to store.
   */
  async put(record: AnalysisRecord): Promise<void> {
    this.records.set(record.id, record)
    await mkdir(this.dir, { recursive: true })
    await replaceFile(join(this.dir, `${record.id}.json`), `${JSON.stringify(record)}\n`, 0o600)
  }

  /**
   * Forget one record and delete its file.
   * @param id - analysis id.
   */
  async remove(id: string): Promise<void> {
    this.records.delete(id)
    await rm(join(this.dir, `${id}.json`), { force: true })
  }

  /**
   * Drop the records past {@link REPORT_RETENTION_MS} of inactivity and the
   * least recently active beyond {@link MAX_REPORT_RECORDS}, with their files
   * and store-local report directories.
   * @param now - epoch milliseconds.
   * @param busy - whether a record is in use and must be kept this time.
   * @returns the dropped ids; a file that cannot be removed is reported to the warning sink and its record is still forgotten.
   */
  async prune(now: number, busy: (id: string) => boolean): Promise<string[]> {
    const ranked = this.all().sort((left, right) => lastActivityOf(right) - lastActivityOf(left))
    const dropped = ranked.filter((record, index) => !busy(record.id) && (index >= MAX_REPORT_RECORDS || now - lastActivityOf(record) > REPORT_RETENTION_MS)).map(record => record.id)
    for (const id of dropped) {
      this.records.delete(id)
      try {
        await rm(join(this.dir, `${id}.json`), { force: true })
        await rm(join(this.dir, id), { recursive: true, force: true })
      } catch (error) {
        this.warn(`logalyze: 删除过期回传记录 ${id} 失败：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return dropped
  }
}
