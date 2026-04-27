/**
 * Phase A.9.6 (per-worker memory observation, Δ D-014) smoke test.
 *
 * Asserts the pure-function behaviour of the memory sweep:
 *  - Probe samples below the warn threshold leave the record intact.
 *  - Samples above warn but below kill emit a single warn (rate-limited
 *    per record) and update lastMemoryRssBytes.
 *  - Samples above the kill threshold call the probe's kill, unregister
 *    the worker with status 'killed', and remove it from the map.
 *  - Probe failures (sample returns 0 or throws) are tolerated.
 *
 * The probe is fully stubbed so no real `ps` invocation or signal occurs.
 * Phase A.10 will fold these (and the c1-c5 + c6-c9 sets) into `bun test`.
 */

import { strict as assert } from 'assert'
import { tmpdir } from 'os'
import { mkdtempSync } from 'fs'
import { join } from 'path'

// Route persistent state into a fresh tmpdir so the smoke test never touches
// real dispatcher state. Set BEFORE importing the modules under test.
const tmp = mkdtempSync(join(tmpdir(), 'a9-c6-memory-'))
process.env.STATE_DIR = tmp
process.env.LOG_DIR = tmp
process.env.OUTBOX_DIR = tmp

// Tighten thresholds so a 1 GB / 1.5 GB choice does not have to be
// expressed in the assertions — the smoke test pretends the warn line
// is at 100 bytes and the kill line is at 200 bytes.
process.env.WORKER_MEMORY_WARN_BYTES = '100'
process.env.WORKER_MEMORY_KILL_BYTES = '200'

const registry = await import('../src/workerRegistry.js')

let pass = 0
let fail = 0
function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  const start = Date.now()
  return Promise.resolve()
    .then(fn)
    .then(() => {
      pass++
      process.stdout.write(`✓ ${name} (${Date.now() - start}ms)\n`)
    })
    .catch((err) => {
      fail++
      process.stdout.write(`✗ ${name} — ${String(err).slice(0, 200)}\n`)
    })
}

interface StubProbe {
  rssByPid: Map<number, number | Error>
  killed: number[]
  sampled: number[]
}

function makeStubProbe(): StubProbe & registry.MemoryProbe {
  const stub: StubProbe = {
    rssByPid: new Map(),
    killed: [],
    sampled: [],
  }
  return {
    ...stub,
    async sampleRss(pid: number): Promise<number> {
      stub.sampled.push(pid)
      const v = stub.rssByPid.get(pid)
      if (v instanceof Error) throw v
      return v ?? 0
    },
    kill(pid: number): void {
      stub.killed.push(pid)
    },
  }
}

// ── memory sweep ──────────────────────────────────────────────────

await check('memory: below warn threshold leaves record intact, no warn no kill', async () => {
  const probe = makeStubProbe()
  registry._resetForTesting({ memoryProbe: probe })
  registry.registerWorker({
    threadId: 't-low',
    pid: 1001,
    projectId: null,
    entity: 'cbs',
    startedAt: Date.now(),
  })
  probe.rssByPid.set(1001, 50) // below warn (100)
  const result = await registry.sweepMemory()
  assert.equal(result.warned, 0)
  assert.equal(result.killed, 0)
  assert.equal(result.sampled, 1)
  const rec = registry.getWorker('t-low')
  assert.ok(rec)
  assert.equal(rec!.lastMemoryRssBytes, 50)
  assert.equal(rec!.memoryWarnedAt, undefined)
  assert.equal(probe.killed.length, 0)
})

await check('memory: at warn threshold but below kill emits warn and updates record', async () => {
  const probe = makeStubProbe()
  registry._resetForTesting({ memoryProbe: probe })
  registry.registerWorker({
    threadId: 't-warn',
    pid: 1002,
    projectId: 'p-x',
    entity: 'cbs',
    startedAt: Date.now(),
  })
  probe.rssByPid.set(1002, 150) // between warn (100) and kill (200)
  const result = await registry.sweepMemory()
  assert.equal(result.warned, 1)
  assert.equal(result.killed, 0)
  assert.equal(result.sampled, 1)
  const rec = registry.getWorker('t-warn')
  assert.ok(rec)
  assert.equal(rec!.lastMemoryRssBytes, 150)
  assert.ok(rec!.memoryWarnedAt && rec!.memoryWarnedAt > 0)
  assert.equal(probe.killed.length, 0)
})

await check('memory: warn is rate-limited within the repeat window for the same record', async () => {
  const probe = makeStubProbe()
  registry._resetForTesting({ memoryProbe: probe })
  registry.registerWorker({
    threadId: 't-rerun',
    pid: 1003,
    projectId: null,
    entity: 'cbs',
    startedAt: Date.now(),
  })
  probe.rssByPid.set(1003, 150)
  const r1 = await registry.sweepMemory()
  const r2 = await registry.sweepMemory() // immediate re-sweep
  assert.equal(r1.warned, 1)
  assert.equal(r2.warned, 0)
  // sampled still increments — the sweep ran, the warn was suppressed.
  assert.equal(r2.sampled, 1)
})

