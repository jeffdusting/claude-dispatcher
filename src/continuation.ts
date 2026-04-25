/**
 * Autonomous continuation protocol.
 *
 * Problem: the dispatcher spawns `claude -p` as a one-shot process per
 * message. When the agent finishes its response, the process exits. There
 * is no mechanism for the agent to keep working between user messages —
 * and Claude Code's in-process ScheduleWakeup fires into a dead process,
 * so it's a no-op in this deployment.
 *
 * Solution: a simple JSON file protocol. Before ending its response, an
 * agent writes a continuation descriptor to a per-thread file. After the
 * session turn completes, the dispatcher picks the file up, schedules a
 * setTimeout, and at fire-time re-invokes the session with the stored
 * prompt (resuming the same Claude session ID). The agent can continue
 * autonomously until it writes no further continuation file.
 *
 * File path: `state/continuations/<threadId>.json`
 * Passed to the child as env var CLAUDE_CONTINUE_FILE (per-session path).
 *
 * Schema:
 *   {
 *     "delay_seconds": 900,           // 60..3600, clamped
 *     "reason": "short one-line",     // shown to user in Discord
 *     "prompt": "full prompt to fire", // the agent's self-continuation prompt
 *     "thread_id": "1495...",         // sanity check
 *     "created_at": "2026-04-22T11:48:00Z"
 *   }
 *
 * Failure modes:
 *   - Malformed JSON → logged, file deleted, no continuation scheduled
 *   - delay_seconds out of range → clamped to [60, 3600]
 *   - thread_id mismatch → logged, no continuation scheduled (guards against
 *     cross-thread collisions)
 *   - File still present at dispatcher shutdown → persisted in sessions.json
 *     so it survives a restart
 */

import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync } from 'fs'
import { join } from 'path'
import { STATE_DIR } from './config.js'
import { logDispatcher } from './logger.js'

export const CONTINUATION_DIR = join(STATE_DIR, 'continuations')
mkdirSync(CONTINUATION_DIR, { recursive: true })

export interface ContinuationDescriptor {
  delaySeconds: number
  reason: string
  prompt: string
  threadId: string
  createdAt: string
}

const MIN_DELAY_SECONDS = 60
const MAX_DELAY_SECONDS = 3600
const MAX_REASON_LENGTH = 200
const MAX_PROMPT_LENGTH = 10_000

/** Absolute path of the per-thread continuation file. */
export function continuationFilePath(threadId: string): string {
  // Safety: ensure threadId is purely digits (Discord snowflake) or simple
  // alphanumeric; refuse path-traversal characters.
  if (!/^[A-Za-z0-9_-]+$/.test(threadId)) {
    throw new Error(`Invalid threadId for continuation file: ${threadId}`)
  }
  return join(CONTINUATION_DIR, `${threadId}.json`)
}

/**
 * Read and consume (delete) the continuation file for this thread.
 *
 * Returns null if no file, malformed, or validation failed. Never throws —
 * all errors are logged; a failed read must not break normal turn flow.
 */
export function readAndConsumeContinuation(threadId: string): ContinuationDescriptor | null {
  let path: string
  try {
    path = continuationFilePath(threadId)
  } catch (err) {
    logDispatcher('continuation_path_error', { threadId, error: String(err) })
    return null
  }

  if (!existsSync(path)) return null

  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (err) {
    logDispatcher('continuation_read_failed', { threadId, error: String(err) })
    _tryDelete(path)
    return null
  }

  // Delete immediately after read to prevent double-fire on retry paths
  _tryDelete(path)

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    logDispatcher('continuation_parse_failed', {
      threadId,
      error: String(err),
      rawPreview: raw.slice(0, 200),
    })
    return null
  }

  if (!parsed || typeof parsed !== 'object') {
    logDispatcher('continuation_not_object', { threadId })
    return null
  }

  // Accept both camelCase and snake_case for agent friendliness
  const p = parsed as Record<string, unknown>
  const delaySecondsRaw = p.delay_seconds ?? p.delaySeconds
  const reasonRaw = p.reason
  const promptRaw = p.prompt
  const threadIdInFile = p.thread_id ?? p.threadId ?? threadId
  const createdAtRaw = p.created_at ?? p.createdAt ?? new Date().toISOString()

  if (typeof delaySecondsRaw !== 'number' || !Number.isFinite(delaySecondsRaw)) {
    logDispatcher('continuation_missing_delay', { threadId })
    return null
  }
  if (typeof promptRaw !== 'string' || promptRaw.length === 0) {
    logDispatcher('continuation_missing_prompt', { threadId })
    return null
  }
  if (typeof reasonRaw !== 'string' || reasonRaw.length === 0) {
    logDispatcher('continuation_missing_reason', { threadId })
    return null
  }
  if (String(threadIdInFile) !== threadId) {
    logDispatcher('continuation_thread_mismatch', {
      expected: threadId,
      got: String(threadIdInFile),
    })
    return null
  }

  const clamped = Math.max(
    MIN_DELAY_SECONDS,
    Math.min(MAX_DELAY_SECONDS, Math.round(delaySecondsRaw)),
  )

  return {
    delaySeconds: clamped,
    reason: String(reasonRaw).slice(0, MAX_REASON_LENGTH),
    prompt: String(promptRaw).slice(0, MAX_PROMPT_LENGTH),
    threadId,
    createdAt: String(createdAtRaw),
  }
}

/**
 * Write a continuation file on behalf of a test/manual caller. Agents
 * normally write this file themselves from inside their session, but this
 * helper is handy for the dispatcher test harness and for scripts/continue.sh.
 */
export function writeContinuation(desc: ContinuationDescriptor): string {
  const path = continuationFilePath(desc.threadId)
  writeFileSync(path, JSON.stringify(desc, null, 2))
  return path
}

function _tryDelete(path: string): void {
  try {
    unlinkSync(path)
  } catch {
    // File may be gone already (race); ignore
  }
}
