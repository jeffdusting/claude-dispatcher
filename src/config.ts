/**
 * Dispatcher configuration — centralised constants and env loading.
 */

import { readFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

// Paths
export const PROJECT_DIR = join(homedir(), 'claude-workspace', 'generic')
export const DISPATCHER_DIR = join(PROJECT_DIR, 'dispatcher')
export const STATE_DIR = join(DISPATCHER_DIR, 'state')
export const LOG_DIR = join(PROJECT_DIR, 'logs')
export const OUTBOX_DIR = join(PROJECT_DIR, 'outbox')
export const INGEST_DIR = join(STATE_DIR, 'channels')
export const INGEST_CURSOR_FILE = join(STATE_DIR, 'ingest-cursors.json')

// Discord plugin state (reuse access config)
const DISCORD_STATE_DIR = join(homedir(), '.claude', 'channels', 'discord')
const ENV_FILE = join(DISCORD_STATE_DIR, '.env')
const ACCESS_FILE = join(DISCORD_STATE_DIR, 'access.json')

// Load bot token from the existing Discord plugin .env
function loadToken(): string {
  try {
    const content = readFileSync(ENV_FILE, 'utf8')
    for (const line of content.split('\n')) {
      const m = line.match(/^DISCORD_BOT_TOKEN=(.+)$/)
      if (m) return m[1]!
    }
  } catch {}
  throw new Error(`DISCORD_BOT_TOKEN not found in ${ENV_FILE}`)
}

export const DISCORD_BOT_TOKEN = loadToken()

// Load access control config
export interface GroupPolicy {
  requireMention?: boolean
  allowFrom?: string[]
}

/**
 * Passive ingestion config.
 *
 * Channels listed here are logged to state/channels/{id}/YYYY-MM-DD.jsonl
 * without triggering a Claude session. Used as a shared context store that
 * any session can query via scripts/query-channels.ts.
 *
 * - `channels`: list of channel IDs to ingest (in addition to any in `groups`).
 * - `includeBots`: log bot/webhook messages too (default true).
 * - `retentionDays`: purge JSONL files older than this (default 90).
 * - `backfillLimit`: max messages to fetch per channel on startup (default 500).
 */
export interface IngestConfig {
  channels?: string[]
  includeBots?: boolean
  retentionDays?: number
  backfillLimit?: number
}

export interface AccessConfig {
  dmPolicy: string
  allowFrom: string[]
  groups: Record<string, GroupPolicy>
  pending: Record<string, unknown>
  ingest?: IngestConfig
}

export function loadAccess(): AccessConfig {
  try {
    return JSON.parse(readFileSync(ACCESS_FILE, 'utf8'))
  } catch {
    throw new Error(`Could not load access config from ${ACCESS_FILE}`)
  }
}

/**
 * Returns the set of channel IDs to passively ingest.
 *
 * Includes: (a) any IDs listed in `ingest.channels`, and (b) any channels
 * already in `groups` (since we're already processing their messages, we
 * may as well archive them into the shared store).
 */
export function ingestChannelIds(access: AccessConfig = loadAccess()): Set<string> {
  const out = new Set<string>()
  for (const id of access.ingest?.channels ?? []) out.add(id)
  for (const id of Object.keys(access.groups ?? {})) out.add(id)
  return out
}

export const INGEST_DEFAULTS = {
  includeBots: true,
  retentionDays: 90,
  backfillLimit: 500,
} as const

// Session limits
export const MAX_CONCURRENT_BUSY = 5
export const MAX_TRACKED_SESSIONS = 50
export const MAX_QUEUED_MESSAGES = 10
export const SESSION_IDLE_TIMEOUT_MS = 4 * 60 * 60 * 1000   // 4 hours
export const SESSION_CLEANUP_MS = 24 * 60 * 60 * 1000        // 24 hours
export const THREAD_AUTO_ARCHIVE_MINUTES = 1440               // 24 hours

// Progress update interval (how often to edit the "Working..." message)
export const PROGRESS_UPDATE_MS = 8_000

// Attachment download directory
export const ATTACHMENT_DIR = join(DISPATCHER_DIR, 'attachments')

// Claude CLI
export const CLAUDE_BIN = join(homedir(), '.local', 'bin', 'claude')
export const CLAUDE_AGENT = 'chief-of-staff'
export const CLAUDE_MODEL = 'opus'

// Pre-approved tools (Phase 1: no permission relay, so approve what agents need)
export const ALLOWED_TOOLS = [
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'Bash',
  'Agent',
  'WebSearch',
  'WebFetch',
  'ToolSearch',
  'TaskCreate',
  'TaskUpdate',
  'TaskGet',
  'TaskList',
  'Skill',
].join(',')
