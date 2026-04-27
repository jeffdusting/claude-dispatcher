/**
 * Per-upstream circuit breaker (Phase A.9.2, Δ D-003).
 *
 * Spec (Migration Plan §4.9.2): 3 failures within 60 seconds trips for
 * 60 seconds; probe-and-close pattern. One probe call is admitted on
 * cooldown expiry — success closes the breaker; failure re-opens it for
 * another 60-second cycle.
 *
 * Designed to compose with `retryWithBackoff`: callers wrap an operation
 * with `withBreaker(upstream, () => retryWithBackoff(fn, ...))` so each
 * fully-exhausted retry budget counts as one breaker failure rather than
 * five. The combination is exposed via `withUpstream` for convenience.
 *
 * Snapshot exposure (`getBreakerSnapshot`) feeds the future
 * `/health/integrations` endpoint scheduled for Phase A.9 component 7
 * (OD-033). Designed to be cheap (object literal) so the probe handler
 * can call it on every request.
 */

import { retryWithBackoff, type RetryOptions, type Upstream } from './retryWithBackoff.js'
import { logDispatcher } from './logger.js'

export type { Upstream } from './retryWithBackoff.js'
export type BreakerState = 'closed' | 'open' | 'half-open'

export interface BreakerSnapshot {
  upstream: Upstream
  state: BreakerState
  failuresInWindow: number
  openedAt: number | null
  lastErrorAt: number | null
  lastErrorMessage: string | null
  lastSuccessAt: number | null
}

export interface BreakerConfig {
  /** Failures within `windowMs` that trip the breaker. Spec default: 3. */
  failureThreshold: number
  /** Sliding window over which failures are counted. Spec default: 60 000ms. */
  windowMs: number
  /** Time the breaker stays open before admitting a probe. Spec default: 60 000ms. */
  cooldownMs: number
}

const DEFAULT_CONFIG: BreakerConfig = {
  failureThreshold: 3,
  windowMs: 60_000,
  cooldownMs: 60_000,
}

interface BreakerEntry {
  state: BreakerState
  /** Timestamps (ms) of recent failures, kept trimmed to `config.windowMs`. */
  failureTimestamps: number[]
  openedAt: number | null
  lastErrorAt: number | null
  lastErrorMessage: string | null
  lastSuccessAt: number | null
  /**
   * When the breaker is half-open, only one probe call is admitted at a
   * time. `probeInFlight` blocks subsequent callers until the probe
   * resolves, at which point the breaker is either closed (success) or
   * re-opened (failure).
   */
  probeInFlight: Promise<unknown> | null
}

const breakers: Map<Upstream, BreakerEntry> = new Map()
const config: BreakerConfig = { ...DEFAULT_CONFIG }

/** Test-only: reset state. */
export function _resetBreakersForTesting(overrides: Partial<BreakerConfig> = {}): void {
  breakers.clear()
  Object.assign(config, DEFAULT_CONFIG, overrides)
}

function entry(upstream: Upstream): BreakerEntry {
  let e = breakers.get(upstream)
  if (!e) {
    e = {
      state: 'closed',
      failureTimestamps: [],
      openedAt: null,
      lastErrorAt: null,
      lastErrorMessage: null,
      lastSuccessAt: null,
      probeInFlight: null,
    }
    breakers.set(upstream, e)
  }
  return e
}

function trimWindow(e: BreakerEntry, now: number): void {
  const cutoff = now - config.windowMs
  while (e.failureTimestamps.length > 0 && e.failureTimestamps[0]! < cutoff) {
    e.failureTimestamps.shift()
  }
}

function shouldHalfOpen(e: BreakerEntry, now: number): boolean {
  return e.state === 'open' &&
    e.openedAt !== null &&
    now - e.openedAt >= config.cooldownMs
}

export class CircuitOpenError extends Error {
  readonly upstream: Upstream
  readonly retryAfterMs: number
  constructor(upstream: Upstream, retryAfterMs: number) {
    super(`Circuit breaker open for upstream "${upstream}" — retry in ${retryAfterMs}ms`)
    this.name = 'CircuitOpenError'
    this.upstream = upstream
    this.retryAfterMs = retryAfterMs
  }
}

/**
 * Externally record a successful upstream interaction. Used by callers that
 * cannot route through `withBreaker` (e.g. Anthropic via subprocess spawn,
 * where auto-retrying the subprocess is unsafe) but still want the breaker
 * state to reflect upstream health.
 */
export function recordBreakerSuccess(upstream: Upstream): void {
  recordSuccess(upstream)
}

/**
 * Externally record a failed upstream interaction. Counts toward the
 * sliding-window threshold; opens the breaker on threshold breach.
 */
export function recordBreakerFailure(upstream: Upstream, err: unknown): void {
  recordFailure(upstream, err)
}

