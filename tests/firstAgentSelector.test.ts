/**
 * Tests for first-agent selector (Migration Plan §14.2.1, Δ D-015).
 *
 * The selector reads `config/first-agent-by-principal.json` and maps a
 * Discord author ID to a per-principal EA partition. Unmapped authors must
 * produce a refusal — silent default routing is the explicitly-rejected
 * failure mode.
 *
 * The config path is overridden via FIRST_AGENT_CONFIG_PATH (set in this
 * file's preamble before requiring the module under test) so the suite
 * never touches the real shipped config.
 */

import { describe, test, expect, beforeEach, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const tmp = mkdtempSync(join(tmpdir(), 'first-agent-test-'))
const cfgPath = join(tmp, 'first-agent-by-principal.json')
process.env.FIRST_AGENT_CONFIG_PATH = cfgPath

import {
  selectEAForAuthor,
  resolvePartitionWithAudit,
  listConfiguredPartitions,
  _resetFirstAgentCacheForTests,
  getFirstAgentConfigPath,
} from '../src/firstAgentSelector.js'

function writeConfig(mappings: Record<string, string>): void {
  // Re-assert the env var on each call. Other test files in the same
  // process can rebind FIRST_AGENT_CONFIG_PATH at their import time;
  // sticking it back here keeps this suite's expectations stable.
  process.env.FIRST_AGENT_CONFIG_PATH = cfgPath
  writeFileSync(
    cfgPath,
    JSON.stringify({ schemaVersion: 1, mappings }, null, 2),
  )
  _resetFirstAgentCacheForTests()
}

function deleteConfig(): void {
  process.env.FIRST_AGENT_CONFIG_PATH = cfgPath
  if (existsSync(cfgPath)) rmSync(cfgPath)
  _resetFirstAgentCacheForTests()
}

describe('firstAgentSelector — config path resolves from env', () => {
  test('getFirstAgentConfigPath honours the env override set in setup', () => {
    expect(getFirstAgentConfigPath()).toBe(cfgPath)
  })
})

describe('selectEAForAuthor', () => {
  beforeEach(() => {
    deleteConfig()
  })

  test('returns mapped result for a known author', () => {
    writeConfig({ '1234567890': 'jeff' })
    const result = selectEAForAuthor('1234567890')
    expect(result).toEqual({ kind: 'mapped', partition: 'jeff' })
  })

  test('returns unmapped for a missing author', () => {
    writeConfig({ '1234567890': 'jeff' })
    const result = selectEAForAuthor('9999999999')
    expect(result).toEqual({ kind: 'unmapped' })
  })

  test('returns unmapped when config file does not exist', () => {
    deleteConfig()
    const result = selectEAForAuthor('1234567890')
    expect(result).toEqual({ kind: 'unmapped' })
  })

  test('returns unmapped when mappings is empty', () => {
    writeConfig({})
    const result = selectEAForAuthor('1234567890')
    expect(result).toEqual({ kind: 'unmapped' })
  })

  test('caches the loaded config across calls', () => {
    writeConfig({ a: 'x' })
    expect(selectEAForAuthor('a')).toEqual({ kind: 'mapped', partition: 'x' })
    // Mutate the file directly without resetting the cache; the cached
    // result should not pick up the change.
    writeFileSync(cfgPath, JSON.stringify({ schemaVersion: 1, mappings: { a: 'y' } }))
    expect(selectEAForAuthor('a')).toEqual({ kind: 'mapped', partition: 'x' })
  })

  test('rejects malformed config (missing schemaVersion)', () => {
    writeFileSync(cfgPath, JSON.stringify({ mappings: { a: 'x' } }))
    _resetFirstAgentCacheForTests()
    expect(() => selectEAForAuthor('a')).toThrow()
  })

  test('rejects malformed config (wrong schemaVersion)', () => {
    // schemaVersion 1, 2 and 3 are accepted; an out-of-range value (e.g. 99)
    // is rejected. v2 (Migration Plan §14.2.4) added the partitions block;
    // v3 (R-940 §14, 2026-05-02) added per-partition runtime + LLM fields.
    writeFileSync(cfgPath, JSON.stringify({ schemaVersion: 99, mappings: { a: 'x' } }))
    _resetFirstAgentCacheForTests()
    expect(() => selectEAForAuthor('a')).toThrow()
  })

  test('accepts schemaVersion 2 with a partitions block', () => {
    writeFileSync(
      cfgPath,
      JSON.stringify({
        schemaVersion: 2,
        mappings: { a: 'x' },
        partitions: { x: { principalName: 'Alpha', anthropicKeyVaultRef: 'op://v/a' } },
      }),
    )
    _resetFirstAgentCacheForTests()
    expect(selectEAForAuthor('a')).toEqual({ kind: 'mapped', partition: 'x' })
  })

  test('rejects malformed config (mapping value empty)', () => {
    writeFileSync(cfgPath, JSON.stringify({ schemaVersion: 1, mappings: { a: '' } }))
    _resetFirstAgentCacheForTests()
    expect(() => selectEAForAuthor('a')).toThrow()
  })
})

describe('resolvePartitionWithAudit', () => {
  beforeEach(() => {
    deleteConfig()
  })

  test('returns the partition string on hit', () => {
    writeConfig({ '1234567890': 'sarah' })
    expect(resolvePartitionWithAudit('1234567890')).toBe('sarah')
  })

  test('returns null on miss', () => {
    writeConfig({ '1234567890': 'sarah' })
    expect(resolvePartitionWithAudit('5555555555')).toBe(null)
  })

  test('null on miss even with full context object', () => {
    writeConfig({})
    expect(
      resolvePartitionWithAudit('1234567890', {
        messageId: 'm-1',
        channelId: 'c-1',
        correlationId: 'corr-1',
      }),
    ).toBe(null)
  })
})

describe('listConfiguredPartitions', () => {
  beforeEach(() => {
    deleteConfig()
  })

  test('returns sorted unique partitions', () => {
    writeConfig({ a: 'jeff', b: 'sarah', c: 'jeff' })
    expect(listConfiguredPartitions()).toEqual(['jeff', 'sarah'])
  })

  test('returns empty when config has no mappings', () => {
    writeConfig({})
    expect(listConfiguredPartitions()).toEqual([])
  })

  test('returns empty when config file absent', () => {
    deleteConfig()
    expect(listConfiguredPartitions()).toEqual([])
  })
})

afterAll(() => {
  try { rmSync(tmp, { recursive: true, force: true }) } catch {}
})
