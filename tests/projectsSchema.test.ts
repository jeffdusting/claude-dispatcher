import { describe, test, expect } from 'bun:test'
import { normaliseProjectRecord, PROJECT_SCHEMA_VERSION } from '../src/projects.js'

describe('projects — normaliseProjectRecord (v1→v2 backfill, Δ DA-001)', () => {
  test('returns null when required v1 fields are missing', () => {
    expect(normaliseProjectRecord({})).toBeNull()
    expect(normaliseProjectRecord({ id: 'p-1' })).toBeNull()
    expect(normaliseProjectRecord({ id: 'p-1', name: 'x' })).toBeNull()
  })

  test('fills entity=cbs when absent (DEFAULT_ENTITY)', () => {
    const v1 = {
      id: 'p-1',
      name: 'thing',
      tasks: [],
    }
    const v2 = normaliseProjectRecord(v1 as Record<string, unknown>)
    expect(v2).toBeTruthy()
    expect(v2!.entity).toBe('cbs')
  })

  test('preserves an explicit valid entity', () => {
    const v1 = {
      id: 'p-2',
      name: 'thing',
      tasks: [],
      entity: 'wr',
    }
    const v2 = normaliseProjectRecord(v1 as Record<string, unknown>)
    expect(v2!.entity).toBe('wr')
  })

  test('coerces unknown entity values back to the default', () => {
    const v1 = {
      id: 'p-3',
      name: 'thing',
      tasks: [],
      entity: 'gibberish',
    }
    const v2 = normaliseProjectRecord(v1 as Record<string, unknown>)
    expect(v2!.entity).toBe('cbs')
  })

  test('fills paperclipTaskIds=[] when absent and filters non-strings when present', () => {
    const a = normaliseProjectRecord({
      id: 'p-4',
      name: 'a',
      tasks: [],
    } as Record<string, unknown>)
    expect(a!.paperclipTaskIds).toEqual([])

    const b = normaliseProjectRecord({
      id: 'p-5',
      name: 'b',
      tasks: [],
      paperclipTaskIds: ['t-1', 42, 't-2', null, 't-3'],
    } as Record<string, unknown>)
    expect(b!.paperclipTaskIds).toEqual(['t-1', 't-2', 't-3'])
  })

  test('fills correlationId="legacy-<id>" when absent; preserves a valid one', () => {
    const a = normaliseProjectRecord({
      id: 'p-6',
      name: 'a',
      tasks: [],
    } as Record<string, unknown>)
    expect(a!.correlationId).toBe('legacy-p-6')

    const b = normaliseProjectRecord({
      id: 'p-7',
      name: 'b',
      tasks: [],
      correlationId: '550e8400-e29b-41d4-a716-446655440000',
    } as Record<string, unknown>)
    expect(b!.correlationId).toBe('550e8400-e29b-41d4-a716-446655440000')
  })

  test('schemaVersion defaults to 1 for legacy records (so the backfill script knows to rewrite)', () => {
    const v1 = {
      id: 'p-8',
      name: 'v1',
      tasks: [],
    }
    const v2 = normaliseProjectRecord(v1 as Record<string, unknown>)
    expect(v2!.schemaVersion).toBe(1)
    expect(v2!.schemaVersion).not.toBe(PROJECT_SCHEMA_VERSION)
  })

  test('schemaVersion=2 records pass through unchanged', () => {
    const v2In = {
      id: 'p-9',
      name: 'v2',
      tasks: [],
      entity: 'cbs',
      paperclipTaskIds: ['pcp-1'],
      correlationId: 'abc-123',
      schemaVersion: 2,
    }
    const v2Out = normaliseProjectRecord(v2In as Record<string, unknown>)
    expect(v2Out!.schemaVersion).toBe(2)
    expect(v2Out!.entity).toBe('cbs')
    expect(v2Out!.paperclipTaskIds).toEqual(['pcp-1'])
    expect(v2Out!.correlationId).toBe('abc-123')
  })

  test('idempotent on re-normalisation', () => {
    const v1 = {
      id: 'p-10',
      name: 'idem',
      tasks: [],
    }
    const a = normaliseProjectRecord(v1 as Record<string, unknown>)!
    const b = normaliseProjectRecord(a as unknown as Record<string, unknown>)!
    expect(b.entity).toBe(a.entity)
    expect(b.paperclipTaskIds).toEqual(a.paperclipTaskIds)
    expect(b.correlationId).toBe(a.correlationId)
    expect(b.schemaVersion).toBe(a.schemaVersion)
  })
})
