#!/usr/bin/env bun
/**
 * Query the ingested Discord channel archive.
 *
 * Reads per-channel JSONL files from state/channels/{channelId}/YYYY-MM-DD.jsonl
 * and filters by channel, time range, author, and/or keyword.
 *
 * Designed to be called from within a Claude session via Bash to pull
 * cross-channel context on demand.
 *
 * Examples:
 *   bun run scripts/query-channels.ts --list
 *   bun run scripts/query-channels.ts --channel general --since 24h
 *   bun run scripts/query-channels.ts --channel 1234567890 --grep "tender" --limit 50
 *   bun run scripts/query-channels.ts --since 2026-04-18 --author jad0404
 *   bun run scripts/query-channels.ts --all --since 6h --format json
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { INGEST_DIR, STATE_DIR } from '../src/config.js'

// Optional cache populated by `discover-channels.ts --write-cache` — holds
// authoritative {channelId: name} data fetched from Discord's API. Used to
// label channels whose archives only contain thread messages with the old
// (pre-fix) ingest shape.
const KNOWN_CHANNELS_FILE = join(STATE_DIR, 'known-channels.json')

function loadKnownChannels(): Record<string, string> {
  try {
    if (existsSync(KNOWN_CHANNELS_FILE)) {
      return JSON.parse(readFileSync(KNOWN_CHANNELS_FILE, 'utf8'))
    }
  } catch {}
  return {}
}

const knownChannels = loadKnownChannels()

interface IngestedMessage {
  timestamp: string
  id: string
  channelId: string
  channelName?: string
  parentChannelId?: string
  threadName?: string
  authorId: string
  authorName: string
  authorBot: boolean
  content: string
  attachments: Array<{ id: string; name: string | null; url: string; size: number; contentType: string | null }>
  replyToId?: string
  editedTimestamp?: string
}

interface Args {
  channel?: string
  all?: boolean
  since?: string
  until?: string
  author?: string
  grep?: string
  limit: number
  format: 'text' | 'json'
  list?: boolean
  help?: boolean
}

// ─── Arg parsing ──────────────────────────────────────────────────

function parseArgs(argv: string[]): Args {
  const args: Args = { limit: 200, format: 'text' }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => {
      const v = argv[++i]
      if (v === undefined) throw new Error(`Flag ${a} requires a value`)
      return v
    }
    switch (a) {
      case '--channel':
      case '-c':
        args.channel = next()
        break
      case '--all':
        args.all = true
        break
      case '--since':
      case '-s':
        args.since = next()
        break
      case '--until':
      case '-u':
        args.until = next()
        break
      case '--author':
      case '-a':
        args.author = next()
        break
      case '--grep':
      case '-g':
        args.grep = next()
        break
      case '--limit':
      case '-n':
        args.limit = parseInt(next(), 10)
        break
      case '--format':
      case '-f': {
        const f = next()
        if (f !== 'text' && f !== 'json') throw new Error(`--format must be text|json`)
        args.format = f
        break
      }
      case '--list':
        args.list = true
        break
      case '--help':
      case '-h':
        args.help = true
        break
      default:
        throw new Error(`Unknown flag: ${a}`)
    }
  }
  return args
}

function usage(): string {
  return `Usage: query-channels.ts [flags]

Flags:
  --list                     List all ingested channels with message counts
  --channel, -c <id|name>    Channel ID or (partial) name (required unless --all or --list)
  --all                      Query across all ingested channels
  --since, -s <time>         Start time: ISO date, or relative "24h" / "7d" / "30m"
  --until, -u <time>         End time: same format as --since
  --author, -a <name>        Filter by author username (case-insensitive, substring)
  --grep, -g <pattern>       Filter by regex against message content (case-insensitive)
  --limit, -n <N>            Max messages to return (default 200)
  --format, -f <text|json>   Output format (default text)
  --help, -h                 Show this help
`
}

// ─── Time parsing ─────────────────────────────────────────────────

function parseTime(s: string): number {
  // Relative: 30m, 24h, 7d
  const rel = s.match(/^(\d+)([mhd])$/)
  if (rel) {
    const n = parseInt(rel[1]!, 10)
    const unit = rel[2]!
    const ms = unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000
    return Date.now() - n * ms
  }
  // Absolute: ISO date/datetime
  const t = Date.parse(s)
  if (!isNaN(t)) return t
  throw new Error(`Invalid time: ${s}`)
}

// ─── Channel discovery ────────────────────────────────────────────

interface ChannelInfo {
  id: string
  /** Most recent channel name we've seen */
  name?: string
  messageCount: number
  firstSeen?: string
  lastSeen?: string
  files: string[]
}

