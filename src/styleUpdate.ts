/**
 * STYLE.md iterative-update helpers (Migration Plan §14.3.3 / §14.4.3
 * conditional-approval requirement; Phase J.1 D2 carry-over).
 *
 * Operator approval of the Phase J.1a / J.1b STYLE.md baselines was
 * conditional on the EAs being able to receive style-update instructions
 * via Discord and reflect those updates in their behaviour. This module
 * is the file-I/O + audit-log layer underneath that mechanism. The
 * natural-language playbook lives at
 * `~/claude-workspace/generic/skills/style-update/SKILL.md`; the EA reads
 * the playbook and uses these helpers to persist the change.
 *
 * The flow:
 *
 *   1. EA receives a Discord message expressing a style preference.
 *   2. EA reads the current baseline via `readPartitionStyle(partition)`.
 *   3. EA composes a proposed update (the new full STYLE.md text plus
 *      a short rationale) and surfaces it as a Discord diff to the
 *      principal.
 *   4. Principal replies with affirmation ("approve" / "yes" / similar).
 *   5. EA calls `applyStyleUpdate({partition, principal, ...})` which
 *      writes the new content to BOTH the seed path
 *      (`state/seeds/eas/<partition>/style.md`, git-tracked, durable
 *      history) and the runtime path
 *      (`state/eas/<partition>/style.md`, immediate effect for the next
 *      session) and appends an audit record at
 *      `state/style-update-audit.jsonl`.
 *   6. The EA itself runs `git add` / `git commit` / `git push` via the
 *      Bash tool — git operations are kept outside this helper so they
 *      run under the EA's own Bash invocation under principal
 *      authorisation, with the dispatcher's git config rather than a
 *      service-account-style commit. The audit log captures the
 *      pre-commit state so the git history and the audit log can be
 *      reconciled if needed.
 *
 * Cross-EA boundary: an EA can only update its own partition's STYLE.md.
 * The dispatcher's identity binding (Phase J.1 §14.2.4) routes Discord
 * messages so that Jeff's messages reach Alex (the `jeff` partition) and
 * Sarah's reach Quinn (`sarah`). `applyStyleUpdate` requires the caller
 * to pass the partition explicitly; `assertPartitionMatchesScope` is the
 * helper an EA's session uses to confirm the active partition matches
 * what the message intends to update.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
} from 'fs'
import { join, dirname } from 'path'
import { STATE_DIR } from './config.js'
import { writeAtomic } from './atomicWrite.js'
import { logDispatcher } from './logger.js'

const PARTITION_RE = /^[a-z][a-z0-9-]*$/

/**
 * Path to the seed STYLE.md for a partition.
 *
 * The seed lives under `STATE_DIR/seeds/eas/<partition>/style.md` —
 * the same convention as the existing `bootstrap.ts` seed pattern. On
 * the laptop this is `dispatcher/state/seeds/eas/<partition>/style.md`,
 * git-tracked, edited and committed by the EA when an iterative update
 * lands. On cloud this is `/data/state/seeds/eas/<partition>/style.md`,
 * volume-resident, R2-backed for durability; the image-baked baseline
 * at `/app/state/seeds/` is not currently propagated to the volume —
 * that gap is a pre-existing first-boot-on-cloud limitation outside
 * this module's scope.
 *
 * Iterative updates rewrite this file in place; the EA commits and
 * pushes the change as part of the same session via its Bash tool.
 */
export function partitionStyleSeedPath(partition: string): string {
  if (!PARTITION_RE.test(partition)) {
    throw new Error(`Invalid partition name: ${partition}`)
  }
  return join(STATE_DIR, 'seeds', 'eas', partition, 'style.md')
}

/**
 * Path to the runtime STYLE.md for a partition.
 *
 * The runtime path is what the EA reads at session start. It is kept in
 * sync with the seed by `bootstrap.ts` on a cold boot (only when the
 * runtime file is absent — existing files survive) and by
 * `applyStyleUpdate()` on iterative updates (always overwritten).
 */
export function partitionStyleRuntimePath(partition: string): string {
  if (!PARTITION_RE.test(partition)) {
    throw new Error(`Invalid partition name: ${partition}`)
  }
  return join(STATE_DIR, 'eas', partition, 'style.md')
}

const STYLE_UPDATE_AUDIT_PATH = join(STATE_DIR, 'style-update-audit.jsonl')

export interface StyleUpdateAuditRecord {
  /** ISO timestamp at which the update was applied. */
  timestamp: string
  /** Partition that was updated (e.g. `jeff`, `sarah`). */
  partition: string
  /** Principal display name from the partition metadata, when known. */
  principalName: string | null
  /** Discord author ID of the principal who approved the change. */
  principalAuthorId: string
  /**
   * The Discord-side reference the EA was acting on — typically the ID of
   * the message that expressed the style preference, but any short
   * string the EA finds useful is acceptable. Recorded verbatim.
   */
  instructionRef: string | null
  /** Short human-readable summary of the change, EA-supplied. */
  summary: string
  /** Length (chars) of the previous STYLE.md content, for sanity. */
  previousLength: number
  /** Length (chars) of the new STYLE.md content. */
  newLength: number
}

export interface ApplyStyleUpdateInput {
  partition: string
  /**
   * The new full STYLE.md content. The caller produces this — the helper
   * does not generate the content itself; that's the EA's
   * principal-approved output.
   */
  newContent: string
  /** Discord author ID of the principal who approved this update. */
  principalAuthorId: string
  /** Display name of the principal (from partition metadata). */
  principalName?: string | null
  /** Discord message ID or any short reference the EA wishes to record. */
  instructionRef?: string | null
  /** Short human-readable summary of the change. */
  summary: string
}

