/**
 * EA mailroom — cross-EA messaging queue (Migration Plan §14.2.3;
 * architecture v2.1 §2.2.2, §2.2.5).
 *
 * Cross-EA messages are deposited as JSON envelope files under
 * `state/ea-mailroom/<from>-to-<to>/<envelopeId>.json`. The drain cycle
 * (60-second cadence — to be wired into the gateway in a follow-up) reads
 * the queue, delivers each envelope to the destination EA's mailbox, and
 * removes the file from the queue on success.
 *
 * Envelope contents per architecture §2.2.2:
 *   - body — the message body
 *   - fromPartition / toPartition — principal-keyed partitions (e.g. `jeff`,
 *     `sarah`); same naming convention as `state/eas/<partition>/`.
 *   - entity — the entity context the message belongs to (`cbs` | `wr`).
 *   - correlationId — propagated correlation chain (Δ DA-013).
 *   - shareableWithPrincipal — boolean. Defaults to false. When true, the
 *     destination EA may surface the message to its principal in the
 *     ordinary course; when false, the message is acted on but not
 *     surfaced. The audit thread always records the exchange regardless.
 *   - createdAt — ISO timestamp set at enqueue.
 *   - envelopeId — short ULID-style ID for the queue file name.
 *
 * Backpressure mitigations (architecture §2.2.5) are scoped for a follow-up
 * PR — this PR establishes the schema, queue paths, drop / drain helpers,
 * and the per-pair directory bootstrap. Queue depth and age alerts wire
 * into the existing `escalator` and `pendingAlerts` modules in §14.2.3
 * follow-up work.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync } from 'fs'
import { join } from 'path'
import { z } from 'zod'
import { writeJsonAtomic } from './atomicWrite.js'
import { logDispatcher } from './logger.js'
import { EA_MAILROOM_DIR } from './eaPartitions.js'

const PARTITION_RE = /^[a-z][a-z0-9-]*$/

export const ENTITY_VALUES = ['cbs', 'wr'] as const

export const MailroomEnvelopeSchema = z.object({
  envelopeId: z.string().regex(/^env-[a-z0-9]+$/, 'envelopeId must match env-<lowercase-alphanum>'),
  fromPartition: z.string().regex(PARTITION_RE, 'fromPartition must be lowercase alphanumeric with hyphens'),
  toPartition: z.string().regex(PARTITION_RE, 'toPartition must be lowercase alphanumeric with hyphens'),
  entity: z.enum(ENTITY_VALUES),
  correlationId: z.string().min(1),
  body: z.string().min(1),
  shareableWithPrincipal: z.boolean(),
  createdAt: z.string().min(1),
}).refine((env) => env.fromPartition !== env.toPartition, {
  message: 'fromPartition and toPartition must differ',
  path: ['toPartition'],
})

export type MailroomEnvelope = z.infer<typeof MailroomEnvelopeSchema>

/**
 * Path to the queue directory for a (from, to) pair. Pair directory is
 * `state/ea-mailroom/<from>-to-<to>/`.
 */
export function pairQueueDir(fromPartition: string, toPartition: string): string {
  if (!PARTITION_RE.test(fromPartition) || !PARTITION_RE.test(toPartition)) {
    throw new Error(
      `Invalid partition name(s): from="${fromPartition}", to="${toPartition}".`,
    )
  }
  if (fromPartition === toPartition) {
    throw new Error(`Self-addressed mailroom envelopes are rejected: ${fromPartition}`)
  }
  return join(EA_MAILROOM_DIR, `${fromPartition}-to-${toPartition}`)
}

function envelopePath(env: MailroomEnvelope): string {
  return join(pairQueueDir(env.fromPartition, env.toPartition), `${env.envelopeId}.json`)
}

function pairRejectedDir(fromPartition: string, toPartition: string): string {
  return join(pairQueueDir(fromPartition, toPartition), '.rejected')
}

/**
 * Generate a short envelope ID. Not UUID-grade entropy — a 10-char
 * base36 timestamp + 4-char random suffix is enough to keep file names
 * unique within a 60-second drain window. Format: `env-<14chars>`.
 */
export function newEnvelopeId(): string {
  const ts = Date.now().toString(36).padStart(10, '0').slice(-10)
  const rand = Math.random().toString(36).slice(2, 6).padStart(4, '0')
  return `env-${ts}${rand}`
}

/**
 * Drop an envelope onto the (from, to) queue. Validates the envelope
 * schema before writing — a bad drop is a programmer bug rather than
 * runtime input, so the failure raises rather than silently quarantining.
 * Idempotent re-drop of the same envelopeId overwrites in place per the
 * atomic-write semantics; the caller is responsible for envelopeId
 * uniqueness in production paths.
 */
