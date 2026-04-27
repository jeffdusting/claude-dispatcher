# Generic Dispatcher

Multi-session orchestrator for the `#generic` Discord channel. Replaces the single-session Discord MCP plugin with a system where each task gets its own Discord thread and independent Claude Code session.

The dispatcher runs in two deployment modes:

- **Cloud (production)** — single persistent Fly.io machine in Sydney with a mounted `/data` volume. The Fly platform supervises the process; the in-image `entrypoint.sh` execs `bun run src/index.ts` under `tini` (PID 1). No `start.sh` restart loop is used in this mode (Δ D-007 / R-002).
- **Laptop (development / warm spare)** — `start.sh --tmux` runs the dispatcher in a tmux session with auto-restart on crash. This is the legacy supervision path; it is retained for laptop development and the Phase F warm-spare role.

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
       ┌──────────────────────────────────┐
       │   DISPATCHER (Bun, single machine)│
       │                                  │
       │   discord.js gateway             │
       │   Session registry (thread→ID)   │
       │   Project descriptors (entity-tagged)
       │   Rate limiter / circuit breaker │
       │   /health  (text/plain liveness) │
       └──────────────┬───────────────────┘
                      │ spawn per Discord message
        ┌─────────────┼─────────────┐
        ▼             ▼             ▼
      Session 1   Session 2     Session 3
      (CBS thread) (WR thread) (CBS thread)
        │             │             │
        ▼             ▼             ▼
      claude -p --agent chief-of-staff (one process per turn)
        │             │             │
        ▼             ▼             ▼
      Per-entity scoped env: CLAUDE_ENTITY, only that entity's
      Supabase service-role key, only that entity's Drive SA.
        │             │             │
        ▼             ▼             ▼
      Drive (CBS SA)  Drive (WR SA)  Drive (CBS SA)
