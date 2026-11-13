/**
 * 监管运行时存储适配层：优先使用 DSH 宿主提供的 `ctx.storageDomain`（`'dsh_supervisor'`），
 * 在宿主未注入该能力或单测独立运行时自动回退到本地原子 JSON 文件或内存表实现。
 *
 * 运行时不直接依赖 `@deepseek-ai/dsh-storage-domain` 包，结构契约与其完全对齐。
 *
 * @module dsh-logalyze/runtime/storage
 */

import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { z } from 'zod'
import { replaceFile } from '../util/files.ts'
import { messageOf } from '../util/errors.ts'

const TABLE_NAME_PATTERN = /^[a-z][a-z0-9_]*$/
const DOMAIN_NAME_PATTERN = /^[a-z][a-z0-9_-]*$/

/** One table schema declaration in a storage domain spec. */
export interface DomainTableSpec<S extends z.ZodType = z.ZodType> {
  readonly valueSchema: S
}

/** Declarative specification of a plugin storage domain. */
export interface DomainSpec<Tables extends Record<string, DomainTableSpec> = Record<string, DomainTableSpec>> {
  readonly name: string
  readonly version: number
  readonly tables: Tables
}

/** Untyped key-value table handle returned by a domain handle. */
export interface RawTable {
  readonly size: number
  get(key: string): unknown
  entries(): [string, unknown][]
  keys(): string[]
  put(key: string, value: unknown): Promise<void>
  update(key: string, fn: (current: unknown) => unknown): Promise<unknown>
  delete(key: string): Promise<boolean>
}

/** Open storage domain handle owning its declared tables. */
export interface RawDomainHandle {
  table(name: string): RawTable
  close(): Promise<void>
}

/**
 * Host `ctx.storageDomain` surface. Supports DSH's `{ open(spec) }` facility as
 * well as a direct factory function `(nameOrSpec) => handle` for lightweight mocks.
 */
export type StorageDomainFacility =
  | { open(spec: DomainSpec): Promise<RawDomainHandle> }
  | ((nameOrSpec: string | DomainSpec) => RawDomainHandle | Promise<RawDomainHandle>)

/** Strongly typed view over one {@link RawTable}. */
export interface DomainTable<V> {
  readonly size: number
  has(key: string): boolean
  get(key: string): V | undefined
  entries(): [string, V][]
  values(): V[]
  keys(): string[]
  put(key: string, value: V): Promise<void>
  update(key: string, fn: (current: V) => V): Promise<V>
  delete(key: string): Promise<boolean>
}

/** Error raised when `table.update` addresses a missing key or a closed handle. */
export class StorageDomainError extends Error {
  readonly code: 'missing-key' | 'closed' | 'invalid-spec' | 'unknown-table' | 'corrupt-store'

  constructor(code: StorageDomainError['code'], message: string) {
    super(message)
    this.name = 'StorageDomainError'
    this.code = code
  }
}

function cloneValue<T>(value: T): T {
  return structuredClone(value)
}

/**
 * Wrap a {@link RawTable} with compile-time value types.
 * @param raw - underlying table handle.
 * @returns typed table view.
 */
export function typedTable<V>(raw: RawTable): DomainTable<V> {
  return {
    get size() { return raw.size },
    has: key => raw.get(key) !== undefined,
    get: key => raw.get(key) as V | undefined,
    entries: () => raw.entries() as [string, V][],
    values: () => raw.entries().map(([, value]) => value as V),
    keys: () => raw.keys(),
    put: (key, value) => raw.put(key, value),
    update: (key, fn) => raw.update(key, current => fn(current as V)) as Promise<V>,
    delete: key => raw.delete(key),
  }
}

function validateSpec(spec: DomainSpec): void {
  if (!DOMAIN_NAME_PATTERN.test(spec.name)) {
    throw new StorageDomainError('invalid-spec', `非法的存储域名 "${spec.name}"`)
  }
  if (!Number.isInteger(spec.version) || spec.version < 1) {
    throw new StorageDomainError('invalid-spec', `存储域 "${spec.name}" 的版本号必须是正整数`)
  }
  const names = Object.keys(spec.tables)
  if (names.length === 0) {
    throw new StorageDomainError('invalid-spec', `存储域 "${spec.name}" 至少需要声明一张表`)
  }
  for (const name of names) {
    if (!TABLE_NAME_PATTERN.test(name)) {
      throw new StorageDomainError('invalid-spec', `存储域 "${spec.name}" 的表名 "${name}" 不合法`)
    }
  }
}

