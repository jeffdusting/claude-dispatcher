/**
 * Generic Dispatcher — entry point.
 *
 * Multi-session orchestrator for the #generic Discord channel.
 * Creates a Discord thread per task, spawns an independent Claude Code
 * session for each, and routes follow-ups to the correct session.
 */

import { loadSessions, cleanupSessions, shutdown as shutdownSessions } from './sessions.js'
import { loadThreadSessions, threadSessionCount } from './threadSessions.js'
import { connect, disconnect, resolveThreadChannel, restoreContinuations, runKickoffCycle } from './gateway.js'
import { shutdown as shutdownHealth } from './health.js'
import { sweepRetention, shutdownIngest } from './ingest.js'
import { listActiveProjects, archiveProject } from './projects.js'
import { logDispatcher } from './logger.js'

logDispatcher('startup', { pid: process.pid, version: '0.1.0' })

// Load the permanent thread → sessionId mapping FIRST. loadSessions() reads
// this as the authoritative source for resume-ability, so the order matters.
loadThreadSessions()
logDispatcher('thread_sessions_ready', { count: threadSessionCount() })

// Load persisted live-registry state (concurrency/queue tracking).
loadSessions()

// Connect to Discord
await connect()

// Restore any pending autonomous continuations that were scheduled before a
// restart. Timers re-arm with remaining time; overdue continuations fire
// immediately. Must run AFTER the Discord gateway is connected so the
// channel resolver can fetch thread objects.
restoreContinuations(resolveThreadChannel)

// Periodic cleanup of expired sessions (every 15 minutes)
const cleanupInterval = setInterval(() => {
  const cleaned = cleanupSessions()
  if (cleaned > 0) {
    logDispatcher('cleanup', { removed: cleaned })
  }
}, 15 * 60 * 1000)

// Project kickoff cycle — drain the kickoff inbox every 10 seconds and
// stand up the PM for any new projects. Fast interval because Jeff should
// see the project thread come alive within moments of the CoS launching it.
const kickoffInterval = setInterval(() => {
  try {
    runKickoffCycle()
  } catch (err) {
    logDispatcher('kickoff_cycle_error', { error: String(err) })
  }
}, 10 * 1000)

// Run once on boot to pick up any requests that were dropped while the
// dispatcher was offline.
runKickoffCycle()

// Project archival sweep — once an hour, move `complete`/`cancelled`/`failed`
// projects out of the active directory. The PM sets the terminal status; we
// do the file move asynchronously to keep the active listing tight.
const projectArchiveInterval = setInterval(() => {
  try {
    let archived = 0
    for (const p of listActiveProjects()) {
      if (p.status === 'complete' || p.status === 'cancelled' || p.status === 'failed') {
        archiveProject(p.id, p.status)
        archived++
      }
    }
    if (archived > 0) {
      logDispatcher('project_archive_sweep', { archived })
    }
  } catch (err) {
    logDispatcher('project_archive_error', { error: String(err) })
  }
}, 60 * 60 * 1000)

// Periodic health heartbeat (every 5 minutes — proves process is alive)
const heartbeatInterval = setInterval(() => {
  logDispatcher('heartbeat', {
    pid: process.pid,
    memMB: Math.round(process.memoryUsage.rss() / 1024 / 1024),
  })
}, 5 * 60 * 1000)

// Ingest retention sweep — runs once on boot and daily thereafter.
// Deletes per-channel JSONL files older than `retentionDays` (default 90).
sweepRetention()
const retentionInterval = setInterval(() => {
  try {
    sweepRetention()
  } catch (err) {
    logDispatcher('ingest_sweep_failed', { error: String(err) })
  }
}, 24 * 60 * 60 * 1000)

// Graceful shutdown
let shuttingDown = false
function shutdown(): void {
  if (shuttingDown) return
  shuttingDown = true
  logDispatcher('shutdown_start')

  clearInterval(cleanupInterval)
  clearInterval(heartbeatInterval)
  clearInterval(retentionInterval)
  clearInterval(kickoffInterval)
  clearInterval(projectArchiveInterval)
  shutdownSessions()
  shutdownHealth()
  shutdownIngest()

  const forceTimer = setTimeout(() => {
    logDispatcher('shutdown_forced')
    process.exit(0)
  }, 10_000)

  disconnect()
    .then(() => {
      logDispatcher('shutdown_complete')
      clearTimeout(forceTimer)
      process.exit(0)
    })
    .catch(() => {
      clearTimeout(forceTimer)
      process.exit(1)
    })
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
process.on('SIGHUP', shutdown)

// Catch unhandled errors so the process doesn't die silently
process.on('unhandledRejection', (err) => {
  logDispatcher('unhandled_rejection', { error: String(err) })
})
process.on('uncaughtException', (err) => {
  logDispatcher('uncaught_exception', { error: String(err) })
  // Don't exit — try to keep serving
})

logDispatcher('ready', { pid: process.pid })
