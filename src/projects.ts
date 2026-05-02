/**
 * Project records — the persistent state for Mode 3 (project mode).
 *
 * A project is a long-running, multi-phase piece of work driven by a
 * dedicated Project Manager (PM) Claude instance. The PM reads and mutates
 * the project record to plan, dispatch workers, aggregate results, and
 * decide when the project is complete.
 *
 * Storage layout:
 *   state/projects/<id>.json             — active projects
 *   state/projects/archive/<id>.json     — completed/cancelled projects
 *
 * One file per project. Write-through (no in-memory cache) so concurrent
 * readers (CoS, PM, workers, operators) always see the latest state.
 * Writes are atomic via temp-file + rename.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  unlinkSync,
} from 'fs'
import { join } from 'path'
import { randomBytes, randomUUID } from 'crypto'
import { STATE_DIR } from './config.js'
import { writeJsonAtomic } from './atomicWrite.js'
import { readJsonTolerant } from './readJsonTolerant.js'
import { DEFAULT_ENTITY, type Entity, isEntity } from './entity.js'
import { logDispatcher } from './logger.js'

export const PROJECTS_DIR = join(STATE_DIR, 'projects')
export const PROJECTS_ARCHIVE_DIR = join(PROJECTS_DIR, 'archive')

mkdirSync(PROJECTS_DIR, { recursive: true })
mkdirSync(PROJECTS_ARCHIVE_DIR, { recursive: true })

export type ProjectStatus =
  | 'planning'     // PM has been kicked off, drafting the plan
  | 'running'      // workers active or about to be dispatched
  | 'blocked'      // PM flagged it needs input from Jeff
  | 'complete'     // all work done, results aggregated
  | 'cancelled'    // halted by operator before completion
  | 'failed'       // unrecoverable error

export type WorkerStatus = 'queued' | 'running' | 'complete' | 'failed'

export interface ProjectTask {
  id: string
  title: string
  brief: string
  /** IDs of tasks that must complete before this one can start. */
  dependsOn: string[]
  /** Suggested model for the worker — `sonnet` (default) or `opus`. */
  model?: 'sonnet' | 'opus' | 'haiku'
  /** Explicit tool allowlist for the worker, comma-separated. */
  allowedTools?: string
  status: WorkerStatus
  workerId?: string
  startedAt?: number
  completedAt?: number
  /** Absolute path of the worker's result file (written on completion). */
  resultPath?: string
  /** Short summary surfaced to the PM. Workers write this. */
  resultSummary?: string
  /** Error message if status = failed. */
  error?: string
}

export interface ProjectArtifact {
  taskId: string
  name: string
  path: string
  addedAt: number
}

/**
 * On-disk schema version for ProjectRecord. v1 had no `entity`,
 * `paperclipTaskIds`, `correlationId`, or `schemaVersion` fields. v2 (Phase
 * A.6) adds all four. v3 (Phase J.1a, Migration Plan §14.3.2) adds
 * `owningEA` — the partition the project belongs to (typically `'jeff'`
 * for Alex Morgan's projects, `'sarah'` for Quinn's projects). Readers
 * tolerate v1 and v2 via `normaliseProjectRecord` (defaulting `owningEA`
 * to `'jeff'`); the `scripts/backfill-project-descriptors.ts` migrates
 * older records on disk.
 */
export const PROJECT_SCHEMA_VERSION = 6 as const

/**
 * Default partition assignment for legacy / un-tagged projects. Pre-J.1a
 * the dispatcher served Alex Morgan only, so every prior project belongs
 * to Jeff's partition. Post-J.1a callers must pass `owningEA` explicitly
 * when the work is for Sarah's partition (or any future partition).
 */
export const DEFAULT_OWNING_EA = 'jeff' as const

