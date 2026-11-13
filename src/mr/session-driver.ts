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
  readonly requestId: string
  messageId: string | undefined
  claimed: boolean
  claimedTurn: number | undefined
  readonly resolve: (outcome: { readonly error?: string }) => void
  readonly cleanup: () => void
}

interface SessionTrackState {
  currentTurn: number | undefined
  readonly inbox: {
    'next-turn': string[]
    'next-step': string[]
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined
}

function extractTurnNumber(data: unknown): number | undefined {
  const rec = asRecord(data)
  return typeof rec?.turn === 'number' ? rec.turn : undefined
}

function extractTurnEndError(data: unknown): string | undefined {
  const rec = asRecord(data)
  const reason = asRecord(rec?.reason)
  if (typeof reason?.kind === 'string') {
    if (reason.kind === 'completed' || reason.kind === 'max-tokens') return undefined
    if (reason.kind === 'error') {
      const errObj = asRecord(reason.error)
      return typeof errObj?.message === 'string' && errObj.message.length > 0 ? errObj.message : 'error'
    }
    if (
      reason.kind === 'aborted'
      || reason.kind === 'blocked'
      || reason.kind === 'interrupted'
      || reason.kind === 'forked'
    ) {
      return reason.kind
    }
    return undefined
  }
  const stopReason = typeof rec?.stopReason === 'string' ? rec.stopReason : undefined
  if (stopReason === 'error' || stopReason === 'aborted') {
    return typeof rec?.error === 'string' && rec.error.length > 0 ? rec.error : stopReason
  }
  return undefined
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
  const sessionStates = new Map<string, SessionTrackState>()

  const getSessionState = (sessionId: string): SessionTrackState => {
    let state = sessionStates.get(sessionId)
    if (state === undefined) {
      state = { currentTurn: undefined, inbox: { 'next-turn': [], 'next-step': [] } }
      sessionStates.set(sessionId, state)
    }
    return state
  }

  const pruneSessionState = (sessionId: string): void => {
    const state = sessionStates.get(sessionId)
    if (state === undefined) return
    for (const waiter of waiters) {
      if (waiter.sessionId === sessionId) return
    }
    if (
      state.currentTurn === undefined
      && state.inbox['next-turn'].length === 0
      && state.inbox['next-step'].length === 0
    ) {
      sessionStates.delete(sessionId)
    }
  }

  const finishWaiter = (waiter: PendingTurnWaiter, error?: string): void => {
    if (!waiters.has(waiter)) return
    waiter.cleanup()
    waiter.resolve(error === undefined ? {} : { error })
    pruneSessionState(waiter.sessionId)
  }

  return {
    onSessionEvent(sessionId: string, eventType: string, data: unknown): void {
      if (
        eventType !== 'turn/start'
        && eventType !== 'agent/inbox/spliced'
        && eventType !== 'user/message'
        && eventType !== 'turn/end'
      ) {
        return
      }

      if (eventType === 'turn/start') {
        const state = getSessionState(sessionId)
        state.currentTurn = extractTurnNumber(data)
        return
      }

      if (eventType === 'agent/inbox/spliced') {
        const rec = asRecord(data)
        const target = rec?.target === 'next-turn' || rec?.target === 'next-step' ? rec.target : undefined
        if (target === undefined) return

        const state = getSessionState(sessionId)
        const list = state.inbox[target]
        const start = typeof rec?.start === 'number' && Number.isInteger(rec.start) && rec.start >= 0
          ? rec.start
          : list.length
        const removedCount = typeof rec?.removedCount === 'number' && Number.isInteger(rec.removedCount) && rec.removedCount >= 0
          ? rec.removedCount
          : 0
        while (list.length < start) list.push('')

        const insertedRaw = Array.isArray(rec?.inserted) ? rec.inserted : []
        const insertedIds: string[] = []
        for (const rawMsg of insertedRaw) {
          const msg = asRecord(rawMsg)
          const id = typeof msg?.id === 'string' ? msg.id : ''
          const source = asRecord(msg?.source)
          const rpcId = typeof source?.rpcId === 'string' ? source.rpcId : undefined
          insertedIds.push(id)
          if (rpcId !== undefined && id.length > 0) {
            for (const waiter of waiters) {
              if (waiter.sessionId === sessionId && waiter.requestId === rpcId) {
                waiter.messageId = id
              }
            }
          }
        }

        const removedIds = list.splice(start, removedCount, ...insertedIds).filter(id => id.length > 0)
        const outcome = typeof rec?.outcome === 'string' ? rec.outcome : undefined
        if (removedIds.length > 0) {
          for (const waiter of [...waiters]) {
            if (waiter.sessionId !== sessionId || waiter.messageId === undefined || !removedIds.includes(waiter.messageId)) {
              continue
            }
            if (outcome === 'canceled') {
              queueMicrotask(() => {
                if (!waiters.has(waiter) || waiter.claimed) return
                const cur = sessionStates.get(sessionId)
                const stillQueued = cur !== undefined
                  && waiter.messageId !== undefined
                  && (cur.inbox['next-turn'].includes(waiter.messageId) || cur.inbox['next-step'].includes(waiter.messageId))
                if (!stillQueued) {
                  finishWaiter(waiter, '排队的 MR 评审消息已被取消')
                }
              })
            } else {
              waiter.claimed = true
              if (state.currentTurn !== undefined && waiter.claimedTurn === undefined) {
                waiter.claimedTurn = state.currentTurn
              }
            }
          }
        }
        pruneSessionState(sessionId)
        return
      }

      if (eventType === 'user/message') {
        const msg = asRecord(data)
        const id = typeof msg?.id === 'string' ? msg.id : undefined
        const source = asRecord(msg?.source)
        const rpcId = typeof source?.rpcId === 'string' ? source.rpcId : undefined
        const state = sessionStates.get(sessionId)
        for (const waiter of waiters) {
          if (waiter.sessionId !== sessionId) continue
          if (
            (rpcId !== undefined && waiter.requestId === rpcId)
            || (id !== undefined && id.length > 0 && waiter.messageId === id)
          ) {
            if (id !== undefined && id.length > 0 && waiter.messageId === undefined) {
              waiter.messageId = id
            }
            waiter.claimed = true
            if (state?.currentTurn !== undefined && waiter.claimedTurn === undefined) {
              waiter.claimedTurn = state.currentTurn
            }
          }
        }
        return
      }

      const endedTurn = extractTurnNumber(data)
      const errorText = extractTurnEndError(data)
      const state = sessionStates.get(sessionId)
      if (state !== undefined && (endedTurn === undefined || state.currentTurn === endedTurn)) {
        state.currentTurn = undefined
      }
      for (const waiter of [...waiters]) {
        if (waiter.sessionId !== sessionId) continue
        if (!waiter.claimed) continue
        if (waiter.claimedTurn !== undefined && endedTurn !== undefined && waiter.claimedTurn !== endedTurn) {
          continue
        }
        finishWaiter(waiter, errorText)
      }
      pruneSessionState(sessionId)
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

      const requestId = randomUUID()
      let registeredWaiter!: PendingTurnWaiter
      const turnPromise = new Promise<{ readonly error?: string }>((resolve, reject) => {
        const onAbort = (): void => {
          cleanup()
          pruneSessionState(sessionId!)
          reject(new Error('MR 会话执行已取消'))
        }
        const waiter: PendingTurnWaiter = {
          sessionId: sessionId!,
          requestId,
          messageId: undefined,
          claimed: false,
          claimedTurn: undefined,
          resolve,
          cleanup,
        }
        registeredWaiter = waiter
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
            requestId,
            content: [{ type: 'text', text: request.prompt }],
            mode: 'queue',
          }, request.signal)
          if (!accepted.accepted) {
            finishWaiter(registeredWaiter, '会话未接受唤醒消息')
          }
        } else if (resolvedAgent?.prompt !== undefined) {
          registeredWaiter.claimed = true
          await resolvedAgent.prompt([{ type: 'text', text: request.prompt }], { signal: request.signal })
          finishWaiter(registeredWaiter)
        } else {
          throw new Error(`宿主 sessionController 未提供 prompt 方法，无法投递消息到会话 "${sessionId}"`)
        }
      } catch (error) {
        finishWaiter(registeredWaiter, error instanceof Error ? error.message : String(error))
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
      sessionStates.clear()
    },
  }
}
