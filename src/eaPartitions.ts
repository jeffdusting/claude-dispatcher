/**
 * Per-EA state directory bootstrap (Migration Plan §14.2.2;
 * architecture v2.1 §2.2.1, §5.1).
 *
 * Each principal-keyed partition lives at `state/eas/<partition>/` and holds
 * the EA's STYLE.md baseline, the principal-to-EA mailbox, and the EA's
 * audit thread snapshots. The first-agent selector resolves a Discord
 * author to one of these partitions; the partition path becomes the root for
 * any per-EA artefact.
 *
 * The mailroom (cross-EA) lives at `state/ea-mailroom/<from>-to-<to>/` and
 * is bootstrapped here too, since the directory parent (`ea-mailroom/`) is
 * universal even when no per-pair queue exists yet.
 *
 * Bootstrap is idempotent — `mkdirSync({recursive: true})` is the
 * primitive. Re-runs on every dispatcher start. The first-agent selector's
 * configured partitions are read from `config/first-agent-by-principal.json`
 * so only partitions for currently-mapped principals are pre-created. A
 * partition for an unmapped principal would be unused state.
 */

import { mkdirSync } from 'fs'
import { join } from 'path'
import { STATE_DIR } from './config.js'
import { listConfiguredPartitions } from './firstAgentSelector.js'

export const EAS_DIR = join(STATE_DIR, 'eas')
export const EA_MAILROOM_DIR = join(STATE_DIR, 'ea-mailroom')

const EA_SUBDIRS = ['mailbox', 'audit'] as const

/**
 * Path to a partition's root directory.
 */
export function partitionDir(partition: string): string {
  if (!/^[a-z][a-z0-9-]*$/.test(partition)) {
    throw new Error(
      `Invalid partition name: ${partition}. Expected lowercase alphanumeric with optional hyphens.`,
    )
  }
  return join(EAS_DIR, partition)
}

/**
 * Path to a partition's STYLE.md file (the approved baseline; not modified
 * by the EA itself per architecture §2.2.6 runtime write-interceptor).
 */
export function partitionStylePath(partition: string): string {
  return join(partitionDir(partition), 'style.md')
}

/**
 * Path to a partition's principal-to-EA mailbox directory.
 */
export function partitionMailboxDir(partition: string): string {
  return join(partitionDir(partition), 'mailbox')
}

/**
 * Path to a partition's audit thread snapshot directory.
 */
export function partitionAuditDir(partition: string): string {
  return join(partitionDir(partition), 'audit')
}

/**
 * Create a partition's directory tree if it does not already exist.
 * Idempotent. Safe to call from boot or from runtime when a partition is
 * added at runtime (typically via a config edit + dispatcher restart, but
 * the function does not assume restart-only).
 */
export function ensurePartitionDirs(partition: string): void {
  const root = partitionDir(partition)
  mkdirSync(root, { recursive: true })
  for (const sub of EA_SUBDIRS) {
    mkdirSync(join(root, sub), { recursive: true })
  }
}

/**
 * Bootstrap the partition tree for every partition currently configured in
 * the first-agent selector, plus the cross-EA mailroom parent. Called from
 * the dispatcher's boot path so the directory shape is in place before any
 * Discord message arrives.
 */
export function bootstrapEAPartitions(): { partitions: string[]; mailroomDir: string } {
  mkdirSync(EAS_DIR, { recursive: true })
  mkdirSync(EA_MAILROOM_DIR, { recursive: true })
  const partitions = listConfiguredPartitions()
  for (const p of partitions) ensurePartitionDirs(p)
  return { partitions, mailroomDir: EA_MAILROOM_DIR }
}
