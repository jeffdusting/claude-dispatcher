/**
 * Identity-binding three-layer resolver (Migration Plan §14.2.4;
 * architecture v2.1 §2.2.4, §6.7).
 *
 * The architecture mandates three layers protecting against a message from
 * one principal exercising another principal's EA:
 *
 *   Layer 1 — dispatcher-side principal binding. The first-agent selector
 *             maps Discord author ID → owning EA partition; an unmapped
 *             author yields a refusal rather than a silent default.
 *
 *   Layer 2 — agent-definition directive ("you serve <name> only") inside
 *             each EA's AGENTS.md. This module resolves the principal
 *             display name and the per-EA vault credential reference so
 *             the worker spawn path can inject the right key and the
 *             AGENTS.md directive has a known target. Authoring of the
 *             AGENTS.md text itself is per-EA work (Phase J.1a / J.1b).
 *
 *   Layer 3 — audit-thread recording. Every resolution — allow or refuse —
 *             produces a record on the identity-binding audit log so the
 *             operator's weekly review can see who was bound to what,
 *             and which messages were refused. Cross-principal exchanges
 *             via the mailroom keep their own audit trail (eaMailroomCycle.ts).
 *
 * The resolver is the integrated three-layer interface used at the gateway
 * boundary. The lower-level firstAgentSelector primitive is preserved for
 * direct callers that only need the partition lookup (e.g. partition-tree
 * bootstrap).
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { STATE_DIR } from './config.js'
import { logDispatcher } from './logger.js'
import {
  selectEAForAuthor,
  getPartitionMetadata,
  type PartitionMetadata,
} from './firstAgentSelector.js'

const AUDIT_FILE = join(STATE_DIR, 'identity-binding-audit.jsonl')

/**
 * Resolved binding chain for an authorised principal.
 *
 * `partitionMetadata` is null when the partition exists in the mappings
 * block but lacks a declared metadata record (v1 config or transitional
 * state). Layer-2 enforcement at the AGENTS.md authoring layer still works
 * — the partition name itself is the directive's target — but the vault
 * credential reference is unavailable. Callers that depend on the vault
 * ref (per-EA worker spawn) should treat null metadata as a configuration
 * error and refuse rather than silently falling through.
 */
export interface ResolvedBinding {
  authorId: string
  partition: string
  partitionMetadata: PartitionMetadata | null
}

export type BindingDecision =
  | { kind: 'allow'; binding: ResolvedBinding }
  | { kind: 'refuse'; authorId: string; reason: 'unmapped_principal' }

export interface IdentityBindingContext {
  messageId?: string
  channelId?: string
  correlationId?: string
}

interface AuditRecord {
  timestamp: string
  decision: 'allow' | 'refuse'
  authorId: string
  partition: string | null
  principalName: string | null
  hasVaultRef: boolean
  reason: string | null
  messageId: string | null
  channelId: string | null
  correlationId: string | null
}

function appendAudit(record: AuditRecord): void {
  try {
    mkdirSync(STATE_DIR, { recursive: true })
    appendFileSync(AUDIT_FILE, JSON.stringify(record) + '\n')
  } catch (err) {
    logDispatcher('identity_binding_audit_append_failed', {
      authorId: record.authorId,
      error: String(err),
    })
  }
}

/**
 * Resolve the full identity-binding chain for a Discord author. Logs a
 * dispatcher event AND writes a JSONL audit record per call. Both records
 * are emitted regardless of decision so the audit trail captures refusals
 * (the failure-mode signal §2.2.5 names) as well as allows (the routing
 * record the operator's weekly review walks).
 *
 * Returns:
 *   { kind: 'allow', binding } when the author is mapped to a partition;
 *   { kind: 'refuse', authorId, reason } when the author is not mapped.
 *
 * The caller decides what to do with a refusal (typically: drop the
 * message silently — the access-control layer already gates *who* can
 * interact, and the binding layer gates *which EA serves them*).
 */
export function resolveIdentityBinding(
  authorId: string,
  context: IdentityBindingContext = {},
): BindingDecision {
  const lookup = selectEAForAuthor(authorId)

  if (lookup.kind === 'unmapped') {
    const reason: 'unmapped_principal' = 'unmapped_principal'
    appendAudit({
      timestamp: new Date().toISOString(),
      decision: 'refuse',
      authorId,
      partition: null,
      principalName: null,
      hasVaultRef: false,
      reason,
      messageId: context.messageId ?? null,
      channelId: context.channelId ?? null,
      correlationId: context.correlationId ?? null,
    })
    logDispatcher('identity_binding_refuse', {
      authorId,
      reason,
      messageId: context.messageId,
      channelId: context.channelId,
    })
    return { kind: 'refuse', authorId, reason }
  }

  const partition = lookup.partition
  const metadata = getPartitionMetadata(partition)
  const binding: ResolvedBinding = {
    authorId,
    partition,
    partitionMetadata: metadata,
  }
  appendAudit({
    timestamp: new Date().toISOString(),
    decision: 'allow',
    authorId,
    partition,
    principalName: metadata?.principalName ?? null,
    hasVaultRef: !!metadata?.anthropicKeyVaultRef,
    reason: null,
    messageId: context.messageId ?? null,
    channelId: context.channelId ?? null,
    correlationId: context.correlationId ?? null,
  })
  logDispatcher('identity_binding_allow', {
    authorId,
    partition,
    principalName: metadata?.principalName,
    hasVaultRef: !!metadata?.anthropicKeyVaultRef,
    messageId: context.messageId,
    channelId: context.channelId,
  })
  return { kind: 'allow', binding }
}

/** Test-only path accessor for the audit log. */
export function _identityBindingAuditPathForTesting(): string {
  return AUDIT_FILE
}
