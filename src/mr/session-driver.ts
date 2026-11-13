/**
 * MR 会话驱动适配器：
 * - 支持测试/嵌入宿主注入自定义 `MrSessionDriver`；
 * - 默认优先通过 DSH `sessionController`（以及 `dsh_channels` 的 `repo/resolve-agent`）
 *   创建无头评审会话或唤醒既有的飞书话题/MR 会话，并监听 `session/event` 的 `turn/end`
 *   等待本轮执行自然结束，不做忙等轮询。
 *
 * @module dsh-logalyze/mr/session-driver
 */

import { randomUUID } from 'node:crypto'
import type { HostContext, HostResolvedAgent, SessionControllerService } from '../host.ts'
import type { MrOrigin } from '../runtime/domain.ts'

/** Input passed to start or wake a persistent MR session turn. */
export interface MrSessionTurnRequest {
  readonly repo: string
  readonly mrNumber: number
  readonly origin: MrOrigin
  readonly existingSessionId?: string
  readonly workDir: string
  readonly prompt: string
  readonly signal: AbortSignal
  readonly onSessionBound?: (sessionId: string) => void | Promise<void>
}

/** Result of invoking one turn of an MR session. */
export interface MrSessionTurnResult {
  readonly sessionId: string
  readonly error?: string
}

/** Injectable session driver for creating and running turns on persistent MR sessions. */
export interface MrSessionDriver {
  runTurn(request: MrSessionTurnRequest): Promise<MrSessionTurnResult>
  dispose?(): void
}

interface PendingTurnWaiter {
  readonly sessionId: string
  readonly resolve: (outcome: { readonly error?: string }) => void
  readonly cleanup: () => void
}

function asController(ctx: HostContext): SessionControllerService | undefined {
  return ctx.get?.('sessionController') as SessionControllerService | undefined
}

async function resolveAgentWithChannelWaterfall(
  ctx: HostContext,
  controller: SessionControllerService | undefined,
  sessionId: string,
): Promise<HostResolvedAgent | undefined> {
  const fallback = async (): Promise<HostResolvedAgent | undefined> => {
    if (controller?.resolveAgent === undefined) return undefined
    const resolved = await controller.resolveAgent(sessionId)
    return 'agent' in resolved ? resolved.agent : undefined
  }
  if (typeof ctx.waterfall === 'function') {
    return ctx.waterfall<HostResolvedAgent | undefined>('repo/resolve-agent', sessionId, fallback)
  }
  return fallback()
}

/** Create the default Host `sessionController`-backed MR session driver. */
export function createHostMrSessionDriver(ctx: HostContext): MrSessionDriver & {
  onSessionEvent(sessionId: string, eventType: string, data: unknown): void
} {
  const waiters = new Set<PendingTurnWaiter>()

  const notifySessionEnded = (sessionId: string, error?: string): void => {
    for (const waiter of waiters) {
      if (waiter.sessionId !== sessionId) continue
      waiter.cleanup()
      waiter.resolve(error === undefined ? {} : { error })
      return
    }
  }

  return {
    onSessionEvent(sessionId: string, eventType: string, data: unknown): void {
      if (eventType === 'turn/end') {
        const stopReason = typeof data === 'object' && data !== null && 'stopReason' in data
          ? String((data as { stopReason?: unknown }).stopReason ?? '')
          : ''
        const errorText = stopReason === 'error' || stopReason === 'aborted'
          ? (typeof data === 'object' && data !== null && 'error' in data ? String((data as { error?: unknown }).error ?? stopReason) : stopReason)
          : undefined
        notifySessionEnded(sessionId, errorText)
      }
    },

    async runTurn(request: MrSessionTurnRequest): Promise<MrSessionTurnResult> {
      const controller = asController(ctx)
      if (controller === undefined) {
        throw new Error('宿主未提供 sessionController 服务，无法创建或唤醒 MR 会话')
      }

      let sessionId = request.existingSessionId
      if (sessionId === undefined) {
        if (controller.create === undefined) {
          throw new Error('宿主 sessionController 未提供 create 方法，无法创建无头 MR 会话')
        }
        const created = await controller.create({ cwd: request.workDir })
        sessionId = created.sessionId
      }
      await request.onSessionBound?.(sessionId)

      // Activate Feishu-routed or cold agent via `repo/resolve-agent` waterfall before submitting the turn.
      const resolvedAgent = await resolveAgentWithChannelWaterfall(ctx, controller, sessionId)
      request.signal.throwIfAborted()

      const turnPromise = new Promise<{ readonly error?: string }>((resolve, reject) => {
        const onAbort = (): void => {
          cleanup()
          reject(new Error('MR 会话执行已取消'))
        }
        const waiter: PendingTurnWaiter = {
          sessionId: sessionId!,
          resolve,
          cleanup,
        }
        function cleanup(): void {
          waiters.delete(waiter)
          request.signal.removeEventListener('abort', onAbort)
        }
        waiters.add(waiter)
        request.signal.addEventListener('abort', onAbort, { once: true })
      })

      try {
        if (controller.prompt !== undefined) {
          const accepted = await controller.prompt({
            sessionId,
            requestId: randomUUID(),
            content: [{ type: 'text', text: request.prompt }],
            mode: 'queue',
          }, request.signal)
          if (!accepted.accepted) {
            notifySessionEnded(sessionId, '会话未接受唤醒消息')
          }
        } else if (resolvedAgent?.prompt !== undefined) {
          await resolvedAgent.prompt([{ type: 'text', text: request.prompt }], { signal: request.signal })
          notifySessionEnded(sessionId)
        } else {
          throw new Error(`宿主 sessionController 未提供 prompt 方法，无法投递消息到会话 "${sessionId}"`)
        }
      } catch (error) {
        notifySessionEnded(sessionId, error instanceof Error ? error.message : String(error))
        throw error
      }

      const outcome = await turnPromise
      return {
        sessionId,
        ...(outcome.error === undefined ? {} : { error: outcome.error }),
      }
    },

    dispose(): void {
      for (const waiter of [...waiters]) {
        waiter.cleanup()
        waiter.resolve({ error: '插件已停止' })
      }
    },
  }
}
