/**
 * 旧版回传命令留下的报告记录（`$DSH_HOME/logalyze/reports/<id>.json`）：
 * 只读出面板展示需要的字段，不再上传；最近活动超过
 * {@link REPORT_RETENTION_MS} 的记录在加载时删除。
 *
 * @module dsh-logalyze/report/legacy
 */

import { readdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { resolveDshHome } from '../config.ts'
import type { LegacyReportWire } from '../settings/contract.ts'
import { REPORT_RETENTION_MS } from './store.ts'

const legacySchema = z.object({
  id: z.string().regex(/^[0-9a-f]{24}$/u),
  logId: z.string(),
  app: z.string(),
  errorCode: z.string(),
  triggeredAt: z.string(),
  acceptedAt: z.number(),
  sections: z.array(z.object({ at: z.number() })).default([]),
  uploadedAt: z.number().optional(),
  error: z.string().optional(),
})

/**
 * Directory of the former report records.
 * @param env - process environment.
 * @returns `$DSH_HOME/logalyze/reports`.
 */
export function legacyReportsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveDshHome(env), 'logalyze', 'reports')
}

/** Reports of the former command upload, shown until they expire. */
export class LegacyReports {
  private records: LegacyReportWire[] = []

  /**
   * @param dir - absolute directory of the former records.
   * @param warn - receives files that cannot be read or removed.
   */
  constructor(private readonly dir: string, private readonly warn: (message: string) => void) {}

  /**
   * Read the records, deleting the expired ones with their store-local report directories.
   * @param now - epoch milliseconds.
   */
  async load(now: number): Promise<void> {
    let names: string[]
    try {
      names = await readdir(this.dir)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    const kept: LegacyReportWire[] = []
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const path = join(this.dir, name)
      try {
        const record = legacySchema.parse(JSON.parse(await readFile(path, 'utf8')))
        const activity = Math.max(record.acceptedAt, ...record.sections.map(section => section.at))
        if (now - activity > REPORT_RETENTION_MS) {
          await rm(path, { force: true })
          await rm(join(this.dir, record.id), { recursive: true, force: true })
          continue
        }
        const { sections: _sections, ...wire } = record
        kept.push(wire)
      } catch (error) {
        this.warn(`logalyze: 跳过无法读取的旧版回传记录 ${path}：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    this.records = kept.sort((left, right) => right.acceptedAt - left.acceptedAt)
  }

  /** @returns the kept records, newest first. */
  list(): LegacyReportWire[] {
    return this.records
  }
}
