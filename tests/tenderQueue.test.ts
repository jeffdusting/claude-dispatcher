/**
 * Phase H §12.3 — tender queue drop/drain behavioural tests.
 *
 * Mirrors the kickoffInbox tests; the schema is a strict superset so
 * we add coverage for the entity / recommendedAgent / signals fields
 * the tender request adds beyond the base kickoff request.
 */

import { describe, test, expect, beforeEach } from 'bun:test'
import { readdirSync, writeFileSync, existsSync, unlinkSync } from 'fs'
import { join } from 'path'
import {
  dropTenderRequest,
  drainTenderRequests,
  hasPendingTender,
  TENDER_QUEUE_DIR,
  TENDER_REJECTED_DIR,
} from '../src/tenderQueue.js'

function purgeQueue(): void {
  for (const dir of [TENDER_QUEUE_DIR, TENDER_REJECTED_DIR]) {
    try {
      for (const name of readdirSync(dir)) {
        try { unlinkSync(join(dir, name)) } catch {}
      }
    } catch {}
  }
}

describe('tenderQueue — drop / drain cycle (Phase H §12.3)', () => {
  beforeEach(() => {
    purgeQueue()
  })

  test('dropTenderRequest writes a parseable file; hasPendingTender sees it', () => {
    dropTenderRequest({
      projectId: 'p-deadbeef',
      originThreadId: 't-origin',
      projectThreadId: 't-project',
      kickoffPrompt: 'tender prompt',
      createdAt: '2026-04-29T10:00:00Z',
      entity: 'wr',
      recommendedAgent: 'tender-review',
      signals: ['channel-name', 'keyword:rft'],
    })
    expect(hasPendingTender('p-deadbeef')).toBe(true)
  })

  test('drainTenderRequests returns valid requests and removes the files', () => {
    dropTenderRequest({
      projectId: 'p-aaaaaaaa',
      originThreadId: 't-1',
      projectThreadId: 't-2',
      kickoffPrompt: 'first',
      createdAt: '2026-04-29T10:00:00Z',
      entity: 'cbs',
      recommendedAgent: 'office-management',
      signals: ['keyword:rfi'],
    })
    dropTenderRequest({
      projectId: 'p-bbbbbbbb',
      originThreadId: 't-3',
      projectThreadId: 't-4',
      kickoffPrompt: 'second',
      createdAt: '2026-04-29T10:01:00Z',
      entity: 'wr',
      recommendedAgent: 'tender-review',
      signals: ['channel-name'],
    })
    const drained = drainTenderRequests()
    expect(drained).toHaveLength(2)
    expect(drained.map((r) => r.projectId).sort()).toEqual([
      'p-aaaaaaaa',
      'p-bbbbbbbb',
    ])
    expect(hasPendingTender('p-aaaaaaaa')).toBe(false)
    expect(hasPendingTender('p-bbbbbbbb')).toBe(false)
  })

  test('drainTenderRequests preserves entity / recommendedAgent / signals fields', () => {
    dropTenderRequest({
      projectId: 'p-cccccccc',
      originThreadId: 't-5',
      projectThreadId: 't-6',
      kickoffPrompt: 'tender prompt',
      createdAt: '2026-04-29T10:02:00Z',
      entity: 'wr',
      recommendedAgent: 'tender-review',
      signals: ['channel-name', 'keyword:eoi', 'weak:closing-date'],
    })
    const [drained] = drainTenderRequests()
    expect(drained.entity).toBe('wr')
    expect(drained.recommendedAgent).toBe('tender-review')
    expect(drained.signals).toEqual(['channel-name', 'keyword:eoi', 'weak:closing-date'])
  })

  test('drainTenderRequests quarantines malformed JSON to .rejected/', () => {
    const badPath = join(TENDER_QUEUE_DIR, 'p-bad11111.json')
    writeFileSync(badPath, '{invalid json', 'utf8')
    const drained = drainTenderRequests()
    expect(drained).toHaveLength(0)
    expect(existsSync(badPath)).toBe(false)
    const rejected = readdirSync(TENDER_REJECTED_DIR)
    expect(rejected.some((n) => n.endsWith('p-bad11111.json'))).toBe(true)
  })

  test('drainTenderRequests quarantines schema-violating files', () => {
    const badPath = join(TENDER_QUEUE_DIR, 'p-schema11.json')
    writeFileSync(
      badPath,
      JSON.stringify({
        projectId: 'p-schema11',
        // missing originThreadId, projectThreadId, entity, recommendedAgent, signals
        createdAt: '2026-04-29T10:00:00Z',
      }),
      'utf8',
    )
    const drained = drainTenderRequests()
    expect(drained).toHaveLength(0)
    expect(existsSync(badPath)).toBe(false)
    const rejected = readdirSync(TENDER_REJECTED_DIR)
    expect(rejected.some((n) => n.endsWith('p-schema11.json'))).toBe(true)
  })

  test('drainTenderRequests rejects an unknown recommendedAgent value', () => {
    const badPath = join(TENDER_QUEUE_DIR, 'p-agent01.json')
    writeFileSync(
      badPath,
      JSON.stringify({
        projectId: 'p-agent01',
        originThreadId: 't-1',
        projectThreadId: 't-2',
        kickoffPrompt: 'x',
        createdAt: '2026-04-29T10:00:00Z',
        entity: 'cbs',
        recommendedAgent: 'unknown-agent',
        signals: [],
      }),
      'utf8',
    )
    const drained = drainTenderRequests()
    expect(drained).toHaveLength(0)
    expect(existsSync(badPath)).toBe(false)
    const rejected = readdirSync(TENDER_REJECTED_DIR)
    expect(rejected.some((n) => n.endsWith('p-agent01.json'))).toBe(true)
  })

  test('dropTenderRequest rejects an invalid projectId at source', () => {
    expect(() =>
      dropTenderRequest({
        projectId: 'not-a-valid-id',
        originThreadId: 't-1',
        projectThreadId: 't-2',
        kickoffPrompt: 'x',
        createdAt: '2026-04-29T10:00:00Z',
        entity: 'cbs',
        recommendedAgent: 'office-management',
        signals: [],
      } as unknown as Parameters<typeof dropTenderRequest>[0]),
    ).toThrow()
  })
})
