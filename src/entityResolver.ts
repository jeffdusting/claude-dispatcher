/**
 * Per-thread entity resolution (Phase A.6.6, channel-map fallback Phase H).
 *
 * Lives in its own file to keep entity.ts free of cycles — entity.ts is
 * imported widely (drive.ts, claude.ts, gateway.ts) and pulling projects
 * into it would create a tangled graph. Callers that need the resolver
 * import from here directly.
 *
 * Resolution order:
 *   1. Thread → projectId (threadSessions.ts)
 *   2. projectId → ProjectRecord.entity (projects.ts)
 *   3. Channel-to-entity map (Phase H) — for threads not bound to a project,
 *      consult the static map keyed by Discord channel ID. For top-level
 *      channels the threadId is the channelId; for nested project threads
 *      step 2 already resolves them, so step 3 is reached only when a
 *      thread has no project descriptor (ad-hoc CoS turns).
 *   4. Fallback: DEFAULT_ENTITY (CBS)
 */

import { DEFAULT_ENTITY, type Entity } from './entity.js'
import { getThreadRecord } from './threadSessions.js'
import { getProject } from './projects.js'
import { resolveEntityForChannel } from './channelEntityMap.js'

export function resolveEntityForThread(threadId: string): Entity {
  try {
    const tr = getThreadRecord(threadId)
    if (tr?.projectId) {
      const project = getProject(tr.projectId)
      if (project) return project.entity
    }
    const fromChannel = resolveEntityForChannel(threadId)
    if (fromChannel) return fromChannel
    return DEFAULT_ENTITY
  } catch {
    return DEFAULT_ENTITY
  }
}
