/**
 * Concurrent-worker cap (Phase A.9.5, Δ D-014).
 *
 * Spec (Migration Plan §4.9.5): configurable maximum (default 5); excess
 * requests queued with 30-second wait; busy-message fallback if the queue
 * cannot serve. Configurable via `DISPATCHER_MAX_CONCURRENT_WORKERS` env
 * var.
 *
 * The pre-A.9 dispatcher held a hard cap at `MAX_CONCURRENT_BUSY` and
 * replied immediately when the cap was hit, leaving the user to retry.
 * The new gate keeps the cap but adds a bounded wait so brief spikes do
 * not surface as user-visible "at capacity" messages.
 *
 * Semantics:
 *   - `acquire({ timeoutMs })` resolves to true when a slot is free, or
 *     false if `timeoutMs` elapses with the queue still unserved.
 *   - `release()` MUST be called for every successful acquire (try/finally).
 *   - The gate is process-local; on a restart it starts empty. The session
 *     registry handles cross-restart accounting separately.
 *
 * The implementation deliberately avoids any dependency on `sessions.ts`
 * to keep the cap independent of the session lifecycle (which couples
 * UI-facing state — busy / idle / error / expired — that should not gate
 * worker resource usage).
 */

import { logDispatcher } from './logger.js'

const DEFAULT_MAX_CONCURRENT = 5
const DEFAULT_QUEUE_TIMEOUT_MS = 30_000

function readMax(): number {
  const raw = process.env.DISPATCHER_MAX_CONCURRENT_WORKERS
  if (!raw) return DEFAULT_MAX_CONCURRENT
  const parsed = parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MAX_CONCURRENT
  return parsed
}

let maxConcurrent = readMax()
let active = 0
const waiters: Array<() => void> = []

export interface AcquireOptions {
  /** Milliseconds to wait for a slot. Spec default: 30 000. */
  timeoutMs?: number
  /** Tag for the log event when a request waits or times out. */
  reason?: string
}

export interface AcquireResult {
  acquired: boolean
  waitedMs: number
}

/**
 * Try to take a slot, waiting up to `timeoutMs` for one to free up.
 * Resolves with `acquired: true` once a slot is held and `release()`
 * becomes the caller's obligation; resolves with `acquired: false` on
 * timeout (the caller must NOT call `release()`).
 */
export function acquire(opts: AcquireOptions = {}): Promise<AcquireResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_QUEUE_TIMEOUT_MS
  const start = Date.now()

  if (active < maxConcurrent) {
    active++
    return Promise.resolve({ acquired: true, waitedMs: 0 })
  }

  return new Promise<AcquireResult>((resolve) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      const idx = waiters.indexOf(grant)
      if (idx >= 0) waiters.splice(idx, 1)
      logDispatcher('concurrency_queue_timeout', {
        waitedMs: Date.now() - start,
        active,
        maxConcurrent,
        reason: opts.reason,
      })
      resolve({ acquired: false, waitedMs: Date.now() - start })
    }, timeoutMs)

    function grant(): void {
      if (settled) return
      settled = true
      clearTimeout(timer)
      active++
      resolve({ acquired: true, waitedMs: Date.now() - start })
    }
    waiters.push(grant)
    logDispatcher('concurrency_queued', {
      queueDepth: waiters.length,
      active,
      maxConcurrent,
      timeoutMs,
      reason: opts.reason,
    })
  })
}

export function release(): void {
  if (active > 0) active--
  const next = waiters.shift()
  if (next) next()
}

export function activeCount(): number {
  return active
}

export function queueDepth(): number {
  return waiters.length
}

export function maxConcurrentLimit(): number {
  return maxConcurrent
}

/** Test-only reset. */
export function _resetForTesting(opts?: { max?: number }): void {
  // Resolve any pending waiters with a timeout outcome.
  const pending = waiters.splice(0)
  for (const grant of pending) {
    // Granters that have already settled simply no-op.
    grant()
    // …and we immediately release the granted slot.
    if (active > 0) active--
  }
  active = 0
  maxConcurrent = opts?.max ?? readMax()
}
