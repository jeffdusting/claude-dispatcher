/**
 * Partial-failure recovery — post-turn side effect tracking (Phase A.9.3,
 * Δ D-003).
 *
 * Reference scenario (25 April 2026 incident): a worker stream completes
 * the Drive save, but the project-complete (Discord) post never lands —
 * Anthropic returned 529 between the two side effects. The user observes
 * silence; the artefacts are in Drive but the thread shows nothing.
 *
 * The recovery framework records, per session turn, which downstream side
 * effects have completed and which are pending. After every successful
 * subprocess run, the dispatcher writes a `pendingSideEffects` blob into
 * the session entry holding:
 *
 *   - the captured response text,
 *   - the outbox files snapshotted on the run,
 *   - per-side-effect completion flags (response posted, outbox uploaded,
 *     attachments sent),
 *   - the resolved entity for Drive routing.
 *
 * Each side effect updates its flag and persists. When all complete, the
 * blob is cleared. On dispatcher boot, `index.ts` walks the session
 * registry, reads any incomplete blob, and replays the missing side
 * effects against the resolved channel — the user sees the response that
 * was previously stranded between Drive and Discord.
 *
 * The migration plan §4.9.3 references "the project descriptor" as the
 * persistence target. The session-entry-level persistence used here is
 * the dispatcher-side analogue and covers the 25 April incident class.
 * Project-task-level side-effect tracking (each ProjectTask records its
 * own side effects) extends this framework in a later session.
 */

import {
  getSession,
  setPendingSideEffects,
  clearPendingSideEffects,
  type PendingSideEffects,
  type SideEffectStatus,
} from './sessions.js'
import type { Entity } from './entity.js'
import type { OutputFile } from './claude.js'
import { logDispatcher } from './logger.js'

export type { PendingSideEffects, SideEffectStatus } from './sessions.js'

export interface SideEffectInputs {
  threadId: string
  responseText: string
  outboxFiles: OutputFile[]
  entity: Entity
  /** When the turn was a continuation, the reason — for telemetry only. */
  continuationReason?: string | null
}

/**
 * Record the start of a turn's post-run side effects. Call this BEFORE the
 * first side effect (typically immediately after `runSession` resolves)
 * so that a crash between runSession returning and the first post-back
 * leaves a recoverable record on disk.
 */
export function beginPostTurn(opts: SideEffectInputs): void {
  const pending: PendingSideEffects = {
    capturedAt: Date.now(),
    responseText: opts.responseText,
    outboxFiles: opts.outboxFiles.map((f) => ({ path: f.path, name: f.name })),
    entity: opts.entity,
    continuationReason: opts.continuationReason ?? null,
    status: {
      responsePosted: false,
      outboxUploaded: opts.outboxFiles.length === 0,
      attachmentsSent: opts.outboxFiles.length === 0,
    },
  }
  setPendingSideEffects(opts.threadId, pending)
}

/**
 * Mark a side effect as complete and persist. When every flag is true the
 * blob is cleared so the next turn starts with a clean slate.
 */
export function markSideEffect(
  threadId: string,
  flag: keyof SideEffectStatus,
): void {
  const session = getSession(threadId)
  const pending = session?.pendingSideEffects
  if (!session || !pending) return

  pending.status[flag] = true
  if (
    pending.status.responsePosted &&
    pending.status.outboxUploaded &&
    pending.status.attachmentsSent
  ) {
    clearPendingSideEffects(threadId)
    return
  }
  setPendingSideEffects(threadId, pending)
}

/**
 * Inspect any pending side effects for a thread (for the boot-time replay
 * pass). Returns null when nothing is pending.
 */
export function getPendingSideEffects(threadId: string): PendingSideEffects | null {
  return getSession(threadId)?.pendingSideEffects ?? null
}

/**
 * Drop the pending blob without replaying — used when the next turn
 * supersedes any unfinished side effects (the user has typed something new
 * that makes replaying the stale response wasteful).
 */
export function discardPendingSideEffects(threadId: string, reason: string): void {
  const pending = getSession(threadId)?.pendingSideEffects
  if (!pending) return
  logDispatcher('side_effects_discarded', {
    threadId,
    reason,
    capturedAt: pending.capturedAt,
    status: pending.status,
  })
  clearPendingSideEffects(threadId)
}
