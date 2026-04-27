import { describe, test, expect, beforeEach } from 'bun:test'
import { readdirSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import {
  dropKickoffRequest,
  drainKickoffRequests,
  hasPendingKickoff,
  KICKOFF_INBOX_DIR,
  KICKOFF_REJECTED_DIR,
} from '../src/kickoffInbox.js'

function purgeInbox(): void {
  for (const dir of [KICKOFF_INBOX_DIR, KICKOFF_REJECTED_DIR]) {
    try {
      for (const name of readdirSync(dir)) {
        try { require('fs').unlinkSync(join(dir, name)) } catch {}
      }
    } catch {}
  }
}

describe('kickoffInbox — drop / drain cycle (Phase A.6.2, Δ D-013)', () => {
  beforeEach(() => {
    purgeInbox()
  })

  test('dropKickoffRequest writes a parseable file; hasPendingKickoff sees it', () => {
    dropKickoffRequest({
      projectId: 'p-deadbeef',
      originThreadId: 't-origin',
      projectThreadId: 't-project',
      kickoffPrompt: 'do the thing',
      createdAt: '2026-04-27T10:00:00Z',
    })
    expect(hasPendingKickoff('p-deadbeef')).toBe(true)
  })

  test('drainKickoffRequests returns valid requests and removes the files', () => {
    dropKickoffRequest({
      projectId: 'p-aaaaaaaa',
      originThreadId: 't-1',
      projectThreadId: 't-2',
      kickoffPrompt: 'first',
      createdAt: '2026-04-27T10:00:00Z',
    })
    dropKickoffRequest({
      projectId: 'p-bbbbbbbb',
      originThreadId: 't-3',
      projectThreadId: 't-4',
      kickoffPrompt: 'second',
      createdAt: '2026-04-27T10:01:00Z',
    })
    const drained = drainKickoffRequests()
    expect(drained).toHaveLength(2)
    expect(drained.map((r) => r.projectId).sort()).toEqual([
      'p-aaaaaaaa',
      'p-bbbbbbbb',
    ])
    expect(hasPendingKickoff('p-aaaaaaaa')).toBe(false)
    expect(hasPendingKickoff('p-bbbbbbbb')).toBe(false)
  })

  test('drainKickoffRequests quarantines malformed JSON to .rejected/', () => {
    const badPath = join(KICKOFF_INBOX_DIR, 'p-bad11111.json')
    writeFileSync(badPath, '{invalid json', 'utf8')
    const drained = drainKickoffRequests()
    expect(drained).toHaveLength(0)
    expect(existsSync(badPath)).toBe(false)
    const rejected = readdirSync(KICKOFF_REJECTED_DIR)
    expect(rejected.some((n) => n.endsWith('p-bad11111.json'))).toBe(true)
  })

  test('drainKickoffRequests quarantines schema-violating files', () => {
    const badPath = join(KICKOFF_INBOX_DIR, 'p-schema11.json')
    writeFileSync(
      badPath,
      JSON.stringify({
        projectId: 'p-schema11',
        // missing originThreadId, projectThreadId, kickoffPrompt
        createdAt: '2026-04-27T10:00:00Z',
      }),
      'utf8',
    )
    const drained = drainKickoffRequests()
    expect(drained).toHaveLength(0)
    expect(existsSync(badPath)).toBe(false)
    const rejected = readdirSync(KICKOFF_REJECTED_DIR)
    expect(rejected.some((n) => n.endsWith('p-schema11.json'))).toBe(true)
  })

  test('dropKickoffRequest rejects an invalid projectId at source', () => {
    expect(() =>
      dropKickoffRequest({
        projectId: 'not-a-valid-id',
        originThreadId: 't-1',
        projectThreadId: 't-2',
        kickoffPrompt: 'x',
        createdAt: '2026-04-27T10:00:00Z',
      } as unknown as Parameters<typeof dropKickoffRequest>[0]),
    ).toThrow()
  })
})
