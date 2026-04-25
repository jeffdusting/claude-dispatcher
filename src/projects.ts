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
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
  mkdirSync,
  readdirSync,
  unlinkSync,
} from 'fs'
import { join } from 'path'
import { randomBytes } from 'crypto'
import { STATE_DIR } from './config.js'
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
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as ProjectRecord
  } catch (err) {
    logDispatcher('project_read_failed', { path, error: String(err) })
    return null
  }
}

function writeProjectFile(path: string, record: ProjectRecord): void {
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(record, null, 2))
  renameSync(tmp, path)
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
  }
  writeProjectFile(projectPath(record.id), record)
  logDispatcher('project_created', { id: record.id, name: record.name })
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
