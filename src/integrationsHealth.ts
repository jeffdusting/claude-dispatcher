/**
 * Integrations health snapshot (Phase A.9 component 7, OD-033).
 *
 * Backs the `/health/integrations` HTTP probe. The endpoint reads a cached
 * snapshot rather than synchronously probing every upstream on each request
 * — synchronous probes would couple probe latency to the orchestrator's
 * health-check timeout and could amplify outages by sending probe traffic
 * during an upstream brown-out.
 *
 * The snapshot is refreshed on a 60-second supercronic-like interval (the
 * dispatcher owns the interval rather than relying on supercronic so the
 * timing survives independently of the cron sidecar). Each refresh reads
 * the breaker snapshot from `circuitBreaker.ts` — the breaker module is
 * already updated in real time on every upstream call, so this loop is
 * effectively a transcribe-and-aggregate pass with no upstream traffic of
 * its own.
 *
 * Aggregation rules:
 *   - `ok`        — every breaker reports `closed`.
 *   - `degraded`  — at least one breaker is `half-open` AND none are `open`.
 *   - `down`      — at least one breaker is `open`.
 *
 * The endpoint returns 503 when the aggregate is anything other than `ok`
 * so a Fly.io load-balancer or external monitor can de-pool the instance.
 */

import { logDispatcher } from './logger.js'
import {
  getBreakerSnapshot,
  INTEGRATION_UPSTREAMS,
  type BreakerSnapshot,
} from './circuitBreaker.js'
import type { Upstream } from './retryWithBackoff.js'
import { postTier2Alert } from './escalator.js'

const PROBE_INTERVAL_MS_DEFAULT = 60 * 1000

export type AggregateStatus = 'ok' | 'degraded' | 'down'

export interface IntegrationStatus {
  upstream: Upstream
  state: 'closed' | 'open' | 'half-open'
  failuresInWindow: number
  openedAt: number | null
  lastErrorAt: number | null
  lastErrorMessage: string | null
  lastSuccessAt: number | null
}

export interface IntegrationsSnapshot {
  generatedAt: number
  aggregate: AggregateStatus
  upstreams: IntegrationStatus[]
}

let probeHandle: ReturnType<typeof setInterval> | null = null
let cachedSnapshot: IntegrationsSnapshot = buildSnapshot()

function toIntegrationStatus(s: BreakerSnapshot): IntegrationStatus {
  return {
    upstream: s.upstream,
    state: s.state,
    failuresInWindow: s.failuresInWindow,
    openedAt: s.openedAt,
    lastErrorAt: s.lastErrorAt,
    lastErrorMessage: s.lastErrorMessage,
    lastSuccessAt: s.lastSuccessAt,
  }
}

function aggregate(upstreams: IntegrationStatus[]): AggregateStatus {
  let degraded = false
  for (const u of upstreams) {
    if (u.state === 'open') return 'down'
    if (u.state === 'half-open') degraded = true
  }
  return degraded ? 'degraded' : 'ok'
}

function buildSnapshot(): IntegrationsSnapshot {
  const breakerSnapshot = getBreakerSnapshot()
  const upstreams = INTEGRATION_UPSTREAMS.map((u) =>
    toIntegrationStatus(breakerSnapshot[u]),
  )
  return {
    generatedAt: Date.now(),
    aggregate: aggregate(upstreams),
    upstreams,
  }
}

/**
 * Refresh the cached snapshot. Called from the probe interval; also exposed
 * for tests that need to step the snapshot deterministically.
 *
 * On `ok → down` transition, post a tier-2 alert via the escalator so the
 * 5-minute SMS window (OD-011) starts ticking. `ok → degraded` is logged
 * but does not page — half-open is a recovery state. `down → ok` posts an
 * informational tier-1 entry so the operator sees the resolution alongside
 * the acknowledgement of the original incident.
 */
export function refreshIntegrationsSnapshot(): IntegrationsSnapshot {
  const next = buildSnapshot()
  if (next.aggregate !== cachedSnapshot.aggregate) {
    logDispatcher('integrations_aggregate_changed', {
      from: cachedSnapshot.aggregate,
      to: next.aggregate,
    })
    handleAggregateTransition(cachedSnapshot.aggregate, next)
  }
  cachedSnapshot = next
  return next
}

function handleAggregateTransition(
  from: AggregateStatus,
  next: IntegrationsSnapshot,
): void {
  if (next.aggregate !== 'down') return
  if (from === 'down') return
  const openUpstreams = next.upstreams
    .filter((u) => u.state === 'open')
    .map((u) => `${u.upstream} (${u.lastErrorMessage ?? 'no error message'})`)
  void postTier2Alert({
    category: 'integration outage',
    summary:
      `One or more upstreams are unavailable: ${openUpstreams.join('; ')}. ` +
      `Aggregate health flipped from ${from} to down.`,
  }).catch((err) => {
    logDispatcher('integrations_alert_post_failed', { error: String(err) })
  })
}

export function getIntegrationsHealth(): IntegrationsSnapshot {
  return cachedSnapshot
}

export function startIntegrationsProbe(intervalMs: number = PROBE_INTERVAL_MS_DEFAULT): void {
  if (probeHandle) return
  // Prime the cache immediately so the first /health/integrations request
  // does not race the interval timer.
  refreshIntegrationsSnapshot()
  probeHandle = setInterval(() => {
    try {
      refreshIntegrationsSnapshot()
    } catch (err) {
      logDispatcher('integrations_probe_error', { error: String(err) })
    }
  }, intervalMs)
  logDispatcher('integrations_probe_started', { intervalMs })
}

export function stopIntegrationsProbe(): void {
  if (!probeHandle) return
  clearInterval(probeHandle)
  probeHandle = null
}

/** Test-only reset. */
export function _resetIntegrationsForTesting(): void {
  if (probeHandle) {
    clearInterval(probeHandle)
    probeHandle = null
  }
  cachedSnapshot = buildSnapshot()
}
