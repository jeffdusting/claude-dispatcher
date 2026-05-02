#!/usr/bin/env bun
/**
 * Gmail helper for Alex (acting on jeffdusting@waterroads.com.au).
 *
 * Subcommands:
 *   list-unread [--max N] [--query "Q"]   — list unread (or query-matched) messages.
 *   get-message --id ID                    — fetch full message body + headers as JSON.
 *   list-threads [--max N] [--query "Q"]  — list threads with subject + last-message snippet.
 *   get-thread --id ID                     — fetch a thread with all messages.
 *   draft-reply --thread-id ID --body B   — create a draft reply (lane-tagged).
 *   draft-new --to T --subject S --body B  — create a brand-new draft (lane-tagged).
 *   list-drafts [--max N]                  — list draft IDs with subject, recipient, and lane.
 *   delete-draft --id ID                   — delete a draft.
 *   send-graduated --id ID                 — gated send for drafts whose lane has graduated.
 *
 * Drafts are lane-tagged at creation per R-952. Lane label values are
 * `lane/autonomous`, `lane/approval`, or `lane/principal_only`. The lane is
 * derived from the inbound classifier (`src/lanes/classifier.ts`) plus the
 * always-approval overlay (`src/lanes/alwaysApproval.ts`).
 *
 * The `send-graduated` subcommand is the only path that sends drafts. It
 * applies the full gating chain — lane label present, overlay does not force
 * approval, graduation config has the lane in `autonomousLanes`. The default
 * graduation config is empty for both EAs, so drafts-only is preserved unless
 * the operator explicitly graduates a lane in
 * `config/graduation-{principal}.json`.
 *
 * All output is JSON to stdout. Errors print { ok: false, error: ... } and
 * exit non-zero. Audit decisions are appended to
 * `${STATE_DIR:-/data/state}/lanes-audit.jsonl`.
 */

import { appendFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { ALEX_PRINCIPAL, gmailService, AuthError } from './auth.js'
import { classify } from '../../src/lanes/classifier.js'
import { shouldForceApproval, loadAlwaysApprovalConfig, alwaysApprovalConfigPath } from '../../src/lanes/alwaysApproval.js'
import { canAutoSend, loadGraduationConfig, graduationConfigPath } from '../../src/lanes/graduationConfig.js'
import type { Lane, Principal } from '../../src/lanes/types.js'

type Args = Record<string, string | boolean>

function parseArgs(argv: string[]): Args {
  const args: Args = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) {
        args[key] = true
      } else {
        args[key] = next
        i++
      }
    }
  }
  return args
}

function fail(error: string, code = 'GMAIL_ERROR'): never {
  console.log(JSON.stringify({ ok: false, code, error }))
  process.exit(1)
}

function ok(payload: unknown): void {
  console.log(JSON.stringify({ ok: true, ...(payload as object) }))
}

function header(headers: { name?: string | null; value?: string | null }[] | undefined, name: string): string {
  if (!headers) return ''
  const h = headers.find((x) => x.name?.toLowerCase() === name.toLowerCase())
  return h?.value ?? ''
}

// ─── Lane labelling ──────────────────────────────────────────────────────────
//
// Drafts created by this helper are tagged with one of three Gmail labels:
//   lane/autonomous, lane/approval, lane/principal_only
// The lane is computed at draft-creation by classify() + always-approval
// overlay. Helpers below resolve label IDs (creating the label if missing)
// and apply the lane label to the draft's underlying message.

const LANE_LABEL_PREFIX = 'lane'

function laneLabelName(lane: Lane): string {
  return `${LANE_LABEL_PREFIX}/${lane}`
}

const labelIdCache = new Map<string, string>()

