/**
 * Tests for the v5 project-record budget envelope (R-953 / R-945).
 *
 * Pins:
 *   - Optional budget fields normalise from missing → undefined.
 *   - addProjectSpend accumulates cost monotonically.
 *   - Non-positive cost values are no-ops (Claude returns null/0 for stale-
 *     cache hits).
 */

import { describe, test, expect, beforeEach } from 'bun:test'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const tmp = mkdtempSync(join(tmpdir(), 'projects-budget-test-'))
process.env.STATE_DIR = tmp
mkdirSync(join(tmp, 'projects'), { recursive: true })

import { addProjectSpend, getProject, normaliseProjectRecord, PROJECT_SCHEMA_VERSION, PROJECTS_DIR } from '../src/projects.js'

function writeProject(record: Record<string, unknown>): string {
  const id = record.id as string
  const path = join(PROJECTS_DIR, `${id}.json`)
  writeFileSync(path, JSON.stringify(record))
  return path
}

const baseV5Record = {
  id: 'p-budget01',
  name: 'Budget Test',
  brief: 'test',
  threadId: null,
  originThreadId: 't1',
  status: 'planning',
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
  pmName: 'Iris',
  schemaVersion: PROJECT_SCHEMA_VERSION,
}

describe('schema v6 normalisation (drive folder fields)', () => {
  beforeEach(() => {
    rmSync(PROJECTS_DIR, { recursive: true, force: true })
    mkdirSync(PROJECTS_DIR, { recursive: true })
  })

  test('v5 record without drive fields → driveFolderUrl/Id undefined', () => {
    const r = normaliseProjectRecord({ ...baseV5Record, schemaVersion: 5 })!
    expect(r.driveFolderUrl).toBeUndefined()
    expect(r.driveFolderId).toBeUndefined()
  })

  test('v6 record with drive fields preserves values', () => {
    const r = normaliseProjectRecord({
      ...baseV5Record,
      schemaVersion: 6,
      driveFolderUrl: 'https://drive.google.com/drive/folders/abc123',
      driveFolderId: 'abc123',
    })!
    expect(r.driveFolderUrl).toBe('https://drive.google.com/drive/folders/abc123')
    expect(r.driveFolderId).toBe('abc123')
  })
})

describe('schema v5 normalisation', () => {
  beforeEach(() => {
    rmSync(PROJECTS_DIR, { recursive: true, force: true })
    mkdirSync(PROJECTS_DIR, { recursive: true })
  })

  test('legacy v4 record without budget fields → all budget fields undefined', () => {
    const r = normaliseProjectRecord({ ...baseV5Record, schemaVersion: 4 })!
    expect(r.budgetEstimateUsd).toBeUndefined()
    expect(r.budgetCeilingUsd).toBeUndefined()
    expect(r.spendUsd).toBeUndefined()
    expect(r.agentBudgetBumps).toBeUndefined()
  })

  test('v5 record with budget envelope normalises preserving values', () => {
    const r = normaliseProjectRecord({
      ...baseV5Record,
      budgetEstimateUsd: 12.5,
      budgetCeilingUsd: 15,
      spendUsd: 3.75,
      agentBudgetBumps: [{ ts: 1, agentId: 'a-1', fromUsd: 5, toUsd: 8, reason: 'unblock task' }],
    })!
    expect(r.budgetEstimateUsd).toBe(12.5)
    expect(r.budgetCeilingUsd).toBe(15)
    expect(r.spendUsd).toBe(3.75)
    expect(r.agentBudgetBumps).toHaveLength(1)
  })
})

describe('addProjectSpend', () => {
  beforeEach(() => {
    rmSync(PROJECTS_DIR, { recursive: true, force: true })
    mkdirSync(PROJECTS_DIR, { recursive: true })
  })

  test('first increment initialises spendUsd from undefined', () => {
    writeProject(baseV5Record)
    addProjectSpend('p-budget01', 0.42)
    const r = getProject('p-budget01')!
    expect(r.spendUsd).toBe(0.42)
  })

  test('subsequent increments accumulate monotonically', () => {
    writeProject({ ...baseV5Record, spendUsd: 1.0 })
    addProjectSpend('p-budget01', 0.25)
    addProjectSpend('p-budget01', 0.5)
    const r = getProject('p-budget01')!
    expect(r.spendUsd).toBe(1.75)
  })

  test('non-positive cost is a no-op', () => {
    writeProject({ ...baseV5Record, spendUsd: 1.0 })
    addProjectSpend('p-budget01', 0)
    addProjectSpend('p-budget01', -0.5)
    addProjectSpend('p-budget01', NaN)
    const r = getProject('p-budget01')!
    expect(r.spendUsd).toBe(1.0)
  })

  test('non-existent project is a no-op (does not throw)', () => {
    expect(() => addProjectSpend('p-nonexistent', 1.0)).not.toThrow()
  })
})
