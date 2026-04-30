/**
 * EA mailroom drain cycle and backpressure alarms (Migration Plan §14.2.3
 * continuation; architecture v2.1 §2.2.2, §2.2.5, §6.7).
 *
 * Two responsibilities:
 *
 *   1. Drain — every MAILROOM_DRAIN_INTERVAL_MS, drain every pair queue
 *      under `state/ea-mailroom/<from>-to-<to>/`, deliver each envelope into
 *      the destination partition's mailbox at `state/eas/<to>/mailbox/`,
 *      and append a record to the cross-EA audit log at
 *      `state/ea-mailroom/audit.jsonl`. The audit log is the single
 *      authoritative trail of cross-principal exchanges (architecture
 *      §2.2.4). Each EA worker then reads from its own mailbox at session
 *      start; the dispatcher does not deliver into a running session.
 *
 *   2. Backpressure alarms — at the same cadence, sweep depth and age
 *      thresholds. Pair queue depth > MAILROOM_DEPTH_ALARM_THRESHOLD
 *      produces a tier-1 Discord post. Envelope age > MAILROOM_AGE_ALARM_MS
 *      produces a tier-2 alert via the escalator (Twilio escalation if
 *      unacked). De-dup is persistent across restarts via
 *      `state/ea-mailroom-alarms.json` so a flapping queue does not
 *      page the operator every minute.
 *
 * Integration with the dispatcher-wide drain (Phase A.9 c6 / §4.9.7): when
 * `isDraining()` is set, runMailroomCycle() returns immediately. Envelopes
 * already on disk are persistent and the next process picks them up. This
 * matches the kickoff and tender cycle patterns — drain is a one-way switch
 * that stops new work being scheduled.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, appendFileSync } from 'fs'
import { join } from 'path'
import {
  STATE_DIR,
  OPS_ALERT_CHANNEL_ID,
} from './config.js'
import { writeJsonAtomic } from './atomicWrite.js'
import { logDispatcher } from './logger.js'
import { isDraining } from './drain.js'
import {
  drainAllPairs,
  listPairQueues,
  pairQueueDepth,
  pairQueueDir,
  type MailroomEnvelope,
} from './eaMailroom.js'
import {
  ensurePartitionDirs,
  partitionMailboxDir,
  EA_MAILROOM_DIR,
} from './eaPartitions.js'
import { postTier2Alert } from './escalator.js'

/** Cadence for the mailroom drain + backpressure sweep. */
export const MAILROOM_DRAIN_INTERVAL_MS: number = parseInt(
  process.env.MAILROOM_DRAIN_INTERVAL_MS ?? `${60 * 1000}`,
  10,
)

/** Pair queue depth at or above which a tier-1 warning fires (architecture §2.2.5). */
export const MAILROOM_DEPTH_ALARM_THRESHOLD: number = parseInt(
  process.env.MAILROOM_DEPTH_ALARM_THRESHOLD ?? '50',
  10,
)

/**
 * Cooldown between repeat depth-alarm posts for the same pair. Architecture
 * §2.2.5 specifies a "15-minute warning"; once posted, do not re-post until
 * the cooldown elapses, and only then if the queue is still over threshold.
 */
export const MAILROOM_DEPTH_ALARM_REPEAT_MS: number = parseInt(
  process.env.MAILROOM_DEPTH_ALARM_REPEAT_MS ?? `${15 * 60 * 1000}`,
  10,
)

/** Envelope age (ms) at or above which a tier-2 alert fires (architecture §2.2.5). */
export const MAILROOM_AGE_ALARM_MS: number = parseInt(
  process.env.MAILROOM_AGE_ALARM_MS ?? `${2 * 60 * 60 * 1000}`,
  10,
)

const ALARMS_FILE = join(STATE_DIR, 'ea-mailroom-alarms.json')
const AUDIT_FILE = join(EA_MAILROOM_DIR, 'audit.jsonl')

