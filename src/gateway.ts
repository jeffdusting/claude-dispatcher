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
  ChannelType,
  GatewayIntentBits,
  type Message,
  type MessageReaction,
  type ThreadChannel,
  type TextBasedChannel,
  type User,
  type PartialMessageReaction,
  type PartialUser,
  type GuildChannel,
  type NonThreadGuildBasedChannel,
} from 'discord.js'
import { mkdirSync, createWriteStream } from 'fs'
import { join, basename } from 'path'
import {
  DISCORD_BOT_TOKEN,
  THREAD_AUTO_ARCHIVE_MINUTES,
  PROGRESS_UPDATE_MS,
  ATTACHMENT_DIR,
  DEFAULT_GROUP_POLICY,
  OPS_ALERT_CHANNEL_ID,
  loadAccess,
  updateAccess,
  upsertKnownChannel,
} from './config.js'
import {
  activeCount as activeWorkerCount,
  maxConcurrentLimit,
} from './concurrencyGate.js'
import { readStaleFlag } from './agentSync.js'
import {
  getSession,
  getOrResumeSession,
  createSession,
  markBusy,
  markIdle,
  markError,
  clearSessionId,
  queueMessage,
  queueDepth,
  drainQueue,
  getStatusSummary,
  setPendingContinuation,
  clearPendingContinuation,
  listPendingContinuations,
  type PendingContinuation,
} from './sessions.js'
import {
  runSession,
  generateTitle,
  snapshotOutbox,
  diffOutbox,
  WorkerSlotUnavailableError,
  type OutputFile,
} from './claude.js'
import { uploadAndSummarise, isDriveEnabled, renameThreadFolder } from './drive.js'
import { type Entity } from './entity.js'
import { resolveEntityForThread } from './entityResolver.js'
import {
  beginPostTurn,
  markSideEffect,
  discardPendingSideEffects,
} from './sideEffects.js'
import {
  readAndConsumeContinuation,
  type ContinuationDescriptor,
} from './continuation.js'
import { drainKickoffRequests, type KickoffRequest } from './kickoffInbox.js'
import { appendProjectLog, getProject } from './projects.js'
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

  // Mirror to Google Drive (if configured). Runs after the Discord send so
  // any upload failure can't delay the user seeing their output. Entity is
  // resolved per-thread from the project descriptor (Phase A.6.6) and
  // falls back to DEFAULT_ENTITY when the thread isn't bound to a project.
  const entity: Entity = resolveEntityForThread(channel.id)
  if (isDriveEnabled(entity)) {
    try {
      const threadId = channel.id
      const threadTitle = 'name' in channel ? (channel as { name?: string | null }).name ?? null : null
      const { summary } = await uploadAndSummarise(
        files.map((f) => ({ path: f.path, name: f.name })),
        threadId,
        threadTitle,
        entity,
      )
      if (summary) {
        const driveMsg = await channel.send({ content: summary })
        trackSent(driveMsg.id)
      }
    } catch (err) {
      logDispatcher('drive_mirror_error', {
        channelId: channel.id, error: String(err).slice(0, 200),
      })
    }
  }
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

// ─── Autonomous Continuation ──────────────────────────────────────
//
// After each session turn, the agent may have written a continuation
// descriptor to its CLAUDE_CONTINUE_FILE (see continuation.ts). We read,
// delete, validate, and schedule a setTimeout that re-invokes the session
// with the stored prompt after the requested delay.
//
// - Pending continuations are persisted in the session registry so they
//   survive a dispatcher restart (index.ts re-arms timers on boot).
// - If the session is busy when the timer fires (because the user sent a
//   new message), the continuation prompt is queued instead of dropped.
// - A user message supersedes any pending continuation — the timer is
//   cancelled before the follow-up runs.

// Map of threadId → setTimeout handle, so we can cancel on supersession.
const activeContinuationTimers = new Map<string, ReturnType<typeof setTimeout>>()