await check('memory: rate-limit window expiry allows a second warn', async () => {
  const probe = makeStubProbe()
  registry._resetForTesting({ memoryProbe: probe })
  registry.registerWorker({
    threadId: 't-window',
    pid: 1004,
    projectId: null,
    entity: 'cbs',
    startedAt: Date.now(),
  })
  probe.rssByPid.set(1004, 150)
  const past = Date.now() - 10 * 60 * 1000 // 10 minutes ago
  await registry.sweepMemory(past)
  const r2 = await registry.sweepMemory() // now — well outside the 5-min window
  assert.equal(r2.warned, 1)
})

await check('memory: at or above kill threshold sends SIGTERM and unregisters with killed status', async () => {
  const probe = makeStubProbe()
  registry._resetForTesting({ memoryProbe: probe })
  registry.registerWorker({
    threadId: 't-kill',
    pid: 1005,
    projectId: 'p-y',
    entity: 'wr',
    startedAt: Date.now(),
  })
  probe.rssByPid.set(1005, 250) // above kill (200)
  const result = await registry.sweepMemory()
  assert.equal(result.killed, 1)
  assert.equal(result.warned, 0)
  assert.equal(result.sampled, 1)
  assert.deepEqual(probe.killed, [1005])
  // Record removed from active map after kill+unregister
  assert.equal(registry.getWorker('t-kill'), undefined)
  // activeWorkerCount reflects the removal
  assert.equal(registry.activeWorkerCount(), 0)
})

await check('memory: probe returning 0 (pid not found) is tolerated, no events', async () => {
  const probe = makeStubProbe()
  registry._resetForTesting({ memoryProbe: probe })
  registry.registerWorker({
    threadId: 't-gone',
    pid: 1006,
    projectId: null,
    entity: 'cbs',
    startedAt: Date.now(),
  })
  probe.rssByPid.set(1006, 0) // ps returned no rows
  const result = await registry.sweepMemory()
  assert.equal(result.sampled, 0)
  assert.equal(result.warned, 0)
  assert.equal(result.killed, 0)
  // Record retained — the next sweep retries.
  assert.ok(registry.getWorker('t-gone'))
})

await check('memory: probe throw is tolerated, sweep continues to other workers', async () => {
  const probe = makeStubProbe()
  registry._resetForTesting({ memoryProbe: probe })
  registry.registerWorker({
    threadId: 't-err',
    pid: 1007,
    projectId: null,
    entity: 'cbs',
    startedAt: Date.now(),
  })
  registry.registerWorker({
    threadId: 't-ok',
    pid: 1008,
    projectId: null,
    entity: 'cbs',
    startedAt: Date.now(),
  })
  probe.rssByPid.set(1007, new Error('boom'))
  probe.rssByPid.set(1008, 50)
  const result = await registry.sweepMemory()
  assert.equal(result.sampled, 1) // only t-ok sampled successfully
  assert.equal(result.warned, 0)
  assert.equal(result.killed, 0)
  // Both records still present — t-err survives a sample failure.
  assert.ok(registry.getWorker('t-err'))
  assert.ok(registry.getWorker('t-ok'))
})

await check('memory: non-running workers are skipped', async () => {
  const probe = makeStubProbe()
  registry._resetForTesting({ memoryProbe: probe })
  registry.registerWorker({
    threadId: 't-done',
    pid: 1009,
    projectId: null,
    entity: 'cbs',
    startedAt: Date.now(),
  })
  // unregisterWorker deletes the record entirely; the sweep can only
  // act on what is in the map. Verify that with no running workers the
  // sweep is a no-op.
  registry.unregisterWorker('t-done', 'completed')
  const result = await registry.sweepMemory()
  assert.equal(result.sampled, 0)
  assert.equal(probe.sampled.length, 0)
})

await check('memory: mixed warn + kill in one sweep produces correct counts', async () => {
  const probe = makeStubProbe()
  registry._resetForTesting({ memoryProbe: probe })
  registry.registerWorker({
    threadId: 't-warn2',
    pid: 2001,
    projectId: null,
    entity: 'cbs',
    startedAt: Date.now(),
  })
  registry.registerWorker({
    threadId: 't-kill2',
    pid: 2002,
    projectId: null,
    entity: 'cbs',
    startedAt: Date.now(),
  })
  registry.registerWorker({
    threadId: 't-low2',
    pid: 2003,
    projectId: null,
    entity: 'cbs',
    startedAt: Date.now(),
  })
  probe.rssByPid.set(2001, 150)
  probe.rssByPid.set(2002, 250)
  probe.rssByPid.set(2003, 50)
  const result = await registry.sweepMemory()
  assert.equal(result.warned, 1)
  assert.equal(result.killed, 1)
  assert.equal(result.sampled, 3)
  assert.deepEqual(probe.killed, [2002])
  assert.ok(registry.getWorker('t-warn2'))
  assert.equal(registry.getWorker('t-kill2'), undefined)
  assert.ok(registry.getWorker('t-low2'))
})

await check('memory: startMemorySweep schedules an interval; stopMemorySweep clears it', () => {
  const probe = makeStubProbe()
  registry._resetForTesting({ memoryProbe: probe })
  // Use a long interval so the timer never fires during the test.
  registry.startMemorySweep(60_000)
  registry.startMemorySweep(60_000) // idempotent
  registry.stopMemorySweep()
  registry.stopMemorySweep() // idempotent
  // No assertion target other than absence of error; the next test
  // would hang or throw if the timer leaked.
})

process.stdout.write(`\n${pass}/${pass + fail} A.9.6 memory smoke checks passed\n`)
if (fail > 0) process.exit(1)