interface FallbackPersistHook {
  (snapshot: Record<string, Record<string, unknown>>): Promise<void>
}

function buildLocalDomainHandle(
  spec: DomainSpec,
  initial: Record<string, Record<string, unknown>>,
  persist?: FallbackPersistHook,
): RawDomainHandle {
  const stores = new Map<string, Map<string, unknown>>()
  for (const [tableName, tableSpec] of Object.entries(spec.tables)) {
    const rows = new Map<string, unknown>()
    const rawRows = initial[tableName] ?? {}
    for (const [key, rawValue] of Object.entries(rawRows)) {
      rows.set(key, cloneValue(tableSpec.valueSchema.parse(rawValue)))
    }
    stores.set(tableName, rows)
  }

  let closed = false
  let queue: Promise<void> = Promise.resolve()

  const snapshotAll = (): Record<string, Record<string, unknown>> => {
    const out: Record<string, Record<string, unknown>> = {}
    for (const [tableName, rows] of stores.entries()) {
      const tableObj: Record<string, unknown> = {}
      for (const [key, value] of rows.entries()) {
        tableObj[key] = cloneValue(value)
      }
      out[tableName] = tableObj
    }
    return out
  }

  const enqueueMutation = <T>(mutate: () => T): Promise<T> => {
    if (closed) {
      return Promise.reject(new StorageDomainError('closed', `存储域 "${spec.name}" 已关闭`))
    }
    const run = queue.then(async () => {
      if (closed) {
        throw new StorageDomainError('closed', `存储域 "${spec.name}" 已关闭`)
      }
      const previous = persist === undefined ? undefined : snapshotAll()
      const result = mutate()
      if (persist !== undefined) {
        try {
          await persist(snapshotAll())
        } catch (error) {
          // Roll back in-memory state if durable flush fails.
          if (previous !== undefined) {
            for (const [tableName, tableObj] of Object.entries(previous)) {
              stores.set(tableName, new Map(Object.entries(tableObj)))
            }
          }
          throw error
        }
      }
      return result
    })
    queue = run.then(() => undefined, () => undefined)
    return run
  }

  const handles = new Map<string, RawTable>()
  for (const [tableName, tableSpec] of Object.entries(spec.tables)) {
    const getRows = (): Map<string, unknown> => stores.get(tableName)!
    handles.set(tableName, {
      get size() {
        return getRows().size
      },
      get(key: string): unknown {
        const value = getRows().get(key)
        return value === undefined ? undefined : cloneValue(value)
      },
      entries(): [string, unknown][] {
        return [...getRows().entries()].map(([key, value]) => [key, cloneValue(value)])
      },
      keys(): string[] {
        return [...getRows().keys()]
      },
      async put(key: string, value: unknown): Promise<void> {
        if (key === '') throw new TypeError(`表 "${tableName}" 的主键不能为空字符串`)
        const parsed = cloneValue(tableSpec.valueSchema.parse(value))
        await enqueueMutation(() => {
          getRows().set(key, parsed)
        })
      },
      async update(key: string, fn: (current: unknown) => unknown): Promise<unknown> {
        if (key === '') throw new TypeError(`表 "${tableName}" 的主键不能为空字符串`)
        return await enqueueMutation(() => {
          const rows = getRows()
          if (!rows.has(key)) {
            throw new StorageDomainError('missing-key', `表 "${tableName}" 中不存在主键 "${key}"`)
          }
          const current = cloneValue(rows.get(key))
          const next = cloneValue(tableSpec.valueSchema.parse(fn(current)))
          rows.set(key, next)
          return cloneValue(next)
        })
      },
      async delete(key: string): Promise<boolean> {
        return await enqueueMutation(() => getRows().delete(key))
      },
    })
  }

  return {
    table(name: string): RawTable {
      const table = handles.get(name)
      if (table === undefined) {
        throw new StorageDomainError('unknown-table', `存储域 "${spec.name}" 未声明表 "${name}"`)
      }
      return table
    },
    async close(): Promise<void> {
      const inflight = queue
      closed = true
      await inflight
    },
  }
}

/**
 * Create an isolated in-memory {@link StorageDomainFacility} with full Zod schema
 * validation and atomic mutation semantics.
 */
