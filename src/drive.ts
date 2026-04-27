/**
 * Google Drive mirror for outbox files — multi-account routing (Phase A.5.1).
 *
 * Each entity (CBS, WR) has its own service account and its own root folder.
 * The dispatcher selects the credential pair at upload time based on the
 * caller's entity context. Per-entity client and folder caches are kept
 * separate so a CBS upload never accidentally lands in a WR folder.
 *
 * Auth: per-entity service account JSON key. Each SA's email must be granted
 * Editor permission on the entity's root folder. Missing key file or
 * missing folder ID → uploads silently skipped for that entity.
 *
 * Cross-entity audit (Δ DA-013, OD-027 OPT IN): when a worker's entity
 * (from CLAUDE_ENTITY) differs from the upload entity, a structured audit
 * event `cross_entity_drive_access` is logged. Phase A.11 wires correlation
 * IDs into the event for end-to-end reconstruction.
 *
 * Outbox manifest (Δ DA-007): every successful upload writes an entry to
 * the manifest at OUTBOX_DIR/.outbox-manifest.json so the purge step can
 * safely delete locally-aged files that are confirmed in Drive.
 */

import { readFileSync, statSync, createReadStream, readdirSync } from 'fs'
import { relative as pathRelative, join } from 'path'
import { google, type drive_v3 } from 'googleapis'
import {
  CBS_DRIVE_FOLDER_ID,
  CBS_DRIVE_SA_KEY_PATH,
  OUTBOX_DIR,
  WR_DRIVE_FOLDER_ID,
  WR_DRIVE_SA_KEY_PATH,
} from './config.js'
import {
  type Entity,
  crossEntityAuditEnabled,
  resolveEntity,
} from './entity.js'
import { recordUpload } from './outboxManifest.js'
import { withUpstream, CircuitOpenError } from './circuitBreaker.js'
import { logDispatcher } from './logger.js'
import { getCorrelationId } from './correlationContext.js'

export interface DriveUploadResult {
  name: string
  webViewLink: string
}

interface EntityDriveConfig {
  saKeyPath: string
  folderId: string | null
}

const ENTITY_CONFIG: Record<Entity, EntityDriveConfig> = {
  cbs: { saKeyPath: CBS_DRIVE_SA_KEY_PATH, folderId: CBS_DRIVE_FOLDER_ID },
  wr: { saKeyPath: WR_DRIVE_SA_KEY_PATH, folderId: WR_DRIVE_FOLDER_ID },
}

const cachedClients = new Map<Entity, drive_v3.Drive>()
// `${entity}:${threadId}` -> folderId
const threadFolderCache = new Map<string, string>()
// `${entity}:${parentId}/${childName}` -> childFolderId
const subfolderCache = new Map<string, string>()

function entityKey(entity: Entity, key: string): string {
  return `${entity}:${key}`
}

export function driveEnabled(entity: Entity): boolean {
  const cfg = ENTITY_CONFIG[entity]
  if (!cfg.folderId) return false
  try {
    statSync(cfg.saKeyPath)
    return true
  } catch {
    return false
  }
}

/**
 * Test-friendly accessor for the per-entity Drive routing config. Exposes
 * the tuple of (saKeyPath, folderId) so tests can assert that CBS and WR
 * resolve to distinct paths and that DISPATCHER_TEST_MODE leaves both
 * unconfigured. Production callers should not depend on this surface.
 */
export function _getEntityDriveConfigForTesting(
  entity: Entity,
): { saKeyPath: string; folderId: string | null } {
  const cfg = ENTITY_CONFIG[entity]
  return { saKeyPath: cfg.saKeyPath, folderId: cfg.folderId }
}

function getClient(entity: Entity): drive_v3.Drive | null {
  if (!driveEnabled(entity)) return null
  const cached = cachedClients.get(entity)
  if (cached) return cached

  const cfg = ENTITY_CONFIG[entity]
  try {
    const key = JSON.parse(readFileSync(cfg.saKeyPath, 'utf8'))
    const auth = new google.auth.JWT({
      email: key.client_email,
      key: key.private_key,
      scopes: ['https://www.googleapis.com/auth/drive.file'],
    })
    const client = google.drive({ version: 'v3', auth })
    cachedClients.set(entity, client)
    return client
  } catch (err) {
    logDispatcher('drive_auth_failed', {
      entity,
      error: String(err).slice(0, 200),
    })
    return null
  }
}