```

Each session runs as a child process via `claude -p --output-format stream-json`. Sessions are spawned on demand and resumed by ID for follow-ups. The agent definitions in `.claude/agents/` are synced at boot into `~/.claude/agents/` (the user-level fallback Claude Code reads — see `docs/agent-loading` referenced in the migration pack).

## Prerequisites

- **Bun 1.3.12** (hard-pinned in the Dockerfile per Migration Plan §4.3.1)
- **Claude Code CLI** (`~/.local/bin/claude` on laptop; installed via `npm install -g @anthropic-ai/claude-code` in the image)
- **Discord bot token** at `~/.claude/channels/discord/.env` on laptop, or injected via `DISCORD_TOKEN` from 1Password on Fly (entrypoint.sh hook)
- **Discord access config** at `~/.claude/channels/discord/access.json` (set up via `/discord:access`)
- **Per-entity Drive credentials** — service-account JSON key + folder ID for each of CBS and WR (see Configuration → Multi-account Drive routing)

## Configuration

### Environment variables (Phase A.4)

The dispatcher reads paths and entity routing from environment variables with laptop-friendly defaults. Cloud values are set in `fly.toml [env]`; laptop dev keeps the existing `~/claude-workspace/generic/...` layout without any explicit env. The relevant variables are listed below.

| Variable | Default (laptop) | Cloud (`fly.toml`) | Purpose |
|---|---|---|---|
| `PROJECT_DIR` | `~/claude-workspace/generic` | `/app` | Root for derived paths |
| `DISPATCHER_DIR` | `<PROJECT_DIR>/dispatcher` | `/app` | Dispatcher source location |
| `STATE_DIR` | `<DISPATCHER_DIR>/state` | `/data/state` | Persistent state (sessions, health, projects, ingest) |
| `LOG_DIR` | `<PROJECT_DIR>/logs` | `/data/logs` | JSONL logs |
| `OUTBOX_DIR` | `<PROJECT_DIR>/outbox` | `/data/outbox` | Files Drive-mirrored to per-entity folders |
| `ATTACHMENT_DIR` | `<DISPATCHER_DIR>/attachments` | `/data/attachments` | Discord attachment downloads |
| `CBS_DRIVE_SA_KEY_PATH` | `<PROJECT_DIR>/.secrets/google-drive-sa.json` | (1Password fetch in Phase B.4) | CBS service-account JSON key |
| `CBS_DRIVE_FOLDER_ID` | from `.secrets/google-drive.env` or `.secrets/cbs-drive.env` | (1Password) | CBS root Drive folder |
| `WR_DRIVE_SA_KEY_PATH` | `<PROJECT_DIR>/.secrets/wr-drive-sa.json` | (1Password) | WR service-account JSON key |
| `WR_DRIVE_FOLDER_ID` | from `.secrets/wr-drive.env` | (1Password) | WR root Drive folder |
| `OPS_ALERT_CHANNEL_ID` | unset | set in Phase G | Tier-1 alert channel; unset → log only |
| `HEALTHCHECK_PORT` | `8080` | `8080` | Internal health HTTP port (matches `fly.toml [http_service].internal_port`) |
| `DISPATCHER_PAUSE_CRON` | unset | unset | Set to `1` to suppress scheduled routines without going full spare-mode |
| `DISPATCHER_ROLE` | `primary` | `primary` (cloud) / `spare` (laptop after cutover) | Selects warm-spare behaviour |

### Multi-account Drive routing (Phase A.5)

Each entity (`cbs`, `wr`) has its own service account and root folder. The dispatcher selects the credential pair at upload time based on the calling project's entity (resolved through `threadId → projectId → projects.entity` by `src/entityResolver.ts`). The default is `cbs` until a project is bound to a thread.

The routing rules are:

- Per-entity client cache and per-entity thread/subfolder caches live in `src/drive.ts`. Cache keys are entity-scoped, so cross-entity cache pollution is impossible by construction.
- Worker subprocesses receive `CLAUDE_ENTITY=<entity>` and have all other entities' Supabase service-role keys removed from the spawned env (`scopeWorkerEnv()` in `src/claude.ts`). A CBS worker cannot read `WR_SUPABASE_SERVICE_ROLE_KEY` and vice versa.
- Cross-entity Drive activity (where the upload entity differs from `CLAUDE_ENTITY`) emits a structured `cross_entity_drive_access` log event (Δ DA-013, on by default per OD-027; force-disable with `CROSS_ENTITY_AUDIT_ENABLED=false`).
- WR routing is silently disabled until `WR_DRIVE_SA_KEY_PATH` and `WR_DRIVE_FOLDER_ID` are populated; CBS-only deployments require no extra configuration.

### Outbox manifest and purge

`<OUTBOX_DIR>/.outbox-manifest.json` records `driveFileId`, `webViewLink`, `uploadedAt`, `size`, `mtimeMs` for every Drive upload. The purge script deletes manifest-confirmed files older than `--days` (default 7) where the local mtime still matches the manifest entry — files edited after upload are kept on disk:

```bash
bun run scripts/purge-outbox.ts --days 7 --dry-run --verbose
bun run scripts/purge-outbox.ts --days 7
```

## Setup

```bash
cd ~/claude-workspace/generic/dispatcher
bun install
```

No further configuration is required for the laptop default — the dispatcher reads the existing bot token and access config from `~/.claude/channels/discord/`. To run cloud-style locally, export the env vars from the table above.

## Running

### Cloud (Fly.io, production)

The image is built with the knowledge base supplied as a named build context:

```bash
docker build \
  --build-context kb=/Users/jeffdusting/Desktop/Projects2/River \
  -t cos-dispatcher .
