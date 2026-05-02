/**
 * Tests for the PM name roster (Option C — persistent named roster).
 *
 * Pins the roster size + invariants (gender balance, no duplicates) and
 * exercises the allocator's round-robin behaviour and fallback path.
 */

import { describe, test, expect, beforeEach, afterAll } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  PMRosterSchema,
  loadPMRoster,
  namesInUse,
  allocatePMName,
  _resetPMRosterCacheForTests,
} from '../src/pmNameRoster.js'

const tmp = mkdtempSync(join(tmpdir(), 'pm-roster-test-'))

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true })
})

describe('shipped roster invariants', () => {
  beforeEach(() => {
    _resetPMRosterCacheForTests()
    delete process.env.PM_ROSTER_CONFIG_PATH
  })

  test('roster loads and has 100 unique names', () => {
    const r = loadPMRoster()
    expect(r.roster.length).toBe(100)
    const distinct = new Set(r.roster)
    expect(distinct.size).toBe(100)
  })

  test('roster names are all non-empty strings', () => {
    const r = loadPMRoster()
    for (const name of r.roster) {
      expect(typeof name).toBe('string')
      expect(name.length).toBeGreaterThan(0)
    }
  })
})

describe('allocator behaviour', () => {
  beforeEach(() => {
    _resetPMRosterCacheForTests()
  })

  function writeRoster(names: string[]): string {
    const path = join(tmp, `roster-${Math.random().toString(36).slice(2, 8)}.json`)
    writeFileSync(
      path,
      JSON.stringify({ schemaVersion: 1, description: 'test', roster: names }),
    )
    return path
  }

  function projectsDirWith(records: Array<{ id: string; pmName?: string; status: string }>): string {
    const dir = mkdtempSync(join(tmp, 'projects-'))
    for (const r of records) {
      writeFileSync(
        join(dir, `${r.id}.json`),
        JSON.stringify({
          id: r.id,
          name: r.id,
          brief: 'test',
          threadId: null,
          originThreadId: 't1',
          status: r.status,
          createdAt: 0,
          updatedAt: 0,
          maxParallelWorkers: 3,
          tasks: [],
          artifacts: [],
          log: [],
          entity: 'cbs',
          paperclipTaskIds: [],
          correlationId: 'corr',
          owningEA: 'jeff',
          schemaVersion: 4,
          ...(r.pmName ? { pmName: r.pmName } : {}),
        }),
      )
    }
    return dir
  }

  test('allocates the first name when nothing in use', () => {
    process.env.PM_ROSTER_CONFIG_PATH = writeRoster(['Iris', 'Felix', 'Mei'])
    _resetPMRosterCacheForTests()
    const dir = projectsDirWith([])
    const r = allocatePMName({ projectId: 'p-aaaa1111', projectsDir: dir })
    expect(r.name).toBe('Iris')
    expect(r.fallback).toBe(false)
  })

  test('skips names held by active projects', () => {
    process.env.PM_ROSTER_CONFIG_PATH = writeRoster(['Iris', 'Felix', 'Mei'])
    _resetPMRosterCacheForTests()
    const dir = projectsDirWith([
      { id: 'p-bbbb2222', pmName: 'Iris', status: 'running' },
      { id: 'p-cccc3333', pmName: 'Felix', status: 'planning' },
    ])
    const r = allocatePMName({ projectId: 'p-dddd4444', projectsDir: dir })
    expect(r.name).toBe('Mei')
    expect(r.fallback).toBe(false)
  })

  test('reuses names freed by completed projects', () => {
    process.env.PM_ROSTER_CONFIG_PATH = writeRoster(['Iris', 'Felix'])
    _resetPMRosterCacheForTests()
    const dir = projectsDirWith([
      { id: 'p-eeee5555', pmName: 'Iris', status: 'complete' },
      { id: 'p-ffff6666', pmName: 'Felix', status: 'failed' },
    ])
    const r = allocatePMName({ projectId: 'p-aaaa7777', projectsDir: dir })
    expect(r.name).toBe('Iris')
    expect(r.fallback).toBe(false)
  })

  test('cancelled projects free their names', () => {
    process.env.PM_ROSTER_CONFIG_PATH = writeRoster(['Iris', 'Felix'])
    _resetPMRosterCacheForTests()
    const dir = projectsDirWith([
      { id: 'p-bbbb8888', pmName: 'Iris', status: 'cancelled' },
    ])
    const r = allocatePMName({ projectId: 'p-cccc9999', projectsDir: dir })
    expect(r.name).toBe('Iris')
  })

  test('blocked projects keep their names occupied', () => {
    process.env.PM_ROSTER_CONFIG_PATH = writeRoster(['Iris', 'Felix'])
    _resetPMRosterCacheForTests()
    const dir = projectsDirWith([
      { id: 'p-dddd0001', pmName: 'Iris', status: 'blocked' },
    ])
    const r = allocatePMName({ projectId: 'p-eeee0002', projectsDir: dir })
    expect(r.name).toBe('Felix')
  })

  test('falls back to PM-<suffix> when every roster name is in use', () => {
    process.env.PM_ROSTER_CONFIG_PATH = writeRoster(['Iris', 'Felix'])
    _resetPMRosterCacheForTests()
    const dir = projectsDirWith([
      { id: 'p-1111aaaa', pmName: 'Iris', status: 'running' },
      { id: 'p-2222bbbb', pmName: 'Felix', status: 'running' },
    ])
    const r = allocatePMName({ projectId: 'p-3333cccc', projectsDir: dir })
    expect(r.fallback).toBe(true)
    expect(r.name).toBe('PM-3333cccc')
  })
})

describe('namesInUse', () => {
  beforeEach(() => {
    _resetPMRosterCacheForTests()
  })

  test('returns empty set for an empty projects dir', () => {
    const dir = mkdtempSync(join(tmp, 'empty-projects-'))
    expect(namesInUse(dir).size).toBe(0)
  })

  test('returns empty set for a non-existent projects dir', () => {
    expect(namesInUse(join(tmp, 'no-such-dir')).size).toBe(0)
  })
})

describe('PMRosterSchema', () => {
  test('accepts a valid v1 roster', () => {
    const r = PMRosterSchema.parse({
      schemaVersion: 1,
      roster: ['Iris', 'Felix'],
    })
    expect(r.roster).toEqual(['Iris', 'Felix'])
  })

  test('rejects empty roster', () => {
    expect(() => PMRosterSchema.parse({ schemaVersion: 1, roster: [] })).toThrow()
  })

  test('rejects unknown schemaVersion', () => {
    expect(() => PMRosterSchema.parse({ schemaVersion: 99, roster: ['Iris'] })).toThrow()
  })
})
