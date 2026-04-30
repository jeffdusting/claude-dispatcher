/**
 * Tests for per-EA partition directory bootstrap (Migration Plan §14.2.2).
 *
 * The bootstrap creates `state/eas/<partition>/{mailbox,audit}/` for every
 * partition currently configured in the first-agent selector, plus the
 * `state/ea-mailroom/` parent. STATE_DIR is routed to a fresh tmp dir by
 * tests/setup.ts. The first-agent config is routed via FIRST_AGENT_CONFIG_PATH.
 */

import { describe, test, expect, beforeEach, afterAll } from 'bun:test'
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const tmp = mkdtempSync(join(tmpdir(), 'ea-partitions-test-'))
const cfgPath = join(tmp, 'first-agent-by-principal.json')
process.env.FIRST_AGENT_CONFIG_PATH = cfgPath

import {
  partitionDir,
  partitionStylePath,
  partitionMailboxDir,
  partitionAuditDir,
  ensurePartitionDirs,
  bootstrapEAPartitions,
  EAS_DIR,
  EA_MAILROOM_DIR,
} from '../src/eaPartitions.js'
import { _resetFirstAgentCacheForTests } from '../src/firstAgentSelector.js'

function writeConfig(mappings: Record<string, string>): void {
  // Re-assert FIRST_AGENT_CONFIG_PATH on each call (see comment in
  // firstAgentSelector.test.ts) — other test files can rebind it at their
  // import time.
  process.env.FIRST_AGENT_CONFIG_PATH = cfgPath
  writeFileSync(
    cfgPath,
    JSON.stringify({ schemaVersion: 1, mappings }, null, 2),
  )
  _resetFirstAgentCacheForTests()
}

describe('partition path helpers', () => {
  test('partitionDir returns state/eas/<name>', () => {
    expect(partitionDir('jeff')).toBe(join(EAS_DIR, 'jeff'))
  })

  test('partitionDir rejects invalid names', () => {
    expect(() => partitionDir('Jeff')).toThrow()
    expect(() => partitionDir('jeff/')).toThrow()
    expect(() => partitionDir('123jeff')).toThrow()
    expect(() => partitionDir('')).toThrow()
    expect(() => partitionDir('jeff_test')).toThrow()
  })

  test('partitionDir accepts hyphens after the first char', () => {
    expect(() => partitionDir('jeff-secondary')).not.toThrow()
  })

  test('partitionStylePath / partitionMailboxDir / partitionAuditDir', () => {
    expect(partitionStylePath('jeff')).toBe(join(EAS_DIR, 'jeff', 'style.md'))
    expect(partitionMailboxDir('jeff')).toBe(join(EAS_DIR, 'jeff', 'mailbox'))
    expect(partitionAuditDir('jeff')).toBe(join(EAS_DIR, 'jeff', 'audit'))
  })
})

describe('ensurePartitionDirs', () => {
  test('creates root + mailbox + audit, idempotent', () => {
    ensurePartitionDirs('jeff')
    expect(existsSync(partitionDir('jeff'))).toBe(true)
    expect(existsSync(partitionMailboxDir('jeff'))).toBe(true)
    expect(existsSync(partitionAuditDir('jeff'))).toBe(true)
    // Re-run is a no-op (mkdirSync recursive is idempotent)
    ensurePartitionDirs('jeff')
    expect(existsSync(partitionDir('jeff'))).toBe(true)
  })
})

describe('bootstrapEAPartitions', () => {
  test('with one mapping creates the configured partition tree', () => {
    writeConfig({ '12345': 'jeff' })
    const result = bootstrapEAPartitions()
    expect(result.partitions).toEqual(['jeff'])
    expect(existsSync(EAS_DIR)).toBe(true)
    expect(existsSync(EA_MAILROOM_DIR)).toBe(true)
    expect(existsSync(partitionDir('jeff'))).toBe(true)
    expect(existsSync(partitionMailboxDir('jeff'))).toBe(true)
    expect(existsSync(partitionAuditDir('jeff'))).toBe(true)
  })

  test('with multiple mappings deduplicates and creates each unique partition', () => {
    writeConfig({ a: 'jeff', b: 'sarah', c: 'jeff' })
    const result = bootstrapEAPartitions()
    expect(result.partitions.sort()).toEqual(['jeff', 'sarah'])
    expect(existsSync(partitionDir('jeff'))).toBe(true)
    expect(existsSync(partitionDir('sarah'))).toBe(true)
  })

  test('with no mappings still creates the parent dirs (no partitions)', () => {
    writeConfig({})
    const result = bootstrapEAPartitions()
    expect(result.partitions).toEqual([])
    expect(existsSync(EAS_DIR)).toBe(true)
    expect(existsSync(EA_MAILROOM_DIR)).toBe(true)
  })

  test('mailroomDir in result matches the canonical EA_MAILROOM_DIR', () => {
    writeConfig({})
    const result = bootstrapEAPartitions()
    expect(result.mailroomDir).toBe(EA_MAILROOM_DIR)
  })
})

afterAll(() => {
  try { rmSync(tmp, { recursive: true, force: true }) } catch {}
})