export interface ApplyStyleUpdateResult {
  seedPath: string
  runtimePath: string
  auditRecord: StyleUpdateAuditRecord
  previousContent: string
}

/**
 * Read the current STYLE.md for a partition. Tries the runtime path
 * first (where the most recent iterative update lands); falls back to
 * the seed path (the original baseline). Returns null if neither is
 * present — the caller should treat this as a misconfigured partition
 * rather than an empty baseline, and surface to the principal.
 */
export function readPartitionStyle(partition: string): string | null {
  const runtime = partitionStyleRuntimePath(partition)
  if (existsSync(runtime)) {
    try {
      return readFileSync(runtime, 'utf8')
    } catch (err) {
      logDispatcher('style_update_read_runtime_failed', {
        partition,
        error: String(err),
      })
    }
  }
  const seed = partitionStyleSeedPath(partition)
  if (existsSync(seed)) {
    try {
      return readFileSync(seed, 'utf8')
    } catch (err) {
      logDispatcher('style_update_read_seed_failed', {
        partition,
        error: String(err),
      })
    }
  }
  return null
}

/**
 * Apply an approved style update.
 *
 * Writes the new content to BOTH the seed path (durable git history) and
 * the runtime path (immediate effect on next session). Appends a JSONL
 * audit record. Returns the audit record plus the previous content (so
 * the caller can include it in a Discord confirmation reply).
 *
 * Caller responsibilities:
 *
 *  - The new content must be the full new STYLE.md text, principal-
 *    approved — the helper does not validate semantic content.
 *  - Git operations (`git add`/`commit`/`push`) are not performed here;
 *    the EA invokes them via its Bash tool after this returns
 *    successfully. The audit record captures the pre-commit state so
 *    the git history and audit log can be reconciled.
 *  - The partition's identity must already be confirmed by the gateway's
 *    binding layer — this helper does not re-check who is allowed to
 *    update which partition; that is the caller's contract.
 */
export function applyStyleUpdate(input: ApplyStyleUpdateInput): ApplyStyleUpdateResult {
  if (!PARTITION_RE.test(input.partition)) {
    throw new Error(`Invalid partition name: ${input.partition}`)
  }
  if (input.newContent.length === 0) {
    throw new Error('newContent must not be empty')
  }
  if (!input.principalAuthorId) {
    throw new Error('principalAuthorId is required')
  }
  if (!input.summary) {
    throw new Error('summary is required')
  }

  const seedPath = partitionStyleSeedPath(input.partition)
  const runtimePath = partitionStyleRuntimePath(input.partition)

  const previousContent = (() => {
    if (existsSync(runtimePath)) {
      try { return readFileSync(runtimePath, 'utf8') } catch { return '' }
    }
    if (existsSync(seedPath)) {
      try { return readFileSync(seedPath, 'utf8') } catch { return '' }
    }
    return ''
  })()

  // Ensure the parent directories exist for both paths. Seed path may
  // already be in place; runtime path is created on first iterative
  // update if the partition was set up without a STYLE.md (rare).
  mkdirSync(dirname(seedPath), { recursive: true })
  mkdirSync(dirname(runtimePath), { recursive: true })

  // Atomic writes to both. Seed first (the durable record); runtime
  // second (the immediate-effect copy). If the runtime write fails after
  // the seed write succeeds, the next dispatcher boot's seed pattern
  // copies the seed onto the runtime path — so a partial failure is
  // recoverable rather than divergent.
  writeAtomic(seedPath, input.newContent)
  writeAtomic(runtimePath, input.newContent)

  const auditRecord: StyleUpdateAuditRecord = {
    timestamp: new Date().toISOString(),
    partition: input.partition,
    principalName: input.principalName ?? null,
    principalAuthorId: input.principalAuthorId,
    instructionRef: input.instructionRef ?? null,
    summary: input.summary,
    previousLength: previousContent.length,
    newLength: input.newContent.length,
  }

  try {
    mkdirSync(dirname(STYLE_UPDATE_AUDIT_PATH), { recursive: true })
    appendFileSync(STYLE_UPDATE_AUDIT_PATH, JSON.stringify(auditRecord) + '\n')
  } catch (err) {
    // Audit-log failure is logged but does not undo the file writes —
    // the durable record is the seed git commit the EA produces next.
    logDispatcher('style_update_audit_append_failed', {
      partition: input.partition,
      error: String(err),
    })
  }

  logDispatcher('style_update_applied', {
    partition: input.partition,
    principalAuthorId: input.principalAuthorId,
    principalName: input.principalName,
    summary: input.summary,
    previousLength: previousContent.length,
    newLength: input.newContent.length,
  })

  return {
    seedPath,
    runtimePath,
    auditRecord,
    previousContent,
  }
}

/**
 * Confirm the partition the EA intends to update matches the partition
 * the active gateway-binding scope assigned. Used by an EA's session to
 * fail-fast if it has wrongly inferred that it should update a partition
 * other than its own.
 *
 * Returns true when partitions match; false otherwise. The caller logs
 * and refuses the update.
 *
 * Note: the gateway's identity-binding layer already ensures messages
 * route to the correct EA, so a mismatch here means the EA's reasoning
 * mis-identified the partition — typically because it was asked to
 * update an EA other than itself ("Alex, please update Quinn's style").
 */
export function partitionMatchesScope(
  intendedPartition: string,
  activePartition: string,
): boolean {
  return intendedPartition === activePartition
}

/** Test-only path accessor for the audit log. */
export function _styleUpdateAuditPathForTesting(): string {
  return STYLE_UPDATE_AUDIT_PATH
}