export interface ProjectRecord {
  id: string
  name: string
  /** Original brief from Jeff that triggered project mode. */
  brief: string
  /** Discord thread ID where the PM posts status. */
  threadId: string | null
  /** Discord thread ID of the CoS conversation that spawned this project. */
  originThreadId: string
  status: ProjectStatus
  createdAt: number
  updatedAt: number
  /** Concurrency ceiling for parallel workers in this project. Default 3. */
  maxParallelWorkers: number
  /**
   * Ordered tasks. Execution order is determined by dependsOn — the PM is
   * responsible for identifying runnable tasks (all deps complete) and
   * dispatching them respecting maxParallelWorkers.
   */
  tasks: ProjectTask[]
  /** Collected output files (outbox paths) across all tasks. */
  artifacts: ProjectArtifact[]
  /** Final summary written by the PM at completion. */
  summary?: string
  /** Plain-text notes the PM appends as it works. Bounded to last 50. */
  log: Array<{ at: number; note: string }>
  /**
   * Entity that owns this project — `'cbs'` (CBS Group) or `'wr'` (WaterRoads).
   * Determines per-entity Drive routing (Phase A.5.1) and KB credential
   * scoping (Phase A.5.3) for any worker spawned against this project's
   * thread. Required from schemaVersion 2 onward.
   */
  entity: Entity
  /**
   * Paperclip task IDs linked to this project. Populated by the dispatcher
   * when project work is mirrored into Paperclip and by the PM when it
   * spawns or links Paperclip-tracked sub-tasks. Empty array if the project
   * has no Paperclip linkage.
   */
  paperclipTaskIds: string[]
  /**
   * Correlation ID for end-to-end audit reconstruction (Δ DA-013, OD-027 OPT
   * IN). Generated at project creation; propagated through dispatcher logs,
   * worker spawn env, outbox file headers, Drive metadata, and KB entries.
   * Phase A.11 wires the propagation; A.6 establishes the field.
   */
  correlationId: string
  /**
   * Owning EA partition (Migration Plan §14.3.2; architecture v2.1 §5.1).
   * Identifies which principal-keyed partition this project belongs to —
   * `'jeff'` for Alex Morgan's projects, `'sarah'` for Quinn's projects,
   * any other configured partition for future EAs. Drives per-EA trace
   * partitioning (`state/traces/<owningEA>/`), per-EA cost attribution
   * (OD-012a spawned-worker bucket), and is the source of truth for
   * cross-EA audit reconciliation. Defaults to `'jeff'` for legacy
   * descriptors via `normaliseProjectRecord`.
   */
  owningEA: string
  /**
   * Project Manager name allocated from the roster at
   * `config/pm-name-roster.json` (Option C — persistent named roster). The
   * PM signs Discord posts with this name so concurrent projects are
   * distinguishable. Optional on the record so legacy descriptors created
   * before schemaVersion 4 do not fail validation; the runtime allocates a
   * name lazily if missing. Reuse-after-completion is supported — audit
   * logs always carry the project ID alongside the name for unambiguous
   * historical reconstruction.
   */
  pmName?: string
  /**
   * PM-estimated total project cost in USD, set at planning time.
   * The PM proposes the estimate; the operator confirms (Discord interaction
   * gate); the value is stored here for the project's lifetime as the
   * baseline against which spend is compared. Optional on the record so
   * legacy descriptors created before schemaVersion 5 do not fail validation.
   * R-953 / R-945.
   */
  budgetEstimateUsd?: number
  /**
   * Operator-confirmed project ceiling in USD. The PM must manage to this
   * ceiling — if running spend approaches the ceiling, the PM alerts the
   * operator and stops further spend until the operator decides whether to
   * raise the ceiling, narrow scope, or end the project. Defaults to
   * `budgetEstimateUsd` if the operator confirms the estimate as the cap
   * (the common case). Optional. R-953 / R-945.
   */
  budgetCeilingUsd?: number
  /**
   * Running USD spend across all worker invocations and Paperclip-side
   * agent calls attributed to this project. Updated by the dispatcher when
   * worker `claude_done` events report a `cost` value. Read by the PM at
   * each turn so it can pace itself against the ceiling. Optional; legacy
   * descriptors and projects with no recorded spend yet read this as 0.
   * R-953 / R-944.
   */
  spendUsd?: number
  /**
   * Audit trail of Paperclip-side agent budget increases the PM has
   * requested or applied. Each entry: { ts, agentId, fromUsd, toUsd, reason }.
   * The PM may bump an agent's budget to clear a Paperclip-side cap that is
   * blocking the project — but only when the project ceiling is preserved
   * (the PM offsets the bump elsewhere within the project). The audit trail
   * lets the operator reconstruct who raised what when. Optional. R-953.
   */
  agentBudgetBumps?: Array<{
    ts: number
    agentId: string
    fromUsd: number
    toUsd: number
    reason: string
  }>
  /**
   * Drive folder URL for this project's auto-mirrored output (R-940 follow-
   * up; operator directive 2026-05-02). Populated at PM kickoff by
   * `ensureProjectDriveFolder` so the folder is visible in the entity Drive
   * even before the project produces its first output. PM reads this field
   * on every turn to know where outputs land. Optional — legacy descriptors
   * created before schemaVersion 6 do not fail validation; the field
   * populates on the next kickoff.
   */
  driveFolderUrl?: string
  driveFolderId?: string
  /** On-disk schema version. Current writers always set this to 6. */
  schemaVersion: number
}