/**
 * Cancel an in-flight continuation timer (called when a user message
 * arrives for this thread, or when a new continuation supersedes an old
 * one). Leaves the session registry untouched — clear() that separately.
 */
function cancelContinuationTimer(threadId: string): void {
  const t = activeContinuationTimers.get(threadId)
  if (!t) return
  clearTimeout(t)
  activeContinuationTimers.delete(threadId)
  logDispatcher('continuation_timer_cancelled', { threadId })
}

/**
 * Read the continuation file (if any) and, if valid, schedule the timer.
 * Must be called after every runSession completion.
 */
async function maybeScheduleContinuation(
  channel: TextBasedChannel,
  threadId: string,
): Promise<void> {
  const desc = readAndConsumeContinuation(threadId)
  if (!desc) return

  // If there was a previous pending continuation (shouldn't normally
  // happen — the last turn just wrote a new one), cancel it first.
  cancelContinuationTimer(threadId)

  const fireAtMs = Date.now() + desc.delaySeconds * 1000
  const pending: PendingContinuation = {
    fireAtMs,
    prompt: desc.prompt,
    reason: desc.reason,
    scheduledAtMs: Date.now(),
  }
  setPendingContinuation(threadId, pending)

  const when = new Date(fireAtMs).toLocaleTimeString('en-AU', {
    hour: '2-digit', minute: '2-digit', hour12: false,
  })
  await sendToChannel(
    channel,
    `⏭ Auto-continue scheduled for ${when} (${Math.round(desc.delaySeconds / 60)} min): ${desc.reason}`,
  )

  const timer = setTimeout(
    () => { fireContinuation(channel, threadId).catch((err) => {
      logDispatcher('continuation_fire_error', { threadId, error: String(err) })
    }) },
    desc.delaySeconds * 1000,
  )
  activeContinuationTimers.set(threadId, timer)
  logDispatcher('continuation_scheduled', {
    threadId,
    delaySeconds: desc.delaySeconds,
    reason: desc.reason,
    fireAtMs,
  })
}

/**
 * Fire a previously-scheduled continuation. Mirrors the follow-up path
 * but with a synthetic "[auto-continue]" prompt derived from the stored
 * continuation descriptor.
 */
