#!/usr/bin/env bun
/**
 * One-shot migration: upload every existing file in outbox/ to Google Drive.
 *
 * Uses the same service-account config as the live dispatcher mirror
 * (see dispatcher/src/drive.ts). Files go under a single
 * "Migrated YYYY-MM-DD" folder inside the configured Drive root.
 *
 * Usage:
 *   bun run dispatcher/scripts/migrate-outbox-to-drive.ts
 *
 * Prerequisites:
 *   - ~/claude-workspace/generic/.secrets/google-drive-sa.json  (SA key)
 *   - ~/claude-workspace/generic/.secrets/google-drive.env       (DRIVE_FOLDER_ID=...)
 *   - SA email granted Editor access on the Drive folder
 *
 * Safe to re-run — files with the same name in the same Drive folder will
 * simply be uploaded as new versions alongside the old ones (Drive doesn't
 * dedupe by name). Delete the migration folder first if you want a clean retry.
 */

import { readdirSync, statSync } from 'fs'
import { join } from 'path'
import { OUTBOX_DIR } from '../src/config.js'
import { uploadOutboxFiles, isDriveEnabled, folderUrl, getThreadFolderUrl } from '../src/drive.js'

async function main() {
  if (!isDriveEnabled()) {
    console.error('Drive mirror is not configured. Aborting.')
    console.error('Required:')
    console.error('  ~/claude-workspace/generic/.secrets/google-drive-sa.json')
    console.error('  ~/claude-workspace/generic/.secrets/google-drive.env (DRIVE_FOLDER_ID=...)')
    console.error('See outbox/drive-setup.md for setup.')
    process.exit(1)
  }

  let entries: string[]
  try {
    entries = readdirSync(OUTBOX_DIR)
  } catch (err) {
    console.error(`Cannot read outbox at ${OUTBOX_DIR}:`, err)
    process.exit(1)
  }

  if (entries.length === 0) {
    console.log('Outbox is empty. Nothing to migrate.')
    return
  }

  const items = entries.map((name) => ({
    path: join(OUTBOX_DIR, name),
    name,
  }))

  // Log what we're about to do
  let fileCount = 0
  let dirCount = 0
  for (const item of items) {
    try {
      const st = statSync(item.path)
      if (st.isDirectory()) dirCount++
      else if (st.isFile()) fileCount++
    } catch {}
  }
  console.log(`Migrating outbox → Drive`)
  console.log(`  Top-level items: ${items.length} (${fileCount} files + ${dirCount} directories)`)

  // We use a synthetic "thread" for the migration batch so it lands in a
  // clearly labelled subfolder of the Drive root rather than the catch-all.
  const today = new Date().toISOString().slice(0, 10)
  const migrationThreadId = `migration-${today}`
  const migrationThreadTitle = `Migrated ${today}`

  const results = await uploadOutboxFiles(items, migrationThreadId, migrationThreadTitle)

  if (results.length === 0) {
    console.error('No files uploaded. Check logs for errors.')
    process.exit(2)
  }

  const folderLink = await getThreadFolderUrl(migrationThreadId, migrationThreadTitle)
  console.log(`\nUploaded ${results.length} file(s).`)
  if (folderLink) {
    console.log(`Migration folder: ${folderLink}`)
  }
  console.log(`\nSample uploads:`)
  for (const r of results.slice(0, 5)) {
    console.log(`  - ${r.name}: ${r.webViewLink}`)
  }
  if (results.length > 5) {
    console.log(`  ... and ${results.length - 5} more`)
  }

  void folderUrl
}

main().catch((err) => {
  console.error('Migration failed:', err)
  process.exit(1)
})