// ──────────────────────────────────────────────────────────────────────
// Path helpers
// ──────────────────────────────────────────────────────────────────────

function safeId(id: string): string {
  if (!/^[a-z0-9-]+$/i.test(id)) {
    throw new Error(`Invalid project id: ${id}`)
  }
  return id
}

export function projectPath(id: string): string {
  return join(PROJECTS_DIR, `${safeId(id)}.json`)
}

export function archivedProjectPath(id: string): string {
  return join(PROJECTS_ARCHIVE_DIR, `${safeId(id)}.json`)
}

// ──────────────────────────────────────────────────────────────────────
// Atomic read/write
// ──────────────────────────────────────────────────────────────────────

function readProjectFile(path: string): ProjectRecord | null {
  const result = readJsonTolerant<ProjectRecord>(path, normaliseProjectRecord)
  if (result.reason === 'missing') return null
  if (!result.record) {
    logDispatcher('project_read_failed', {
      path,
      reason: result.reason,
      error: result.error ? String(result.error) : undefined,
    })
    return null
  }
  return result.record
}

/**
 * Version-tolerant reader (Δ DA-001, Phase A.6.5).
 *
 * Records written by the v1 codebase lack `entity`, `paperclipTaskIds`,
 * `correlationId`, and `schemaVersion`. Readers should not crash; they fill
 * in defaults so callers always see a v2-shaped record. Disk is untouched —
 * the backfill script (`scripts/backfill-project-descriptors.ts`) is the
 * only place that rewrites records to bump the on-disk version.
 *
 * Returns null if the input cannot be coerced (missing required v1 fields
 * such as `id`, `name`, or `tasks`); the caller logs and skips.
 */
export function normaliseProjectRecord(
  raw: Record<string, unknown>,
): ProjectRecord | null {
  if (typeof raw.id !== 'string' || typeof raw.name !== 'string') return null
  if (!Array.isArray(raw.tasks)) return null

  const entity = isEntity(raw.entity) ? raw.entity : DEFAULT_ENTITY
  const paperclipTaskIds = Array.isArray(raw.paperclipTaskIds)
    ? raw.paperclipTaskIds.filter((x): x is string => typeof x === 'string')
    : []
  const correlationId =
    typeof raw.correlationId === 'string' && raw.correlationId.length > 0
      ? raw.correlationId
      : `legacy-${raw.id}`
  const schemaVersion =
    typeof raw.schemaVersion === 'number' ? raw.schemaVersion : 1
  // v3 field: owningEA. Pre-J.1a descriptors fall back to 'jeff' since the
  // dispatcher served Alex Morgan only. Tolerantly accept the legacy alias
  // `eaOwner` if the descriptor was tagged ad-hoc by an older script.
  const owningEA =
    typeof raw.owningEA === 'string' && raw.owningEA.length > 0
      ? raw.owningEA
      : typeof (raw as { eaOwner?: unknown }).eaOwner === 'string' &&
          ((raw as { eaOwner: string }).eaOwner).length > 0
        ? (raw as { eaOwner: string }).eaOwner
        : DEFAULT_OWNING_EA
  // v4 field: pmName. Optional — legacy descriptors keep undefined until a
  // future allocation pass fills it in. The runtime tolerates undefined.
  const pmName = typeof raw.pmName === 'string' && raw.pmName.length > 0 ? raw.pmName : undefined
  // v5 fields: budget envelope (R-953 / R-945). All optional. Legacy
  // descriptors normalise without budgets — the PM running on a legacy
  // project must propose an estimate at the next planning turn.
  const budgetEstimateUsd = typeof raw.budgetEstimateUsd === 'number' ? raw.budgetEstimateUsd : undefined
  const budgetCeilingUsd = typeof raw.budgetCeilingUsd === 'number' ? raw.budgetCeilingUsd : undefined
  const spendUsd = typeof raw.spendUsd === 'number' ? raw.spendUsd : undefined
  const agentBudgetBumps = Array.isArray(raw.agentBudgetBumps)
    ? (raw.agentBudgetBumps as ProjectRecord['agentBudgetBumps'])
    : undefined
  // v6 fields: Drive folder URL + ID populated at PM kickoff. Optional.
  const driveFolderUrl = typeof raw.driveFolderUrl === 'string' && raw.driveFolderUrl.length > 0 ? raw.driveFolderUrl : undefined
  const driveFolderId = typeof raw.driveFolderId === 'string' && raw.driveFolderId.length > 0 ? raw.driveFolderId : undefined

  return {
    ...(raw as unknown as ProjectRecord),
    entity,
    paperclipTaskIds,
    correlationId,
    owningEA,
    pmName,
    budgetEstimateUsd,
    budgetCeilingUsd,
    spendUsd,
    agentBudgetBumps,
    driveFolderUrl,
    driveFolderId,
    schemaVersion,
  }
}

