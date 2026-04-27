import { describe, test, expect } from 'bun:test'
import {
  retryWithBackoff,
  isTransientError,
} from '../src/retryWithBackoff.js'

describe('retryWithBackoff — transient classification', () => {
  test('HTTP 529 (Anthropic over capacity) is transient', () => {
    expect(isTransientError({ status: 529 })).toBe(true)
  })

  test('HTTP 408 / 425 / 429 / 500 / 502 / 503 / 504 are transient', () => {
    for (const status of [408, 425, 429, 500, 502, 503, 504]) {
      expect(isTransientError({ status })).toBe(true)
    }
  })

  test('node ECONN* / ETIMEDOUT / EAI_AGAIN / EPIPE / EHOSTUNREACH / ENETUNREACH / UND_ERR_SOCKET are transient', () => {
    for (const code of [
      'ECONNRESET',
      'ECONNREFUSED',
      'ETIMEDOUT',
      'EAI_AGAIN',
      'EPIPE',
      'EHOSTUNREACH',
      'ENETUNREACH',
      'UND_ERR_SOCKET',
    ]) {
      expect(isTransientError({ code })).toBe(true)
    }
  })

  test('HTTP 4xx other than 408/425/429 is not transient', () => {
    expect(isTransientError({ status: 400 })).toBe(false)
    expect(isTransientError({ status: 401 })).toBe(false)
    expect(isTransientError({ status: 403 })).toBe(false)
    expect(isTransientError({ status: 404 })).toBe(false)
  })

  test('plain string error containing "529" or "rate limit" is matched via message regex', () => {
    expect(isTransientError({ message: 'HTTP 529 returned' })).toBe(true)
    expect(isTransientError({ message: 'rate limit exceeded' })).toBe(true)
    expect(isTransientError({ message: 'random non-transient error' })).toBe(false)
  })
})

describe('retryWithBackoff — execution', () => {
  test('returns the value on first success without sleeping', async () => {
    let attempts = 0
    const result = await retryWithBackoff(
      async () => {
        attempts++
        return 'ok'
      },
      { upstream: 'drive', attempts: 3, initialDelayMs: 1, maxDelayMs: 5 },
    )
    expect(result).toBe('ok')
    expect(attempts).toBe(1)
  })

  test('retries transient failures up to budget then resolves on a later success', async () => {
    let attempts = 0
    const result = await retryWithBackoff(
      async () => {
        attempts++
        if (attempts < 3) throw { status: 503, message: 'upstream brown-out' }
        return 'eventual-ok'
      },
      { upstream: 'anthropic', attempts: 5, initialDelayMs: 1, maxDelayMs: 5 },
    )
    expect(result).toBe('eventual-ok')
    expect(attempts).toBe(3)
  })

  test('rethrows immediately on a non-transient error without consuming the budget', async () => {
    let attempts = 0
    let thrown: unknown = null
    try {
      await retryWithBackoff(
        async () => {
          attempts++
          throw { status: 400, message: 'bad input' }
        },
        { upstream: 'paperclip', attempts: 5, initialDelayMs: 1, maxDelayMs: 5 },
      )
    } catch (err) {
      thrown = err
    }
    expect(attempts).toBe(1)
    expect(thrown).toBeTruthy()
  })

  test('exhausts the budget on persistent transient failures and rethrows the last error', async () => {
    let attempts = 0
    let thrown: unknown = null
    try {
      await retryWithBackoff(
        async () => {
          attempts++
          throw { status: 503, message: `attempt ${attempts}` }
        },
        { upstream: 'graph', attempts: 4, initialDelayMs: 1, maxDelayMs: 5 },
      )
    } catch (err) {
      thrown = err
    }
    expect(attempts).toBe(4)
    expect((thrown as { message?: string }).message).toBe('attempt 4')
  })

  test('onRetry hook fires once per inter-attempt sleep with attempt and delay metadata', async () => {
    const calls: Array<{ attempt: number; nextDelayMs: number }> = []
    let attempts = 0
    await retryWithBackoff(
      async () => {
        attempts++
        if (attempts < 3) throw { status: 503 }
        return 'ok'
      },
      {
        upstream: 'drive',
        attempts: 5,
        initialDelayMs: 1,
        maxDelayMs: 5,
        onRetry: (info) => calls.push({ attempt: info.attempt, nextDelayMs: info.nextDelayMs }),
      },
    )
    expect(calls).toHaveLength(2)
    expect(calls[0]!.attempt).toBe(1)
    expect(calls[1]!.attempt).toBe(2)
  })
})