function discoverChannels(): ChannelInfo[] {
  if (!existsSync(INGEST_DIR)) return []
  const out: ChannelInfo[] = []
  for (const id of readdirSync(INGEST_DIR)) {
    const dir = join(INGEST_DIR, id)
    let st
    try {
      st = statSync(dir)
    } catch {
      continue
    }
    if (!st.isDirectory()) continue

    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .sort()
    if (files.length === 0) {
      out.push({ id, messageCount: 0, files: [] })
      continue
    }

    // Peek the last file for the latest channel name + lastSeen.
    // We prefer a clean record (non-thread, or thread with channelName !=
    // threadName) so we don't mistakenly label a parent channel with a
    // thread's name. If no clean record exists, we fall back to the last
    // observed channelName (which, for archives that are all old-format
    // thread messages, will be a thread name — a known cosmetic caveat).
    const info: ChannelInfo = { id, messageCount: 0, files }
    const lastFile = files[files.length - 1]!
    const firstFile = files[0]!

    let fallbackName: string | undefined

    for (const f of files) {
      const content = readFileSync(join(dir, f), 'utf8')
      const lines = content.split('\n').filter((l) => l.length > 0)
      info.messageCount += lines.length
      if (f === firstFile && lines.length > 0) {
        const first = JSON.parse(lines[0]!) as IngestedMessage
        info.firstSeen = first.timestamp
      }
      // Scan every message in order — prefer a clean name but keep the
      // latest fallback handy
      for (const line of lines) {
        try {
          const m = JSON.parse(line) as IngestedMessage
          if (m.channelName) {
            const isClean = !m.threadName || m.channelName !== m.threadName
            if (isClean) info.name = m.channelName
            else fallbackName = m.channelName
          }
        } catch {}
      }
      if (f === lastFile && lines.length > 0) {
        const last = JSON.parse(lines[lines.length - 1]!) as IngestedMessage
        info.lastSeen = last.timestamp
      }
    }

    // Priority for info.name:
    //   1. Authoritative Discord-side cache (populated via discover-channels.ts --write-cache)
    //   2. Clean record found during scan (info.name already set)
    //   3. Fallback — last observed channelName (may be a thread name)
    if (knownChannels[id]) {
      info.name = knownChannels[id]
    } else if (!info.name && fallbackName) {
      info.name = fallbackName
    }

    out.push(info)
  }
  return out
}

function resolveChannel(query: string, channels: ChannelInfo[]): ChannelInfo | null {
  // Exact ID match
  const byId = channels.find((c) => c.id === query)
  if (byId) return byId
  // Substring match on name (case-insensitive)
  const q = query.toLowerCase()
  const byName = channels.filter((c) => c.name?.toLowerCase().includes(q))
  if (byName.length === 1) return byName[0]!
  if (byName.length > 1) {
    throw new Error(
      `Ambiguous channel name "${query}". Matches: ${byName.map((c) => `${c.name} (${c.id})`).join(', ')}`,
    )
  }
  return null
}

// ─── Message loading ──────────────────────────────────────────────

function* iterMessages(channelId: string, sinceMs: number, untilMs: number): Generator<IngestedMessage> {
  const dir = join(INGEST_DIR, channelId)
  if (!existsSync(dir)) return
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .sort()

  for (const f of files) {
    // Skip files whose date is clearly out of range
    const fileDate = f.replace('.jsonl', '')
    const fileDayStart = Date.parse(fileDate + 'T00:00:00Z')
    const fileDayEnd = fileDayStart + 86_400_000
    if (fileDayEnd < sinceMs || fileDayStart > untilMs) continue

    const content = readFileSync(join(dir, f), 'utf8')
    for (const line of content.split('\n')) {
      if (!line) continue
      try {
        const msg = JSON.parse(line) as IngestedMessage
        const t = Date.parse(msg.timestamp)
        if (t < sinceMs || t > untilMs) continue
        yield msg
      } catch {
        // Skip malformed lines
      }
    }
  }
}

// ─── Formatting ───────────────────────────────────────────────────

function formatText(msg: IngestedMessage, showChannel: boolean, parentNames: Map<string, string>): string {
  const time = msg.timestamp.slice(0, 19).replace('T', ' ')

  // Resolve the parent channel label. Older records stored thread messages with
  // channelName set to the thread name; detect that (channelName === threadName)
  // and fall back to the parent channel name we've learned from peer messages.
  let parentLabel: string | undefined
  if (msg.threadName && msg.parentChannelId) {
    parentLabel = parentNames.get(msg.parentChannelId) ?? msg.channelName
    if (parentLabel === msg.threadName) parentLabel = parentNames.get(msg.parentChannelId)
  } else {
    parentLabel = msg.channelName
  }

  let channel = ''
  if (showChannel) {
    const root = parentLabel ?? msg.parentChannelId ?? msg.channelId
    channel = msg.threadName ? `#${root} ▸ ${msg.threadName} ` : `#${root} `
  }

  const author = msg.authorBot ? `${msg.authorName} [bot]` : msg.authorName
  let body = msg.content || '(no content)'
  if (msg.attachments.length > 0) {
    body += `  [+${msg.attachments.length} attachment${msg.attachments.length > 1 ? 's' : ''}: ${msg.attachments.map((a) => a.name ?? a.id).join(', ')}]`
  }
  return `[${time}] ${channel}${author}: ${body}`
}

