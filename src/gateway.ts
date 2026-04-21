/**
 * Discord gateway — handles inbound messages, thread creation, and outbound replies.
 *
 * Phase 2 additions:
 * - Progress indicator (editable "Working..." message)
 * - Typing indicator while processing
 * - Stale session recovery (fallback to new session if --resume fails)
 * - Attachment downloading and passing to Claude
 * - Outbox file detection (auto-attach new files to thread)
 * - !status command
 * - Queue position feedback
 */

import {
  Client,
  GatewayIntentBits,
  type Message,
  type MessageReaction,
  type ThreadChannel,
  type TextBasedChannel,
  type User,
  type PartialMessageReaction,
  type PartialUser,
} from 'discord.js'
import { mkdirSync, createWriteStream } from 'fs'
import { join, basename } from 'path'
import {
  DISCORD_BOT_TOKEN,
  THREAD_AUTO_ARCHIVE_MINUTES,
  MAX_CONCURRENT_BUSY,
  PROGRESS_UPDATE_MS,
  ATTACHMENT_DIR,
  loadAccess,
} from './config.js'
import {
  getSession,
  createSession,
  markBusy,
  markIdle,
  markError,
  clearSessionId,
  queueMessage,
  queueDepth,
  drainQueue,
  busyCount,
  getStatusSummary,
} from './sessions.js'
import { runSession, generateTitle, snapshotOutbox, diffOutbox, type OutputFile } from './claude.js'
import { chunk } from './chunker.js'
import { logDispatcher } from './logger.js'
import { ingestMessage, backfillAll } from './ingest.js'
import {
  checkRateLimit,
  isCircuitOpen,
  recordSuccess,
  recordError,
  trackMessageReceived,
  trackMessageQueued,
  trackSessionCreated,
  trackTurnCompleted,
  trackSessionError,
  getStatsReport,
  getHealthLine,
} from './health.js'

mkdirSync(ATTACHMENT_DIR, { recursive: true })

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
})

// Track recent messages we sent (to avoid replying to ourselves)
const recentSentIds = new Set<string>()

// ─── Access Control ───────────────────────────────────────────────

function shouldProcess(msg: Message): boolean {
  if (msg.author.bot) return false

  const access = loadAccess()

  // Thread message — check if parent channel is allowed
  if (msg.channel.isThread()) {
    const parentId = msg.channel.parentId
    if (!parentId || !(parentId in access.groups)) return false
    const policy = access.groups[parentId]!
    if (policy.allowFrom && policy.allowFrom.length > 0) {
      if (!policy.allowFrom.includes(msg.author.id)) return false
    }
    return true // threads don't require mention
  }

  // Channel message — check groups and mention requirement
  if (!(msg.channelId in access.groups)) return false
  const policy = access.groups[msg.channelId]!
  if (policy.allowFrom && policy.allowFrom.length > 0) {
    if (!policy.allowFrom.includes(msg.author.id)) return false
  }
  const requireMention = policy.requireMention ?? true
  if (requireMention && !isMentioned(msg)) return false

  return true
}

function isMentioned(msg: Message): boolean {
  // Direct user mention
  if (client.user && msg.mentions.has(client.user)) return true
  // Role mention — check if the bot is a member of any mentioned role
  if (client.user && msg.mentions.roles.size > 0) {
    for (const role of msg.mentions.roles.values()) {
      if (role.members?.has(client.user.id)) return true
    }
  }
  // Raw text match — catch any mention format (user or role) containing the bot's ID
  if (client.user && msg.content.includes(client.user.id)) return true
  // Reply to a bot message
  if (msg.reference?.messageId && recentSentIds.has(msg.reference.messageId)) return true
  return false
}

function cleanContent(msg: Message): string {
  let text = msg.content
  if (client.user) {
    // Strip user mentions of the bot
    text = text.replace(new RegExp(`<@!?${client.user.id}>`, 'g'), '').trim()
  }
  // Strip role mentions for roles the bot belongs to
  if (msg.mentions.roles.size > 0 && client.user) {
    for (const role of msg.mentions.roles.values()) {
      if (role.members?.has(client.user.id)) {
        text = text.replace(new RegExp(`<@&${role.id}>`, 'g'), '').trim()
      }
    }
  }
  return text
}

// ─── Discord Helpers ──────────────────────────────────────────────