function recordSuccess(upstream: Upstream): void {
  const e = entry(upstream)
  const now = Date.now()
  e.lastSuccessAt = now
  e.failureTimestamps = []
  if (e.state !== 'closed') {
    logDispatcher('breaker_closed', { upstream, prevState: e.state })
  }
  e.state = 'closed'
  e.openedAt = null
}

function recordFailure(upstream: Upstream, err: unknown): void {
  const e = entry(upstream)
  const now = Date.now()
  e.lastErrorAt = now
  e.lastErrorMessage = String(err).slice(0, 300)
  e.failureTimestamps.push(now)
  trimWindow(e, now)

  if (e.state === 'half-open') {
    e.state = 'open'
    e.openedAt = now
    logDispatcher('breaker_reopened', { upstream, error: e.lastErrorMessage })
    return
  }

  if (e.state === 'closed' && e.failureTimestamps.length >= config.failureThreshold) {
    e.state = 'open'
    e.openedAt = now
    logDispatcher('breaker_opened', {
      upstream,
      failuresInWindow: e.failureTimestamps.length,
      windowMs: config.windowMs,
      error: e.lastErrorMessage,
    })
  }
}

/**
 * Run `fn` gated by the upstream's circuit breaker. Behaviour:
 *  - state=closed: pass through; on rejection, count toward window;
 *    open after `failureThreshold` within `windowMs`.
 *  - state=open: throw `CircuitOpenError` immediately. After `cooldownMs`,
 *    the next call transitions to half-open and is admitted as a probe.
 *  - state=half-open: a single probe is admitted; concurrent callers
 *    join the same probe via `probeInFlight`. Probe success closes the
 *    breaker; probe failure re-opens it.
 */
export async function withBreaker<T>(
  upstream: Upstream,
  fn: () => Promise<T>,
): Promise<T> {
  const e = entry(upstream)
  const now = Date.now()
  trimWindow(e, now)

  if (e.state === 'open' && shouldHalfOpen(e, now)) {
    e.state = 'half-open'
    logDispatcher('breaker_half_open', { upstream })
  }

  if (e.state === 'open') {
    const retryAfterMs =
      e.openedAt !== null
        ? Math.max(0, config.cooldownMs - (now - e.openedAt))
        : 0
    throw new CircuitOpenError(upstream, retryAfterMs)
  }

  if (e.state === 'half-open') {
    if (e.probeInFlight) {
      // Another caller is probing — wait for the result.
      try {
        await e.probeInFlight
      } catch {
        // The probe failed — fall through to the post-probe state read.
      }
      // After awaiting, the breaker is either 'closed' (probe succeeded)
      // or 'open' (probe failed). Either way, re-enter withBreaker so
      // the new state is observed correctly.
      return withBreaker(upstream, fn)
    }
    const probe = (async () => {
      try {
        const result = await fn()
        recordSuccess(upstream)
        return result
      } catch (err) {
        recordFailure(upstream, err)
        throw err
      } finally {
        e.probeInFlight = null
      }
    })()
    e.probeInFlight = probe
    return probe as Promise<T>
  }

  // state === 'closed'
  try {
    const result = await fn()
    recordSuccess(upstream)
    return result
  } catch (err) {
    recordFailure(upstream, err)
    throw err
  }
}

export function getBreakerState(upstream: Upstream): BreakerState {
  const e = breakers.get(upstream)
  if (!e) return 'closed'
  const now = Date.now()
  if (e.state === 'open' && shouldHalfOpen(e, now)) return 'half-open'
  return e.state
}

export function getBreakerSnapshot(): Record<Upstream, BreakerSnapshot> {
  const upstreams: Upstream[] = ['anthropic', 'paperclip', 'drive', 'graph']
  const out = {} as Record<Upstream, BreakerSnapshot>
  for (const upstream of upstreams) {
    const e = breakers.get(upstream)
    if (!e) {
      out[upstream] = {
        upstream,
        state: 'closed',
        failuresInWindow: 0,
        openedAt: null,
        lastErrorAt: null,
        lastErrorMessage: null,
        lastSuccessAt: null,
      }
      continue
    }
    trimWindow(e, Date.now())
    out[upstream] = {
      upstream,
      state: getBreakerState(upstream),
      failuresInWindow: e.failureTimestamps.length,
      openedAt: e.openedAt,
      lastErrorAt: e.lastErrorAt,
      lastErrorMessage: e.lastErrorMessage,
      lastSuccessAt: e.lastSuccessAt,
    }
  }
  return out
}

/**
 * Convenience composition: retry with backoff, gated by the breaker.
 * A fully-exhausted retry budget counts as a single breaker failure,
 * keeping trip semantics aligned with the spec's "3 failures in 60s".
 */
export function withUpstream<T>(
  upstream: Upstream,
  fn: () => Promise<T>,
  retryOpts?: Omit<RetryOptions, 'upstream'>,
): Promise<T> {
  return withBreaker(upstream, () =>
    retryWithBackoff(fn, { upstream, ...retryOpts }),
  )
}
