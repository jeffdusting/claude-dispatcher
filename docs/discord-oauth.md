# Discord bot OAuth scopes and permissions

Operational reference for the dispatcher's Discord bot. Source of truth for what scopes and channel permissions the bot is allowed to hold. Reviewed under S-011 (architecture review 01) during Phase A.2.

## 1. OAuth2 scopes (application-level)

The bot install URL grants the following OAuth2 scopes:

- `bot` — the bot user is added to the guild.
- `applications.commands` — slash commands (reserved; not currently used, but kept on the install URL for future use).

Anything broader (e.g. `guilds`, `guilds.members.read`, `messages.read` user-token scopes) is out of scope. The dispatcher operates on the gateway with the bot token only.

## 2. Bot permissions (channel/guild-level)

Constrained to the minimum set required for the dispatcher's actual behaviour. Grant these on the install URL via the permissions integer; do not grant `Administrator` or any management permission.

| Permission | Flag bit | Why the dispatcher needs it |
|---|---:|---|
| View Channels | `1 << 10` (1024) | Receive messages on the gateway. |
| Send Messages | `1 << 11` (2048) | Reply in parent channels and DMs. |
| Embed Links | `1 << 14` (16384) | Render `outbox/*.md` previews and link cards. |
| Attach Files | `1 << 15` (32768) | Upload files generated in the session's outbox. |
| Read Message History | `1 << 16` (65536) | Reattach to existing threads and read context. |
| Add Reactions | `1 << 6` (64) | Reaction-driven affordances (see `gateway.ts` reaction handlers). |
| Create Public Threads | `1 << 35` (34359738368) | Per-task thread creation in supported channels. |
| Send Messages in Threads | `1 << 38` (274877906944) | Reply inside the per-task thread. |
| Manage Threads | `1 << 34` (17179869184) | Set `THREAD_AUTO_ARCHIVE_MINUTES` and rename threads after Drive folder rename. |

Resulting permissions integer: **326434611160**.

The dispatcher does NOT need and MUST NOT be granted: `Administrator`, `Manage Server`, `Manage Roles`, `Manage Channels`, `Kick Members`, `Ban Members`, `Mention Everyone`, `Manage Webhooks`, `Manage Emojis and Stickers`, `Move Members`, `Mute Members`, `Deafen Members`, `Use Voice Activity`, `Priority Speaker`.

## 3. Gateway intents (declared in code)

Distinct from OAuth/bot permissions — these are the WebSocket gateway intents the dispatcher subscribes to. Set in `src/gateway.ts` via `GatewayIntentBits`:

- `Guilds` — guild lifecycle events.
- `GuildMessages` — message events in guild channels.
- `GuildMessageReactions` — reaction events in guild channels.
- `MessageContent` — privileged intent; required for the bot to read message bodies (not just metadata). Must be enabled in the Developer Portal.
- `DirectMessages` — DM messages to the bot.

`GuildMembers` and `GuildPresences` are deliberately not requested — they are privileged intents the dispatcher does not need.

## 4. Verification checklist

Use this list when applying or reviewing the constraint:

- 4.1 Open the Discord Developer Portal entry for the dispatcher application. URL pattern: `https://discord.com/developers/applications/<APP_ID>/oauth2/url-generator`.
- 4.2 Confirm OAuth2 scopes list shows only `bot` and `applications.commands`.
- 4.3 Under the Bot Permissions section, confirm only the nine permissions in §2 are ticked. Untick anything else.
- 4.4 Confirm the resulting permissions integer matches **326434611160** (or the recomputed value if any permission is intentionally added or removed).
- 4.5 Under the Bot tab, confirm only `Server Members Intent` is OFF, only `Presence Intent` is OFF, and `Message Content Intent` is ON.
- 4.6 If permissions were tightened, re-invite the bot to each guild it currently sits in (Discord caches old grants per-guild; the new install URL is the simplest re-grant path).

## 5. Audit cadence

Review §2 and §3 annually, or whenever the dispatcher gains a new feature class (slash commands, voice channels, role assignment, etc.). Phase J.4 retrospective is the natural first review point.

## 6. Document control

| Item | Value |
|---|---|
| Document | Dispatcher Discord OAuth scopes and permissions |
| Status | Active. Source of truth. |
| Created | 2026-04-26 (Phase A.2 / S-011) |
| Owner | Operator |