interface GmailService {
  users: {
    labels: {
      list(args: { userId: string }): Promise<{ data: { labels?: Array<{ id?: string | null; name?: string | null }> | null } }>
      create(args: { userId: string; requestBody: { name: string; labelListVisibility?: string; messageListVisibility?: string } }): Promise<{ data: { id?: string | null } }>
    }
    messages: {
      modify(args: { userId: string; id: string; requestBody: { addLabelIds?: string[]; removeLabelIds?: string[] } }): Promise<unknown>
      get(args: { userId: string; id: string; format?: string; metadataHeaders?: string[] }): Promise<{ data: { id?: string | null; threadId?: string | null; labelIds?: string[] | null; snippet?: string | null; payload?: { headers?: Array<{ name?: string | null; value?: string | null }> | null } | null } }>
      list(args: { userId: string; q?: string; maxResults?: number }): Promise<{ data: { messages?: Array<{ id?: string | null }> | null } }>
    }
    threads: {
      get(args: { userId: string; id: string; format?: string }): Promise<{ data: { id?: string | null; messages?: Array<{ id?: string | null; payload?: { headers?: Array<{ name?: string | null; value?: string | null }> | null } | null }> | null } }>
    }
    drafts: {
      get(args: { userId: string; id: string; format?: string }): Promise<{ data: { id?: string | null; message?: { id?: string | null; threadId?: string | null; labelIds?: string[] | null; snippet?: string | null; payload?: { headers?: Array<{ name?: string | null; value?: string | null }> | null } | null } | null } }>
      send(args: { userId: string; requestBody: { id: string } }): Promise<unknown>
    }
  }
}

async function getOrCreateLabelId(gmail: GmailService, name: string): Promise<string> {
  if (labelIdCache.has(name)) return labelIdCache.get(name)!
  const list = await gmail.users.labels.list({ userId: 'me' })
  const existing = (list.data.labels ?? []).find((l) => l.name === name)
  if (existing?.id) {
    labelIdCache.set(name, existing.id)
    return existing.id
  }
  const created = await gmail.users.labels.create({
    userId: 'me',
    requestBody: { name, labelListVisibility: 'labelShow', messageListVisibility: 'show' },
  })
  if (!created.data.id) throw new Error(`failed to create label ${name}`)
  labelIdCache.set(name, created.data.id)
  return created.data.id
}

async function applyLaneLabel(gmail: GmailService, messageId: string, lane: Lane): Promise<string> {
  const labelName = laneLabelName(lane)
  const labelId = await getOrCreateLabelId(gmail, labelName)
  await gmail.users.messages.modify({
    userId: 'me',
    id: messageId,
    requestBody: { addLabelIds: [labelId] },
  })
  return labelName
}

function principalForAlex(): Principal {
  return 'jeff'
}

function dispatcherDir(): string {
  // The compiled gmail.ts ships under /app/scripts/google-workspace/ in the
  // Fly image. The dispatcher root is two levels up.
  // Allow override via env for tests.
  return process.env.DISPATCHER_DIR || '/app'
}

function laneAuditPath(): string {
  const stateDir = process.env.STATE_DIR || '/data/state'
  return join(stateDir, 'lanes-audit.jsonl')
}

interface LaneAuditEntry {
  ts: string
  principal: Principal
  action: 'draft-tag' | 'send-graduated' | 'send-blocked'
  draftId?: string
  messageId?: string
  threadId?: string
  lane?: Lane
  reasons?: string[]
  forceApproval?: { force: boolean; reason: string | null }
  graduation?: { allowed: boolean; reason: string }
  blockedReason?: string
  correlationId?: string
}

function appendLaneAudit(entry: Omit<LaneAuditEntry, 'ts'>): void {
  try {
    const path = laneAuditPath()
    mkdirSync(dirname(path), { recursive: true })
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry })
    appendFileSync(path, line + '\n', { encoding: 'utf8' })
  } catch {
    // Audit failures must not block the main path. Stderr captures the issue
    // via the dispatcher's worker stdout/stderr collector.
  }
}

interface ClassifyForOutboundInput {
  subject: string
  body: string
  fromHeader: string
}

function classifyOutbound(input: ClassifyForOutboundInput): ReturnType<typeof classify> {
  return classify({
    subject: input.subject,
    body: input.body,
    fromHeader: input.fromHeader,
    internalDomains: ['waterroads.com.au', 'cbsaustralia.com.au', 'cbs.com.au'],
  })
}

