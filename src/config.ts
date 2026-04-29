/**
 * Dispatcher configuration — centralised constants and env loading.
 */

import { readFileSync, writeFileSync, renameSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

// ─── Paths ────────────────────────────────────────────────────────────────
//
// Each path constant is env-var-driven with a laptop default. Cloud (Fly.io)
// sets the env explicitly via fly.toml so the dispatcher writes to the
// mounted /data volume; laptop dev keeps the existing ~/claude-workspace
// layout. Migration Plan §4.4.1 (Phase A.4).
//
// envOr<name>(default) keeps the call site readable and avoids `process.env.X
// ?? default` everywhere.
function envOr(name: string, fallback: string): string {
  const v = process.env[name]
  return v && v.length > 0 ? v : fallback
}

const LAPTOP_PROJECT_DIR = join(homedir(), 'claude-workspace', 'generic')

export const PROJECT_DIR = envOr('PROJECT_DIR', LAPTOP_PROJECT_DIR)
export const DISPATCHER_DIR = envOr('DISPATCHER_DIR', join(PROJECT_DIR, 'dispatcher'))
export const STATE_DIR = envOr('STATE_DIR', join(DISPATCHER_DIR, 'state'))
export const LOG_DIR = envOr('LOG_DIR', join(PROJECT_DIR, 'logs'))
export const OUTBOX_DIR = envOr('OUTBOX_DIR', join(PROJECT_DIR, 'outbox'))
export const INGEST_DIR = join(STATE_DIR, 'channels')
export const INGEST_CURSOR_FILE = join(STATE_DIR, 'ingest-cursors.json')

// Discord plugin state (reuse access config)
const DISCORD_STATE_DIR = join(homedir(), '.claude', 'channels', 'discord')
const ENV_FILE = join(DISCORD_STATE_DIR, '.env')
const ACCESS_FILE = join(DISCORD_STATE_DIR, 'access.json')

// Role must be defined before loadToken() so it can suppress the throw in spare mode.
export type DispatcherRole = 'primary' | 'spare'
export const DISPATCHER_ROLE: DispatcherRole =
  (process.env.DISPATCHER_ROLE as DispatcherRole | undefined) ?? 'primary'

/**
 * Test-mode flag (Δ OD-034). When DISPATCHER_TEST_MODE=1 every on-disk
 * secret fallback in this module short-circuits to empty/null. Tests set
 * the flag; production never sets it.
 *
 * Background: an A.9 c6-c9 smoke test leaked a real Twilio SMS to the
 * operator's mobile because clearing env vars did not block the .secrets
 * fallback — readFileSync still found the laptop-dev credentials and the
 * test made a real API call. The fix is structural: every secret-file read
 * routes through `readSecretFileOrEmpty()` and every secret-path default
 * routes through `secretPathFallback()`. Both return empty in test mode,
 * so credential consumers (Twilio, Discord token, Drive folder IDs, SA
 * key paths) all resolve to null/empty and any code path that genuinely
 * requires a credential fails closed.
 *
 * The check belongs at this layer rather than at individual call sites:
 * call-site checks would be piecemeal and easy to miss when adding a new
 * credential; gating the two helpers below makes the policy uniform.
 */
export const DISPATCHER_TEST_MODE: boolean = process.env.DISPATCHER_TEST_MODE === '1'

/**
 * Read a secret file, returning '' when the file is missing, unreadable,
 * or DISPATCHER_TEST_MODE is set. Centralised so tests cannot bypass the
 * fallback by leaving an env var unset — the fallback itself is gated.
 */
function readSecretFileOrEmpty(path: string): string {
  if (DISPATCHER_TEST_MODE) return ''
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

/**
 * Compute the default path for a secret living under SECRETS_DIR. Returns
 * '' in test mode so a path-typed export (e.g. CBS_DRIVE_SA_KEY_PATH)
 * cannot accidentally point at the real on-disk credential when a test
 * forgets to override the env var.
 */
function secretPathFallback(filename: string): string {
  return DISPATCHER_TEST_MODE ? '' : join(SECRETS_DIR, filename)
}

// Load bot token from the existing Discord plugin .env.
// Spare mode and test mode: return '' rather than throw — connect() is
// never called in spare mode so the empty string is never used; tests that
// drive gateway code inject their own value via env or a poster seam.
function loadToken(): string {
  const content = readSecretFileOrEmpty(ENV_FILE)
  for (const line of content.split('\n')) {
    const m = line.match(/^DISCORD_BOT_TOKEN=(.+)$/)
    if (m) return m[1]!
  }
  if (DISPATCHER_ROLE === 'spare' || DISPATCHER_TEST_MODE) return ''
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

// Session limits.
// `MAX_CONCURRENT_BUSY` was retired in Phase A.9.5 (Δ D-014); the
// concurrent-worker cap is owned by `concurrencyGate.ts` and configured via
// the `DISPATCHER_MAX_CONCURRENT_WORKERS` env var (default 5).
export const MAX_TRACKED_SESSIONS = 50
export const MAX_QUEUED_MESSAGES = 10
export const SESSION_IDLE_TIMEOUT_MS = 4 * 60 * 60 * 1000   // 4 hours
export const SESSION_CLEANUP_MS = 24 * 60 * 60 * 1000        // 24 hours
export const THREAD_AUTO_ARCHIVE_MINUTES = 1440               // 24 hours

// Progress update interval (how often to edit the "Working..." message)
export const PROGRESS_UPDATE_MS = 8_000

// Attachment download directory. Env-overridable (Phase A.4) so cloud can
// route attachments onto the /data volume.
export const ATTACHMENT_DIR = envOr('ATTACHMENT_DIR', join(DISPATCHER_DIR, 'attachments'))

// Claude CLI. Laptop default is the user-local npm install path; cloud
// fly.toml [env] overrides to /usr/bin/claude (npm -g destination on the
// Debian-based bun image).
export const CLAUDE_BIN = envOr('CLAUDE_BIN', join(homedir(), '.local', 'bin', 'claude'))
export const CLAUDE_AGENT = 'chief-of-staff'
export const CLAUDE_MODEL = 'opus'

// Google Drive mirror — per-entity routing (Phase A.5.1).
//
// Each entity has its own service account and its own root folder. The
// dispatcher selects the credential pair at upload time based on the
// caller's entity context. The default routes CBS Group traffic to the
// existing single-tenant config (operator's `.secrets/google-drive*` files);
// WR routes to a separate SA + folder once populated.
//
// Auth: service account JSON key per entity. Each SA's email must be granted
// Editor access to its corresponding folder. Until WR is populated, WR
// routing is silently disabled (no SA key file → uploads skipped).
//
// Env-var overrides (set in fly.toml [env] for cloud):
//   CBS_DRIVE_SA_KEY_PATH, CBS_DRIVE_FOLDER_ID
//   WR_DRIVE_SA_KEY_PATH,  WR_DRIVE_FOLDER_ID
//
// Phase B.4 moves these onto 1Password fetch-at-boot; until then they
// resolve from the workspace .secrets directory.
const SECRETS_DIR = join(homedir(), 'claude-workspace', 'generic', '.secrets')

export const CBS_DRIVE_SA_KEY_PATH = envOr(
  'CBS_DRIVE_SA_KEY_PATH',
  secretPathFallback('google-drive-sa.json'),
)
export const WR_DRIVE_SA_KEY_PATH = envOr(
  'WR_DRIVE_SA_KEY_PATH',
  secretPathFallback('wr-drive-sa.json'),
)

function loadFolderIdFromEnvFile(filename: string, key: string): string | null {
  const content = readSecretFileOrEmpty(join(SECRETS_DIR, filename))
  for (const line of content.split('\n')) {
    const m = line.match(new RegExp(`^${key}=(.+)$`))
    if (m) return m[1]!.trim()
  }
  return null
}

export const CBS_DRIVE_FOLDER_ID: string | null =
  envOr('CBS_DRIVE_FOLDER_ID', '') ||
  loadFolderIdFromEnvFile('google-drive.env', 'DRIVE_FOLDER_ID') ||
  loadFolderIdFromEnvFile('cbs-drive.env', 'CBS_DRIVE_FOLDER_ID') ||
  null

export const WR_DRIVE_FOLDER_ID: string | null =
  envOr('WR_DRIVE_FOLDER_ID', '') ||
  loadFolderIdFromEnvFile('wr-drive.env', 'WR_DRIVE_FOLDER_ID') ||
  null

// Pause scheduled routines without going full spare-mode. Use on the laptop
// during cutover so it still answers Discord but cloud owns cron execution.
// Set DISPATCHER_PAUSE_CRON=1 in the environment.
export const DISPATCHER_PAUSE_CRON: boolean = process.env.DISPATCHER_PAUSE_CRON === '1'

// Discord channel for tier-1 ops alerts (e.g. agent sync failures at boot).
// Optional — when unset, alerts are logged but not posted. The full alert
// layer lands in Phase A.9 Resilience; this constant is the stop-gap.
export const OPS_ALERT_CHANNEL_ID: string | null =
  process.env.OPS_ALERT_CHANNEL_ID?.trim() || null

// Twilio SMS escalation (Phase A.9 component 8 — Δ O-002, OD-011).
//
// A tier-2 Discord alert posted to OPS_ALERT_CHANNEL_ID gets escalated to
// SMS if it has not received an acknowledgement reaction within
// TIER2_ACK_WINDOW_MS. All four variables must resolve for SMS to be sent;
// missing creds produce a log-only fallback so a misconfigured environment
// does not silently swallow alerts.
//
// Laptop dev resolves these from `.secrets/twilio-alex-morgan.env` and
// `.secrets/sms-contacts.env` via the loader below. Cloud (Fly.io) sets
// them via `fly secrets set`. Phase B.4 moves them onto 1Password
// fetch-at-boot.
function loadTwilioFromEnvFiles(): Record<string, string> {
  const fields: Record<string, string> = {}
  for (const file of ['twilio-alex-morgan.env', 'sms-contacts.env']) {
    const content = readSecretFileOrEmpty(join(SECRETS_DIR, file))
    if (!content) continue
    for (const line of content.split('\n')) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.+)$/)
      if (m) fields[m[1]!] = m[2]!.trim()
    }
  }
  return fields
}

