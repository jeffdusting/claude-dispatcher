/**
 * Generic Dispatcher — entry point.
 *
 * Multi-session orchestrator for the #generic Discord channel.
 * Creates a Discord thread per task, spawns an independent Claude Code
 * session for each, and routes follow-ups to the correct session.
 */

import { seedStateIfAbsent } from './bootstrap.js'
import { syncAgents } from './agentSync.js'
import { loadSessions, cleanupSessions, shutdown as shutdownSessions } from './sessions.js'
import { loadThreadSessions, threadSessionCount } from './threadSessions.js'
import { connect, disconnect, resolveThreadChannel, restoreContinuations, runKickoffCycle, notifyIfStaleAgents } from './gateway.js'
import { shutdown as shutdownHealth, startHealthServer } from './health.js'
import { sweepRetention, shutdownIngest } from './ingest.js'
import { listActiveProjects, archiveProject } from './projects.js'
import { logDispatcher } from './logger.js'
import { DISPATCHER_ROLE, DISPATCHER_PAUSE_CRON, HEALTHCHECK_PORT } from './config.js'

// Seed missing runtime state files from state/seeds/ on first boot.
seedStateIfAbsent()

// Sync agent definitions from the dispatcher repo's canonical .claude/agents/
// into ~/.claude/agents/ — Claude Code's user-level fallback. Runs before any
// scheduled work so spawned sessions resolve the latest agent definitions.
// Failure is non-fatal: state/agents-stale.json is set and an alert is posted
// to Discord once the gateway connects.
syncAgents()

logDispatcher('dispatcher_starting', {
  role: DISPATCHER_ROLE,
  cronPaused: DISPATCHER_PAUSE_CRON,
  pid: process.pid,
  version: '0.1.0',
})

if (DISPATCHER_PAUSE_CRON) {
  logDispatcher('cron_paused', { cron_paused: true })
}

// Load the permanent thread → sessionId mapping FIRST. loadSessions() reads
// this as the authoritative source for resume-ability, so the order matters.
loadThreadSessions()
logDispatcher('thread_sessions_ready', { count: threadSessionCount() })

// Load persisted live-registry state (concurrency/queue tracking).
loadSessions()

// Health HTTP endpoint — runs in ALL modes including spare so the process
// is monitorable. curl localhost:HEALTHCHECK_PORT/health
startHealthServer(HEALTHCHECK_PORT, DISPATCHER_ROLE)

// skipCron is true for spare (no Discord, no cron) and for pause-cron mode
// (Discord active, cron suppressed so cloud owns scheduling during cutover).
const skipCron = DISPATCHER_ROLE === 'spare' || DISPATCHER_PAUSE_CRON

// Connect to Discord — skipped in spare mode entirely.
if (DISPATCHER_ROLE !== 'spare') {
  await connect()

  // Restore any pending autonomous continuations that were scheduled before a
  // restart. Timers re-arm with remaining time; overdue continuations fire
  // immediately. Must run AFTER the Discord gateway is connected so the
  // channel resolver can fetch thread objects.
  restoreContinuations(resolveThreadChannel)

  // Tier-1 alert if the boot-time agent sync failed. Posts only if
  // OPS_ALERT_CHANNEL_ID is set; otherwise the stale flag plus log entry
  // are the durable signal.
  await notifyIfStaleAgents()
}

// ─── Scheduled Intervals ─────────────────────────────────────────
// All intervals below are gated by skipCron. The heartbeat is the only
// interval that runs unconditionally — it proves the process is alive and
// is the only activity expected from a spare.

let cleanupInterval: ReturnType<typeof setInterval> | undefined
let kickoffInterval: ReturnType<typeof setInterval> | undefined
let projectArchiveInterval: ReturnType<typeof setInterval> | undefined
let retentionInterval: ReturnType<typeof setInterval> | undefined

if (!skipCron) {
  // Periodic cleanup of expired sessions (every 15 minutes)
  cleanupInterval = setInterval(() => {
    const cleaned = cleanupSessions()
    if (cleaned > 0) {
      logDispatcher('cleanup', { removed: cleaned })
    }
  }, 15 * 60 * 1000)

  // Project kickoff cycle — drain the kickoff inbox every 10 seconds and
  // stand up the PM for any new projects. Fast interval because Jeff should
  // see the project thread come alive within moments of the CoS launching it.
  kickoffInterval = setInterval(() => {
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
  // projects out of the active directory.
  projectArchiveInterval = setInterval(() => {
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

  // Ingest retention sweep — runs once on boot and daily thereafter.
  sweepRetention()
  retentionInterval = setInterval(() => {
    try {
      sweepRetention()
    } catch (err) {
      logDispatcher('ingest_sweep_failed', { error: String(err) })
    }
  }, 24 * 60 * 60 * 1000)
}

// Periodic health heartbeat (every 5 minutes — proves process is alive).
// Runs in ALL modes including spare.
const heartbeatInterval = setInterval(() => {
  logDispatcher('heartbeat', {
    role: DISPATCHER_ROLE,
    pid: process.pid,
    memMB: Math.round(process.memoryUsage.rss() / 1024 / 1024),
  })
}, 5 * 60 * 1000)

// Graceful shutdown
let shuttingDown = false
function shutdown(): void {
  if (shuttingDown) return
  shuttingDown = true
  logDispatcher('shutdown_start')

  if (cleanupInterval) clearInterval(cleanupInterval)
  if (kickoffInterval) clearInterval(kickoffInterval)
  if (projectArchiveInterval) clearInterval(projectArchiveInterval)
  if (retentionInterval) clearInterval(retentionInterval)
  clearInterval(heartbeatInterval)

  shutdownSessions()
  shutdownHealth()
  shutdownIngest()

  const forceTimer = setTimeout(() => {
    logDispatcher('shutdown_forced')
    process.exit(0)
  }, 10_000)

  if (DISPATCHER_ROLE === 'spare') {
    // Nothing to disconnect — spare never called connect().
    logDispatcher('shutdown_complete')
    clearTimeout(forceTimer)
    process.exit(0)
  } else {
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

logDispatcher('ready', { role: DISPATCHER_ROLE, pid: process.pid })