async function listUnread(args: Args) {
  const gmail = gmailService(ALEX_PRINCIPAL)
  const maxResults = Number(args.max ?? 25)
  const q = (args.query as string) ?? 'is:unread in:inbox'
  const list = await gmail.users.messages.list({ userId: 'me', q, maxResults })
  const ids = list.data.messages?.map((m) => m.id!).filter(Boolean) ?? []
  const summaries = await Promise.all(
    ids.map(async (id) => {
      const msg = await gmail.users.messages.get({
        userId: 'me',
        id,
        format: 'metadata',
        metadataHeaders: ['From', 'Subject', 'Date', 'To'],
      })
      return {
        id: msg.data.id,
        threadId: msg.data.threadId,
        snippet: msg.data.snippet,
        from: header(msg.data.payload?.headers, 'From'),
        to: header(msg.data.payload?.headers, 'To'),
        subject: header(msg.data.payload?.headers, 'Subject'),
        date: header(msg.data.payload?.headers, 'Date'),
        labels: msg.data.labelIds,
      }
    }),
  )
  ok({ count: summaries.length, query: q, messages: summaries })
}

function decodeBody(data: string | null | undefined): string {
  if (!data) return ''
  return Buffer.from(data, 'base64url').toString('utf8')
}

interface PayloadPart {
  mimeType?: string | null
  body?: { data?: string | null } | null
  parts?: PayloadPart[] | null
}

function extractBody(payload: PayloadPart | undefined): { textPlain: string; textHtml: string } {
  let textPlain = ''
  let textHtml = ''
  if (!payload) return { textPlain, textHtml }
  const walk = (p: PayloadPart) => {
    if (p.mimeType === 'text/plain' && p.body?.data) {
      textPlain += decodeBody(p.body.data)
    } else if (p.mimeType === 'text/html' && p.body?.data) {
      textHtml += decodeBody(p.body.data)
    }
    for (const child of p.parts ?? []) walk(child)
  }
  walk(payload)
  return { textPlain, textHtml }
}

async function getMessage(args: Args) {
  const id = String(args.id ?? '')
  if (!id) fail('--id required', 'BAD_ARGS')
  const gmail = gmailService(ALEX_PRINCIPAL)
  const msg = await gmail.users.messages.get({ userId: 'me', id, format: 'full' })
  const body = extractBody(msg.data.payload as PayloadPart | undefined)
  ok({
    id: msg.data.id,
    threadId: msg.data.threadId,
    snippet: msg.data.snippet,
    from: header(msg.data.payload?.headers, 'From'),
    to: header(msg.data.payload?.headers, 'To'),
    cc: header(msg.data.payload?.headers, 'Cc'),
    subject: header(msg.data.payload?.headers, 'Subject'),
    date: header(msg.data.payload?.headers, 'Date'),
    labels: msg.data.labelIds,
    textPlain: body.textPlain,
    textHtml: body.textHtml,
  })
}

async function listThreads(args: Args) {
  const gmail = gmailService(ALEX_PRINCIPAL)
  const maxResults = Number(args.max ?? 25)
  const q = (args.query as string) ?? 'in:inbox'
  const list = await gmail.users.threads.list({ userId: 'me', q, maxResults })
  const summaries = (list.data.threads ?? []).map((t) => ({
    id: t.id,
    snippet: t.snippet,
    historyId: t.historyId,
  }))
  ok({ count: summaries.length, query: q, threads: summaries })
}

async function getThread(args: Args) {
  const id = String(args.id ?? '')
  if (!id) fail('--id required', 'BAD_ARGS')
  const gmail = gmailService(ALEX_PRINCIPAL)
  const t = await gmail.users.threads.get({ userId: 'me', id, format: 'full' })
  const messages = (t.data.messages ?? []).map((m) => {
    const body = extractBody(m.payload as PayloadPart | undefined)
    return {
      id: m.id,
      from: header(m.payload?.headers, 'From'),
      to: header(m.payload?.headers, 'To'),
      subject: header(m.payload?.headers, 'Subject'),
      date: header(m.payload?.headers, 'Date'),
      snippet: m.snippet,
      labels: m.labelIds,
      textPlain: body.textPlain,
    }
  })
  ok({ id: t.data.id, historyId: t.data.historyId, count: messages.length, messages })
}

function buildRfc822({
  to,
  subject,
  body,
  inReplyTo,
  references,
  cc,
}: {
  to: string
  subject: string
  body: string
  inReplyTo?: string
  references?: string
  cc?: string
}): string {
  const lines = [`From: jeffdusting@waterroads.com.au`, `To: ${to}`]
  if (cc) lines.push(`Cc: ${cc}`)
  lines.push(`Subject: ${subject}`)
  if (inReplyTo) lines.push(`In-Reply-To: ${inReplyTo}`)
  if (references) lines.push(`References: ${references}`)
  lines.push('Content-Type: text/plain; charset="UTF-8"', 'MIME-Version: 1.0', '', body)
  return lines.join('\r\n')
}

