/**
 * 面板覆盖文件 `$DSH_HOME/logalyze/settings.json` 的读写。文件只保存与
 * cordis.yml 默认值不同的字段；写入先落临时文件再改名，读到的内容按与
 * 配置相同的规则校验。
 *
 * @module dsh-logalyze/settings/overlay
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { describeIssue, overlaySchema, resolveDshHome } from '../config.ts'
import type { SettingsOverlay } from '../config.ts'
import { EDITABLE_KEYS } from './contract.ts'
import type { EditableKey, EditableSettings } from './contract.ts'

/**
 * Default overlay path.
 * @param env - process environment.
 * @returns `$DSH_HOME/logalyze/settings.json`.
 */
export function defaultOverlayPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveDshHome(env), 'logalyze', 'settings.json')
}

/** Result of reading the overlay file. */
export type OverlayRead =
  | { readonly ok: true; readonly overlay: SettingsOverlay }
  | { readonly ok: false; readonly error: string }

/**
 * Keys whose value differs from the defaults, i.e. what the overlay must store.
 * @param defaults - settings from the configuration.
 * @param settings - settings the panel saved.
 * @returns the minimal overlay.
 */
export function diffOverlay(defaults: EditableSettings, settings: EditableSettings): SettingsOverlay {
  const overlay: Record<string, unknown> = {}
  for (const key of EDITABLE_KEYS) {
    if (JSON.stringify(settings[key]) !== JSON.stringify(defaults[key])) overlay[key] = settings[key]
  }
  return overlay as SettingsOverlay
}

/**
 * Keys an overlay overrides.
 * @param overlay - validated overlay.
 * @returns overridden keys in panel order.
 */
export function overriddenKeys(overlay: SettingsOverlay): EditableKey[] {
  return EDITABLE_KEYS.filter(key => overlay[key] !== undefined)
}

/** Reads and writes one overlay file. */
export class OverlayStore {
  /** @param path - absolute overlay file path. */
  constructor(readonly path: string) {}

  /**
   * Read the overlay. A missing file is an empty overlay; unreadable or
   * invalid content is reported, never silently replaced.
   * @returns the overlay or the reason it cannot be used.
   */
  async read(): Promise<OverlayRead> {
    let text: string
    try {
      text = await readFile(this.path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true, overlay: {} }
      return { ok: false, error: `无法读取 ${this.path}：${(error as Error).message}` }
    }
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch (error) {
      return { ok: false, error: `${this.path} 不是合法 JSON：${(error as Error).message}` }
    }
    const parsed = overlaySchema.safeParse(raw)
    if (!parsed.success) return { ok: false, error: `${this.path} 内容不合法：${describeIssue(parsed.error)}` }
    return { ok: true, overlay: parsed.data }
  }

  /**
   * Replace the overlay atomically.
   * @param overlay - validated overlay to store.
   */
  async write(overlay: SettingsOverlay): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    const temporary = `${this.path}.${process.pid}.${Date.now()}.tmp`
    await writeFile(temporary, `${JSON.stringify(overlay, undefined, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, this.path)
  }
}
