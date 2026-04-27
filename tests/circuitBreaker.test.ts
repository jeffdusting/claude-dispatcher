import { describe, test, expect, beforeEach } from 'bun:test'
import {
  withBreaker,
  withUpstream,
  recordBreakerFailure,
  recordBreakerSuccess,
  getBreakerSnapshot,
  getBreakerState,
  CircuitOpenError,
  INTEGRATION_UPSTREAMS,
  _resetBreakersForTesting,
} from '../src/circuitBreaker.js'

describe('circuitBreaker', () => {
  beforeEach(() => {
    _resetBreakersForTesting({ failureThreshold: 3, windowMs: 60_000, cooldownMs: 60_000 })
  })

  test('starts closed for every named upstream in INTEGRATION_UPSTREAMS', () => {
    const snap = getBreakerSnapshot()
    for (const u of INTEGRATION_UPSTREAMS) {
      expect(snap[u]?.state).toBe('closed')
    }
    expect(Object.keys(snap).length).toBe(INTEGRATION_UPSTREAMS.length)
  })

  test('opens after `failureThreshold` failures within the window', () => {
    _resetBreakersForTesting({ failureThreshold: 2, windowMs: 60_000, cooldownMs: 60_000 })
    expect(getBreakerState('drive')).toBe('closed')
    recordBreakerFailure('drive', new Error('x'))
    expect(getBreakerState('drive')).toBe('closed')
    recordBreakerFailure('drive', new Error('y'))
    expect(getBreakerState('drive')).toBe('open')
  })

  test('open breaker rejects withBreaker calls with CircuitOpenError', async () => {
    _resetBreakersForTesting({ failureThreshold: 1, windowMs: 60_000, cooldownMs: 60_000 })
    recordBreakerFailure('drive', new Error('upstream gone'))
    let thrown: unknown = null
    try {
      await withBreaker('drive', async () => 'never')
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(CircuitOpenError)
    expect((thrown as CircuitOpenError).upstream).toBe('drive')
  })

  test('cooldown elapse admits a probe; success closes the breaker', async () => {
    // cooldownMs 20 — long enough to be observable as 'open' immediately
    // after the failure, short enough to elapse before the sleep below.
    _resetBreakersForTesting({ failureThreshold: 1, windowMs: 60_000, cooldownMs: 20 })
    recordBreakerFailure('drive', new Error('boom'))
    expect(getBreakerState('drive')).toBe('open')
    await new Promise((r) => setTimeout(r, 40))
    // After cooldown the next withBreaker call is the probe.
    const result = await withBreaker('drive', async () => 'recovered')
    expect(result).toBe('recovered')
    expect(getBreakerState('drive')).toBe('closed')
  })

  test('probe failure on half-open re-opens the breaker', async () => {
    _resetBreakersForTesting({ failureThreshold: 1, windowMs: 60_000, cooldownMs: 20 })
    recordBreakerFailure('drive', new Error('boom'))
    await new Promise((r) => setTimeout(r, 40))
    let probeError: unknown = null
    try {
      await withBreaker('drive', async () => {
        throw new Error('probe failed')
      })
    } catch (e) {
      probeError = e
    }
    expect((probeError as Error).message).toBe('probe failed')
    // Re-opened with a fresh openedAt; the 20ms cooldown has not yet elapsed
    // so getBreakerState reports 'open' rather than auto-flipping back to half-open.
    expect(getBreakerState('drive')).toBe('open')
  })

  test('recordBreakerSuccess clears accumulated window failures', () => {
    _resetBreakersForTesting({ failureThreshold: 3, windowMs: 60_000, cooldownMs: 60_000 })
    recordBreakerFailure('anthropic', new Error('a'))
    recordBreakerFailure('anthropic', new Error('b'))
    expect(getBreakerSnapshot().anthropic!.failuresInWindow).toBe(2)
    recordBreakerSuccess('anthropic')
    expect(getBreakerSnapshot().anthropic!.failuresInWindow).toBe(0)
    expect(getBreakerState('anthropic')).toBe('closed')
  })

  test('withUpstream composes retry+breaker — exhausted retries count as a single breaker failure', async () => {
    _resetBreakersForTesting({ failureThreshold: 2, windowMs: 60_000, cooldownMs: 60_000 })
    let attempts = 0
    let thrown: unknown = null
    try {
      await withUpstream(
        'paperclip',
        async () => {
          attempts++
          throw { status: 503 }
        },
        { attempts: 3, initialDelayMs: 1, maxDelayMs: 5 },
      )
    } catch (e) {
      thrown = e
    }
    expect(attempts).toBe(3)
    expect(thrown).toBeTruthy()
    // One full retry budget exhausted = 1 breaker failure (not 3).
    expect(getBreakerSnapshot().paperclip!.failuresInWindow).toBe(1)
  })
})
