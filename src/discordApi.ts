/**
 * Thin wrapper around the Discord REST API for dispatcher-side thread and
 * message operations that don't require the gateway connection.
 *
 * Used by project mode: the CoS (or the kickoff watcher) needs to create a
 * new thread and post a seed message without holding a long-lived
 * discord.js gateway connection in a short-lived script.
 *
 * All functions use `fetch` directly — no discord.js dependency at the
 * call site. The bot token is read from the existing dispatcher config.
 */

import { DISCORD_BOT_TOKEN } from './config.js'
import { logDispatcher } from './logger.js'

const DISCORD_API = 'https://discord.com/api/v10'

function authHeaders(): Record<string, string> {
  return {
    Authorization: `Bot ${DISCORD_BOT_TOKEN}`,
    'Content-Type': 'application/json',
    'User-Agent': 'GenericDispatcher/1.0 (local)',
  }
}

async function discordFetch(path: string, init: RequestInit): Promise<Response> {
  const res = await fetch(`${DISCORD_API}${path}`, {
    ...init,
    headers: { ...authHeaders(), ...(init.headers ?? {}) },
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(
      `Discord API ${init.method ?? 'GET'} ${path} → ${res.status}: ${body.slice(0, 300)}`,
    )
  }
  return res
}

/**
 * Create a public thread inside a channel with no starter message.
 * Returns the created thread's ID.
 */
export async function createPublicThread(opts: {
  parentChannelId: string
  name: string
  autoArchiveMinutes?: 60 | 1440 | 4320 | 10080
}): Promise<{ id: string; name: string }> {
  const res = await discordFetch(`/channels/${opts.parentChannelId}/threads`, {
    method: 'POST',
    body: JSON.stringify({
      name: opts.name.slice(0, 100),
      auto_archive_duration: opts.autoArchiveMinutes ?? 1440,
      type: 11, // PUBLIC_THREAD without a starter message
    }),
  })
  const body = (await res.json()) as { id: string; name: string }
  logDispatcher('discord_thread_created', {
    threadId: body.id,
    parentChannelId: opts.parentChannelId,
    name: body.name,
  })
  return { id: body.id, name: body.name }
}

/** Post a plain-text message to a channel or thread. Returns the message ID. */
export async function postMessage(
  channelId: string,
  content: string,
): Promise<{ id: string }> {
  const res = await discordFetch(`/channels/${channelId}/messages`, {
    method: 'POST',
    body: JSON.stringify({ content: content.slice(0, 2000) }),
  })
  const body = (await res.json()) as { id: string }
  return { id: body.id }
}

/**
 * Resolve a channel/thread's parent_id — used by project kickoff so a
 * project thread is created under the same parent channel as the origin
 * thread, keeping things contextually close in Discord.
 */
export async function getChannelParent(channelId: string): Promise<string | null> {
  const res = await discordFetch(`/channels/${channelId}`, { method: 'GET' })
  const body = (await res.json()) as { parent_id?: string | null }
  return body.parent_id ?? null
}

/**
 * Resolve a channel's name — used by the tender classifier (Phase H §12.3)
 * to detect tender-bearing channels by substring match. Returns null if
 * the API response lacks a name field (rare; happens for some thread
 * types pre-population).
 */
export async function getChannelName(channelId: string): Promise<string | null> {
  const res = await discordFetch(`/channels/${channelId}`, { method: 'GET' })
  const body = (await res.json()) as { name?: string | null }
  return body.name ?? null
}
