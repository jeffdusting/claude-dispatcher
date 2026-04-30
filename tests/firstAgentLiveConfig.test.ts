/**
 * Live-config verification (Phase J.1 §14.4 closure).
 *
 * This suite loads the actual `config/first-agent-by-principal.json` from
 * the dispatcher repo (rather than a synthetic tmp config) and confirms
 * the bindings the operator has staged for production resolve as
 * expected. It is the code-side verification step that precedes the
 * runbook's Discord-side verification ping (multi-EA-operations.md §2.9):
 * if these tests fail, do NOT run the Discord ping — fix the config
 * first.
 *
 * The fixture covers:
 *   - Jeff's Discord ID 1495020845846761582 → `jeff` partition →
 *     chief-of-staff agent, alex-morgan-runtime vault ref.
 *   - Sarah's Discord ID 1495747655152701547 → `sarah` partition →
 *     quinn agent, quinn-runtime vault ref.
 *   - An unknown ID is refused.
 *
 * Other tests in this suite use tmpdir configs to test schema variants;
 * this one is the integration check on the canonical file.
 */

import { describe, test, expect, beforeAll } from 'bun:test'
import { join } from 'path'

import { DISPATCHER_DIR } from '../src/config.js'
import {
  agentForPartition,
  getPartitionMetadata,
  selectEAForAuthor,
  _resetFirstAgentCacheForTests,
} from '../src/firstAgentSelector.js'

const LIVE_CONFIG_PATH = join(DISPATCHER_DIR, 'config', 'first-agent-by-principal.json')

beforeAll(() => {
  // Override the env to point at the canonical config so the loader picks
  // it up rather than the tmp config another suite may have set.
  process.env.FIRST_AGENT_CONFIG_PATH = LIVE_CONFIG_PATH
  _resetFirstAgentCacheForTests()
})

describe('first-agent-by-principal.json — live config', () => {
  test("Jeff's Discord ID resolves to the jeff partition", () => {
    const r = selectEAForAuthor('1495020845846761582')
    expect(r.kind).toBe('mapped')
    if (r.kind !== 'mapped') throw new Error('unreachable')
    expect(r.partition).toBe('jeff')
  })

  test("Sarah's Discord ID resolves to the sarah partition", () => {
    const r = selectEAForAuthor('1495747655152701547')
    expect(r.kind).toBe('mapped')
    if (r.kind !== 'mapped') throw new Error('unreachable')
    expect(r.partition).toBe('sarah')
  })

  test('an unknown Discord ID is refused', () => {
    const r = selectEAForAuthor('0000000000000000000')
    expect(r.kind).toBe('unmapped')
  })

  test('jeff partition: chief-of-staff agent, Alex Morgan principal, alex-morgan-runtime vault ref', () => {
    const meta = getPartitionMetadata('jeff')
    expect(meta).not.toBeNull()
    expect(meta!.principalName).toBe('Jeff Dusting')
    expect(meta!.anthropicKeyVaultRef).toBe(
      'op://CoS-Dispatcher/alex-morgan-runtime/credential',
    )
    expect(agentForPartition('jeff')).toBe('chief-of-staff')
  })

  test('sarah partition: quinn agent, Sarah Taylor principal, quinn-runtime vault ref', () => {
    const meta = getPartitionMetadata('sarah')
    expect(meta).not.toBeNull()
    expect(meta!.principalName).toBe('Sarah Taylor')
    expect(meta!.anthropicKeyVaultRef).toBe(
      'op://CoS-Dispatcher/quinn-runtime/credential',
    )
    expect(agentForPartition('sarah')).toBe('quinn')
  })
})