export function dropEnvelope(env: MailroomEnvelope): string {
  const validated = MailroomEnvelopeSchema.parse(env)
  const dir = pairQueueDir(validated.fromPartition, validated.toPartition)
  mkdirSync(dir, { recursive: true })
  const path = envelopePath(validated)
  writeJsonAtomic(path, validated)
  logDispatcher('mailroom_envelope_queued', {
    envelopeId: validated.envelopeId,
    fromPartition: validated.fromPartition,
    toPartition: validated.toPartition,
    entity: validated.entity,
    correlationId: validated.correlationId,
    shareableWithPrincipal: validated.shareableWithPrincipal,
  })
  return path
}

/**
 * Quarantine a malformed envelope file. Same pattern as kickoffInbox.ts:
 * move to `.rejected/` with a timestamp prefix, log the reason, fall back
 * to deletion if the rename itself fails.
 */
function quarantine(
  fromPartition: string,
  toPartition: string,
  name: string,
  srcPath: string,
  reason: string,
): void {
  const rej = pairRejectedDir(fromPartition, toPartition)
  try {
    mkdirSync(rej, { recursive: true })
  } catch {}
  const dest = join(rej, `${Date.now()}-${name}`)
  try {
    renameSync(srcPath, dest)
    logDispatcher('mailroom_envelope_quarantined', {
      file: name,
      dest,
      reason,
      fromPartition,
      toPartition,
    })
  } catch (err) {
    logDispatcher('mailroom_envelope_quarantine_failed', {
      file: name,
      reason,
      error: String(err),
      fromPartition,
      toPartition,
    })
    try { unlinkSync(srcPath) } catch {}
  }
}

/**
 * Drain a single (from, to) queue. Returns the validated envelopes and
 * removes their files from the queue. Malformed files quarantine to
 * `.rejected/`. Caller integrates with the destination-side delivery
 * (writing to the destination partition's mailbox, posting to the audit
 * thread, etc.) — this function only owns dequeue.
 */
export function drainPairQueue(fromPartition: string, toPartition: string): MailroomEnvelope[] {
  const dir = pairQueueDir(fromPartition, toPartition)
  if (!existsSync(dir)) return []

  const envelopes: MailroomEnvelope[] = []
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch (err) {
    logDispatcher('mailroom_drain_listdir_failed', {
      fromPartition,
      toPartition,
      error: String(err),
    })
    return []
  }

  for (const name of names) {
    if (!name.endsWith('.json')) continue
    if (name.startsWith('.')) continue
    const full = join(dir, name)

    let raw: string
    try {
      raw = readFileSync(full, 'utf8')
    } catch (err) {
      quarantine(fromPartition, toPartition, name, full, `read_failed: ${String(err).slice(0, 100)}`)
      continue
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (err) {
      quarantine(fromPartition, toPartition, name, full, `json_parse_failed: ${String(err).slice(0, 100)}`)
      continue
    }

    const result = MailroomEnvelopeSchema.safeParse(parsed)
    if (!result.success) {
      quarantine(
        fromPartition,
        toPartition,
        name,
        full,
        `schema_invalid: ${result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ').slice(0, 200)}`,
      )
      continue
    }

    envelopes.push(result.data)
    try { unlinkSync(full) } catch {}
  }
  return envelopes
}

/**
 * Discover every (from, to) queue currently present under the mailroom
 * root. Returns pairs as `{from, to}`. Does not create directories — useful
 * for the drain cycle which iterates over real queues only.
 */
export function listPairQueues(): Array<{ from: string; to: string }> {
  if (!existsSync(EA_MAILROOM_DIR)) return []
  let entries: string[]
  try {
    entries = readdirSync(EA_MAILROOM_DIR)
  } catch {
    return []
  }
  const pairs: Array<{ from: string; to: string }> = []
  for (const name of entries) {
    const m = name.match(/^([a-z][a-z0-9-]*)-to-([a-z][a-z0-9-]*)$/)
    if (!m) continue
    pairs.push({ from: m[1], to: m[2] })
  }
  return pairs
}

/**
 * Drain every pair queue under the mailroom root. Returns the envelopes
 * drained, grouped by pair. Used by the gateway drain cycle (wired in a
 * follow-up PR per Migration Plan §14.2.3).
 */
export function drainAllPairs(): Array<{ from: string; to: string; envelopes: MailroomEnvelope[] }> {
  const result: Array<{ from: string; to: string; envelopes: MailroomEnvelope[] }> = []
  for (const { from, to } of listPairQueues()) {
    const envelopes = drainPairQueue(from, to)
    if (envelopes.length === 0) continue
    result.push({ from, to, envelopes })
  }
  return result
}

/**
 * Count pending envelopes per pair queue. Used by the depth-alert wiring
 * (architecture §2.2.5: queue depth >50 → 15-minute warning) — that wiring
 * lands in the same follow-up PR as the gateway drain integration.
 */
export function pairQueueDepth(fromPartition: string, toPartition: string): number {
  const dir = pairQueueDir(fromPartition, toPartition)
  if (!existsSync(dir)) return 0
  try {
    return readdirSync(dir).filter((n) => n.endsWith('.json') && !n.startsWith('.')).length
  } catch {
    return 0
  }
}
