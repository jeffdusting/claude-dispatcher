/**
 * Session registry — tracks active Claude sessions mapped to Discord threads.
 * Persists to disk for restart recovery.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import {
  STATE_DIR,
  MAX_TRACKED_SESSIONS,
  MAX_QUEUED_MESSAGES,
  SESSION_IDLE_TIMEOUT_MS,
  SESSION_CLEANUP_MS,
} from './config.js'
import { logSession } from './logger.js'

mkdirSync(STATE_DIR, { recursive: true })

const SESSIONS_FILE = join(STATE_DIR, 'sessions.json')

export type SessionStatus = 'idle' | 'busy' | 'error' | 'expired'

export interface QueuedMessage {
  content: string
  username: string
  timestamp: number
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
}

// In-memory registry
const sessions = new Map<string, SessionEntry>()

// Load persisted state on startup
export function loadSessions(): void {
  try {
    const data = JSON.parse(readFileSync(SESSIONS_FILE, 'utf8')) as SessionEntry[]
    for (const entry of data) {
      // Mark all as idle on restart (we can't reconnect to running processes)
      entry.status = entry.status === 'busy' ? 'idle' : entry.status
      entry.messageQueue = []
      sessions.set(entry.threadId, entry)
    }
    logSession('registry_loaded', { count: sessions.size })
  } catch {
    // No persisted state — fresh start
    logSession('registry_fresh_start')
  }
}

// Persist to disk
function persist(): void {
  try {
    const data = Array.from(sessions.values())
    writeFileSync(SESSIONS_FILE, JSON.stringify(data, null, 2))
  } catch (err) {
    process.stderr.write(`sessions: persist failed: ${err}\n`)
  }
}

// Create a new session entry for a thread
export function createSession(threadId: string, threadName: string): SessionEntry {
  const entry: SessionEntry = {
    threadId,
    sessionId: null,
    threadName,
    status: 'busy',
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
    messageQueue: [],
    turnCount: 0,
    lastError: null,
  }
  sessions.set(threadId, entry)
  persist()
  logSession('session_created', { threadId, threadName })
  return entry
}

// Get session for a thread
export function getSession(threadId: string): SessionEntry | undefined {
  return sessions.get(threadId)
}

// Update session after a turn completes
export function markIdle(threadId: string, sessionId: string): void {
  const entry = sessions.get(threadId)
  if (!entry) return
  entry.sessionId = sessionId
  entry.status = 'idle'
  entry.lastActiveAt = Date.now()
  entry.turnCount++
  persist()
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

// Clear a stale session ID so next attempt creates a fresh session
export function clearSessionId(threadId: string): void {
  const entry = sessions.get(threadId)
  if (!entry) return
  logSession('session_id_cleared', { threadId, oldSessionId: entry.sessionId })
  entry.sessionId = null
  persist()
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

// Clean up expired sessions
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
