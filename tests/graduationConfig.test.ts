/**
 * Tests for per-EA graduation config (R-952).
 *
 * Pins the default-empty-autonomousLanes invariant so a future schema change
 * does not silently flip behaviour from drafts-only to autonomous.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  GraduationConfigSchema,
  canAutoSend,
  loadGraduationConfig,
  type GraduationConfig,
} from '../src/lanes/graduationConfig.js'

describe('canAutoSend', () => {
  const emptyJeff: GraduationConfig = GraduationConfigSchema.parse({
    schemaVersion: 1,
    principal: 'jeff',
    autonomousLanes: [],
  })

  const autonomousGraduated: GraduationConfig = GraduationConfigSchema.parse({
    schemaVersion: 1,
    principal: 'jeff',
    autonomousLanes: ['autonomous'],
  })

  test('default empty config blocks every lane', () => {
    expect(canAutoSend('autonomous', emptyJeff).allowed).toBe(false)
    expect(canAutoSend('approval', emptyJeff).allowed).toBe(false)
    expect(canAutoSend('principal_only', emptyJeff).allowed).toBe(false)
  })

  test('graduated autonomous lane allows autonomous-tagged drafts', () => {
    expect(canAutoSend('autonomous', autonomousGraduated).allowed).toBe(true)
  })

  test('graduated autonomous still blocks approval and principal_only drafts', () => {
    expect(canAutoSend('approval', autonomousGraduated).allowed).toBe(false)
    expect(canAutoSend('principal_only', autonomousGraduated).allowed).toBe(false)
  })

  test('reason names the lane and the principal', () => {
    const allowed = canAutoSend('autonomous', autonomousGraduated)
    expect(allowed.reason).toContain('autonomous')
    expect(allowed.reason).toContain('jeff')
    const blocked = canAutoSend('approval', autonomousGraduated)
    expect(blocked.reason).toContain('approval')
    expect(blocked.reason).toContain('jeff')
  })
})

describe('loadGraduationConfig', () => {
  let tmp: string
  let goodPath: string
  let bumpedSchema: string

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), 'graduation-test-'))
    goodPath = join(tmp, 'good.json')
    bumpedSchema = join(tmp, 'bumped.json')
    writeFileSync(
      goodPath,
      JSON.stringify({ schemaVersion: 1, principal: 'sarah', autonomousLanes: [] }),
    )
    writeFileSync(
      bumpedSchema,
      JSON.stringify({ schemaVersion: 99, principal: 'sarah', autonomousLanes: [] }),
    )
  })

  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  test('loads a valid v1 config', () => {
    const cfg = loadGraduationConfig(goodPath)
    expect(cfg.principal).toBe('sarah')
    expect(cfg.autonomousLanes).toEqual([])
  })

  test('rejects a config with an unrecognised schemaVersion', () => {
    expect(() => loadGraduationConfig(bumpedSchema)).toThrow()
  })
})

describe('shipped per-EA configs', () => {
  test('Jeff ships drafts-only', () => {
    const cfg = loadGraduationConfig(
      join(import.meta.dir, '..', 'config', 'graduation-jeff.json'),
    )
    expect(cfg.principal).toBe('jeff')
    expect(cfg.autonomousLanes).toEqual([])
  })

  test('Sarah ships drafts-only', () => {
    const cfg = loadGraduationConfig(
      join(import.meta.dir, '..', 'config', 'graduation-sarah.json'),
    )
    expect(cfg.principal).toBe('sarah')
    expect(cfg.autonomousLanes).toEqual([])
  })
})