async function sendToChannel(channel: TextBasedChannel, text: string): Promise<string[]> {
  if (!('send' in channel)) return []
  const chunks = chunk(text)
  const ids: string[] = []
  for (const c of chunks) {
    const sent = await channel.send(c)
    trackSent(sent.id)
    ids.push(sent.id)
  }
  return ids
}

async function sendFiles(channel: TextBasedChannel, files: OutputFile[], message: string): Promise<void> {
  if (!('send' in channel) || files.length === 0) return
  // Discord allows max 10 attachments per message
  const batch = files.slice(0, 10)
  const sent = await channel.send({
    content: message,
    files: batch.map((f) => ({ attachment: f.path, name: f.name })),
  })
  trackSent(sent.id)
}

async function editMessage(channel: TextBasedChannel, messageId: string, text: string): Promise<void> {
  try {
    if (!('messages' in channel)) return
    const msg = await channel.messages.fetch(messageId)
    await msg.edit(text)
  } catch {
    // Edit can fail if message was deleted — ignore
  }
}

function trackSent(id: string): void {
  recentSentIds.add(id)
  if (recentSentIds.size > 200) {
    const first = recentSentIds.values().next().value
    if (first) recentSentIds.delete(first)
  }
}

async function startTyping(channel: TextBasedChannel): Promise<void> {
  try {
    if ('sendTyping' in channel) {
      await channel.sendTyping()
    }
  } catch {}
}

// ─── Attachment Handling ──────────────────────────────────────────

async function downloadAttachments(msg: Message): Promise<string[]> {
  if (msg.attachments.size === 0) return []

  const paths: string[] = []
  for (const att of msg.attachments.values()) {
    const safeName = att.name?.replace(/[^a-zA-Z0-9._-]/g, '_') ?? `${att.id}.bin`
    const dest = join(ATTACHMENT_DIR, `${Date.now()}-${safeName}`)
    try {
      const res = await fetch(att.url)
      const buf = Buffer.from(await res.arrayBuffer())
      await Bun.write(dest, buf)
      paths.push(dest)
    } catch (err) {
      logDispatcher('attachment_download_failed', { name: att.name, error: String(err) })
    }
  }
  return paths
}

// ─── Progress Tracking ────────────────────────────────────────────

/**
 * Creates a progress tracker that periodically edits a Discord message.
 * Returns start/stop functions.
 */
function createProgressTracker(channel: TextBasedChannel, messageId: string) {
  let activityCount = 0
  let lastUpdate = Date.now()
  let stopped = false

  const dots = () => '.'.repeat((activityCount % 3) + 1)

  // Periodic typing indicator
  const typingInterval = setInterval(() => {
    if (!stopped) startTyping(channel)
  }, 8_000)

  // Periodic progress message edit
  const progressInterval = setInterval(() => {
    if (stopped) return
    activityCount++
    const elapsed = Math.round((Date.now() - lastUpdate) / 1000)
    editMessage(channel, messageId, `Working${dots()} (${elapsed}s)`)
  }, PROGRESS_UPDATE_MS)

  return {
    /** Signal activity from Claude (resets the elapsed counter display) */
    tick() {
      activityCount++
    },
    /** Stop all intervals and finalize */
    stop() {
      stopped = true
      clearInterval(typingInterval)
      clearInterval(progressInterval)
    },
  }
}

// ─── Prompt Building ──────────────────────────────────────────────

function buildPrompt(
  content: string,
  username: string,
  threadId: string,
  attachmentPaths: string[],
): string {
  const parts: string[] = [
    `<channel source="discord" thread_id="${threadId}" user="${username}">`,
    content,
  ]

  if (attachmentPaths.length > 0) {
    parts.push('')
    parts.push('Attached files (downloaded to local disk):')
    for (const p of attachmentPaths) {
      parts.push(`  - ${p}`)
    }
  }

  parts.push('</channel>')
  parts.push('')
  parts.push(
    'Reply directly with your response. The dispatcher will post it to the Discord thread.',
  )
  parts.push('For file outputs, save to the outbox/ directory as usual.')

  return parts.join('\n')
}

// ─── Core Handlers ────────────────────────────────────────────────

