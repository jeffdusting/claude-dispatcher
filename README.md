# Generic Dispatcher

Multi-session orchestrator for the `#generic` Discord channel. Replaces the single-session Discord MCP plugin with a system where each task gets its own Discord thread and independent Claude Code session.

## What it does

1. Pat @mentions the bot in `#generic` with a task
2. Dispatcher creates a Discord thread with an LLM-generated title
3. A fresh `claude -p --agent chief-of-staff` session spawns with its own context window
4. Chief-of-staff triages and delegates to specialist agents (researcher, report-writer, etc.)
5. All responses post back to the thread
6. Follow-up messages in the thread resume the same session
7. A second message in `#generic` starts a second thread and second session — fully independent

## Architecture

```
Discord #generic
    │
    ▼
┌────────────────────────────────┐
│     DISPATCHER (Bun process)   │
│                                │
│  discord.js gateway            │
│  Session registry (thread→ID)  │
│  Rate limiter / circuit breaker│
│  Cost & usage tracking         │
└────────┬───────────────────────┘
         │
   ┌─────┼─────┐
   ▼     ▼     ▼
 Session 1  Session 2  Session 3     ← independent claude -p processes
 (thread)   (thread)   (thread)
   │         │          │
   chief-of-staff → specialist agents (researcher, report-writer, etc.)
```

Each session runs as a child process via `claude -p --output-format stream-json`. Sessions are spawned on demand and resumed by ID for follow-ups. The agent definitions in `.claude/agents/` are loaded automatically — no changes needed.

## Prerequisites

- **Bun** (tested with 1.3.x)
- **Claude Code CLI** (`~/.local/bin/claude`) with active OAuth subscription
- **Discord bot token** already configured at `~/.claude/channels/discord/.env`
- **Discord access config** at `~/.claude/channels/discord/access.json` (set up via `/discord:access`)

## Setup

```bash
cd ~/claude-workspace/generic/dispatcher
bun install
```

No additional configuration needed — the dispatcher reads the existing bot token and access control config from the Discord plugin's state directory.

## Running

### Production (recommended)

```bash
./start.sh --tmux
```

This launches the dispatcher in a tmux session named `generic-dispatcher` with auto-restart on crash (exponential backoff, max 10 restarts per 10 minutes).

```bash
# Attach to see output
tmux attach -t generic-dispatcher

# Stop gracefully
./start.sh --stop
```

### Development

```bash
bun run src/index.ts       # foreground
bun --watch run src/index.ts  # auto-reload on file changes
```

### Important

The dispatcher and the Discord MCP plugin cannot run simultaneously on the same bot token. Stop the existing Claude Code session (`claude --channels plugin:discord@...`) before starting the dispatcher.

## Discord commands

Send these in `#generic` (with @mention) or in any dispatcher thread:

| Command | Description |
|---------|-------------|
| `!status` | Active sessions, queue depth, health, uptime |
| `!stats` | Daily stats: sessions, turns, costs, errors, circuit breaker state |

## How sessions work

### New task

A message in `#generic` (not in a thread) creates a new session:

- Dispatcher generates a thread title via a fast Haiku call
- Creates a Discord thread under the original message
- Spawns `claude -p --agent chief-of-staff --resume <none>`
- Posts a "Working..." message that updates with elapsed time
- On completion, posts the response and any new files from `outbox/`

### Follow-up

A message in an existing thread resumes the session:

- Dispatcher looks up the thread's session ID in the registry
- Spawns `claude -p --resume <sessionId>` with the follow-up as prompt
- Full conversation history is preserved from the original session
- If the session ID is stale (expired/cleaned up), automatically starts a fresh session

### Queue

If a follow-up arrives while the session is busy:

- Message is queued (max 10 per thread) with a ⏳ reaction
- Queue position shown if depth > 1
- When the current turn completes, queued messages are drained and processed in order

## Resilience

