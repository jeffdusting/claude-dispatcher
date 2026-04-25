#!/usr/bin/env bun
/**
 * List Shared Drives the SA is a member of, find the Claude output drive,
 * create a root folder inside it, and update google-drive.env.
 *
 * Runs as a one-shot after Jeff adds the SA to a Shared Drive.
 */

import { google } from 'googleapis'
import { readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

const SA_KEY = join(homedir(), 'claude-workspace', 'generic', '.secrets', 'google-drive-sa.json')
const ENV_FILE = join(homedir(), 'claude-workspace', 'generic', '.secrets', 'google-drive.env')
const ROOT_FOLDER_NAME = 'Claude Outbox'

async function main() {
  const key = JSON.parse(readFileSync(SA_KEY, 'utf8'))
  const auth = new google.auth.JWT({
    email: key.client_email,
    key: key.private_key,
    // drives.list needs drive.readonly; drive.file alone returns 403 here.
    // We only need this for the one-time discovery; runtime uploads use drive.file.
    scopes: [
      'https://www.googleapis.com/auth/drive.readonly',
      'https://www.googleapis.com/auth/drive.file',
    ],
  })
  const drive = google.drive({ version: 'v3', auth })

  // 1. List Shared Drives the SA can see
  const drives = await drive.drives.list({ pageSize: 50 })
  if (!drives.data.drives || drives.data.drives.length === 0) {
    console.error('SA is not a member of any Shared Drives yet.')
    console.error('Confirm the SA is added as Content Manager on the target Shared Drive.')
    process.exit(2)
  }

  console.log(`SA can see ${drives.data.drives.length} Shared Drive(s):`)
  for (const d of drives.data.drives) {
    console.log(`  - ${d.name}  (id: ${d.id})`)
  }

  // Prefer an exact-name match if multiple; else use the first.
  const preferred =
    drives.data.drives.find((d) => d.name?.toLowerCase().includes('claude')) ??
    drives.data.drives[0]!
  const driveId = preferred.id!
  const driveName = preferred.name!
  console.log(`\nUsing Shared Drive: ${driveName} (${driveId})`)

  // 2. Find or create the "Claude Outbox" root folder INSIDE the shared drive.
  // In a shared drive, the root parent is the drive's own ID.
  const q = `name='${ROOT_FOLDER_NAME}' and '${driveId}' in parents ` +
    `and mimeType='application/vnd.google-apps.folder' and trashed=false`
  const existing = await drive.files.list({
    q,
    driveId,
    corpora: 'drive',
    includeItemsFromAllDrives: true,
    supportsAllDrives: true,
    fields: 'files(id,name,webViewLink)',
    pageSize: 1,
  })

  let folderId: string
  let folderLink: string
  if (existing.data.files && existing.data.files.length > 0) {
    folderId = existing.data.files[0]!.id!
    folderLink =
      existing.data.files[0]!.webViewLink ?? `https://drive.google.com/drive/folders/${folderId}`
    console.log(`Reusing root folder: ${folderId}`)
  } else {
    const created = await drive.files.create({
      requestBody: {
        name: ROOT_FOLDER_NAME,
        mimeType: 'application/vnd.google-apps.folder',
        parents: [driveId],
      },
      fields: 'id,name,webViewLink',
      supportsAllDrives: true,
    })
    folderId = created.data.id!
    folderLink = created.data.webViewLink ?? `https://drive.google.com/drive/folders/${folderId}`
    console.log(`Created root folder: ${folderId}`)
  }

  // 3. Update env file
  writeFileSync(ENV_FILE, `DRIVE_FOLDER_ID=${folderId}\n`)
  console.log(`Wrote ${ENV_FILE}`)

  console.log('')
  console.log(`Shared Drive:  ${driveName}`)
  console.log(`Root folder:   ${folderLink}`)
  console.log(`Folder ID:     ${folderId}`)
}

main().catch((err) => {
  console.error('Failed:', err)
  process.exit(1)
})
