/**
 * Tests for the schemaVersion 3 first-agent-by-principal extension (R-940 §14).
 *
 * Pins:
 *   - v2 records continue to load and resolve to claude-code + anthropic
 *     defaults via resolveRuntimeForPartition (no behaviour change for
 *     existing partitions).
 *   - v3 records with explicit runtime/llmProvider/llmModel/llmKeyVaultRef
 *     parse and surface the explicit values.
 *   - llmKeyVaultRef falls back to anthropicKeyVaultRef on v2 records.
 *   - Hermes-runtime partitions parse without requiring a runtime adapter
 *     to exist (the adapter lands when §13 pilot graduates).
 */

import { describe, test, expect, beforeEach, afterAll } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  selectEAForAuthor,
  resolveRuntimeForPartition,
  getPartitionMetadata,
  _resetFirstAgentCacheForTests,
} from '../src/firstAgentSelector.js'

const tmp = mkdtempSync(join(tmpdir(), 'first-agent-v3-test-'))

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true })
})

function writeConfig(content: object): string {
  const path = join(tmp, `cfg-${Math.random().toString(36).slice(2, 8)}.json`)
  writeFileSync(path, JSON.stringify(content))
  return path
}

beforeEach(() => {
  _resetFirstAgentCacheForTests()
})

describe('v2 records continue to load', () => {
  test('v2 partition without runtime fields resolves to claude-code defaults', () => {
    process.env.FIRST_AGENT_CONFIG_PATH = writeConfig({
      schemaVersion: 2,
      mappings: { '111': 'jeff' },
      partitions: {
        jeff: {
          principalName: 'Jeff Dusting',
          anthropicKeyVaultRef: 'op://CoS-Dispatcher/alex-morgan-runtime/credential',
          claudeAgent: 'chief-of-staff',
        },
      },
    })
    _resetFirstAgentCacheForTests()
    const meta = getPartitionMetadata('jeff')
    expect(meta?.principalName).toBe('Jeff Dusting')
    const r = resolveRuntimeForPartition('jeff')!
    expect(r.runtime).toBe('claude-code')
    expect(r.llmProvider).toBe('anthropic')
    expect(r.llmModel).toBe('claude-opus-4-7')
    expect(r.llmKeyVaultRef).toBe('op://CoS-Dispatcher/alex-morgan-runtime/credential')
  })

  test('v2 partition without anthropicKeyVaultRef resolves with null key ref', () => {
    process.env.FIRST_AGENT_CONFIG_PATH = writeConfig({
      schemaVersion: 2,
      mappings: { '222': 'orphan' },
      partitions: {
        orphan: { principalName: 'Orphan' },
      },
    })
    _resetFirstAgentCacheForTests()
    const r = resolveRuntimeForPartition('orphan')!
    expect(r.llmKeyVaultRef).toBeNull()
  })
})

describe('v3 records — explicit runtime + LLM fields', () => {
  test('v3 partition with runtime=hermes and llmProvider=anthropic parses', () => {
    process.env.FIRST_AGENT_CONFIG_PATH = writeConfig({
      schemaVersion: 3,
      mappings: { '333': 'jeff-shadow' },
      partitions: {
        'jeff-shadow': {
          principalName: 'Jeff Dusting (shadow)',
          claudeAgent: 'chief-of-staff',
          runtime: 'hermes',
          llmProvider: 'anthropic',
          llmModel: 'claude-opus-4-7',
          llmKeyVaultRef: 'op://CoS-Dispatcher/alex-morgan-runtime/credential',
        },
      },
    })
    _resetFirstAgentCacheForTests()
    const r = resolveRuntimeForPartition('jeff-shadow')!
    expect(r.runtime).toBe('hermes')
    expect(r.llmProvider).toBe('anthropic')
    expect(r.llmModel).toBe('claude-opus-4-7')
    expect(r.llmKeyVaultRef).toBe('op://CoS-Dispatcher/alex-morgan-runtime/credential')
  })

  test('v3 partition with alternative LLM provider parses', () => {
    process.env.FIRST_AGENT_CONFIG_PATH = writeConfig({
      schemaVersion: 3,
      mappings: { '444': 'open-test' },
      partitions: {
        'open-test': {
          principalName: 'Open Test',
          runtime: 'claude-code',
          llmProvider: 'openrouter',
          llmModel: 'meta-llama/llama-3.1-405b-instruct',
          llmKeyVaultRef: 'op://CoS-Dispatcher/openrouter/credential',
        },
      },
    })
    _resetFirstAgentCacheForTests()
    const r = resolveRuntimeForPartition('open-test')!
    expect(r.llmProvider).toBe('openrouter')
    expect(r.llmModel).toBe('meta-llama/llama-3.1-405b-instruct')
  })

  test('v3 partition with only runtime field defaults the rest', () => {
    process.env.FIRST_AGENT_CONFIG_PATH = writeConfig({
      schemaVersion: 3,
      mappings: { '555': 'minimal-v3' },
      partitions: {
        'minimal-v3': {
          principalName: 'Minimal V3',
          runtime: 'hermes',
        },
      },
    })
    _resetFirstAgentCacheForTests()
    const r = resolveRuntimeForPartition('minimal-v3')!
    expect(r.runtime).toBe('hermes')
    expect(r.llmProvider).toBe('anthropic')
    expect(r.llmModel).toBe('claude-opus-4-7')
    expect(r.llmKeyVaultRef).toBeNull()
  })
})