| Feature | Behaviour |
|---------|-----------|
| **Auto-restart** | `start.sh` restarts on crash with exponential backoff (2s → 60s) |
| **Circuit breaker** | After 5 consecutive Claude errors, pauses new tasks for 60s |
| **Rate limiter** | Max 15 messages/minute; excess get a 🐌 reaction |
| **Stale session recovery** | If `--resume` fails, falls back to a fresh session transparently |
| **Graceful shutdown** | SIGTERM/SIGINT persists session registry, saves daily report, disconnects cleanly |
| **Crash recovery** | On restart, session registry reloads from disk; busy sessions marked idle |
| **Unhandled errors** | Caught and logged instead of crashing the process |

## Logging

All logs write to `~/claude-workspace/generic/logs/`:

| File | Contents |
|------|----------|
| `YYYY-MM-DD-dispatcher.jsonl` | Dispatcher events: spawns, completions, errors, gateway, heartbeats |
| `YYYY-MM-DD-sessions.jsonl` | Session lifecycle: created, idle, error, expired, queue events |
| `YYYY-MM-DD-session.jsonl` | Tool-level events from Claude Code hooks (if configured) |
| `YYYY-MM-DD-daily-report.json` | Aggregated daily stats: sessions, turns, costs, errors |

### Review script

```bash
cd ~/claude-workspace/generic/logs

./review.sh                # full review for today (all log sources)
./review.sh 2026-04-11     # specific date
./review.sh dispatcher     # dispatcher event timeline only
./review.sh daily          # raw daily report JSON
./review.sh latest         # most recent session log
```

## Limits

| Limit | Default | Config location |
|-------|---------|-----------------|
| Max concurrent busy sessions | 5 | `config.ts → MAX_CONCURRENT_BUSY` |
| Max tracked sessions | 50 | `config.ts → MAX_TRACKED_SESSIONS` |
| Max queued messages per thread | 10 | `config.ts → MAX_QUEUED_MESSAGES` |
| Session idle timeout | 4 hours | `config.ts → SESSION_IDLE_TIMEOUT_MS` |
| Session cleanup | 24 hours | `config.ts → SESSION_CLEANUP_MS` |
| Thread auto-archive | 24 hours | `config.ts → THREAD_AUTO_ARCHIVE_MINUTES` |
| Rate limit | 15 msgs/min | `health.ts → RATE_LIMIT_MAX` |
| Circuit breaker threshold | 5 errors | `health.ts → CIRCUIT_BREAKER_THRESHOLD` |
| Circuit breaker cooldown | 60 seconds | `health.ts → CIRCUIT_BREAKER_COOLDOWN_MS` |

## File structure

```
dispatcher/
├── src/
│   ├── index.ts       # Entry point, lifecycle, heartbeat, shutdown
│   ├── config.ts      # Constants, bot token, access + ingest config
│   ├── gateway.ts     # Discord connection, routing, threads, commands
│   ├── sessions.ts    # Session registry, queue, persistence
│   ├── claude.ts      # Claude CLI wrapper, stream parsing, outbox diff
│   ├── health.ts      # Rate limiter, circuit breaker, cost tracking
│   ├── chunker.ts     # Message splitting for Discord's 2000 char limit
│   ├── logger.ts      # Structured JSONL logging
│   └── ingest.ts      # Passive channel archive (see "Channel ingestion")
├── scripts/
│   ├── query-channels.ts    # CLI for querying the ingested archive
│   └── discover-channels.ts # CLI for listing guild channels + writing name cache
├── state/
│   ├── sessions.json          # Persisted session registry
│   ├── health.json            # Health state
│   ├── ingest-cursors.json    # Last-ingested snowflake per channel
│   ├── known-channels.json    # Discord-authoritative channel name cache
│   └── channels/              # Per-channel JSONL message archive
├── attachments/       # Downloaded Discord attachments
├── start.sh           # Production startup with auto-restart
├── package.json
└── tsconfig.json
```

