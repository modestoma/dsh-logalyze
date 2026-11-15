/**
 * 从旧包名 `dsh-logalyze`（`$DSH_HOME/logalyze`）迁移本地持久化数据到
 * `dsh-supervisor`（`$DSH_HOME/supervisor`），并兼容将本地回退存储域子目录
 * `supervisor/dsh_supervisor.json` 迁往 `domain/dsh_supervisor.json`。
 *
 * 迁移按条目幂等移动、不覆盖目标目录中已存在的新文件，避免升级后面板设置、
 * 应用描述与别名、待回传分析记录和本地回退状态被静默重置，也不因重启而
 * 重新复活已过期清理的旧记录。
 *
 * @module dsh-supervisor/settings/legacy-migration
 */

import { randomBytes } from 'node:crypto'
import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { resolveDshHome } from '../config.ts'
import { messageOf } from '../util/errors.ts'
import { kindOf } from '../util/files.ts'

/**
 * Default data directory for `dsh-supervisor`.
 * @param env - process environment.
 * @returns `$DSH_HOME/supervisor`.
 */
export function defaultSupervisorDataDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveDshHome(env), 'supervisor')
}

/**
 * Former default data directory from `dsh-logalyze`.
 * @param env - process environment.
 * @returns `$DSH_HOME/logalyze`.
 */
export function defaultLegacyDataDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveDshHome(env), 'logalyze')
}

/** Inputs controlling one-time startup migration of legacy persisted files. */
export interface MigrateLegacyDataOptions {
  /** Legacy `$DSH_HOME/logalyze` root when active; undefined disables root migration. */
  readonly legacyDataDir?: string
  /** Target panel overlay file (`$DSH_HOME/supervisor/settings.json`). */
  readonly overlayPath: string
  /** Target application metadata file (`$DSH_HOME/supervisor/applications.json`). */
  readonly applicationsPath: string
  /** Target fallback storage domain directory (`$DSH_HOME/supervisor/domain`). */
  readonly supervisorDir: string
  /** Former fallback storage domain directory beside `overlayPath` (`<dataDir>/supervisor`), when unoverridden. */
  readonly nestedLegacySupervisorDir?: string
  /** Target analysis store directory (`$DSH_HOME/supervisor/analyses`). */
  readonly analysesDir: string
  /** Target legacy report directory (`$DSH_HOME/supervisor/reports`). */
  readonly legacyReportsDir: string
  /** Warning sink when an individual legacy item cannot be migrated. */
  readonly warn: (message: string) => void
}

async function copyDirectoryContents(src: string, dest: string): Promise<void> {
  await mkdir(dest, { recursive: true, mode: 0o700 })
  const entries = await readdir(src)
  for (const name of entries) {
    const srcChild = join(src, name)
    const destChild = join(dest, name)
    const info = await lstat(srcChild)
    if (info.isSymbolicLink()) continue
    if (info.isDirectory()) {
      await copyDirectoryContents(srcChild, destChild)
    } else if (info.isFile()) {
      const bytes = await readFile(srcChild)
      await writeFile(destChild, bytes, { flag: 'wx', mode: 0o600 })
    }
  }
}

