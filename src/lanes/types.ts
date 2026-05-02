/**
 * Shared types for the approval-lane subsystem (R-952).
 *
 * Three lanes describe how an inbound message (or the outbound it triggers)
 * should be handled:
 *
 *   autonomous     — the EA acts without principal review (acks, calendar
 *                    proposals, internal standing participants).
 *   approval       — the EA drafts; the principal approves before send
 *                    (substantive replies, declines, government, board, legal,
 *                    all travel).
 *   principal_only — the EA does not draft, just routes and holds (media,
 *                    ministers, commitments, commercial terms, personnel).
 *
 * The classifier is intentionally conservative — when in doubt, escalate.
 * Cost of over-escalation is noise; cost of under-escalation is the principal
 * committed to something they did not intend.
 *
 * Per-EA architecture: the classifier itself is principal-agnostic, but the
 * always-approval overlay and the graduation config are keyed by principal so
 * Alex and Quinn evolve independently per the operator's R-950 brief.
 */

export type Lane = 'autonomous' | 'approval' | 'principal_only'

export type Principal = 'jeff' | 'sarah'

/** Counterparty profile snippet — the subset the lane subsystem reads. */
export interface CounterpartyProfile {
  id?: string
  name?: string
  category?:
    | 'government'
    | 'regulator'
    | 'board'
    | 'investor'
    | 'legal'
    | 'supplier'
    | 'internal'
    | 'media'
    | 'advisor'
    | 'other'
  /** Topics that, when mentioned, force routing to principal_only. */
  jeff_only_topics?: string[]
}

export interface ClassifyInput {
  subject: string
  body: string
  fromHeader: string
  counterpartyProfile?: CounterpartyProfile
  /** Domains treated as "internal" for the principal (no substantive ask = autonomous ack). */
  internalDomains?: string[]
}

export interface ClassifyResult {
  lane: Lane
  /** 0..1 — how certain the classifier is. */
  confidence: number
  /** Short human-readable reasons for this decision. */
  reasons: string[]
  /** Topic-style labels for the audit log. */
  topicTags: string[]
}