/**
 * Build a map of channelId → most-plausible channel name by scanning
 * non-thread records (those have a clean channelName set to the actual
 * parent channel's name).
 */
function buildParentNameMap(messages: IngestedMessage[]): Map<string, string> {
  const out = new Map<string, string>()
  for (const m of messages) {
    if (!m.threadName && m.channelName) {
      // Direct channel message — channelName is trustworthy
      out.set(m.channelId, m.channelName)
    } else if (m.threadName && m.parentChannelId && m.channelName && m.channelName !== m.threadName) {
      // Thread message with a correctly-resolved parent name (post-fix records)
      out.set(m.parentChannelId, m.channelName)
    }
  }
  return out
}

// ─── Main ─────────────────────────────────────────────────────────

function main() {
  let args: Args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (err) {
    process.stderr.write(`Error: ${(err as Error).message}\n\n${usage()}`)
    process.exit(2)
  }

  if (args.help) {
    process.stdout.write(usage())
    return
  }

  const channels = discoverChannels()

  if (args.list) {
    if (channels.length === 0) {
      process.stdout.write('No ingested channels yet.\n')
      return
    }
    process.stdout.write('Ingested channels:\n')
    for (const c of channels.sort((a, b) => b.messageCount - a.messageCount)) {
      const nameLabel = c.name ? `#${c.name}` : '(unknown name)'
      const range = c.firstSeen && c.lastSeen
        ? `${c.firstSeen.slice(0, 10)} → ${c.lastSeen.slice(0, 10)}`
        : 'empty'
      process.stdout.write(`  ${c.id}  ${nameLabel.padEnd(30)}  ${c.messageCount.toString().padStart(6)} msgs  (${range})\n`)
    }
    return
  }

  // Determine target channels
  let targets: ChannelInfo[]
  if (args.all) {
    targets = channels
  } else if (args.channel) {
    const resolved = resolveChannel(args.channel, channels)
    if (!resolved) {
      process.stderr.write(`No channel matching "${args.channel}". Try --list.\n`)
      process.exit(1)
    }
    targets = [resolved]
  } else {
    process.stderr.write(`Must specify --channel, --all, or --list.\n\n${usage()}`)
    process.exit(2)
  }

  const sinceMs = args.since ? parseTime(args.since) : 0
  const untilMs = args.until ? parseTime(args.until) : Date.now()

  // Collect matching messages from all targets, then sort by time
  const matches: IngestedMessage[] = []
  const grepRe = args.grep ? new RegExp(args.grep, 'i') : null
  const authorQ = args.author?.toLowerCase()

  for (const t of targets) {
    for (const msg of iterMessages(t.id, sinceMs, untilMs)) {
      if (authorQ && !msg.authorName.toLowerCase().includes(authorQ)) continue
      if (grepRe && !grepRe.test(msg.content)) continue
      matches.push(msg)
    }
  }

  matches.sort((a, b) => a.timestamp.localeCompare(b.timestamp))

  // If we have more than the limit, keep the MOST RECENT N (then display chronologically)
  const limited = matches.length > args.limit ? matches.slice(-args.limit) : matches

  if (args.format === 'json') {
    process.stdout.write(JSON.stringify(limited, null, 2) + '\n')
  } else {
    const showChannel = targets.length > 1
    // Build parent-name map with three sources, in precedence order:
    //   1. Authoritative Discord-side cache (known-channels.json)
    //   2. Clean records found during the scan
    //   3. Seeded from discovered channel metadata (for the query's targets)
    const parentNames = buildParentNameMap(matches)
    for (const [id, name] of Object.entries(knownChannels)) {
      parentNames.set(id, name)
    }
    for (const ch of targets) {
      if (ch.name) parentNames.set(ch.id, ch.name)
    }
    for (const msg of limited) {
      process.stdout.write(formatText(msg, showChannel, parentNames) + '\n')
    }
    const totalNote = matches.length > args.limit
      ? ` (showing most recent ${args.limit} of ${matches.length})`
      : ` (${matches.length} messages)`
    process.stderr.write(`\n— end${totalNote}\n`)
  }
}

main()
