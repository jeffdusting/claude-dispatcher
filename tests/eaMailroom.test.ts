/**
 * Tests for EA mailroom queue (Migration Plan §14.2.3).
 *
 * Covers the envelope schema, drop / drain helpers, the per-pair queue
 * directory structure, malformed-envelope quarantine, pair queue depth, and
 * the discover-pairs helper.
 */

import { describe, test, expect, beforeEach, afterAll } from 'bun:test'
import { mkdtempSync, writeFileSync, existsSync, rmSync, readdirSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const tmp = mkdtempSync(join(tmpdir(), 'ea-mailroom-test-'))
process.env.FIRST_AGENT_CONFIG_PATH = join(tmp, 'first-agent-by-principal.json')

import {
  MailroomEnvelopeSchema,
  dropEnvelope,
  drainPairQueue,
  drainAllPairs,
  listPairQueues,
  pairQueueDir,
  pairQueueDepth,
  newEnvelopeId,
  type MailroomEnvelope,
} from '../src/eaMailroom.js'
import { EA_MAILROOM_DIR } from '../src/eaPartitions.js'

function makeEnvelope(overrides: Partial<MailroomEnvelope> = {}): MailroomEnvelope {
  return {
    envelopeId: overrides.envelopeId ?? newEnvelopeId(),
    fromPartition: 'jeff',
    toPartition: 'sarah',
    entity: 'cbs',
    correlationId: 'corr-001',
    body: 'hello',
    shareableWithPrincipal: false,
    createdAt: '2026-04-30T01:00:00Z',
    ...overrides,
  }
}

function purgeMailroom(): void {
  try {
    rmSync(EA_MAILROOM_DIR, { recursive: true, force: true })
  } catch {}
}

describe('MailroomEnvelopeSchema', () => {
  test('accepts a well-formed envelope', () => {
    const env = makeEnvelope()
    const result = MailroomEnvelopeSchema.safeParse(env)
    expect(result.success).toBe(true)
  })

  test('rejects envelopes with same from and to partition', () => {
    const env = makeEnvelope({ fromPartition: 'jeff', toPartition: 'jeff' })
    const result = MailroomEnvelopeSchema.safeParse(env)
    expect(result.success).toBe(false)
  })

  test('rejects bad envelopeId format', () => {
    const env = makeEnvelope({ envelopeId: 'BAD-ID' })
    expect(MailroomEnvelopeSchema.safeParse(env).success).toBe(false)
  })

  test('rejects unknown entity values', () => {
    const env = makeEnvelope({ entity: 'platform' as unknown as 'cbs' })
    expect(MailroomEnvelopeSchema.safeParse(env).success).toBe(false)
  })

  test('rejects empty body', () => {
    const env = makeEnvelope({ body: '' })
    expect(MailroomEnvelopeSchema.safeParse(env).success).toBe(false)
  })

  test('requires shareableWithPrincipal as boolean (no default)', () => {
    const partial = { ...makeEnvelope() } as Partial<MailroomEnvelope>
    delete partial.shareableWithPrincipal
    expect(MailroomEnvelopeSchema.safeParse(partial).success).toBe(false)
  })

  test('rejects bad partition names with uppercase or punctuation', () => {
    expect(MailroomEnvelopeSchema.safeParse(makeEnvelope({ fromPartition: 'Jeff' })).success).toBe(false)
    expect(MailroomEnvelopeSchema.safeParse(makeEnvelope({ toPartition: 'sarah_main' })).success).toBe(false)
  })
})

describe('newEnvelopeId', () => {
  test('returns env-prefixed lowercase alphanum ID', () => {
    const id = newEnvelopeId()
    expect(id).toMatch(/^env-[a-z0-9]+$/)
  })

  test('two consecutive IDs differ', () => {
    expect(newEnvelopeId()).not.toBe(newEnvelopeId())
  })
})

describe('pairQueueDir', () => {
  test('builds <from>-to-<to> path under EA_MAILROOM_DIR', () => {
    expect(pairQueueDir('jeff', 'sarah')).toBe(join(EA_MAILROOM_DIR, 'jeff-to-sarah'))
  })

  test('rejects self-addressed pairs', () => {
    expect(() => pairQueueDir('jeff', 'jeff')).toThrow()
  })

  test('rejects invalid partition names', () => {
    expect(() => pairQueueDir('Jeff', 'sarah')).toThrow()
  })
})

describe('dropEnvelope and drainPairQueue', () => {
  beforeEach(() => {
    purgeMailroom()
  })

  test('dropEnvelope writes a parseable file under the pair queue', () => {
    const env = makeEnvelope()
    dropEnvelope(env)
    const dir = pairQueueDir(env.fromPartition, env.toPartition)
    const files = readdirSync(dir)
    expect(files).toContain(`${env.envelopeId}.json`)
  })

  test('drainPairQueue returns the dropped envelope and removes the file', () => {
    const env = makeEnvelope({ body: 'first' })
    dropEnvelope(env)
    const drained = drainPairQueue(env.fromPartition, env.toPartition)
    expect(drained).toHaveLength(1)
    expect(drained[0].body).toBe('first')
    expect(drainPairQueue(env.fromPartition, env.toPartition)).toHaveLength(0)
  })

  test('drainPairQueue returns multiple envelopes in arbitrary order; both removed', () => {
    dropEnvelope(makeEnvelope({ envelopeId: 'env-aaa1', body: 'a' }))
    dropEnvelope(makeEnvelope({ envelopeId: 'env-bbb2', body: 'b' }))
    const drained = drainPairQueue('jeff', 'sarah')
    expect(drained).toHaveLength(2)
    expect(drained.map((e) => e.body).sort()).toEqual(['a', 'b'])
  })

  test('drainPairQueue on an empty queue returns []', () => {
    expect(drainPairQueue('jeff', 'sarah')).toEqual([])
  })

  test('drainPairQueue quarantines malformed JSON', () => {
    const dir = pairQueueDir('jeff', 'sarah')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'env-broken.json'), 'not json {{{')
    const drained = drainPairQueue('jeff', 'sarah')
    expect(drained).toHaveLength(0)
    const rejectedDir = join(dir, '.rejected')
    expect(existsSync(rejectedDir)).toBe(true)
    const rejected = readdirSync(rejectedDir)
    expect(rejected).toHaveLength(1)
    expect(rejected[0]).toContain('env-broken.json')
  })

  test('drainPairQueue quarantines schema-invalid envelopes', () => {
    const dir = pairQueueDir('jeff', 'sarah')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'env-bad.json'), JSON.stringify({ envelopeId: 'BAD' }))
    const drained = drainPairQueue('jeff', 'sarah')
    expect(drained).toHaveLength(0)
    const rejectedDir = join(dir, '.rejected')
    expect(readdirSync(rejectedDir)).toHaveLength(1)
  })

  test('drainPairQueue ignores non-json files and dotfiles', () => {
    const dir = pairQueueDir('jeff', 'sarah')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'README.txt'), 'docs')
    writeFileSync(join(dir, '.lock'), '1')
    dropEnvelope(makeEnvelope({ body: 'real' }))
    const drained = drainPairQueue('jeff', 'sarah')
    expect(drained).toHaveLength(1)
    expect(drained[0].body).toBe('real')
  })
})