```

Deploy:

```bash
fly deploy
```

The Fly machine runs the image directly. `tini` is PID 1; it execs `entrypoint.sh`, which fetches secrets from 1Password (Phase B.4) and execs `bun run src/index.ts`. The Fly platform handles restart on crash and SIGTERM on deploy. There is no `start.sh` in the cloud path — supervision is single-layer via the Fly machine.

### Laptop (development)

```bash
bun run src/index.ts            # foreground
bun --watch run src/index.ts    # auto-reload on file changes
./start.sh --tmux               # tmux session, auto-restart on crash
./start.sh --stop               # stop the tmux session
```

`start.sh` keeps the legacy exponential-backoff restart loop (max 10 restarts per 10 minutes) for laptop dev and warm-spare use. It is **not** used on Fly — the platform supervises the process there. Mixing both on the same machine would create the double-supervision pattern Δ D-007 / R-002 explicitly prohibits.

#### Codespace lifetime (Δ S-010)

GitHub Codespaces are deleted after 30 days of inactivity. Any dispatcher development inside a codespace must either commit and push within that window or accept that the codespace will be reaped. The 30-day clock resets on each connection, not each commit.

### Important — single bot token per session

The dispatcher and the Discord MCP plugin cannot run simultaneously on the same bot token. Stop the existing Claude Code session (`claude --channels plugin:discord@...`) before starting the dispatcher.

## Health endpoint (Phase A.7)

The dispatcher exposes a single public HTTP probe on `HEALTHCHECK_PORT` (8080):

| Path | State | Response |
|---|---|---|
| `GET /health` | alive | 200, body `ok`, content-type `text/plain` |
| `GET /health` | shutting down | 503, empty body |
| any other path | — | 404 |

The earlier rich-JSON `/health` (role, pid, memMB, circuit state, consecutive errors) was the S-008 information-leak surface and has been removed. Internal diagnostics still feed the in-process `!status` and `!stats` Discord commands, but the HTTP surface is now exactly one endpoint with two response variants.

`/health/integrations` (per-upstream probe) is deferred to Phase A.9 alongside the resilience layer it depends on (OD-033).

## Discord commands

Send these in `#generic` (with @mention) or in any dispatcher thread:

| Command | Description |
|---|---|
| `!status` | Active sessions, queue depth, health, uptime |
| `!stats` | Daily stats: sessions, turns, costs, errors, circuit breaker state |

## How sessions work

### New task

A message in `#generic` (not in a thread) creates a new session:

- Dispatcher generates a thread title via a fast Haiku call
- Creates a Discord thread under the original message
- Spawns `claude -p --agent chief-of-staff --resume <none>` with entity-scoped env
- Posts a "Working..." message that updates with elapsed time
- On completion, posts the response and any new files from `outbox/`

### Follow-up

A message in an existing thread resumes the session:

- Dispatcher looks up the thread's session ID in the registry
- Spawns `claude -p --resume <sessionId>` with the follow-up as prompt
- Full conversation history is preserved from the original session
- If the session ID is stale (expired/cleaned up), automatically starts a fresh session

### Queue

If a follow-up arrives while the session is busy, the message is queued (max 10 per thread) with a ⏳ reaction; queue position is shown if depth > 1; queued messages are drained in order when the current turn completes.

## Resilience

The current resilience surface is summarised below. Phase A.9 expands this with per-integration retry policies, per-integration circuit breakers, partial-failure recovery in project descriptors, an in-memory worker registry, per-worker memory observation, graceful-shutdown drain semantics, and a tier-2 SMS escalator for unack'd Discord alerts.

| Feature | Behaviour |
|---|---|
| **Cloud restart** | Fly machine restarts on crash; deploys send SIGTERM with a 120s wait window |
| **Laptop restart** | `start.sh` exponential backoff (2s → 60s), max 10 restarts per 10 minutes |
| **Circuit breaker** | After 5 consecutive Claude errors, pauses new tasks for 60s |
| **Rate limiter** | Max 15 messages/minute; excess get a 🐌 reaction |
| **Stale session recovery** | If `--resume` fails, falls back to a fresh session transparently |
| **Graceful shutdown** | SIGTERM/SIGINT marks `/health` as shutting-down (503), persists session registry, saves daily report, disconnects cleanly |
| **Crash recovery** | On restart, session registry reloads from disk; busy sessions marked idle; pending continuations re-armed |
| **Unhandled errors** | Caught and logged instead of crashing the process |

