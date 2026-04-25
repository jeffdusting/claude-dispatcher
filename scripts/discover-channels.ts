#!/usr/bin/env bun
/**
 * Discover the guilds and channels the dispatcher bot can see — via REST only.
 *
 * Uses the Discord HTTP API (no gateway connection), so this is safe to run
 * while the live dispatcher is connected with the same bot token.
 *
 * For each readable-type channel, resolves the bot's effective permissions
 * by combining the guild's base permissions (via @everyone + bot role
 * memberships) with channel-level overwrites.
 *
 * Usage:
 *   bun run scripts/discover-channels.ts
 *   bun run scripts/discover-channels.ts --format json
 *   bun run scripts/discover-channels.ts --guild DiscordRiver
 */

import { REST } from '@discordjs/rest'
import { Routes, ChannelType, PermissionsBitField, PermissionFlagsBits } from 'discord.js'
import { writeFileSync } from 'fs'
import { join } from 'path'
import { DISCORD_BOT_TOKEN, STATE_DIR, loadAccess, ingestChannelIds } from '../src/config.js'

const KNOWN_CHANNELS_FILE = join(STATE_DIR, 'known-channels.json')

interface Args {
  format: 'text' | 'json'
  guild?: string
  /** Write channel metadata to state/known-channels.json for query-channels.ts to use */
  writeCache?: boolean
}

function parseArgs(argv: string[]): Args {
  const args: Args = { format: 'text' }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => {
      const v = argv[++i]
      if (v === undefined) throw new Error(`Flag ${a} requires a value`)
      return v
    }
    switch (a) {
      case '--format':
      case '-f': {
        const f = next()
        if (f !== 'text' && f !== 'json') throw new Error(`--format must be text|json`)
        args.format = f
        break
      }
      case '--guild':
      case '-g':
        args.guild = next()
        break
      case '--write-cache':
        args.writeCache = true
        break
      case '--help':
      case '-h':
        process.stdout.write(
          'Usage: discover-channels.ts [--format text|json] [--guild <name or id>]\n',
        )
        process.exit(0)
      default:
        throw new Error(`Unknown flag: ${a}`)
    }
  }
  return args
}

// ─── Discord API types (minimal, only what we use) ────────────────

interface GuildSummary {
  id: string
  name: string
  approximate_member_count?: number
}

interface RawChannel {
  id: string
  type: number
  name?: string
  parent_id?: string | null
  position?: number
  permission_overwrites?: Array<{
    id: string
    type: 0 | 1 // 0 = role, 1 = member
    allow: string
    deny: string
  }>
}

interface RawGuildMember {
  roles: string[]
  user?: { id: string }
}

interface RawRole {
  id: string
  name: string
  permissions: string
  position: number
}

interface RawGuild {
  id: string
  name: string
  owner_id: string
  roles: RawRole[]
}

interface DiscoveredChannel {
  id: string
  name: string
  type: string
  category?: string
  botCanView: boolean
  botCanReadHistory: boolean
  alreadyIngested: boolean
  alreadyTriggers: boolean
}

interface DiscoveredGuild {
  id: string
  name: string
  memberCount: number | null
  channels: DiscoveredChannel[]
}

const READABLE_TYPES = new Set<number>([
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
  ChannelType.GuildForum,
])

const TYPE_LABEL: Record<number, string> = {
  [ChannelType.GuildText]: 'text',
  [ChannelType.GuildAnnouncement]: 'announcement',
  [ChannelType.GuildForum]: 'forum',
  [ChannelType.GuildVoice]: 'voice',
  [ChannelType.GuildStageVoice]: 'stage',
  [ChannelType.GuildCategory]: 'category',
}

// ─── Permission calculation ───────────────────────────────────────
//
// Discord permission model:
//   base = union of @everyone role perms and any role perms the member has
//   if base includes ADMINISTRATOR or member is guild owner, all perms granted
//   otherwise per-channel overwrites applied in order:
//     1) @everyone overwrite (allow then deny)
//     2) role overwrites — union of allows, union of denies (denies applied first)
//     3) member overwrite (allow then deny)

function computeChannelPerms(
  channel: RawChannel,
  guild: RawGuild,
  botMember: RawGuildMember,
  botUserId: string,
): bigint {
  const everyoneRole = guild.roles.find((r) => r.id === guild.id)!

  let base = BigInt(everyoneRole.permissions)
  for (const roleId of botMember.roles) {
    const role = guild.roles.find((r) => r.id === roleId)
    if (role) base |= BigInt(role.permissions)
  }

  // Admin short-circuit
  if ((base & PermissionFlagsBits.Administrator) === PermissionFlagsBits.Administrator) {
    return ~0n
  }
  if (guild.owner_id === botUserId) return ~0n

  const overwrites = channel.permission_overwrites ?? []

  // @everyone channel overwrite
  const everyoneOw = overwrites.find((o) => o.id === guild.id)
  if (everyoneOw) {
    base &= ~BigInt(everyoneOw.deny)
    base |= BigInt(everyoneOw.allow)
  }

  // Role overwrites (aggregate allow/deny for the bot's roles)
  let roleAllow = 0n
  let roleDeny = 0n
  for (const ow of overwrites) {
    if (ow.type !== 0) continue
    if (ow.id === guild.id) continue // already handled
    if (!botMember.roles.includes(ow.id)) continue
    roleAllow |= BigInt(ow.allow)
    roleDeny |= BigInt(ow.deny)
  }
  base &= ~roleDeny
  base |= roleAllow

  // Member overwrite
  const memberOw = overwrites.find((o) => o.type === 1 && o.id === botUserId)
  if (memberOw) {
    base &= ~BigInt(memberOw.deny)
    base |= BigInt(memberOw.allow)
  }

  return base
}

