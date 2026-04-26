/**
 * Live session registry — tracks in-flight Claude sessions per Discord thread.
 *
 * This registry handles concurrency, queuing and status tracking. Entries are
 * aggressively cleaned up after idle timeouts as a pure performance
 * optimisation — removing a live entry does NOT affect resume-ability.
 *
 * The permanent thread → sessionId mapping (the source of truth for resume)
 * lives in threadSessions.ts and is never cleaned up. When a cleaned-up
 * thread receives a new message, the gateway re-seeds a live entry from the
 * permanent mapping and resumes the original Claude session.
 *
 * Persists in-flight state to state/sessions.json so a restart mid-turn
 * doesn't lose queue state. The authoritative sessionId is always written
 * through to the permanent mapping as well.
 */

import { readFileSync, mkdirSync } from 'fs'
import { writeJsonAtomic } from './atomicWrite.js'
import { join } from 'path'
import {
  STATE_DIR,
  MAX_TRACKED_SESSIONS,
  MAX_QUEUED_MESSAGES,
  SESSION_IDLE_TIMEOUT_MS,
  SESSION_CLEANUP_MS,
} from './config.js'
import { logSession } from './logger.js'
import {
  rememberThread,
  recordSessionId,
  forgetSessionId,
  getThreadRecord,
} from './threadSessions.js'

mkdirSync(STATE_DIR, { recursive: true })

const SESSIONS_FILE = join(STATE_DIR, 'sessions.json')

export type SessionStatus = 'idle' | 'busy' | 'error' | 'expired'

export interface QueuedMessage {
  content: string
  username: string
  timestamp: number
}

export interface PendingContinuation {
  fireAtMs: number
  prompt: string
  reason: string
  scheduledAtMs: number
}

export interface SessionEntry {
  threadId: string
  sessionId: string | null    // null until first response captured
  threadName: string
  status: SessionStatus
  createdAt: number
  lastActiveAt: number
  messageQueue: QueuedMessage[]
  turnCount: number
  lastError: string | null
  /**
   * Scheduled autonomous continuation. When non-null, the dispatcher has
   * a setTimeout armed to re-invoke this session at fireAtMs with `prompt`.
   * Persisted across restarts — on boot the dispatcher re-arms the timer
   * (or fires immediately if the deadline has already passed).
   */
  pendingContinuation?: PendingContinuation | null
}

// In-memory registry
const sessions = new Map<string, SessionEntry>()

// Load persisted state on startup. Reconciles sessionId from the permanent
// mapping if present — threadSessions.json is the source of truth for resume.
export function loadSessions(): void {
  try {
    const data = JSON.parse(readFileSync(SESSIONS_FILE, 'utf8')) as SessionEntry[]
    for (const entry of data) {
      // Mark all as idle on restart (we can't reconnect to running processes)
      entry.status = entry.status === 'busy' ? 'idle' : entry.status
      entry.messageQueue = []

      // Prefer the sessionId from the permanent mapping. The live registry
      // may be stale if a turn completed but the process died before
      // markIdle() was observed.
      const permanent = getThreadRecord(entry.threadId)
      if (permanent?.sessionId) {
        entry.sessionId = permanent.sessionId
      } else if (entry.sessionId) {
        // First-run migration: live registry has a sessionId but the
        // permanent mapping doesn't know about it yet. Promote it now so
        // we never lose resume-ability.
        recordSessionId(entry.threadId, entry.sessionId, entry.threadName)
      }

      sessions.set(entry.threadId, entry)
    }
    logSession('registry_loaded', { count: sessions.size })
  } catch {
    // No persisted state — fresh start
    logSession('registry_fresh_start')
  }
}

// Persist to disk. Atomic write per D-001 audit (Phase A.4).
function persist(): void {
  try {
    const data = Array.from(sessions.values())
    writeJsonAtomic(SESSIONS_FILE, data)
  } catch (err) {
    process.stderr.write(`sessions: persist failed: ${err}\n`)
  }
}

