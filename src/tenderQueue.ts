/**
 * Tender queue — file-drop protocol for tender-classified kickoffs.
 *
 * Mirrors `kickoffInbox.ts` but writes to `state/tender-queue/` and
 * carries additional fields the tender handler needs to route the work
 * to the correct agent. The schema is a strict superset of the kickoff
 * request: a tender request can always be downgraded to a kickoff
 * request (drop the tender-specific fields) if the handler decides the
 * classification was wrong.
 *
 * Why a separate queue? Three reasons:
 *   1. Audit clarity — operators can see at a glance how many opportunities
 *      are waiting versus how many internal projects are.
 *   2. Independent backpressure — tender review tends to be heavier and
 *      the dispatcher may want to gate it on a separate concurrency
 *      budget (deferred — same gate as kickoffs for now).
 *   3. Easier post-hoc inspection — the tender-queue/ files form a
 *      simple receipt that an opportunity was seen and where it went,
 *      which is useful for the eventual Stage 1 Paperclip-as-source
 *      project board.
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

export const TENDER_QUEUE_DIR = join(STATE_DIR, 'tender-queue')
export const TENDER_REJECTED_DIR = join(TENDER_QUEUE_DIR, '.rejected')
mkdirSync(TENDER_QUEUE_DIR, { recursive: true })
mkdirSync(TENDER_REJECTED_DIR, { recursive: true })

/**
 * Schema for a tender-queue request file.
 *
 * `recommendedAgent` is `office-management` or `tender-review`; the
 * handler resolves the actual agent identifier from its registry. We
 * keep this as an opaque tag rather than hard-coding agent IDs so the
 * dispatcher and the agent platform can evolve independently.
 */
export const TenderRequestSchema = z.object({
  projectId: z.string().regex(/^p-[a-z0-9]+$/, 'projectId must match p-<lowercase-hex>'),
  originThreadId: z.string().min(1),
  projectThreadId: z.string().min(1),
  kickoffPrompt: z.string().min(1),
  createdAt: z.string().min(1),
  entity: z.enum(['cbs', 'wr']),
  recommendedAgent: z.enum(['office-management', 'tender-review']),
  signals: z.array(z.string()),
})

export type TenderRequest = z.infer<typeof TenderRequestSchema>

function tenderPath(projectId: string): string {
  if (!/^p-[a-z0-9]+$/.test(projectId)) {
    throw new Error(`Invalid projectId: ${projectId}`)
  }
  return join(TENDER_QUEUE_DIR, `${projectId}.json`)
}

/**
 * Drop a tender request for the dispatcher's tender cycle to pick up.
 * Validates against the schema at the source — a bad drop is a
 * programmer bug, so the failure raises rather than silently quarantining.
 */
export function dropTenderRequest(req: TenderRequest): string {
  const validated = TenderRequestSchema.parse(req)
  const path = tenderPath(validated.projectId)
  writeJsonAtomic(path, validated)
  logDispatcher('tender_queued', {
    projectId: validated.projectId,
    projectThreadId: validated.projectThreadId,
    entity: validated.entity,
    recommendedAgent: validated.recommendedAgent,
    signals: validated.signals,
  })
  return path
}

function quarantine(name: string, srcPath: string, reason: string): void {
  const dest = join(TENDER_REJECTED_DIR, `${Date.now()}-${name}`)
  try {
    renameSync(srcPath, dest)
    logDispatcher('tender_quarantined', { file: name, dest, reason })
  } catch (err) {
    logDispatcher('tender_quarantine_failed', {
      file: name,
      reason,
      error: String(err),
    })
    try { unlinkSync(srcPath) } catch {}
  }
}

/**
 * Read and consume all pending tender requests.
 *
 * Valid requests are returned and their files removed. Invalid requests
 * are moved to `.rejected/` so an operator can inspect them later.
 */
export function drainTenderRequests(): TenderRequest[] {
  const requests: TenderRequest[] = []
  try {
    for (const name of readdirSync(TENDER_QUEUE_DIR)) {
      if (!name.endsWith('.json')) continue
      if (name.startsWith('.')) continue

      const full = join(TENDER_QUEUE_DIR, name)
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

      const result = TenderRequestSchema.safeParse(parsed)
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
    logDispatcher('tender_drain_failed', { error: String(err) })
  }
  return requests
}

export function hasPendingTender(projectId: string): boolean {
  return existsSync(tenderPath(projectId))
}
