/**
 * Anthropic monthly-cap detector and per-consumer budget tracker
 * (Phase A.9.9, Δ E-001 / I-001, OD-012).
 *
 * Two paths cover the same surface from different angles:
 *
 *  - Reactive path: when a Claude subprocess exits with an error whose
 *    text matches the monthly-cap signature, `recordCapHitFromError` is
 *    called. The marker file is written so the kickoff cycle pauses; in-
 *    flight workers continue to drain on the existing cap allowance. A
 *    tier-2 Discord alert posts via the escalator so the operator knows.
 *
 *  - Proactive path: a periodic loop queries the Anthropic Admin API for
 *    cycle-to-date organisation usage and, when an API key tag is set up
 *    per consumer, per-consumer usage. The 70 / 85 / 95% thresholds fire
 *    informational alerts before the cap is actually hit.
 *
 * The reference scenario is the 24 April 2026 cap-hit incident: a single
 * spike in dispatcher consumption pushed the organisation past its
 * monthly limit; per-request 5xx retries did not detect it because the
 * upstream error was a 400 with a billing-related message rather than a
 * transient 5xx. The classifier below distinguishes the two so the
 * retry/breaker layer does not waste budget against a deterministic
 * billing failure.
 *
 * The marker file lives at STATE_DIR/anthropic-cap.json. While present,
 * `isAnthropicCapHit()` returns true and `gateway.runKickoffCycle` skips
 * the drain. Operator clears it with `clearAnthropicCapHit()` (typically
 * once the next reset is observed via the proactive loop).
 */

import { readFileSync, existsSync, unlinkSync, mkdirSync } from 'fs'
import { join } from 'path'
import { writeJsonAtomic } from './atomicWrite.js'
import {
  STATE_DIR,
  ANTHROPIC_ADMIN_KEY,
  ANTHROPIC_MONTHLY_CAP_USD,
  ANTHROPIC_BUDGET_SPLIT,
} from './config.js'
import { logDispatcher } from './logger.js'
import { postTier2Alert } from './escalator.js'

mkdirSync(STATE_DIR, { recursive: true })
const CAP_MARKER_FILE = join(STATE_DIR, 'anthropic-cap.json')

const PROBE_INTERVAL_MS_DEFAULT = 30 * 60 * 1000  // 30 minutes
const BUDGET_THRESHOLDS = [0.70, 0.85, 0.95] as const

export type Consumer = keyof typeof ANTHROPIC_BUDGET_SPLIT

interface CapMarker {
  capHitAt: number
  detectedVia: 'reactive' | 'proactive'
  errorMessage: string | null
  nextResetAt: number | null
}

/**
 * Patterns Anthropic uses in monthly-cap / billing errors. Drawn from the
 * 24 April 2026 incident plus published API error documentation. Kept
 * narrow so transient 5xx do not match.
 */
const MONTHLY_CAP_PATTERNS: RegExp[] = [
  /credit balance is too low/i,
  /monthly cost limit/i,
  /exceeded.{0,40}monthly/i,
  /billing.{0,40}limit/i,
  /organization has reached.{0,40}cap/i,
  /usage limit.{0,40}exceeded/i,
  /your monthly.{0,40}budget/i,
]

export type AnthropicErrorClass = 'monthly-cap' | 'transient' | 'other'

/**
 * Classify an Anthropic-side error so the retry and breaker layers do not
 * waste budget on a deterministic billing failure. Pure: no side effects.
 */
export function classifyAnthropicError(input: unknown): AnthropicErrorClass {
  const msg = errorText(input)
  for (const pat of MONTHLY_CAP_PATTERNS) {
    if (pat.test(msg)) return 'monthly-cap'
  }
  // Per-request transient signatures the retry/breaker layer already
  // handles. Mirrored loosely from retryWithBackoff.isTransientError so the
  // classes are mutually exclusive.
  if (/\b(429|500|502|503|504|529)\b/.test(msg)) return 'transient'
  if (/timeout|timed out|temporarily|rate limit/i.test(msg)) return 'transient'
  return 'other'
}

function errorText(input: unknown): string {
  if (typeof input === 'string') return input
  if (input && typeof input === 'object') {
    const e = input as Record<string, unknown>
    const direct = typeof e.message === 'string' ? e.message : ''
    const nested =
      typeof e.error === 'object' && e.error !== null && typeof (e.error as { message?: unknown }).message === 'string'
        ? (e.error as { message: string }).message
        : ''
    return [direct, nested].filter(Boolean).join(' ')
  }
  return String(input ?? '')
}

