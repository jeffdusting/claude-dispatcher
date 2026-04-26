/**
 * Passive channel ingestion.
 *
 * Archives messages from configured channels into per-channel JSONL files at
 * state/channels/{channelId}/YYYY-MM-DD.jsonl. This gives the Chief-of-Staff
 * (and any other session) a cross-channel shared context that can be queried
 * via scripts/query-channels.ts.
 *
 * Design:
 * - Append-only JSONL, one line per message, partitioned by UTC date.
 * - Per-channel ingest cursor persisted to state/ingest-cursors.json so we
 *   can resume without re-fetching on restart.
 * - Daily sweeper deletes files older than `retentionDays` (default 90).
 * - Attachments stored as metadata + URL only — content fetched on demand.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'fs'
import { writeJsonAtomic } from './atomicWrite.js'
import { join } from 'path'
import type { Client, Message, TextChannel, NewsChannel, ThreadChannel, ForumChannel } from 'discord.js'
import {
  INGEST_DIR,
  INGEST_CURSOR_FILE,
  INGEST_DEFAULTS,
  ingestChannelIds,
  loadAccess,
  type AccessConfig,
} from './config.js'
import { logDispatcher } from './logger.js'

mkdirSync(INGEST_DIR, { recursive: true })

// ─── Types ────────────────────────────────────────────────────────

export interface IngestedMessage {
  /** ISO 8601 timestamp */
  timestamp: string
  /** Discord message ID (snowflake) — monotonically increasing */
  id: string
  channelId: string
  channelName?: string
  /** Parent channel ID if this is a thread message */
  parentChannelId?: string
  /** Thread name if applicable */
  threadName?: string
  authorId: string
  authorName: string
  authorBot: boolean
  content: string
  attachments: Array<{ id: string; name: string | null; url: string; size: number; contentType: string | null }>
  /** Message ID this is a reply to, if any */
  replyToId?: string
  editedTimestamp?: string
}

interface CursorState {
  /** Last ingested message ID per channel (snowflake). Used for backfill resume. */
  [channelId: string]: string
}

// ─── Cursor persistence ───────────────────────────────────────────

let cursors: CursorState = loadCursors()

function loadCursors(): CursorState {
  try {
    if (existsSync(INGEST_CURSOR_FILE)) {
      return JSON.parse(readFileSync(INGEST_CURSOR_FILE, 'utf8'))
    }
  } catch (err) {
    logDispatcher('ingest_cursor_load_failed', { error: String(err) })
  }
  return {}
}

function saveCursors(): void {
  // Atomic write per D-001 audit (Phase A.4).
  try {
    writeJsonAtomic(INGEST_CURSOR_FILE, cursors)
  } catch (err) {
    logDispatcher('ingest_cursor_save_failed', { error: String(err) })
  }
}

// Debounced save — cursor is hot-written, no need to fsync on every message
let saveTimer: NodeJS.Timeout | null = null
function scheduleSave(): void {
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveCursors()
    saveTimer = null
  }, 2_000)
}

// ─── File layout ──────────────────────────────────────────────────

function dateStr(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10)
}

function channelDir(channelId: string): string {
  const dir = join(INGEST_DIR, channelId)
  mkdirSync(dir, { recursive: true })
  return dir
}

function fileForDate(channelId: string, date: Date): string {
  return join(channelDir(channelId), `${dateStr(date)}.jsonl`)
}

// ─── Message shaping ──────────────────────────────────────────────