async function fireContinuation(
  channel: TextBasedChannel,
  threadId: string,
): Promise<void> {
  activeContinuationTimers.delete(threadId)
  const pending = clearPendingContinuation(threadId)
  if (!pending) {
    logDispatcher('continuation_fire_no_pending', { threadId })
    return
  }

  const session = getSession(threadId)
  if (!session) {
    logDispatcher('continuation_fire_no_session', { threadId })
    return
  }

  // If session is busy (a user message beat us to it), queue the prompt
  if (session.status === 'busy') {
    const queued = queueMessage(threadId, pending.prompt, '[auto-continue]')
    if (queued) {
      logDispatcher('continuation_queued_busy', { threadId, reason: pending.reason })
    } else {
      logDispatcher('continuation_queue_full', { threadId, reason: pending.reason })
    }
    return
  }

  // Not busy — run it as a self-invoked follow-up.
  // CRITICAL: markBusy happens BEFORE the try, but every await that follows
  // must be inside try/catch so a transient transport failure (e.g. an
  // Anthropic API URL/port error from startTyping or sendToChannel) cannot
  // leave the session zombied in 'busy' with no pending continuation. Any
  // exception must reach markError so the session becomes recoverable.
  markBusy(threadId)

  let progressMsgId: string | null = null
  let tracker: ReturnType<typeof createProgressTracker> | null = null
  const outboxBefore = snapshotOutbox()
  const prompt = buildContinuationPrompt(pending, threadId)

  try {
    await startTyping(channel)
    await sendToChannel(channel, `⏯ Auto-continuing: ${pending.reason}`)

    const sendResult = await sendToChannel(channel, 'Working...')
    progressMsgId = sendResult[0] ?? null
    tracker = progressMsgId
      ? createProgressTracker(channel, progressMsgId)
      : null

    const result = await runSession({
      prompt,
      sessionId: session.sessionId,
      threadId,
      onProgress: () => tracker?.tick(),
    })

    // Handle stale session (resume failed) — retry without resume
    if (result.resumeFailed) {
      logDispatcher('continuation_resume_stale', {
        threadId, oldSessionId: session.sessionId,
      })
      clearSessionId(threadId)
      if (progressMsgId) {
        await editMessage(channel, progressMsgId, 'Session expired — starting fresh...')
      }
      const retry = await runSession({
        prompt, threadId, onProgress: () => tracker?.tick(),
      })
      tracker?.stop()

      // Side-effect tracking BEFORE the post-back. This is the 25 April
      // 2026 incident's exact reference scenario: the continuation
      // (autonomous) generated output, the response/files need posting,
      // and a transient transport failure between runSession returning
      // and the channel.send() must not leave the result stranded.
      const newFiles = diffOutbox(outboxBefore)
      beginPostTurn({
        threadId,
        responseText: retry.response ?? '',
        outboxFiles: newFiles,
        entity: resolveEntityForThread(threadId),
        continuationReason: pending.reason,
      })

      if (progressMsgId) await editMessage(channel, progressMsgId, 'Done.')
      if (retry.response) await sendToChannel(channel, retry.response)
      markSideEffect(threadId, 'responsePosted')

      if (newFiles.length > 0) {
        await sendFiles(channel, newFiles, 'Output file(s):')
        markSideEffect(threadId, 'attachmentsSent')
        markSideEffect(threadId, 'outboxUploaded')
      }

      markIdle(threadId, retry.sessionId!)
      trackTurnCompleted(threadId, retry.cost, retry.durationMs, retry.toolsUsed)
      recordSuccess()
    } else {
      tracker?.stop()
      const newFiles = diffOutbox(outboxBefore)
      beginPostTurn({
        threadId,
        responseText: result.response ?? '',
        outboxFiles: newFiles,
        entity: resolveEntityForThread(threadId),
        continuationReason: pending.reason,
      })

      if (progressMsgId) await editMessage(channel, progressMsgId, 'Done.')
      if (result.response) await sendToChannel(channel, result.response)
      markSideEffect(threadId, 'responsePosted')

      if (newFiles.length > 0) {
        await sendFiles(channel, newFiles, 'Output file(s):')
        markSideEffect(threadId, 'attachmentsSent')
        markSideEffect(threadId, 'outboxUploaded')
      }

      markIdle(threadId, result.sessionId!)
      trackTurnCompleted(threadId, result.cost, result.durationMs, result.toolsUsed)
      recordSuccess()
    }

    // The continuation may itself have scheduled another continuation
    await maybeScheduleContinuation(channel, threadId)
  } catch (err) {
    tracker?.stop()
    if (progressMsgId) {
      try { await editMessage(channel, progressMsgId, 'Failed.') } catch { /* best-effort */ }
    }
    markError(threadId, String(err))
    trackSessionError(threadId)
    recordError()
    try {
      await sendToChannel(channel, `Auto-continue failed: ${String(err).slice(0, 200)}`)
    } catch {
      // If Discord itself is unreachable, we cannot notify — the markError
      // call above is what matters for recovery. Log and move on.
      logDispatcher('continuation_fire_notify_failed', {
        threadId, error: String(err).slice(0, 200),
      })
    }
  }
}

function buildContinuationPrompt(pending: PendingContinuation, threadId: string): string {
  return [
    `<channel source="discord" thread_id="${threadId}" user="[auto-continue]">`,
    pending.prompt,
    '</channel>',
    '',
    'This is an autonomous continuation that you scheduled on a previous turn.',
    'The dispatcher re-invoked this session as requested. Continue the work.',
    'If more continuation is needed, write another continuation file via CLAUDE_CONTINUE_FILE.',
    'If the work is complete, simply respond without writing a continuation file and the loop ends.',
    'For file outputs, save to the outbox/ directory as usual.',
  ].join('\n')
}