export function isAnthropicCapHit(): boolean {
  return existsSync(CAP_MARKER_FILE)
}

export function readCapMarker(): CapMarker | null {
  if (!existsSync(CAP_MARKER_FILE)) return null
  try {
    return JSON.parse(readFileSync(CAP_MARKER_FILE, 'utf8')) as CapMarker
  } catch (err) {
    logDispatcher('cap_marker_read_failed', { error: String(err) })
    return null
  }
}

function writeCapMarker(marker: CapMarker): void {
  writeJsonAtomic(CAP_MARKER_FILE, marker)
}

export function clearAnthropicCapHit(): void {
  if (!existsSync(CAP_MARKER_FILE)) return
  try {
    unlinkSync(CAP_MARKER_FILE)
    logDispatcher('cap_marker_cleared')
  } catch (err) {
    logDispatcher('cap_marker_clear_failed', { error: String(err) })
  }
}

/**
 * Reactive entry point: claude.ts calls this when a subprocess exit
 * matches the monthly-cap signature. Idempotent — repeated calls update
 * the latest error message but keep the original `capHitAt`.
 */
export function recordCapHitFromError(rawError: unknown): void {
  const message = errorText(rawError).slice(0, 500)
  const existing = readCapMarker()
  const marker: CapMarker = existing
    ? { ...existing, errorMessage: message }
    : {
        capHitAt: Date.now(),
        detectedVia: 'reactive',
        errorMessage: message,
        nextResetAt: null,
      }
  writeCapMarker(marker)
  if (!existing) {
    logDispatcher('anthropic_cap_hit', {
      detectedVia: 'reactive',
      errorMessage: message,
    })
    void postTier2Alert({
      category: 'Anthropic monthly cap hit',
      summary:
        `Anthropic reported a monthly-cap / billing error from a worker subprocess. ` +
        `Kickoff cycle is paused; in-flight workers continue. Error: ${message}`,
    }).catch((err) => {
      logDispatcher('cap_alert_post_failed', { error: String(err) })
    })
  }
}

// ─── Proactive budget check ──────────────────────────────────────────

interface UsageReport {
  totalUsd: number
  byConsumer: Partial<Record<Consumer, number>>
  cycleStartIso: string
  cycleEndIso: string
}

/** Tracks the highest-tripped threshold per consumer so we don't re-alert. */
const lastTrippedThreshold: Map<Consumer, number> = new Map()
let probeHandle: ReturnType<typeof setInterval> | null = null
let proactiveSkipLogged = false

/**
 * Fetch organisation usage from the Anthropic Admin API. Stub implementation
 * — the Admin API surface for usage reports has been in flux through 2025-26;
 * the network call is gated on `ANTHROPIC_ADMIN_KEY` so the proactive path
 * is dormant until the key is provisioned (Phase B.4). When the call fails
 * or no key is set, returns null and the caller treats the absence of data
 * as inconclusive (no threshold transitions fire).
 */
async function fetchUsageReport(): Promise<UsageReport | null> {
  if (!ANTHROPIC_ADMIN_KEY) {
    if (!proactiveSkipLogged) {
      logDispatcher('cap_proactive_skipped', { reason: 'no admin key' })
      proactiveSkipLogged = true
    }
    return null
  }
  try {
    const url = 'https://api.anthropic.com/v1/organizations/usage_report/messages'
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'x-api-key': ANTHROPIC_ADMIN_KEY,
        'anthropic-version': '2023-06-01',
      },
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      logDispatcher('cap_proactive_fetch_failed', {
        status: res.status,
        body: body.slice(0, 300),
      })
      return null
    }
    const json = (await res.json()) as Record<string, unknown>
    return parseUsageReport(json)
  } catch (err) {
    logDispatcher('cap_proactive_fetch_error', { error: String(err).slice(0, 200) })
    return null
  }
}

/**
 * Parse the Admin API response. Tolerant: unknown shapes return null so
 * the caller treats it as inconclusive rather than mis-attributing usage.
 */
