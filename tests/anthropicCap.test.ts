import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import {
  classifyAnthropicError,
  recordCapHitFromError,
  isAnthropicCapHit,
  readCapMarker,
  clearAnthropicCapHit,
  checkBudget,
  _resetCapDetectorForTesting,
} from '../src/anthropicCap.js'
import { installFetchStub, type FetchStub } from './helpers/fetchStub.js'

let fetchStub: FetchStub

describe('anthropicCap — classifyAnthropicError', () => {
  test('detects monthly-cap signatures from the 24 April 2026 incident class', () => {
    expect(classifyAnthropicError('Your credit balance is too low to make this request.')).toBe(
      'monthly-cap',
    )
    expect(classifyAnthropicError('Organization has reached its monthly cost limit.')).toBe(
      'monthly-cap',
    )
    expect(classifyAnthropicError('You have exceeded your monthly budget')).toBe('monthly-cap')
    expect(classifyAnthropicError({ message: 'billing limit reached' })).toBe('monthly-cap')
  })

  test('detects transient signatures (529 over-capacity, timeout, rate limit)', () => {
    expect(classifyAnthropicError('HTTP 529 Anthropic over capacity')).toBe('transient')
    expect(classifyAnthropicError('Request timed out')).toBe('transient')
    expect(classifyAnthropicError('rate limit exceeded')).toBe('transient')
  })

  test('returns "other" for unrelated error text', () => {
    expect(classifyAnthropicError('random error message')).toBe('other')
    expect(classifyAnthropicError({})).toBe('other')
    expect(classifyAnthropicError(null)).toBe('other')
  })

  test('reads .message and nested .error.message off error-shaped objects', () => {
    expect(classifyAnthropicError({ message: 'credit balance is too low' })).toBe('monthly-cap')
    expect(
      classifyAnthropicError({ error: { message: 'monthly cost limit reached' } }),
    ).toBe('monthly-cap')
  })
})

describe('anthropicCap — marker file lifecycle', () => {
  beforeEach(() => {
    _resetCapDetectorForTesting()
    fetchStub = installFetchStub()
  })

  afterEach(() => {
    fetchStub.uninstall()
    _resetCapDetectorForTesting()
  })

  test('isAnthropicCapHit starts false; recordCapHitFromError writes the marker', () => {
    expect(isAnthropicCapHit()).toBe(false)
    recordCapHitFromError('credit balance is too low')
    expect(isAnthropicCapHit()).toBe(true)
    const marker = readCapMarker()
    expect(marker).toBeTruthy()
    expect(marker!.detectedVia).toBe('reactive')
    expect(marker!.errorMessage).toContain('credit balance')
  })

  test('clearAnthropicCapHit removes the marker', () => {
    recordCapHitFromError('monthly cost limit')
    expect(isAnthropicCapHit()).toBe(true)
    clearAnthropicCapHit()
    expect(isAnthropicCapHit()).toBe(false)
    expect(readCapMarker()).toBeNull()
  })

  test('repeated recordCapHitFromError keeps the original capHitAt but updates errorMessage', async () => {
    recordCapHitFromError('first error')
    const first = readCapMarker()!
    await new Promise((r) => setTimeout(r, 5))
    recordCapHitFromError('second error')
    const second = readCapMarker()!
    expect(second.capHitAt).toBe(first.capHitAt)
    expect(second.errorMessage).toContain('second')
  })
})

describe('anthropicCap — proactive budget check', () => {
  beforeEach(() => {
    _resetCapDetectorForTesting()
    fetchStub = installFetchStub()
  })

  afterEach(() => {
    fetchStub.uninstall()
  })

  test('checkBudget returns null and skips fetch when ANTHROPIC_ADMIN_KEY is unset', async () => {
    const report = await checkBudget()
    expect(report).toBeNull()
    const anthropicCalls = fetchStub.calls.filter((c) => c.url.includes('anthropic.com'))
    expect(anthropicCalls).toHaveLength(0)
  })
})
