/**
 * Tests for the STYLE.md iterative-update helpers (Phase J.1 D2).
 *
 * Covers: read of current STYLE.md (runtime first, seed fallback),
 * applyStyleUpdate writes both seed and runtime atomically, audit log
 * appends a JSONL record per call, partition-scope mismatch helper,
 * input validation, and the no-clobber invariant on bootstrap (kept
 * here as an end-to-end check that bootstrap does not undo iterative
 * updates).
 */

import { describe, test, expect, beforeEach, afterAll } from 'bun:test'
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from 'fs'
import { join } from 'path'

import { STATE_DIR } from '../src/config.js'
import {
  applyStyleUpdate,
  partitionMatchesScope,
  partitionStyleRuntimePath,
  partitionStyleSeedPath,
  readPartitionStyle,
  _styleUpdateAuditPathForTesting,
} from '../src/styleUpdate.js'
import { seedStateIfAbsent } from '../src/bootstrap.js'

const RUNTIME_EAS_DIR = join(STATE_DIR, 'eas')
const SEED_EAS_DIR = join(STATE_DIR, 'seeds', 'eas')

function purge(): void {
  for (const path of [
    RUNTIME_EAS_DIR,
    join(SEED_EAS_DIR, 'jeff-test'),
    join(SEED_EAS_DIR, 'sarah-test'),
    _styleUpdateAuditPathForTesting(),
  ]) {
    try { rmSync(path, { recursive: true, force: true }) } catch {}
  }
}

afterAll(() => {
  purge()
})

describe('styleUpdate — paths', () => {
  test('seed and runtime paths both rooted under STATE_DIR (matches bootstrap convention)', () => {
    expect(partitionStyleSeedPath('jeff-test')).toBe(
      join(STATE_DIR, 'seeds', 'eas', 'jeff-test', 'style.md'),
    )
    expect(partitionStyleRuntimePath('jeff-test')).toBe(
      join(STATE_DIR, 'eas', 'jeff-test', 'style.md'),
    )
  })

  test('rejects malformed partition names', () => {
    expect(() => partitionStyleSeedPath('Jeff-test')).toThrow()
    expect(() => partitionStyleRuntimePath('jeff_test')).toThrow()
  })
})

describe('readPartitionStyle', () => {
  beforeEach(() => {
    purge()
  })

  test('returns null when neither runtime nor seed exists', () => {
    expect(readPartitionStyle('jeff-test')).toBeNull()
  })

  test('reads from seed when only seed exists', () => {
    const seed = partitionStyleSeedPath('jeff-test')
    mkdirSync(join(SEED_EAS_DIR, 'jeff-test'), { recursive: true })
    writeFileSync(seed, '# Seed only\n')
    expect(readPartitionStyle('jeff-test')).toBe('# Seed only\n')
  })

  test('runtime takes precedence over seed when both exist', () => {
    const seed = partitionStyleSeedPath('jeff-test')
    const runtime = partitionStyleRuntimePath('jeff-test')
    mkdirSync(join(SEED_EAS_DIR, 'jeff-test'), { recursive: true })
    writeFileSync(seed, '# Seed v1\n')
    mkdirSync(join(RUNTIME_EAS_DIR, 'jeff-test'), { recursive: true })
    writeFileSync(runtime, '# Runtime v2 (iterative update)\n')
    expect(readPartitionStyle('jeff-test')).toBe('# Runtime v2 (iterative update)\n')
  })
})

