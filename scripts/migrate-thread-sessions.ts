#!/usr/bin/env bun
/**
 * One-time migration: seed thread_sessions.json from the existing sessions.json.
 *
 * Idempotent — running multiple times is safe; existing thread_sessions rows
 * are preserved (newest-by-lastUsedAt wins if a conflict exists).
 *
 * The dispatcher also performs this promotion inside loadSessions() on boot,
 * so this script is belt-and-braces: run it before the first restart so we
 * can eyeball the output.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

const STATE_DIR = join(homedir(), 'claude-workspace', 'generic', 'dispatcher', 'state')
const SESSIONS_FILE = join(STATE_DIR, 'sessions.json')
const THREAD_SESSIONS_FILE = join(STATE_DIR, 'thread_sessions.json')

interface LegacySessionEntry {
  threadId: string
  sessionId: string | null
  threadName: string
  createdAt: number
  lastActiveAt: number
  turnCount: number
}

interface ThreadSessionRecord {
  threadId: string
  sessionId: string | null
  threadName: string
  createdAt: number
  lastUsedAt: number
  turnCount: number
}

function main(): void {
  if (!existsSync(SESSIONS_FILE)) {
    console.log(`No sessions.json found at ${SESSIONS_FILE} — nothing to migrate.`)
    return
  }

  const legacy = JSON.parse(readFileSync(SESSIONS_FILE, 'utf8')) as LegacySessionEntry[]
  const existing: ThreadSessionRecord[] = existsSync(THREAD_SESSIONS_FILE)
    ? JSON.parse(readFileSync(THREAD_SESSIONS_FILE, 'utf8'))
    : []

  const byThread = new Map<string, ThreadSessionRecord>()
  for (const record of existing) {
    byThread.set(record.threadId, record)
  }

  let added = 0
  let updated = 0
  for (const entry of legacy) {
    const current = byThread.get(entry.threadId)
    const incoming: ThreadSessionRecord = {
      threadId: entry.threadId,
      sessionId: entry.sessionId,
      threadName: entry.threadName,
      createdAt: entry.createdAt,
      lastUsedAt: entry.lastActiveAt,
      turnCount: entry.turnCount,
    }
    if (!current) {
      byThread.set(entry.threadId, incoming)
      added++
    } else if (current.lastUsedAt < incoming.lastUsedAt) {
      byThread.set(entry.threadId, incoming)
      updated++
    }
  }

  const out = Array.from(byThread.values())
  writeFileSync(THREAD_SESSIONS_FILE, JSON.stringify(out, null, 2))

  console.log(`Migrated ${added} new + ${updated} updated thread sessions.`)
  console.log(`Total rows in thread_sessions.json: ${out.length}`)
  console.log(`File: ${THREAD_SESSIONS_FILE}`)
}

main()
