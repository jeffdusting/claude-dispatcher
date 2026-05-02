/**
 * Per-EA graduation config (R-952 part 3).
 *
 * Names which lanes the EA may auto-send for. Default `autonomousLanes: []`
 * preserves drafts-only operation — every Alex/Quinn outbound is a draft until
 * the operator explicitly graduates a lane.
 *
 * The graduation decision flow at send time:
 *
 *   1. Look up the draft's `lane` tag (set at draft-creation by the gmail
 *      helper).
 *   2. If the always-approval overlay forces approval for this counterparty,
 *      abort — the draft is principal-approval-only regardless.
 *   3. If the lane is in `autonomousLanes`, send and audit-log. Otherwise
 *      abort — the lane is not graduated.
 *
 * Per-EA: Alex's `autonomousLanes` is independent from Quinn's. Each EA
 * graduates their own categories at their own pace.
 */

import { readFileSync } from 'fs'
import { z } from 'zod'
import type { Lane, Principal } from './types.js'

export const GraduationConfigSchema = z.object({
  schemaVersion: z.literal(1),
  principal: z.string(),
  description: z.string().optional(),
  updatedAt: z.string().optional(),
  /**
   * Lanes the EA may auto-send for. EMPTY by default → drafts-only.
   * Adding a lane here is a deliberate operator decision per R-952. Even when
   * a lane is graduated, the always-approval overlay may still force approval
   * for specific counterparties.
   */
  autonomousLanes: z.array(z.enum(['autonomous', 'approval', 'principal_only'])).default([]),
  notes: z.array(z.string()).optional(),
  history: z
    .array(
      z.object({
        action: z.enum(['add', 'remove']),
        lane: z.enum(['autonomous', 'approval', 'principal_only']),
        addedAt: z.string().optional(),
        addedNote: z.string().optional(),
      }),
    )
    .optional(),
})

export type GraduationConfig = z.infer<typeof GraduationConfigSchema>

/** Decision returned by `canAutoSend`. */
export interface AutoSendDecision {
  allowed: boolean
  reason: string
}

/**
 * Decide whether a draft tagged with `lane` may auto-send under this config.
 *
 * The always-approval overlay must be applied separately by the caller — it
 * may force approval for the specific counterparty even if the lane has
 * graduated. This function only decides the lane-level question.
 */
export function canAutoSend(lane: Lane, config: GraduationConfig): AutoSendDecision {
  if (config.autonomousLanes.includes(lane)) {
    return { allowed: true, reason: `lane '${lane}' is graduated for principal '${config.principal}'` }
  }
  return {
    allowed: false,
    reason: `lane '${lane}' is not graduated for principal '${config.principal}' — drafts-only`,
  }
}

export function loadGraduationConfig(path: string): GraduationConfig {
  const raw = readFileSync(path, 'utf8')
  const parsed = JSON.parse(raw)
  return GraduationConfigSchema.parse(parsed)
}

export function graduationConfigPath(dispatcherDir: string, principal: Principal): string {
  return `${dispatcherDir}/config/graduation-${principal}.json`
}
