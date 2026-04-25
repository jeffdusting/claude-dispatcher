/**
 * Google Drive mirror for outbox files.
 *
 * When configured, every file written to outbox/ during a session is also
 * uploaded to a dedicated Drive folder, organised by Discord thread.
 * Returns shareable links that the gateway appends to the Discord message,
 * so Jeff can access output from any device.
 *
 * Auth: service account JSON key. The SA email must be granted Editor
 * permission on DRIVE_FOLDER_ID (root folder in Jeff's Drive).
 *
 * Config:
 *   DRIVE_FOLDER_ID      (~/claude-workspace/generic/.secrets/google-drive.env)
 *   DRIVE_SA_KEY_PATH    (~/claude-workspace/generic/.secrets/google-drive-sa.json)
 *
 * If either is missing, uploads are silently skipped — the rest of the
 * dispatcher keeps working unchanged.
 */

import { readFileSync, statSync, createReadStream, readdirSync } from 'fs'
import { join, relative } from 'path'
import { google, type drive_v3 } from 'googleapis'
import { DRIVE_FOLDER_ID, DRIVE_SA_KEY_PATH, OUTBOX_DIR } from './config.js'
import { logDispatcher } from './logger.js'

export interface DriveUploadResult {
  name: string
  webViewLink: string
}

let cachedClient: drive_v3.Drive | null = null
// threadId -> folderId cache, so repeated uploads from the same thread
// all land in the same subfolder without re-querying Drive.
const threadFolderCache = new Map<string, string>()
// parentId/childName -> childFolderId for subdirectory trees.
const subfolderCache = new Map<string, string>()

function driveEnabled(): boolean {
  if (!DRIVE_FOLDER_ID) return false
  try {
    statSync(DRIVE_SA_KEY_PATH)
    return true
  } catch {
    return false
  }
}

function getClient(): drive_v3.Drive | null {
  if (!driveEnabled()) return null
  if (cachedClient) return cachedClient

  try {
    const key = JSON.parse(readFileSync(DRIVE_SA_KEY_PATH, 'utf8'))
    const auth = new google.auth.JWT({
      email: key.client_email,
      key: key.private_key,
      scopes: ['https://www.googleapis.com/auth/drive.file'],
    })
    cachedClient = google.drive({ version: 'v3', auth })
    return cachedClient
  } catch (err) {
    logDispatcher('drive_auth_failed', { error: String(err).slice(0, 200) })
    return null
  }
}

async function findOrCreateFolder(
  drive: drive_v3.Drive,
  name: string,
  parentId: string,
): Promise<string> {
  const cacheKey = `${parentId}/${name}`
  const cached = subfolderCache.get(cacheKey)
  if (cached) return cached

  // Search first
  const q = `name='${name.replace(/'/g, "\\'")}' and '${parentId}' in parents ` +
    `and mimeType='application/vnd.google-apps.folder' and trashed=false`
  const res = await drive.files.list({
    q,
    fields: 'files(id,name)',
    pageSize: 1,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  })
  if (res.data.files && res.data.files.length > 0) {
    const id = res.data.files[0]!.id!
    subfolderCache.set(cacheKey, id)
    return id
  }

  // Create if not found
  const created = await drive.files.create({
    requestBody: {
      name,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentId],
    },
    fields: 'id',
    supportsAllDrives: true,
  })
  const id = created.data.id!
  subfolderCache.set(cacheKey, id)
  return id
}

/**
 * Ensure a file/folder has "anyone with the link can view" sharing.
 * Idempotent: safe to call repeatedly; Drive returns the existing permission
 * if one already matches (or a 4xx we silently ignore).
 */
async function makeAnyoneLinkReadable(
  drive: drive_v3.Drive,
  fileId: string,
): Promise<void> {
  try {
    await drive.permissions.create({
      fileId,
      requestBody: { role: 'reader', type: 'anyone' },
      sendNotificationEmail: false,
      supportsAllDrives: true,
    })
  } catch (err) {
    // Already-shared folders often return a 400 or no-op; don't fail the upload.
    logDispatcher('drive_share_noop', {
      fileId, error: String(err).slice(0, 150),
    })
  }
}