function has(perms: bigint, flag: bigint): boolean {
  return (perms & flag) === flag
}

// ─── Main ─────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const access = loadAccess()
  const ingestIds = ingestChannelIds(access)
  const triggerIds = new Set(Object.keys(access.groups ?? {}))

  const rest = new REST({ version: '10' }).setToken(DISCORD_BOT_TOKEN)

  // Identify the bot itself
  const me = (await rest.get(Routes.user('@me'))) as { id: string; username: string }

  // List guilds
  const allGuilds = (await rest.get(Routes.userGuilds())) as GuildSummary[]

  const filtered = args.guild
    ? allGuilds.filter(
        (g) => g.id === args.guild || g.name.toLowerCase().includes(args.guild!.toLowerCase()),
      )
    : allGuilds

  const results: DiscoveredGuild[] = []

  for (const gSummary of filtered) {
    let guild: RawGuild
    let channels: RawChannel[]
    let botMember: RawGuildMember
    try {
      // Fetch full guild (includes roles)
      guild = (await rest.get(Routes.guild(gSummary.id))) as RawGuild
      channels = (await rest.get(Routes.guildChannels(gSummary.id))) as RawChannel[]
      botMember = (await rest.get(Routes.guildMember(gSummary.id, me.id))) as RawGuildMember
    } catch (err) {
      process.stderr.write(
        `Warning: failed to load guild ${gSummary.name} (${gSummary.id}): ${(err as Error).message}\n`,
      )
      continue
    }

    // Category name lookup
    const categoryNames = new Map<string, string>()
    for (const ch of channels) {
      if (ch.type === ChannelType.GuildCategory && ch.name) {
        categoryNames.set(ch.id, ch.name)
      }
    }

    const readable = channels.filter((c) => READABLE_TYPES.has(c.type))

    const enriched: DiscoveredChannel[] = readable.map((ch) => {
      const perms = computeChannelPerms(ch, guild, botMember, me.id)
      return {
        id: ch.id,
        name: ch.name ?? '(unnamed)',
        type: TYPE_LABEL[ch.type] ?? `type${ch.type}`,
        category: ch.parent_id ? categoryNames.get(ch.parent_id) : undefined,
        botCanView: has(perms, PermissionFlagsBits.ViewChannel),
        botCanReadHistory: has(perms, PermissionFlagsBits.ReadMessageHistory),
        alreadyIngested: ingestIds.has(ch.id),
        alreadyTriggers: triggerIds.has(ch.id),
      }
    })

    enriched.sort((a, b) => {
      const cat = (a.category ?? '').localeCompare(b.category ?? '')
      if (cat !== 0) return cat
      return a.name.localeCompare(b.name)
    })

    results.push({
      id: guild.id,
      name: guild.name,
      memberCount: gSummary.approximate_member_count ?? null,
      channels: enriched,
    })
  }

  // Write the channel-name cache if requested. Written as a flat map
  // {channelId: name} so query-channels.ts can do a cheap lookup.
  if (args.writeCache) {
    const map: Record<string, string> = {}
    for (const g of results) {
      for (const c of g.channels) {
        map[c.id] = c.name
      }
    }
    writeFileSync(KNOWN_CHANNELS_FILE, JSON.stringify(map, null, 2))
    process.stderr.write(`Wrote ${Object.keys(map).length} channel names to ${KNOWN_CHANNELS_FILE}\n`)
  }

  if (args.format === 'json') {
    process.stdout.write(JSON.stringify(results, null, 2) + '\n')
    return
  }

  if (results.length === 0) {
    process.stdout.write('Bot is not in any matching guilds.\n')
    return
  }

  for (const g of results) {
    process.stdout.write(
      `\n━━━ ${g.name}  (guild ${g.id}, ${g.memberCount ?? '?'} members) ━━━\n`,
    )
    if (g.channels.length === 0) {
      process.stdout.write('  (no readable channels visible)\n')
      continue
    }
    let lastCategory = '\x00'
    for (const c of g.channels) {
      const cat = c.category ?? '(uncategorised)'
      if (cat !== lastCategory) {
        process.stdout.write(`\n  [${cat}]\n`)
        lastCategory = cat
      }
      const flags: string[] = []
      if (!c.botCanView) flags.push('NO-VIEW')
      if (c.botCanView && !c.botCanReadHistory) flags.push('NO-HISTORY')
      if (c.alreadyIngested) flags.push('ingested')
      if (c.alreadyTriggers) flags.push('trigger')
      const flagStr = flags.length > 0 ? `  [${flags.join(', ')}]` : ''
      process.stdout.write(
        `    ${c.id.padEnd(20)}  #${c.name.padEnd(30)}  ${c.type.padEnd(12)}${flagStr}\n`,
      )
    }
  }

  const total = results.reduce((n, g) => n + g.channels.length, 0)
  const visible = results.reduce(
    (n, g) => n + g.channels.filter((c) => c.botCanView && c.botCanReadHistory).length,
    0,
  )
  process.stdout.write(
    `\nSummary: ${results.length} guild(s), ${total} readable-type channel(s), ${visible} fully accessible by bot.\n`,
  )
}

main().catch((err) => {
  process.stderr.write(`Error: ${(err as Error).message}\n${(err as Error).stack}\n`)
  process.exit(1)
})
