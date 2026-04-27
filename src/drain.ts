/**
 * Graceful shutdown drain (Phase A.9.7, Δ D-008).
 *
 * Owns the dispatcher-wide drain flag and the helpers that wait for
 * in-flight workers to complete before the process exits. The flag is
 * checked at the inbound boundaries (gateway message handler, kickoff
 * dispatch, concurrency gate acquire) so SIGTERM stops accepting new
 * work the moment it is observed; the worker registry then reports
 * what is in-flight and `awaitWorkersDrained()` waits up to the
 * configured budget for those workers to finish on their own.
 *
 * Anything still running when the budget elapses is hard-killed via
 * SIGKILL with status `killed` and reason `drain timeout` so the
 * worker-registry log line distinguishes a deliberate kill from a
 * crash. State files are flushed atomically in `index.ts` after the
 * drain returns.
 *
 * Lives in its own module so health.ts (HTTP probe), gateway.ts
 * (inbound boundary), concurrencyGate.ts (acquire boundary), and
 * index.ts (shutdown sequence) can all reach the flag without import
 * cycles. The flag is process-local; on restart the new process boots
 * with `draining=false` and reconcileOnBoot in workerRegistry handles
 * any workers that survived the previous process death.
 */

import { logDispatcher } from './logger.js'
import {
  activeWorkerCount,
  listWorkers,
  unregisterWorker,
} from './workerRegistry.js'

const DEFAULT_DRAIN_TIMEOUT_MS = 90_000  // Migration Plan §4.9.7
const DEFAULT_POLL_MS = 500

let draining = false

/**
 * Flip the dispatcher into drain mode. Idempotent. Once set, the flag
 * remains set for the life of the process — a draining dispatcher
 * never re-opens for traffic; it exits.
 */
export function markDraining(): void {
  if (draining) return
  draining = true
  logDispatcher('drain_started', { activeWorkers: activeWorkerCount() })
}

export function isDraining(): boolean {
  return draining
}

export interface DrainOptions {
  /** Hard cap on time spent waiting for workers. Default: 90 000ms (spec). */
  timeoutMs?: number
  /** Poll cadence while waiting. Default: 500ms. */
  pollMs?: number
}

export interface DrainResult {
  drainedCleanly: boolean
  waitedMs: number
  killedCount: number
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Wait for in-flight workers to complete. Resolves cleanly once
 * `activeWorkerCount()` hits zero. If `timeoutMs` elapses with workers
 * still running, force-kills the remainder via SIGKILL and resolves
 * with `drainedCleanly: false`. The caller is expected to follow the
 * call with state-file flushes.
 *
 * Safe to call without `markDraining()` first (e.g. test paths), but
 * production callers should always flip the flag first so new work is
 * rejected at the inbound boundaries while the wait runs.
 */
export async function awaitWorkersDrained(
  opts: DrainOptions = {},
): Promise<DrainResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS
  const start = Date.now()

  while (Date.now() - start < timeoutMs) {
    if (activeWorkerCount() === 0) {
      const waitedMs = Date.now() - start
      logDispatcher('drain_complete', { waitedMs })
      return { drainedCleanly: true, waitedMs, killedCount: 0 }
    }
    await sleep(pollMs)
  }

  // Timeout elapsed — kill anything still running.
  const survivors = listWorkers().filter((w) => w.status === 'running')
  for (const w of survivors) {
    try {
      process.kill(w.pid, 'SIGKILL')
    } catch (err) {
      // ESRCH means the process is already gone; anything else is logged.
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'ESRCH') {
        logDispatcher('drain_kill_failed', {
          threadId: w.threadId,
          pid: w.pid,
          error: String(err),
        })
      }
    }
    unregisterWorker(w.threadId, 'killed', 'drain timeout')
  }

  const waitedMs = Date.now() - start
  logDispatcher('drain_timeout', {
    waitedMs,
    killed: survivors.length,
    killedThreads: survivors.map((w) => w.threadId),
  })
  return {
    drainedCleanly: false,
    waitedMs,
    killedCount: survivors.length,
  }
}

/** Test-only reset. */
export function _resetDrainForTesting(): void {
  draining = false
}
