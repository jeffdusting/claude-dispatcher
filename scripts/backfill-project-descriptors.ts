#!/usr/bin/env bun
/**
 * Backfill v1 → v2 ProjectRecord migration (Phase A.6.3).
 *
 * Walks `state/projects/` and `state/projects/archive/` and rewrites any
 * descriptor that lacks Phase A.6 fields (`entity`, `paperclipTaskIds`,
 * `correlationId`, `schemaVersion ≥ 2`) so it conforms to the v2 schema.
 *
 * Usage:
 *   bun run dispatcher/scripts/backfill-project-descriptors.ts \
 *     [--entity cbs|wr] [--dry-run] [--verbose]
 *
 * Defaults:
 *   --entity   cbs                       (DEFAULT_ENTITY — current dispatcher
 *                                         traffic is all CBS Group; flip per
 *                                         project before re-running if a WR
 *                                         project pre-exists)
 *   --dry-run  off                       (writes by default — guard with the
 *                                         flag if running in production)
 *
 * Idempotency: descriptors already at schemaVersion 2 are skipped. The script
 * may be re-run safely after partial completion.
 *
 * The backfill leaves `correlationId` set to the existing value if present;
 * otherwise it generates a fresh UUID. Existing logs are preserved; a single
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
  type ProjectRecord,
} from '../src/projects.js'
import { writeJsonAtomic } from '../src/atomicWrite.js'
import { DEFAULT_ENTITY, type Entity, isEntity } from '../src/entity.js'

interface Args {
  entity: Entity
  dryRun: boolean
  verbose: boolean
}

function parseCliArgs(): Args {
  const { values } = parseArgs({
    options: {
      entity: { type: 'string' },
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

  return {
    entity: entityRaw,
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

    const migrated: ProjectRecord = {
      ...(raw as unknown as ProjectRecord),
      entity,
      paperclipTaskIds,
      correlationId,
      schemaVersion: PROJECT_SCHEMA_VERSION,
    }

    // Append a single migration note to the log so the descriptor's history
    // shows when v2 fields were added. Bound the log per the existing 50-cap.
    const log = Array.isArray(migrated.log) ? migrated.log : []
    log.push({
      at: Date.now(),
      note: `Backfilled to schemaVersion ${PROJECT_SCHEMA_VERSION} (from v${sourceVersion}); entity=${entity}; correlationId=${correlationId}.`,
    })
    migrated.log = log.length > 50 ? log.slice(-50) : log

    if (args.dryRun) {
      console.log(`would migrate: ${path} (entity=${entity}, correlationId=${correlationId})`)
    } else {
      try {
        writeJsonAtomic(path, migrated)
        if (args.verbose) {
          console.log(`migrated: ${path} (entity=${entity}, correlationId=${correlationId})`)
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
