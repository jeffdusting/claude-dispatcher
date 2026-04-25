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
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  unlinkSync,
} from 'fs'
import { join } from 'path'
import { STATE_DIR } from './config.js'
import { logDispatcher } from './logger.js'

export const KICKOFF_INBOX_DIR = join(STATE_DIR, 'project-kickoff-inbox')
mkdirSync(KICKOFF_INBOX_DIR, { recursive: true })

export interface KickoffRequest {
  projectId: string
  originThreadId: string
  projectThreadId: string
  kickoffPrompt: string
  createdAt: string
}

function kickoffPath(projectId: string): string {
  if (!/^p-[a-z0-9]+$/.test(projectId)) {
    throw new Error(`Invalid projectId: ${projectId}`)
  }
  return join(KICKOFF_INBOX_DIR, `${projectId}.json`)
}

/** Drop a kickoff request for the dispatcher to pick up. */
export function dropKickoffRequest(req: KickoffRequest): string {
  const path = kickoffPath(req.projectId)
  writeFileSync(path, JSON.stringify(req, null, 2))
  logDispatcher('kickoff_requested', {
    projectId: req.projectId,
    projectThreadId: req.projectThreadId,
  })
  return path
}

/** Read and consume (delete) all pending kickoff requests. */
export function drainKickoffRequests(): KickoffRequest[] {
  const requests: KickoffRequest[] = []
  try {
    for (const name of readdirSync(KICKOFF_INBOX_DIR)) {
      if (!name.endsWith('.json')) continue
      const full = join(KICKOFF_INBOX_DIR, name)
      try {
        const raw = readFileSync(full, 'utf8')
        const parsed = JSON.parse(raw) as KickoffRequest
        // Validate minimally before consuming.
        if (
          typeof parsed.projectId === 'string' &&
          typeof parsed.originThreadId === 'string' &&
          typeof parsed.projectThreadId === 'string' &&
          typeof parsed.kickoffPrompt === 'string'
        ) {
          requests.push(parsed)
        } else {
          logDispatcher('kickoff_invalid_schema', { file: name })
        }
      } catch (err) {
        logDispatcher('kickoff_read_failed', { file: name, error: String(err) })
      }
      // Delete regardless — malformed files shouldn't loop.
      try {
        unlinkSync(full)
      } catch {}
    }
  } catch (err) {
    logDispatcher('kickoff_drain_failed', { error: String(err) })
  }
  return requests
}

export function hasPendingKickoff(projectId: string): boolean {
  return existsSync(kickoffPath(projectId))
}
