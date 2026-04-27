/**
 * Worker registry (Phase A.9.4, Δ D-004).
 *
 * In-memory map keyed by Discord thread ID, recording each spawned Claude
 * subprocess: PID, project, entity, start time, last heartbeat, status.
 * Powers two operational concerns:
 *
 *  - Periodic sweep detects hung workers — no stream output for
 *    `HUNG_THRESHOLD_MS` flips status to `'orphaned'` and emits a structured
 *    log event so the alerting layer (component 8 in the next session) has
 *    a hook to act on. The sweep does not kill workers in this iteration —
 *    surfacing is the priority; killing belongs with memory observation
 *    (component 6) which lands later.
 *
 *  - Boot reconciliation: the registry is in-memory, so on restart it
 *    starts empty. `reconcileOnBoot` pairs the empty registry with the
 *    persisted session entries that were `'busy'` at shutdown — those are
 *    treated as orphans (the subprocess is gone with the previous Bun
 *    process) and surface to the partial-failure-recovery framework
 *    (component 3) so any captured side effects can be replayed.
 *
 * Heartbeats are emitted from `claude.ts` on each stream-JSON message — in
 * effect, every assistant chunk or tool-use block bumps `lastHeartbeatAt`.
 *
 * Memory observation (4.9.6 component 6) extends this module with rss
 * sampling and a kill-on-overflow path; out of scope for this session.
 */

import { logDispatcher } from './logger.js'
import type { Entity } from './entity.js'

export type WorkerStatus = 'running' | 'completed' | 'orphaned' | 'killed'

export interface WorkerRecord {
  threadId: string
  pid: number
  /** Project ID if the worker is a project-mode session, else null. */
  projectId: string | null
  entity: Entity
  startedAt: number
  lastHeartbeatAt: number
  status: WorkerStatus
  /** Set when status leaves 'running'. */
  endedAt?: number
  /** Surfaced cause for status transitions away from 'running'. */
  reason?: string
}

const HUNG_THRESHOLD_MS_DEFAULT = 5 * 60 * 1000  // 5 minutes without a stream chunk
const SWEEP_INTERVAL_MS_DEFAULT = 60 * 1000       // sweep every minute

let hungThresholdMs = HUNG_THRESHOLD_MS_DEFAULT
let sweepHandle: ReturnType<typeof setInterval> | null = null
const workers: Map<string, WorkerRecord> = new Map()

export function _resetForTesting(opts?: { hungThresholdMs?: number }): void {
  workers.clear()
  if (sweepHandle) {
    clearInterval(sweepHandle)
    sweepHandle = null
  }
  hungThresholdMs = opts?.hungThresholdMs ?? HUNG_THRESHOLD_MS_DEFAULT
}

export function registerWorker(rec: Omit<WorkerRecord, 'lastHeartbeatAt' | 'status'>): void {
  const now = Date.now()
  const full: WorkerRecord = {
    ...rec,
    lastHeartbeatAt: now,
    status: 'running',
  }
  workers.set(rec.threadId, full)
  logDispatcher('worker_registered', {
    threadId: rec.threadId,
    pid: rec.pid,
    projectId: rec.projectId,
    entity: rec.entity,
  })
}

export function recordHeartbeat(threadId: string): void {
  const rec = workers.get(threadId)
  if (!rec) return
  rec.lastHeartbeatAt = Date.now()
}

export function unregisterWorker(
  threadId: string,
  status: 'completed' | 'killed' = 'completed',
  reason?: string,
): void {
  const rec = workers.get(threadId)
  if (!rec) return
  rec.status = status
  rec.endedAt = Date.now()
  if (reason) rec.reason = reason
  logDispatcher('worker_unregistered', {
    threadId,
    pid: rec.pid,
    status,
    reason,
    durationMs: rec.endedAt - rec.startedAt,
  })
  workers.delete(threadId)
}

export function listWorkers(): WorkerRecord[] {
  return Array.from(workers.values())
}

export function getWorker(threadId: string): WorkerRecord | undefined {
  return workers.get(threadId)
}

export function activeWorkerCount(): number {
  let count = 0
  for (const rec of workers.values()) {
    if (rec.status === 'running') count++
  }
  return count
}

/**
 * One pass of the orphan-detection sweep. Marks any worker whose last
 * heartbeat is older than `hungThresholdMs` as orphaned. Idempotent — a
 * worker that has already been flipped to 'orphaned' is not re-flipped.
 *
 * Returns the number of newly-orphaned workers this pass for the alerting
 * layer to act on (component 8 in a later session).
 */
export function sweepOrphans(now: number = Date.now()): number {
  let orphaned = 0
  for (const rec of workers.values()) {
    if (rec.status !== 'running') continue
    if (now - rec.lastHeartbeatAt < hungThresholdMs) continue
    rec.status = 'orphaned'
    rec.endedAt = now
    rec.reason = `no heartbeat for ${Math.round((now - rec.lastHeartbeatAt) / 1000)}s`
    orphaned++
    logDispatcher('worker_orphaned', {
      threadId: rec.threadId,
      pid: rec.pid,
      projectId: rec.projectId,
      lastHeartbeatAt: rec.lastHeartbeatAt,
      ageSeconds: Math.round((now - rec.lastHeartbeatAt) / 1000),
    })
  }
  return orphaned
}

export function startSweep(intervalMs: number = SWEEP_INTERVAL_MS_DEFAULT): void {
  if (sweepHandle) return
  sweepHandle = setInterval(() => {
    try {
      sweepOrphans()
    } catch (err) {
      logDispatcher('worker_sweep_error', { error: String(err) })
    }
  }, intervalMs)
}

export function stopSweep(): void {
  if (!sweepHandle) return
  clearInterval(sweepHandle)
  sweepHandle = null
}

/**
 * Boot reconciliation. The registry is in-memory; on restart it starts
 * empty. The persisted session registry, however, may carry entries that
 * were `'busy'` at shutdown — those workers are gone with the previous Bun
 * process and need to be surfaced as orphans so the partial-failure
 * recovery framework (component 3) can replay any captured side effects.
 *
 * `previouslyBusyThreads` is the snapshot from `loadSessions()` of which
 * threads were busy. Returns the count for caller logging.
 */
export function reconcileOnBoot(previouslyBusyThreads: string[]): number {
  if (previouslyBusyThreads.length === 0) {
    logDispatcher('worker_reconcile_clean')
    return 0
  }
  logDispatcher('worker_reconcile_orphans', {
    count: previouslyBusyThreads.length,
    threadIds: previouslyBusyThreads,
  })
  return previouslyBusyThreads.length
}