async function draftReply(args: Args) {
  const threadId = String(args['thread-id'] ?? '')
  const body = String(args.body ?? '')
  if (!threadId || !body) fail('--thread-id and --body required', 'BAD_ARGS')
  const gmail = gmailService(ALEX_PRINCIPAL)
  const t = await gmail.users.threads.get({ userId: 'me', id: threadId, format: 'full' })
  const last = (t.data.messages ?? []).at(-1)
  if (!last) fail(`thread ${threadId} has no messages`, 'EMPTY_THREAD')
  const fromAddr = header(last.payload?.headers, 'From')
  const subject = header(last.payload?.headers, 'Subject')
  const messageIdHeader = header(last.payload?.headers, 'Message-ID')
  const refs = header(last.payload?.headers, 'References')
  const replySubject = subject.toLowerCase().startsWith('re:') ? subject : `Re: ${subject}`

  // Classify against the inbound message so the outbound draft inherits the
  // lane the inbound landed in. This keeps drafts traceable: a reply to a
  // government enquiry stays in approval; a reply to an internal-domain
  // scheduling chat stays autonomous.
  const inboundBody = String((last.payload as { body?: { data?: string } } | undefined)?.body?.data ?? '')
  const inboundDecoded = inboundBody ? Buffer.from(inboundBody, 'base64url').toString('utf8').slice(0, 2000) : ''
  const classification = classifyOutbound({
    subject: subject || '',
    body: inboundDecoded,
    fromHeader: fromAddr,
  })
  const principal = principalForAlex()
  const overlay = shouldForceApproval({
    fromHeader: fromAddr,
    config: loadAlwaysApprovalConfig(alwaysApprovalConfigPath(dispatcherDir(), principal)),
  })
  const effectiveLane: Lane = overlay.force ? 'approval' : classification.lane

  const rfc822 = buildRfc822({
    to: fromAddr,
    subject: replySubject,
    body,
    inReplyTo: messageIdHeader || undefined,
    references: [refs, messageIdHeader].filter(Boolean).join(' ') || undefined,
  })
  const raw = Buffer.from(rfc822, 'utf8').toString('base64url')
  const draft = await gmail.users.drafts.create({
    userId: 'me',
    requestBody: { message: { raw, threadId } },
  })

  const messageId = draft.data.message?.id ?? ''
  let labelApplied: string | null = null
  if (messageId) {
    try {
      labelApplied = await applyLaneLabel(gmail, messageId, effectiveLane)
    } catch (err) {
      // Label-apply failure is recoverable — draft exists; lane just is not
      // tagged. Surface in audit but do not fail the call.
      appendLaneAudit({
        principal,
        action: 'draft-tag',
        draftId: draft.data.id ?? undefined,
        messageId,
        threadId: draft.data.message?.threadId ?? undefined,
        lane: effectiveLane,
        blockedReason: `label-apply-failed: ${(err as Error).message}`,
      })
    }
  }

  appendLaneAudit({
    principal,
    action: 'draft-tag',
    draftId: draft.data.id ?? undefined,
    messageId,
    threadId: draft.data.message?.threadId ?? undefined,
    lane: effectiveLane,
    reasons: classification.reasons,
    forceApproval: overlay,
    correlationId: process.env.CLAUDE_CORRELATION_ID,
  })

  ok({
    draftId: draft.data.id,
    messageId: draft.data.message?.id,
    threadId: draft.data.message?.threadId,
    lane: effectiveLane,
    classifierLane: classification.lane,
    classifierConfidence: classification.confidence,
    classifierReasons: classification.reasons,
    forceApproval: overlay,
    laneLabel: labelApplied,
    note: 'drafts-only — send via send-graduated only when graduated',
  })
}