function parseUsageReport(json: Record<string, unknown>): UsageReport | null {
  const data = (json.data ?? json) as Record<string, unknown>
  const totalRaw = (data as { total_cost_usd?: unknown }).total_cost_usd
  const total = typeof totalRaw === 'number' ? totalRaw : null
  if (total === null) return null
  const byConsumerRaw = (data as { by_consumer?: unknown }).by_consumer
  const byConsumer: Partial<Record<Consumer, number>> = {}
  if (byConsumerRaw && typeof byConsumerRaw === 'object') {
    const obj = byConsumerRaw as Record<string, unknown>
    for (const k of Object.keys(ANTHROPIC_BUDGET_SPLIT) as Consumer[]) {
      const v = obj[k]
      if (typeof v === 'number') byConsumer[k] = v
    }
  }
  return {
    totalUsd: total,
    byConsumer,
    cycleStartIso:
      typeof (data as { cycle_start?: unknown }).cycle_start === 'string'
        ? ((data as { cycle_start: string }).cycle_start)
        : '',
    cycleEndIso:
      typeof (data as { cycle_end?: unknown }).cycle_end === 'string'
        ? ((data as { cycle_end: string }).cycle_end)
        : '',
  }
}

/**
 * One pass of the proactive budget check. Reads usage, computes per-consumer
 * spend versus its OD-012 allocation, and posts threshold alerts for any
 * consumer that newly crossed 70 / 85 / 95%. Idempotent — already-tripped
 * thresholds do not re-alert until usage drops below them and crosses
 * upward again.
 */
export async function checkBudget(): Promise<UsageReport | null> {
  const report = await fetchUsageReport()
  if (!report) return null

  for (const consumer of Object.keys(ANTHROPIC_BUDGET_SPLIT) as Consumer[]) {
    if (consumer === 'reserve') continue
    const allocated = ANTHROPIC_MONTHLY_CAP_USD * ANTHROPIC_BUDGET_SPLIT[consumer]
    const spent = report.byConsumer[consumer] ?? 0
    const ratio = allocated > 0 ? spent / allocated : 0
    const lastThresh = lastTrippedThreshold.get(consumer) ?? 0

    let crossed: number | null = null
    for (const t of BUDGET_THRESHOLDS) {
      if (ratio >= t && lastThresh < t) crossed = t
    }
    if (ratio < BUDGET_THRESHOLDS[0]!) {
      lastTrippedThreshold.set(consumer, 0)
      continue
    }
    if (crossed !== null) {
      lastTrippedThreshold.set(consumer, crossed)
      logDispatcher('budget_threshold_crossed', {
        consumer,
        threshold: crossed,
        spent,
        allocated,
      })
      void postTier2Alert({
        category: 'Anthropic budget threshold',
        level: crossed >= 0.95 ? 'tier-2' : 'tier-1',
        summary:
          `Consumer "${consumer}" crossed ${Math.round(crossed * 100)}% of its monthly allocation ` +
          `(USD ${spent.toFixed(2)} of ${allocated.toFixed(2)}; ` +
          `cycle ${report.cycleStartIso || 'n/a'} → ${report.cycleEndIso || 'n/a'}).`,
      }).catch((err) => {
        logDispatcher('budget_alert_post_failed', { error: String(err) })
      })
    }
  }
  return report
}

export function startCapDetector(intervalMs: number = PROBE_INTERVAL_MS_DEFAULT): void {
  if (probeHandle) return
  // Fire once on start so the first reading is captured promptly; subsequent
  // probes follow the interval.
  void checkBudget().catch((err) => {
    logDispatcher('cap_probe_error', { error: String(err) })
  })
  probeHandle = setInterval(() => {
    void checkBudget().catch((err) => {
      logDispatcher('cap_probe_error', { error: String(err) })
    })
  }, intervalMs)
  logDispatcher('cap_detector_started', {
    intervalMs,
    monthlyCapUsd: ANTHROPIC_MONTHLY_CAP_USD,
    proactive: ANTHROPIC_ADMIN_KEY !== null,
  })
}

export function stopCapDetector(): void {
  if (!probeHandle) return
  clearInterval(probeHandle)
  probeHandle = null
}

/** Test-only reset. */
export function _resetCapDetectorForTesting(): void {
  if (probeHandle) {
    clearInterval(probeHandle)
    probeHandle = null
  }
  lastTrippedThreshold.clear()
  proactiveSkipLogged = false
  if (existsSync(CAP_MARKER_FILE)) {
    try { unlinkSync(CAP_MARKER_FILE) } catch {}
  }
}
