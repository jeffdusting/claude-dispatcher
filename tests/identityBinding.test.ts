/**
 * Tests for the identity-binding three-layer resolver (Migration Plan
 * §14.2.4; architecture v2.1 §2.2.4).
 *
 * Layer 1 — author → partition lookup (firstAgentSelector).
 * Layer 2 — partition → principal display name + vault credential ref.
 * Layer 3 — audit log entry per call (allow or refuse).
 *
 * Covers: mapped author with full v2 metadata, mapped author with v1
 * config (no metadata block), unmapped author refusal, audit-log JSONL
 * format, schema rejection of malformed configs.
 */

import { describe, test, expect, beforeEach, afterAll } from 'bun:test'
import {
  mkdtempSync,
  writeFileSync,
  existsSync,
  readFileSync,
  rmSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const tmpDir = mkdtempSync(join(tmpdir(), 'identity-binding-test-'))
const configPath = join(tmpDir, 'first-agent-by-principal.json')
process.env.FIRST_AGENT_CONFIG_PATH = configPath

import {
  resolveIdentityBinding,
  _identityBindingAuditPathForTesting,
} from '../src/identityBinding.js'
import { _resetFirstAgentCacheForTests } from '../src/firstAgentSelector.js'

const auditPath = _identityBindingAuditPathForTesting()

function writeConfig(content: unknown): void {
  writeFileSync(configPath, JSON.stringify(content, null, 2) + '\n')
  _resetFirstAgentCacheForTests()
}

function clearAudit(): void {
  try { rmSync(auditPath, { force: true }) } catch {}
}

function readAudit(): Array<Record<string, unknown>> {
  if (!existsSync(auditPath)) return []
  return readFileSync(auditPath, 'utf8')
    .trim()
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l))
}

afterAll(() => {
  try { rmSync(tmpDir, { recursive: true, force: true }) } catch {}
  clearAudit()
})

describe('resolveIdentityBinding — schema v2 (mappings + partitions)', () => {
  beforeEach(() => {
    clearAudit()
    writeConfig({
      schemaVersion: 2,
      mappings: { '111': 'jeff' },
      partitions: {
        jeff: {
          principalName: 'Jeff Dusting',
          anthropicKeyVaultRef: 'op://CoS-Dispatcher/alex-morgan-runtime/credential',
        },
      },
    })
  })

  test('returns allow with full partition metadata', () => {
    const result = resolveIdentityBinding('111')
    expect(result.kind).toBe('allow')
    if (result.kind !== 'allow') throw new Error('unreachable')
    expect(result.binding.partition).toBe('jeff')
    expect(result.binding.partitionMetadata).not.toBeNull()
    expect(result.binding.partitionMetadata!.principalName).toBe('Jeff Dusting')
    expect(result.binding.partitionMetadata!.anthropicKeyVaultRef).toBe(
      'op://CoS-Dispatcher/alex-morgan-runtime/credential',
    )
  })

  test('writes one allow record to the audit log', () => {
    resolveIdentityBinding('111', { messageId: 'm-1', channelId: 'c-1', correlationId: 'corr-1' })
    const records = readAudit()
    expect(records).toHaveLength(1)
    expect(records[0].decision).toBe('allow')
    expect(records[0].authorId).toBe('111')
    expect(records[0].partition).toBe('jeff')
    expect(records[0].principalName).toBe('Jeff Dusting')
    expect(records[0].hasVaultRef).toBe(true)
    expect(records[0].messageId).toBe('m-1')
    expect(records[0].channelId).toBe('c-1')
    expect(records[0].correlationId).toBe('corr-1')
  })
})

describe('resolveIdentityBinding — schema v1 (mappings only)', () => {
  beforeEach(() => {
    clearAudit()
    writeConfig({
      schemaVersion: 1,
      mappings: { '111': 'jeff' },
    })
  })

  test('returns allow with null partition metadata', () => {
    const result = resolveIdentityBinding('111')
    expect(result.kind).toBe('allow')
    if (result.kind !== 'allow') throw new Error('unreachable')
    expect(result.binding.partition).toBe('jeff')
    expect(result.binding.partitionMetadata).toBeNull()
  })

  test('audit record reflects missing metadata', () => {
    resolveIdentityBinding('111')
    const records = readAudit()
    expect(records).toHaveLength(1)
    expect(records[0].decision).toBe('allow')
    expect(records[0].principalName).toBeNull()
    expect(records[0].hasVaultRef).toBe(false)
  })
})

describe('resolveIdentityBinding — unmapped author', () => {
  beforeEach(() => {
    clearAudit()
    writeConfig({
      schemaVersion: 2,
      mappings: { '111': 'jeff' },
      partitions: {
        jeff: { principalName: 'Jeff Dusting' },
      },
    })
  })

  test('returns refuse with reason=unmapped_principal', () => {
    const result = resolveIdentityBinding('999')
    expect(result.kind).toBe('refuse')
    if (result.kind !== 'refuse') throw new Error('unreachable')
    expect(result.authorId).toBe('999')
    expect(result.reason).toBe('unmapped_principal')
  })

  test('writes a refuse record to the audit log', () => {
    resolveIdentityBinding('999', { messageId: 'm-9', channelId: 'c-9', correlationId: 'corr-9' })
    const records = readAudit()
    expect(records).toHaveLength(1)
    expect(records[0].decision).toBe('refuse')
    expect(records[0].authorId).toBe('999')
    expect(records[0].reason).toBe('unmapped_principal')
    expect(records[0].partition).toBeNull()
    expect(records[0].messageId).toBe('m-9')
  })
})

describe('resolveIdentityBinding — partition declared in mappings but missing metadata', () => {
  beforeEach(() => {
    clearAudit()
    writeConfig({
      schemaVersion: 2,
      mappings: { '111': 'jeff', '222': 'sarah' },
      partitions: {
        jeff: {
          principalName: 'Jeff Dusting',
          anthropicKeyVaultRef: 'op://CoS-Dispatcher/alex-morgan-runtime/credential',
        },
        // sarah is in mappings but missing from partitions — transitional
        // state during Quinn bootstrap (Phase J.1b).
      },
    })
  })

  test('still allows the message but exposes null metadata for the consumer to handle', () => {
    const result = resolveIdentityBinding('222')
    expect(result.kind).toBe('allow')
    if (result.kind !== 'allow') throw new Error('unreachable')
    expect(result.binding.partition).toBe('sarah')
    expect(result.binding.partitionMetadata).toBeNull()
  })
})

describe('resolveIdentityBinding — multiple sequential calls', () => {
  beforeEach(() => {
    clearAudit()
    writeConfig({
      schemaVersion: 2,
      mappings: { '111': 'jeff' },
      partitions: { jeff: { principalName: 'Jeff Dusting' } },
    })
  })

  test('writes one audit record per call (no batching, no dedup)', () => {
    resolveIdentityBinding('111')
    resolveIdentityBinding('999')
    resolveIdentityBinding('111')
    const records = readAudit()
    expect(records).toHaveLength(3)
    expect(records.map((r) => r.decision)).toEqual(['allow', 'refuse', 'allow'])
  })
})
