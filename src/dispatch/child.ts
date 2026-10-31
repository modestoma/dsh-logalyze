/**
 * 启动一个子 Agent 并等待它结束：接入起草和 SKILL 改进各用一个子 Agent，
 * 结果交还调用方（delivery `caller`）。超过时限或调用被取消时停止子 Agent；
 * 无论结果如何都释放它。
 *
 * @module dsh-logalyze/dispatch/child
 */

import type { Agent, SubagentService } from '../host.ts'
import { messageOf } from '../repos/lookup.ts'

/** One child run. */
export interface ChildRun {
  readonly subagents: SubagentService
  /** Registered `ctx.subagents` provider. */
  readonly provider: string
  readonly parent: Agent
  /** Child label shown in the UI. */
  readonly label: string
  /** Read-only snapshot the child works in. */
  readonly cwd: string
  /** First message. */
  readonly prompt: string
  readonly timeoutMs: number
  readonly signal: AbortSignal
}

/** How a child ended. */
export interface ChildOutcome {
  /** `completed`, `timeout`, `aborted`, `failed`, `error`, or the child's stop reason. */
  status: string
  /** The child's final answer text. */
  output: string
  diagnostic?: string
}

/**
 * Run one child to its end.
 * @param run - service, parent, snapshot, prompt, and limits.
 * @returns the outcome; a child that fails to start or errors is reported, not thrown.
 * @throws the cancellation reason when `signal` is aborted.
 */
export async function runChild(run: ChildRun): Promise<ChildOutcome> {
  const { signal, timeoutMs } = run
  const stop = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
  const maxDepth = run.subagents.resolveMaxDepth()
  let activation
  try {
    activation = await run.subagents.startActivation({
      provider: run.provider,
      label: run.label,
      request: { cwd: run.cwd, prompt: [{ type: 'text', text: run.prompt }], parent: run.parent, ...maxDepth === undefined ? {} : { maxDepth } },
      signal: stop,
      delivery: 'caller',
    })
  } catch (error) {
    signal.throwIfAborted()
    return { status: stop.aborted ? 'timeout' : 'failed', output: '', diagnostic: messageOf(error) }
  }
  const stopped = new Promise<'stopped'>((resolveStop) => {
    if (stop.aborted) resolveStop('stopped')
    else stop.addEventListener('abort', () => { resolveStop('stopped') }, { once: true })
  })
  let result: ChildOutcome
  try {
    const outcome = await Promise.race([activation.result, stopped])
    result = outcome === 'stopped'
      ? { status: signal.aborted ? 'aborted' : 'timeout', output: '', diagnostic: signal.aborted ? '调用被取消' : `超过派发等待上限 ${timeoutMs} ms` }
      : {
          status: outcome.stopReason,
          output: outcome.output.flatMap(block => block.type === 'text' && typeof block.text === 'string' ? [block.text] : []).join('\n').trim(),
          ...outcome.diagnostic === undefined ? {} : { diagnostic: outcome.diagnostic },
        }
  } catch (error) {
    result = { status: 'error', output: '', diagnostic: messageOf(error) }
  }
  // Disposing releases a finished child and stops one that timed out or was cancelled.
  try {
    await activation.dispose()
  } catch (error) {
    result.diagnostic = [result.diagnostic, `子 Agent 清理失败：${messageOf(error)}`].filter(Boolean).join('；')
  }
  signal.throwIfAborted()
  return result
}
