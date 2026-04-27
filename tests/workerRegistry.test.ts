import { describe, test, expect, beforeEach } from 'bun:test'
import {
  registerWorker,
  unregisterWorker,
  recordHeartbeat,
  getWorker,
  listWorkers,
  activeWorkerCount,
  sweepOrphans,
  reconcileOnBoot,
  _resetForTesting,
} from '../src/workerRegistry.js'

describe('workerRegistry — registration and heartbeat', () => {
  beforeEach(() => {
    _resetForTesting({ hungThresholdMs: 200 })
  })

  test('registerWorker adds a record discoverable by getWorker; activeWorkerCount counts running only', () => {
    registerWorker({
      threadId: 't-1',
      pid: 100,
      projectId: 'p-x',
      entity: 'cbs',
      startedAt: Date.now(),
    })
    const rec = getWorker('t-1')
    expect(rec).toBeTruthy()
    expect(rec!.status).toBe('running')
    expect(rec!.pid).toBe(100)
    expect(rec!.entity).toBe('cbs')
    expect(activeWorkerCount()).toBe(1)
    expect(listWorkers()).toHaveLength(1)
  })

  test('unregisterWorker removes the record from the active map', () => {
    registerWorker({
      threadId: 't-2',
      pid: 101,
      projectId: null,
      entity: 'wr',
      startedAt: Date.now(),
    })
    unregisterWorker('t-2', 'completed')
    expect(getWorker('t-2')).toBeUndefined()
    expect(activeWorkerCount()).toBe(0)
  })

  test('recordHeartbeat updates lastHeartbeatAt only for running workers', async () => {
    const now = Date.now()
    registerWorker({
      threadId: 't-3',
      pid: 102,
      projectId: null,
      entity: 'cbs',
      startedAt: now,
    })
    const before = getWorker('t-3')!.lastHeartbeatAt
    await new Promise((r) => setTimeout(r, 5))
    recordHeartbeat('t-3')
    const after = getWorker('t-3')!.lastHeartbeatAt
    expect(after).toBeGreaterThan(before)
  })

  test('recordHeartbeat on an unknown threadId is a no-op (does not throw)', () => {
    expect(() => recordHeartbeat('does-not-exist')).not.toThrow()
  })
})

describe('workerRegistry — sweepOrphans', () => {
  beforeEach(() => {
    _resetForTesting({ hungThresholdMs: 100 })
  })

  test('flips a stale running worker to orphaned and surfaces the count', async () => {
    registerWorker({
      threadId: 't-stale',
      pid: 200,
      projectId: null,
      entity: 'cbs',
      startedAt: Date.now() - 1_000,
    })
    // Heartbeat is stamped on register; force it stale.
    const rec = getWorker('t-stale')!
    rec.lastHeartbeatAt = Date.now() - 500
    const orphaned = sweepOrphans()
    expect(orphaned).toBe(1)
    expect(getWorker('t-stale')!.status).toBe('orphaned')
    // activeWorkerCount drops because orphans aren't running.
    expect(activeWorkerCount()).toBe(0)
  })

  test('does not re-orphan an already-orphaned worker on a subsequent sweep', () => {
    registerWorker({
      threadId: 't-stale-2',
      pid: 201,
      projectId: null,
      entity: 'cbs',
      startedAt: Date.now() - 1_000,
    })
    getWorker('t-stale-2')!.lastHeartbeatAt = Date.now() - 500
    expect(sweepOrphans()).toBe(1)
    expect(sweepOrphans()).toBe(0)
  })
})

describe('workerRegistry — reconcileOnBoot', () => {
  beforeEach(() => {
    _resetForTesting()
  })

  test('returns 0 when no busy threads were carried over', () => {
    expect(reconcileOnBoot([])).toBe(0)
  })

  test('returns the count of previously-busy threads', () => {
    expect(reconcileOnBoot(['t-a', 't-b'])).toBe(2)
  })
})
