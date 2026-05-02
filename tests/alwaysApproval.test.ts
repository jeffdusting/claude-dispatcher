/**
 * Tests for the always-approval overlay (R-952).
 *
 * The overlay forces approval lane regardless of what the lane classifier
 * returned. Confirms the five matchers (counterparty ID, category, principal-
 * only topics, government domain, explicit domain match) and that an ordinary
 * sender is not falsely forced.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  AlwaysApprovalConfigSchema,
  loadAlwaysApprovalConfig,
  shouldForceApproval,
  type AlwaysApprovalConfig,
} from '../src/lanes/alwaysApproval.js'

const baseConfig: AlwaysApprovalConfig = AlwaysApprovalConfigSchema.parse({
  schemaVersion: 1,
  principal: 'jeff',
  counterpartyIds: ['sarah-taylor-waterroads'],
  categories: ['board', 'investor', 'regulator', 'government', 'legal'],
  domains: ['sarahjanetaylor/waterroads.com.au'],
})

describe('shouldForceApproval', () => {
  test('counterparty ID match forces approval', () => {
    const r = shouldForceApproval({
      fromHeader: 'Sarah Taylor <sarahjanetaylor@waterroads.com.au>',
      counterpartyProfile: { id: 'sarah-taylor-waterroads', category: 'internal' },
      config: baseConfig,
    })
    expect(r.force).toBe(true)
    expect(r.reason).toContain("counterparty id 'sarah-taylor-waterroads'")
  })

  test('counterparty category match forces approval', () => {
    const r = shouldForceApproval({
      fromHeader: 'Paul Miller <paul.miller@deutschmiller.com>',
      counterpartyProfile: { id: 'paul-miller', category: 'legal' },
      config: baseConfig,
    })
    expect(r.force).toBe(true)
    expect(r.reason).toContain("category 'legal'")
  })

  test('non-empty principal-only topics on profile forces approval', () => {
    const r = shouldForceApproval({
      fromHeader: 'partner@somewhere.com',
      counterpartyProfile: {
        id: 'partner',
        category: 'advisor',
        jeff_only_topics: ['equity raise'],
      },
      config: baseConfig,
    })
    expect(r.force).toBe(true)
    expect(r.reason).toContain('principal-only topics')
  })

  test('government domain forces approval (belt-and-braces)', () => {
    const r = shouldForceApproval({
      fromHeader: 'officer@transport.nsw.gov.au',
      counterpartyProfile: undefined,
      config: baseConfig,
    })
    expect(r.force).toBe(true)
    expect(r.reason).toContain('transport.nsw.gov.au')
  })

  test('explicit user@domain match forces approval', () => {
    const r = shouldForceApproval({
      fromHeader: 'sarahjanetaylor@waterroads.com.au',
      counterpartyProfile: undefined,
      config: baseConfig,
    })
    // The slash-shorthand domain matches sarahjanetaylor@waterroads.com.au.
    expect(r.force).toBe(true)
  })

  test('ordinary internal sender not forced', () => {
    const r = shouldForceApproval({
      fromHeader: 'Jim Ellwood <jimellwood@waterroads.com.au>',
      counterpartyProfile: { id: 'jim-ellwood-waterroads', category: 'internal' },
      config: baseConfig,
    })
    expect(r.force).toBe(false)
    expect(r.reason).toBeNull()
  })

  test('unknown sender with no profile not forced', () => {
    const r = shouldForceApproval({
      fromHeader: 'unknown@somewhere.org',
      counterpartyProfile: undefined,
      config: baseConfig,
    })
    expect(r.force).toBe(false)
  })
})

describe('loadAlwaysApprovalConfig', () => {
  let tmp: string
  let goodPath: string
  let badPath: string

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), 'always-approval-test-'))
    goodPath = join(tmp, 'good.json')
    badPath = join(tmp, 'bad.json')
    writeFileSync(
      goodPath,
      JSON.stringify({
        schemaVersion: 1,
        principal: 'sarah',
        counterpartyIds: ['jeff-dusting'],
        categories: ['board'],
        domains: [],
      }),
    )
    writeFileSync(badPath, JSON.stringify({ schemaVersion: 2, principal: 'sarah' }))
  })

  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  test('parses a valid config', () => {
    const cfg = loadAlwaysApprovalConfig(goodPath)
    expect(cfg.principal).toBe('sarah')
    expect(cfg.counterpartyIds).toEqual(['jeff-dusting'])
    expect(cfg.categories).toEqual(['board'])
  })

  test('rejects a config with the wrong schemaVersion', () => {
    expect(() => loadAlwaysApprovalConfig(badPath)).toThrow()
  })
})
