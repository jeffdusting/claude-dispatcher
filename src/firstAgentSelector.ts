/**
 * First-agent selector — maps a Discord author ID to its per-principal EA
 * partition (Δ D-015; Migration Plan §14.2.1).
 *
 * Each principal (Jeff, Sarah, ...) has exactly one EA. The dispatcher routes
 * a Discord message to the EA matching the message's author ID, looking up
 * the mapping in `config/first-agent-by-principal.json`. Unmapped authors
 * produce an audit-logged refusal rather than silently routing to a default
 * EA — silent default routing was the failure mode the design rejects, since
 * it would let an unknown principal's message exercise an EA that does not
 * serve them.
 *
 * The mapping file is loaded once at module import; reload requires a
 * dispatcher restart. Reload-on-disk-change is intentionally not supported —
 * the principal-to-EA binding is a piece of identity infrastructure that
 * should change deliberately, alongside the EA's AGENTS.md and audit thread
 * (Δ identity-binding three-layer mitigation, architecture §2.2.4).
 */

import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { z } from 'zod'
import { DISPATCHER_DIR } from './config.js'
import { logDispatcher } from './logger.js'

/**
 * Resolve the config path on each call so tests that override
 * FIRST_AGENT_CONFIG_PATH at module-import time pick up the override even
 * after this module has been first-loaded by an earlier test file.
 * Production uses the default DISPATCHER_DIR-rooted path.
 */
export function getFirstAgentConfigPath(): string {
  return (
    process.env.FIRST_AGENT_CONFIG_PATH ||
    join(DISPATCHER_DIR, 'config', 'first-agent-by-principal.json')
  )
}

const PartitionMetadataSchema = z.object({
  principalName: z.string().min(1),
  anthropicKeyVaultRef: z.string().min(1).optional(),
})

const FirstAgentConfigSchema = z.object({
  // schemaVersion 1: mappings only.
  // schemaVersion 2: mappings + optional partitions block (Migration Plan
  // §14.2.4; architecture v2.1 §2.2.4 layer-1 + layer-2 binding metadata).
  schemaVersion: z.union([z.literal(1), z.literal(2)]),
  comment: z.string().optional(),
  mappings: z.record(z.string(), z.string().min(1)),
  partitions: z.record(z.string(), PartitionMetadataSchema).optional(),
})

export type FirstAgentConfig = z.infer<typeof FirstAgentConfigSchema>
export type PartitionMetadata = z.infer<typeof PartitionMetadataSchema>

export type SelectorResult =
  | { kind: 'mapped'; partition: string }
  | { kind: 'unmapped' }

let cached: FirstAgentConfig | null = null

function load(): FirstAgentConfig {
  if (cached) return cached
  const path = getFirstAgentConfigPath()
  if (!existsSync(path)) {
    // Empty mapping rather than throw — a fresh deploy with no principals
    // mapped yet should refuse every message rather than crash the
    // dispatcher. Caller's audit log carries the refusal.
    cached = { schemaVersion: 1, mappings: {} }
    return cached
  }
  const raw = readFileSync(path, 'utf8')
  const parsed = JSON.parse(raw)
  cached = FirstAgentConfigSchema.parse(parsed)
  return cached
}

/**
 * Look up the EA partition for a Discord author ID.
 *
 * Returns `{kind: 'mapped', partition}` on hit; `{kind: 'unmapped'}` on miss.
 * The caller is responsible for logging the refusal — this function does not
 * log, since the call site has the surrounding context (channel, message ID,
 * correlation ID) that makes the audit entry useful.
 */
export function selectEAForAuthor(authorId: string): SelectorResult {
  const cfg = load()
  const partition = cfg.mappings[authorId]
  if (partition) return { kind: 'mapped', partition }
  return { kind: 'unmapped' }
}

/**
 * Convenience helper: look up the partition AND emit the refusal audit log
 * if unmapped. Returns the partition string on hit, null on miss. The miss
 * log carries the author ID and the optional correlation ID so the operator
 * can correlate refusals against the broader trace.
 */
export function resolvePartitionWithAudit(
  authorId: string,
  context: { messageId?: string; channelId?: string; correlationId?: string } = {},
): string | null {
  const result = selectEAForAuthor(authorId)
  if (result.kind === 'mapped') return result.partition
  logDispatcher('first_agent_refusal', {
    authorId,
    reason: 'unmapped_principal',
    ...context,
  })
  return null
}

/**
 * Reset the in-memory cache. Tests use this to rehydrate the config between
 * cases without restarting the process. Production code should not call this.
 */
export function _resetFirstAgentCacheForTests(): void {
  cached = null
}

/**
 * List all configured partitions (for diagnostics, not routing). Returns the
 * unique set of EA-partition values in the current mapping.
 */
export function listConfiguredPartitions(): string[] {
  const cfg = load()
  return Array.from(new Set(Object.values(cfg.mappings))).sort()
}

/**
 * Look up the partition metadata block for a given partition name. Returns
 * null when the config does not declare metadata for it (typical for v1
 * configs that pre-date the partitions block, or for partitions present in
 * `mappings` but not yet declared in `partitions`).
 *
 * Used by the identity-binding resolver (Migration Plan §14.2.4) to chain
 * Discord author → partition → principal display name + vault credential
 * reference.
 */
export function getPartitionMetadata(partition: string): PartitionMetadata | null {
  const cfg = load()
  const meta = cfg.partitions?.[partition]
  return meta ?? null
}
