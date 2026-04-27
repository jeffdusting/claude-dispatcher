import { describe, test, expect, beforeEach } from 'bun:test'
import {
  getIntegrationsHealth,
  refreshIntegrationsSnapshot,
  _resetIntegrationsForTesting,
} from '../src/integrationsHealth.js'
import {
  recordBreakerFailure,
  _resetBreakersForTesting,
  INTEGRATION_UPSTREAMS,
} from '../src/circuitBreaker.js'

describe('integrationsHealth', () => {
  beforeEach(() => {
    _resetBreakersForTesting()
    _resetIntegrationsForTesting()
  })

  test('aggregate=ok when every breaker is closed; reports all known upstreams', () => {
    const snap = refreshIntegrationsSnapshot()
    expect(snap.aggregate).toBe('ok')
    expect(snap.upstreams).toHaveLength(INTEGRATION_UPSTREAMS.length)
    for (const u of snap.upstreams) {
      expect(u.state).toBe('closed')
      expect(u.failuresInWindow).toBe(0)
    }
  })

  test('aggregate=down when any upstream is open', () => {
    _resetBreakersForTesting({ failureThreshold: 1, windowMs: 60_000, cooldownMs: 60_000 })
    _resetIntegrationsForTesting()
    recordBreakerFailure('drive', new Error('drive gone'))
    const snap = refreshIntegrationsSnapshot()
    expect(snap.aggregate).toBe('down')
    const drive = snap.upstreams.find((u) => u.upstream === 'drive')!
    expect(drive.state).toBe('open')
    expect(drive.lastErrorMessage).toContain('drive gone')
  })

  test('getIntegrationsHealth returns the cached snapshot — same object until refresh', () => {
    const a = refreshIntegrationsSnapshot()
    const b = getIntegrationsHealth()
    expect(b.generatedAt).toBe(a.generatedAt)
  })
})
