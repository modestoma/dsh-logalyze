/**
 * 回传记录的持久化：每份报告一个 JSON 文件
 * `$DSH_HOME/logalyze/reports/<id>.json`，写入先落临时文件再改名；读到的
 * 内容按 {@link reportRecordSchema} 校验，不合格的文件记日志后跳过。
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

/** One tracked report. */
export const reportRecordSchema = z.object({
  /** Stable id: SHA-256 prefix of {@link key}; also the file name. */
  id: z.string().regex(/^[0-9a-f]{24}$/u),
  /** The request's `Idempotency-Key` (the `feishuTopics` launch key). */
  key: z.string().min(1),
  logId: z.string().min(1),
  app: z.string().min(1),
  errorCode: z.string().min(1),
  triggeredAt: z.string().min(1),
  acceptedAt: z.number(),
  /** Topic working directory once known. */
  workDir: z.string().optional(),
  sections: z.array(sectionSchema),
  /** Last turn number recorded per Session id. */
  turns: z.record(z.string(), z.number()),
  /** File fingerprints of the report directory at the last recorded turn. */
  snapshot: z.record(z.string(), z.string()),
  /** Links of the recorded replies the caller cannot open. */
  warnings: z.array(z.string()),
  /** Incremented on every content change; an upload covers the revision it started from. */
  revision: z.number().int().nonnegative(),
  uploadedRevision: z.number().int().nonnegative(),
  lastAttemptAt: z.number().optional(),
  uploadedAt: z.number().optional(),
  error: z.string().optional(),
  /** Whether the last attempt failed and retrying cannot help until the content changes. */
  blocked: z.boolean().optional(),
}).strict()

/** One tracked report. */
export type ReportRecord = z.infer<typeof reportRecordSchema>

/** Most records kept; the least recently active are dropped first. */
export const MAX_REPORT_RECORDS = 200

/** Records with no activity for this long are dropped: 30 days. */
export const REPORT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

/**
 * When a record last changed: its acceptance or its latest recorded turn.
 * @param record - the record.
 * @returns epoch milliseconds.
 */
export function lastActivityOf(record: ReportRecord): number {
  return Math.max(record.acceptedAt, ...record.sections.map(section => section.at))
}

/**
 * Report id of one request.
 * @param key - the request's `Idempotency-Key`.
 * @returns 24 hex characters.
 */
export function reportIdOf(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 24)
}

/**
 * Default report store directory.
 * @param env - process environment.
 * @returns `$DSH_HOME/logalyze/reports`.
 */
export function defaultReportsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveDshHome(env), 'logalyze', 'reports')
}

/** Reads and writes the report records of one directory. */
export class ReportStore {
  private readonly records = new Map<string, ReportRecord>()

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
        const record = reportRecordSchema.parse(JSON.parse(await readFile(path, 'utf8')))
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
  get(id: string): ReportRecord | undefined {
    return this.records.get(id)
  }

  /** @returns every record. */
  all(): ReportRecord[] {
    return [...this.records.values()]
  }

  /**
   * Replace one record in memory and on disk.
   * @param record - the record to store.
   */
  async put(record: ReportRecord): Promise<void> {
    this.records.set(record.id, record)
    await mkdir(this.dir, { recursive: true })
    await replaceFile(join(this.dir, `${record.id}.json`), `${JSON.stringify(record)}\n`, 0o600)
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
