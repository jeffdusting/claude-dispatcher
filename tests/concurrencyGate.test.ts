import { describe, test, expect, beforeEach } from 'bun:test'
import {
  acquire,
  release,
  activeCount,
  queueDepth,
  maxConcurrentLimit,
  _resetForTesting,
} from '../src/concurrencyGate.js'
import { _resetDrainForTesting, markDraining } from '../src/drain.js'

describe('concurrencyGate', () => {
  beforeEach(() => {
    _resetForTesting({ max: 2 })
    _resetDrainForTesting()
  })

  test('configured limit is reported by maxConcurrentLimit()', () => {
    expect(maxConcurrentLimit()).toBe(2)
  })

  test('acquire grants up to limit immediately, beyond limit queues', async () => {
    const a = await acquire()
    const b = await acquire()
    expect(a.acquired).toBe(true)
    expect(b.acquired).toBe(true)
    expect(activeCount()).toBe(2)

    // Third request queues.
    const cPromise = acquire({ timeoutMs: 1_000 })
    await new Promise((r) => setTimeout(r, 10))
    expect(queueDepth()).toBe(1)

    // release frees a slot; the queued waiter resolves.
    release()
    const c = await cPromise
    expect(c.acquired).toBe(true)
    expect(c.waitedMs).toBeGreaterThanOrEqual(0)
    expect(activeCount()).toBe(2)
  })

  test('queue timeout returns acquired=false without holding a slot', async () => {
    await acquire()
    await acquire()
    expect(activeCount()).toBe(2)

    const result = await acquire({ timeoutMs: 30, reason: 'test' })
    expect(result.acquired).toBe(false)
    expect(activeCount()).toBe(2)
    expect(queueDepth()).toBe(0)
  })

  test('drain mode rejects new acquisitions immediately', async () => {
    markDraining()
    const result = await acquire({ timeoutMs: 1_000, reason: 'post-drain' })
    expect(result.acquired).toBe(false)
    expect(activeCount()).toBe(0)
  })
})
