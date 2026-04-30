/**
 * Tests for the seed-state bootstrap (Phase A.4 + Migration Plan
 * §14.3.3 / §14.4.3 per-EA STYLE.md seeding).
 *
 * Covers: per-EA style.md is copied from `state/seeds/eas/<partition>/`
 * to `state/eas/<partition>/` on first boot, existing runtime files
 * are not clobbered (the iterative-update mechanism's writes survive
 * subsequent boots), missing seed subtree is a quiet no-op, and the
 * dynamic partition discovery picks up new partitions added under
 * seeds without code change.
 */

import { describe, test, expect, beforeEach, afterAll } from 'bun:test'
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  mkdtempSync,
} from 'fs'
import { join } from 'path'

// STATE_DIR is set by tests/setup.ts to a tmpdir path; bootstrap.ts reads it
// at module load. Use the same value here so the seeded files land where
// bootstrap.ts looks.
import { STATE_DIR } from '../src/config.js'
import { seedStateIfAbsent } from '../src/bootstrap.js'

const SEEDS_DIR = join(STATE_DIR, 'seeds')
const SEED_EAS_DIR = join(SEEDS_DIR, 'eas')
const RUNTIME_EAS_DIR = join(STATE_DIR, 'eas')

function purge(): void {
  // Clean both seeds/eas and eas/ so each test starts from a known empty
  // state. Other tests may have created state/seeds files; we only manage
  // the eas subtree here.
  for (const path of [SEED_EAS_DIR, RUNTIME_EAS_DIR]) {
    try { rmSync(path, { recursive: true, force: true }) } catch {}
  }
}

function writeSeedStyle(partition: string, content: string): void {
  const dir = join(SEED_EAS_DIR, partition)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'style.md'), content)
}

describe('bootstrap — seedStateIfAbsent / per-EA style.md', () => {
  beforeEach(() => {
    purge()
  })

  afterAll(() => {
    purge()
  })

  test('copies a seeded style.md to the runtime location on first boot', () => {
    writeSeedStyle('jeff', '# Alex baseline\n')
    seedStateIfAbsent()
    const runtimeStyle = join(RUNTIME_EAS_DIR, 'jeff', 'style.md')
    expect(existsSync(runtimeStyle)).toBe(true)
    expect(readFileSync(runtimeStyle, 'utf8')).toBe('# Alex baseline\n')
  })

  test('does not clobber an existing runtime style.md (volume is source of truth)', () => {
    writeSeedStyle('jeff', '# Alex seed v1\n')
    // Simulate the iterative-update mechanism having written a newer
    // baseline at runtime — bootstrap must not overwrite it.
    const runtimeDir = join(RUNTIME_EAS_DIR, 'jeff')
    mkdirSync(runtimeDir, { recursive: true })
    writeFileSync(join(runtimeDir, 'style.md'), '# Alex iterative v2\n')
    seedStateIfAbsent()
    expect(readFileSync(join(runtimeDir, 'style.md'), 'utf8')).toBe('# Alex iterative v2\n')
  })

  test('seeds multiple partitions in a single call', () => {
    writeSeedStyle('jeff', '# Alex baseline\n')
    writeSeedStyle('sarah', '# Quinn baseline\n')
    seedStateIfAbsent()
    expect(readFileSync(join(RUNTIME_EAS_DIR, 'jeff', 'style.md'), 'utf8')).toBe('# Alex baseline\n')
    expect(readFileSync(join(RUNTIME_EAS_DIR, 'sarah', 'style.md'), 'utf8')).toBe('# Quinn baseline\n')
  })

  test('partitions without a seed style.md are skipped without error', () => {
    // Create a partition seed dir with no style.md inside.
    mkdirSync(join(SEED_EAS_DIR, 'no-style'), { recursive: true })
    expect(() => seedStateIfAbsent()).not.toThrow()
    expect(existsSync(join(RUNTIME_EAS_DIR, 'no-style'))).toBe(false)
  })

  test('missing seeds/eas root is a quiet no-op', () => {
    // No SEED_EAS_DIR at all.
    expect(() => seedStateIfAbsent()).not.toThrow()
    expect(existsSync(RUNTIME_EAS_DIR)).toBe(false)
  })

  test('idempotent — second call after a successful seed is a no-op', () => {
    writeSeedStyle('jeff', '# Alex baseline\n')
    seedStateIfAbsent()
    // Second call should not reach inside the runtime file even if the
    // seed file is rewritten between calls — the runtime copy stays.
    writeSeedStyle('jeff', '# Alex seed UPDATED — should not propagate\n')
    seedStateIfAbsent()
    expect(readFileSync(join(RUNTIME_EAS_DIR, 'jeff', 'style.md'), 'utf8')).toBe('# Alex baseline\n')
  })

  test('a new partition added under seeds is picked up dynamically', () => {
    writeSeedStyle('jeff', '# Alex\n')
    seedStateIfAbsent()
    // Adding a new partition without restarting the test process — the
    // seed walk re-reads the directory each call.
    writeSeedStyle('sarah', '# Quinn\n')
    seedStateIfAbsent()
    expect(existsSync(join(RUNTIME_EAS_DIR, 'sarah', 'style.md'))).toBe(true)
  })
})