// Create a new session entry for a thread. If a permanent record exists for
// this threadId, the live entry is seeded from it so resume continues to work
// after the live entry was previously cleaned up.
export function createSession(threadId: string, threadName: string): SessionEntry {
  const permanent = getThreadRecord(threadId) ?? rememberThread(threadId, threadName)
  const entry: SessionEntry = {
    threadId,
    sessionId: permanent.sessionId,
    threadName: permanent.threadName || threadName,
    status: 'busy',
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
    messageQueue: [],
    turnCount: permanent.turnCount,
    lastError: null,
  }
  sessions.set(threadId, entry)
  persist()
  logSession('session_created', {
    threadId,
    threadName: entry.threadName,
    resumingSessionId: entry.sessionId ?? null,
  })
  return entry
}

// Get session for a thread
export function getSession(threadId: string): SessionEntry | undefined {
  return sessions.get(threadId)
}

/**
 * Get the live entry for a thread, or create one seeded from the permanent
 * mapping if we have no live entry but do have a known sessionId. Returns
 * undefined only if the thread is entirely unknown to us.
 *
 * Use this from the gateway on follow-up messages: it transparently handles
 * the case where the live registry was cleaned up but the thread is still
 * resumable via threadSessions.
 */
export function getOrResumeSession(threadId: string): SessionEntry | undefined {
  const live = sessions.get(threadId)
  if (live) return live
  const permanent = getThreadRecord(threadId)
  if (!permanent) return undefined
  // Re-seed a live entry from the permanent mapping. Starts idle so the
  // caller can markBusy() before running.
  const entry: SessionEntry = {
    threadId,
    sessionId: permanent.sessionId,
    threadName: permanent.threadName,
    status: 'idle',
    createdAt: permanent.createdAt,
    lastActiveAt: permanent.lastUsedAt,
    messageQueue: [],
    turnCount: permanent.turnCount,
    lastError: null,
  }
  sessions.set(threadId, entry)
  persist()
  logSession('session_rehydrated', {
    threadId,
    threadName: permanent.threadName,
    sessionId: permanent.sessionId,
  })
  return entry
}

// Update session after a turn completes. Writes the sessionId through to
// the permanent mapping so the thread stays resumable forever.
export function markIdle(threadId: string, sessionId: string): void {
  const entry = sessions.get(threadId)
  if (!entry) return
  entry.sessionId = sessionId
  entry.status = 'idle'
  entry.lastActiveAt = Date.now()
  entry.turnCount++
  persist()
  recordSessionId(threadId, sessionId, entry.threadName)
  logSession('session_idle', { threadId, sessionId, turnCount: entry.turnCount })
}

// Mark session as busy (processing a message)
export function markBusy(threadId: string): void {
  const entry = sessions.get(threadId)
  if (!entry) return
  entry.status = 'busy'
  entry.lastActiveAt = Date.now()
  persist()
}

// Mark session as errored
export function markError(threadId: string, error: string): void {
  const entry = sessions.get(threadId)
  if (!entry) return
  entry.status = 'error'
  entry.lastActiveAt = Date.now()
  entry.lastError = error
  persist()
  logSession('session_error', { threadId, error })
}

// Record a pending continuation on the session (called by gateway when
// it schedules a setTimeout). Persisted so it survives a restart.
export function setPendingContinuation(
  threadId: string,
  cont: PendingContinuation,
): void {
  const entry = sessions.get(threadId)
  if (!entry) return
  entry.pendingContinuation = cont
  persist()
  logSession('continuation_scheduled', {
    threadId,
    fireAtMs: cont.fireAtMs,
    reason: cont.reason,
  })
}

// Clear the pending continuation (called when the timer fires, or when
// the user sends a new message that supersedes it).
export function clearPendingContinuation(threadId: string): PendingContinuation | null {
  const entry = sessions.get(threadId)
  if (!entry) return null
  const prev = entry.pendingContinuation ?? null
  entry.pendingContinuation = null
  persist()
  if (prev) {
    logSession('continuation_cleared', { threadId, reason: prev.reason })
  }
  return prev
}

// List all pending continuations at boot, so index.ts can re-arm their timers.
export function listPendingContinuations(): Array<{ threadId: string; cont: PendingContinuation }> {
  const out: Array<{ threadId: string; cont: PendingContinuation }> = []
  for (const entry of sessions.values()) {
    if (entry.pendingContinuation) {
      out.push({ threadId: entry.threadId, cont: entry.pendingContinuation })
    }
  }
  return out
}

