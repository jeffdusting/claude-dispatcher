/**
 * Structured logging — dispatcher events + session events.
 * Writes JSONL to the shared logs/ directory.
 *
 * Phase A.11 (Δ DA-013, OD-027): every emission inside a correlation
 * scope (see correlationContext.ts) gets a `correlationId` field
 * automatically. Callers do not need to remember to pass it.
 */

import { appendFileSync, mkdirSync } from 'fs'
import { LOG_DIR } from './config.js'
import { getCorrelationId } from './correlationContext.js'

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
  correlationId?: string
  [key: string]: unknown
}

function write(prefix: string, entry: LogEntry): void {
  try {
    appendFileSync(logFile(prefix), JSON.stringify(entry) + '\n')
  } catch (err) {
    process.stderr.write(`logger: write failed: ${err}\n`)
  }
}

function withCorrelationField(data: Record<string, unknown>): Record<string, unknown> {
  // Caller-supplied correlationId wins so an explicit override (e.g. logging
  // on behalf of a different project) is preserved verbatim.
  if ('correlationId' in data) return data
  const cid = getCorrelationId()
  if (!cid) return data
  return { correlationId: cid, ...data }
}

// Dispatcher-level events (startup, shutdown, errors)
export function logDispatcher(event: string, data: Record<string, unknown> = {}): void {
  const enriched = withCorrelationField(data)
  const entry: LogEntry = { timestamp: timestamp(), event, ...enriched }
  write('dispatcher', entry)
  // Also print to stderr for tmux visibility
  process.stderr.write(`[dispatcher] ${event}${Object.keys(enriched).length ? ' ' + JSON.stringify(enriched) : ''}\n`)
}

// Session lifecycle events (created, resumed, expired)
export function logSession(event: string, data: Record<string, unknown> = {}): void {
  write('sessions', { timestamp: timestamp(), event, ...withCorrelationField(data) })
}

// Console-style helpers for developer output
export const log = {
  info: (msg: string) => process.stderr.write(`[info] ${msg}\n`),
  warn: (msg: string) => process.stderr.write(`[warn] ${msg}\n`),
  error: (msg: string) => process.stderr.write(`[error] ${msg}\n`),
}
