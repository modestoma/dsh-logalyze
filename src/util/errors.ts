/**
 * Error text helpers shared by the tools, the services, and the routes.
 *
 * @module dsh-logalyze/util/errors
 */

/**
 * Readable message of any thrown value.
 * @param error - the thrown value.
 * @returns its message, or its string form when it is not an `Error`.
 */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
