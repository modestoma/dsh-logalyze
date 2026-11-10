/**
 * 生效设置：cordis.yml 给出默认值，面板覆盖文件只保存与默认值不同的字段。
 * 覆盖文件不可读或不合法时忽略它、在面板上说明原因，下一次保存时替换它。
 *
 * @module dsh-logalyze/settings/controller
 */

import { applyOverlay, defaultsOf, describeIssue, editableSettingsSchema } from '../config.ts'
import type { LogalyzeConfig, SettingsOverlay } from '../config.ts'
import type { EditableSettings, StateWire } from './contract.ts'
import { diffOverlay, overriddenKeys } from './overlay.ts'
import type { OverlayStore } from './overlay.ts'

/** A settings write the panel reports as a field error. */
export class SettingsError extends Error {}

/** Holds the effective settings and writes the panel overlay. */
export class SettingsController {
  /** Settings from cordis.yml, before panel overrides. */
  readonly defaults: EditableSettings
  private overlay: SettingsOverlay = {}
  private overlayError: string | undefined
  private current: EditableSettings

  /**
   * @param config - validated plugin configuration.
   * @param store - panel overlay file.
   * @param warn - receives the reason an unusable overlay file is ignored.
   */
  constructor(config: LogalyzeConfig, private readonly store: OverlayStore, private readonly warn: (message: string) => void) {
    this.defaults = defaultsOf(config)
    this.current = this.defaults
  }

  /** Read the overlay file and make it effective; an unusable file is ignored and reported. */
  async load(): Promise<void> {
    const read = await this.store.read()
    if (read.ok) {
      this.use(read.overlay)
      return
    }
    this.overlayError = read.error
    this.warn(`logalyze: 忽略面板设置：${read.error}`)
  }

  /** @returns the effective settings. */
  get(): EditableSettings {
    return this.current
  }

  /** @returns the settings part of the panel state. */
  panel(): Pick<StateWire, 'settings' | 'defaults' | 'overridden' | 'overlayError'> {
    return {
      settings: this.current,
      defaults: this.defaults,
      overridden: overriddenKeys(this.overlay),
      ...this.overlayError === undefined ? {} : { overlayError: this.overlayError },
    }
  }

  /**
   * Validate and persist a complete settings payload from the panel.
   * @param raw - request body.
   * @throws SettingsError when the payload is invalid.
   */
  async save(raw: unknown): Promise<void> {
    const parsed = editableSettingsSchema.safeParse(raw)
    if (!parsed.success) throw new SettingsError(describeIssue(parsed.error))
    const overlay = diffOverlay(this.defaults, parsed.data)
    await this.store.write(overlay)
    this.use(overlay)
  }

  /** Remove every panel override. */
  async reset(): Promise<void> {
    await this.store.write({})
    this.use({})
  }

  private use(overlay: SettingsOverlay): void {
    this.overlay = overlay
    this.overlayError = undefined
    this.current = applyOverlay(this.defaults, overlay)
  }
}
