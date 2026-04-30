import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'fs'
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
 * Per-EA seed subtree (Migration Plan §14.3.3 / §14.4.3).
 *
 * `state/seeds/eas/<partition>/style.md` holds the approved STYLE.md
 * baseline for each EA. On first boot of a fresh volume the file is
 * copied to `state/eas/<partition>/style.md` — Quinn or Alex reads it
 * at session start. Existing style.md files on the volume are left
 * untouched: the volume is the source of truth once seeded, so an
 * iterative-update mechanism (D2) can write to the runtime path
 * without the next boot clobbering its work.
 *
 * Walks the seeds subtree dynamically rather than using a static list
 * so adding a new EA's style.md to seeds requires no code change here.
 */
function seedEaStyleIfAbsent(): void {
  const seedRoot = join(SEEDS_DIR, 'eas')
  const runtimeRoot = join(STATE_DIR, 'eas')
  if (!existsSync(seedRoot)) return

  let partitions: string[]
  try {
    partitions = readdirSync(seedRoot)
  } catch (err) {
    logDispatcher('seed_eas_listdir_failed', { error: String(err) })
    return
  }

  for (const partition of partitions) {
    const seedPartitionDir = join(seedRoot, partition)
    let isDir = false
    try {
      isDir = statSync(seedPartitionDir).isDirectory()
    } catch {
      continue
    }
    if (!isDir) continue

    const seedStyle = join(seedPartitionDir, 'style.md')
    if (!existsSync(seedStyle)) continue

    const runtimePartitionDir = join(runtimeRoot, partition)
    const runtimeStyle = join(runtimePartitionDir, 'style.md')
    if (existsSync(runtimeStyle)) continue

    try {
      mkdirSync(runtimePartitionDir, { recursive: true })
      copyFileSync(seedStyle, runtimeStyle)
      logDispatcher('ea_style_seeded', { partition, path: runtimeStyle })
    } catch (err) {
      logDispatcher('ea_style_seed_failed', { partition, error: String(err) })
    }
  }
}

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
  seedEaStyleIfAbsent()
}
