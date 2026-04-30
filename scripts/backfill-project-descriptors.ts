#!/usr/bin/env bun
/**
 * Backfill ProjectRecord schema migration (Phase A.6.3 + Phase J.1a §14.3.2).
 *
 * Walks `state/projects/` and `state/projects/archive/` and rewrites any
 * descriptor below `PROJECT_SCHEMA_VERSION` so it conforms to the current
 * schema.
 *
 * v1 → v2 (Phase A.6) added `entity`, `paperclipTaskIds`, `correlationId`,
 * `schemaVersion`. v2 → v3 (Phase J.1a) adds `owningEA` — the partition the
 * project belongs to (Migration Plan §14.3.2 in-place migration of Alex
 * Morgan's projects to the `jeff` partition).
 *
 * Usage:
 *   bun run dispatcher/scripts/backfill-project-descriptors.ts \
 *     [--entity cbs|wr] [--owning-ea jeff|sarah|...] [--dry-run] [--verbose]
 *
 * Defaults:
 *   --entity     cbs                     (DEFAULT_ENTITY — current dispatcher
 *                                         traffic is all CBS Group; flip per
 *                                         project before re-running if a WR
 *                                         project pre-exists)
 *   --owning-ea  jeff                    (DEFAULT_OWNING_EA — pre-J.1a
 *                                         dispatcher served Alex Morgan only)
 *   --dry-run    off                     (writes by default — guard with the
 *                                         flag if running in production)
 *
 * Idempotency: descriptors already at the current schemaVersion are skipped.
 * The script may be re-run safely after partial completion.
 *
 * The backfill leaves `correlationId` set to the existing value if present;
 * otherwise it generates a fresh UUID. `owningEA` is left set to the existing
 * value (or the legacy `eaOwner` alias if present) when it exists; otherwise
 * the --owning-ea CLI value is used. Existing logs are preserved; a single
 * log entry is appended noting the migration timestamp and source version.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { parseArgs } from 'util'
import { randomUUID } from 'crypto'
import {
  PROJECTS_DIR,
  PROJECTS_ARCHIVE_DIR,
  PROJECT_SCHEMA_VERSION,
  DEFAULT_OWNING_EA,
  type ProjectRecord,
} from '../src/projects.js'
import { writeJsonAtomic } from '../src/atomicWrite.js'
import { DEFAULT_ENTITY, type Entity, isEntity } from '../src/entity.js'

interface Args {
  entity: Entity
  owningEA: string
  dryRun: boolean
  verbose: boolean
}

function parseCliArgs(): Args {
  const { values } = parseArgs({
    options: {
      entity: { type: 'string' },
      'owning-ea': { type: 'string' },
      'dry-run': { type: 'boolean' },
      verbose: { type: 'boolean' },
    },
    strict: true,
  })

  const entityRaw = values.entity ?? DEFAULT_ENTITY
  if (!isEntity(entityRaw)) {
    console.error(`--entity must be one of: cbs, wr (got: ${entityRaw})`)
    process.exit(2)
  }

  const owningEA = values['owning-ea'] ?? DEFAULT_OWNING_EA
  if (!/^[a-z][a-z0-9-]*$/.test(owningEA)) {
    console.error(`--owning-ea must be lowercase alphanumeric with hyphens (got: ${owningEA})`)
    process.exit(2)
  }

  return {
    entity: entityRaw,
    owningEA,
    dryRun: values['dry-run'] === true,
    verbose: values.verbose === true,
  }
}

interface MigrationOutcome {
  scanned: number
  migrated: number
  alreadyV2: number
  skipped: number
  errors: number
}

function migrateDir(dir: string, args: Args, outcome: MigrationOutcome): void {
  if (!existsSync(dir)) {
    if (args.verbose) console.error(`skip: ${dir} does not exist`)
    return
  }

  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue
    if (name.startsWith('.')) continue

    const path = join(dir, name)
    if (!statSync(path).isFile()) continue

    outcome.scanned++

    let raw: Record<string, unknown>
    try {
      raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    } catch (err) {
      console.error(`error: ${path}: ${String(err)}`)
      outcome.errors++
      continue
    }

    if (typeof raw.id !== 'string' || typeof raw.name !== 'string' || !Array.isArray(raw.tasks)) {
      console.error(`error: ${path}: missing required v1 fields (id/name/tasks)`)
      outcome.errors++
      continue
    }

    const sourceVersion = typeof raw.schemaVersion === 'number' ? raw.schemaVersion : 1
    if (sourceVersion >= PROJECT_SCHEMA_VERSION) {
      outcome.alreadyV2++
      if (args.verbose) console.log(`skip v${sourceVersion}: ${path}`)
      continue
    }

    const entity = isEntity(raw.entity) ? raw.entity : args.entity
    const paperclipTaskIds = Array.isArray(raw.paperclipTaskIds)
      ? raw.paperclipTaskIds.filter((x): x is string => typeof x === 'string')
      : []
    const correlationId =
      typeof raw.correlationId === 'string' && raw.correlationId.length > 0
        ? raw.correlationId
        : randomUUID()
    // v3 field: owningEA. Honour an existing value or the legacy `eaOwner`
    // alias; otherwise apply the CLI default.
    const owningEA =
      typeof raw.owningEA === 'string' && raw.owningEA.length > 0
        ? raw.owningEA
        : typeof (raw as { eaOwner?: unknown }).eaOwner === 'string' &&
            ((raw as { eaOwner: string }).eaOwner).length > 0
          ? (raw as { eaOwner: string }).eaOwner
          : args.owningEA

    const migrated: ProjectRecord = {
      ...(raw as unknown as ProjectRecord),
      entity,
      paperclipTaskIds,
      correlationId,
      owningEA,
      schemaVersion: PROJECT_SCHEMA_VERSION,
    }

    // Append a single migration note to the log so the descriptor's history
    // shows when newer-version fields were added. Bound the log per the
    // existing 50-cap.
    const log = Array.isArray(migrated.log) ? migrated.log : []
    log.push({
      at: Date.now(),
      note: `Backfilled to schemaVersion ${PROJECT_SCHEMA_VERSION} (from v${sourceVersion}); entity=${entity}; owningEA=${owningEA}; correlationId=${correlationId}.`,
    })
    migrated.log = log.length > 50 ? log.slice(-50) : log

    if (args.dryRun) {
      console.log(`would migrate: ${path} (entity=${entity}, owningEA=${owningEA}, correlationId=${correlationId})`)
    } else {
      try {
        writeJsonAtomic(path, migrated)
        if (args.verbose) {
          console.log(`migrated: ${path} (entity=${entity}, owningEA=${owningEA}, correlationId=${correlationId})`)
        }
      } catch (err) {
        console.error(`error: ${path}: write failed: ${String(err)}`)
        outcome.errors++
        continue
      }
    }

    outcome.migrated++
  }
}

const args = parseCliArgs()
const outcome: MigrationOutcome = {
  scanned: 0,
  migrated: 0,
  alreadyV2: 0,
  skipped: 0,
  errors: 0,
}

console.log(`Backfill mode: ${args.dryRun ? 'DRY RUN' : 'WRITE'}`)
console.log(`Default entity: ${args.entity}`)
console.log(`Default owningEA: ${args.owningEA}`)
console.log(`Active projects dir: ${PROJECTS_DIR}`)
console.log(`Archive dir: ${PROJECTS_ARCHIVE_DIR}`)
console.log('')

migrateDir(PROJECTS_DIR, args, outcome)
migrateDir(PROJECTS_ARCHIVE_DIR, args, outcome)

console.log('')
console.log(`scanned:    ${outcome.scanned}`)
console.log(`migrated:   ${outcome.migrated}`)
console.log(`already v2: ${outcome.alreadyV2}`)
console.log(`errors:     ${outcome.errors}`)

process.exit(outcome.errors > 0 ? 1 : 0)