interface AlarmsState {
  /** pair key (`<from>-to-<to>`) → ms timestamp of last depth-alarm post. */
  depthLastAlertedAt: Record<string, number>
  /** envelopeId → ms timestamp of the age-alarm post (one-shot per envelope). */
  ageAlertedEnvelopes: Record<string, number>
}

function loadAlarms(): AlarmsState {
  if (!existsSync(ALARMS_FILE)) {
    return { depthLastAlertedAt: {}, ageAlertedEnvelopes: {} }
  }
  try {
    const raw = readFileSync(ALARMS_FILE, 'utf8')
    const parsed = JSON.parse(raw) as Partial<AlarmsState>
    return {
      depthLastAlertedAt: parsed.depthLastAlertedAt ?? {},
      ageAlertedEnvelopes: parsed.ageAlertedEnvelopes ?? {},
    }
  } catch (err) {
    logDispatcher('mailroom_alarms_load_failed', { error: String(err) })
    return { depthLastAlertedAt: {}, ageAlertedEnvelopes: {} }
  }
}

function persistAlarms(state: AlarmsState): void {
  try {
    mkdirSync(STATE_DIR, { recursive: true })
    writeJsonAtomic(ALARMS_FILE, state)
  } catch (err) {
    logDispatcher('mailroom_alarms_persist_failed', { error: String(err) })
  }
}

/**
 * Garbage-collect the age-alarm dedup map. An envelope that has been
 * delivered no longer exists on disk, so its entry can never re-fire; keep
 * the file from growing unboundedly across the life of the dispatcher.
 */
function pruneAgeDedup(state: AlarmsState, presentEnvelopeIds: Set<string>): boolean {
  let changed = false
  for (const id of Object.keys(state.ageAlertedEnvelopes)) {
    if (!presentEnvelopeIds.has(id)) {
      delete state.ageAlertedEnvelopes[id]
      changed = true
    }
  }
  return changed
}

interface AuditRecord {
  timestamp: string
  envelopeId: string
  fromPartition: string
  toPartition: string
  entity: string
  correlationId: string
  shareableWithPrincipal: boolean
  bodyPreview: string
}

function appendAudit(env: MailroomEnvelope): void {
  try {
    mkdirSync(EA_MAILROOM_DIR, { recursive: true })
    const record: AuditRecord = {
      timestamp: new Date().toISOString(),
      envelopeId: env.envelopeId,
      fromPartition: env.fromPartition,
      toPartition: env.toPartition,
      entity: env.entity,
      correlationId: env.correlationId,
      shareableWithPrincipal: env.shareableWithPrincipal,
      bodyPreview: env.body.slice(0, 200),
    }
    appendFileSync(AUDIT_FILE, JSON.stringify(record) + '\n')
  } catch (err) {
    logDispatcher('mailroom_audit_append_failed', {
      envelopeId: env.envelopeId,
      error: String(err),
    })
  }
}

/**
 * Deliver an envelope to the destination partition's mailbox by writing the
 * envelope JSON into `state/eas/<to>/mailbox/<envelopeId>.json`. The
 * destination partition's directory tree is ensured first so a fresh deploy
 * with no prior delivery does not error on a missing path.
 */
function deliverEnvelope(env: MailroomEnvelope): void {
  ensurePartitionDirs(env.toPartition)
  const path = join(partitionMailboxDir(env.toPartition), `${env.envelopeId}.json`)
  writeJsonAtomic(path, env)
  logDispatcher('mailroom_envelope_delivered', {
    envelopeId: env.envelopeId,
    fromPartition: env.fromPartition,
    toPartition: env.toPartition,
    entity: env.entity,
    correlationId: env.correlationId,
    shareableWithPrincipal: env.shareableWithPrincipal,
  })
}

interface DeliveryResult {
  delivered: number
  failures: number
  pairs: number
}

/**
 * Drain every pair queue and deliver each envelope to its destination
 * partition's mailbox. Returns a summary for the cycle log. Errors during
 * delivery are caught per-envelope so a single bad write does not stall the
 * remaining pairs.
 */
