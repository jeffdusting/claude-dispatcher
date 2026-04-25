#!/usr/bin/env bun
/**
 * One-time Drive bootstrap.
 *
 * Creates the "Claude Outbox" root folder in the service account's Drive,
 * shares it with Jeff as Editor (so it appears in his "Shared with me"),
 * and sets anyone-with-link-viewer so he can forward any output to others
 * without extra clicks. Then writes the resulting folder ID to
 * ~/claude-workspace/generic/.secrets/google-drive.env.
 *
 * Safe to re-run: if a folder named "Claude Outbox" already exists in the
 * SA's drive, it reuses that one rather than creating a duplicate.
 */

import { google } from 'googleapis'
import { readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

const SA_KEY = join(homedir(), 'claude-workspace', 'generic', '.secrets', 'google-drive-sa.json')
const ENV_FILE = join(homedir(), 'claude-workspace', 'generic', '.secrets', 'google-drive.env')
const FOLDER_NAME = 'Claude Outbox'
const JEFFS_EMAIL = 'jeffdusting@waterroads.com.au'

async function main() {
  const key = JSON.parse(readFileSync(SA_KEY, 'utf8'))
  console.log(`Using service account: ${key.client_email}`)

  const auth = new google.auth.JWT({
    email: key.client_email,
    key: key.private_key,
    // drive.file = access files created by this app. Sufficient for
    // creating the folder and sharing it.
    scopes: ['https://www.googleapis.com/auth/drive.file'],
  })
  const drive = google.drive({ version: 'v3', auth })

  // 1. Find or create the root folder
  const search = await drive.files.list({
    q: `name='${FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: 'files(id,name)',
    pageSize: 1,
    spaces: 'drive',
  })

  let folderId: string
  let folderLink: string
  if (search.data.files && search.data.files.length > 0) {
    folderId = search.data.files[0]!.id!
    const meta = await drive.files.get({
      fileId: folderId,
      fields: 'id,name,webViewLink',
    })
    folderLink = meta.data.webViewLink ?? `https://drive.google.com/drive/folders/${folderId}`
    console.log(`Reusing existing folder: ${folderId}`)
  } else {
    const created = await drive.files.create({
      requestBody: {
        name: FOLDER_NAME,
        mimeType: 'application/vnd.google-apps.folder',
      },
      fields: 'id,name,webViewLink',
    })
    folderId = created.data.id!
    folderLink = created.data.webViewLink ?? `https://drive.google.com/drive/folders/${folderId}`
    console.log(`Created folder: ${folderId}`)
  }

  // 2. Share with Jeff as Editor (so it lands in "Shared with me")
  try {
    await drive.permissions.create({
      fileId: folderId,
      requestBody: {
        role: 'writer',
        type: 'user',
        emailAddress: JEFFS_EMAIL,
      },
      sendNotificationEmail: false,
      fields: 'id',
    })
    console.log(`Shared as Editor with ${JEFFS_EMAIL}`)
  } catch (err) {
    const msg = String(err).slice(0, 300)
    if (msg.includes('already') || msg.includes('409') || msg.includes('duplicate')) {
      console.log(`Already shared with ${JEFFS_EMAIL}`)
    } else {
      console.warn(`User share warning: ${msg}`)
    }
  }

  // 3. Set anyone-with-link = Viewer
  try {
    await drive.permissions.create({
      fileId: folderId,
      requestBody: {
        role: 'reader',
        type: 'anyone',
      },
      fields: 'id',
    })
    console.log(`Anyone-with-link = Viewer set`)
  } catch (err) {
    const msg = String(err).slice(0, 300)
    if (msg.includes('already') || msg.includes('409')) {
      console.log(`Anyone-with-link already configured`)
    } else {
      console.warn(`Link share warning: ${msg}`)
    }
  }

  // 4. Write env file for the dispatcher
  writeFileSync(ENV_FILE, `DRIVE_FOLDER_ID=${folderId}\n`)
  console.log(`Wrote ${ENV_FILE}`)

  console.log('')
  console.log(`Folder URL: ${folderLink}`)
  console.log(`Folder ID:  ${folderId}`)
  console.log('')
  console.log('Bootstrap complete.')
}

main().catch((err) => {
  console.error('Setup failed:')
  console.error(err)
  process.exit(1)
})
