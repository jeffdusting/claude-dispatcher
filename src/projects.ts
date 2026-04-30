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
export const PROJECT_SCHEMA_VERSION = 3 as const

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
  /** On-disk schema version. Current writers always set this to 3. */
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

  return {
    ...(raw as unknown as ProjectRecord),
    entity,
    paperclipTaskIds,
    correlationId,
    owningEA,
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
}): ProjectRecord {
  const now = Date.now()
  const record: ProjectRecord = {
    id: newProjectId(),
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
    log: [{ at: now, note: 'Project created.' }],
    entity: opts.entity ?? DEFAULT_ENTITY,
    paperclipTaskIds: [],
    correlationId: randomUUID(),
    owningEA: opts.owningEA ?? DEFAULT_OWNING_EA,
    schemaVersion: PROJECT_SCHEMA_VERSION,
  }
  writeProjectFile(projectPath(record.id), record)
  logDispatcher('project_created', {
    id: record.id,
    name: record.name,
    entity: record.entity,
    owningEA: record.owningEA,
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
