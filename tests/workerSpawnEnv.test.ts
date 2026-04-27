import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { scopeWorkerEnv } from '../src/claude.js'

const ENV_KEYS_TO_RESTORE = [
  'CBS_SUPABASE_URL',
  'CBS_SUPABASE_SERVICE_ROLE_KEY',
  'WR_SUPABASE_URL',
  'WR_SUPABASE_SERVICE_ROLE_KEY',
]

describe('claude.ts — scopeWorkerEnv (Phase A.5.3, Δ DA-005)', () => {
  const saved: Record<string, string | undefined> = {}

  beforeEach(() => {
    for (const k of ENV_KEYS_TO_RESTORE) {
      saved[k] = process.env[k]
      delete process.env[k]
    }
    process.env.CBS_SUPABASE_URL = 'cbs-url'
    process.env.CBS_SUPABASE_SERVICE_ROLE_KEY = 'cbs-key'
    process.env.WR_SUPABASE_URL = 'wr-url'
    process.env.WR_SUPABASE_SERVICE_ROLE_KEY = 'wr-key'
  })

  afterEach(() => {
    for (const k of ENV_KEYS_TO_RESTORE) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })

  test('CBS worker env retains CBS_SUPABASE_* and drops WR_SUPABASE_*', () => {
    const env = scopeWorkerEnv('cbs', {})
    expect(env.CBS_SUPABASE_URL).toBe('cbs-url')
    expect(env.CBS_SUPABASE_SERVICE_ROLE_KEY).toBe('cbs-key')
    expect(env.WR_SUPABASE_URL).toBeUndefined()
    expect(env.WR_SUPABASE_SERVICE_ROLE_KEY).toBeUndefined()
  })

  test('WR worker env retains WR_SUPABASE_* and drops CBS_SUPABASE_*', () => {
    const env = scopeWorkerEnv('wr', {})
    expect(env.WR_SUPABASE_URL).toBe('wr-url')
    expect(env.WR_SUPABASE_SERVICE_ROLE_KEY).toBe('wr-key')
    expect(env.CBS_SUPABASE_URL).toBeUndefined()
    expect(env.CBS_SUPABASE_SERVICE_ROLE_KEY).toBeUndefined()
  })

  test('extras are merged into the scoped env', () => {
    const env = scopeWorkerEnv('cbs', {
      CLAUDE_THREAD_ID: 't-123',
      CLAUDE_ENTITY: 'cbs',
    })
    expect(env.CLAUDE_THREAD_ID).toBe('t-123')
    expect(env.CLAUDE_ENTITY).toBe('cbs')
  })

  test('non-Supabase env vars pass through unchanged', () => {
    process.env.SOME_OTHER_VAR = 'value'
    const env = scopeWorkerEnv('cbs', {})
    expect(env.SOME_OTHER_VAR).toBe('value')
    delete process.env.SOME_OTHER_VAR
  })

  test('extras override pass-through env when keys collide (extras win)', () => {
    process.env.OVERRIDE_TARGET = 'from-env'
    const env = scopeWorkerEnv('cbs', { OVERRIDE_TARGET: 'from-extras' })
    expect(env.OVERRIDE_TARGET).toBe('from-extras')
    delete process.env.OVERRIDE_TARGET
  })
})