async function draftNew(args: Args) {
  const to = String(args.to ?? '')
  const subject = String(args.subject ?? '')
  const body = String(args.body ?? '')
  const cc = args.cc ? String(args.cc) : undefined
  if (!to || !subject || !body) fail('--to, --subject and --body required', 'BAD_ARGS')
  const gmail = gmailService(ALEX_PRINCIPAL)

  // For draft-new there is no inbound message — classify the outbound itself.
  // Use the To: address as the fromHeader proxy so gov/internal/category
  // signals still apply. Always-approval overlay also runs against the To:.
  const classification = classifyOutbound({ subject, body, fromHeader: to })
  const principal = principalForAlex()
  const overlay = shouldForceApproval({
    fromHeader: to,
    config: loadAlwaysApprovalConfig(alwaysApprovalConfigPath(dispatcherDir(), principal)),
  })
  const effectiveLane: Lane = overlay.force ? 'approval' : classification.lane

  const rfc822 = buildRfc822({ to, subject, body, cc })
  const raw = Buffer.from(rfc822, 'utf8').toString('base64url')
  const draft = await gmail.users.drafts.create({ userId: 'me', requestBody: { message: { raw } } })

  const messageId = draft.data.message?.id ?? ''
  let labelApplied: string | null = null
  if (messageId) {
    try {
      labelApplied = await applyLaneLabel(gmail, messageId, effectiveLane)
    } catch (err) {
      appendLaneAudit({
        principal,
        action: 'draft-tag',
        draftId: draft.data.id ?? undefined,
        messageId,
        threadId: draft.data.message?.threadId ?? undefined,
        lane: effectiveLane,
        blockedReason: `label-apply-failed: ${(err as Error).message}`,
      })
    }
  }

  appendLaneAudit({
    principal,
    action: 'draft-tag',
    draftId: draft.data.id ?? undefined,
    messageId,
    threadId: draft.data.message?.threadId ?? undefined,
    lane: effectiveLane,
    reasons: classification.reasons,
    forceApproval: overlay,
    correlationId: process.env.CLAUDE_CORRELATION_ID,
  })

  ok({
    draftId: draft.data.id,
    messageId: draft.data.message?.id,
    threadId: draft.data.message?.threadId,
    lane: effectiveLane,
    classifierLane: classification.lane,
    classifierConfidence: classification.confidence,
    classifierReasons: classification.reasons,
    forceApproval: overlay,
    laneLabel: labelApplied,
    note: 'drafts-only — send via send-graduated only when graduated',
  })
}

async function laneFromLabels(
  gmail: GmailService,
  messageId: string,
): Promise<Lane | null> {
  const list = await gmail.users.labels.list({ userId: 'me' })
  const labels = list.data.labels ?? []
  const msg = await gmail.users.messages.get({ userId: 'me', id: messageId, format: 'metadata' })
  const labelIds = msg.data.labelIds ?? []
  for (const id of labelIds) {
    const l = labels.find((x) => x.id === id)
    if (!l?.name) continue
    if (l.name === laneLabelName('autonomous')) return 'autonomous'
    if (l.name === laneLabelName('approval')) return 'approval'
    if (l.name === laneLabelName('principal_only')) return 'principal_only'
  }
  return null
}

async function listDrafts(args: Args) {
  const gmail = gmailService(ALEX_PRINCIPAL)
  const maxResults = Number(args.max ?? 25)
  const list = await gmail.users.drafts.list({ userId: 'me', maxResults })
  const ids = list.data.drafts?.map((d) => d.id!).filter(Boolean) ?? []
  const drafts = await Promise.all(
    ids.map(async (id) => {
      const d = await gmail.users.drafts.get({
        userId: 'me',
        id,
        format: 'metadata',
      })
      const messageId = d.data.message?.id ?? null
      const lane = messageId ? await laneFromLabels(gmail, messageId) : null
      return {
        draftId: d.data.id,
        messageId,
        threadId: d.data.message?.threadId,
        snippet: d.data.message?.snippet,
        to: header(d.data.message?.payload?.headers, 'To'),
        subject: header(d.data.message?.payload?.headers, 'Subject'),
        lane,
      }
    }),
  )
  ok({ count: drafts.length, drafts })
}

async function deleteDraft(args: Args) {
  const id = String(args.id ?? '')
  if (!id) fail('--id required', 'BAD_ARGS')
  const gmail = gmailService(ALEX_PRINCIPAL)
  await gmail.users.drafts.delete({ userId: 'me', id })
  ok({ draftId: id, deleted: true })
}

