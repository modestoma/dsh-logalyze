/**
 * 飞书渠道插件 `feishuTopics` 服务的查找。服务接口在 `./topics-contract.ts`
 * 本地声明；服务在运行时经 `ctx.get('feishuTopics')` 取得，版本不符或缺少
 * 话题状态与链接表方法（较早的版本 3）时不调用。
 *
 * @module dsh-logalyze/deps/topics
 */

import type { TopicsAvailability } from '../settings/contract.ts'
import type { FeishuTopicService, FeishuTopicsVersion } from './topics-contract.ts'

/** Name the Feishu channel plugin provides the service under. */
export const FEISHU_TOPICS_SERVICE = 'feishuTopics'

/** The `feishuTopics` contract version this plugin speaks. */
export const FEISHU_TOPICS_VERSION: FeishuTopicsVersion = 3

/** Result of looking the service up. */
export type TopicsLookup =
  | { readonly availability: 'ready'; readonly service: FeishuTopicService }
  | { readonly availability: Exclude<TopicsAvailability, 'ready'> }

/**
 * Classify the value `ctx.get('feishuTopics')` returned. The provider is
 * another package, so its contract version and the methods added within it
 * are checked at run time.
 * @param value - the looked-up service, or undefined.
 * @returns the usable service, or why there is none.
 */
export function lookupTopics(value: unknown): TopicsLookup {
  if (value === undefined || value === null) return { availability: 'missing' }
  const service = value as Partial<Record<keyof FeishuTopicService, unknown>>
  if (service.version !== FEISHU_TOPICS_VERSION) return { availability: 'incompatible' }
  if (typeof service.state !== 'function' || typeof service.launchKeyOf !== 'function' || typeof service.updateLinks !== 'function') return { availability: 'incompatible' }
  return { availability: 'ready', service: value as FeishuTopicService }
}
