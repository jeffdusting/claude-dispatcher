/**
 * Outbox manifest (Phase A.5.2, Δ DA-007).
 *
 * Records the Drive-upload status of each file written to outbox/ so a
 * purge step can safely delete locally-aged files that have been preserved
 * in Drive. The manifest is the single source of truth for "what is safe
 * to purge" — files without a confirmed manifest entry are kept on disk
 * regardless of age.
 *
 * Storage: `<OUTBOX_DIR>/.outbox-manifest.json` (hidden file). Atomic
 * writes via writeJsonAtomic from the D-001 audit (Phase A.4).
 *
 * Schema: see ManifestEntry below. `version` lets later phases evolve the
 * shape without breaking older readers (Δ DA-001 — version-tolerant readers).
 *
 * Concurrency: a single dispatcher writes; multiple readers are tolerated.
 * The `recordUpload`-style functions read-modify-write under atomic rename,
 * so two concurrent uploads of different files do not lose entries.
 */

import { existsSync, readFileSync, statSync } from 'fs'
import { join } from 'path'
import { OUTBOX_DIR } from './config.js'
import { writeJsonAtomic } from './atomicWrite.js'
import { logDispatcher } from './logger.js'
import type { Entity } from './entity.js'

export const MANIFEST_PATH = join(OUTBOX_DIR, '.outbox-manifest.json')

const MANIFEST_VERSION = 1

export interface ManifestEntry {
  /** Path relative to OUTBOX_DIR. */
  path: string
  /** Entity that owned the upload. */
  entity: Entity
  /** Drive file ID assigned at upload. */
  driveFileId: string
  /** Drive web view link returned at upload. */
  webViewLink: string
  /** ISO-8601 of the successful upload. */
  uploadedAt: string
  /** Local file size in bytes at upload time. */
  size: number
  /** Local mtime in ms at upload time — used to detect post-upload changes. */
  mtimeMs: number
}

export interface Manifest {
  version: number
  entries: Record<string, ManifestEntry>
}

function emptyManifest(): Manifest {
  return { version: MANIFEST_VERSION, entries: {} }
}

export function readManifest(): Manifest {
  if (!existsSync(MANIFEST_PATH)) return emptyManifest()
  try {
    const parsed = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as Manifest
    if (typeof parsed !== 'object' || !parsed) return emptyManifest()
    if (typeof parsed.version !== 'number') parsed.version = MANIFEST_VERSION
    if (!parsed.entries || typeof parsed.entries !== 'object') parsed.entries = {}
    return parsed
  } catch (err) {
    logDispatcher('outbox_manifest_read_failed', { error: String(err).slice(0, 200) })
    return emptyManifest()
  }
}

function writeManifest(m: Manifest): void {
  writeJsonAtomic(MANIFEST_PATH, m)
}

/**
 * Record a successful Drive upload in the manifest. Idempotent: re-recording
 * the same path overwrites the entry, which is the right behaviour when the
 * same outbox file is uploaded again after edits.
 */
export function recordUpload(opts: {
  relativePath: string
  absolutePath: string
  entity: Entity
  driveFileId: string
  webViewLink: string
}): void {
  let size = 0
  let mtimeMs = 0
  try {
    const st = statSync(opts.absolutePath)
    size = st.size
    mtimeMs = st.mtimeMs
  } catch {
    // File deleted between upload and manifest record; entry still useful.
  }

  const m = readManifest()
  m.entries[opts.relativePath] = {
    path: opts.relativePath,
    entity: opts.entity,
    driveFileId: opts.driveFileId,
    webViewLink: opts.webViewLink,
    uploadedAt: new Date().toISOString(),
    size,
    mtimeMs,
  }
  writeManifest(m)
}

/**
 * Remove an entry from the manifest (e.g. when the local file is purged).
 * No-op if the entry is absent.
 */
export function forgetEntry(relativePath: string): void {
  const m = readManifest()
  if (!(relativePath in m.entries)) return
  delete m.entries[relativePath]
  writeManifest(m)
}

/**
 * Lookup helper for diagnostics.
 */
export function getEntry(relativePath: string): ManifestEntry | null {
  const m = readManifest()
  return m.entries[relativePath] ?? null
}
