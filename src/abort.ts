/**
 * Cancellation helpers shared by the entry skill and the dispatch tool.
 *
 * @module dsh-logalyze/abort
 */

/**
 * Wait for a promise unless the signal aborts first.
 * @param promise - work to wait for; it keeps running after an abort.
 * @param signal - caller cancellation.
 * @returns when the promise settles.
 * @throws the signal's reason when it aborts first.
 */
export async function abortable(promise: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
  if (signal === undefined) return await promise
  signal.throwIfAborted()
  let onAbort: (() => void) | undefined
  try {
    await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      onAbort = () => { reject(signal.reason) }
      signal.addEventListener('abort', onAbort, { once: true })
    })])
  } finally {
    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort)
  }
}
