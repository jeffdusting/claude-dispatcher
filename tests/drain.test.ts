import { describe, test, expect, beforeEach } from 'bun:test'
import {
  isDraining,
  markDraining,
  awaitWorkersDrained,
  _resetDrainForTesting,
} from '../src/drain.js'
import {
  registerWorker,
  unregisterWorker,
  activeWorkerCount,
  _resetForTesting as _resetRegistry,
} from '../src/workerRegistry.js'

describe('drain', () => {
  beforeEach(() => {
    _resetDrainForTesting()
    _resetRegistry()
  })

  test('starts not-draining; markDraining is idempotent', () => {
    expect(isDraining()).toBe(false)
    markDraining()
    expect(isDraining()).toBe(true)
    markDraining()
    expect(isDraining()).toBe(true)
  })

  test('awaitWorkersDrained resolves cleanly when registry is empty', async () => {
    const result = await awaitWorkersDrained({ timeoutMs: 200, pollMs: 20 })
    expect(result.drainedCleanly).toBe(true)
    expect(result.killedCount).toBe(0)
    expect(result.waitedMs).toBeLessThan(200)
  })

  test('awaitWorkersDrained resolves cleanly once active workers all exit', async () => {
    registerWorker({
      threadId: 't-exit',
      pid: 1234,
      projectId: null,
      entity: 'cbs',
      startedAt: Date.now(),
    })
    expect(activeWorkerCount()).toBe(1)
    // Schedule the unregister to happen while the drain is polling.
    setTimeout(() => unregisterWorker('t-exit', 'completed'), 30)
    const result = await awaitWorkersDrained({ timeoutMs: 500, pollMs: 10 })
    expect(result.drainedCleanly).toBe(true)
    expect(result.killedCount).toBe(0)
  })

  test('awaitWorkersDrained times out and reports survivors as killed', async () => {
    registerWorker({
      threadId: 't-stuck',
      pid: 999_999_999, // non-existent — process.kill returns ESRCH
      projectId: null,
      entity: 'cbs',
      startedAt: Date.now(),
    })
    const result = await awaitWorkersDrained({ timeoutMs: 50, pollMs: 10 })
    expect(result.drainedCleanly).toBe(false)
    expect(result.killedCount).toBe(1)
    expect(activeWorkerCount()).toBe(0)
  })
})
