/**
 * Tests for the partition-binding context (Migration Plan §14.4.3,
 * Phase J.1b) and the `agentForPartition` resolver helper.
 *
 * Covers: AsyncLocalStorage scope discipline, getCurrentPartition()
 * outside a scope, `agentForPartition()` reading partition metadata
 * from `first-agent-by-principal.json`, and graceful fallback for
 * partitions without an explicit `claudeAgent`.
 */

import { describe, test, expect, beforeEach, afterAll } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const tmpDir = mkdtempSync(join(tmpdir(), 'partition-context-test-'))
const configPath = join(tmpDir, 'first-agent-by-principal.json')
process.env.FIRST_AGENT_CONFIG_PATH = configPath

import { withPartition, getCurrentPartition } from '../src/partitionContext.js'
import {
  agentForPartition,
  _resetFirstAgentCacheForTests,
} from '../src/firstAgentSelector.js'

function writeConfig(content: unknown): void {
  writeFileSync(configPath, JSON.stringify(content, null, 2) + '\n')
  _resetFirstAgentCacheForTests()
}

afterAll(() => {
  try { rmSync(tmpDir, { recursive: true, force: true }) } catch {}
})

describe('partitionContext — scope discipline', () => {
  test('getCurrentPartition() returns undefined outside any scope', () => {
    expect(getCurrentPartition()).toBeUndefined()
  })

  test('getCurrentPartition() returns the partition inside a scope', () => {
    let observed: string | undefined
    withPartition('jeff', () => {
      observed = getCurrentPartition()
    })
    expect(observed).toBe('jeff')
  })

  test('inner scope wins over outer scope (nested)', () => {
    let observed: string | undefined
    withPartition('jeff', () => {
      withPartition('sarah', () => {
        observed = getCurrentPartition()
      })
    })
    expect(observed).toBe('sarah')
  })

  test('scope unwinds correctly after the inner block', () => {
    let inner: string | undefined
    let after: string | undefined
    withPartition('jeff', () => {
      withPartition('sarah', () => {
        inner = getCurrentPartition()
      })
      after = getCurrentPartition()
    })
    expect(inner).toBe('sarah')
    expect(after).toBe('jeff')
  })

  test('async work inside the scope keeps the partition binding', async () => {
    let observed: string | undefined
    await withPartition('sarah', async () => {
      await new Promise((resolve) => setTimeout(resolve, 5))
      observed = getCurrentPartition()
    })
    expect(observed).toBe('sarah')
  })
})

describe('agentForPartition', () => {
  beforeEach(() => {
    _resetFirstAgentCacheForTests()
  })

  test('returns the partition\'s claudeAgent when present', () => {
    writeConfig({
      schemaVersion: 2,
      mappings: { '111': 'jeff' },
      partitions: {
        jeff: {
          principalName: 'Jeff Dusting',
          claudeAgent: 'chief-of-staff',
        },
      },
    })
    expect(agentForPartition('jeff')).toBe('chief-of-staff')
  })

  test('returns null when partition metadata is absent', () => {
    writeConfig({
      schemaVersion: 2,
      mappings: { '111': 'jeff' },
      partitions: {},
    })
    expect(agentForPartition('jeff')).toBeNull()
  })

  test('returns null when claudeAgent is absent on the partition record', () => {
    writeConfig({
      schemaVersion: 2,
      mappings: { '111': 'jeff' },
      partitions: {
        jeff: {
          principalName: 'Jeff Dusting',
          // no claudeAgent
        },
      },
    })
    expect(agentForPartition('jeff')).toBeNull()
  })

  test('returns the right agent for each partition (Quinn vs chief-of-staff)', () => {
    writeConfig({
      schemaVersion: 2,
      mappings: { '111': 'jeff', '222': 'sarah' },
      partitions: {
        jeff: { principalName: 'Jeff Dusting', claudeAgent: 'chief-of-staff' },
        sarah: { principalName: 'Sarah Taylor', claudeAgent: 'quinn' },
      },
    })
    expect(agentForPartition('jeff')).toBe('chief-of-staff')
    expect(agentForPartition('sarah')).toBe('quinn')
  })

  test('returns null for an unknown partition', () => {
    writeConfig({
      schemaVersion: 2,
      mappings: { '111': 'jeff' },
      partitions: {
        jeff: { principalName: 'Jeff Dusting', claudeAgent: 'chief-of-staff' },
      },
    })
    expect(agentForPartition('nonexistent')).toBeNull()
  })

  test('rejects malformed claudeAgent values at config-load time (empty string)', () => {
    writeConfig({
      schemaVersion: 2,
      mappings: { '111': 'jeff' },
      partitions: {
        jeff: { principalName: 'Jeff Dusting', claudeAgent: '' },
      },
    })
    expect(() => agentForPartition('jeff')).toThrow()
  })
})