/**
 * Get (or create) the Drive folder for a specific Discord thread.
 * Uses threadTitle as the folder name, falling back to the thread ID.
 * Newly created folders are set to "anyone with link can view" so Jeff
 * can share them outside the dispatcher without extra clicks.
 */
async function getThreadFolder(
  drive: drive_v3.Drive,
  threadId: string,
  threadTitle: string | null,
): Promise<string> {
  const cached = threadFolderCache.get(threadId)
  if (cached) return cached

  const name = sanitizeFolderName(threadTitle ?? threadId)
  // Check if a folder with this name already exists (e.g. from a previous
  // dispatcher run with no in-memory cache). If not, create & link-share.
  const parentId = DRIVE_FOLDER_ID!
  const cacheKey = `${parentId}/${name}`
  const existing = subfolderCache.get(cacheKey)
  if (existing) {
    threadFolderCache.set(threadId, existing)
    return existing
  }

  const folderId = await findOrCreateFolder(drive, name, parentId)
  // Set link-sharing on every thread folder we see; the helper no-ops if the
  // permission is already present.
  await makeAnyoneLinkReadable(drive, folderId)
  threadFolderCache.set(threadId, folderId)
  return folderId
}

/**
 * Rename the Drive folder for a given thread when the Discord thread is
 * renamed. Silently no-ops if:
 *   - Drive mirror isn't configured
 *   - We have no cached folder for this thread (e.g. no files ever uploaded)
 *   - The rename call fails (logged)
 *
 * Because thread folders are discovered lazily by name, we ALSO refresh the
 * subfolderCache so the next upload routes to the renamed folder rather than
 * creating a duplicate under the new name.
 */
export async function renameThreadFolder(
  threadId: string,
  newTitle: string,
): Promise<{ renamed: boolean; folderId?: string }> {
  const drive = getClient()
  if (!drive) return { renamed: false }

  const folderId = threadFolderCache.get(threadId)
  if (!folderId) {
    // No folder created yet for this thread; nothing to rename. Future uploads
    // will create one under the new name.
    return { renamed: false }
  }

  const newName = sanitizeFolderName(newTitle)
  try {
    await drive.files.update({
      fileId: folderId,
      requestBody: { name: newName },
      supportsAllDrives: true,
    })
    // Update the subfolder cache: invalidate the old `parentId/oldName` entry
    // (we don't know the old name without tracking it — just clear any entry
    // pointing to this folderId) and set the new `parentId/newName` entry.
    const parentId = DRIVE_FOLDER_ID!
    for (const [k, v] of subfolderCache.entries()) {
      if (v === folderId) subfolderCache.delete(k)
    }
    subfolderCache.set(`${parentId}/${newName}`, folderId)
    logDispatcher('drive_thread_folder_renamed', { threadId, folderId, newName })
    return { renamed: true, folderId }
  } catch (err) {
    logDispatcher('drive_thread_folder_rename_failed', {
      threadId, folderId, error: String(err).slice(0, 200),
    })
    return { renamed: false, folderId }
  }
}

function sanitizeFolderName(name: string): string {
  // Drive allows most characters in names, but keep this clean for UI legibility.
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
): Promise<DriveUploadResult | null> {
  try {
    const res = await drive.files.create({
      requestBody: {
        name: remoteName,
        parents: [parentId],
      },
      media: {
        mimeType: guessMimeType(localPath),
        body: createReadStream(localPath),
      },
      fields: 'id,name,webViewLink',
      supportsAllDrives: true,
    })
    return {
      name: res.data.name ?? remoteName,
      webViewLink: res.data.webViewLink ?? '',
    }
  } catch (err) {
    logDispatcher('drive_upload_failed', {
      path: localPath,
      error: String(err).slice(0, 300),
    })
    return null
  }
}