/**
 * Replay any post-turn side effects that were captured but not finished
 * before the previous Bun process exited (Phase A.9.3, Δ D-003). Walks
 * every session entry with a non-null `pendingSideEffects` blob and posts
 * the response and/or attachments that didn't land last time.
 *
 * Called from index.ts on boot, after the gateway is connected and after
 * `restoreContinuations` so the channel resolver is ready.
 */
export async function replayPendingSideEffects(
  channelResolver: (threadId: string) => Promise<TextBasedChannel | null>,
): Promise<void> {
  const { listPendingSideEffects } = await import('./sessions.js')
  const items = listPendingSideEffects()
  if (items.length === 0) {
    logDispatcher('side_effects_replay_clean')
    return
  }

  for (const { threadId, pending } of items) {
    const channel = await channelResolver(threadId)
    if (!channel) {
      logDispatcher('side_effects_replay_channel_unresolved', { threadId })
      // Channel unresolvable — discard. The thread may have been deleted
      // or the bot is no longer a member; leaving the blob would block
      // future turns from clearing state.
      discardPendingSideEffects(threadId, 'channel_unresolved_on_replay')
      continue
    }

    logDispatcher('side_effects_replay_start', {
      threadId,
      capturedAt: pending.capturedAt,
      status: pending.status,
      continuationReason: pending.continuationReason,
    })

    try {
      if (!pending.status.responsePosted && pending.responseText) {
        await sendToChannel(
          channel,
          `🔁 Resuming after restart — ${pending.responseText}`,
        )
        markSideEffect(threadId, 'responsePosted')
      } else if (!pending.status.responsePosted) {
        // Empty response is a degenerate case — flip the flag so we
        // don't loop on it.
        markSideEffect(threadId, 'responsePosted')
      }

      if (
        (!pending.status.attachmentsSent || !pending.status.outboxUploaded) &&
        pending.outboxFiles.length > 0
      ) {
        await sendFiles(
          channel,
          pending.outboxFiles.map((f) => ({ path: f.path, name: f.name })),
          '🔁 Output file(s) (resumed after restart):',
        )
        markSideEffect(threadId, 'attachmentsSent')
        markSideEffect(threadId, 'outboxUploaded')
      } else if (
        !pending.status.attachmentsSent ||
        !pending.status.outboxUploaded
      ) {
        markSideEffect(threadId, 'attachmentsSent')
        markSideEffect(threadId, 'outboxUploaded')
      }

      logDispatcher('side_effects_replay_done', { threadId })
    } catch (err) {
      logDispatcher('side_effects_replay_failed', {
        threadId,
        error: String(err).slice(0, 300),
      })
      // Leave the blob in place; next boot will retry.
    }
  }
}

/**
 * Called on Discord boot (from index.ts) and whenever a user-driven turn
 * supersedes a pending continuation. Re-arms timers from the persisted
 * session registry, firing immediately for any that are already overdue.
 */
export function restoreContinuations(
  channelResolver: (threadId: string) => Promise<TextBasedChannel | null>,
): void {
  const pending = listPendingContinuations()
  for (const { threadId, cont } of pending) {
    const remaining = Math.max(0, cont.fireAtMs - Date.now())
    logDispatcher('continuation_restored', { threadId, remaining, reason: cont.reason })

    const timer = setTimeout(async () => {
      const channel = await channelResolver(threadId)
      if (!channel) {
        logDispatcher('continuation_channel_unresolved', { threadId })
        clearPendingContinuation(threadId)
        return
      }
      fireContinuation(channel, threadId).catch((err) => {
        logDispatcher('continuation_fire_error', { threadId, error: String(err) })
      })
    }, remaining)
    activeContinuationTimers.set(threadId, timer)
  }
}