describe('llmKeyVaultRef fallback to anthropicKeyVaultRef', () => {
  test('v3 partition with anthropicKeyVaultRef but no llmKeyVaultRef falls back', () => {
    process.env.FIRST_AGENT_CONFIG_PATH = writeConfig({
      schemaVersion: 3,
      mappings: { '666': 'fallback-test' },
      partitions: {
        'fallback-test': {
          principalName: 'Fallback Test',
          runtime: 'claude-code',
          llmProvider: 'anthropic',
          anthropicKeyVaultRef: 'op://CoS-Dispatcher/legacy/credential',
        },
      },
    })
    _resetFirstAgentCacheForTests()
    const r = resolveRuntimeForPartition('fallback-test')!
    expect(r.llmKeyVaultRef).toBe('op://CoS-Dispatcher/legacy/credential')
  })

  test('llmKeyVaultRef takes precedence over anthropicKeyVaultRef when both present', () => {
    process.env.FIRST_AGENT_CONFIG_PATH = writeConfig({
      schemaVersion: 3,
      mappings: { '777': 'both-test' },
      partitions: {
        'both-test': {
          principalName: 'Both Test',
          llmKeyVaultRef: 'op://CoS-Dispatcher/new/credential',
          anthropicKeyVaultRef: 'op://CoS-Dispatcher/legacy/credential',
        },
      },
    })
    _resetFirstAgentCacheForTests()
    const r = resolveRuntimeForPartition('both-test')!
    expect(r.llmKeyVaultRef).toBe('op://CoS-Dispatcher/new/credential')
  })
})

describe('selectEAForAuthor still routes correctly', () => {
  test('v3 mapping resolves the author to the right partition', () => {
    process.env.FIRST_AGENT_CONFIG_PATH = writeConfig({
      schemaVersion: 3,
      mappings: { '999': 'jeff' },
      partitions: {
        jeff: { principalName: 'Jeff' },
      },
    })
    _resetFirstAgentCacheForTests()
    const r = selectEAForAuthor('999')
    expect(r).toEqual({ kind: 'mapped', partition: 'jeff' })
  })

  test('schema rejects an unrecognised schemaVersion', () => {
    process.env.FIRST_AGENT_CONFIG_PATH = writeConfig({
      schemaVersion: 99,
      mappings: { '888': 'bad' },
    })
    _resetFirstAgentCacheForTests()
    // The selector throws or errors on the bad config.
    expect(() => selectEAForAuthor('888')).toThrow()
  })
})

describe('shipped live config', () => {
  beforeEach(() => {
    delete process.env.FIRST_AGENT_CONFIG_PATH
    _resetFirstAgentCacheForTests()
  })

  test('shipped config is v3 and resolves both partitions to anthropic claude defaults', () => {
    const jeff = resolveRuntimeForPartition('jeff')!
    expect(jeff.runtime).toBe('claude-code')
    expect(jeff.llmProvider).toBe('anthropic')
    expect(jeff.llmModel).toBe('claude-opus-4-7')
    expect(jeff.llmKeyVaultRef).toBe('op://CoS-Dispatcher/alex-morgan-runtime/credential')

    const sarah = resolveRuntimeForPartition('sarah')!
    expect(sarah.runtime).toBe('claude-code')
    expect(sarah.llmProvider).toBe('anthropic')
    expect(sarah.llmKeyVaultRef).toBe('op://CoS-Dispatcher/quinn-runtime/credential')
  })
})
