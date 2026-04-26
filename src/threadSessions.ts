/**
 * Permanent thread → Claude sessionId mapping.
 *
 * This is the source of truth for resume-ability. It is independent of the
 * live session registry in sessions.ts — which tracks in-flight concurrency
 * state (status, queue, turn counts) and gets aggressively cleaned up.
 *
 * Thread sessions are never cleaned up by the dispatcher. A thread that
 * hasn't been touched for a week can still be resumed, as long as Claude
 * itself still has the underlying session on disk. If Claude has purged
 * the session, the gateway's stale-session recovery path calls
 * forgetSessionId() to blank this mapping and start fresh.
 *
 * Persisted to state/thread_sessions.json on every write.
 */

import { readFileSync, mkdirSync } from 'fs'
import { writeJsonAtomic } from './atomicWrite.js'
import { join } from 'path'
import { STATE_DIR } from './config.js'
import { logSession } from './logger.js'

mkdirSync(STATE_DIR, { recursive: true })

const THREAD_SESSIONS_FILE = join(STATE_DIR, 'thread_sessions.json')

export interface ThreadSessionRecord {
  threadId: string
  sessionId: string | null
  threadName: string
  createdAt: number
  lastUsedAt: number
  turnCount: number
  /**
   * Optional Claude agent override for this thread. When set, the dispatcher
   * spawns `claude -p --agent <agent>` instead of the default chief-of-staff.
   * Used by project mode to route a dedicated project thread to the
   * project-manager agent.
   */
  agent?: string
  /**
   * Optional project ID this thread belongs to. Used by the PM to locate
   * its state file and by operator tooling to correlate threads with
   * projects.
   */
  projectId?: string
}

// In-memory index; writes are flushed to disk immediately.
const records = new Map<string, ThreadSessionRecord>()

export function loadThreadSessions(): void {
  try {
    const data = JSON.parse(readFileSync(THREAD_SESSIONS_FILE, 'utf8')) as ThreadSessionRecord[]
    for (const record of data) {
      records.set(record.threadId, record)
    }
    logSession('thread_sessions_loaded', { count: records.size })
  } catch {
    logSession('thread_sessions_fresh_start')
  }
}

function persist(): void {
  // Atomic write per D-001 audit (Phase A.4).
  try {
    const data = Array.from(records.values())
    writeJsonAtomic(THREAD_SESSIONS_FILE, data)
  } catch (err) {
    process.stderr.write(`threadSessions: persist failed: ${err}\n`)
  }
}

/**
 * Ensure a record exists for this thread. Called when a thread is first
 * created — we don't have a sessionId yet, but we want to register the
 * thread so lookups work once the first turn completes.
 */
export function rememberThread(
  threadId: string,
  threadName: string,
  opts?: { agent?: string; projectId?: string },
): ThreadSessionRecord {
  const existing = records.get(threadId)
  if (existing) {
    let changed = false
    if (threadName && existing.threadName !== threadName) {
      existing.threadName = threadName
      changed = true
    }
    if (opts?.agent && existing.agent !== opts.agent) {
      existing.agent = opts.agent
      changed = true
    }
    if (opts?.projectId && existing.projectId !== opts.projectId) {
      existing.projectId = opts.projectId
      changed = true
    }
    if (changed) persist()
    return existing
  }
  const record: ThreadSessionRecord = {
    threadId,
    sessionId: null,
    threadName,
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
    turnCount: 0,
    ...(opts?.agent ? { agent: opts.agent } : {}),
    ...(opts?.projectId ? { projectId: opts.projectId } : {}),
  }
  records.set(threadId, record)
  persist()
  logSession('thread_session_remembered', {
    threadId,
    threadName,
    agent: opts?.agent,
    projectId: opts?.projectId,
  })
  return record
}

/**
 * Record the sessionId returned by Claude after a turn. This is what makes
 * the thread resumable across dispatcher restarts and live-registry cleanup.
 */
export function recordSessionId(
  threadId: string,
  sessionId: string,
  threadName?: string,
): void {
  let record = records.get(threadId)
  if (!record) {
    record = {
      threadId,
      sessionId,
      threadName: threadName ?? 'Unknown',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      turnCount: 1,
    }
    records.set(threadId, record)
  } else {
    record.sessionId = sessionId
    record.lastUsedAt = Date.now()
    record.turnCount++
    if (threadName && record.threadName !== threadName) {
      record.threadName = threadName
    }
  }
  persist()
}

export function getThreadSessionId(threadId: string): string | null {
  return records.get(threadId)?.sessionId ?? null
}

export function getThreadRecord(threadId: string): ThreadSessionRecord | undefined {
  return records.get(threadId)
}

/**
 * Clear the sessionId for a thread while keeping the thread record. Used on
 * stale-session recovery: the old Claude session is gone, but we still want
 * to remember this thread so future turns land in the same permanent record.
 */
export function forgetSessionId(threadId: string): void {
  const record = records.get(threadId)
  if (!record) return
  logSession('thread_session_forgotten', { threadId, oldSessionId: record.sessionId })
  record.sessionId = null
  record.lastUsedAt = Date.now()
  persist()
}

/** Count of known threads (permanent mapping size). */
export function threadSessionCount(): number {
  return records.size
}
