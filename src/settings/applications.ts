/**
 * 按目录 URL 索引的应用描述与触发别名存储；仓库成员与分支归属仍由 dsh-repo 管理。
 *
 * @module dsh-logalyze/settings/applications
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'
import { KEBAB_ID, MANIFEST_PATH } from '../apps/manifest.ts'
import type { RepoFileReader } from '../apps/manifest.ts'
import { messageOf } from '../util/errors.ts'
import { replaceFile } from '../util/files.ts'
import type { AppManifest, ApplicationMetadata } from './contract.ts'
import { SettingsError } from './controller.ts'

/** Trimmed, NFKC-normalized, case-insensitive key shared by Feishu names and platform component codes. */
export function applicationKey(value: string): string {
  return value.normalize('NFKC').trim().toLowerCase()
}

/** Only description and aliases are editable; identity is assigned or migrated once. */
export const applicationMetadataSchema = z.object({
  description: z.string().trim().max(8000),
  aliases: z.array(z.string().trim().min(1).max(256)).max(100),
}).strict().superRefine((value, ctx) => {
  const keys = value.aliases.map(applicationKey)
  if (keys.some(key => key === '')) ctx.addIssue({ code: 'custom', path: ['aliases'], message: '别名不能为空' })
  if (new Set(keys).size !== keys.length) ctx.addIssue({ code: 'custom', path: ['aliases'], message: '别名重复，请移除重复项（忽略大小写及全角差异）' })
})

const storedApp = z.object({
  id: z.string().regex(KEBAB_ID),
  name: z.string().trim().min(1),
  description: z.string(),
  aliases: z.array(z.string()),
  logHints: z.array(z.string()),
  // Kept for the existing improvement tool, never required for analysis.
  skill: z.string().regex(KEBAB_ID).optional(),
}).strict()

const documentSchema = z.object({
  version: z.literal(1),
  applications: z.record(z.string(), storedApp),
}).strict()

/** A legacy import failure is visible but never makes a readable code repository unusable. */
export interface ApplicationImport {
  app: AppManifest
  warning?: string
}

async function migrate(url: string, read: RepoFileReader): Promise<ApplicationImport> {
  const tail = url.replace(/\/$/u, '').split('/').at(-1)?.replace(/\.git$/u, '') || 'application'
  const app: AppManifest = {
    id: `app-${createHash('sha256').update(url).digest('hex').slice(0, 16)}`,
    name: tail,
    description: '',
    aliases: [],
    logHints: [],
  }
  let raw: unknown
  try {
    const text = await read(MANIFEST_PATH)
    if (text === undefined) return { app }
    raw = parseYaml(text)
  } catch (error) {
    return { app, warning: `旧应用配置未迁移：${messageOf(error)}。请在智能监管面板填写描述与别名；代码分析仍可用。` }
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { app, warning: '旧应用配置不是字段对象；请在智能监管面板填写描述与别名。' }
  }
  const fields = raw as Record<string, unknown>
  const text = (name: string): string | undefined => typeof fields[name] === 'string' ? fields[name].trim() || undefined : undefined
  const list = (name: string): string[] => Array.isArray(fields[name])
    ? [...new Map(
        fields[name]
          .filter((item): item is string => typeof item === 'string' && item.trim() !== '')
          .map(item => [applicationKey(item), item.trim()]),
      ).values()]
    : []
  const id = text('id')
  const skill = text('skill')
  return {
    app: {
      ...app,
      ...(id !== undefined && KEBAB_ID.test(id) ? { id } : {}),
      name: text('name') ?? app.name,
      description: text('description') ?? '',
      aliases: list('aliases'),
      logHints: list('logHints'),
      ...(skill !== undefined && KEBAB_ID.test(skill) ? { skill } : {}),
    },
  }
}

/** Serial, atomic metadata storage. An omitted path gives an isolated in-memory store for embedding/tests. */
export class ApplicationSettings {
  private records: Record<string, AppManifest> | undefined
  private pending: Promise<unknown> = Promise.resolve()

  /** @param path - `applications.json` beside the panel overlay, or omitted for in-memory use. */
  constructor(private readonly path?: string) {}

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.pending.then(operation)
    this.pending = next.catch((_error: unknown) => { /* The caller receives the failure; the write queue continues. */ })
    return next
  }

  private async read(): Promise<Record<string, AppManifest>> {
    if (this.records !== undefined) return this.records
    if (this.path === undefined) return this.records = {}
    let text: string
    try {
      text = await readFile(this.path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return this.records = {}
      throw new SettingsError(`应用设置无法读取：${messageOf(error)}`)
    }
    try {
      return this.records = documentSchema.parse(JSON.parse(text)).applications
    } catch (error) {
      throw new SettingsError(`应用设置不合法，未覆盖原文件：${messageOf(error)}`)
    }
  }

  private async write(records: Record<string, AppManifest>): Promise<void> {
    if (this.path !== undefined) {
      await mkdir(dirname(this.path), { recursive: true })
      await replaceFile(this.path, `${JSON.stringify({ version: 1, applications: records }, undefined, 2)}\n`, 0o600)
    }
    this.records = records
  }

  /** Last durably published metadata; sync publication must not overwrite it with an older read. */
  current(url: string): AppManifest | undefined {
    return this.records !== undefined && Object.hasOwn(this.records, url) ? this.records[url] : undefined
  }

  /** Import usable legacy metadata once; never modify repository files. */
  ensure(url: string, read: RepoFileReader): Promise<ApplicationImport> {
    return this.serialize(async () => {
      const records = await this.read()
      if (Object.hasOwn(records, url)) return { app: records[url]! }
      const imported = await migrate(url, read)
      if (imported.warning === undefined) await this.write({ ...records, [url]: imported.app })
      return imported
    })
  }

  /** Save metadata for an already imported catalog repository. */
  save(url: string, metadata: ApplicationMetadata, fallback?: AppManifest): Promise<AppManifest> {
    return this.serialize(async () => {
      const records = await this.read()
      const app = Object.hasOwn(records, url) ? records[url] : fallback
      if (app === undefined) throw new SettingsError('仓库尚未读取，读取完成后再保存应用设置')
      const updated = { ...app, ...metadata }
      await this.write({ ...records, [url]: updated })
      return updated
    })
  }
}