function writeProjectFile(path: string, record: ProjectRecord): void {
  // Was already atomic; consolidated onto the shared helper for the D-001
  // audit (Phase A.4).
  writeJsonAtomic(path, record)
}

// ──────────────────────────────────────────────────────────────────────
// Public API
// ──────────────────────────────────────────────────────────────────────

export function newProjectId(): string {
  // 8 hex chars — room for ~4B projects before collision risk matters.
  return `p-${randomBytes(4).toString('hex')}`
}

export function createProject(opts: {
  name: string
  brief: string
  originThreadId: string
  maxParallelWorkers?: number
  /** Entity that owns this project. Defaults to DEFAULT_ENTITY (cbs) per
   *  Phase A.5; callers in Phase H may pass an explicit entity once the
   *  channel-to-entity map exists. */
  entity?: Entity
  /** Owning EA partition. Defaults to DEFAULT_OWNING_EA ('jeff'). Phase
   *  J.1a (Migration Plan §14.3.2) re-tags legacy descriptors to 'jeff';
   *  Phase J.1b adds Quinn's partition. Future EAs pass an explicit
   *  partition name. */
  owningEA?: string
  /** Override allocator — tests pass a specific name. Production callers
   *  leave this undefined and rely on `allocatePMName` from the roster. */
  pmName?: string
}): ProjectRecord {
  const now = Date.now()
  const id = newProjectId()
  // Allocate a PM name from the roster (Option C — persistent named
  // roster, R-952 sibling). Imported lazily to avoid the projects → roster
  // → projects circular import (the roster reads project records to find
  // names in use).
  const allocator = opts.pmName
    ? { name: opts.pmName, fallback: false }
    : (() => {
        try {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const mod = require('./pmNameRoster.js') as typeof import('./pmNameRoster.js')
          return mod.allocatePMName({ projectId: id })
        } catch (err) {
          logDispatcher('pm_name_allocation_failed', {
            projectId: id,
            error: String(err),
          })
          return { name: `PM-${id.replace(/^p-/, '').slice(0, 8)}`, fallback: true }
        }
      })()
  const record: ProjectRecord = {
    id,
    name: opts.name.slice(0, 120),
    brief: opts.brief,
    threadId: null,
    originThreadId: opts.originThreadId,
    status: 'planning',
    createdAt: now,
    updatedAt: now,
    maxParallelWorkers: opts.maxParallelWorkers ?? 3,
    tasks: [],
    artifacts: [],
    log: [{ at: now, note: `Project created. PM: ${allocator.name}` }],
    entity: opts.entity ?? DEFAULT_ENTITY,
    paperclipTaskIds: [],
    correlationId: randomUUID(),
    owningEA: opts.owningEA ?? DEFAULT_OWNING_EA,
    pmName: allocator.name,
    schemaVersion: PROJECT_SCHEMA_VERSION,
  }
  writeProjectFile(projectPath(record.id), record)
  logDispatcher('project_created', {
    id: record.id,
    name: record.name,
    entity: record.entity,
    owningEA: record.owningEA,
    pmName: record.pmName,
    correlationId: record.correlationId,
  })
  return record
}

