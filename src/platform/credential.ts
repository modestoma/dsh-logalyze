/**
 * 保存在 DSH 凭据库中的凭据：日志平台的 OAuth2 client_secret（凭据名是配置项
 * `platformSecretRef`）。面板只能看到是否已配置和来源，看不到值。
 *
 * @module dsh-supervisor/platform/credential
 */

import { z } from 'zod'
import { describeIssue } from '../config.ts'
import type { HostCredentials } from '../host.ts'
import { SettingsError } from '../settings/controller.ts'
import type { TokenStatusWire } from '../settings/contract.ts'
import { messageOf } from '../util/errors.ts'

/** Longest accepted token; personal access tokens are far shorter. */
const MAX_TOKEN_LENGTH = 4096

const tokenValue = z.string().trim()
  .refine(value => value.length > 0 && value.length <= MAX_TOKEN_LENGTH && !/[\u0000-\u001f\u007f]/.test(value), `令牌不能为空、超过 ${MAX_TOKEN_LENGTH} 个字符或包含换行等控制字符`)
const tokenClearSchema = z.object({ tokenEnv: z.string() }).strict()
const tokenSetSchema = tokenClearSchema.extend({ value: tokenValue }).strict()

/** One credential in DSH's credential store. */
export class StoredCredential {
  private migrating: Promise<void> | undefined

  /**
   * @param ref - credential reference (`platformSecretRef`).
   * @param label - what the credential is, in messages (e.g. `日志平台 client_secret`).
   * @param credentials - DSH's credential store, looked up per use.
   * @param warn - receives credential store failures.
   * @param legacyRef - optional legacy credential reference to migrate from (`LOGALYZE_*`).
   */
  constructor(
    readonly ref: string,
    private readonly label: string,
    private readonly credentials: () => HostCredentials | undefined,
    private readonly warn: (message: string) => void,
    private readonly legacyRef?: string,
  ) {}

  /** @returns whether the composition has a credential store. */
  available(): boolean {
    return this.credentials() !== undefined
  }

  private async ensureMigrated(store: HostCredentials): Promise<void> {
    if (this.legacyRef === undefined || this.legacyRef === this.ref) return
    if (this.migrating !== undefined) {
      await this.migrating
      return
    }
    this.migrating = (async () => {
      try {
        const info = await store.describe(this.ref)
        if (info.configured || !info.writable) return
        const legacyInfo = await store.describe(this.legacyRef!).catch(() => undefined)
        if (legacyInfo?.configured !== true || legacyInfo.source !== 'file') return
        const legacy = await store.resolve(this.legacyRef!)
        if (legacy === undefined || legacy.source !== 'file') return
        await store.set(this.ref, legacy.value)
        await store.unset(this.legacyRef!).catch(() => undefined)
      } catch {
        // Best-effort migration only; reads still fall back to legacyRef when available.
      }
    })().finally(() => {
      this.migrating = undefined
    })
    await this.migrating
  }

  /**
   * Resolve the value, read per use.
   * @returns the value, or undefined when it is not configured or cannot be read.
   */
  async value(): Promise<string | undefined> {
    const store = this.credentials()
    if (store === undefined) return undefined
    try {
      const primary = await store.resolve(this.ref)
      if (primary !== undefined) return primary.value
      if (this.legacyRef === undefined || this.legacyRef === this.ref) return undefined
      await this.ensureMigrated(store)
      const afterMigrate = await store.resolve(this.ref)
      if (afterMigrate !== undefined) return afterMigrate.value
      return (await store.resolve(this.legacyRef))?.value
    } catch (error) {
      this.warn(`supervisor: 读取${this.label} ${this.ref} 失败：${messageOf(error)}`)
      return undefined
    }
  }

  /** @returns whether the token is configured and where from; undefined without a credential store. */
  async status(): Promise<TokenStatusWire | undefined> {
    const store = this.credentials()
    if (store === undefined) return undefined
    try {
      await this.ensureMigrated(store)
      const info = await store.describe(this.ref)
      if (!info.configured && this.legacyRef !== undefined && this.legacyRef !== this.ref) {
        const legacyInfo = await store.describe(this.legacyRef).catch(() => undefined)
        if (legacyInfo?.configured === true) {
          return {
            tokenEnv: this.ref,
            configured: true,
            ...legacyInfo.source === undefined ? {} : { source: legacyInfo.source },
            writable: info.writable,
          }
        }
      }
      return { tokenEnv: this.ref, configured: info.configured, ...info.source === undefined ? {} : { source: info.source }, writable: info.writable }
    } catch (error) {
      return { tokenEnv: this.ref, configured: false, writable: false, error: messageOf(error) }
    }
  }

  /**
   * Store the value; it applies from the next use.
   * @param raw - request body `{ tokenEnv, value }`.
   * @throws SettingsError when the body is invalid, the name is not {@link ref}, or no credential store is loaded.
   */
  async set(raw: unknown): Promise<void> {
    const parsed = tokenSetSchema.safeParse(raw)
    if (!parsed.success) throw new SettingsError(describeIssue(parsed.error))
    await this.write(parsed.data.tokenEnv, parsed.data.value)
  }

  /**
   * Remove the stored value; an environment variable of the same name applies again afterwards.
   * @param raw - request body `{ tokenEnv }`.
   * @throws SettingsError on the same conditions as {@link set}.
   */
  async clear(raw: unknown): Promise<void> {
    const parsed = tokenClearSchema.safeParse(raw)
    if (!parsed.success) throw new SettingsError(describeIssue(parsed.error))
    await this.write(parsed.data.tokenEnv, undefined)
  }

  private async write(tokenEnv: string, value: string | undefined): Promise<void> {
    if (tokenEnv !== this.ref) throw new SettingsError(`${tokenEnv} 不是${this.label}的名称`)
    const store = this.credentials()
    if (store === undefined) throw new SettingsError(`当前 DSH 组合没有凭据服务（@deepseek-ai/dsh-credentials-local），无法保存${this.label}`)
    if (value === undefined) await store.unset(tokenEnv)
    else await store.set(tokenEnv, value)
    if (this.legacyRef !== undefined && this.legacyRef !== this.ref) {
      await store.unset(this.legacyRef).catch(() => undefined)
    }
  }
}
