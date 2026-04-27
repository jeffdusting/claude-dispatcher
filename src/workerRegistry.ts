/**
 * Worker registry (Phase A.9.4, Δ D-004; A.9.6 memory observation, Δ D-014).
 *
 * In-memory map keyed by Discord thread ID, recording each spawned Claude
 * subprocess: PID, project, entity, start time, last heartbeat, last
 * sampled RSS, status. Powers three operational concerns:
 *
 *  - Periodic orphan sweep — no stream output for `HUNG_THRESHOLD_MS`
 *    flips status to `'orphaned'` and emits a structured log event so the
 *    alerting layer (component 8) has a hook to act on. Surfacing only,
 *    no kill.
 *
 *  - Periodic memory sweep (A.9.6) — samples each running worker's RSS
 *    every `WORKER_MEMORY_SAMPLE_INTERVAL_MS`. RSS ≥ warn threshold logs
 *    `worker_memory_warn` (rate-limited per record); RSS ≥ kill threshold
 *    SIGTERMs the subprocess, logs `worker_memory_killed`, and unregisters
 *    via the existing `unregisterWorker(threadId, 'killed', reason)` path.
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
 */

import { logDispatcher } from './logger.js'
import type { Entity } from './entity.js'
import {
  WORKER_MEMORY_WARN_BYTES,
  WORKER_MEMORY_KILL_BYTES,
  WORKER_MEMORY_SAMPLE_INTERVAL_MS,
} from './config.js'

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
  /** Most recent RSS sample, in bytes. */
  lastMemoryRssBytes?: number
  /** Wall-clock of the most recent RSS sample. */
  lastMemorySampledAt?: number
  /** Wall-clock of the last warn emission for this record (rate-limit). */
  memoryWarnedAt?: number
}

/**
 * Probe + killer used by the memory sweep. Pulled into a single object so
 * the smoke test can substitute a deterministic stub without spawning ps
 * or signalling real PIDs.
 */
export interface MemoryProbe {
  /** Returns RSS in bytes for `pid`, or 0 when the pid cannot be inspected. */
  sampleRss: (pid: number) => Promise<number>
  /** Sends SIGTERM to `pid`. Errors are swallowed (the worker may have just exited). */
  kill: (pid: number) => void
}

