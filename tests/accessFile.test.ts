import { describe, test, expect, beforeAll } from 'bun:test'
import { writeFileSync, existsSync } from 'fs'
import {
  ACCESS_FILE,
  loadAccess,
  updateAccess,
  type AccessConfig,
} from '../src/config.js'

const SEED: AccessConfig = {
  dmPolicy: 'allowlist',
  allowFrom: ['1495020845846761582'],
  groups: {},
  pending: {},
}

beforeAll(() => {
  writeFileSync(ACCESS_FILE, JSON.stringify(SEED, null, 2) + '\n', 'utf8')
})

describe('config.ts — ACCESS_FILE env override (B-013)', () => {
  test('ACCESS_FILE export reflects the env override set in setup.ts', () => {
    // setup.ts sets ACCESS_FILE under the test tmp dir; confirm the const
    // resolved at module load matches the env var.
    expect(ACCESS_FILE).toBe(process.env.ACCESS_FILE)
    expect(ACCESS_FILE.endsWith('/discord-access.json')).toBe(true)
  })

  test('loadAccess() reads from the override path', () => {
    const cfg = loadAccess()
    expect(cfg.dmPolicy).toBe('allowlist')
    expect(cfg.allowFrom).toEqual(['1495020845846761582'])
  })

  test('updateAccess() persists to the override path', () => {
    updateAccess((cfg) => {
      cfg.allowFrom.push('1495747655152701547')
    })
    const reloaded = loadAccess()
    expect(reloaded.allowFrom).toEqual([
      '1495020845846761582',
      '1495747655152701547',
    ])
    expect(existsSync(ACCESS_FILE)).toBe(true)
  })
})