/**
 * Recursively collect all files under a directory, returning
 * [absolutePath, pathRelativeToRoot] pairs.
 */
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
 * Upload the given outbox items to Drive, under a thread-specific subfolder.
 *
 * - Regular files upload directly.
 * - Directories are walked; their contents upload into a mirrored subfolder tree.
 * - Silently returns [] if Drive is not configured or auth fails.
 */
export async function uploadOutboxFiles(
  items: UploadInput[],
  threadId: string,
  threadTitle: string | null,
): Promise<DriveUploadResult[]> {
  const drive = getClient()
  if (!drive) return []
  if (items.length === 0) return []

  let threadFolderId: string
  try {
    threadFolderId = await getThreadFolder(drive, threadId, threadTitle)
  } catch (err) {
    logDispatcher('drive_thread_folder_failed', {
      threadId, error: String(err).slice(0, 200),
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
      // Walk the directory; upload each file into a mirrored subfolder tree.
      const files = walkDir(item.path)
      for (const [abs, rel] of files) {
        const parts = rel.split('/').filter(Boolean)
        const fileName = parts.pop()!
        // Build subfolder path under threadFolderId: <item.name>/<subpath>
        let currentParent = threadFolderId
        const folderParts = [item.name, ...parts]
        for (const segment of folderParts) {
          try {
            currentParent = await findOrCreateFolder(drive, segment, currentParent)
          } catch (err) {
            logDispatcher('drive_folder_create_failed', {
              segment, error: String(err).slice(0, 200),
            })
            currentParent = ''
            break
          }
        }
        if (!currentParent) continue
        const uploaded = await uploadOne(drive, abs, fileName, currentParent)
        if (uploaded) results.push(uploaded)
      }
    } else if (st.isFile()) {
      const uploaded = await uploadOne(drive, item.path, item.name, threadFolderId)
      if (uploaded) results.push(uploaded)
    }
  }

  logDispatcher('drive_upload_batch', {
    threadId,
    count: results.length,
    requested: items.length,
  })
  return results
}

/**
 * Render a short line summarising uploads, suitable for appending to a
 * Discord message. Returns empty string if no uploads.
 *
 * Example: "📁 Also saved to Drive: <link1>, <link2>"
 * For many files we just show the thread folder link.
 */
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

/** Build a web URL to a Drive folder given its ID. */
export function folderUrl(folderId: string): string {
  return `https://drive.google.com/drive/folders/${folderId}`
}

/**
 * Get the thread folder's web URL, creating it if necessary.
 * Used to include a single folder link when many files upload at once.
 * Returns null if Drive is not configured.
 */
export async function getThreadFolderUrl(
  threadId: string,
  threadTitle: string | null,
): Promise<string | null> {
  const drive = getClient()
  if (!drive) return null
  try {
    const id = await getThreadFolder(drive, threadId, threadTitle)
    return folderUrl(id)
  } catch {
    return null
  }
}

/**
 * True if Drive mirror is configured and ready to upload.
 * Useful for status/diagnostics.
 */
export function isDriveEnabled(): boolean {
  return driveEnabled()
}

/**
 * Convenience: given an array of OutputFile-like objects (path + name),
 * upload them as one batch with thread context, returning a Discord-ready
 * summary line and the individual results.
 */
export async function uploadAndSummarise(
  items: UploadInput[],
  threadId: string,
  threadTitle: string | null,
): Promise<{ summary: string; results: DriveUploadResult[] }> {
  const results = await uploadOutboxFiles(items, threadId, threadTitle)
  if (results.length === 0) {
    return { summary: '', results: [] }
  }
  const threadFolderUrl = await getThreadFolderUrl(threadId, threadTitle)
  return {
    summary: formatUploadSummary(results, threadFolderUrl),
    results,
  }
}

// Silence "unused" linter complaints about OUTBOX_DIR — kept imported so
// future features (e.g. a full outbox sync on startup) can reference it.
void OUTBOX_DIR
void relative
