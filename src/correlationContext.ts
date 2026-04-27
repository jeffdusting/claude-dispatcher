/**
 * Correlation-ID propagation context (Phase A.11, Δ DA-013, OD-027).
 *
 * Stores a correlation ID for the duration of a logical unit of work
 * (a runSession invocation, a kickoff handler, a continuation timer
 * callback) so downstream emitters — logs, Discord footers, Drive
 * appProperties, trace blocks, Paperclip task context — can read it
 * without every caller passing the ID through their argument lists.
 *
 * Implementation uses Node's AsyncLocalStorage. Bun supports the API.
 *
 * The store is keyed by AsyncLocalStorage rather than module-level state
 * so concurrent runSession invocations (the gateway processes multiple
 * threads in parallel) do not interleave their IDs.
 */

import { AsyncLocalStorage } from 'async_hooks'

interface CorrelationFrame {
  correlationId: string
}

const als = new AsyncLocalStorage<CorrelationFrame>()

/**
 * Run `fn` inside a correlation scope. All log emissions, Discord
 * sends, Drive uploads, and trace-block writes that occur inside `fn`
 * (or any awaited promise inside it) inherit the correlation ID via
 * `getCorrelationId()` without explicit threading.
 */
export function withCorrelation<T>(
  correlationId: string,
  fn: () => T | Promise<T>,
): T | Promise<T> {
  return als.run({ correlationId }, fn)
}

/** Returns the correlation ID for the currently running scope, if any. */
export function getCorrelationId(): string | undefined {
  return als.getStore()?.correlationId
}
