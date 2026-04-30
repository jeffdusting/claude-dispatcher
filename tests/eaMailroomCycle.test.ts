/**
 * Tests for the EA mailroom drain cycle and backpressure alarms (Migration
 * Plan §14.2.3 continuation).
 *
 * Covers: delivery to destination mailbox, audit-log append, depth alarm
 * with cooldown, age alarm with persistent dedup, draining-mode skip, and
 * GC of stale dedup entries.
 */

import {
  describe,
  test,
  expect,
  beforeEach,
  beforeAll,
  afterAll,
} from 'bun:test'
import {
  mkdtempSync,
  writeFileSync,
  existsSync,
  rmSync,
  readdirSync,
  readFileSync,
  mkdirSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// Mailroom thresholds are configured in tests/setup.ts (preload) so that
// eaMailroomCycle.ts captures them at module load. This file just sets the
// principal-mapping path under tmp.
const tmp = mkdtempSync(join(tmpdir(), 'ea-mailroom-cycle-test-'))
process.env.FIRST_AGENT_CONFIG_PATH = join(tmp, 'first-agent-by-principal.json')

import {
  dropEnvelope,
  newEnvelopeId,
  pairQueueDir,
  type MailroomEnvelope,
} from '../src/eaMailroom.js'
import { EA_MAILROOM_DIR, partitionMailboxDir } from '../src/eaPartitions.js'
import {
  deliverAllPending,
  findAgedEnvelopes,
  sweepBackpressureAlarms,
  runMailroomCycle,
  _alarmsFilePathForTesting,
  _auditFilePathForTesting,
  MAILROOM_DEPTH_ALARM_THRESHOLD,
  MAILROOM_AGE_ALARM_MS,
} from '../src/eaMailroomCycle.js'
import {
  postTier2Alert as _unusedImport,
  setDiscordPoster,
  _resetEscalatorForTesting,
} from '../src/escalator.js'
import { markDraining, _resetDrainForTesting } from '../src/drain.js'

void _unusedImport // keep import shape stable; used indirectly through the module under test

function makeEnvelope(overrides: Partial<MailroomEnvelope> = {}): MailroomEnvelope {
  return {
    envelopeId: overrides.envelopeId ?? newEnvelopeId(),
    fromPartition: 'jeff',
    toPartition: 'sarah',
    entity: 'cbs',
    correlationId: 'corr-test',
    body: 'hello',
    shareableWithPrincipal: false,
    createdAt: new Date().toISOString(),
    ...overrides,
  }
}

function purgeMailroomState(): void {
  try { rmSync(EA_MAILROOM_DIR, { recursive: true, force: true }) } catch {}
  try { rmSync(_alarmsFilePathForTesting(), { force: true }) } catch {}
  // Clear any partition mailbox dirs created by previous tests.
  for (const p of ['jeff', 'sarah', 'alex', 'quinn']) {
    try {
      const dir = partitionMailboxDir(p)
      rmSync(dir, { recursive: true, force: true })
    } catch {}
  }
}

beforeAll(() => {
  // Confirm threshold env was honoured at module load.
  expect(MAILROOM_DEPTH_ALARM_THRESHOLD).toBe(3)
  expect(MAILROOM_AGE_ALARM_MS).toBe(60_000)
})

afterAll(() => {
  try { rmSync(tmp, { recursive: true, force: true }) } catch {}
  purgeMailroomState()
})

describe('deliverAllPending', () => {
  beforeEach(() => {
    _resetDrainForTesting()
    _resetEscalatorForTesting()
    setDiscordPoster(async () => 'msg-test')
    purgeMailroomState()
  })

  test('drains every pair and writes envelopes into destination mailboxes', () => {
    dropEnvelope(makeEnvelope({ envelopeId: 'env-d1', fromPartition: 'jeff', toPartition: 'sarah', body: 'A' }))
    dropEnvelope(makeEnvelope({ envelopeId: 'env-d2', fromPartition: 'sarah', toPartition: 'jeff', body: 'B' }))

    const result = deliverAllPending()
    expect(result.delivered).toBe(2)
    expect(result.failures).toBe(0)
    expect(result.pairs).toBe(2)

    const sarahMailbox = readdirSync(partitionMailboxDir('sarah'))
    const jeffMailbox = readdirSync(partitionMailboxDir('jeff'))
    expect(sarahMailbox).toContain('env-d1.json')
    expect(jeffMailbox).toContain('env-d2.json')

    // The envelope file in the queue dir has been consumed.
    const sarahQueue = pairQueueDir('jeff', 'sarah')
    expect(existsSync(sarahQueue) ? readdirSync(sarahQueue).filter((n) => n.endsWith('.json')).length : 0).toBe(0)
  })

  test('appends a record to the cross-EA audit log per delivery', () => {
    dropEnvelope(makeEnvelope({ envelopeId: 'env-a1', body: 'audit-me', correlationId: 'corr-a1' }))
    deliverAllPending()
    const auditPath = _auditFilePathForTesting()
    expect(existsSync(auditPath)).toBe(true)
    const lines = readFileSync(auditPath, 'utf8').trim().split('\n').filter((l) => l.length > 0)
    expect(lines).toHaveLength(1)
    const rec = JSON.parse(lines[0]!)
    expect(rec.envelopeId).toBe('env-a1')
    expect(rec.fromPartition).toBe('jeff')
    expect(rec.toPartition).toBe('sarah')
    expect(rec.correlationId).toBe('corr-a1')
    expect(rec.bodyPreview).toBe('audit-me')
  })

  test('returns zero pairs when no queues exist', () => {
    const result = deliverAllPending()
    expect(result).toEqual({ delivered: 0, failures: 0, pairs: 0 })
  })
})

describe('findAgedEnvelopes', () => {
  beforeEach(() => {
    _resetDrainForTesting()
    _resetEscalatorForTesting()
    setDiscordPoster(async () => 'msg-test')
    purgeMailroomState()
  })

  test('returns envelopes whose createdAt is older than the threshold', () => {
    const old = new Date(Date.now() - 5 * 60 * 1000).toISOString() // 5 min old
    dropEnvelope(makeEnvelope({ envelopeId: 'env-old', createdAt: old }))
    dropEnvelope(makeEnvelope({ envelopeId: 'env-new', createdAt: new Date().toISOString() }))
    const findings = findAgedEnvelopes()
    const ids = findings.map((f) => f.envelopeId)
    expect(ids).toContain('env-old')
    expect(ids).not.toContain('env-new')
  })

  test('returns empty when no queues exist', () => {
    expect(findAgedEnvelopes()).toEqual([])
  })
})

describe('sweepBackpressureAlarms — depth alarm', () => {
  beforeEach(() => {
    _resetDrainForTesting()
    _resetEscalatorForTesting()
    setDiscordPoster(async () => 'msg-test')
    purgeMailroomState()
  })

  test('fires once when a pair queue crosses the depth threshold', async () => {
    // Threshold is 3 (env-overridden). Drop 4.
    for (let i = 0; i < 4; i++) {
      dropEnvelope(makeEnvelope({ envelopeId: `env-d${i}`, body: `m${i}` }))
    }
    const result = await sweepBackpressureAlarms()
    expect(result.depthAlarmsFired).toBe(1)
  })

  test('does not re-fire while the cooldown window is still active', async () => {
    for (let i = 0; i < 5; i++) {
      dropEnvelope(makeEnvelope({ envelopeId: `env-c${i}`, body: `m${i}` }))
    }
    const first = await sweepBackpressureAlarms()
    expect(first.depthAlarmsFired).toBe(1)
    const second = await sweepBackpressureAlarms()
    expect(second.depthAlarmsFired).toBe(0)
  })

  test('does not fire when depth is below threshold', async () => {
    for (let i = 0; i < 2; i++) {
      dropEnvelope(makeEnvelope({ envelopeId: `env-b${i}`, body: `m${i}` }))
    }
    const result = await sweepBackpressureAlarms()
    expect(result.depthAlarmsFired).toBe(0)
  })
})

describe('sweepBackpressureAlarms — age alarm', () => {
  beforeEach(() => {
    _resetDrainForTesting()
    _resetEscalatorForTesting()
    setDiscordPoster(async () => 'msg-test')
    purgeMailroomState()
  })

  test('fires once per aged envelope; does not re-fire on the next sweep', async () => {
    const old = new Date(Date.now() - 5 * 60 * 1000).toISOString() // 5 min old; threshold 60s
    dropEnvelope(makeEnvelope({ envelopeId: 'env-aged1', createdAt: old }))
    const first = await sweepBackpressureAlarms()
    expect(first.ageAlarmsFired).toBe(1)
    const second = await sweepBackpressureAlarms()
    expect(second.ageAlarmsFired).toBe(0)
  })

  test('does not fire for envelopes younger than the threshold', async () => {
    dropEnvelope(makeEnvelope({ envelopeId: 'env-fresh', createdAt: new Date().toISOString() }))
    const result = await sweepBackpressureAlarms()
    expect(result.ageAlarmsFired).toBe(0)
  })

  test('garbage-collects dedup entries for envelopes no longer on disk', async () => {
    const old = new Date(Date.now() - 5 * 60 * 1000).toISOString()
    dropEnvelope(makeEnvelope({ envelopeId: 'env-gc1', createdAt: old }))
    await sweepBackpressureAlarms()

    // Simulate delivery/removal of the aged envelope.
    deliverAllPending()

    // Drop a fresh envelope so the sweep still has work; the prior aged
    // envelope's dedup entry should be pruned.
    dropEnvelope(makeEnvelope({ envelopeId: 'env-gc2' }))
    await sweepBackpressureAlarms()

    const alarms = JSON.parse(readFileSync(_alarmsFilePathForTesting(), 'utf8'))
    expect(alarms.ageAlertedEnvelopes).not.toHaveProperty('env-gc1')
  })
})

describe('runMailroomCycle — drain integration', () => {
  beforeEach(() => {
    _resetDrainForTesting()
    _resetEscalatorForTesting()
    setDiscordPoster(async () => 'msg-test')
    purgeMailroomState()
  })

  test('skips delivery and alarms when the dispatcher is in drain mode', async () => {
    dropEnvelope(makeEnvelope({ envelopeId: 'env-drain1', body: 'do-not-deliver' }))
    markDraining()
    await runMailroomCycle()

    // Envelope is still on the queue; the destination mailbox is empty (or non-existent).
    const queueDir = pairQueueDir('jeff', 'sarah')
    const remaining = readdirSync(queueDir).filter((n) => n.endsWith('.json'))
    expect(remaining).toHaveLength(1)

    const mailboxDir = partitionMailboxDir('sarah')
    const inMailbox = existsSync(mailboxDir) ? readdirSync(mailboxDir) : []
    expect(inMailbox).not.toContain('env-drain1.json')
  })

  test('delivers in normal mode', async () => {
    dropEnvelope(makeEnvelope({ envelopeId: 'env-normal1', body: 'deliver' }))
    await runMailroomCycle()
    const inMailbox = readdirSync(partitionMailboxDir('sarah'))
    expect(inMailbox).toContain('env-normal1.json')
  })
})

describe('alarms-state file', () => {
  beforeEach(() => {
    _resetDrainForTesting()
    _resetEscalatorForTesting()
    setDiscordPoster(async () => 'msg-test')
    purgeMailroomState()
  })

  test('writes a JSON file with both depthLastAlertedAt and ageAlertedEnvelopes keys after a fire', async () => {
    const old = new Date(Date.now() - 5 * 60 * 1000).toISOString()
    for (let i = 0; i < 4; i++) {
      dropEnvelope(makeEnvelope({ envelopeId: `env-state${i}`, body: `m${i}`, createdAt: old }))
    }
    await sweepBackpressureAlarms()
    const path = _alarmsFilePathForTesting()
    expect(existsSync(path)).toBe(true)
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    expect(parsed).toHaveProperty('depthLastAlertedAt')
    expect(parsed).toHaveProperty('ageAlertedEnvelopes')
    expect(parsed.depthLastAlertedAt['jeff-to-sarah']).toBeGreaterThan(0)
    expect(Object.keys(parsed.ageAlertedEnvelopes).length).toBeGreaterThan(0)
  })

  test('survives a corrupt alarms file by treating it as empty', async () => {
    mkdirSync(join(_alarmsFilePathForTesting(), '..'), { recursive: true })
    writeFileSync(_alarmsFilePathForTesting(), 'not json')
    // Should not throw.
    await sweepBackpressureAlarms()
  })
})