describe('listPairQueues and drainAllPairs', () => {
  beforeEach(() => {
    purgeMailroom()
  })

  test('listPairQueues returns each present pair', () => {
    dropEnvelope(makeEnvelope({ fromPartition: 'jeff', toPartition: 'sarah' }))
    dropEnvelope(makeEnvelope({ fromPartition: 'sarah', toPartition: 'jeff' }))
    const pairs = listPairQueues()
    expect(pairs.map((p) => `${p.from}-${p.to}`).sort()).toEqual(['jeff-sarah', 'sarah-jeff'])
  })

  test('listPairQueues ignores entries that do not match <from>-to-<to>', () => {
    mkdirSync(join(EA_MAILROOM_DIR, 'not-a-pair'), { recursive: true })
    dropEnvelope(makeEnvelope())
    const pairs = listPairQueues()
    expect(pairs).toHaveLength(1)
    expect(pairs[0]).toEqual({ from: 'jeff', to: 'sarah' })
  })

  test('drainAllPairs returns one entry per non-empty pair', () => {
    dropEnvelope(makeEnvelope({ fromPartition: 'jeff', toPartition: 'sarah', body: 'a' }))
    dropEnvelope(makeEnvelope({ fromPartition: 'sarah', toPartition: 'jeff', body: 'b' }))
    const drained = drainAllPairs()
    expect(drained).toHaveLength(2)
    const byPair = Object.fromEntries(drained.map((d) => [`${d.from}-${d.to}`, d.envelopes]))
    expect(byPair['jeff-sarah'][0].body).toBe('a')
    expect(byPair['sarah-jeff'][0].body).toBe('b')
  })

  test('drainAllPairs skips empty queues', () => {
    mkdirSync(pairQueueDir('jeff', 'sarah'), { recursive: true })
    expect(drainAllPairs()).toEqual([])
  })
})

describe('pairQueueDepth', () => {
  beforeEach(() => {
    purgeMailroom()
  })

  test('returns 0 for missing queue', () => {
    expect(pairQueueDepth('jeff', 'sarah')).toBe(0)
  })

  test('counts pending envelopes', () => {
    dropEnvelope(makeEnvelope({ envelopeId: 'env-a' }))
    dropEnvelope(makeEnvelope({ envelopeId: 'env-b' }))
    expect(pairQueueDepth('jeff', 'sarah')).toBe(2)
  })

  test('does not count rejected envelopes', () => {
    const dir = pairQueueDir('jeff', 'sarah')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'env-bad.json'), 'not json')
    drainPairQueue('jeff', 'sarah')
    expect(pairQueueDepth('jeff', 'sarah')).toBe(0)
  })
})

afterAll(() => {
  try { rmSync(tmp, { recursive: true, force: true }) } catch {}
  try { rmSync(EA_MAILROOM_DIR, { recursive: true, force: true }) } catch {}
})
