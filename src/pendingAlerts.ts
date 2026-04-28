/**
 * Drain external tier-2 alerts emitted by sidecar processes (notably
 * scripts/backup.sh) into the in-process escalator.
 *
 * Producers append JSONL records to STATE_DIR/pending-tier2-alerts.jsonl.
 * The dispatcher's escalator sweep calls drainPendingTier2Alerts() at the
 * top of each tick. Drain rotates the file via rename so concurrent
 * appends (next-hour cron during a sweep) are not lost.
 *
 * Each line must be a JSON object with at least:
 *   category: string
 *   summary:  string
 * Optional fields (passed through to PostTier2Alert):
 *   level, channelId, recipientMobile.
 *
 * Wired from escalator.ts via dynamic import to avoid an import cycle —
 * pendingAlerts.ts depends on postTier2Alert which lives in escalator.ts.
 */

import { existsSync, readFileSync, renameSync, unlinkSync } from 'fs'
import { join } from 'path'
import { STATE_DIR } from './config.js'
import { postTier2Alert, type PostTier2Alert } from './escalator.js'
import { logDispatcher } from './logger.js'

const PENDING_FILE = join(STATE_DIR, 'pending-tier2-alerts.jsonl')

export async function drainPendingTier2Alerts(): Promise<number> {
  if (!existsSync(PENDING_FILE)) return 0

  const draining = `${PENDING_FILE}.draining-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  try {
    renameSync(PENDING_FILE, draining)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return 0
    logDispatcher('pending_alerts_rename_failed', { error: String(err) })
    return 0
  }

  let raw: string
  try {
    raw = readFileSync(draining, 'utf8')
  } catch (err) {
    logDispatcher('pending_alerts_read_failed', { error: String(err) })
    try {
      unlinkSync(draining)
    } catch {
      // best effort
    }
    return 0
  }

  const lines = raw.split('\n').filter((l) => l.trim().length > 0)
  let drained = 0

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as Partial<PostTier2Alert>
      if (typeof parsed.category !== 'string' || typeof parsed.summary !== 'string') {
        logDispatcher('pending_alert_invalid', { line: line.slice(0, 200) })
        continue
      }
      await postTier2Alert({
        category: parsed.category,
        summary: parsed.summary,
        level: parsed.level,
        channelId: parsed.channelId,
        recipientMobile: parsed.recipientMobile,
      })
      drained++
    } catch (err) {
      logDispatcher('pending_alert_parse_failed', {
        error: String(err),
        line: line.slice(0, 200),
      })
    }
  }

  try {
    unlinkSync(draining)
  } catch (err) {
    logDispatcher('pending_alerts_unlink_failed', { error: String(err) })
  }

  if (drained > 0) {
    logDispatcher('pending_alerts_drained', { count: drained })
  }
  return drained
}

/** Test-only path accessor. Production code reads PENDING_FILE directly. */
export function _getPendingFileForTesting(): string {
  return PENDING_FILE
}