## Channel ingestion (cross-channel context)

The dispatcher can passively ingest messages from additional Discord channels into a shared archive that any Claude session can query. This is separate from the trigger/task path — ingested channels don't spawn sessions; they just get logged.

### Enable

Add an `ingest` block to `~/.claude/channels/discord/access.json`:

```json
{
  "dmPolicy": "deny",
  "allowFrom": [],
  "groups": { "1495629402908921876": { "requireMention": true } },
  "ingest": {
    "channels": [
      "1400000000000000001",
      "1400000000000000002"
    ],
    "includeBots": true,
    "retentionDays": 90,
    "backfillLimit": 500
  },
  "pending": {}
}
```

The bot must be invited to the guild with **View Channel** + **Read Message History** on every channel listed. Channels already in `groups` are automatically ingested too (no need to list them twice).

### Storage layout

```
dispatcher/state/
├── channels/
│   ├── {channelId}/
│   │   ├── 2026-04-18.jsonl   # one message per line, UTC-partitioned
│   │   ├── 2026-04-19.jsonl
│   │   └── ...
│   └── {otherChannelId}/...
└── ingest-cursors.json        # last ingested snowflake per channel
```

Attachments are stored as metadata + URL only — their binary content is not copied until a session fetches it on demand.

### Retention

Files older than `retentionDays` (default 90) are deleted. The sweep runs once on boot and once every 24 hours thereafter.

### Backfill on startup

On each restart, the dispatcher fetches up to `backfillLimit` (default 500) recent messages per channel and stores any newer than the last-seen cursor. This keeps the archive continuous across restarts — no blind spots.

### Channel name cache

The query tool resolves channel names primarily from the ingested records themselves, but thread-only archives (records where every message was posted inside a thread) don't hold the parent channel's name. To guarantee correct labelling, populate an authoritative cache from Discord's REST API:

```bash
bun run scripts/discover-channels.ts --write-cache
```

This writes `state/known-channels.json` (a flat `{channelId: name}` map) which `query-channels.ts` reads on every run. Safe to re-run after renaming channels or adding new ones. Rerun after any significant channel changes.

### Querying from within a session

Use the query script to pull messages on demand:

```bash
bun run scripts/query-channels.ts --list
bun run scripts/query-channels.ts --channel tenders --since 24h
bun run scripts/query-channels.ts --channel 140000...01 --grep "contract" --limit 50
bun run scripts/query-channels.ts --all --since 6h --author jad0404
bun run scripts/query-channels.ts --channel general --since 2026-04-15 --until 2026-04-19 --format json
```

Filters:

| Flag | Purpose |
|------|---------|
| `--list` | Show all ingested channels with message counts |
| `--channel, -c` | Channel ID or partial name match |
| `--all` | Query across every ingested channel |
| `--since, -s` | ISO date/datetime, or relative (`30m`, `24h`, `7d`) |
| `--until, -u` | Upper time bound (same format) |
| `--author, -a` | Case-insensitive substring match on username |
| `--grep, -g` | Regex (case-insensitive) against message content |
| `--limit, -n` | Max messages (default 200; returns most recent if truncated) |
| `--format, -f` | `text` (default) or `json` |

The Chief-of-Staff agent should invoke this script via the Bash tool whenever cross-channel context is relevant to the user's request.

## Future work

- **Phase 3 — Permission relay**: In-thread permission buttons instead of `bypassPermissions` mode. Would allow fine-grained approval for destructive operations (Bash, Edit outside outbox/).
- **Per-channel agent configuration**: Different agents for different trigger channels (e.g. `#investing` routes to a different system prompt).
- **Streaming responses**: Post incremental output to Discord as Claude generates it, rather than waiting for completion.
- **Semantic search over ingested channels**: Embed JSONL content for similarity queries, not just regex/substring.
