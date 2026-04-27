/**
 * Per-upstream retry with exponential backoff (Phase A.9.1, Δ D-003).
 *
 * Wraps an async operation with retry-on-transient-failure semantics. Used
 * by upstream-facing code (Drive, Anthropic-spawn, Paperclip, Microsoft
 * Graph) so transient 5xx / rate-limit / network blips do not surface as
 * operator-visible errors.
 *
 * Spec: backoff capped at 30 seconds, 5-attempt budget. Migration Plan
 * §4.9.1 lists the four upstreams in scope; the helper is upstream-agnostic
 * — the caller passes the upstream name for log attribution.
 *
 * The default `shouldRetry` covers transient HTTP statuses (408, 425, 429,
 * 500, 502, 503, 504, and the Anthropic 529 over-capacity status that drove
 * the 25 April 2026 incident) plus common Node/Bun network error codes.
 * Callers can supply their own predicate when the upstream's failure model
 * differs.
 */
import { logDispatcher } from './logger.js'

export type Upstream = 'anthropic' | 'paperclip' | 'drive' | 'graph'

export interface RetryOptions {
  upstream: Upstream
  /** Maximum attempts including the first. Spec default: 5. */
  attempts?: number
  /** Initial delay between attempt 1 and attempt 2 (ms). Default 500. */
  initialDelayMs?: number
  /** Hard cap on per-iteration delay (ms). Spec default: 30 000. */
  maxDelayMs?: number
  /** Predicate that decides whether `err` warrants another attempt. */
  shouldRetry?: (err: unknown) => boolean
  /** Hook fired before sleeping prior to the next attempt. */
  onRetry?: (info: { attempt: number; nextDelayMs: number; err: unknown }) => void
  /** Tag added to log events so calls within an upstream are distinguishable. */
  operation?: string
}

const DEFAULTS = {
  attempts: 5,
  initialDelayMs: 500,
  maxDelayMs: 30_000,
} as const

const TRANSIENT_HTTP_STATUSES: ReadonlySet<number> = new Set([
  408, 425, 429, 500, 502, 503, 504, 529,
])

const TRANSIENT_NETWORK_CODES: ReadonlySet<string> = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_SOCKET',
])

export function isTransientError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as Record<string, unknown>

  const code = typeof e.code === 'string' ? e.code : undefined
  if (code && TRANSIENT_NETWORK_CODES.has(code)) return true

  const status =
    typeof e.status === 'number'
      ? e.status
      : typeof e.statusCode === 'number'
        ? e.statusCode
        : typeof (e.response as Record<string, unknown> | undefined)?.status === 'number'
          ? (e.response as Record<string, number>).status
          : undefined
  if (status !== undefined && TRANSIENT_HTTP_STATUSES.has(status)) return true

  const message = typeof e.message === 'string' ? e.message : ''
  if (/\b(429|500|502|503|504|529)\b/.test(message)) return true
  if (/timeout|timed out|temporarily|rate limit/i.test(message)) return true

  return false
}

function jitter(delayMs: number): number {
  return Math.round(delayMs * (0.7 + Math.random() * 0.6))
}

function nextDelay(attempt: number, initialDelayMs: number, maxDelayMs: number): number {
  const raw = initialDelayMs * Math.pow(2, attempt - 1)
  return Math.min(jitter(raw), maxDelayMs)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Run `fn` with retry-on-transient-failure. Returns the resolved value on
 * success; rethrows the last error if every attempt fails or the error is
 * judged non-transient.
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  opts: RetryOptions,
): Promise<T> {
  const attempts = opts.attempts ?? DEFAULTS.attempts
  const initialDelayMs = opts.initialDelayMs ?? DEFAULTS.initialDelayMs
  const maxDelayMs = opts.maxDelayMs ?? DEFAULTS.maxDelayMs
  const shouldRetry = opts.shouldRetry ?? isTransientError

  let lastErr: unknown
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      const isLast = attempt === attempts
      const transient = shouldRetry(err)

      if (isLast || !transient) {
        logDispatcher('upstream_retry_giveup', {
          upstream: opts.upstream,
          operation: opts.operation,
          attempt,
          transient,
          error: String(err).slice(0, 300),
        })
        throw err
      }

      const delay = nextDelay(attempt, initialDelayMs, maxDelayMs)
      logDispatcher('upstream_retry', {
        upstream: opts.upstream,
        operation: opts.operation,
        attempt,
        nextDelayMs: delay,
        error: String(err).slice(0, 200),
      })
      opts.onRetry?.({ attempt, nextDelayMs: delay, err })
      await sleep(delay)
    }
  }
  throw lastErr
}
