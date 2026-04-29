/**
 * Channel-to-entity map (Phase H Deliverable 3).
 *
 * Static mapping from Discord channel IDs to the entity context the channel
 * represents. Channels with deterministic entity ownership map to `'cbs'` or
 * `'wr'`; cross-entity channels (e.g. `jad-pa`) and platform channels (e.g.
 * `riveragents`, `general`) are deliberately absent — kickoffs originating
 * from them fall through to the existing project-descriptor default.
 *
 * The map is a static file shipped with the source, not a runtime mutation
 * surface. Cadence of change is governed by PR review and deploy. The
 * source-of-truth document for the mapping is
 * `docs/discord-channel-taxonomy.md` in the river-migration repository
 * (Phase H Deliverable 2).
 *
 * Usage:
 *   - `kickoff-project.ts` consults the map after resolving the origin
 *     thread's parent channel and before calling `createProject`, so the
 *     project descriptor's `entity` field is set deterministically for
 *     entity-bearing channels.
 *   - `entityResolver.resolveEntityForThread` consults the map as a
 *     fallback after the project-descriptor lookup misses, so ad-hoc CoS
 *     turns in entity-bearing channels resolve correctly.
 */

import type { Entity } from './entity.js'

export const CHANNEL_ENTITY_MAP: Readonly<Record<string, Entity>> = Object.freeze({
  // WaterRoads
  '1495962797329219584': 'wr', // waterroads
  '1497129990192627802': 'wr', // wrei
  '1495962505879486584': 'wr', // sjt-pa
  // CBS Group
  '1497133030559715338': 'cbs', // bridge-repair-white-paper
  '1495962402934751382': 'cbs', // project-leo
  // jad-pa (1495962464616059051), riveragents (1495629402908921876),
  // general (1495618035174735894) — no entry; cross-entity / platform.
})

export function resolveEntityForChannel(channelId: string | null | undefined): Entity | null {
  if (!channelId) return null
  return CHANNEL_ENTITY_MAP[channelId] ?? null
}
