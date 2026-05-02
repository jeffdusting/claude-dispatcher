/**
 * Hermes shadow fork (R-940 §13 — shadow-Alex pilot).
 *
 * When a Discord message routes to a partition with an active shadow, the
 * dispatcher forks a copy of the message to the shadow runtime. The shadow
 * processes the message with Hermes Agent and writes its response to a
 * comparison register the operator reviews at the end of the pilot week.
 *
 * Read-only contract. The shadow consumes inputs and writes only to its
 * own state — it never posts to Discord, never sends mail, never mutates
 * calendar, never writes to Drive, never calls Paperclip. The dispatcher's
 * existing paths to mutation surfaces continue to be the live Alex stream.
 *
 * Two transport modes (operator-confirmed HTTP endpoint as primary):
 *
 *   HTTP — `HERMES_SHADOW_ENDPOINT` (URL) + `HERMES_SHADOW_API_TOKEN`
 *     (bearer). Dispatcher POSTs the envelope to the endpoint with the
 *     bearer header. Recommended for cross-app deployments (cos-dispatcher
 *     and cos-hermes-shadow-jeff are separate Fly apps with separate
 *     volumes).
 *
 *   File — `HERMES_SHADOW_INPUT_DIR` writes a JSON file to the directory.
 *     Useful for local testing and as a fallback when the HTTP endpoint
 *     is unreachable.
 *
 * Either is gated by `HERMES_SHADOW_PARTITIONS` (comma-separated). The fork
 * is a no-op when none of the transport env vars are set, OR no partitions
 * are configured, OR the inbound message's partition is not on the list.
 * Production behaviour is unchanged unless explicitly opted in.
 */

import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { logDispatcher } from './logger.js'

export interface ShadowForkInput {
  correlationId: string
  threadId: string
  channelId: string
  messageId: string
  authorId: string
  authorUsername: string
  partition: string
  contentRaw: string
  isThread: boolean
  hasAttachments: boolean
  ts: number
}

interface ShadowConfig {
  inputDir: string | null
  endpoint: string | null
  apiToken: string | null
  partitions: Set<string>
}

let cachedConfig: ShadowConfig | null = null

export function readShadowConfig(): ShadowConfig {
  if (cachedConfig) return cachedConfig
  const inputDir = process.env.HERMES_SHADOW_INPUT_DIR || null
  const endpoint = process.env.HERMES_SHADOW_ENDPOINT || null
  const apiToken = process.env.HERMES_SHADOW_API_TOKEN || null
  const rawPartitions = process.env.HERMES_SHADOW_PARTITIONS || ''
  const partitions = new Set(
    rawPartitions
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  )
  cachedConfig = { inputDir, endpoint, apiToken, partitions }
  return cachedConfig
}

/** Test-only — clear the cached config so env-var changes take effect. */
export function _resetShadowConfigForTests(): void {
  cachedConfig = null
}

export function shadowForkEnabled(partition: string): boolean {
  const cfg = readShadowConfig()
  // Either transport mode counts as enabled.
  if (!cfg.inputDir && !cfg.endpoint) return false
  if (cfg.partitions.size === 0) return false
  return cfg.partitions.has(partition)
}

/**
 * Fork a Discord message to the shadow runtime. Side-effect-free if the
 * shadow is not configured. Failures are logged and swallowed — the live
 * Alex stream continues regardless. HTTP transport is preferred when both
 * endpoint and inputDir are configured (operator-confirmed).
 */
export function forkToShadow(input: ShadowForkInput): {
  written: boolean
  transport?: 'http' | 'file'
  path?: string
  endpoint?: string
  reason?: string
} {
  const cfg = readShadowConfig()
  if (!cfg.partitions.has(input.partition)) return { written: false, reason: 'partition-not-shadowed' }

  // HTTP endpoint preferred when configured.
  if (cfg.endpoint) {
    forkViaHttp(cfg.endpoint, cfg.apiToken, input)
    // HTTP is fire-and-forget; the dispatcher's main path must not block on
    // the shadow. The function returns immediately; logDispatcher captures
    // success/failure asynchronously when the fetch resolves.
    return { written: true, transport: 'http', endpoint: cfg.endpoint }
  }

  if (cfg.inputDir) {
    try {
      mkdirSync(cfg.inputDir, { recursive: true })
      const filename = `${input.ts.toString(36)}-${input.correlationId}.json`
      const path = join(cfg.inputDir, filename)
      writeFileSync(path, JSON.stringify(input, null, 2), { encoding: 'utf8' })
      logDispatcher('hermes_shadow_fork_written', {
        partition: input.partition,
        correlationId: input.correlationId,
        threadId: input.threadId,
        path,
        transport: 'file',
      })
      return { written: true, transport: 'file', path }
    } catch (err) {
      logDispatcher('hermes_shadow_fork_failed', {
        partition: input.partition,
        correlationId: input.correlationId,
        transport: 'file',
        error: (err as Error).message,
      })
      return { written: false, transport: 'file', reason: (err as Error).message }
    }
  }

  return { written: false, reason: 'no-transport-configured' }
}

function forkViaHttp(endpoint: string, apiToken: string | null, input: ShadowForkInput): void {
  // Fire-and-forget. Five-second timeout so the dispatcher main path is not
  // held up if the shadow is slow or unreachable. Log the outcome after the
  // request resolves.
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (apiToken) headers.authorization = `Bearer ${apiToken}`
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 5000)
  fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(input),
    signal: controller.signal,
  })
    .then((res) => {
      clearTimeout(timeout)
      if (res.ok) {
        logDispatcher('hermes_shadow_fork_posted', {
          partition: input.partition,
          correlationId: input.correlationId,
          threadId: input.threadId,
          endpoint,
          status: res.status,
        })
      } else {
        logDispatcher('hermes_shadow_fork_post_failed', {
          partition: input.partition,
          correlationId: input.correlationId,
          endpoint,
          status: res.status,
        })
      }
    })
    .catch((err) => {
      clearTimeout(timeout)
      logDispatcher('hermes_shadow_fork_post_failed', {
        partition: input.partition,
        correlationId: input.correlationId,
        endpoint,
        error: (err as Error).message,
      })
    })
}