async function handleNewTask(msg: Message): Promise<void> {
  const content = cleanContent(msg)
  if (!content) return

  // Check concurrent session limit
  if (busyCount() >= MAX_CONCURRENT_BUSY) {
    await msg.reply(
      `At capacity (${MAX_CONCURRENT_BUSY} tasks running). Send again shortly or check \`!status\`.`,
    )
    return
  }

  await startTyping(msg.channel)

  // Download any attachments
  const attachmentPaths = await downloadAttachments(msg)

  // Generate thread title
  let title: string
  try {
    title = await generateTitle(content)
  } catch {
    title = content.slice(0, 80)
  }

  // Create Discord thread
  let thread: ThreadChannel
  try {
    thread = await msg.startThread({
      name: title,
      autoArchiveDuration: THREAD_AUTO_ARCHIVE_MINUTES as 60 | 1440 | 4320 | 10080,
    })
  } catch (err) {
    logDispatcher('thread_create_failed', { error: String(err) })
    await msg.reply('Failed to create thread — please try again.')
    return
  }

  logDispatcher('thread_created', { threadId: thread.id, title })

  // Register session
  createSession(thread.id, title)
  trackSessionCreated(thread.id, title)

  // Post initial progress message (we'll edit this)
  const [progressMsgId] = await sendToChannel(thread, `Working on: **${title}**...`)

  // Set up progress tracker
  const tracker = progressMsgId
    ? createProgressTracker(thread, progressMsgId)
    : null

  const prompt = buildPrompt(content, msg.author.username, thread.id, attachmentPaths)

  // Snapshot outbox before running so we can detect new files
  const outboxBefore = snapshotOutbox()

  try {
    const result = await runSession({
      prompt,
      threadId: thread.id,
      onProgress: () => tracker?.tick(),
    })

    tracker?.stop()

    // Edit the progress message to show completion
    if (progressMsgId) {
      await editMessage(thread, progressMsgId, `**${title}** — complete.`)
    }

    // Post response
    if (result.response) {
      await sendToChannel(thread, result.response)
    }

    // Check for new outbox files and attach them
    const newFiles = diffOutbox(outboxBefore)
    if (newFiles.length > 0) {
      await sendFiles(thread, newFiles, `Output file(s):`)
    }

    markIdle(thread.id, result.sessionId!)
    trackTurnCompleted(thread.id, result.cost, result.durationMs, result.toolsUsed)
    recordSuccess()

    // Drain any queued follow-ups
    await processQueue(thread)
  } catch (err) {
    tracker?.stop()
    if (progressMsgId) {
      await editMessage(thread, progressMsgId, `**${title}** — failed.`)
    }
    markError(thread.id, String(err))
    trackSessionError(thread.id)
    recordError()
    await sendToChannel(
      thread,
      `Something went wrong: ${String(err).slice(0, 200)}\n\nSend another message here to retry.`,
    )
  }
}