const TWILIO_FALLBACK = loadTwilioFromEnvFiles()

export const TWILIO_ACCOUNT_SID: string | null =
  process.env.TWILIO_ACCOUNT_SID?.trim() || TWILIO_FALLBACK.TWILIO_ACCOUNT_SID || null

export const TWILIO_AUTH_TOKEN: string | null =
  process.env.TWILIO_AUTH_TOKEN?.trim() || TWILIO_FALLBACK.TWILIO_AUTH_TOKEN || null

export const TWILIO_FROM_NUMBER: string | null =
  process.env.TWILIO_FROM_NUMBER?.trim() || TWILIO_FALLBACK.TWILIO_FROM_NUMBER || null

/**
 * Operator mobile number (E.164). Falls back to JEFF_MOBILE from the SMS
 * contacts file. WR escalation routes via SARAH_MOBILE per OD-008 (Sarah
 * is backup operator on the WR side); the escalator picks the appropriate
 * recipient based on the alert level / entity.
 */
export const OPERATOR_MOBILE: string | null =
  process.env.OPERATOR_MOBILE?.trim() || TWILIO_FALLBACK.JEFF_MOBILE || null

export const SARAH_MOBILE: string | null =
  process.env.SARAH_MOBILE?.trim() || TWILIO_FALLBACK.SARAH_MOBILE || null

