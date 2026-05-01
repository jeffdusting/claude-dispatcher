#!/usr/bin/env bun
/**
 * Gmail helper for Alex (acting on jeffdusting@waterroads.com.au).
 *
 * Subcommands:
 *   list-unread [--max N] [--query "Q"]   — list unread (or query-matched) messages, summary form.
 *   get-message --id ID                    — fetch full message body + headers as JSON.
 *   list-threads [--max N] [--query "Q"]  — list threads with subject + last-message snippet.
 *   get-thread --id ID                     — fetch a thread with all messages.
 *   draft-reply --thread-id ID --body B   — create a draft reply on the thread.
 *   draft-new --to T --subject S --body B  — create a brand-new draft.
 *   list-drafts [--max N]                  — list draft IDs with subject + recipient.
 *   delete-draft --id ID                   — delete a draft.
 *
 * Send is INTENTIONALLY ABSENT. Per the operator's standing rule, Alex never
 * sends as Jeff. Drafts only. Future graduation to autonomous-send for
 * specific email types is tracked under R-952 (approval-lane port from the
 * pre-migration alex-morgan runtime).
 *
 * All output is JSON to stdout. Errors print { ok: false, error: ... } and
 * exit non-zero.
 */

import { ALEX_PRINCIPAL, gmailService, AuthError } from './auth.js'

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
  const t = await gmail.users.threads.get({ userId: 'me', id: threadId, format: 'metadata' })
  const last = (t.data.messages ?? []).at(-1)
  if (!last) fail(`thread ${threadId} has no messages`, 'EMPTY_THREAD')
  const fromAddr = header(last.payload?.headers, 'From')
  const subject = header(last.payload?.headers, 'Subject')
  const messageIdHeader = header(last.payload?.headers, 'Message-ID')
  const refs = header(last.payload?.headers, 'References')
  const replySubject = subject.toLowerCase().startsWith('re:') ? subject : `Re: ${subject}`
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
  ok({
    draftId: draft.data.id,
    messageId: draft.data.message?.id,
    threadId: draft.data.message?.threadId,
    note: 'drafts-only — operator approval required before send',
  })
}

async function draftNew(args: Args) {
  const to = String(args.to ?? '')
  const subject = String(args.subject ?? '')
  const body = String(args.body ?? '')
  const cc = args.cc ? String(args.cc) : undefined
  if (!to || !subject || !body) fail('--to, --subject and --body required', 'BAD_ARGS')
  const gmail = gmailService(ALEX_PRINCIPAL)
  const rfc822 = buildRfc822({ to, subject, body, cc })
  const raw = Buffer.from(rfc822, 'utf8').toString('base64url')
  const draft = await gmail.users.drafts.create({ userId: 'me', requestBody: { message: { raw } } })
  ok({
    draftId: draft.data.id,
    messageId: draft.data.message?.id,
    threadId: draft.data.message?.threadId,
    note: 'drafts-only — operator approval required before send',
  })
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
      return {
        draftId: d.data.id,
        messageId: d.data.message?.id,
        threadId: d.data.message?.threadId,
        snippet: d.data.message?.snippet,
        to: header(d.data.message?.payload?.headers, 'To'),
        subject: header(d.data.message?.payload?.headers, 'Subject'),
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

const COMMANDS: Record<string, (args: Args) => Promise<void>> = {
  'list-unread': listUnread,
  'get-message': getMessage,
  'list-threads': listThreads,
  'get-thread': getThread,
  'draft-reply': draftReply,
  'draft-new': draftNew,
  'list-drafts': listDrafts,
  'delete-draft': deleteDraft,
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
