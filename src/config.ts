/**
 * Dispatcher configuration — centralised constants and env loading.
 */

import { readFileSync, writeFileSync, renameSync, existsSync } from 'fs'
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
 * Default allowlist for newly auto-enabled channels.
 *
 * Matches the union of user IDs across existing group policies — the two
 * principals who interact with the dispatcher (Jeff and Sarah). Kept here
 * rather than recomputed from existing groups so the default is explicit
 * and survives edge cases where every group happens to be single-user.
 */
export const DEFAULT_ALLOW_FROM: string[] = [
  '1495020845846761582', // jad0404
  '1495747655152701547', // sjt
]

/**
 * Default policy for auto-enabled channels: require a mention in the parent
 * channel (threads bypass this check — see gateway.ts shouldProcess).
 */
export const DEFAULT_GROUP_POLICY: GroupPolicy = {
  requireMention: true,
  allowFrom: DEFAULT_ALLOW_FROM,
}

/**
 * Atomically mutate and persist access.json.
 *
 * Reads the current config, applies `mutator`, writes to a tmp file, then
 * renames onto ACCESS_FILE. Safe against torn writes if the process dies
 * mid-write. Returns the updated config so callers can inspect the result.
 *
 * The dispatcher re-reads access.json on every inbound message via
 * `loadAccess()`, so no restart or reload is required after this call.
 */
export function updateAccess(mutator: (cfg: AccessConfig) => void): AccessConfig {
  const cfg = loadAccess()
  mutator(cfg)
  const json = JSON.stringify(cfg, null, 2) + '\n'
  const tmp = `${ACCESS_FILE}.tmp.${process.pid}.${Date.now()}`
  writeFileSync(tmp, json, 'utf8')
  renameSync(tmp, ACCESS_FILE)
  return cfg
}

/**
 * Known-channels cache path — a flat `{channelId: name}` map consumed by
 * scripts/query-channels.ts for cheap lookups.
 */
const KNOWN_CHANNELS_FILE = join(STATE_DIR, 'known-channels.json')

/**
 * Add or update a single entry in the known-channels name cache.
 * Best-effort: missing/corrupt cache is re-created from the new entry.
 */
export function upsertKnownChannel(channelId: string, name: string): void {
  let map: Record<string, string> = {}
  if (existsSync(KNOWN_CHANNELS_FILE)) {
    try {
      map = JSON.parse(readFileSync(KNOWN_CHANNELS_FILE, 'utf8'))
    } catch {
      map = {}
    }
  }
  map[channelId] = name
  const json = JSON.stringify(map, null, 2) + '\n'
  const tmp = `${KNOWN_CHANNELS_FILE}.tmp.${process.pid}.${Date.now()}`
  writeFileSync(tmp, json, 'utf8')
  renameSync(tmp, KNOWN_CHANNELS_FILE)
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

// Google Drive mirror (optional — disabled if not configured)
//
// When enabled, files written to outbox/ during a session are uploaded to the
// configured Drive folder in addition to being attached to Discord. The user
// can then access them from phone/web without needing their desktop.
//
// Auth: service account JSON key. The service account's email must be granted
// Editor access to DRIVE_FOLDER_ID (share the folder with the SA email via the
// Drive UI). See outbox/drive-setup.md for the one-time setup.
export const DRIVE_SA_KEY_PATH = join(
  homedir(),
  'claude-workspace',
  'generic',
  '.secrets',
  'google-drive-sa.json',
)
function loadDriveConfig(): { folderId: string | null } {
  try {
    const envFile = join(homedir(), 'claude-workspace', 'generic', '.secrets', 'google-drive.env')
    const content = readFileSync(envFile, 'utf8')
    for (const line of content.split('\n')) {
      const m = line.match(/^DRIVE_FOLDER_ID=(.+)$/)
      if (m) return { folderId: m[1]!.trim() }
    }
  } catch {}
  return { folderId: null }
}
export const DRIVE_FOLDER_ID = loadDriveConfig().folderId

// Dispatcher role — controls whether this instance actively connects to Discord
// and runs scheduled routines ('primary') or sits idle as a warm spare ('spare').
// Set via DISPATCHER_ROLE env var. t07 adds the gateway short-circuit that reads this.
export type DispatcherRole = 'primary' | 'spare'
export const DISPATCHER_ROLE: DispatcherRole =
  (process.env.DISPATCHER_ROLE as DispatcherRole | undefined) ?? 'primary'

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