async function sendGraduated(args: Args) {
  const id = String(args.id ?? '')
  if (!id) fail('--id required', 'BAD_ARGS')
  const gmail = gmailService(ALEX_PRINCIPAL)
  const principal = principalForAlex()

  // Step 1 — fetch the draft and resolve its lane label.
  const draft = await gmail.users.drafts.get({ userId: 'me', id, format: 'metadata' })
  const messageId = draft.data.message?.id
  if (!messageId) fail(`draft ${id} has no underlying message`, 'API_ERROR')
  const lane = await laneFromLabels(gmail, messageId)
  if (!lane) {
    appendLaneAudit({
      principal,
      action: 'send-blocked',
      draftId: id,
      messageId,
      threadId: draft.data.message?.threadId ?? undefined,
      blockedReason: 'no-lane-label',
      correlationId: process.env.CLAUDE_CORRELATION_ID,
    })
    fail(`draft ${id} has no lane label — was it created via this helper? send-graduated requires lane-tagging`, 'NO_LANE_LABEL')
  }

  // Step 2 — apply always-approval overlay against the To: address.
  const toHeader = header(draft.data.message?.payload?.headers, 'To')
  const overlay = shouldForceApproval({
    fromHeader: toHeader,
    config: loadAlwaysApprovalConfig(alwaysApprovalConfigPath(dispatcherDir(), principal)),
  })
  if (overlay.force) {
    appendLaneAudit({
      principal,
      action: 'send-blocked',
      draftId: id,
      messageId,
      threadId: draft.data.message?.threadId ?? undefined,
      lane,
      forceApproval: overlay,
      blockedReason: `overlay-forced-approval: ${overlay.reason}`,
      correlationId: process.env.CLAUDE_CORRELATION_ID,
    })
    fail(
      `always-approval overlay forces principal approval for this recipient: ${overlay.reason}`,
      'OVERLAY_FORCES_APPROVAL',
    )
  }

  // Step 3 — check graduation config.
  const grad = canAutoSend(lane, loadGraduationConfig(graduationConfigPath(dispatcherDir(), principal)))
  if (!grad.allowed) {
    appendLaneAudit({
      principal,
      action: 'send-blocked',
      draftId: id,
      messageId,
      threadId: draft.data.message?.threadId ?? undefined,
      lane,
      forceApproval: overlay,
      graduation: grad,
      blockedReason: grad.reason,
      correlationId: process.env.CLAUDE_CORRELATION_ID,
    })
    fail(`lane '${lane}' is not graduated for principal '${principal}' — drafts-only. Edit config/graduation-${principal}.json to graduate.`, 'LANE_NOT_GRADUATED')
  }

  // Step 4 — send. Audit-log the success.
  await gmail.users.drafts.send({ userId: 'me', requestBody: { id } })
  appendLaneAudit({
    principal,
    action: 'send-graduated',
    draftId: id,
    messageId,
    threadId: draft.data.message?.threadId ?? undefined,
    lane,
    forceApproval: overlay,
    graduation: grad,
    correlationId: process.env.CLAUDE_CORRELATION_ID,
  })
  ok({
    draftId: id,
    messageId,
    threadId: draft.data.message?.threadId,
    sent: true,
    lane,
    graduation: grad,
    forceApproval: overlay,
  })
}

const COMMANDS: Record<string, (args: Args) => Promise<void>> = {
  'list-unread': listUnread,
  'get-message': getMessage,
  'list-threads': listThreads,
  'get-thread': getThread,
  'draft-reply': draftReply,
  'draft-new': draftNew,
  'list-drafts': listDrafts,
  'delete-draft': deleteDraft,
  'send-graduated': sendGraduated,
}

async function main() {
  const argv = process.argv.slice(2)
  const cmd = argv[0]
  if (!cmd || !COMMANDS[cmd]) {
    fail(
      `unknown subcommand. Available: ${Object.keys(COMMANDS).join(', ')}. Send is intentionally absent — drafts only.`,
      'UNKNOWN_COMMAND',
    )
  }
  try {
    await COMMANDS[cmd](parseArgs(argv.slice(1)))
  } catch (e) {
    if (e instanceof AuthError) fail(e.message, e.code)
    const err = e as Error
    fail(err.message ?? String(e), 'API_ERROR')
  }
}

main()
