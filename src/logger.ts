/**
 * Structured logging — dispatcher events + session events.
 * Writes JSONL to the shared logs/ directory.
 */

import { appendFileSync, mkdirSync } from 'fs'
import { LOG_DIR } from './config.js'

mkdirSync(LOG_DIR, { recursive: true })

function dateStr(): string {
  return new Date().toISOString().slice(0, 10)
}

function timestamp(): string {
  return new Date().toISOString()
}

function logFile(prefix: string): string {
  return `${LOG_DIR}/${dateStr()}-${prefix}.jsonl`
}

export interface LogEntry {
  timestamp: string
  event: string
  [key: string]: unknown
}

function write(prefix: string, entry: LogEntry): void {
  try {
    appendFileSync(logFile(prefix), JSON.stringify(entry) + '\n')
  } catch (err) {
    process.stderr.write(`logger: write failed: ${err}\n`)
  }
}

// Dispatcher-level events (startup, shutdown, errors)
export function logDispatcher(event: string, data: Record<string, unknown> = {}): void {
  const entry: LogEntry = { timestamp: timestamp(), event, ...data }
  write('dispatcher', entry)
  // Also print to stderr for tmux visibility
  process.stderr.write(`[dispatcher] ${event}${Object.keys(data).length ? ' ' + JSON.stringify(data) : ''}\n`)
}

// Session lifecycle events (created, resumed, expired)
export function logSession(event: string, data: Record<string, unknown> = {}): void {
  write('sessions', { timestamp: timestamp(), event, ...data })
}

// Console-style helpers for developer output
export const log = {
  info: (msg: string) => process.stderr.write(`[info] ${msg}\n`),
  warn: (msg: string) => process.stderr.write(`[warn] ${msg}\n`),
  error: (msg: string) => process.stderr.write(`[error] ${msg}\n`),
}