export function createMemoryStorageFacility(): { open(spec: DomainSpec): Promise<RawDomainHandle> } {
  const domains = new Map<string, Record<string, Record<string, unknown>>>()
  return {
    open(spec: DomainSpec): Promise<RawDomainHandle> {
      validateSpec(spec)
      const initial = domains.get(spec.name) ?? {}
      const handle = buildLocalDomainHandle(spec, initial, (snapshot) => {
        domains.set(spec.name, snapshot)
        return Promise.resolve()
      })
      if (!domains.has(spec.name)) {
        domains.set(spec.name, {})
      }
      return Promise.resolve(handle)
    },
  }
}

interface PersistedDomainDocument {
  readonly version: number
  readonly tables: Record<string, Record<string, unknown>>
}

/**
 * Create a durable local JSON-file {@link StorageDomainFacility}. Each domain is
 * stored under `<dir>/<domainName>.json` via atomic temp-file rename (`0600`).
 * @param dir - directory holding fallback domain files.
 */
export function createFileStorageFacility(dir: string): { open(spec: DomainSpec): Promise<RawDomainHandle> } {
  return {
    async open(spec: DomainSpec): Promise<RawDomainHandle> {
      validateSpec(spec)
      const filePath = join(dir, `${spec.name}.json`)
      let initial: Record<string, Record<string, unknown>> = {}
      try {
        const rawText = await readFile(filePath, 'utf8')
        const parsed = JSON.parse(rawText) as Partial<PersistedDomainDocument>
        if (typeof parsed !== 'object' || parsed === null || typeof parsed.tables !== 'object' || parsed.tables === null) {
          throw new StorageDomainError('corrupt-store', `${filePath} 结构不合法`)
        }
        initial = parsed.tables
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          if (error instanceof StorageDomainError) throw error
          throw new StorageDomainError('corrupt-store', `无法读取存储域文件 ${filePath}：${messageOf(error)}`)
        }
      }

      const persist: FallbackPersistHook = async (snapshot) => {
        await mkdir(dirname(filePath), { recursive: true })
        const payload: PersistedDomainDocument = { version: spec.version, tables: snapshot }
        await replaceFile(filePath, `${JSON.stringify(payload, undefined, 2)}\n`, 0o600)
      }

      return buildLocalDomainHandle(spec, initial, persist)
    },
  }
}

/** Context slice optionally carrying `storageDomain`. */
export interface StorageHostLike {
  readonly storageDomain?: unknown
  get?(name: string): unknown
}

/** Options for opening a storage domain with automatic fallback. */
export interface OpenStorageDomainOptions {
  /** Host context that may expose `ctx.storageDomain` or `ctx.get('storageDomain')`. */
  readonly ctx?: StorageHostLike
  /** Explicit facility override (takes precedence over `ctx`). */
  readonly facility?: StorageDomainFacility
  /** Directory used for local JSON persistence when host `storageDomain` is absent; omitted uses memory. */
  readonly fallbackDir?: string
}

function isStorageFacility(candidate: unknown): candidate is StorageDomainFacility {
  if (typeof candidate === 'function') return true
  return typeof candidate === 'object'
    && candidate !== null
    && typeof (candidate as { open?: unknown }).open === 'function'
}

/**
 * Open a storage domain via host `ctx.storageDomain` when available, otherwise
 * fall back to local file or in-memory storage.
 */
export async function openStorageDomain(spec: DomainSpec, options: OpenStorageDomainOptions = {}): Promise<RawDomainHandle> {
  validateSpec(spec)
  const hostCandidate = options.facility ?? options.ctx?.storageDomain ?? options.ctx?.get?.('storageDomain')
  if (isStorageFacility(hostCandidate)) {
    if (typeof hostCandidate === 'function') {
      // Support both `ctx.storageDomain('dsh_supervisor')` and `ctx.storageDomain(spec)`.
      try {
        const handle = await hostCandidate(spec.name)
        if (handle !== undefined && typeof (handle as { table?: unknown }).table === 'function') {
          return handle
        }
      } catch (error) {
        if (!(error instanceof StorageDomainError && error.code === 'invalid-spec')) {
          throw error
        }
      }
      return await hostCandidate(spec)
    }
    return await hostCandidate.open(spec)
  }
  const fallback = options.fallbackDir !== undefined
    ? createFileStorageFacility(options.fallbackDir)
    : createMemoryStorageFacility()
  return await fallback.open(spec)
}
