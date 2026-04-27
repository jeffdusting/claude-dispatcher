import { describe, test, expect, beforeEach } from 'bun:test'
import {
  registerWorker,
  unregisterWorker,
  sweepMemory,
  getWorker,
  activeWorkerCount,
  startMemorySweep,
  stopMemorySweep,
  _resetForTesting,
} from '../src/workerRegistry.js'
import { makeFakeProbe } from './helpers/fakeProbe.js'

// Tighten thresholds at module load time so the per-test probe values
// (50 / 150 / 250) cleanly straddle warn=100 and kill=200. The env vars
// are read once by config.ts; setting them here only matters if config.ts
// has not already loaded — for the registry tests it has, so we rely on
// the smoke-test-baked default of WORKER_MEMORY_WARN_BYTES=100 only when
// running this file under the same env.
process.env.WORKER_MEMORY_WARN_BYTES = '100'
process.env.WORKER_MEMORY_KILL_BYTES = '200'

describe('workerRegistry — memory sweep (Δ D-014, A.9.6)', () => {
  beforeEach(() => {
    _resetForTesting({ memoryProbe: makeFakeProbe() })
  })

  test('below warn threshold leaves the record intact, no warn no kill', async () => {
    const probe = makeFakeProbe()
    _resetForTesting({ memoryProbe: probe })
    registerWorker({
      threadId: 't-low',
      pid: 1001,
      projectId: null,
      entity: 'cbs',
      startedAt: Date.now(),
    })
    probe.rssByPid.set(1001, 50)
    const result = await sweepMemory()
    expect(result.warned).toBe(0)
    expect(result.killed).toBe(0)
    expect(result.sampled).toBe(1)
    const rec = getWorker('t-low')!
    expect(rec.lastMemoryRssBytes).toBe(50)
    expect(rec.memoryWarnedAt).toBeUndefined()
    expect(probe.killed).toHaveLength(0)
  })

  test('between warn and kill emits a warn and updates the record', async () => {
    const probe = makeFakeProbe()
    _resetForTesting({ memoryProbe: probe })
    registerWorker({
      threadId: 't-warn',
      pid: 1002,
      projectId: 'p-x',
      entity: 'cbs',
      startedAt: Date.now(),
    })
    probe.rssByPid.set(1002, 150)
    const result = await sweepMemory()
    expect(result.warned).toBe(1)
    expect(result.killed).toBe(0)
    const rec = getWorker('t-warn')!
    expect(rec.lastMemoryRssBytes).toBe(150)
    expect(rec.memoryWarnedAt).toBeGreaterThan(0)
  })

  test('warns are rate-limited to once per 5 minutes per record', async () => {
    const probe = makeFakeProbe()
    _resetForTesting({ memoryProbe: probe })
    registerWorker({
      threadId: 't-rerun',
      pid: 1003,
      projectId: null,
      entity: 'cbs',
      startedAt: Date.now(),
    })
    probe.rssByPid.set(1003, 150)
    const r1 = await sweepMemory()
    const r2 = await sweepMemory()
    expect(r1.warned).toBe(1)
    expect(r2.warned).toBe(0)
    expect(r2.sampled).toBe(1)
  })

  test('rate-limit window expiry (>5 min) allows a fresh warn', async () => {
    const probe = makeFakeProbe()
    _resetForTesting({ memoryProbe: probe })
    registerWorker({
      threadId: 't-window',
      pid: 1004,
      projectId: null,
      entity: 'cbs',
      startedAt: Date.now(),
    })
    probe.rssByPid.set(1004, 150)
    const past = Date.now() - 10 * 60 * 1000
    await sweepMemory(past)
    const r2 = await sweepMemory()
    expect(r2.warned).toBe(1)
  })

  test('at or above kill threshold sends SIGTERM via probe and unregisters with status killed', async () => {
    const probe = makeFakeProbe()
    _resetForTesting({ memoryProbe: probe })
    registerWorker({
      threadId: 't-kill',
      pid: 1005,
      projectId: 'p-y',
      entity: 'wr',
      startedAt: Date.now(),
    })
    probe.rssByPid.set(1005, 250)
    const result = await sweepMemory()
    expect(result.killed).toBe(1)
    expect(probe.killed).toEqual([1005])
    expect(getWorker('t-kill')).toBeUndefined()
    expect(activeWorkerCount()).toBe(0)
  })

  test('probe returning 0 (pid not found) is tolerated, no events, record retained', async () => {
    const probe = makeFakeProbe()
    _resetForTesting({ memoryProbe: probe })
    registerWorker({
      threadId: 't-gone',
      pid: 1006,
      projectId: null,
      entity: 'cbs',
      startedAt: Date.now(),
    })
    probe.rssByPid.set(1006, 0)
    const result = await sweepMemory()
    expect(result.sampled).toBe(0)
    expect(result.warned).toBe(0)
    expect(result.killed).toBe(0)
    expect(getWorker('t-gone')).toBeTruthy()
  })

  test('probe throw is tolerated; sweep continues to the next worker', async () => {
    const probe = makeFakeProbe()
    _resetForTesting({ memoryProbe: probe })
    registerWorker({
      threadId: 't-err',
      pid: 1007,
      projectId: null,
      entity: 'cbs',
      startedAt: Date.now(),
    })
    registerWorker({
      threadId: 't-ok',
      pid: 1008,
      projectId: null,
      entity: 'cbs',
      startedAt: Date.now(),
    })
    probe.rssByPid.set(1007, new Error('boom'))
    probe.rssByPid.set(1008, 50)
    const result = await sweepMemory()
    expect(result.sampled).toBe(1)
    expect(getWorker('t-err')).toBeTruthy()
    expect(getWorker('t-ok')).toBeTruthy()
  })

  test('non-running workers are skipped (sweep is a no-op when registry is empty)', async () => {
    const probe = makeFakeProbe()
    _resetForTesting({ memoryProbe: probe })
    registerWorker({
      threadId: 't-done',
      pid: 1009,
      projectId: null,
      entity: 'cbs',
      startedAt: Date.now(),
    })
    unregisterWorker('t-done', 'completed')
    const result = await sweepMemory()
    expect(result.sampled).toBe(0)
    expect(probe.sampled).toHaveLength(0)
  })

  test('mixed warn + kill in one sweep produces correct counts', async () => {
    const probe = makeFakeProbe()
    _resetForTesting({ memoryProbe: probe })
    for (const [threadId, pid, rss] of [
      ['t-warn2', 2001, 150],
      ['t-kill2', 2002, 250],
      ['t-low2', 2003, 50],
    ] as const) {
      registerWorker({
        threadId,
        pid,
        projectId: null,
        entity: 'cbs',
        startedAt: Date.now(),
      })
      probe.rssByPid.set(pid, rss)
    }
    const result = await sweepMemory()
    expect(result.warned).toBe(1)
    expect(result.killed).toBe(1)
    expect(result.sampled).toBe(3)
    expect(probe.killed).toEqual([2002])
    expect(getWorker('t-warn2')).toBeTruthy()
    expect(getWorker('t-kill2')).toBeUndefined()
    expect(getWorker('t-low2')).toBeTruthy()
  })

  test('startMemorySweep / stopMemorySweep are idempotent and do not leak timers', () => {
    const probe = makeFakeProbe()
    _resetForTesting({ memoryProbe: probe })
    startMemorySweep(60_000)
    startMemorySweep(60_000)
    stopMemorySweep()
    stopMemorySweep()
  })
})
