/**
 * Tier-2 alert escalator (Phase A.9.8, Δ O-002, OD-011).
 *
 * Tier-2 conditions — dispatcher down, integration outage, backup failure,
 * security event — are first surfaced via a Discord post in
 * OPS_ALERT_CHANNEL_ID. If the operator does not acknowledge the alert
 * within TIER2_ACK_WINDOW_MS (5 minutes per OD-011), SMS is sent via
 * Twilio so the alert reaches them off-platform.
 *
 * Acknowledgement is "any reaction by a non-bot user on the alert
 * message". Any of 👍 ✅ 🆗 etc. clears the escalation. The reaction is
 * recorded with the responding user; the alert is left in the registry as
 * `acked` so post-incident review can see who picked it up.
 *
 * State is persisted to STATE_DIR/tier2-alerts.json so a dispatcher
 * restart mid-window does not lose pending escalations. The persisted
 * file is small (one entry per active tier-2 condition) and cheap to
 * rewrite via the atomic-write helper.
 *
 * The escalator does NOT block on the SMS request — Twilio outages or
 * a slow upstream cannot stall the dispatcher. The HTTP request runs on
 * the next tick; failure is logged.
 */

import { readFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { writeJsonAtomic } from './atomicWrite.js'
import {
  STATE_DIR,
  OPS_ALERT_CHANNEL_ID,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_FROM_NUMBER,
  OPERATOR_MOBILE,
  TIER2_ACK_WINDOW_MS,
} from './config.js'
import { logDispatcher } from './logger.js'

const SWEEP_INTERVAL_MS_DEFAULT = 30 * 1000

mkdirSync(STATE_DIR, { recursive: true })
const ALERTS_FILE = join(STATE_DIR, 'tier2-alerts.json')

export type Tier2Level = 'tier-2' | 'tier-1'

export interface Tier2AlertRecord {
  alertId: string
  level: Tier2Level
  category: string
  summary: string
  channelId: string | null
  messageId: string | null
  postedAt: number
  ackedAt: number | null
  ackedBy: string | null
  escalatedAt: number | null
  escalationStatus: 'pending' | 'sent' | 'skipped' | 'failed'
  escalationReason: string | null
  recipientMobile: string | null
}

export interface PostTier2Alert {
  category: string
  summary: string
  /** Override the default ops alert channel. */
  channelId?: string
  /** Defaults to `tier-2`. */
  level?: Tier2Level
  /** Override the recipient (E.164). Defaults to OPERATOR_MOBILE. */
  recipientMobile?: string
}

const records: Map<string, Tier2AlertRecord> = new Map()
let sweepHandle: ReturnType<typeof setInterval> | null = null

type DiscordPoster = (channelId: string, body: string) => Promise<string | null>
let discordPoster: DiscordPoster | null = null

function loadFromDisk(): void {
  if (!existsSync(ALERTS_FILE)) return
  try {
    const raw = readFileSync(ALERTS_FILE, 'utf8')
    const parsed = JSON.parse(raw) as Tier2AlertRecord[]
    for (const r of parsed) records.set(r.alertId, r)
    logDispatcher('escalator_loaded', { count: records.size })
  } catch (err) {
    logDispatcher('escalator_load_failed', { error: String(err) })
  }
}

function persist(): void {
  try {
    writeJsonAtomic(ALERTS_FILE, Array.from(records.values()))
  } catch (err) {
    logDispatcher('escalator_persist_failed', { error: String(err) })
  }
}

loadFromDisk()

/**
 * Register the Discord posting function. Called from gateway.ts after
 * client.login resolves. The escalator can also run without a poster
 * (e.g. in spare mode); in that case alerts are logged but not posted to
 * Discord, and SMS escalation still fires after the window because the
 * unacked record is what the sweep checks.
 */
export function setDiscordPoster(poster: DiscordPoster | null): void {
  discordPoster = poster
}

/**
 * Register a previously-posted Discord message ID against an alertId.
 * Used after the post resolves. Idempotent.
 */
function attachMessageId(alertId: string, messageId: string): void {
  const r = records.get(alertId)
  if (!r) return
  r.messageId = messageId
  persist()
}

/**
 * Post a tier-2 alert. The alert is registered immediately so the sweep
 * can escalate it even if the Discord post fails. Returns the alertId so
 * the caller can correlate with subsequent acknowledgement events; null
 * is never returned.
 */
export async function postTier2Alert(opts: PostTier2Alert): Promise<string> {
  const alertId = randomUUID()
  const now = Date.now()
  const channelId = opts.channelId ?? OPS_ALERT_CHANNEL_ID
  const recipientMobile = opts.recipientMobile ?? OPERATOR_MOBILE

  const record: Tier2AlertRecord = {
    alertId,
    level: opts.level ?? 'tier-2',
    category: opts.category,
    summary: opts.summary,
    channelId: channelId ?? null,
    messageId: null,
    postedAt: now,
    ackedAt: null,
    ackedBy: null,
    escalatedAt: null,
    escalationStatus: 'pending',
    escalationReason: null,
    recipientMobile: recipientMobile ?? null,
  }
  records.set(alertId, record)
  persist()

  logDispatcher('tier2_alert_posted', {
    alertId,
    category: record.category,
    summary: record.summary.slice(0, 200),
    level: record.level,
    channelId: record.channelId,
    hasRecipient: record.recipientMobile !== null,
  })

  if (channelId && discordPoster) {
    const body = formatDiscordBody(record)
    try {
      const messageId = await discordPoster(channelId, body)
      if (messageId) attachMessageId(alertId, messageId)
    } catch (err) {
      logDispatcher('tier2_alert_post_failed', {
        alertId,
        channelId,
        error: String(err).slice(0, 200),
      })
    }
  }

  return alertId
}

function formatDiscordBody(r: Tier2AlertRecord): string {
  const ackHint = '\nReact to this message to acknowledge and prevent SMS escalation.'
  return `**[${r.level.toUpperCase()}] ${r.category}**\n${r.summary}${ackHint}`
}

/**
 * Acknowledge a tier-2 alert by its Discord messageId. Called from the
 * gateway's reaction handler. Returns true if a record was matched and
 * marked.
 */
export function acknowledgeByMessageId(messageId: string, userId: string): boolean {
  for (const r of records.values()) {
    if (r.messageId !== messageId) continue
    if (r.ackedAt !== null) return true
    r.ackedAt = Date.now()
    r.ackedBy = userId
    if (r.escalationStatus === 'pending') {
      r.escalationStatus = 'skipped'
      r.escalationReason = 'acked before window'
    }
    logDispatcher('tier2_alert_acked', {
      alertId: r.alertId,
      messageId,
      userId,
      ageSeconds: Math.round((Date.now() - r.postedAt) / 1000),
    })
    persist()
    return true
  }
  return false
}

/**
 * Test-friendly accessor for a record. Not exposed to runtime callers.
 */
export function _getAlertForTesting(alertId: string): Tier2AlertRecord | undefined {
  return records.get(alertId)
}

/**
 * Send SMS via Twilio. Returns true on success. Failures are logged with
 * the upstream error; they do not throw.
 */
async function sendSmsViaTwilio(toMobile: string, body: string): Promise<boolean> {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_FROM_NUMBER) {
    logDispatcher('twilio_skipped_missing_creds', {
      hasSid: !!TWILIO_ACCOUNT_SID,
      hasToken: !!TWILIO_AUTH_TOKEN,
      hasFrom: !!TWILIO_FROM_NUMBER,
    })
    return false
  }
  const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`
  const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64')
  const form = new URLSearchParams({
    To: toMobile,
    From: TWILIO_FROM_NUMBER,
    Body: body.slice(0, 1500),
  })
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      logDispatcher('twilio_send_failed', {
        status: res.status,
        body: text.slice(0, 300),
      })
      return false
    }
    return true
  } catch (err) {
    logDispatcher('twilio_send_error', { error: String(err).slice(0, 200) })
    return false
  }
}

/**
 * Walk pending records and escalate any that crossed the ack window
 * without acknowledgement. Idempotent and safe to call repeatedly. The
 * sweep is async because escalation makes an HTTP request to Twilio; the
 * function awaits all in-flight escalations so the caller can sequence
 * shutdown after a final sweep.
 */
export async function sweepEscalations(now: number = Date.now()): Promise<number> {
  let escalated = 0
  for (const r of records.values()) {
    if (r.escalationStatus !== 'pending') continue
    if (r.ackedAt !== null) continue
    if (now - r.postedAt < TIER2_ACK_WINDOW_MS) continue

    if (!r.recipientMobile) {
      r.escalationStatus = 'skipped'
      r.escalationReason = 'no recipient mobile configured'
      r.escalatedAt = now
      logDispatcher('tier2_escalation_skipped', {
        alertId: r.alertId,
        reason: r.escalationReason,
      })
      persist()
      continue
    }

    const body =
      `[${r.level.toUpperCase()}] ${r.category}: ${r.summary} ` +
      `(unacked ${Math.round((now - r.postedAt) / 1000)}s — alert ${r.alertId.slice(0, 8)})`
    const ok = await sendSmsViaTwilio(r.recipientMobile, body)
    r.escalatedAt = Date.now()
    r.escalationStatus = ok ? 'sent' : 'failed'
    r.escalationReason = ok ? null : 'twilio send failed'
    if (ok) escalated++
    logDispatcher('tier2_escalation_attempted', {
      alertId: r.alertId,
      ok,
      recipient: r.recipientMobile,
      ageSeconds: Math.round((now - r.postedAt) / 1000),
    })
    persist()
  }
  return escalated
}

export function startEscalator(intervalMs: number = SWEEP_INTERVAL_MS_DEFAULT): void {
  if (sweepHandle) return
  sweepHandle = setInterval(() => {
    sweepEscalations().catch((err) => {
      logDispatcher('escalator_sweep_error', { error: String(err) })
    })
  }, intervalMs)
  logDispatcher('escalator_started', { intervalMs, ackWindowMs: TIER2_ACK_WINDOW_MS })
}

export function stopEscalator(): void {
  if (!sweepHandle) return
  clearInterval(sweepHandle)
  sweepHandle = null
}

/** Test-only reset. */
export function _resetEscalatorForTesting(): void {
  records.clear()
  if (sweepHandle) {
    clearInterval(sweepHandle)
    sweepHandle = null
  }
  discordPoster = null
}