/**
 * Audit a Drive access whose entity differs from the worker's entity (set
 * by the dispatcher at spawn time via CLAUDE_ENTITY). Phase A.11 will fold
 * a correlation ID into the event so cross-entity reconstruction is
 * end-to-end.
 */
function auditCrossEntityAccess(opts: {
  entity: Entity
  threadId: string
  context: string
}): void {
  if (!crossEntityAuditEnabled()) return
  const workerEntity = resolveEntity(process.env.CLAUDE_ENTITY)
  if (workerEntity === opts.entity) return
  logDispatcher('cross_entity_drive_access', {
    workerEntity,
    accessEntity: opts.entity,
    threadId: opts.threadId,
    context: opts.context,
  })
}

async function findOrCreateFolder(
  entity: Entity,
  drive: drive_v3.Drive,
  name: string,
  parentId: string,
): Promise<string> {
  const cacheKey = entityKey(entity, `${parentId}/${name}`)
  const cached = subfolderCache.get(cacheKey)
  if (cached) return cached

  const q = `name='${name.replace(/'/g, "\\'")}' and '${parentId}' in parents ` +
    `and mimeType='application/vnd.google-apps.folder' and trashed=false`
  const res = await withUpstream('drive', () => drive.files.list({
    q,
    fields: 'files(id,name)',
    pageSize: 1,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  }), { operation: 'files.list' })
  if (res.data.files && res.data.files.length > 0) {
    const id = res.data.files[0]!.id!
    subfolderCache.set(cacheKey, id)
    return id
  }

  const created = await withUpstream('drive', () => drive.files.create({
    requestBody: {
      name,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentId],
    },
    fields: 'id',
    supportsAllDrives: true,
  }), { operation: 'files.create.folder' })
  const id = created.data.id!
  subfolderCache.set(cacheKey, id)
  return id
}

async function makeAnyoneLinkReadable(
  drive: drive_v3.Drive,
  fileId: string,
): Promise<void> {
  try {
    await withUpstream('drive', () => drive.permissions.create({
      fileId,
      requestBody: { role: 'reader', type: 'anyone' },
      sendNotificationEmail: false,
      supportsAllDrives: true,
    }), { operation: 'permissions.create' })
  } catch (err) {
    if (err instanceof CircuitOpenError) {
      logDispatcher('drive_share_breaker_open', {
        fileId, retryAfterMs: err.retryAfterMs,
      })
      return
    }
    logDispatcher('drive_share_noop', {
      fileId, error: String(err).slice(0, 150),
    })
  }
}

async function getThreadFolder(
  entity: Entity,
  drive: drive_v3.Drive,
  threadId: string,
  threadTitle: string | null,
): Promise<string> {
  const cacheKey = entityKey(entity, threadId)
  const cached = threadFolderCache.get(cacheKey)
  if (cached) return cached

  const cfg = ENTITY_CONFIG[entity]
  const parentId = cfg.folderId!
  const name = sanitizeFolderName(threadTitle ?? threadId)
  const subKey = entityKey(entity, `${parentId}/${name}`)
  const existing = subfolderCache.get(subKey)
  if (existing) {
    threadFolderCache.set(cacheKey, existing)
    return existing
  }

  const folderId = await findOrCreateFolder(entity, drive, name, parentId)
  await makeAnyoneLinkReadable(drive, folderId)
  threadFolderCache.set(cacheKey, folderId)
  return folderId
}

export async function renameThreadFolder(
  threadId: string,
  newTitle: string,
  entity: Entity,
): Promise<{ renamed: boolean; folderId?: string }> {
  const drive = getClient(entity)
  if (!drive) return { renamed: false }

  const folderId = threadFolderCache.get(entityKey(entity, threadId))
  if (!folderId) return { renamed: false }

  const newName = sanitizeFolderName(newTitle)
  try {
    await withUpstream('drive', () => drive.files.update({
      fileId: folderId,
      requestBody: { name: newName },
      supportsAllDrives: true,
    }), { operation: 'files.update.rename' })
    const cfg = ENTITY_CONFIG[entity]
    const parentId = cfg.folderId!
    for (const [k, v] of subfolderCache.entries()) {
      if (v === folderId && k.startsWith(`${entity}:`)) subfolderCache.delete(k)
    }
    subfolderCache.set(entityKey(entity, `${parentId}/${newName}`), folderId)
    logDispatcher('drive_thread_folder_renamed', {
      entity, threadId, folderId, newName,
    })
    return { renamed: true, folderId }
  } catch (err) {
    logDispatcher('drive_thread_folder_rename_failed', {
      entity, threadId, folderId, error: String(err).slice(0, 200),
    })
    return { renamed: false, folderId }
  }
}

