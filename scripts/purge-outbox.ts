#!/usr/bin/env bun
/**
 * Purge outbox files older than the retention threshold (default 7 days),
 * gated on the file being recorded as Drive-uploaded in the outbox manifest.
 *
 * Migration Plan §4.5.2 (Δ DA-007).
 *
 * Default safety: a file is purged ONLY if all of:
 *   - it has a manifest entry (was uploaded to Drive)
 *   - the manifest's `uploadedAt` is older than the retention threshold
 *   - the local file's mtime matches the manifest's mtimeMs (no edits since
 *     upload — otherwise the local copy is the newer source of truth)
 *
 * Files without a manifest entry are kept. Files edited after upload are
 * kept until re-uploaded. The manifest is the gate; nothing else is.
 *
 * Flags:
 *   --days N      Override retention threshold (default 7).
 *   --dry-run     Print what would be purged without deleting.
 *   --verbose     Per-file decision output.
 *
 * Exit codes:
 *   0 — completed (with or without deletions)
 *   1 — fatal error (manifest unreadable, OUTBOX_DIR missing)
 */

import { existsSync, statSync, unlinkSync } from 'fs'
import { join } from 'path'
import { OUTBOX_DIR } from '../src/config.js'
import { forgetEntry, readManifest } from '../src/outboxManifest.js'

interface Options {
  days: number
  dryRun: boolean
  verbose: boolean
}

function parseArgs(argv: string[]): Options {
  const opts: Options = { days: 7, dryRun: false, verbose: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dry-run') opts.dryRun = true
    else if (a === '--verbose' || a === '-v') opts.verbose = true
    else if (a === '--days') {
      const next = argv[++i]
      if (!next) throw new Error('--days requires a value')
      opts.days = Number(next)
      if (!Number.isFinite(opts.days) || opts.days < 0) {
        throw new Error(`Invalid --days value: ${next}`)
      }
    } else if (a === '--help' || a === '-h') {
      printHelp()
      process.exit(0)
    } else {
      throw new Error(`Unknown arg: ${a}`)
    }
  }
  return opts
}

function printHelp(): void {
  console.log(`Usage: bun scripts/purge-outbox.ts [--days N] [--dry-run] [--verbose]

Purges outbox/ files older than --days (default 7) that are confirmed
Drive-uploaded in the outbox manifest. Files without a manifest entry,
or with mtime newer than the manifest record, are kept.

Examples:
  bun scripts/purge-outbox.ts --dry-run
  bun scripts/purge-outbox.ts --days 14 --verbose
`)
}

function main(): number {
  let opts: Options
  try {
    opts = parseArgs(process.argv.slice(2))
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`)
    printHelp()
    return 1
  }

  if (!existsSync(OUTBOX_DIR)) {
    console.error(`OUTBOX_DIR does not exist: ${OUTBOX_DIR}`)
    return 1
  }

  const manifest = readManifest()
  const now = Date.now()
  const cutoffMs = now - opts.days * 24 * 60 * 60 * 1000

  let kept = 0
  let purged = 0
  let stale = 0
  let missingFile = 0
  let edited = 0

  for (const [rel, entry] of Object.entries(manifest.entries)) {
    const abs = join(OUTBOX_DIR, rel)
    const uploadedMs = Date.parse(entry.uploadedAt)

    if (!Number.isFinite(uploadedMs)) {
      if (opts.verbose) console.log(`SKIP unparseable uploadedAt: ${rel}`)
      kept++
      continue
    }

    if (uploadedMs >= cutoffMs) {
      if (opts.verbose) {
        const ageDays = ((now - uploadedMs) / 86_400_000).toFixed(1)
        console.log(`KEEP ${rel} — uploaded ${ageDays}d ago, under threshold`)
      }
      kept++
      continue
    }

    if (!existsSync(abs)) {
      if (opts.verbose) console.log(`PRUNE-MANIFEST ${rel} — local file gone`)
      if (!opts.dryRun) forgetEntry(rel)
      missingFile++
      continue
    }

    const st = statSync(abs)
    if (st.mtimeMs > entry.mtimeMs + 1000) {
      if (opts.verbose) console.log(`KEEP ${rel} — edited after upload`)
      edited++
      continue
    }

    if (opts.dryRun) {
      console.log(`WOULD PURGE ${rel} (uploaded ${entry.uploadedAt})`)
    } else {
      try {
        unlinkSync(abs)
        forgetEntry(rel)
        purged++
        if (opts.verbose) console.log(`PURGED ${rel}`)
      } catch (err) {
        console.error(`Failed to purge ${rel}: ${(err as Error).message}`)
        stale++
      }
    }
  }

  console.log(
    `Done. purged=${purged} kept=${kept} edited=${edited} missing=${missingFile} errors=${stale} (dry-run=${opts.dryRun})`,
  )
  return 0
}

process.exit(main())
