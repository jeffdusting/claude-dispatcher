/**
 * Paperclip task-context builder (Phase A.11, Δ DA-013, OD-027).
 *
 * Forward-direction correlation propagation. The reverse direction —
 * Paperclip task IDs flowing back into the dispatcher's project descriptor
 * — was wired in Phase A.6 via `ProjectRecord.paperclipTaskIds`. A.11
 * ensures that when the dispatcher dispatches work to Paperclip, the task
 * context the dispatcher hands over also carries the correlation ID so
 * Paperclip's own audit surface can be stitched back to the originating
 * dispatcher project.
 *
 * The actual Paperclip transport (HTTP API or session pattern) lands in
 * Phase B.4 §5.4.1 once the auth investigation finishes. This module
 * defines the shape and the field-stamping rule so callers built later
 * cannot forget the correlationId.
 */

import { getCorrelationId } from './correlationContext.js'

/**
 * Caller-supplied fields for a Paperclip dispatch. The dispatcher fills in
 * `correlationId` from the active correlation scope; callers must not
 * provide it themselves so the rule remains tamper-evident.
 */
export interface PaperclipDispatchInput {
  /** Dispatcher project this Paperclip task is part of. */
  projectId: string
  /**
   * Title shown in Paperclip's task list. Should be human-readable and
   * stable enough for Paperclip-side reporting.
   */
  title: string
  /** Free-text brief that the Paperclip-side worker reads. */
  brief: string
  /** Optional structured payload Paperclip's API accepts as task params. */
  params?: Record<string, unknown>
}

export interface PaperclipDispatchContext extends PaperclipDispatchInput {
  /** Phase A.11: stamped from active correlation scope. Always populated. */
  correlationId: string
}

/**
 * Build the canonical Paperclip-task context. Throws if no correlation
 * scope is active — dispatching Paperclip work outside a correlation
 * scope is a programming bug, not a runtime error to swallow.
 */
export function buildPaperclipDispatchContext(
  input: PaperclipDispatchInput,
): PaperclipDispatchContext {
  const correlationId = getCorrelationId()
  if (!correlationId) {
    throw new Error(
      'buildPaperclipDispatchContext: no active correlation scope. ' +
        'Wrap the dispatch path in withCorrelation() — see correlationContext.ts.',
    )
  }
  return { ...input, correlationId }
}