/** Time after a tier-2 alert post without an ack before SMS escalation fires. */
export const TIER2_ACK_WINDOW_MS: number =
  parseInt(process.env.TIER2_ACK_WINDOW_MS ?? `${5 * 60 * 1000}`, 10)

// Anthropic monthly-cap detector (Phase A.9.9 — OD-012).
//
// `ANTHROPIC_ADMIN_KEY` is the Organisation-scoped admin key used to query
// the Admin API for cycle-to-date usage. Optional: when unset, the proactive
// budget check is skipped and only the reactive path (claude.ts catches a
// monthly-cap error from a subprocess) detects cap hits. Phase B.4 moves
// this onto 1Password fetch-at-boot.
export const ANTHROPIC_ADMIN_KEY: string | null =
  process.env.ANTHROPIC_ADMIN_KEY?.trim() || null

/**
 * Per-consumer monthly Anthropic spend cap (USD). The dispatcher uses this
 * to compute per-consumer thresholds (70/85/95% per OD-012). The total cap
 * is what Anthropic enforces at the organisation level; the splits below
 * are what the dispatcher polices to avoid one consumer starving the
 * others. Override via env: `ANTHROPIC_MONTHLY_CAP_USD`.
 */
export const ANTHROPIC_MONTHLY_CAP_USD: number =
  parseFloat(process.env.ANTHROPIC_MONTHLY_CAP_USD ?? '5000')

/** Per OD-012: 50% dispatcher / 30% Paperclip / 15% mail-manager / 5% reserve. */
export const ANTHROPIC_BUDGET_SPLIT = {
  dispatcher: 0.50,
  paperclip: 0.30,
  'mail-manager': 0.15,
  reserve: 0.05,
} as const

// Per-worker memory observation (Phase A.9.6 — Δ D-014).
//
// The worker registry samples each running subprocess's RSS at
// WORKER_MEMORY_SAMPLE_INTERVAL_MS. RSS at or above WORKER_MEMORY_WARN_BYTES
// emits a structured `worker_memory_warn` log; RSS at or above
// WORKER_MEMORY_KILL_BYTES SIGTERMs the subprocess and unregisters the
// worker with status `killed`. Defaults are 1 GB / 1.5 GB / 30 seconds.
const ONE_GB = 1024 * 1024 * 1024
export const WORKER_MEMORY_WARN_BYTES: number =
  parseInt(process.env.WORKER_MEMORY_WARN_BYTES ?? `${ONE_GB}`, 10)
export const WORKER_MEMORY_KILL_BYTES: number =
  parseInt(process.env.WORKER_MEMORY_KILL_BYTES ?? `${Math.floor(1.5 * ONE_GB)}`, 10)
export const WORKER_MEMORY_SAMPLE_INTERVAL_MS: number =
  parseInt(process.env.WORKER_MEMORY_SAMPLE_INTERVAL_MS ?? `${30 * 1000}`, 10)

// Port for the internal health HTTP endpoint. Responds in all modes (including spare)
// so spares can be monitored with a simple curl localhost:PORT/health.
// Default 8080 matches the Fly.io http_service.internal_port in fly.toml.
// Override with HEALTHCHECK_PORT env var if running locally on a port that's in use.
export const HEALTHCHECK_PORT: number = parseInt(process.env.HEALTHCHECK_PORT ?? '8080', 10)

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
