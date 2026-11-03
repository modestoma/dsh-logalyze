/**
 * 观象 client half：左侧栏全局入口「观象」+ 主区整页设置面板。
 *
 * 依赖平台核心的 `slots` 服务与 react，可选使用插件页的 `pluginNavigation`
 * 跳转到 dsh-repo 的主机与令牌设置（bundle 里 react 走平台模块表，
 * 其余全部内联）；页面数据来自 Host 半侧的 `/logalyze/*` 路由。
 *
 * @module dsh-logalyze/client
 */

import { LogalyzeIcon } from './icon.tsx'
import { boundLogalyzePage, PANEL_TITLE } from './page.tsx'
import { installStyles } from './styles.ts'

/** Slots runtime surface this bundle uses: list slots by `id`, keyed slots by `key`. */
export interface ClientSlots {
  inject(slot: string, contribution: () => unknown): void
  register(
    declaration:
      | { name: string; id: string; order?: number; label?: () => string }
      | { name: string; key: string },
    component: (props: never) => unknown,
  ): () => void
}

/** Client plugin context. */
export interface ClientContext {
  slots: ClientSlots
  /** Optional services, read when used: `pluginNavigation` opens a bundle's Plugins page. */
  get?(name: string): unknown
  effect?(callback: () => void | (() => void), label?: string): void
}

/** The `pluginNavigation` client service of the Plugins panel. */
interface PluginNavigation {
  openBundle(packageName: string): void
}

/** npm package name of the plugin that owns hosts and tokens. */
export const REPO_BUNDLE = 'dsh-repo'

/** Cordis client plugin name. */
export const name = 'dsh-logalyze'

/** Required client services: the Slots registry is part of the web shell core. */
export const inject = ['slots']

/**
 * Main panel id: the `sidebar.panellist` row id and the matching `main` slot
 * key. Must not change once released: DSH keys navigation state by it.
 */
export const PANEL_ID = 'logalyze'
/** Left-sidebar row order (dsh-channels uses 40). */
export const PANEL_ORDER = 45

/**
 * Mount the left-sidebar entry, its main-column page, and the stylesheet.
 * @param ctx - client plugin context carrying the slots registry.
 */
export function apply(ctx: ClientContext): void {
  if (typeof ctx.effect === 'function') ctx.effect(() => installStyles(), 'dsh-logalyze: panel styles')
  else installStyles()
  const openRepoSettings = (): (() => void) | undefined => {
    const navigation = ctx.get?.('pluginNavigation') as PluginNavigation | undefined
    return navigation === undefined ? undefined : () => { navigation.openBundle(REPO_BUNDLE) }
  }
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID }, boundLogalyzePage(openRepoSettings)))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: PANEL_ORDER,
    label: () => PANEL_TITLE,
  }, LogalyzeIcon))
}
