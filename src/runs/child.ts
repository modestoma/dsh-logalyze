/**
 * 启动一个子 Agent 并等待它结束，结果交还调用方（delivery `caller`）。派发
 * 为每个应用各用一个，SKILL 改进和接入起草各用一个。超过时限或调用被取消时
 * 停止子 Agent；无论结果如何都释放它。
 *
 * @module dsh-logalyze/runs/child
 */

import type { Agent, ContentBlock, SubagentService } from '../host.ts'
import { messageOf } from '../util/errors.ts'

/** One child run. */
export interface ChildRun {
  readonly subagents: SubagentService
  /** Registered `ctx.subagents` provider. */
  readonly provider: string
  readonly parent: Agent
  /** Child label shown in the UI. */
  readonly label: string
  /** Directory the child works in. */
  readonly cwd: string
  /** First message. */
  readonly prompt: string
  /** Wait budget in milliseconds; a child still running then is stopped. */
  readonly timeoutMs: number
  /** Caller cancellation. */
  readonly signal: AbortSignal
}

/** Terminal state of one child: its stop reason, or why the plugin stopped or never started it. */
export type ChildStatus = 'completed' | 'aborted' | 'error' | 'max-tokens' | 'refusal' | 'timeout' | 'failed' | (string & {})

/** How a child ended. */
export interface ChildOutcome {
  status: ChildStatus
  /** The child's id; absent when it never started. */
  childId?: string
  /** The child's final answer text. */
  output: string
  /** Failure detail separate from the child's own words. */
  diagnostic?: string
}

/**
 * The text of a child's final answer.
 * @param blocks - the answer's content blocks.
 * @returns the text blocks joined by newlines.
 */
export function textOf(blocks: readonly ContentBlock[]): string {
  return blocks.flatMap(block => block.type === 'text' && typeof block.text === 'string' ? [block.text] : []).join('\n').trim()
}

/**
 * Run one child to its end. The outcome is returned even when `signal` is
 * aborted (status `aborted`); callers that stop on cancellation check the signal.
 * @param run - service, parent, working directory, prompt, and limits.
 * @returns the outcome; a child that fails to start or errors is reported, not thrown.
 */
export async function runChild(run: ChildRun): Promise<ChildOutcome> {
  const { signal, timeoutMs } = run
  const stop = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
  const stoppedDiagnostic = (): string => signal.aborted ? '调用被取消' : `超过派发等待上限 ${timeoutMs} ms`
  const maxDepth = run.subagents.resolveMaxDepth()
  let activation
  try {
    activation = await run.subagents.startActivation({
      provider: run.provider,
      label: run.label,
      cwd: run.cwd,
      prompt: [{ type: 'text', text: run.prompt }],
      parent: run.parent,
      ...maxDepth === undefined ? {} : { maxDepth },
      signal: stop,
      delivery: 'caller',
    })
  } catch (error) {
    return { status: signal.aborted ? 'aborted' : stop.aborted ? 'timeout' : 'failed', output: '', diagnostic: messageOf(error) }
  }
  const { childId } = activation
  const stopped = new Promise<'stopped'>((resolveStop) => {
    if (stop.aborted) resolveStop('stopped')
    else stop.addEventListener('abort', () => { resolveStop('stopped') }, { once: true })
  })
  let result: ChildOutcome
  try {
    const outcome = await Promise.race([activation.result, stopped])
    result = outcome === 'stopped'
      ? { status: signal.aborted ? 'aborted' : 'timeout', childId, output: '', diagnostic: stoppedDiagnostic() }
      : {
          status: outcome.stopReason,
          childId,
          output: textOf(outcome.output),
          ...outcome.diagnostic === undefined ? {} : { diagnostic: outcome.diagnostic },
        }
  } catch (error) {
    result = { status: 'error', childId, output: '', diagnostic: messageOf(error) }
  }
  // Disposing releases a finished child and stops one that timed out or was cancelled.
  try {
    await activation.dispose()
  } catch (error) {
    result.diagnostic = [result.diagnostic, `子 Agent 清理失败：${messageOf(error)}`].filter(Boolean).join('；')
  }
  return result
}
