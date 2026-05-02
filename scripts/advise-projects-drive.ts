#!/usr/bin/env bun
/**
 * One-shot operator script — append a Drive-availability advisory note to
 * the project log of every active and archived project. Triggered 2026-05-02
 * after PR #52 fixed the silent-skip Drive upload bug; operator's directive:
 * "all current projects are advised to use the google drives for outputs
 * once this is established, including archived threads and projects".
 *
 * Behaviour:
 *   - Walks /data/state/projects/*.json (active) and
 *     /data/state/projects/archive/*.json (archived).
 *   - For each project, appends a single log entry naming the entity's
 *     Drive folder URL and the canonical <entity>/<year>/<project-id>-<slug>/
 *     output structure.
 *   - Skips a project if the same advisory note is already present (rerunnable).
 *   - Reports counts.
 *
 * Read-only outside the project descriptor — does not touch outbox files,
 * Drive directly, or any external state.
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import { PROJECTS_DIR, PROJECTS_ARCHIVE_DIR, normaliseProjectRecord } from '../src/projects.js'

const ADVISORY_TAG = '[r-940 drive-advisory 2026-05-02]'

const CBS_FOLDER_URL = 'https://drive.google.com/drive/folders/1P7sAByjFLdlLg_bBtqAK7oraeHOwHCX4'
const WR_FOLDER_URL = 'https://drive.google.com/drive/folders/0AK2-hid6-LNFUk9PVA'

function noteFor(entity: 'cbs' | 'wr', projectId: string, projectName: string): string {
  const folderUrl = entity === 'cbs' ? CBS_FOLDER_URL : WR_FOLDER_URL
  const year = new Date().getUTCFullYear()
  const slug = projectName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  const outputPath = `${entity}/${year}/${projectId}-${slug}/`
  return (
    `${ADVISORY_TAG} Drive outputs are live as of 2026-05-02 (PR #52 fixed the ` +
    `entrypoint silent-skip bug). All future outbox files for this project will ` +
    `mirror to the entity's Drive folder at ${folderUrl} under the path ` +
    `${outputPath}. PM agents reading this entry on next resume: write outputs ` +
    `to outbox/ as usual; the dispatcher's drive.ts auto-uploads on each turn ` +
    `via the Phase A.5.1 / DA-007 outbox manifest pattern.`
  )
}

function processFile(path: string, isArchived: boolean): { ok: boolean; reason?: string; advisedAt?: number } {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (e) {
    return { ok: false, reason: `cannot read: ${(e as Error).message}` }
  }
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>
  } catch (e) {
    return { ok: false, reason: `cannot parse: ${(e as Error).message}` }
  }
  const record = normaliseProjectRecord(parsed)
  if (!record) return { ok: false, reason: 'normaliseProjectRecord returned null' }

  // Idempotency — skip if already advised.
  for (const entry of record.log ?? []) {
    if (entry.note?.includes(ADVISORY_TAG)) {
      return { ok: true, reason: 'already-advised', advisedAt: entry.at }
    }
  }

  const note = noteFor(record.entity, record.id, record.name)
  const updated = {
    ...parsed,
    log: [...(record.log ?? []), { at: Date.now(), note }],
  }
  // Atomic write: rename pattern
  const tmpPath = `${path}.tmp`
  writeFileSync(tmpPath, JSON.stringify(updated, null, 2), { encoding: 'utf8' })
  // Bun's fs.renameSync — use require for compat
  const fs = require('fs')
  fs.renameSync(tmpPath, path)
  return { ok: true, advisedAt: Date.now() }
}

function walkDir(dir: string, isArchived: boolean): { advised: number; skipped: number; failed: number } {
  let advised = 0
  let skipped = 0
  let failed = 0
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch (e) {
    console.log(`  ${dir} not readable: ${(e as Error).message}`)
    return { advised, skipped, failed }
  }
  for (const name of entries) {
    if (!name.endsWith('.json')) continue
    if (name.startsWith('.')) continue
    const full = join(dir, name)
    try {
      if (!statSync(full).isFile()) continue
    } catch {
      continue
    }
    const r = processFile(full, isArchived)
    if (!r.ok) {
      failed++
      console.log(`  FAIL ${name}: ${r.reason}`)
    } else if (r.reason === 'already-advised') {
      skipped++
    } else {
      advised++
      console.log(`  advised ${name}`)
    }
  }
  return { advised, skipped, failed }
}

function main() {
  console.log('=== Active projects ===')
  const active = walkDir(PROJECTS_DIR, false)
  console.log(`  active: advised=${active.advised} skipped=${active.skipped} failed=${active.failed}`)

  console.log('=== Archived projects ===')
  const archived = walkDir(PROJECTS_ARCHIVE_DIR, true)
  console.log(`  archived: advised=${archived.advised} skipped=${archived.skipped} failed=${archived.failed}`)

  const total = active.advised + archived.advised
  console.log(`\nTotal advised: ${total}. Total skipped (idempotent rerun): ${active.skipped + archived.skipped}. Total failed: ${active.failed + archived.failed}.`)
}

main()
