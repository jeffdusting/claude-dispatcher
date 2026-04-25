import { copyFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { STATE_DIR } from './config.js'
import { logDispatcher } from './logger.js'

const SEEDS_DIR = join(STATE_DIR, 'seeds')

const SEED_FILES = [
  'sessions.json',
  'health.json',
  'ingest-cursors.json',
  'known-channels.json',
]

/**
 * On first boot (e.g. a fresh cloud volume), copy seed files from state/seeds/
 * into state/ so subsequent modules find their expected files. Existing files
 * are left untouched — the volume is the source of truth once it is populated.
 */
export function seedStateIfAbsent(): void {
  mkdirSync(STATE_DIR, { recursive: true })
  for (const filename of SEED_FILES) {
    const dest = join(STATE_DIR, filename)
    const src = join(SEEDS_DIR, filename)
    if (!existsSync(dest) && existsSync(src)) {
      copyFileSync(src, dest)
      logDispatcher('state_seeded', { file: filename })
    }
  }
}