function toIngested(msg: Message): IngestedMessage {
  const isThread = msg.channel.isThread()
  const out: IngestedMessage = {
    timestamp: new Date(msg.createdTimestamp).toISOString(),
    id: msg.id,
    channelId: msg.channelId,
    authorId: msg.author.id,
    authorName: msg.author.username,
    authorBot: msg.author.bot,
    content: msg.content,
    attachments: Array.from(msg.attachments.values()).map((a) => ({
      id: a.id,
      name: a.name,
      url: a.url,
      size: a.size,
      contentType: a.contentType,
    })),
  }

  // Resolve channel name. For thread messages we want `channelName` to be
  // the PARENT channel's name (e.g. "riveragents"), and `threadName` to be
  // the thread's name — not both set to the thread name.
  if (isThread) {
    const thread = msg.channel as ThreadChannel
    if (thread.parentId) out.parentChannelId = thread.parentId
    if (thread.name) out.threadName = thread.name
    const parent = thread.parent as TextChannel | NewsChannel | ForumChannel | null
    if (parent && 'name' in parent && parent.name) out.channelName = parent.name
  } else {
    const ch = msg.channel as TextChannel | NewsChannel
    if ('name' in ch && ch.name) out.channelName = ch.name
  }

  if (msg.reference?.messageId) out.replyToId = msg.reference.messageId
  if (msg.editedTimestamp) out.editedTimestamp = new Date(msg.editedTimestamp).toISOString()

  return out
}

// ─── Write path ───────────────────────────────────────────────────

/**
 * Ingest a single live message (called from gateway.ts on messageCreate).
 * Returns true if written, false if skipped (bot filter, duplicate, etc.).
 */
export function ingestMessage(msg: Message, access: AccessConfig = loadAccess()): boolean {
  const ingestIds = ingestChannelIds(access)

  // Also ingest thread messages if their PARENT channel is ingested
  const parentId = msg.channel.isThread() ? msg.channel.parentId : null
  const effectiveChannel = parentId && ingestIds.has(parentId) ? parentId : msg.channelId

  if (!ingestIds.has(msg.channelId) && !(parentId && ingestIds.has(parentId))) return false

  const includeBots = access.ingest?.includeBots ?? INGEST_DEFAULTS.includeBots
  if (msg.author.bot && !includeBots) return false

  // Dedupe against cursor — if we've already stored this ID or a newer one, skip.
  // Discord snowflakes are monotonically increasing numeric strings.
  const last = cursors[effectiveChannel]
  if (last && compareSnowflake(msg.id, last) <= 0) return false

  try {
    const entry = toIngested(msg)
    const file = fileForDate(effectiveChannel, new Date(msg.createdTimestamp))
    appendFileSync(file, JSON.stringify(entry) + '\n')
    cursors[effectiveChannel] = msg.id
    scheduleSave()
    return true
  } catch (err) {
    logDispatcher('ingest_write_failed', {
      channelId: effectiveChannel,
      messageId: msg.id,
      error: String(err),
    })
    return false
  }
}

/**
 * Compare two Discord snowflakes. Returns negative if a<b, positive if a>b, 0 if equal.
 * Snowflakes are 64-bit numeric strings so we can't just use regular number compare.
 */
function compareSnowflake(a: string, b: string): number {
  if (a.length !== b.length) return a.length - b.length
  return a < b ? -1 : a > b ? 1 : 0
}

// ─── Backfill ─────────────────────────────────────────────────────

/**
 * On startup, fetch recent messages for each ingested channel that we haven't
 * already stored. Limited to `backfillLimit` messages per channel to cap
 * cold-start time.
 */
export async function backfillAll(client: Client): Promise<void> {
  const access = loadAccess()
  const ingestIds = ingestChannelIds(access)
  if (ingestIds.size === 0) {
    logDispatcher('ingest_backfill_skipped', { reason: 'no_channels_configured' })
    return
  }

  const limit = access.ingest?.backfillLimit ?? INGEST_DEFAULTS.backfillLimit
  const includeBots = access.ingest?.includeBots ?? INGEST_DEFAULTS.includeBots

  logDispatcher('ingest_backfill_start', {
    channelCount: ingestIds.size,
    limitPerChannel: limit,
  })

  let total = 0
  for (const channelId of ingestIds) {
    try {
      const count = await backfillChannel(client, channelId, limit, includeBots)
      total += count
    } catch (err) {
      logDispatcher('ingest_backfill_channel_failed', {
        channelId,
        error: String(err),
      })
    }
  }

  saveCursors()
  logDispatcher('ingest_backfill_complete', { totalMessages: total })
}

