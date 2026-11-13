/**
 * 分析入口共用的应用准备接口；调用方自行负责鉴权与租约释放。
 *
 * @module dsh-logalyze/apps/access
 */

import type { ReadyApp, RepoLease } from './registry.ts'

/** Runtime service for catalog-based application preparation. */
export const LOGALYZE_APPLICATIONS_SERVICE = 'logalyzeApplications'

/** Only enabled, usable repositories accept new work. A held lease keeps its commit after catalog changes. */
export interface ApplicationAccess {
  /** @returns current applications after startup has settled. */
  list(): Promise<readonly ReadyApp[]>
  /** @param name - Feishu name, platform component code, or id; @returns a unique match; rejects ambiguity. */
  resolve(name: string): Promise<ReadyApp>
  /** @param ids - application ids; @returns held code snapshots and DSH skill readers; release after all readers stop. */
  acquire(ids: readonly string[]): Promise<RepoLease>
}