export function deliverAllPending(): DeliveryResult {
  const drained = drainAllPairs()
  let delivered = 0
  let failures = 0
  for (const { envelopes } of drained) {
    for (const env of envelopes) {
      try {
        deliverEnvelope(env)
        appendAudit(env)
        delivered++
      } catch (err) {
        failures++
        logDispatcher('mailroom_delivery_failed', {
          envelopeId: env.envelopeId,
          fromPartition: env.fromPartition,
          toPartition: env.toPartition,
          error: String(err),
        })
      }
    }
  }
  return { delivered, failures, pairs: drained.length }
}

interface AgeSweepFinding {
  envelopeId: string
  fromPartition: string
  toPartition: string
  ageMs: number
}

/**
 * Walk every pair queue (without draining) and find envelopes whose
 * `createdAt` is older than `MAILROOM_AGE_ALARM_MS`. Returns the findings;
 * the caller decides whether to alert and applies de-dup.
 */
export function findAgedEnvelopes(now: number = Date.now()): AgeSweepFinding[] {
  const findings: AgeSweepFinding[] = []
  for (const { from, to } of listPairQueues()) {
    const dir = pairQueueDir(from, to)
    if (!existsSync(dir)) continue
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      continue
    }
    for (const name of names) {
      if (!name.endsWith('.json') || name.startsWith('.')) continue
      try {
        const raw = readFileSync(join(dir, name), 'utf8')
        const parsed = JSON.parse(raw) as Partial<MailroomEnvelope>
        const id = parsed.envelopeId
        const createdAt = parsed.createdAt
        if (typeof id !== 'string' || typeof createdAt !== 'string') continue
        const created = Date.parse(createdAt)
        if (Number.isNaN(created)) continue
        const ageMs = now - created
        if (ageMs >= MAILROOM_AGE_ALARM_MS) {
          findings.push({ envelopeId: id, fromPartition: from, toPartition: to, ageMs })
        }
      } catch {
        // Malformed envelope files surface via drainPairQueue's quarantine
        // path; this sweep ignores them so it cannot double-alert.
      }
    }
  }
  return findings
}

interface AlarmCounts {
  depthAlarmsFired: number
  ageAlarmsFired: number
}

/**
 * Sweep depth and age alarms for every pair queue. Persistent de-dup via
 * the alarms state file. Async because the tier-2 escalator path makes a
 * Discord post.
 */
export async function sweepBackpressureAlarms(now: number = Date.now()): Promise<AlarmCounts> {
  const state = loadAlarms()
  let depthAlarmsFired = 0
  let ageAlarmsFired = 0
  let stateChanged = false

  // Depth alarms — one tier-1 post per pair, throttled by repeat-window.
  for (const { from, to } of listPairQueues()) {
    const depth = pairQueueDepth(from, to)
    if (depth < MAILROOM_DEPTH_ALARM_THRESHOLD) continue
    const key = `${from}-to-${to}`
    const last = state.depthLastAlertedAt[key] ?? 0
    if (now - last < MAILROOM_DEPTH_ALARM_REPEAT_MS) continue

    const summary =
      `Mailroom queue ${key} depth=${depth} ` +
      `(threshold ${MAILROOM_DEPTH_ALARM_THRESHOLD}). ` +
      `Investigate destination EA. Escalates to tier-2 if any envelope ` +
      `passes ${Math.round(MAILROOM_AGE_ALARM_MS / 60000)}m unread.`
    try {
      await postTier2Alert({
        category: 'mailroom-depth',
        summary,
        level: 'tier-1',
        channelId: OPS_ALERT_CHANNEL_ID ?? undefined,
      })
      state.depthLastAlertedAt[key] = now
      depthAlarmsFired++
      stateChanged = true
      logDispatcher('mailroom_depth_alarm_fired', { pair: key, depth })
    } catch (err) {
      logDispatcher('mailroom_depth_alarm_post_failed', {
        pair: key,
        depth,
        error: String(err),
      })
    }
  }

  // Age alarms — one tier-2 alert per envelope, persistent across restarts.
  const aged = findAgedEnvelopes(now)
  const presentIds = new Set<string>()
  for (const f of aged) presentIds.add(f.envelopeId)

  for (const f of aged) {
    if (state.ageAlertedEnvelopes[f.envelopeId] !== undefined) continue
    const summary =
      `Mailroom envelope ${f.envelopeId} (${f.fromPartition} → ${f.toPartition}) ` +
      `unconsumed for ${Math.round(f.ageMs / 60000)}m. ` +
      `Threshold ${Math.round(MAILROOM_AGE_ALARM_MS / 60000)}m. ` +
      `Check destination EA mailbox or drain pipeline.`
    try {
      await postTier2Alert({
        category: 'mailroom-aged',
        summary,
        level: 'tier-2',
        channelId: OPS_ALERT_CHANNEL_ID ?? undefined,
      })
      state.ageAlertedEnvelopes[f.envelopeId] = now
      ageAlarmsFired++
      stateChanged = true
      logDispatcher('mailroom_age_alarm_fired', {
        envelopeId: f.envelopeId,
        pair: `${f.fromPartition}-to-${f.toPartition}`,
        ageMs: f.ageMs,
      })
    } catch (err) {
      logDispatcher('mailroom_age_alarm_post_failed', {
        envelopeId: f.envelopeId,
        error: String(err),
      })
    }
  }

  // Garbage-collect age-dedup entries for envelopes no longer on disk.
  // Drives bounded growth of the alarms file across the dispatcher's life.
  if (pruneAgeDedup(state, presentIds)) stateChanged = true

  if (stateChanged) persistAlarms(state)
  return { depthAlarmsFired, ageAlarmsFired }
}

