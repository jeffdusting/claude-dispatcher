/**
 * Phase H Deliverable 3 — channel-to-entity map and resolver wiring.
 *
 * Two surfaces under test:
 *   1. resolveEntityForChannel — direct lookup against the static map.
 *   2. resolveEntityForThread — fallback chain with the channel map slotted
 *      between the project lookup (step 2) and DEFAULT_ENTITY (step 4).
 *
 * The kickoff path entity-tagging is exercised at the integration seam in
 * scripts/kickoff-project.ts; we test the map and resolver directly here.
 */

import { describe, test, expect } from 'bun:test'
import {
  CHANNEL_ENTITY_MAP,
  resolveEntityForChannel,
} from '../src/channelEntityMap.js'
import { resolveEntityForThread } from '../src/entityResolver.js'
import { rememberThread } from '../src/threadSessions.js'
import { createProject } from '../src/projects.js'

const WATERROADS = '1495962797329219584'
const WREI = '1497129990192627802'
const SJT_PA = '1495962505879486584'
const BRIDGE_REPAIR = '1497133030559715338'
const PROJECT_LEO = '1495962402934751382'
const JAD_PA = '1495962464616059051'
const RIVERAGENTS = '1495629402908921876'
const GENERAL = '1495618035174735894'

describe('Phase H Deliverable 3 — channel-entity map (CHANNEL_ENTITY_MAP)', () => {
  test('WaterRoads-side channels map to wr', () => {
    expect(CHANNEL_ENTITY_MAP[WATERROADS]).toBe('wr')
    expect(CHANNEL_ENTITY_MAP[WREI]).toBe('wr')
    expect(CHANNEL_ENTITY_MAP[SJT_PA]).toBe('wr')
  })

  test('CBS-side channels map to cbs', () => {
    expect(CHANNEL_ENTITY_MAP[BRIDGE_REPAIR]).toBe('cbs')
    expect(CHANNEL_ENTITY_MAP[PROJECT_LEO]).toBe('cbs')
  })

  test('cross-entity and platform channels are absent (deliberately)', () => {
    expect(CHANNEL_ENTITY_MAP[JAD_PA]).toBeUndefined()
    expect(CHANNEL_ENTITY_MAP[RIVERAGENTS]).toBeUndefined()
    expect(CHANNEL_ENTITY_MAP[GENERAL]).toBeUndefined()
  })

  test('map is frozen — runtime mutation is rejected', () => {
    expect(() => {
      // @ts-expect-error: intentional write to a Readonly Record
      CHANNEL_ENTITY_MAP['1234'] = 'cbs'
    }).toThrow()
  })
})

describe('Phase H Deliverable 3 — resolveEntityForChannel', () => {
  test('returns the mapped entity for known channels', () => {
    expect(resolveEntityForChannel(WATERROADS)).toBe('wr')
    expect(resolveEntityForChannel(BRIDGE_REPAIR)).toBe('cbs')
  })

  test('returns null for unmapped channels (cross-entity / platform)', () => {
    expect(resolveEntityForChannel(JAD_PA)).toBeNull()
    expect(resolveEntityForChannel(RIVERAGENTS)).toBeNull()
    expect(resolveEntityForChannel(GENERAL)).toBeNull()
  })

  test('returns null for null / undefined / empty input', () => {
    expect(resolveEntityForChannel(null)).toBeNull()
    expect(resolveEntityForChannel(undefined)).toBeNull()
    expect(resolveEntityForChannel('')).toBeNull()
  })

  test('returns null for a wholly unknown channel ID', () => {
    expect(resolveEntityForChannel('9999999999999999999')).toBeNull()
  })
})

describe('Phase H Deliverable 3 — resolveEntityForThread fallback chain', () => {
  test('project-bound thread: project entity wins over channel-map (step 2 short-circuits step 3)', () => {
    // Create a project tagged 'wr', then register a thread that points at it
    // but whose ID matches a CBS channel in the map. Project should win.
    const project = createProject({
      name: 'phase-h-test-project-wins',
      brief: 'irrelevant',
      originThreadId: 'origin-pwins',
      entity: 'wr',
    })
    rememberThread(BRIDGE_REPAIR, 'thread-bound-to-wr-project', {
      projectId: project.id,
    })
    expect(resolveEntityForThread(BRIDGE_REPAIR)).toBe('wr')
  })

  test('non-project thread in a wr-mapped channel: resolves wr (Phase H step 3)', () => {
    // Use a fresh threadId that is not registered as a project thread.
    expect(resolveEntityForThread(WATERROADS)).toBe('wr')
    expect(resolveEntityForThread(WREI)).toBe('wr')
    expect(resolveEntityForThread(SJT_PA)).toBe('wr')
  })

  test('non-project thread in a cbs-mapped channel: resolves cbs (Phase H step 3)', () => {
    // Note: BRIDGE_REPAIR is registered to a project above, so use PROJECT_LEO.
    expect(resolveEntityForThread(PROJECT_LEO)).toBe('cbs')
  })

  test('non-project thread in a cross-entity channel: falls through to default (cbs)', () => {
    expect(resolveEntityForThread(JAD_PA)).toBe('cbs')
    expect(resolveEntityForThread(RIVERAGENTS)).toBe('cbs')
  })

  test('non-project thread with no map entry: falls through to default (cbs)', () => {
    expect(resolveEntityForThread('thread-not-in-map-and-not-bound')).toBe('cbs')
  })

  test('project-bound thread whose project went missing: falls back to channel map', () => {
    // Register a thread bound to a project ID that does not exist on disk.
    rememberThread(WATERROADS, 'orphan-thread-wr-channel', {
      projectId: 'p-nonexistent',
    })
    // Project lookup misses; the channel map (wr) should still resolve.
    expect(resolveEntityForThread(WATERROADS)).toBe('wr')
  })
})