## Logging

All logs write to `LOG_DIR` (`<PROJECT_DIR>/logs` on laptop, `/data/logs` on Fly):

| File | Contents |
|---|---|
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
|---|---|---|
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
│   ├── index.ts            # Entry point, lifecycle, heartbeat, shutdown
│   ├── config.ts           # Env-driven constants, bot token, access + ingest config
│   ├── gateway.ts          # Discord connection, routing, threads, commands
│   ├── sessions.ts         # Session registry, queue, persistence
│   ├── claude.ts           # Claude CLI wrapper, stream parsing, outbox diff, env scoping
│   ├── projects.ts         # Project descriptors (entity-tagged, schema v2)
│   ├── entity.ts           # Entity type, defaults, audit flag
│   ├── entityResolver.ts   # threadId → projectId → entity resolution
│   ├── drive.ts            # Per-entity Drive client; cross-entity audit
│   ├── outboxManifest.ts   # Drive-upload manifest for purge gating
│   ├── health.ts           # /health server (liveness + shutdown), rate limiter, circuit breaker
│   ├── chunker.ts          # Message splitting for Discord's 2000 char limit
│   ├── logger.ts           # Structured JSONL logging
│   ├── ingest.ts           # Passive channel archive (see "Channel ingestion")
│   ├── agentSync.ts        # Boot-time rsync of .claude/agents into ~/.claude/agents/
│   ├── kickoffInbox.ts     # Schema-validated kickoff request drain (rejects to .rejected/)
│   ├── readJsonTolerant.ts # Version-tolerant JSON reader (Δ DA-001)
│   └── atomicWrite.ts      # Shared writeAtomic / writeJsonAtomic (D-001)
├── scripts/
│   ├── backfill-project-descriptors.ts  # v1 → v2 ProjectRecord migration
│   ├── purge-outbox.ts                  # Manifest-gated outbox purge
│   ├── query-channels.ts                # CLI for the ingested archive
│   ├── discover-channels.ts             # Channel name cache + listing
│   └── …                                # leo-monitor, send-sms, state-pull/push, etc.
├── docs/
│   ├── discord-oauth.md      # Constrained scope set per S-011
│   └── state-schemas.md      # Per-file schema + writer index
├── state/                    # Runtime state (env: STATE_DIR)
├── attachments/              # Discord attachment downloads (env: ATTACHMENT_DIR)
├── outbox/                   # Drive-mirrored output (env: OUTBOX_DIR)
├── start.sh                  # Laptop production startup (tmux + auto-restart) — laptop only
├── entrypoint.sh             # Cloud entrypoint under tini
├── Dockerfile
├── fly.toml
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
<STATE_DIR>/
├── channels/
│   ├── {channelId}/
│   │   ├── 2026-04-18.jsonl   # one message per line, UTC-partitioned
│   │   ├── 2026-04-19.jsonl
│   │   └── …
│   └── {otherChannelId}/…
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

This writes `<STATE_DIR>/known-channels.json` (a flat `{channelId: name}` map) which `query-channels.ts` reads on every run. Safe to re-run after renaming channels or adding new ones.

### Querying from within a session

```bash
bun run scripts/query-channels.ts --list
bun run scripts/query-channels.ts --channel tenders --since 24h
bun run scripts/query-channels.ts --channel 140000...01 --grep "contract" --limit 50
bun run scripts/query-channels.ts --all --since 6h --author jad0404
bun run scripts/query-channels.ts --channel general --since 2026-04-15 --until 2026-04-19 --format json
```

Filters:

| Flag | Purpose |
|---|---|
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

## Autonomous continuation

