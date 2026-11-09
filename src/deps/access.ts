/**
 * The `access/authorize` event: before a write is made for a Session, the
 * plugin asks the other plugins (with `ctx.parallel`) whether that Session
 * may act. A listener that knows the Session and refuses throws an `Error`
 * whose message says why; one that does not know it returns. No listener
 * means allowed. The event is declared here so the plugin does not depend on
 * the package of whoever answers it.
 *
 * @module dsh-logalyze/deps/access
 */

import type { HostContext } from '../host.ts'

/** Cordis event name. */
export const ACCESS_AUTHORIZE_EVENT = 'access/authorize'

/** Payload of {@link ACCESS_AUTHORIZE_EVENT}. */
export interface AuthorizeEvent {
  /** Session id of the Agent the write is made for. */
  readonly session: string
  /** What is asked for; this plugin asks `admin` for changing its own repository list. */
  readonly level: 'code-write' | 'wiki-read' | 'wiki-write' | 'admin'
  /** The tool name. */
  readonly action: string
  /** Chinese description of the write, as the approval request shows it. */
  readonly summary: string
}

/**
 * Ask the `access/authorize` listeners whether a Session may make one write.
 * @param ctx - plugin context; without `parallel` there are no listeners.
 * @param event - the Session, the level, and what it is about to do.
 * @throws an `Error` naming every listener's reason when any listener refused.
 */
export async function authorize(ctx: Pick<HostContext, 'parallel'>, event: AuthorizeEvent): Promise<void> {
  try {
    await ctx.parallel?.(ACCESS_AUTHORIZE_EVENT, event)
  } catch (error) {
    const errors = error instanceof AggregateError ? error.errors : [error]
    throw new Error(`${event.action} 未获授权，没有执行：${errors.map(reason => reason instanceof Error ? reason.message : String(reason)).join('；')}`)
  }
}
