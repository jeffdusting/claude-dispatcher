/**
 * Agent definition sync — copies the canonical agent files from the
 * dispatcher repo's `.claude/agents/` into the user-level Claude Code
 * fallback at `~/.claude/agents/` at startup.
 *
 * Why: Claude Code resolves `--agent <name>` from `<cwd>/.claude/agents/`
 * then walks to `~/.claude/agents/`. The dispatcher spawns Claude with
 * `cwd = PROJECT_DIR` (the workspace), where `.claude/agents/` is no
 * longer the source of truth — the dispatcher repo is. Syncing into
 * `~/.claude/agents/` lets Claude's native fallback resolve the same
 * file content without changing the spawn pattern.
 *
 * Failure mode: rsync errors are non-fatal — the dispatcher continues
 * startup with `state/agents-stale.json` set, and a tier-1 alert is
 * posted to Discord once the gateway is connected (see notifyIfStale).
 */

import { spawnSync } from 'child_process'
import { existsSync, mkdirSync, unlinkSync, writeFileSync, readFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { DISPATCHER_DIR, STATE_DIR } from './config.js'
import { logDispatcher } from './logger.js'

const SOURCE = join(DISPATCHER_DIR, '.claude', 'agents') + '/'
const TARGET = join(homedir(), '.claude', 'agents') + '/'
const STALE_FLAG = join(STATE_DIR, 'agents-stale.json')

export interface StaleFlag {
  at: string
  reason: string
  rsyncExit?: number | null
  rsyncStderr?: string
}

export function readStaleFlag(): StaleFlag | null {
  if (!existsSync(STALE_FLAG)) return null
  try {
    return JSON.parse(readFileSync(STALE_FLAG, 'utf8')) as StaleFlag
  } catch {
    return { at: 'unknown', reason: 'flag file unreadable' }
  }
}

function writeStale(flag: StaleFlag): void {
  try {
    mkdirSync(STATE_DIR, { recursive: true })
    writeFileSync(STALE_FLAG, JSON.stringify(flag, null, 2) + '\n', 'utf8')
  } catch (err) {
    logDispatcher('agents_stale_flag_write_failed', { error: String(err) })
  }
}

function clearStale(): void {
  if (existsSync(STALE_FLAG)) {
    try {
      unlinkSync(STALE_FLAG)
    } catch {}
  }
}

/**
 * Idempotent rsync of the canonical agent directory into the user-level
 * Claude fallback. Safe to call multiple times.
 */
export function syncAgents(): { ok: boolean; reason?: string } {
  if (!existsSync(SOURCE.slice(0, -1))) {
    const reason = `source missing: ${SOURCE}`
    writeStale({ at: new Date().toISOString(), reason })
    logDispatcher('agents_sync_skipped', { reason })
    return { ok: false, reason }
  }

  mkdirSync(TARGET, { recursive: true })

  const result = spawnSync('rsync', ['-a', '--delete', SOURCE, TARGET], {
    encoding: 'utf8',
  })

  if (result.error) {
    const reason = `rsync spawn failed: ${result.error.message}`
    writeStale({
      at: new Date().toISOString(),
      reason,
      rsyncStderr: result.stderr ?? '',
    })
    logDispatcher('agents_sync_failed', { reason })
    return { ok: false, reason }
  }

  if (result.status !== 0) {
    const reason = `rsync exited ${result.status}`
    writeStale({
      at: new Date().toISOString(),
      reason,
      rsyncExit: result.status,
      rsyncStderr: (result.stderr ?? '').slice(0, 500),
    })
    logDispatcher('agents_sync_failed', { reason, stderr: (result.stderr ?? '').slice(0, 500) })
    return { ok: false, reason }
  }

  clearStale()
  logDispatcher('agents_sync_ok', { source: SOURCE, target: TARGET })
  return { ok: true }
}
