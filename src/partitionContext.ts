/**
 * Partition-binding propagation context (Migration Plan §14.4.3, Phase J.1b).
 *
 * Stores the active EA partition for the duration of a Discord-message
 * handling flow so downstream callers — `runSession()` in particular —
 * can pick up the partition's `claudeAgent` without every gateway path
 * threading the partition through their argument lists.
 *
 * Set once by the gateway after the identity-binding resolver returns an
 * `allow` decision; read by `runSession()` to resolve the per-EA agent
 * name. The store is keyed by AsyncLocalStorage rather than module-level
 * state so concurrent gateway invocations across multiple threads do not
 * interleave their partition assignments.
 *
 * Pattern mirrors `correlationContext.ts` (Phase A.11) — same primitive,
 * same lifecycle, same testing seam (`_resetPartitionForTesting`).
 */

import { AsyncLocalStorage } from 'async_hooks'

interface PartitionFrame {
  partition: string
}

const als = new AsyncLocalStorage<PartitionFrame>()

/**
 * Run `fn` inside a partition scope. All `runSession()` calls that occur
 * inside `fn` (or any awaited promise inside it) resolve their agent
 * defaults via `getCurrentPartition()` → `agentForPartition()` without
 * explicit threading.
 */
export function withPartition<T>(
  partition: string,
  fn: () => T | Promise<T>,
): T | Promise<T> {
  return als.run({ partition }, fn)
}

/** Returns the partition for the currently running scope, if any. */
export function getCurrentPartition(): string | undefined {
  return als.getStore()?.partition
}
