/**
 * Per-thread entity resolution (Phase A.6.6).
 *
 * Lives in its own file to keep entity.ts free of cycles — entity.ts is
 * imported widely (drive.ts, claude.ts, gateway.ts) and pulling projects
 * into it would create a tangled graph. Callers that need the resolver
 * import from here directly.
 *
 * Resolution order:
 *   1. Thread → projectId (threadSessions.ts)
 *   2. projectId → ProjectRecord.entity (projects.ts)
 *   3. Fallback: DEFAULT_ENTITY (CBS)
 *
 * Phase H may insert a channel-to-entity map between steps 2 and 3 so
 * threads not associated with a project still resolve correctly.
 */

import { DEFAULT_ENTITY, type Entity } from './entity.js'
import { getThreadRecord } from './threadSessions.js'
import { getProject } from './projects.js'

export function resolveEntityForThread(threadId: string): Entity {
  try {
    const tr = getThreadRecord(threadId)
    if (!tr?.projectId) return DEFAULT_ENTITY
    const project = getProject(tr.projectId)
    return project?.entity ?? DEFAULT_ENTITY
  } catch {
    return DEFAULT_ENTITY
  }
}