async function handleFollowUp(msg: Message): Promise<void> {
  const content = cleanContent(msg)
  if (!content) return

  const threadId = msg.channelId
  const session = getSession(threadId)

  // No session exists for this thread — start fresh
  if (!session) {
    createSession(threadId, 'Resumed conversation')
    trackSessionCreated(threadId, 'Resumed conversation')
    const attachmentPaths = await downloadAttachments(msg)
    const prompt = buildPrompt(content, msg.author.username, threadId, attachmentPaths)

    await startTyping(msg.channel)
    const [progressMsgId] = await sendToChannel(msg.channel, 'Working...')
    const tracker = progressMsgId
      ? createProgressTracker(msg.channel, progressMsgId)
      : null

    try {
      const result = await runSession({
        prompt,
        threadId,
        onProgress: () => tracker?.tick(),
      })

      tracker?.stop()
      if (progressMsgId) await editMessage(msg.channel, progressMsgId, 'Done.')

      if (result.response) {
        await sendToChannel(msg.channel, result.response)
      }
      markIdle(threadId, result.sessionId!)
      trackTurnCompleted(threadId, result.cost, result.durationMs, result.toolsUsed)
      recordSuccess()
    } catch (err) {
      tracker?.stop()
      if (progressMsgId) await editMessage(msg.channel, progressMsgId, 'Failed.')
      markError(threadId, String(err))
      trackSessionError(threadId)
      recordError()
      await sendToChannel(msg.channel, `Error: ${String(err).slice(0, 200)}`)
    }
    return
  }

  // Session is busy — queue the message
  if (session.status === 'busy') {
    const queued = queueMessage(threadId, content, msg.author.username)
    if (queued) {
      trackMessageQueued()
      const depth = queueDepth(threadId)
      await msg.react('⏳')
      if (depth > 1) {
        await msg.reply(`Queued (position ${depth}). I'll get to this when the current task finishes.`)
      }
    } else {
      await msg.reply('Queue full — please wait for the current task to finish.')
    }
    return
  }

  // Session is idle, error, or expired — resume (or start fresh)
  markBusy(threadId)

  await startTyping(msg.channel)
  const attachmentPaths = await downloadAttachments(msg)
  const prompt = buildPrompt(content, msg.author.username, threadId, attachmentPaths)

  const [progressMsgId] = await sendToChannel(msg.channel, 'Working...')
  const tracker = progressMsgId
    ? createProgressTracker(msg.channel, progressMsgId)
    : null

  const outboxBefore = snapshotOutbox()

  try {
    const result = await runSession({
      prompt,
      sessionId: session.sessionId,
      threadId,
      onProgress: () => tracker?.tick(),
    })

    // Handle stale session — retry without resume
    if (result.resumeFailed) {
      logDispatcher('stale_session_recovery', { threadId, oldSessionId: session.sessionId })
      clearSessionId(threadId)

      if (progressMsgId) {
        await editMessage(msg.channel, progressMsgId, 'Session expired — starting fresh...')
      }

      const retryResult = await runSession({
        prompt,
        threadId,
        onProgress: () => tracker?.tick(),
      })

      tracker?.stop()
      if (progressMsgId) await editMessage(msg.channel, progressMsgId, 'Done.')

      if (retryResult.response) {
        await sendToChannel(msg.channel, retryResult.response)
      }
      markIdle(threadId, retryResult.sessionId!)
      trackTurnCompleted(threadId, retryResult.cost, retryResult.durationMs, retryResult.toolsUsed)
      recordSuccess()
    } else {
      tracker?.stop()
      if (progressMsgId) await editMessage(msg.channel, progressMsgId, 'Done.')

      if (result.response) {
        await sendToChannel(msg.channel, result.response)
      }
      markIdle(threadId, result.sessionId!)
      trackTurnCompleted(threadId, result.cost, result.durationMs, result.toolsUsed)
      recordSuccess()
    }

    // Check for new outbox files
    const newFiles = diffOutbox(outboxBefore)
    if (newFiles.length > 0) {
      await sendFiles(msg.channel, newFiles, `Output file(s):`)
    }

    // Process any queued messages
    if (msg.channel.isThread()) {
      await processQueue(msg.channel as ThreadChannel)
    }
  } catch (err) {
    tracker?.stop()
    if (progressMsgId) await editMessage(msg.channel, progressMsgId, 'Failed.')
    markError(threadId, String(err))
    trackSessionError(threadId)
    recordError()
    await sendToChannel(msg.channel, `Error: ${String(err).slice(0, 200)}`)
  }
}

async function processQueue(thread: ThreadChannel): Promise<void> {
  const drained = drainQueue(thread.id)
  if (!drained) return

  const session = getSession(thread.id)
  if (!session?.sessionId) return

  markBusy(thread.id)

  const [progressMsgId] = await sendToChannel(thread, 'Processing queued follow-up...')
  const tracker = progressMsgId
    ? createProgressTracker(thread, progressMsgId)
    : null

  const prompt = buildPrompt(drained.combined, drained.username, thread.id, [])

  try {
    const result = await runSession({
      prompt,
      sessionId: session.sessionId,
      threadId: thread.id,
      onProgress: () => tracker?.tick(),
    })

    tracker?.stop()
    if (progressMsgId) await editMessage(thread, progressMsgId, 'Done.')

    if (result.resumeFailed) {
      clearSessionId(thread.id)
      const retryResult = await runSession({
        prompt,
        threadId: thread.id,
        onProgress: () => {},
      })
      if (retryResult.response) await sendToChannel(thread, retryResult.response)
      markIdle(thread.id, retryResult.sessionId!)
    } else {
      if (result.response) await sendToChannel(thread, result.response)
      markIdle(thread.id, result.sessionId!)
    }

    // Recurse if more messages queued during processing
    await processQueue(thread)
  } catch (err) {
    tracker?.stop()
    if (progressMsgId) await editMessage(thread, progressMsgId, 'Failed.')
    markError(thread.id, String(err))
    await sendToChannel(thread, `Error processing follow-up: ${String(err).slice(0, 200)}`)
  }
}