/**
 * One mailroom cycle — drain pending envelopes into destination mailboxes
 * and run backpressure alarms. Skips entirely while the dispatcher is in
 * graceful drain (envelopes stay on disk for the next process).
 *
 * Fire-and-forget shape mirrors `runKickoffCycle` / `runTenderCycle`.
 */
export async function runMailroomCycle(): Promise<void> {
  if (isDraining()) return
  const result = deliverAllPending()
  const alarms = await sweepBackpressureAlarms()
  if (
    result.delivered > 0 ||
    result.failures > 0 ||
    alarms.depthAlarmsFired > 0 ||
    alarms.ageAlarmsFired > 0
  ) {
    logDispatcher('mailroom_cycle', {
      delivered: result.delivered,
      failures: result.failures,
      pairs: result.pairs,
      depthAlarmsFired: alarms.depthAlarmsFired,
      ageAlarmsFired: alarms.ageAlarmsFired,
    })
  }
}

let mailroomInterval: ReturnType<typeof setInterval> | null = null

/**
 * Start the mailroom drain interval. Idempotent — a second call while the
 * interval is active is a no-op. Wired from index.ts after the dispatcher
 * boot path completes.
 */
export function startMailroomCycle(intervalMs: number = MAILROOM_DRAIN_INTERVAL_MS): void {
  if (mailroomInterval) return
  mailroomInterval = setInterval(() => {
    runMailroomCycle().catch((err) => {
      logDispatcher('mailroom_cycle_error', { error: String(err) })
    })
  }, intervalMs)
  logDispatcher('mailroom_cycle_started', { intervalMs })
}

/**
 * Stop the mailroom drain interval. Called from the shutdown path so the
 * timer does not fire after `markDraining()` and racing with state-file
 * flushes.
 */
export function stopMailroomCycle(): void {
  if (!mailroomInterval) return
  clearInterval(mailroomInterval)
  mailroomInterval = null
}

/** Test-only state reset. Prod code never calls this. */
export function _resetMailroomCycleForTesting(): void {
  if (mailroomInterval) {
    clearInterval(mailroomInterval)
    mailroomInterval = null
  }
}

/** Test-only path accessor for the alarms file. */
export function _alarmsFilePathForTesting(): string {
  return ALARMS_FILE
}

/** Test-only path accessor for the audit log. */
export function _auditFilePathForTesting(): string {
  return AUDIT_FILE
}
