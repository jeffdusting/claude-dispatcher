/**
 * Generic Dispatcher — entry point.
 *
 * Multi-session orchestrator for the #generic Discord channel.
 * Creates a Discord thread per task, spawns an independent Claude Code
 * session for each, and routes follow-ups to the correct session.
 */

import { seedStateIfAbsent } from './bootstrap.js'
import { syncAgents } from './agentSync.js'
import {
  loadSessions,
  cleanupSessions,
  shutdown as shutdownSessions,
  listPreviouslyBusyThreads,
} from './sessions.js'
import { loadThreadSessions, threadSessionCount } from './threadSessions.js'
import {
  connect,
  disconnect,
  resolveThreadChannel,
  restoreContinuations,
  replayPendingSideEffects,
  runKickoffCycle,
  notifyIfStaleAgents,
} from './gateway.js'
import {
  reconcileOnBoot as reconcileWorkersOnBoot,
  startSweep as startWorkerSweep,
  stopSweep as stopWorkerSweep,
  startMemorySweep as startWorkerMemorySweep,
  stopMemorySweep as stopWorkerMemorySweep,
} from './workerRegistry.js'
import {
  shutdown as shutdownHealth,
  startHealthServer,
} from './health.js'
import { markDraining, awaitWorkersDrained } from './drain.js'
import { startIntegrationsProbe, stopIntegrationsProbe } from './integrationsHealth.js'
import { startCapDetector, stopCapDetector } from './anthropicCap.js'
import { startEscalator, stopEscalator } from './escalator.js'
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

// Worker registry boot reconciliation (Phase A.9.4, Δ D-004). Sessions
// that were 'busy' at last shutdown lost their subprocess with the prior
// Bun process — surface them so the partial-failure-recovery framework
// (Phase A.9.3) replays any captured side effects after the gateway is
// connected. Start the orphan-detection sweep immediately so any
// post-boot worker that hangs is caught.
reconcileWorkersOnBoot(listPreviouslyBusyThreads())
startWorkerSweep()

// Per-worker memory observation sweep (Phase A.9.6, Δ D-014). Samples
// RSS every WORKER_MEMORY_SAMPLE_INTERVAL_MS; warns at WORKER_MEMORY_WARN_BYTES
// (default 1 GB), kills at WORKER_MEMORY_KILL_BYTES (default 1.5 GB) with
// audit through the existing unregisterWorker(threadId,'killed',reason) path.
startWorkerMemorySweep()

// Health HTTP endpoint — runs in ALL modes including spare so the process
// is monitorable. curl localhost:HEALTHCHECK_PORT/health
startHealthServer(HEALTHCHECK_PORT, DISPATCHER_ROLE)

// Integrations health probe — refreshes the per-upstream snapshot every 60s.
// /health/integrations reads the cached value, so the request handler does
// not block on synchronous probes (Phase A.9 component 7, OD-033).
startIntegrationsProbe()

// Anthropic monthly-cap detector — periodic light probe distinguishes the
// monthly-cap signature from per-request 5xx so kickoff can be paused
// without blocking in-flight worker streams (Phase A.9 component 9,
// reference scenario: 24 April 2026 cap-hit incident).
startCapDetector()

// Tier-2 alert escalator — sweeps unacked Discord alerts at the configured
// cadence and sends SMS via Twilio per OD-011 (Phase A.9 component 8).
startEscalator()

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

  // Replay any side effects (Discord posts, Drive uploads, attachments)
  // that were captured but not finished before the previous Bun process
  // exited (Phase A.9.3, Δ D-003 — 25 April 2026 incident class). Run
  // after restoreContinuations so a continuation that completed mid-flight
  // does not race with the replay path.
  replayPendingSideEffects(resolveThreadChannel).catch((err) => {
    logDispatcher('side_effects_replay_top_level_error', { error: String(err) })
  })

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

// Graceful shutdown (Phase A.9.7, Δ D-008).
//
// Sequence: flip the drain flag, stop scheduled intervals so no new work
// starts, wait up to 90s for in-flight workers to complete, hard-kill any
// survivors, flush state files, disconnect from Discord, exit. The 10-second
// post-disconnect force-exit timer is the secondary guard for a stuck
// disconnect; the 90-second drain window is the primary budget per spec.
let shuttingDown = false
async function shutdown(): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  // Flip the drain flag. Inbound traffic, kickoff cycle, and concurrency-gate
  // acquires now reject; /health flips to 503; the worker registry is the
  // source of truth for what is in flight.
  markDraining()
  logDispatcher('shutdown_start')

  if (cleanupInterval) clearInterval(cleanupInterval)
  if (kickoffInterval) clearInterval(kickoffInterval)
  if (projectArchiveInterval) clearInterval(projectArchiveInterval)
  if (retentionInterval) clearInterval(retentionInterval)
  clearInterval(heartbeatInterval)
  stopWorkerSweep()
  stopWorkerMemorySweep()
  stopIntegrationsProbe()
  stopCapDetector()
  stopEscalator()

  // Wait for in-flight workers to complete; force-kill survivors at the
  // budget. State-file flushes happen after the wait so anything captured
  // by a worker that finished mid-drain is persisted.
  const drainResult = await awaitWorkersDrained()

  shutdownSessions()
  shutdownHealth()
  shutdownIngest()

  const forceTimer = setTimeout(() => {
    logDispatcher('shutdown_forced')
    process.exit(0)
  }, 10_000)

  if (DISPATCHER_ROLE === 'spare') {
    // Nothing to disconnect — spare never called connect().
    logDispatcher('shutdown_complete', { ...drainResult })
    clearTimeout(forceTimer)
    process.exit(0)
  } else {
    disconnect()
      .then(() => {
        logDispatcher('shutdown_complete', { ...drainResult })
        clearTimeout(forceTimer)
        process.exit(0)
      })
      .catch(() => {
        clearTimeout(forceTimer)
        process.exit(1)
      })
  }
}

function triggerShutdown(): void {
  shutdown().catch((err) => {
    logDispatcher('shutdown_error', { error: String(err) })
    process.exit(1)
  })
}

process.on('SIGTERM', triggerShutdown)
process.on('SIGINT', triggerShutdown)
process.on('SIGHUP', triggerShutdown)

// Catch unhandled errors so the process doesn't die silently
process.on('unhandledRejection', (err) => {
  logDispatcher('unhandled_rejection', { error: String(err) })
})
process.on('uncaughtException', (err) => {
  logDispatcher('uncaught_exception', { error: String(err) })
  // Don't exit — try to keep serving
})

logDispatcher('ready', { role: DISPATCHER_ROLE, pid: process.pid })