const defaultMemoryProbe: MemoryProbe = {
  async sampleRss(pid: number): Promise<number> {
    // `ps -o rss= -p PID` returns RSS in kilobytes on macOS and Linux.
    // The trailing `=` suppresses the column header so the output is the
    // single integer.
    try {
      const proc = Bun.spawn(['ps', '-o', 'rss=', '-p', String(pid)], {
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const text = await new Response(proc.stdout).text()
      const exitCode = await proc.exited
      if (exitCode !== 0) return 0
      const kb = parseInt(text.trim(), 10)
      if (!Number.isFinite(kb) || kb <= 0) return 0
      return kb * 1024
    } catch {
      return 0
    }
  },
  kill(pid: number): void {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      // pid already gone — sweep continues and the unregister-via-exit path cleans up.
    }
  },
}

const HUNG_THRESHOLD_MS_DEFAULT = 5 * 60 * 1000  // 5 minutes without a stream chunk
const SWEEP_INTERVAL_MS_DEFAULT = 60 * 1000       // sweep every minute
const MEMORY_WARN_REPEAT_MS = 5 * 60 * 1000       // do not re-warn the same record more often than this

let hungThresholdMs = HUNG_THRESHOLD_MS_DEFAULT
let sweepHandle: ReturnType<typeof setInterval> | null = null
let memoryHandle: ReturnType<typeof setInterval> | null = null
let memoryProbe: MemoryProbe = defaultMemoryProbe
const workers: Map<string, WorkerRecord> = new Map()

export function _resetForTesting(opts?: {
  hungThresholdMs?: number
  memoryProbe?: MemoryProbe
}): void {
  workers.clear()
  if (sweepHandle) {
    clearInterval(sweepHandle)
    sweepHandle = null
  }
  if (memoryHandle) {
    clearInterval(memoryHandle)
    memoryHandle = null
  }
  hungThresholdMs = opts?.hungThresholdMs ?? HUNG_THRESHOLD_MS_DEFAULT
  memoryProbe = opts?.memoryProbe ?? defaultMemoryProbe
}

/** Test seam — replace the probe without resetting the registry. */
export function setMemoryProbeForTesting(probe: MemoryProbe): void {
  memoryProbe = probe
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
 * One pass of the memory observation sweep (Phase A.9.6, Δ D-014).
 *
 * For each running worker, samples RSS via the configured probe. RSS at or
 * above WORKER_MEMORY_WARN_BYTES emits `worker_memory_warn` (rate-limited
 * per record so a stuck-near-threshold worker does not spam logs); RSS at
 * or above WORKER_MEMORY_KILL_BYTES emits `worker_memory_killed`, sends
 * SIGTERM via the probe, and unregisters the worker with status 'killed'
 * — the existing exit-path unregister becomes a no-op once the subprocess
 * dies because the record is already gone.
 *
 * Sample failures (pid no longer present, ps non-zero) are tolerated —
 * the next sweep retries, and the orphan sweep picks up workers that have
 * truly silenced.
 *
 * Returns counts of warn / kill emissions for caller logging.
 */
export async function sweepMemory(now: number = Date.now()): Promise<{ warned: number; killed: number; sampled: number }> {
  let warned = 0
  let killed = 0
  let sampled = 0

  // Snapshot the running set before any await so concurrent registry edits
  // do not perturb the iteration.
  const targets: WorkerRecord[] = []
  for (const rec of workers.values()) {
    if (rec.status === 'running') targets.push(rec)
  }

  for (const rec of targets) {
    let rss = 0
    try {
      rss = await memoryProbe.sampleRss(rec.pid)
    } catch (err) {
      logDispatcher('worker_memory_sample_error', {
        threadId: rec.threadId,
        pid: rec.pid,
        error: String(err),
      })
      continue
    }
    if (rss <= 0) continue

    sampled++
    rec.lastMemoryRssBytes = rss
    rec.lastMemorySampledAt = now

    if (rss >= WORKER_MEMORY_KILL_BYTES) {
      const reason = `memory ${(rss / (1024 * 1024 * 1024)).toFixed(2)} GB exceeded kill threshold ${(WORKER_MEMORY_KILL_BYTES / (1024 * 1024 * 1024)).toFixed(2)} GB`
      logDispatcher('worker_memory_killed', {
        threadId: rec.threadId,
        pid: rec.pid,
        projectId: rec.projectId,
        entity: rec.entity,
        rssBytes: rss,
        thresholdBytes: WORKER_MEMORY_KILL_BYTES,
      })
      memoryProbe.kill(rec.pid)
      unregisterWorker(rec.threadId, 'killed', reason)
      killed++
      continue
    }

    if (rss >= WORKER_MEMORY_WARN_BYTES) {
      const last = rec.memoryWarnedAt ?? 0
      if (now - last >= MEMORY_WARN_REPEAT_MS) {
        logDispatcher('worker_memory_warn', {
          threadId: rec.threadId,
          pid: rec.pid,
          projectId: rec.projectId,
          entity: rec.entity,
          rssBytes: rss,
          thresholdBytes: WORKER_MEMORY_WARN_BYTES,
        })
        rec.memoryWarnedAt = now
        warned++
      }
    }
  }

  return { warned, killed, sampled }
}

export function startMemorySweep(intervalMs: number = WORKER_MEMORY_SAMPLE_INTERVAL_MS): void {
  if (memoryHandle) return
  memoryHandle = setInterval(() => {
    sweepMemory().catch((err) => {
      logDispatcher('worker_memory_sweep_error', { error: String(err) })
    })
  }, intervalMs)
}

export function stopMemorySweep(): void {
  if (!memoryHandle) return
  clearInterval(memoryHandle)
  memoryHandle = null
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