describe('applyStyleUpdate', () => {
  beforeEach(() => {
    purge()
  })

  test('writes seed AND runtime; appends one audit record', () => {
    // Pre-existing baseline so previousLength is non-zero.
    mkdirSync(join(SEED_EAS_DIR, 'jeff-test'), { recursive: true })
    writeFileSync(partitionStyleSeedPath('jeff-test'), '# Old\n')

    const result = applyStyleUpdate({
      partition: 'jeff-test',
      newContent: '# New baseline\n',
      principalAuthorId: '1495020845846761582',
      principalName: 'Jeff Dusting',
      instructionRef: 'msg-123',
      summary: 'Reduce hedge phrasing in §1.1',
    })

    expect(readFileSync(result.seedPath, 'utf8')).toBe('# New baseline\n')
    expect(readFileSync(result.runtimePath, 'utf8')).toBe('# New baseline\n')
    expect(result.previousContent).toBe('# Old\n')

    const auditPath = _styleUpdateAuditPathForTesting()
    const lines = readFileSync(auditPath, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(1)
    const rec = JSON.parse(lines[0]!)
    expect(rec.partition).toBe('jeff-test')
    expect(rec.principalAuthorId).toBe('1495020845846761582')
    expect(rec.principalName).toBe('Jeff Dusting')
    expect(rec.instructionRef).toBe('msg-123')
    expect(rec.summary).toBe('Reduce hedge phrasing in §1.1')
    expect(rec.previousLength).toBe('# Old\n'.length)
    expect(rec.newLength).toBe('# New baseline\n'.length)
  })

  test('multiple updates produce one audit record each', () => {
    applyStyleUpdate({
      partition: 'sarah-test',
      newContent: '# v1\n',
      principalAuthorId: '1495747655152701547',
      summary: 'first',
    })
    applyStyleUpdate({
      partition: 'sarah-test',
      newContent: '# v2\n',
      principalAuthorId: '1495747655152701547',
      summary: 'second',
    })
    const lines = readFileSync(_styleUpdateAuditPathForTesting(), 'utf8')
      .trim()
      .split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0]!).summary).toBe('first')
    expect(JSON.parse(lines[1]!).summary).toBe('second')
  })

  test('rejects empty newContent', () => {
    expect(() =>
      applyStyleUpdate({
        partition: 'jeff-test',
        newContent: '',
        principalAuthorId: '1495020845846761582',
        summary: 'should fail',
      }),
    ).toThrow()
  })

  test('rejects missing principalAuthorId', () => {
    expect(() =>
      applyStyleUpdate({
        partition: 'jeff-test',
        newContent: '# x\n',
        principalAuthorId: '',
        summary: 'should fail',
      }),
    ).toThrow()
  })

  test('rejects missing summary', () => {
    expect(() =>
      applyStyleUpdate({
        partition: 'jeff-test',
        newContent: '# x\n',
        principalAuthorId: '1495020845846761582',
        summary: '',
      }),
    ).toThrow()
  })

  test('first update on a partition with no prior baseline still works', () => {
    const result = applyStyleUpdate({
      partition: 'newpart',
      newContent: '# brand new\n',
      principalAuthorId: 'whoever',
      summary: 'first ever',
    })
    expect(result.previousContent).toBe('')
    expect(readFileSync(result.runtimePath, 'utf8')).toBe('# brand new\n')
    expect(readFileSync(result.seedPath, 'utf8')).toBe('# brand new\n')
    // Cleanup
    try { rmSync(join(SEED_EAS_DIR, 'newpart'), { recursive: true, force: true }) } catch {}
  })
})

describe('partitionMatchesScope (cross-EA boundary)', () => {
  test('returns true for matching partitions', () => {
    expect(partitionMatchesScope('jeff', 'jeff')).toBe(true)
    expect(partitionMatchesScope('sarah', 'sarah')).toBe(true)
  })

  test('returns false when an EA tries to update another partition', () => {
    expect(partitionMatchesScope('quinn', 'jeff')).toBe(false)
    expect(partitionMatchesScope('jeff', 'sarah')).toBe(false)
  })
})

describe('end-to-end — bootstrap does not clobber an iterative update', () => {
  beforeEach(() => {
    purge()
  })

  test('after applyStyleUpdate, seedStateIfAbsent leaves the runtime file alone', () => {
    // Stage a seed baseline as if a fresh-volume boot would seed it.
    mkdirSync(join(SEED_EAS_DIR, 'sarah-test'), { recursive: true })
    writeFileSync(partitionStyleSeedPath('sarah-test'), '# seed baseline\n')

    // First boot: bootstrap copies seed to runtime.
    seedStateIfAbsent()
    expect(readFileSync(partitionStyleRuntimePath('sarah-test'), 'utf8')).toBe(
      '# seed baseline\n',
    )

    // Iterative update: applyStyleUpdate writes both runtime and seed.
    applyStyleUpdate({
      partition: 'sarah-test',
      newContent: '# iterative v2\n',
      principalAuthorId: '1495747655152701547',
      summary: 'iterative change',
    })

    // Second boot (e.g. dispatcher restart): bootstrap must NOT overwrite.
    seedStateIfAbsent()
    expect(readFileSync(partitionStyleRuntimePath('sarah-test'), 'utf8')).toBe(
      '# iterative v2\n',
    )
  })
})