// ─── Commands ─────────────────────────────────────────────────────

async function handleStatus(msg: Message): Promise<void> {
  const summary = getStatusSummary(getHealthLine())
  await msg.reply(summary)
}

async function handleStats(msg: Message): Promise<void> {
  const report = getStatsReport()
  await msg.reply(report)
}

// ─── Main Router ──────────────────────────────────────────────────

async function handleMessage(msg: Message): Promise<void> {
  if (!shouldProcess(msg)) return

  trackMessageReceived()

  logDispatcher('message_received', {
    channelId: msg.channelId,
    userId: msg.author.id,
    username: msg.author.username,
    isThread: msg.channel.isThread(),
    hasAttachments: msg.attachments.size > 0,
    contentPreview: msg.content.slice(0, 100),
  })

  const cleaned = cleanContent(msg)
  const command = cleaned.trim().toLowerCase()

  // Commands (work in channel or thread)
  if (command === '!status') {
    await handleStatus(msg)
    return
  }
  if (command === '!stats') {
    await handleStats(msg)
    return
  }

  // Rate limiting
  if (!checkRateLimit()) {
    await msg.react('🐌')
    return
  }

  // Circuit breaker — if too many consecutive errors, pause and notify
  if (isCircuitOpen()) {
    await msg.reply(
      '⚠️ Paused — too many consecutive errors. Auto-retrying in ~1 minute. Use `!status` to check.',
    )
    return
  }

  if (msg.channel.isThread()) {
    await handleFollowUp(msg)
  } else {
    await handleNewTask(msg)
  }
}

// ─── Discord Events ───────────────────────────────────────────────

client.on('messageCreate', (msg) => {
  // Passive ingestion runs first and independently of processing. A message
  // can be both ingested (archived to the shared channel store) AND processed
  // as a dispatcher task — they're orthogonal concerns.
  try {
    ingestMessage(msg)
  } catch (err) {
    logDispatcher('ingest_error', { error: String(err), channelId: msg.channelId })
  }

  handleMessage(msg).catch((err) => {
    logDispatcher('handler_error', { error: String(err), channelId: msg.channelId })
  })
})

client.once('ready', (c) => {
  logDispatcher('gateway_connected', { tag: c.user.tag })
  // Kick off backfill after gateway is ready. Fire-and-forget — failures are
  // logged but don't block the dispatcher from serving live traffic.
  backfillAll(client).catch((err) => {
    logDispatcher('ingest_backfill_failed', { error: String(err) })
  })
})

client.on('error', (err) => {
  logDispatcher('gateway_error', { error: String(err) })
})

// ─── Reaction Tracking (Quality Signal) ──────────────────────────

const QUALITY_REACTIONS: Record<string, string> = {
  '👍': 'positive',
  '👎': 'negative',
  '⭐': 'positive',
  '❌': 'negative',
  '✅': 'positive',
}

client.on('messageReactionAdd', async (
  reaction: MessageReaction | PartialMessageReaction,
  user: User | PartialUser,
) => {
  try {
    // Ignore bot reactions (including our own)
    if (user.bot) return

    // Only track reactions on messages we sent
    const messageId = reaction.message.id
    if (!recentSentIds.has(messageId)) return

    const emoji = reaction.emoji.name ?? ''
    const signal = QUALITY_REACTIONS[emoji]
    if (!signal) return

    const channelId = reaction.message.channelId
    const threadId = reaction.message.channel?.isThread()
      ? channelId
      : undefined
    const session = threadId ? getSession(threadId) : undefined

    logDispatcher('quality_signal', {
      signal,
      emoji,
      userId: user.id,
      username: ('username' in user) ? user.username : undefined,
      messageId,
      channelId,
      threadId,
      sessionId: session?.sessionId ?? null,
      threadName: session?.threadName ?? null,
    })
  } catch (err) {
    logDispatcher('reaction_handler_error', { error: String(err) })
  }
})

export async function connect(): Promise<void> {
  await client.login(DISCORD_BOT_TOKEN)
}

export async function disconnect(): Promise<void> {
  await client.destroy()
}
