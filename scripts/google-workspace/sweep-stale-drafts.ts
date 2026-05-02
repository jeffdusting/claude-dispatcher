#!/usr/bin/env bun
/**
 * Sweep stale drafts whose threads have a newer principal-side reply.
 *
 * Port of `~/claude-workspace/alex-morgan/runtime/approval_sweep.py`.
 *
 * The principal (Jeff for Alex; Sarah for Quinn) sometimes replies directly
 * from their own Gmail client without going through the EA's draft. When
 * that happens, the EA's lane-tagged draft becomes stale — the conversation
 * has moved on. This sweep deletes drafts whose Gmail thread has a SENT
 * message newer than the draft's creation timestamp.
 *
 * Run by supercronic on a sensible cadence (every 30 minutes — a stale
 * draft does not need same-tick cleanup; the principal's send already
 * landed). Output goes to stdout as JSON; the dispatcher's worker stdout
 * collector pairs it with the boot context.
 *
 * Per R-952 — preserves drafts-only safety property by ensuring the queue
 * does not accumulate stale work the operator already actioned.
 */

import { appendFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { ALEX_PRINCIPAL, gmailService, AuthError } from './auth.js'
import type { Principal } from '../../src/lanes/types.js'

interface SweepResult {
  checked: number
  superseded: number
  kept: number
  errors: string[]
}

function laneAuditPath(): string {
  const stateDir = process.env.STATE_DIR || '/data/state'
  return join(stateDir, 'lanes-audit.jsonl')
}

function appendAudit(entry: Record<string, unknown>): void {
  try {
    const path = laneAuditPath()
    mkdirSync(dirname(path), { recursive: true })
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry })
    appendFileSync(path, line + '\n', { encoding: 'utf8' })
  } catch {
    // Audit failures must not block the main path.
  }
}

function header(
  headers: { name?: string | null; value?: string | null }[] | undefined,
  name: string,
): string {
  if (!headers) return ''
  const h = headers.find((x) => x.name?.toLowerCase() === name.toLowerCase())
  return h?.value ?? ''
}

async function sweepForPrincipal(principal: Principal, principalEmail: string): Promise<SweepResult> {
  const result: SweepResult = { checked: 0, superseded: 0, kept: 0, errors: [] }
  const gmail = gmailService(principal === 'jeff' ? ALEX_PRINCIPAL : ALEX_PRINCIPAL)
  // Note: at v0.1 only Jeff's principal is wired via the auth helper. Quinn-
  // side gating items (R-951) provision a separate auth path. Until those
  // resolve, the sweep against Sarah's mailbox is a no-op — we report 0
  // checked rather than fail.
  if (principal !== 'jeff') {
    return result
  }

  const list = await gmail.users.drafts.list({ userId: 'me', maxResults: 100 })
  const draftIds = list.data.drafts?.map((d) => d.id!).filter(Boolean) ?? []
  result.checked = draftIds.length

  for (const draftId of draftIds) {
    try {
      const d = await gmail.users.drafts.get({ userId: 'me', id: draftId, format: 'metadata' })
      const message = d.data.message
      const threadId = message?.threadId
      const draftMessageId = message?.id
      if (!threadId || !draftMessageId) {
        result.kept++
        continue
      }

      // Use the message's internalDate as the draft's creation reference.
      // Gmail returns it as a string of milliseconds.
      const draftMsg = await gmail.users.messages.get({ userId: 'me', id: draftMessageId, format: 'metadata' })
      const draftCreatedMs = Number((draftMsg.data as { internalDate?: string }).internalDate ?? 0)
      const subject = header(draftMsg.data.payload?.headers, 'Subject')
      const to = header(draftMsg.data.payload?.headers, 'To')

      const thread = await gmail.users.threads.get({ userId: 'me', id: threadId, format: 'metadata' })
      let hasNewerPrincipalSend = false
      for (const m of thread.data.messages ?? []) {
        if (m.id === draftMessageId) continue
        const labels = m.labelIds ?? []
        if (!labels.includes('SENT')) continue
        const fromHeader = header(m.payload?.headers, 'From').toLowerCase()
        if (!fromHeader.includes(principalEmail.toLowerCase())) continue
        const internalMs = Number((m as { internalDate?: string }).internalDate ?? 0)
        if (internalMs > draftCreatedMs) {
          hasNewerPrincipalSend = true
          break
        }
      }

      if (hasNewerPrincipalSend) {
        await gmail.users.drafts.delete({ userId: 'me', id: draftId })
        result.superseded++
        appendAudit({
          principal,
          action: 'draft-superseded',
          draftId,
          messageId: draftMessageId,
          threadId,
          to,
          subject,
          reason: `principal already sent in thread post-draft`,
        })
      } else {
        result.kept++
      }
    } catch (e) {
      result.kept++
      result.errors.push(`draft ${draftId}: ${(e as Error).message}`)
      appendAudit({
        principal,
        action: 'draft-sweep-error',
        draftId,
        error: (e as Error).message,
      })
    }
  }

  return result
}

async function main() {
  const out: Record<string, SweepResult | { error: string; code?: string }> = {}
  try {
    out.jeff = await sweepForPrincipal('jeff', ALEX_PRINCIPAL)
  } catch (e) {
    if (e instanceof AuthError) {
      out.jeff = { error: e.message, code: e.code }
    } else {
      out.jeff = { error: (e as Error).message }
    }
  }
  // Quinn-side sweep is a no-op until R-951 Quinn side resolves and the
  // helper auth path is duplicated for Sarah. Report explicitly so operators
  // know the sweep ran but did nothing for that principal.
  out.sarah = { checked: 0, superseded: 0, kept: 0, errors: ['quinn-side helper not yet wired (R-951 gating)'] }
  console.log(JSON.stringify(out, null, 2))
}

main()