The dispatcher spawns `claude -p` as a one-shot process per Discord message. When an agent finishes its response, the process exits. That means any in-process `ScheduleWakeup` call is a no-op under this deployment — there's no long-running process to wake.

To support multi-turn work without requiring the user to nudge, the dispatcher implements a **continuation file protocol**:

1. Before ending its response, an agent writes a JSON descriptor to `$CLAUDE_CONTINUE_FILE` (set automatically by the dispatcher, unique per thread).
2. After the turn completes, the dispatcher reads and deletes the file, validates it, and schedules a `setTimeout` for the requested delay.
3. When the timer fires, the dispatcher re-invokes the same Claude session (via `--resume`) with the stored prompt.
4. A user message in the thread always supersedes the pending continuation — the timer is cancelled and the user's message runs instead.
5. Pending continuations are persisted in `state/sessions.json` so they survive a dispatcher restart. On boot, timers are re-armed with remaining time; overdue ones fire immediately.

### Helper script

Agents call the helper from Bash:

```bash
~/claude-workspace/generic/dispatcher/scripts/continue_when.sh \
  --delay 900 \
  --reason "continuing Stage 2 build" \
  --prompt "Resume work on the shadow-mode review helper..."
```

### File schema

Written to `<STATE_DIR>/continuations/<threadId>.json`:

```json
{
  "delay_seconds": 900,
  "reason": "short one-liner for Discord visibility",
  "prompt": "the prompt the dispatcher will fire back at the session",
  "thread_id": "1495997222234488862",
  "created_at": "2026-04-22T11:57:00Z"
}
```

### Constraints and safeties

| Concern | Behaviour |
|---|---|
| Delay clamping | `[60, 3600]` seconds. Smaller/larger values are clamped. |
| Per-thread isolation | File path includes threadId; no cross-thread collisions. |
| User supersession | Any user message cancels the pending timer. |
| Session busy at fire-time | Continuation prompt is queued behind the current turn. |
| Restart recovery | Pending continuations are persisted; timers re-arm on boot. |
| Stale session | If `--resume` fails at fire-time, falls back to a fresh session and carries the prompt forward. |
| Malformed file | Logged, file deleted, no continuation scheduled. |

### Discord visibility

- `⏭ Auto-continue scheduled for HH:MM (N min): <reason>` — posted after the turn that scheduled it
- `⏯ Auto-continuing: <reason>` — posted when the timer fires and the session re-runs

### Event logs

| Event | Written to |
|---|---|
| `continuation_scheduled` | dispatcher log |
| `continuation_timer_cancelled` | dispatcher log (user message superseded) |
| `continuation_superseded_by_user` | dispatcher log |
| `continuation_restored` | dispatcher log (on boot) |
| `continuation_fire_error` | dispatcher log |

## Future work

- **Phase A.9 — Resilience layer**: per-integration retries and circuit breakers, partial-failure recovery, worker registry with hung-worker sweep, concurrent-worker queue, per-worker memory observation, graceful shutdown drain (90s), tier-2 SMS escalator, Anthropic per-consumer budget tracking. `/health/integrations` ships with this phase (OD-033).
- **Phase A.10 — Test scaffolding**: Bun test runner with the 18 pre-existing TypeScript errors cleaned and CI typecheck flipped strict.
- **Phase A.11 — Correlation-ID propagation**: end-to-end trace IDs across dispatcher, Drive uploads, and KB queries (Δ DA-013).
- **Phase 3 — Permission relay**: in-thread permission buttons instead of `bypassPermissions` mode. Would allow fine-grained approval for destructive operations (Bash, Edit outside outbox/).
- **Per-channel agent configuration**: different agents for different trigger channels (e.g. `#investing` routes to a different system prompt).
- **Streaming responses**: post incremental output to Discord as Claude generates it, rather than waiting for completion.
- **Semantic search over ingested channels**: embed JSONL content for similarity queries, not just regex/substring.
