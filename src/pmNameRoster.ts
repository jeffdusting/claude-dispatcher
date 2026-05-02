/**
 * Project Manager naming roster (Option C — persistent named roster).
 *
 * When the dispatcher creates a Mode-3 project, it allocates the next
 * available name from the roster at `config/pm-name-roster.json`. The name
 * is stored on the project record and travels through to the PM worker via
 * the `CLAUDE_PM_NAME` env var so the PM signs Discord posts with the name.
 *
 * Allocation algorithm:
 *
 *   1. Load the roster (~100 names, gender-balanced, multicultural Australia).
 *   2. List active projects — anything not in {complete, failed, cancelled}.
 *   3. Walk the roster in order; return the first name not held by an active
 *      project.
 *   4. If every name is in use (>= 100 concurrent active projects), fall back
 *      to a deterministic synthetic name `PM-<projectId-suffix>` so the
 *      project still gets a stable identity. Should never happen in practice.
 *
 * Names freed when a project completes are immediately reusable. Audit logs
 * always carry the project ID alongside the name so reuse-after-retirement
 * is unambiguous (`Felix on p-690de71c` vs `Felix on p-173549a3`).
 */

import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { z } from 'zod'
import { DISPATCHER_DIR } from './config.js'
import { PROJECTS_DIR, normaliseProjectRecord, type ProjectRecord } from './projects.js'
import { logDispatcher } from './logger.js'

export const PMRosterSchema = z.object({
  schemaVersion: z.literal(1),
  description: z.string().optional(),
  updatedAt: z.string().optional(),
  notes: z.array(z.string()).optional(),
  roster: z.array(z.string().min(1)).min(1),
})

export type PMRoster = z.infer<typeof PMRosterSchema>

let cached: PMRoster | null = null

export function getPMRosterPath(): string {
  return process.env.PM_ROSTER_CONFIG_PATH || join(DISPATCHER_DIR, 'config', 'pm-name-roster.json')
}

export function loadPMRoster(): PMRoster {
  if (cached) return cached
  const path = getPMRosterPath()
  const raw = readFileSync(path, 'utf8')
  const parsed = JSON.parse(raw)
  cached = PMRosterSchema.parse(parsed)
  return cached
}

/** Test-only — clear the in-memory roster cache. */
export function _resetPMRosterCacheForTests(): void {
  cached = null
}

/** Project statuses that count as "active" for name-occupancy purposes. */
const ACTIVE_STATUSES = new Set(['planning', 'running', 'blocked'])

/**
 * Enumerate names currently held by active projects. Reads the projects
 * directory (fast — typically <50 records). Skips legacy descriptors that
 * have no pmName field (those projects predate the roster and are
 * harmless — their thread is the project ID, no name allocated).
 */
export function namesInUse(projectsDir: string = PROJECTS_DIR): Set<string> {
  const inUse = new Set<string>()
  let entries: string[]
  try {
    entries = readdirSync(projectsDir)
  } catch {
    return inUse
  }
  for (const name of entries) {
    if (!name.endsWith('.json')) continue
    try {
      const raw = readFileSync(join(projectsDir, name), 'utf8')
      const parsed = JSON.parse(raw) as Record<string, unknown>
      const record = normaliseProjectRecord(parsed)
      if (!record) continue
      if (!ACTIVE_STATUSES.has(record.status)) continue
      const pmName = (parsed.pmName ?? record.pmName) as string | undefined
      if (typeof pmName === 'string' && pmName.length > 0) inUse.add(pmName)
    } catch {
      // Corrupt records are skipped — the namesInUse view is best-effort.
    }
  }
  return inUse
}

export interface AllocateResult {
  name: string
  fallback: boolean
}

/**
 * Allocate the next available name from the roster.
 *
 * Walks the roster in order; returns the first name not held by an active
 * project. Falls back to `PM-<projectId-suffix>` if every name is in use.
 */
export function allocatePMName(opts: { projectId: string; projectsDir?: string }): AllocateResult {
  const roster = loadPMRoster()
  const inUse = namesInUse(opts.projectsDir)
  for (const candidate of roster.roster) {
    if (!inUse.has(candidate)) {
      logDispatcher('pm_name_allocated', {
        projectId: opts.projectId,
        pmName: candidate,
        rosterSize: roster.roster.length,
        inUseCount: inUse.size,
      })
      return { name: candidate, fallback: false }
    }
  }
  // Every name in use — synthesise a stable identifier from the project ID
  // suffix. This should not occur in practice (>= 100 concurrent active
  // projects) but the fallback keeps the project workable rather than failing
  // creation.
  const suffix = opts.projectId.replace(/^p-/, '').slice(0, 8)
  const fallback = `PM-${suffix}`
  logDispatcher('pm_name_fallback', {
    projectId: opts.projectId,
    pmName: fallback,
    rosterSize: roster.roster.length,
    inUseCount: inUse.size,
    reason: 'all roster names in use by active projects',
  })
  return { name: fallback, fallback: true }
}
