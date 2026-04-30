/**
 * Tender classifier (Phase H §12.3).
 *
 * Examines a project brief plus its origin-channel context and decides
 * whether the brief is a tender opportunity that should auto-route to the
 * tender-processing queue rather than the general project-kickoff inbox.
 *
 * Design choices:
 *   - The classifier is deliberately precision-biased. A false positive
 *     diverts work to the wrong queue and the CoS has to re-route it
 *     manually, which is expensive. A false negative falls back to the
 *     normal kickoff path, where Jeff can re-classify with one Discord
 *     turn — cheap. So the rules favour high-confidence single signals
 *     and require pairing for ambiguous keywords.
 *   - Channel-name match (substring "tender") and the unambiguous
 *     procurement abbreviations (RFI, RFT, RFQ, RFP, EOI) are each
 *     sufficient on their own.
 *   - The generic single word "tender" or the phrase "closing date" only
 *     trip the classifier if paired with another signal — they appear
 *     too often in non-tender contexts.
 *   - The recommended-agent decision is a function of the entity owning
 *     the kickoff: tender-bearing channels in WaterRoads get the WR
 *     Tender Review agent; CBS-side or unmapped channels get the CBS
 *     Office Management agent (the same agent that handles cross-entity
 *     mail intake under Phase G.5). The handler reading this struct
 *     resolves the actual agent identifier from its agent registry.
 */

import type { Entity } from './entity.js'

export type TenderRecommendedAgent = 'office-management' | 'tender-review'

export interface TenderClassification {
  /** Whether the message classifies as a tender. */
  isTender: boolean
  /**
   * Human-readable signal labels that fired. Empty when isTender is false
   * and nothing matched. Useful for audit and for surfacing to the
   * operator in the kickoff prompt.
   */
  signals: string[]
  /**
   * Recommended agent for handling the tender. Null when isTender is
   * false. Set deterministically by entity — see the design note above.
   */
  recommendedAgent: TenderRecommendedAgent | null
}

/**
 * Single-signal-sufficient patterns. Each match counts as a strong
 * indicator — one is enough to route. Word-boundary anchoring avoids
 * matching substrings inside unrelated words.
 */
const STRONG_KEYWORD_PATTERNS: ReadonlyArray<{ label: string; re: RegExp }> = [
  { label: 'rfi', re: /\bRFI\b/i },
  { label: 'rft', re: /\bRFT\b/i },
  { label: 'rfq', re: /\bRFQ\b/i },
  { label: 'rfp', re: /\bRFP\b/i },
  { label: 'eoi', re: /\bEOI\b/i },
  { label: 'expression-of-interest', re: /\bexpressions?\s+of\s+interest\b/i },
  { label: 'request-for-proposal', re: /\brequest\s+for\s+proposal\b/i },
  { label: 'request-for-tender', re: /\brequest\s+for\s+tender\b/i },
  { label: 'request-for-quote', re: /\brequest\s+for\s+quote\b/i },
  { label: 'request-for-information', re: /\brequest\s+for\s+information\b/i },
  { label: 'tender-notice', re: /\btender\s+notice\b/i },
  { label: 'tender-number', re: /\btender\s+(?:number|id|no\.?|ref(?:erence)?)\b/i },
  { label: 'austender', re: /\bAusTender\b/i },
  { label: 'procurepoint', re: /\bProcurePoint\b/i },
  { label: 'etendering', re: /\beTendering\b/i },
  { label: 'tenders-vic', re: /\bTenders\s+VIC\b/i },
  { label: 'queensland-tenders', re: /\bQueensland\s+Tenders\b/i },
]

/**
 * Weak patterns — each contributes one count toward a pairing threshold.
 * Two weak signals (or one weak + one structural cue) are enough to route.
 * Single weak match alone is not.
 */
const WEAK_KEYWORD_PATTERNS: ReadonlyArray<{ label: string; re: RegExp }> = [
  { label: 'tender-word', re: /\btender(?:s|ing|ed)?\b/i },
  { label: 'closing-date', re: /\bclosing\s+date\b/i },
  { label: 'submission-deadline', re: /\bsubmission\s+deadline\b/i },
  { label: 'procurement', re: /\bprocurement\b/i },
  { label: 'panel-arrangement', re: /\bpanel\s+arrangement\b/i },
]

/**
 * Forwarded-email subject cues. The brief usually contains the original
 * email subject when CoS has been forwarded an opportunity; "Fwd:" + a
 * tender keyword is a structural cue we count as one weak signal.
 */
const FORWARDED_EMAIL_PATTERNS: ReadonlyArray<{ label: string; re: RegExp }> = [
  { label: 'forwarded-email', re: /^(?:re|fwd|fw):\s*/im },
]

export interface ClassifyTenderInput {
  /** The project brief that the kickoff is being created from. */
  brief: string
  /** Optional origin-channel name — substring match on "tender" is a strong cue. */
  channelName?: string | null
  /** Optional resolved entity for the kickoff — drives the recommended-agent choice. */
  entity?: Entity | null
}

/**
 * Classify a brief plus optional channel context as tender or not.
 *
 * Returns `{ isTender: false, signals: [], recommendedAgent: null }`
 * when nothing matches. Callers fall through to the existing kickoff
 * path in that case.
 */
export function classifyTender(input: ClassifyTenderInput): TenderClassification {
  const { brief, channelName, entity } = input
  const signals: string[] = []
  let strongMatches = 0
  let weakMatches = 0

  // Channel name: a name containing "tender" is a deliberate signal.
  if (channelName && /tender/i.test(channelName)) {
    signals.push('channel-name')
    strongMatches += 1
  }

  // Strong keyword scan over the brief.
  for (const { label, re } of STRONG_KEYWORD_PATTERNS) {
    if (re.test(brief)) {
      signals.push(`keyword:${label}`)
      strongMatches += 1
    }
  }

  // Weak keyword scan — each contributes toward the pairing threshold.
  for (const { label, re } of WEAK_KEYWORD_PATTERNS) {
    if (re.test(brief)) {
      signals.push(`weak:${label}`)
      weakMatches += 1
    }
  }

  // Forwarded-email cue — counted as a weak signal since "Re:"/"Fwd:" is
  // common but rarely appears alongside a tender brief by accident.
  for (const { label, re } of FORWARDED_EMAIL_PATTERNS) {
    if (re.test(brief)) {
      signals.push(`structural:${label}`)
      weakMatches += 1
    }
  }

  const isTender = strongMatches >= 1 || weakMatches >= 2

  return {
    isTender,
    signals,
    recommendedAgent: isTender ? recommendAgent(entity ?? null) : null,
  }
}

/**
 * Pick the recommended handler agent given the resolved entity.
 *
 * - WR-owned tenders go to the WaterRoads Tender Review agent (external
 *   business development pipeline, substantive review of opportunities).
 * - CBS-owned and entity-unknown tenders go to the CBS Office Management
 *   agent — that agent already handles the Phase G.5 cross-entity mail
 *   intake skill and is the right first port for triaging an unfamiliar
 *   opportunity into the right reviewer.
 */
function recommendAgent(entity: Entity | null): TenderRecommendedAgent {
  if (entity === 'wr') return 'tender-review'
  return 'office-management'
}