export function getProject(id: string): ProjectRecord | null {
  return readProjectFile(projectPath(id))
}

export function getArchivedProject(id: string): ProjectRecord | null {
  return readProjectFile(archivedProjectPath(id))
}

/**
 * Update a project via a mutator function. The mutator is called with a
 * fresh read of the record and must return it mutated. Writes are atomic.
 * Throws if the project doesn't exist — callers should check first.
 */
export function updateProject(
  id: string,
  mutator: (r: ProjectRecord) => ProjectRecord,
): ProjectRecord {
  const path = projectPath(id)
  const current = readProjectFile(path)
  if (!current) throw new Error(`Project not found: ${id}`)
  const updated = mutator(current)
  updated.updatedAt = Date.now()
  // Trim log to last 50 entries to prevent unbounded growth.
  if (updated.log.length > 50) {
    updated.log = updated.log.slice(-50)
  }
  writeProjectFile(path, updated)
  return updated
}

export function appendProjectLog(id: string, note: string): void {
  try {
    updateProject(id, (r) => {
      r.log.push({ at: Date.now(), note: note.slice(0, 500) })
      return r
    })
  } catch (err) {
    logDispatcher('project_log_append_failed', { id, error: String(err) })
  }
}

/**
 * Increment the project's running USD spend total. Called when a worker
 * `claude_done` event reports a `cost` value attributable to this project.
 * No-op if the project does not exist (race against archive) or if cost is
 * non-positive (Claude returns null for stale-cache hits).
 *
 * R-953 / R-944: gives the PM a running view of project spend so it can
 * pace itself against the operator-confirmed `budgetCeilingUsd`.
 */
export function addProjectSpend(id: string, costUsd: number): void {
  if (!Number.isFinite(costUsd) || costUsd <= 0) return
  try {
    updateProject(id, (r) => {
      r.spendUsd = (r.spendUsd ?? 0) + costUsd
      return r
    })
    logDispatcher('project_spend_increment', { id, addedUsd: costUsd })
  } catch (err) {
    logDispatcher('project_spend_increment_failed', { id, error: String(err) })
  }
}

export function listActiveProjects(): ProjectRecord[] {
  const out: ProjectRecord[] = []
  try {
    for (const name of readdirSync(PROJECTS_DIR)) {
      if (!name.endsWith('.json') || name.startsWith('.')) continue
      const full = join(PROJECTS_DIR, name)
      const record = readProjectFile(full)
      if (record) out.push(record)
    }
  } catch (err) {
    logDispatcher('project_list_failed', { error: String(err) })
  }
  return out
}

export function listRunnableTasks(record: ProjectRecord): ProjectTask[] {
  const doneIds = new Set(
    record.tasks.filter((t) => t.status === 'complete').map((t) => t.id),
  )
  return record.tasks.filter(
    (t) => t.status === 'queued' && t.dependsOn.every((d) => doneIds.has(d)),
  )
}

export function countRunningTasks(record: ProjectRecord): number {
  return record.tasks.filter((t) => t.status === 'running').length
}

/**
 * Archive a project — move the file to the archive directory and stamp
 * a terminal status. Idempotent: if already archived, returns the archived
 * record without error.
 */
export function archiveProject(id: string, finalStatus: ProjectStatus): ProjectRecord | null {
  const active = projectPath(id)
  const archived = archivedProjectPath(id)

  if (!existsSync(active)) {
    // Maybe it's already archived.
    return readProjectFile(archived)
  }

  const record = readProjectFile(active)
  if (!record) return null

  record.status = finalStatus
  record.updatedAt = Date.now()
  record.log.push({ at: Date.now(), note: `Archived with status: ${finalStatus}` })
  if (record.log.length > 50) record.log = record.log.slice(-50)

  writeProjectFile(archived, record)
  try {
    unlinkSync(active)
  } catch {
    // If delete fails, we'd have both files — prefer the archived one.
  }
  logDispatcher('project_archived', { id, finalStatus })
  return record
}