function sanitizeFolderName(name: string): string {
  return name.replace(/[\r\n\t]/g, ' ').trim().slice(0, 120) || 'unnamed-thread'
}

function guessMimeType(path: string): string {
  const lower = path.toLowerCase()
  if (lower.endsWith('.md')) return 'text/markdown'
  if (lower.endsWith('.txt')) return 'text/plain'
  if (lower.endsWith('.json')) return 'application/json'
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'text/html'
  if (lower.endsWith('.pdf')) return 'application/pdf'
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  if (lower.endsWith('.gif')) return 'image/gif'
  if (lower.endsWith('.svg')) return 'image/svg+xml'
  if (lower.endsWith('.csv')) return 'text/csv'
  if (lower.endsWith('.docx')) {
    return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  }
  if (lower.endsWith('.xlsx')) {
    return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  }
  if (lower.endsWith('.zip')) return 'application/zip'
  return 'application/octet-stream'
}

async function uploadOne(
  drive: drive_v3.Drive,
  localPath: string,
  remoteName: string,
  parentId: string,
): Promise<{ id: string; result: DriveUploadResult } | null> {
  // Phase A.11 (Δ DA-013, OD-027): stamp the active correlation ID into
  // Drive file appProperties so an artefact is linkable back through the
  // chain without a sidecar file. Drive's appProperties are restricted to
  // the application that wrote them (the entity's service account here),
  // which is exactly the access pattern the audit tool wants.
  const correlationId = getCorrelationId()
  const appProperties = correlationId ? { correlationId } : undefined
  try {
    // The retry helper re-invokes `fn` on transient failure. Each attempt
    // needs its own read stream — the body is consumed on attempt 1, so
    // attempt 2 must reopen the file. Hence the stream construction inside
    // the closure rather than once outside.
    const res = await withUpstream('drive', () => drive.files.create({
      requestBody: {
        name: remoteName,
        parents: [parentId],
        ...(appProperties ? { appProperties } : {}),
      },
      media: {
        mimeType: guessMimeType(localPath),
        body: createReadStream(localPath),
      },
      fields: 'id,name,webViewLink',
      supportsAllDrives: true,
    }), { operation: 'files.create.upload' })
    return {
      id: res.data.id ?? '',
      result: {
        name: res.data.name ?? remoteName,
        webViewLink: res.data.webViewLink ?? '',
      },
    }
  } catch (err) {
    if (err instanceof CircuitOpenError) {
      logDispatcher('drive_upload_breaker_open', {
        path: localPath, retryAfterMs: err.retryAfterMs,
      })
      return null
    }
    logDispatcher('drive_upload_failed', {
      path: localPath,
      error: String(err).slice(0, 300),
    })
    return null
  }
}

function walkDir(rootAbs: string, relativeToParent: string = ''): Array<[string, string]> {
  const out: Array<[string, string]> = []
  let entries: string[]
  try {
    entries = readdirSync(rootAbs)
  } catch {
    return out
  }
  for (const name of entries) {
    const abs = join(rootAbs, name)
    const rel = relativeToParent ? join(relativeToParent, name) : name
    let st
    try {
      st = statSync(abs)
    } catch {
      continue
    }
    if (st.isDirectory()) {
      out.push(...walkDir(abs, rel))
    } else if (st.isFile()) {
      out.push([abs, rel])
    }
  }
  return out
}

export interface UploadInput {
  /** Absolute path on local disk. */
  path: string
  /** Display name (may be a simple filename, or the outbox-relative path for subdirectory items). */
  name: string
}

