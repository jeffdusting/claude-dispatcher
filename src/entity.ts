/**
 * Entity context — CBS Group vs WaterRoads.
 *
 * Phase A.5 introduces explicit entity routing for Drive uploads, KB
 * credential scoping, and the cross-entity audit flag. The actual binding
 * of an entity to a project descriptor lands in Phase A.6 (schema
 * consolidation); until then, callers default to `'cbs'` because all
 * current dispatcher traffic is Jeff's CBS Group work. WR traffic routes
 * via separate contractors today.
 *
 * This module is the single place to extend when:
 *   - Phase A.6 adds `entity` to ProjectRecord — update `entityForProject()`.
 *   - Phase H assigns Discord channels to entities — update `entityForChannel()`.
 *
 * The audit flag is operator-opted-in via OD-027 (Decisions Applied §3A).
 */

export type Entity = 'cbs' | 'wr'

export const DEFAULT_ENTITY: Entity = 'cbs'

export const ENTITIES: readonly Entity[] = ['cbs', 'wr'] as const

export function isEntity(s: unknown): s is Entity {
  return s === 'cbs' || s === 'wr'
}

/**
 * Resolve entity from an explicit value, falling back to the default.
 * Use this at any call site that may pass through unvalidated input.
 */
export function resolveEntity(value: string | null | undefined): Entity {
  return isEntity(value) ? value : DEFAULT_ENTITY
}

/**
 * Names of the Supabase env vars per entity, used for credential scoping.
 * The dispatcher's worker spawn loads exactly one pair into the worker's
 * environment based on entity context (Migration Plan §4.5.3).
 */
export const SUPABASE_ENV_NAMES: Record<Entity, { url: string; serviceRoleKey: string }> = {
  cbs: {
    url: 'CBS_SUPABASE_URL',
    serviceRoleKey: 'CBS_SUPABASE_SERVICE_ROLE_KEY',
  },
  wr: {
    url: 'WR_SUPABASE_URL',
    serviceRoleKey: 'WR_SUPABASE_SERVICE_ROLE_KEY',
  },
}

/**
 * The complete set of Supabase env-var names across all entities. Used by
 * the worker-spawn env scoper to drop the cross-entity variables from the
 * child process environment before exec.
 */
export const ALL_SUPABASE_ENV_NAMES: readonly string[] = Object.values(SUPABASE_ENV_NAMES)
  .flatMap((v) => [v.url, v.serviceRoleKey])

/**
 * Cross-entity audit flag (Δ DA-013, OD-027 OPT IN).
 *
 * When set, the dispatcher logs structured audit events for cross-entity
 * accesses (e.g. a CBS worker uploading to a WR Drive folder, or a WR
 * worker reading from a CBS Drive folder). The flag defaults to ON because
 * OD-027 opted in; it can be force-disabled via env for diagnostics.
 *
 * Phase A.11 wires correlation IDs into the audit event so cross-entity
 * activity can be reconstructed end-to-end. Until then, the event records
 * the entity pair and the contextual identifiers available at the call
 * site (threadId, projectId).
 */
export function crossEntityAuditEnabled(): boolean {
  const v = process.env.CROSS_ENTITY_AUDIT_ENABLED
  if (v === undefined || v === '') return true
  return v === '1' || v.toLowerCase() === 'true'
}