// ─── Core Handlers ────────────────────────────────────────────────

async function handleNewTask(msg: Message): Promise<void> {
  const content = cleanContent(msg)
  if (!content) return

  // Concurrent-worker cap (Phase A.9.5, Δ D-014). The pre-check avoids
  // creating a thread we cannot service immediately. In a race where slots
  // free up between this check and runSession, the gate inside runSession
  // queues for up to 30 seconds before raising WorkerSlotUnavailableError;
  // the thread already exists, so we surface a busy reply in the catch
  // block below.
  if (activeWorkerCount() >= maxConcurrentLimit()) {
    await msg.reply(
      `At capacity (${maxConcurrentLimit()} workers running). Send again shortly or check \`!status\`.`,
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

    // Capture post-turn side effects BEFORE any post-back so a crash
    // between runSession returning and the Discord post leaves a
    // recoverable record (Phase A.9.3, Δ D-003 — 25 April 2026 incident
    // reference scenario).
    const newFiles = diffOutbox(outboxBefore)
    beginPostTurn({
      threadId: thread.id,
      responseText: result.response ?? '',
      outboxFiles: newFiles,
      entity: resolveEntityForThread(thread.id),
    })

    // Edit the progress message to show completion
    if (progressMsgId) {
      await editMessage(thread, progressMsgId, `**${title}** — complete.`)
    }

    // Post response
    if (result.response) {
      await sendToChannel(thread, result.response)
    }
    markSideEffect(thread.id, 'responsePosted')

    // Check for new outbox files and attach them
    if (newFiles.length > 0) {
      await sendFiles(thread, newFiles, `Output file(s):`)
      markSideEffect(thread.id, 'attachmentsSent')
      markSideEffect(thread.id, 'outboxUploaded')
    }

    markIdle(thread.id, result.sessionId!)
    trackTurnCompleted(thread.id, result.cost, result.durationMs, result.toolsUsed)
    recordSuccess()

    // Check for autonomous continuation
    await maybeScheduleContinuation(thread, thread.id)

    // Drain any queued follow-ups
    await processQueue(thread)
  } catch (err) {
    tracker?.stop()
    if (err instanceof WorkerSlotUnavailableError) {
      if (progressMsgId) {
        await editMessage(thread, progressMsgId, `**${title}** — busy, send another message to retry.`)
      }
      // markError (not markIdle with an empty sessionId — that would corrupt
      // the permanent mapping). The error state lets the next user message
      // take the resume-or-start-fresh path in handleFollowUp.
      markError(thread.id, 'worker_slot_unavailable')
      await sendToChannel(
        thread,
        `At capacity (${maxConcurrentLimit()} workers running). Send another message in a moment to retry.`,
      )
      return
    }
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

  // A user message always supersedes any pending autonomous continuation
  // for this thread. Cancel the timer and clear the persisted record —
  // the agent can re-schedule if it still wants to continue after handling
  // this new input.
  cancelContinuationTimer(threadId)
  const superseded = clearPendingContinuation(threadId)
  if (superseded) {
    logDispatcher('continuation_superseded_by_user', {
      threadId, reason: superseded.reason,
    })
  }

  // Any unfinished side effects from a prior turn are also superseded —
  // the user has moved on, replaying a stale response would confuse them
  // (Phase A.9.3).
  discardPendingSideEffects(threadId, 'user_message_received')

  // getOrResumeSession re-seeds from the permanent thread→sessionId mapping
  // when the live entry has been cleaned up. Returns undefined only if the
  // thread is entirely unknown — in that case we start a fresh conversation.
  const session = getOrResumeSession(threadId)

  // Thread is unknown — start fresh
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
      await maybeScheduleContinuation(msg.channel, threadId)
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
      const newFiles = diffOutbox(outboxBefore)
      beginPostTurn({
        threadId,
        responseText: retryResult.response ?? '',
        outboxFiles: newFiles,
        entity: resolveEntityForThread(threadId),
      })

      if (progressMsgId) await editMessage(msg.channel, progressMsgId, 'Done.')
      if (retryResult.response) {
        await sendToChannel(msg.channel, retryResult.response)
      }
      markSideEffect(threadId, 'responsePosted')

      if (newFiles.length > 0) {
        await sendFiles(msg.channel, newFiles, `Output file(s):`)
        markSideEffect(threadId, 'attachmentsSent')
        markSideEffect(threadId, 'outboxUploaded')
      }

      markIdle(threadId, retryResult.sessionId!)
      trackTurnCompleted(threadId, retryResult.cost, retryResult.durationMs, retryResult.toolsUsed)
      recordSuccess()
    } else {
      tracker?.stop()
      const newFiles = diffOutbox(outboxBefore)
      beginPostTurn({
        threadId,
        responseText: result.response ?? '',
        outboxFiles: newFiles,
        entity: resolveEntityForThread(threadId),
      })

      if (progressMsgId) await editMessage(msg.channel, progressMsgId, 'Done.')
      if (result.response) {
        await sendToChannel(msg.channel, result.response)
      }
      markSideEffect(threadId, 'responsePosted')

      if (newFiles.length > 0) {
        await sendFiles(msg.channel, newFiles, `Output file(s):`)
        markSideEffect(threadId, 'attachmentsSent')
        markSideEffect(threadId, 'outboxUploaded')
      }

      markIdle(threadId, result.sessionId!)
      trackTurnCompleted(threadId, result.cost, result.durationMs, result.toolsUsed)
      recordSuccess()
    }

    // Check for autonomous continuation
    await maybeScheduleContinuation(msg.channel, threadId)

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

// ─── Auto-Enable New Channels ─────────────────────────────────────
//
// When a readable guild channel is created, automatically:
//   1. Add it to `groups` with DEFAULT_GROUP_POLICY so the dispatcher
//      responds to allowed users (currently Jeff + Sarah, mention required).
//   2. Add it to `ingest.channels` so messages are archived.
//   3. Update the known-channels name cache.
//
// `loadAccess()` is called fresh on every inbound message, so this takes
// effect immediately with no dispatcher restart. Skips non-text channels
// (categories, voice, stages) and anything already in `groups`.

const AUTO_ENABLE_TYPES: ReadonlySet<number> = new Set([
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
  ChannelType.GuildForum,
])

client.on('channelCreate', (channel: NonThreadGuildBasedChannel) => {
  try {
    // Only guild channels of readable types
    if (!AUTO_ENABLE_TYPES.has(channel.type)) return

    const channelId = channel.id
    const channelName = (channel as GuildChannel).name ?? '(unnamed)'

    const current = loadAccess()
    if (channelId in (current.groups ?? {})) {
      // Already enabled — nothing to do.
      return
    }

    updateAccess((cfg) => {
      cfg.groups[channelId] = { ...DEFAULT_GROUP_POLICY }
      if (!cfg.ingest) {
        cfg.ingest = { channels: [] }
      }
      const ingestList = cfg.ingest.channels ?? []
      if (!ingestList.includes(channelId)) {
        ingestList.push(channelId)
      }
      cfg.ingest.channels = ingestList
    })

    try {
      upsertKnownChannel(channelId, channelName)
    } catch (err) {
      logDispatcher('auto_enable_cache_write_failed', {
        channelId,
        error: String(err).slice(0, 200),
      })
    }

    logDispatcher('channel_auto_enabled', {
      channelId,
      channelName,
      type: channel.type,
      guildId: (channel as GuildChannel).guildId,
      policy: DEFAULT_GROUP_POLICY,
    })
  } catch (err) {
    logDispatcher('channel_auto_enable_failed', {
      channelId: (channel as GuildChannel)?.id,
      error: String(err).slice(0, 200),
    })
  }
})

// ─── Thread Rename → Drive Folder Rename ──────────────────────────
//
// When a Discord thread is renamed, mirror the rename to its Drive folder
// so the two stay in sync. If no Drive folder exists for this thread yet,
// the handler is a no-op — the folder will be created under the new name
// the first time files upload.
client.on('threadUpdate', async (oldThread, newThread) => {
  try {
    // Entity is resolved per-thread from the project descriptor (Phase
    // A.6.6); when the thread is not bound to a project, the resolver
    // returns DEFAULT_ENTITY. Phase H may add a channel-to-entity layer
    // for non-project threads.
    const entity: Entity = resolveEntityForThread(newThread.id)
    if (!isDriveEnabled(entity)) return
    if (oldThread.name === newThread.name) return
    const res = await renameThreadFolder(newThread.id, newThread.name, entity)
    if (res.renamed) {
      logDispatcher('thread_rename_synced_to_drive', {
        threadId: newThread.id,
        oldName: oldThread.name,
        newName: newThread.name,
        folderId: res.folderId,
      })
    }
  } catch (err) {
    logDispatcher('thread_rename_handler_error', {
      threadId: newThread.id,
      error: String(err).slice(0, 200),
    })
  }
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

/**
 * Tier-1 alert: agent definition sync failed at boot.
 *
 * Reads the stale flag set by agentSync.syncAgents() and, if present,
 * posts a summary to OPS_ALERT_CHANNEL_ID. No-op when the channel is
 * unset or the flag is absent. Logged either way.
 *
 * Precondition: client.login() has resolved (call after connect()).
 */
export async function notifyIfStaleAgents(): Promise<void> {
  const flag = readStaleFlag()
  if (!flag) return

  logDispatcher('agents_stale_at_boot', { ...flag })

  if (!OPS_ALERT_CHANNEL_ID) {
    logDispatcher('agents_stale_alert_skipped', { reason: 'OPS_ALERT_CHANNEL_ID not set' })
    return
  }

  try {
    const ch = await client.channels.fetch(OPS_ALERT_CHANNEL_ID)
    if (!ch || !('send' in ch) || typeof (ch as { send?: unknown }).send !== 'function') {
      logDispatcher('agents_stale_alert_failed', { reason: 'channel unresolvable or not sendable' })
      return
    }
    const body =
      `**Tier-1: agent sync failed at boot**\n` +
      `Reason: ${flag.reason}\n` +
      `At: ${flag.at}\n` +
      `Dispatcher continued startup; agent definitions in \`~/.claude/agents/\` may be stale until next boot.`
    await (ch as { send: (b: string) => Promise<unknown> }).send(body)
    logDispatcher('agents_stale_alert_sent', { channel: OPS_ALERT_CHANNEL_ID })
  } catch (err) {
    logDispatcher('agents_stale_alert_failed', { error: String(err).slice(0, 200) })
  }
}

/**
 * Resolve a Discord thread by ID. Used by restoreContinuations on boot to
 * reattach timers to the channels they were scheduled against.
 */
export async function resolveThreadChannel(threadId: string): Promise<TextBasedChannel | null> {
  try {
    const ch = await client.channels.fetch(threadId)
    if (!ch) return null
    if ('send' in ch) return ch as TextBasedChannel
    return null
  } catch {
    return null
  }
}

// ─── Project Kickoff Processing ───────────────────────────────────
//
// The CoS drops a kickoff request file; we pick it up on an interval and
// stand up the PM as a live session against the project thread. After this
// cycle, the thread behaves like any other — follow-ups route through the
// normal paths, continuations re-arm themselves, etc.

async function handleKickoff(req: KickoffRequest): Promise<void> {
  const project = getProject(req.projectId)
  if (!project) {
    logDispatcher('kickoff_project_missing', { projectId: req.projectId })
    return
  }

  const channel = await resolveThreadChannel(req.projectThreadId)
  if (!channel) {
    logDispatcher('kickoff_channel_unresolved', {
      projectId: req.projectId,
      threadId: req.projectThreadId,
    })
    return
  }

  // At capacity? Defer — re-drop the file so the next tick picks it up.
  // (Phase A.9.5, Δ D-014: now driven by the concurrent-worker gate
  // rather than the in-memory session-busy counter.)
  if (activeWorkerCount() >= maxConcurrentLimit()) {
    logDispatcher('kickoff_at_capacity', { projectId: req.projectId })
    // Rewrite the request so the next drain re-picks it up. Cheap.
    const { dropKickoffRequest } = await import('./kickoffInbox.js')
    dropKickoffRequest(req)
    return
  }

  // Create the live session for this thread. threadSessions already has
  // the project-manager agent override wired in, so runSession will spawn
  // the PM automatically.
  createSession(req.projectThreadId, `Project: ${project.name}`)
  trackSessionCreated(req.projectThreadId, `Project: ${project.name}`)
  appendProjectLog(req.projectId, 'PM kickoff starting.')

  await startTyping(channel)
  const [progressMsgId] = await sendToChannel(channel, 'Standing up project manager...')
  const tracker = progressMsgId ? createProgressTracker(channel, progressMsgId) : null

  const outboxBefore = snapshotOutbox()

  try {
    const result = await runSession({
      prompt: req.kickoffPrompt,
      threadId: req.projectThreadId,
      onProgress: () => tracker?.tick(),
    })

    tracker?.stop()
    if (progressMsgId) {
      await editMessage(channel, progressMsgId, 'PM initialised.')
    }

    if (result.response) {
      await sendToChannel(channel, result.response)
    }

    markIdle(req.projectThreadId, result.sessionId!)
    trackTurnCompleted(
      req.projectThreadId,
      result.cost,
      result.durationMs,
      result.toolsUsed,
    )
    recordSuccess()

    const newFiles = diffOutbox(outboxBefore)
    if (newFiles.length > 0) {
      await sendFiles(channel, newFiles, 'Output file(s):')
    }

    appendProjectLog(req.projectId, 'PM kickoff complete.')

    // PM likely scheduled its own continuation. Pick it up.
    await maybeScheduleContinuation(channel, req.projectThreadId)
  } catch (err) {
    tracker?.stop()
    if (err instanceof WorkerSlotUnavailableError) {
      // Slot held by other workers for the full 30s queue wait. Re-drop the
      // kickoff request so the next drain retries; the live session entry
      // is marked errored so the next attempt re-creates it cleanly.
      if (progressMsgId) {
        await editMessage(channel, progressMsgId, 'PM kickoff deferred — at capacity.')
      }
      markError(req.projectThreadId, 'worker_slot_unavailable')
      const { dropKickoffRequest } = await import('./kickoffInbox.js')
      dropKickoffRequest(req)
      appendProjectLog(req.projectId, 'PM kickoff deferred: at capacity, re-queued.')
      return
    }
    if (progressMsgId) {
      await editMessage(channel, progressMsgId, 'PM kickoff failed.')
    }
    markError(req.projectThreadId, String(err))
    trackSessionError(req.projectThreadId)
    recordError()
    appendProjectLog(req.projectId, `PM kickoff failed: ${String(err).slice(0, 200)}`)
    await sendToChannel(
      channel,
      `PM kickoff failed: ${String(err).slice(0, 200)}`,
    )
  }
}

/**
 * Drain any pending kickoff requests. Called on an interval from index.ts.
 * Fire-and-forget per request — we don't await all of them in series so a
 * slow PM doesn't block subsequent kickoffs.
 */
export function runKickoffCycle(): void {
  const pending = drainKickoffRequests()
  if (pending.length === 0) return
  logDispatcher('kickoff_cycle', { count: pending.length })
  for (const req of pending) {
    handleKickoff(req).catch((err) => {
      logDispatcher('kickoff_handler_error', {
        projectId: req.projectId,
        error: String(err),
      })
    })
  }
}