// Clear a stale session ID so next attempt creates a fresh session.
// Also forgets the sessionId in the permanent mapping — the thread record
// itself is kept so future turns land in the same permanent row.
export function clearSessionId(threadId: string): void {
  const entry = sessions.get(threadId)
  if (!entry) return
  logSession('session_id_cleared', { threadId, oldSessionId: entry.sessionId })
  entry.sessionId = null
  persist()
  forgetSessionId(threadId)
}

// Queue a follow-up message when session is busy
export function queueMessage(threadId: string, content: string, username: string): boolean {
  const entry = sessions.get(threadId)
  if (!entry) return false
  if (entry.messageQueue.length >= MAX_QUEUED_MESSAGES) return false
  entry.messageQueue.push({ content, username, timestamp: Date.now() })
  persist()
  logSession('message_queued', { threadId, username, queueLength: entry.messageQueue.length })
  return true
}

// Get current queue depth
export function queueDepth(threadId: string): number {
  return sessions.get(threadId)?.messageQueue.length ?? 0
}

// Drain the message queue (returns combined message or null)
export function drainQueue(threadId: string): { combined: string; username: string } | null {
  const entry = sessions.get(threadId)
  if (!entry || entry.messageQueue.length === 0) return null
  const messages = entry.messageQueue.splice(0)
  persist()
  const username = messages[0]!.username
  if (messages.length === 1) {
    return { combined: messages[0]!.content, username }
  }
  const combined = messages
    .map((m) => `[${m.username}]: ${m.content}`)
    .join('\n\n')
  return { combined, username }
}

// Get a summary of all active sessions (for !status command)
export function getStatusSummary(healthLine?: string): string {
  const lines: string[] = []

  if (healthLine) {
    lines.push(healthLine)
    lines.push('')
  }

  if (sessions.size === 0) {
    lines.push('No active sessions.')
    return lines.join('\n')
  }

  const now = Date.now()

  lines.push(`**Active sessions:** ${sessions.size} (${busyCount()} busy)\n`)

  for (const entry of sessions.values()) {
    const age = Math.round((now - entry.createdAt) / 60_000)
    const idle = Math.round((now - entry.lastActiveAt) / 60_000)
    const statusIcon =
      entry.status === 'busy' ? '🔄' :
      entry.status === 'idle' ? '💤' :
      entry.status === 'error' ? '❌' : '⏰'
    const queueInfo = entry.messageQueue.length > 0
      ? ` (${entry.messageQueue.length} queued)`
      : ''

    lines.push(
      `${statusIcon} **${entry.threadName}**\n` +
      `  Status: ${entry.status}${queueInfo} · ${entry.turnCount} turns · ` +
      `Age: ${age}m · Idle: ${idle}m`
    )
  }

  return lines.join('\n')
}

// Count currently busy sessions
export function busyCount(): number {
  let count = 0
  for (const entry of sessions.values()) {
    if (entry.status === 'busy') count++
  }
  return count
}

// Clean up expired live-registry entries. This is a performance optimisation
// only — the permanent thread → sessionId mapping is untouched, so any
// removed thread remains resumable if a new message arrives later.
export function cleanupSessions(): number {
  const now = Date.now()
  let cleaned = 0
  for (const [threadId, entry] of sessions) {
    if (entry.status === 'busy') continue // don't touch active sessions

    const idleTime = now - entry.lastActiveAt

    if (idleTime > SESSION_CLEANUP_MS) {
      sessions.delete(threadId)
      logSession('session_removed', { threadId, threadName: entry.threadName })
      cleaned++
    } else if (idleTime > SESSION_IDLE_TIMEOUT_MS && entry.status !== 'expired') {
      entry.status = 'expired'
      logSession('session_expired', { threadId, threadName: entry.threadName })
    }
  }

  // Enforce max tracked sessions (remove oldest expired first)
  if (sessions.size > MAX_TRACKED_SESSIONS) {
    const sorted = Array.from(sessions.entries())
      .filter(([, e]) => e.status === 'expired')
      .sort(([, a], [, b]) => a.lastActiveAt - b.lastActiveAt)
    for (const [threadId] of sorted) {
      if (sessions.size <= MAX_TRACKED_SESSIONS) break
      sessions.delete(threadId)
      cleaned++
    }
  }

  if (cleaned > 0) persist()
  return cleaned
}

// Shutdown — persist final state
export function shutdown(): void {
  persist()
  logSession('registry_shutdown', { count: sessions.size })
}