async function migrateRegularFile(src: string, dest: string, mode = 0o600): Promise<void> {
  if (resolve(src) === resolve(dest)) return
  if (await kindOf(dest) !== 'missing') return
  if (await kindOf(src) !== 'file') return
  await mkdir(dirname(dest), { recursive: true })
  try {
    await rename(src, dest)
    return
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
  }
  const bytes = await readFile(src)
  const temporary = join(dirname(dest), `.${basename(dest)}.${randomBytes(6).toString('hex')}.tmp`)
  try {
    await writeFile(temporary, bytes, { flag: 'wx', mode })
    if (await kindOf(dest) !== 'missing') {
      await rm(temporary, { force: true })
      return
    }
    await rename(temporary, dest)
    await rm(src, { force: true })
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}

async function migrateDirectory(srcDir: string, destDir: string): Promise<void> {
  if (resolve(srcDir) === resolve(destDir)) return
  if (await kindOf(destDir) !== 'missing') return
  if (await kindOf(srcDir) !== 'directory') return
  await mkdir(dirname(destDir), { recursive: true })
  try {
    await rename(srcDir, destDir)
    return
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
  }
  const stagingDir = join(dirname(destDir), `.${basename(destDir)}.${randomBytes(6).toString('hex')}.tmp`)
  try {
    await copyDirectoryContents(srcDir, stagingDir)
    if (await kindOf(destDir) !== 'missing') {
      await rm(stagingDir, { recursive: true, force: true })
      return
    }
    await rename(stagingDir, destDir)
    await rm(srcDir, { recursive: true, force: true })
  } catch (error) {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
}

async function readVisibleEntries(dir: string): Promise<string[]> {
  if (await kindOf(dir) !== 'directory') return []
  try {
    return (await readdir(dir)).filter(name => !name.startsWith('.'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

async function migrateDomainDirectory(srcDir: string, destDir: string, warn: (message: string) => void): Promise<void> {
  if (resolve(srcDir) === resolve(destDir)) return
  const entries = await readVisibleEntries(srcDir)
  for (const name of entries) {
    if (!name.endsWith('.json')) continue
    const src = join(srcDir, name)
    const dest = join(destDir, name)
    try {
      await migrateRegularFile(src, dest)
    } catch (error) {
      warn(`supervisor: 迁移旧版存储域文件 ${src} 失败：${messageOf(error)}`)
    }
  }
}

async function migrateRecordStore(srcRoot: string, destRoot: string, warn: (message: string) => void): Promise<void> {
  if (resolve(srcRoot) === resolve(destRoot)) return
  const entries = await readVisibleEntries(srcRoot)
  if (entries.length === 0) return

  // Move `<id>/` report artifact directories before `<id>.json` records so an interrupted run stays recoverable.
  for (const name of entries) {
    if (name.endsWith('.json')) continue
    const srcDir = join(srcRoot, name)
    const destDir = join(destRoot, name)
    const destRecord = join(destRoot, `${name}.json`)
    try {
      if (await kindOf(srcDir) !== 'directory') continue
      if (await kindOf(destRecord) !== 'missing' || await kindOf(destDir) !== 'missing') continue
      await migrateDirectory(srcDir, destDir)
    } catch (error) {
      warn(`supervisor: 迁移旧版记录目录 ${srcDir} 失败：${messageOf(error)}`)
    }
  }

  for (const name of entries) {
    if (!name.endsWith('.json')) continue
    const srcFile = join(srcRoot, name)
    const destFile = join(destRoot, name)
    try {
      await migrateRegularFile(srcFile, destFile)
    } catch (error) {
      warn(`supervisor: 迁移旧版记录文件 ${srcFile} 失败：${messageOf(error)}`)
    }
  }
}

/**
 * Migrate persisted files from legacy `logalyze` locations into the current
 * `supervisor` locations without overwriting files already present at target paths.
 */
export async function migrateLegacyData(options: MigrateLegacyDataOptions): Promise<void> {
  if (options.nestedLegacySupervisorDir !== undefined) {
    try {
      await migrateDomainDirectory(options.nestedLegacySupervisorDir, options.supervisorDir, options.warn)
    } catch (error) {
      options.warn(`supervisor: 迁移存储域目录 ${options.nestedLegacySupervisorDir} 失败：${messageOf(error)}`)
    }
  }

  if (options.legacyDataDir === undefined || resolve(options.legacyDataDir) === resolve(dirname(options.overlayPath))) {
    return
  }

  const steps: ReadonlyArray<{ readonly label: string; readonly run: () => Promise<void> }> = [
    {
      label: join(options.legacyDataDir, 'settings.json'),
      run: () => migrateRegularFile(join(options.legacyDataDir!, 'settings.json'), options.overlayPath),
    },
    {
      label: join(options.legacyDataDir, 'applications.json'),
      run: () => migrateRegularFile(join(options.legacyDataDir!, 'applications.json'), options.applicationsPath),
    },
    {
      label: join(options.legacyDataDir, 'supervisor'),
      run: () => migrateDomainDirectory(join(options.legacyDataDir!, 'supervisor'), options.supervisorDir, options.warn),
    },
    {
      label: join(options.legacyDataDir, 'analyses'),
      run: () => migrateRecordStore(join(options.legacyDataDir!, 'analyses'), options.analysesDir, options.warn),
    },
    {
      label: join(options.legacyDataDir, 'reports'),
      run: () => migrateRecordStore(join(options.legacyDataDir!, 'reports'), options.legacyReportsDir, options.warn),
    },
  ]

  for (const step of steps) {
    try {
      await step.run()
    } catch (error) {
      options.warn(`supervisor: 迁移旧版数据 ${step.label} 失败：${messageOf(error)}`)
    }
  }
}