/**
 * Upload outbox items to Drive under the entity's thread-specific subfolder.
 * Returns successful upload results. Records every success in the outbox
 * manifest. Audits cross-entity access if the worker's entity differs.
 */
export async function uploadOutboxFiles(
  items: UploadInput[],
  threadId: string,
  threadTitle: string | null,
  entity: Entity,
): Promise<DriveUploadResult[]> {
  const drive = getClient(entity)
  if (!drive) return []
  if (items.length === 0) return []

  auditCrossEntityAccess({ entity, threadId, context: 'uploadOutboxFiles' })

  let threadFolderId: string
  try {
    threadFolderId = await getThreadFolder(entity, drive, threadId, threadTitle)
  } catch (err) {
    logDispatcher('drive_thread_folder_failed', {
      entity, threadId, error: String(err).slice(0, 200),
    })
    return []
  }

  const results: DriveUploadResult[] = []

  for (const item of items) {
    let st
    try {
      st = statSync(item.path)
    } catch {
      continue
    }

    if (st.isDirectory()) {
      const files = walkDir(item.path)
      for (const [abs, rel] of files) {
        const parts = rel.split('/').filter(Boolean)
        const fileName = parts.pop()!
        let currentParent = threadFolderId
        const folderParts = [item.name, ...parts]
        for (const segment of folderParts) {
          try {
            currentParent = await findOrCreateFolder(entity, drive, segment, currentParent)
          } catch (err) {
            logDispatcher('drive_folder_create_failed', {
              entity, segment, error: String(err).slice(0, 200),
            })
            currentParent = ''
            break
          }
        }
        if (!currentParent) continue
        const uploaded = await uploadOne(drive, abs, fileName, currentParent)
        if (uploaded) {
          results.push(uploaded.result)
          recordUpload({
            relativePath: pathRelative(OUTBOX_DIR, abs),
            absolutePath: abs,
            entity,
            driveFileId: uploaded.id,
            webViewLink: uploaded.result.webViewLink,
          })
        }
      }
    } else if (st.isFile()) {
      const uploaded = await uploadOne(drive, item.path, item.name, threadFolderId)
      if (uploaded) {
        results.push(uploaded.result)
        recordUpload({
          relativePath: pathRelative(OUTBOX_DIR, item.path),
          absolutePath: item.path,
          entity,
          driveFileId: uploaded.id,
          webViewLink: uploaded.result.webViewLink,
        })
      }
    }
  }

  logDispatcher('drive_upload_batch', {
    entity,
    threadId,
    count: results.length,
    requested: items.length,
  })
  return results
}

export function formatUploadSummary(
  results: DriveUploadResult[],
  threadFolderUrl: string | null,
): string {
  if (results.length === 0) return ''
  if (results.length === 1) {
    return `📁 Also saved to Drive: <${results[0]!.webViewLink}>`
  }
  if (threadFolderUrl) {
    return `📁 Also saved to Drive (${results.length} files): <${threadFolderUrl}>`
  }
  const links = results
    .slice(0, 3)
    .map((r) => `<${r.webViewLink}>`)
    .join(', ')
  const extra = results.length > 3 ? ` (+${results.length - 3} more)` : ''
  return `📁 Also saved to Drive: ${links}${extra}`
}

export function folderUrl(folderId: string): string {
  return `https://drive.google.com/drive/folders/${folderId}`
}

export async function getThreadFolderUrl(
  threadId: string,
  threadTitle: string | null,
  entity: Entity,
): Promise<string | null> {
  const drive = getClient(entity)
  if (!drive) return null
  try {
    const id = await getThreadFolder(entity, drive, threadId, threadTitle)
    return folderUrl(id)
  } catch {
    return null
  }
}

export function isDriveEnabled(entity: Entity): boolean {
  return driveEnabled(entity)
}

export async function uploadAndSummarise(
  items: UploadInput[],
  threadId: string,
  threadTitle: string | null,
  entity: Entity,
): Promise<{ summary: string; results: DriveUploadResult[] }> {
  const results = await uploadOutboxFiles(items, threadId, threadTitle, entity)
  if (results.length === 0) {
    return { summary: '', results: [] }
  }
  const threadFolderUrl = await getThreadFolderUrl(threadId, threadTitle, entity)
  return {
    summary: formatUploadSummary(results, threadFolderUrl),
    results,
  }
}
