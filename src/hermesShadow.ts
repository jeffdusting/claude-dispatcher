/**
 * Hermes shadow fork (R-940 §13 — shadow-Alex pilot).
 *
 * When a Discord message routes to a partition with an active shadow, the
 * dispatcher writes a copy of the message to the shadow's input directory.
 * The Hermes Agent runtime drains the directory, processes the message
 * with its long-term memory and skill library, and writes its response to
 * a comparison register the operator reviews at the end of the pilot week.
 *
 * Read-only contract. The shadow consumes inputs and writes only to the
 * comparison register and to its own ~/.hermes/ memory and skills directory
 * — it never posts to Discord, never sends mail, never mutates calendar,
 * never writes to Drive, never calls Paperclip. The dispatcher's existing
 * paths to all of those mutation surfaces continue to be the live Alex
 * stream; the shadow is purely observational.
 *
 * Configuration is env-driven for zero-cost runtime when no shadow is
 * provisioned:
 *
 *   HERMES_SHADOW_INPUT_DIR — directory the dispatcher writes shadow-input
 *     files to. The shadow runtime drains this directory. If unset, the
 *     fork is a no-op.
 *   HERMES_SHADOW_PARTITIONS — comma-separated list of partition names that
 *     should be forked to the shadow (e.g. "jeff" to shadow Alex only).
 *     If unset, no fork.
 *
 * The fork runs only when both env vars are set AND the inbound message's
 * resolved partition matches the configured list. Result: the dispatcher
 * is a no-op for shadow purposes until the shadow Fly app is provisioned
 * and the env is wired in.
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
  partitions: Set<string>
}

let cachedConfig: ShadowConfig | null = null

export function readShadowConfig(): ShadowConfig {
  if (cachedConfig) return cachedConfig
  const inputDir = process.env.HERMES_SHADOW_INPUT_DIR || null
  const rawPartitions = process.env.HERMES_SHADOW_PARTITIONS || ''
  const partitions = new Set(
    rawPartitions
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  )
  cachedConfig = { inputDir, partitions }
  return cachedConfig
}

/** Test-only — clear the cached config so env-var changes take effect. */
export function _resetShadowConfigForTests(): void {
  cachedConfig = null
}

export function shadowForkEnabled(partition: string): boolean {
  const cfg = readShadowConfig()
  if (!cfg.inputDir) return false
  if (cfg.partitions.size === 0) return false
  return cfg.partitions.has(partition)
}

/**
 * Write a shadow-input file for a Discord message. Side-effect-free if the
 * shadow is not configured for the partition. Failures are logged and
 * swallowed — the live Alex stream continues regardless.
 */
export function forkToShadow(input: ShadowForkInput): { written: boolean; path?: string; reason?: string } {
  const cfg = readShadowConfig()
  if (!cfg.inputDir) return { written: false, reason: 'no-input-dir' }
  if (!cfg.partitions.has(input.partition)) return { written: false, reason: 'partition-not-shadowed' }
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
    })
    return { written: true, path }
  } catch (err) {
    logDispatcher('hermes_shadow_fork_failed', {
      partition: input.partition,
      correlationId: input.correlationId,
      error: (err as Error).message,
    })
    return { written: false, reason: (err as Error).message }
  }
}