async function backfillChannel(
  client: Client,
  channelId: string,
  limit: number,
  includeBots: boolean,
): Promise<number> {
  const channel = await client.channels.fetch(channelId).catch(() => null)
  if (!channel || !channel.isTextBased() || !('messages' in channel)) {
    logDispatcher('ingest_backfill_unfetchable', { channelId })
    return 0
  }

  const cursor = cursors[channelId]
  const batchSize = 100 // Discord API max
  let fetched = 0
  let written = 0
  let before: string | undefined

  // Fetch in descending order (newest first) until we hit cursor or limit
  while (fetched < limit) {
    const batch = await (channel as TextChannel).messages
      .fetch({ limit: Math.min(batchSize, limit - fetched), before })
      .catch(() => null)
    if (!batch || batch.size === 0) break

    // Discord returns newest→oldest; iterate in that order so we can short-circuit
    // once we cross the cursor.
    let hitCursor = false
    const newEntries: IngestedMessage[] = []
    for (const m of batch.values()) {
      if (cursor && compareSnowflake(m.id, cursor) <= 0) {
        hitCursor = true
        break
      }
      if (m.author.bot && !includeBots) continue
      newEntries.push(toIngested(m))
    }

    // Write in chronological order so later reads are naturally ordered
    for (const entry of newEntries.reverse()) {
      const file = fileForDate(channelId, new Date(entry.timestamp))
      try {
        appendFileSync(file, JSON.stringify(entry) + '\n')
        written++
      } catch (err) {
        logDispatcher('ingest_backfill_write_failed', {
          channelId,
          messageId: entry.id,
          error: String(err),
        })
      }
    }

    // Update cursor to the newest message we've seen overall (first batch, first msg)
    if (fetched === 0 && batch.size > 0) {
      const newest = Array.from(batch.values())[0]!
      const existing = cursors[channelId]
      if (!existing || compareSnowflake(newest.id, existing) > 0) {
        cursors[channelId] = newest.id
      }
    }

    fetched += batch.size
    if (hitCursor) break

    const oldest = Array.from(batch.values()).at(-1)
    if (!oldest) break
    before = oldest.id
    if (batch.size < batchSize) break
  }

  if (written > 0) {
    logDispatcher('ingest_backfill_channel_done', { channelId, fetched, written })
  }
  return written
}

// ─── Retention sweep ──────────────────────────────────────────────

/**
 * Delete JSONL files older than retentionDays. Per-channel directories are
 * left in place even when emptied.
 */
export function sweepRetention(access: AccessConfig = loadAccess()): number {
  const retentionDays = access.ingest?.retentionDays ?? INGEST_DEFAULTS.retentionDays
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000
  let removed = 0

  if (!existsSync(INGEST_DIR)) return 0

  for (const channel of readdirSync(INGEST_DIR)) {
    const dir = join(INGEST_DIR, channel)
    let st
    try {
      st = statSync(dir)
    } catch {
      continue
    }
    if (!st.isDirectory()) continue

    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.jsonl')) continue
      const path = join(dir, file)
      try {
        const fst = statSync(path)
        if (fst.mtimeMs < cutoff) {
          rmSync(path)
          removed++
        }
      } catch (err) {
        logDispatcher('ingest_sweep_file_failed', { path, error: String(err) })
      }
    }
  }

  if (removed > 0) {
    logDispatcher('ingest_sweep_done', { removed, retentionDays })
  }
  return removed
}

// ─── Shutdown ─────────────────────────────────────────────────────

export function shutdownIngest(): void {
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  saveCursors()
}
