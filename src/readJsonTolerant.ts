/**
 * Version-tolerant JSON readers (Δ DA-001, Phase A.6.5).
 *
 * State files evolve over time — Phase A.6 added v2 fields to the project
 * descriptor; future phases will version sessions, threadSessions, health,
 * and the rest in turn. Readers must tolerate older versions without
 * crashing so a partly-migrated dispatcher state still boots.
 *
 * The pattern this helper captures:
 *   1. Read the file.
 *   2. JSON.parse it.
 *   3. Hand the raw object to a per-file `normaliser` that fills in
 *      defaults for missing v2 fields and returns a typed record (or
 *      null if the input cannot be coerced).
 *   4. Log and return null on any failure rather than throwing — readers
 *      are routinely called from `listActiveProjects()`-style scans where
 *      one bad file should not abort the loop.
 *
 * Disk is untouched. The companion backfill scripts are responsible for
 * rewriting on-disk records to the latest version.
 */

import { existsSync, readFileSync } from 'fs'

export type Normaliser<T> = (raw: Record<string, unknown>) => T | null

export interface ReadJsonTolerantResult<T> {
  record: T | null
  /** Reason the read returned null. Useful for callers that want to log or
   *  count failures without re-implementing the read pipeline. */
  reason?: 'missing' | 'parse_failed' | 'normalise_failed'
  error?: unknown
}

/**
 * Read and parse a JSON file, returning the normalised record or null
 * with a structured reason when the file is missing, malformed, or
 * fails normalisation. Pure — never throws, never writes.
 */
export function readJsonTolerant<T>(
  path: string,
  normaliser: Normaliser<T>,
): ReadJsonTolerantResult<T> {
  if (!existsSync(path)) {
    return { record: null, reason: 'missing' }
  }
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    return { record: null, reason: 'parse_failed', error: err }
  }
  if (typeof raw !== 'object' || raw === null) {
    return { record: null, reason: 'normalise_failed' }
  }
  const record = normaliser(raw as Record<string, unknown>)
  if (!record) {
    return { record: null, reason: 'normalise_failed' }
  }
  return { record }
}
