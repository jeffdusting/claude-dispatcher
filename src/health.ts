/**
 * Health monitoring, cost tracking, rate limiting, and daily reporting.
 *
 * Tracks:
 * - Dispatcher uptime and process health
 * - Per-session and aggregate cost/usage
 * - Error rates and consecutive failures (circuit breaker)
 * - Rate limiting for inbound messages
 *
 * Persists daily stats to logs/ for review.
 */

import { writeFileSync, readFileSync, appendFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { STATE_DIR, LOG_DIR } from './config.js'
import { logDispatcher } from './logger.js'

mkdirSync(STATE_DIR, { recursive: true })

// ─── Types ────────────────────────────────────────────────────────

export interface SessionStats {
  threadId: string
  threadName: string
  turns: number
  cost: number
  durationMs: number
  toolsUsed: string[]
  errors: number
  startedAt: number
  lastActiveAt: number
}

interface DailyStats {
  date: string
  sessionsCreated: number
  turnsCompleted: number
  totalCost: number
  totalErrors: number
  messagesReceived: number
  messagesQueued: number
  sessionsByThread: Record<string, SessionStats>
}

interface HealthState {
  startedAt: number
  lastActivityAt: number
  consecutiveErrors: number
  circuitOpen: boolean
  circuitOpenedAt: number | null
  dailyStats: DailyStats
}

// ─── State ────────────────────────────────────────────────────────

const HEALTH_FILE = join(STATE_DIR, 'health.json')
const CIRCUIT_BREAKER_THRESHOLD = 5          // consecutive errors before opening
const CIRCUIT_BREAKER_COOLDOWN_MS = 60_000   // 1 minute cooldown

const state: HealthState = {
  startedAt: Date.now(),
  lastActivityAt: Date.now(),
  consecutiveErrors: 0,
  circuitOpen: false,
  circuitOpenedAt: null,
  dailyStats: freshDailyStats(),
}

function dateStr(): string {
  return new Date().toISOString().slice(0, 10)
}

function freshDailyStats(): DailyStats {
  return {
    date: dateStr(),
    sessionsCreated: 0,
    turnsCompleted: 0,
    totalCost: 0,
    totalErrors: 0,
    messagesReceived: 0,
    messagesQueued: 0,
    sessionsByThread: {},
  }
}

function rollDateIfNeeded(): void {
  const today = dateStr()
  if (state.dailyStats.date !== today) {
    // Save yesterday's stats before rolling
    saveDailyReport(state.dailyStats)
    state.dailyStats = freshDailyStats()
  }
}

function persist(): void {
  try {
    writeFileSync(HEALTH_FILE, JSON.stringify(state, null, 2))
  } catch {}
}

// ─── Rate Limiter ─────────────────────────────────────────────────

const messageTimestamps: number[] = []
const RATE_LIMIT_WINDOW_MS = 60_000   // 1 minute window
const RATE_LIMIT_MAX = 15             // max messages per window

/**
 * Check if a new message should be rate-limited.
 * Returns true if the message should be processed, false if rate-limited.
 */
export function checkRateLimit(): boolean {
  const now = Date.now()
  // Prune old timestamps
  while (messageTimestamps.length > 0 && messageTimestamps[0]! < now - RATE_LIMIT_WINDOW_MS) {
    messageTimestamps.shift()
  }
  if (messageTimestamps.length >= RATE_LIMIT_MAX) {
    logDispatcher('rate_limited', { count: messageTimestamps.length, window: RATE_LIMIT_WINDOW_MS })
    return false
  }
  messageTimestamps.push(now)
  return true
}

// ─── Circuit Breaker ──────────────────────────────────────────────

/**
 * Check if the circuit breaker is open (too many consecutive errors).
 * Auto-closes after cooldown period.
 */
export function isCircuitOpen(): boolean {
  if (!state.circuitOpen) return false
  // Check if cooldown has passed
  if (state.circuitOpenedAt && Date.now() - state.circuitOpenedAt > CIRCUIT_BREAKER_COOLDOWN_MS) {
    state.circuitOpen = false
    state.circuitOpenedAt = null
    state.consecutiveErrors = 0
    logDispatcher('circuit_closed', { reason: 'cooldown_elapsed' })
    persist()
    return false
  }
  return true
}

/** Record a successful session completion. */
export function recordSuccess(): void {
  state.consecutiveErrors = 0
  if (state.circuitOpen) {
    state.circuitOpen = false
    state.circuitOpenedAt = null
    logDispatcher('circuit_closed', { reason: 'success' })
  }
  state.lastActivityAt = Date.now()
  persist()
}

/** Record a session error. Opens circuit breaker after threshold. */
export function recordError(): void {
  state.consecutiveErrors++
  state.lastActivityAt = Date.now()
  if (state.consecutiveErrors >= CIRCUIT_BREAKER_THRESHOLD && !state.circuitOpen) {
    state.circuitOpen = true
    state.circuitOpenedAt = Date.now()
    logDispatcher('circuit_opened', {
      consecutiveErrors: state.consecutiveErrors,
      cooldownMs: CIRCUIT_BREAKER_COOLDOWN_MS,
    })
  }
  persist()
}

// ─── Stats Tracking ───────────────────────────────────────────────

export function trackMessageReceived(): void {
  rollDateIfNeeded()
  state.dailyStats.messagesReceived++
}

export function trackMessageQueued(): void {
  rollDateIfNeeded()
  state.dailyStats.messagesQueued++
}

export function trackSessionCreated(threadId: string, threadName: string): void {
  rollDateIfNeeded()
  state.dailyStats.sessionsCreated++
  state.dailyStats.sessionsByThread[threadId] = {
    threadId,
    threadName,
    turns: 0,
    cost: 0,
    durationMs: 0,
    toolsUsed: [],
    errors: 0,
    startedAt: Date.now(),
    lastActiveAt: Date.now(),
  }
}

export function trackTurnCompleted(
  threadId: string,
  cost: number | null,
  durationMs: number | null,
  toolsUsed: string[],
): void {
  rollDateIfNeeded()
  state.dailyStats.turnsCompleted++
  if (cost) state.dailyStats.totalCost += cost

  const session = state.dailyStats.sessionsByThread[threadId]
  if (session) {
    session.turns++
    if (cost) session.cost += cost
    if (durationMs) session.durationMs += durationMs
    session.lastActiveAt = Date.now()
    // Merge tools
    for (const t of toolsUsed) {
      if (!session.toolsUsed.includes(t)) session.toolsUsed.push(t)
    }
  }
}

export function trackSessionError(threadId: string): void {
  rollDateIfNeeded()
  state.dailyStats.totalErrors++
  const session = state.dailyStats.sessionsByThread[threadId]
  if (session) session.errors++
}

// ─── Reporting ────────────────────────────────────────────────────

/** Save a daily stats report to logs/ */
function saveDailyReport(stats: DailyStats): void {
  const file = join(LOG_DIR, `${stats.date}-daily-report.json`)
  try {
    writeFileSync(file, JSON.stringify(stats, null, 2))
    logDispatcher('daily_report_saved', { date: stats.date, file })
  } catch (err) {
    logDispatcher('daily_report_save_failed', { error: String(err) })
  }
}

/** Get formatted stats for Discord (!stats command). */
export function getStatsReport(): string {
  rollDateIfNeeded()
  const s = state.dailyStats
  const uptime = Math.round((Date.now() - state.startedAt) / 60_000)
  const uptimeHrs = (uptime / 60).toFixed(1)

  const lines: string[] = [
    `**Dispatcher Stats** (${s.date})`,
    '',
    `Uptime: ${uptimeHrs}h (${uptime}m)`,
    `Sessions today: ${s.sessionsCreated}`,
    `Turns completed: ${s.turnsCompleted}`,
    `Messages received: ${s.messagesReceived}`,
    `Messages queued: ${s.messagesQueued}`,
    `Errors: ${s.totalErrors}`,
    `Circuit breaker: ${state.circuitOpen ? '🔴 OPEN' : '🟢 closed'}`,
    `Consecutive errors: ${state.consecutiveErrors}`,
  ]

  // Per-session breakdown
  const sessions = Object.values(s.sessionsByThread)
  if (sessions.length > 0) {
    lines.push('')
    lines.push('**Sessions:**')
    for (const sess of sessions) {
      const dur = (sess.durationMs / 1000).toFixed(0)
      lines.push(
        `  ${sess.threadName}: ${sess.turns} turns, ${dur}s total` +
        (sess.errors > 0 ? `, ${sess.errors} errors` : ''),
      )
    }
  }

  return lines.join('\n')
}

/** Get a brief health line for embedding in !status */
export function getHealthLine(): string {
  const uptime = Math.round((Date.now() - state.startedAt) / 60_000)
  const circuit = state.circuitOpen ? '🔴 circuit open' : '🟢 healthy'
  return `Uptime: ${uptime}m · ${circuit} · Errors today: ${state.dailyStats.totalErrors}`
}

// ─── Lifecycle ────────────────────────────────────────────────────

/** Save current daily stats on shutdown */
export function shutdown(): void {
  saveDailyReport(state.dailyStats)
  persist()
}

// ─── Health HTTP Server ───────────────────────────────────────────

/**
 * Start a minimal HTTP server on `port` that returns dispatcher health as JSON.
 * Runs in all modes (primary and spare) so spares are monitorable via
 * `curl localhost:PORT/health`. The server is intentionally read-only and
 * has no auth — it is not exposed publicly (no Fly http_service block).
 */
export function startHealthServer(port: number, role: string): void {
  Bun.serve({
    port,
    fetch(req) {
      const url = new URL(req.url)
      if (url.pathname !== '/health') {
        return new Response('Not found', { status: 404 })
      }
      const body = JSON.stringify({
        status: 'ok',
        role,
        pid: process.pid,
        uptimeSeconds: Math.round((Date.now() - state.startedAt) / 1000),
        memMB: Math.round(process.memoryUsage.rss() / 1024 / 1024),
        circuitOpen: state.circuitOpen,
        consecutiveErrors: state.consecutiveErrors,
      })
      return new Response(body, {
        headers: { 'Content-Type': 'application/json' },
      })
    },
  })
  logDispatcher('health_server_started', { port, role })
}
