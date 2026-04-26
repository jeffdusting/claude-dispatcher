/**
 * Project kickoff inbox — file-drop protocol for starting a Mode-3 project.
 *
 * The CoS drops a request file describing the project; the dispatcher's
 * watcher picks it up, creates the Discord thread, registers it with the
 * project-manager agent override, and kicks off the first PM turn.
 *
 * Why file-drop instead of a direct call? The CoS runs as a short-lived
 * `claude -p` child of the dispatcher. Running the full PM spin-up inline
 * would tie up the CoS's turn while the PM plans, losing tempo. Dropping
 * a request lets the CoS return to Jeff immediately while the dispatcher
 * stands up the project in the background.
 *
 * Request schema (state/project-kickoff-inbox/<projectId>.json):
 *   {
 *     "projectId": "p-abc12345",
 *     "originThreadId": "1234...",
 *     "projectThreadId": "5678...",    // already created by the CoS
 *     "kickoffPrompt": "…",
 *     "createdAt": "2026-04-22T12:00:00Z"
 *   }
 */

import {
  readFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  unlinkSync,
} from 'fs'
import { join } from 'path'
import { z } from 'zod'
import { STATE_DIR } from './config.js'
import { writeJsonAtomic } from './atomicWrite.js'
import { logDispatcher } from './logger.js'

export const KICKOFF_INBOX_DIR = join(STATE_DIR, 'project-kickoff-inbox')
export const KICKOFF_REJECTED_DIR = join(KICKOFF_INBOX_DIR, '.rejected')
mkdirSync(KICKOFF_INBOX_DIR, { recursive: true })
mkdirSync(KICKOFF_REJECTED_DIR, { recursive: true })

/**
 * Schema for a kickoff request file (Phase A.6.2, Δ D-013).
 *
 * `projectId` matches the format newProjectId() emits (`p-<8-hex>`); the
 * pattern is enforced here so a malformed value is quarantined rather than
 * silently dropped. `kickoffPrompt` requires non-empty text — an empty
 * prompt would spawn a worker with nothing to do.
 */
export const KickoffRequestSchema = z.object({
  projectId: z.string().regex(/^p-[a-z0-9]+$/, 'projectId must match p-<lowercase-hex>'),
  originThreadId: z.string().min(1),
  projectThreadId: z.string().min(1),
  kickoffPrompt: z.string().min(1),
  createdAt: z.string().min(1),
})

export type KickoffRequest = z.infer<typeof KickoffRequestSchema>

function kickoffPath(projectId: string): string {
  if (!/^p-[a-z0-9]+$/.test(projectId)) {
    throw new Error(`Invalid projectId: ${projectId}`)
  }
  return join(KICKOFF_INBOX_DIR, `${projectId}.json`)
}

/**
 * Drop a kickoff request for the dispatcher to pick up.
 *
 * Validates against the schema at the source — a bad drop is a programmer
 * bug rather than runtime input, so the failure raises rather than
 * silently quarantining.
 */
export function dropKickoffRequest(req: KickoffRequest): string {
  const validated = KickoffRequestSchema.parse(req)
  const path = kickoffPath(validated.projectId)
  // Atomic write per D-001 audit (Phase A.4) — kickoff requests are
  // consumed by drainKickoffRequests; partial writes would leave the inbox
  // with an unparseable file the drainer would loop on.
  writeJsonAtomic(path, validated)
  logDispatcher('kickoff_requested', {
    projectId: validated.projectId,
    projectThreadId: validated.projectThreadId,
  })
  return path
}

/**
 * Quarantine a malformed kickoff request file. Moves it to `.rejected/`
 * with a timestamp suffix so collisions across drain cycles don't clobber
 * earlier rejects, then logs the decision so the operator can audit.
 */
function quarantine(name: string, srcPath: string, reason: string): void {
  const dest = join(
    KICKOFF_REJECTED_DIR,
    `${Date.now()}-${name}`,
  )
  try {
    renameSync(srcPath, dest)
    logDispatcher('kickoff_quarantined', { file: name, dest, reason })
  } catch (err) {
    logDispatcher('kickoff_quarantine_failed', {
      file: name,
      reason,
      error: String(err),
    })
    // Best-effort fallback: delete so the drainer doesn't loop on it. The
    // quarantine log line above carries the reason so the file's loss is
    // not silent.
    try { unlinkSync(srcPath) } catch {}
  }
}

/**
 * Read and consume all pending kickoff requests.
 *
 * Valid requests are returned and their files removed. Invalid requests
 * (parse failure or schema rejection) are moved to `.rejected/` per Phase
 * A.6.2 so the operator can inspect them later — keeping evidence beats
 * silent deletion.
 */
export function drainKickoffRequests(): KickoffRequest[] {
  const requests: KickoffRequest[] = []
  try {
    for (const name of readdirSync(KICKOFF_INBOX_DIR)) {
      if (!name.endsWith('.json')) continue
      // Skip the rejected dir if readdir surfaced it as a name (it shouldn't
      // — the dir starts with '.', so the .endsWith('.json') check above
      // already excludes it; defensive guard).
      if (name.startsWith('.')) continue

      const full = join(KICKOFF_INBOX_DIR, name)
      let raw: string
      try {
        raw = readFileSync(full, 'utf8')
      } catch (err) {
        quarantine(name, full, `read_failed: ${String(err).slice(0, 100)}`)
        continue
      }

      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch (err) {
        quarantine(name, full, `json_parse_failed: ${String(err).slice(0, 100)}`)
        continue
      }

      const result = KickoffRequestSchema.safeParse(parsed)
      if (!result.success) {
        quarantine(
          name,
          full,
          `schema_invalid: ${result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ').slice(0, 200)}`,
        )
        continue
      }

      requests.push(result.data)
      try { unlinkSync(full) } catch {}
    }
  } catch (err) {
    logDispatcher('kickoff_drain_failed', { error: String(err) })
  }
  return requests
}

export function hasPendingKickoff(projectId: string): boolean {
  return existsSync(kickoffPath(projectId))
}
