/**
 * Lane classifier — rule-based first pass over inbound message metadata.
 *
 * Ports `~/claude-workspace/alex-morgan/runtime/lane_classifier.py`. Two-stage
 * design: deterministic rules cover the routine cases; ambiguity falls
 * through to the default (approval) lane. A future Claude-fallback for
 * genuinely ambiguous cases can layer on top — kept out of v0.1.0 to keep the
 * classifier sub-second and free.
 *
 * The classifier is principal-agnostic. The always-approval overlay
 * (`alwaysApproval.ts`) layers on top and may force an approval-or-stricter
 * lane regardless of what this returns.
 */

import { isGovernmentDomain, senderDomain } from './govDomain.js'
import type { ClassifyInput, ClassifyResult, Lane } from './types.js'

// ---------- Word-list signals ------------------------------------------------

const MINISTERIAL_INDICATORS = [
  'minister',
  'chief of staff',
  'secretary',
  'ministerial',
  'premier',
  'cabinet',
  '@minister',
  'transport minister',
]

const MEDIA_INDICATORS = [
  'journalist',
  'reporter',
  'press',
  'media enquiry',
  'media inquiry',
  'interview request',
  'comment for publication',
  'quote for',
  'abc news',
  'smh.com.au',
  'afr.com',
  'guardian.com',
  '@news.com.au',
]

const COMMERCIAL_INDICATORS = [
  'quote',
  'pricing',
  'price point',
  'contract terms',
  'nda',
  'msa',
  'non-disclosure',
  'heads of agreement',
  'term sheet',
  'commercial in confidence',
  'payment terms',
  'purchase order',
]

const HR_INDICATORS = [
  'grievance',
  'complaint',
  'disciplinary',
  'termination',
  'performance review',
  'hiring decision',
  'resignation',
]

const COMMITMENT_INDICATORS = [
  'speaking slot',
  'keynote',
  'panel invitation',
  'board role',
  'advisory role',
  'event invitation',
]

const AUTONOMOUS_SUBJECT_PATTERNS = [
  /^\s*re:\s*confirm(ed|ing)?/i,
  /^\s*re:\s*scheduled/i,
  /^\s*calendar invitation/i,
  /^\s*meeting invite/i,
  /^\s*read:\s/i,
  /^\s*delivery status notification/i,
]

const SUBSTANTIVE_ASK_PATTERNS = [
  /\?\s*$/,
  /\bwhen can\b/i,
  /\bcould you\b/i,
  /\bwould you\b/i,
  /\bplease confirm\b/i,
  /\bplease advise\b/i,
  /\bwhat are your thoughts\b/i,
  /\bcan you send\b/i,
  /\bour position\b/i,
  /\byour view on\b/i,
]

const ACK_ONLY_PATTERNS = [
  /^\s*thanks?\b/i,
  /^\s*thank you\b/i,
  /^\s*appreciated\b/i,
  /^\s*noted\b/i,
  /^\s*received\b/i,
  /^\s*got it\b/i,
]

const SCHEDULING_SUBJECT = /\b(meeting|catch[- ]up|call|chat)\b/i
const SCHEDULING_BODY = /\b(available|availability|suit|convenient|propose|free)\b/i

// ---------- Helpers ----------------------------------------------------------

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Word-boundary match for short keywords; substring for multi-word phrases. */
function has(needles: string[], haystack: string): boolean {
  const h = haystack.toLowerCase()
  for (const n of needles) {
    if (n.includes(' ')) {
      if (h.includes(n)) return true
      continue
    }
    const re = new RegExp(`\\b${escapeRegex(n)}\\b`, 'i')
    if (re.test(haystack)) return true
  }
  return false
}

function matches(patterns: RegExp[], text: string): boolean {
  return patterns.some((p) => p.test(text))
}

function result(lane: Lane, confidence: number, reasons: string[], topicTags: string[]): ClassifyResult {
  return { lane, confidence, reasons, topicTags }
}

// ---------- Classifier -------------------------------------------------------

export function classify(input: ClassifyInput): ClassifyResult {
  const { subject = '', body = '', fromHeader = '', counterpartyProfile, internalDomains = [] } = input

  const domain = senderDomain(fromHeader)
  const bodyHead = body.slice(0, 2000)
  const combined = `${subject}\n${bodyHead}`
  const senderIsGov = isGovernmentDomain(domain)

  // ---- Principal-only hard rules ------------------------------------------
  // Ministerial contact: requires gov sender AND ministerial signal.
  // A bulk email mentioning a minister attending an event is not direct contact.
  if (senderIsGov && has(MINISTERIAL_INDICATORS, combined)) {
    return result('principal_only', 0.95, ['ministerial/senior-gov contact from gov domain'], ['government', 'senior'])
  }
  if (has(MEDIA_INDICATORS, combined)) {
    return result('principal_only', 0.95, ['media enquiry signal'], ['media'])
  }
  if (has(COMMITMENT_INDICATORS, combined)) {
    return result('principal_only', 0.9, ['commitment ask (speaking/board/role)'], ['commitment'])
  }
  if (has(HR_INDICATORS, combined)) {
    return result('principal_only', 0.9, ['HR / personnel signal'], ['hr'])
  }

  // Profile-level principal-only overrides.
  if (counterpartyProfile?.jeff_only_topics) {
    for (const topic of counterpartyProfile.jeff_only_topics) {
      if (topic && combined.toLowerCase().includes(topic.toLowerCase())) {
        return result(
          'principal_only',
          0.95,
          [`counterparty profile flags '${topic}' as principal-only`],
          ['profile-flag'],
        )
      }
    }
  }

  // ---- Approval-lane signals ----------------------------------------------
  if (has(COMMERCIAL_INDICATORS, combined)) {
    return result('approval', 0.85, ['commercial terms / contract signal'], ['commercial'])
  }

  if (senderIsGov) {
    return result('approval', 0.85, [`government sender (${domain})`], ['government'])
  }

  if (counterpartyProfile?.category) {
    const cat = counterpartyProfile.category
    if (cat === 'board' || cat === 'investor' || cat === 'legal' || cat === 'regulator') {
      return result('approval', 0.85, [`counterparty category = ${cat}`], [cat])
    }
  }

  if (matches(SUBSTANTIVE_ASK_PATTERNS, combined)) {
    return result('approval', 0.6, ['substantive question detected'], ['substantive'])
  }

  // ---- Autonomous candidates ----------------------------------------------
  if (matches(AUTONOMOUS_SUBJECT_PATTERNS, subject)) {
    return result('autonomous', 0.85, ['routine subject pattern'], ['routine'])
  }
  if (matches(ACK_ONLY_PATTERNS, bodyHead)) {
    return result('autonomous', 0.75, ['acknowledgement-only body'], ['ack'])
  }
  if (SCHEDULING_SUBJECT.test(subject) && SCHEDULING_BODY.test(combined)) {
    return result('autonomous', 0.7, ['scheduling / availability request'], ['scheduling'])
  }

  if (domain && internalDomains.map((d) => d.toLowerCase()).includes(domain)) {
    return result('autonomous', 0.65, [`internal domain (${domain}), no substantive ask`], ['internal'])
  }

  // Default: approval lane (safer than autonomous when ambiguous).
  return result('approval', 0.5, ['default (ambiguous) → approval lane'], ['ambiguous'])
}
