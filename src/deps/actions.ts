/**
 * 飞书渠道插件 `feishuActions` 服务（v1）的运行时发现与版本校验辅助函数。
 *
 * @module dsh-logalyze/deps/actions
 */

import type { ActionsAvailability } from '../settings/contract.ts'
import type { FeishuActionsService, FeishuActionsVersion } from './actions-contract.ts'

/** Name the Feishu channel plugin provides the service under. */
export const FEISHU_ACTIONS_SERVICE = 'feishuActions'

/** Contract version required by this plugin. */
export const FEISHU_ACTIONS_VERSION: FeishuActionsVersion = 1

/** Result of looking up `feishuActions` on the host context. */
export type ActionsLookup =
  | { readonly availability: 'ready'; readonly service: FeishuActionsService }
  | { readonly availability: Exclude<ActionsAvailability, 'ready'> }

/**
 * Classify `ctx.get('feishuActions')` at run time.
 * @param value - looked-up service candidate.
 * @returns usable v1 service, or `'missing'` / `'incompatible'`.
 */
export function lookupActions(value: unknown): ActionsLookup {
  if (value === undefined || value === null) return { availability: 'missing' }
  const service = value as Partial<Record<keyof FeishuActionsService, unknown>>
  if (service.version !== FEISHU_ACTIONS_VERSION) return { availability: 'incompatible' }
  if (typeof service.propose !== 'function' || typeof service.supersede !== 'function') {
    return { availability: 'incompatible' }
  }
  return { availability: 'ready', service: value as FeishuActionsService }
}
