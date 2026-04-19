/**
 * Generic Dispatcher — entry point.
 *
 * Multi-session orchestrator for the #generic Discord channel.
 * Creates a Discord thread per task, spawns an independent Claude Code
 * session for each, and routes follow-ups to the correct session.
 */

import { loadSessions, cleanupSessions, shutdown as shutdownSessions } from './sessions.js'
import { connect, disconnect } from './gateway.js'
import { shutdown as shutdownHealth } from './health.js'
import { logDispatcher } from './logger.js'

logDispatcher('startup', { pid: process.pid, version: '0.1.0' })

// Load persisted session state
loadSessions()

// Connect to Discord
await connect()

// Periodic cleanup of expired sessions (every 15 minutes)
const cleanupInterval = setInterval(() => {
  const cleaned = cleanupSessions()
  if (cleaned > 0) {
    logDispatcher('cleanup', { removed: cleaned })
  }
}, 15 * 60 * 1000)

// Periodic health heartbeat (every 5 minutes — proves process is alive)
const heartbeatInterval = setInterval(() => {
  logDispatcher('heartbeat', {
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

  clearInterval(cleanupInterval)
  clearInterval(heartbeatInterval)
  shutdownSessions()
  shutdownHealth()

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
