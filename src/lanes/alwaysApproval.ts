/**
 * Always-approval overlay (R-952 part 2).
 *
 * The lane classifier (`classifier.ts`) decides what lane an inbound message
 * belongs in. The always-approval overlay can FORCE the lane to approval
 * (or stricter) regardless of what the classifier said.
 *
 * Reasons to force approval even when the classifier said autonomous:
 *
 *   1. Counterparty ID is on the explicit always-approval list.
 *   2. Counterparty category is on the always-approval categories list
 *      (default: board, investor, regulator, government, legal).
 *   3. Counterparty profile has any non-empty `jeff_only_topics` list.
 *   4. Sender is on a government domain (belt-and-braces — the classifier
 *      already lands these in approval, but this catches future drift).
 *   5. Explicit domain / email match from the per-EA config.
 *
 * The overlay is keyed per-principal so Alex (Jeff) and Quinn (Sarah) can
 * evolve their force-approval lists independently.
 */

import { readFileSync } from 'fs'
import { z } from 'zod'
import { isGovernmentDomain, senderDomain } from './govDomain.js'
import type { CounterpartyProfile, Principal } from './types.js'

export const AlwaysApprovalConfigSchema = z.object({
  schemaVersion: z.literal(1),
  principal: z.string(),
  description: z.string().optional(),
  updatedAt: z.string().optional(),
  /** Explicit counterparty IDs that always force approval. */
  counterpartyIds: z.array(z.string()).default([]),
  /** Counterparty categories that always force approval. */
  categories: z
    .array(
      z.enum([
        'government',
        'regulator',
        'board',
        'investor',
        'legal',
        'supplier',
        'internal',
        'media',
        'advisor',
        'other',
      ]),
    )
    .default([]),
  /** Explicit domain or full-email patterns that force approval. */
  domains: z.array(z.string()).default([]),
  notes: z.array(z.string()).optional(),
  /** Internal book-keeping: history of counterparties added at runtime. */
  history: z
    .array(
      z.object({
        counterpartyId: z.string(),
        addedNote: z.string().optional(),
        addedAt: z.string().optional(),
      }),
    )
    .optional(),
})

export type AlwaysApprovalConfig = z.infer<typeof AlwaysApprovalConfigSchema>

export interface ForceApprovalInput {
  fromHeader: string
  counterpartyProfile?: CounterpartyProfile
  config: AlwaysApprovalConfig
}

export interface ForceApprovalResult {
  force: boolean
  reason: string | null
}

function senderEmail(fromHeader: string): string {
  const match = /<([^>]+)>/.exec(fromHeader || '')
  return (match ? match[1] : fromHeader || '').trim().toLowerCase()
}

export function shouldForceApproval(input: ForceApprovalInput): ForceApprovalResult {
  const { fromHeader, counterpartyProfile, config } = input

  // 1. Counterparty-id match.
  if (counterpartyProfile?.id && config.counterpartyIds.includes(counterpartyProfile.id)) {
    return { force: true, reason: `counterparty id '${counterpartyProfile.id}' on always-approval list` }
  }

  // 2. Counterparty-category match.
  if (counterpartyProfile?.category && config.categories.includes(counterpartyProfile.category)) {
    return { force: true, reason: `counterparty category '${counterpartyProfile.category}' is always-approval` }
  }

  // 3. Non-empty principal-only topics on the profile.
  if (counterpartyProfile?.jeff_only_topics && counterpartyProfile.jeff_only_topics.length > 0) {
    return {
      force: true,
      reason: `counterparty has principal-only topics (${counterpartyProfile.jeff_only_topics.length} listed) — always-approval`,
    }
  }

  // 4. Government-domain sender.
  const email = senderEmail(fromHeader)
  const domain = senderDomain(fromHeader)
  if (domain && isGovernmentDomain(domain)) {
    return { force: true, reason: `government sender (${domain})` }
  }

  // 5. Explicit domain / email match from config.
  for (const d of config.domains) {
    const dLower = d.toLowerCase()
    if (dLower.includes('/')) {
      // user@domain/path shorthand → user@domain
      const userAtDomain = dLower.includes('@') ? dLower : dLower.replace('/', '@')
      if (email === userAtDomain) return { force: true, reason: `email ${email} on always-approval list` }
      continue
    }
    if (email && (email === dLower || email.endsWith(`@${dLower}`))) {
      return { force: true, reason: `domain ${dLower} on always-approval list` }
    }
  }

  return { force: false, reason: null }
}

/** Load and validate a per-EA always-approval config. */
export function loadAlwaysApprovalConfig(path: string): AlwaysApprovalConfig {
  const raw = readFileSync(path, 'utf8')
  const parsed = JSON.parse(raw)
  return AlwaysApprovalConfigSchema.parse(parsed)
}

/** Resolve the canonical config path for a principal. */
export function alwaysApprovalConfigPath(dispatcherDir: string, principal: Principal): string {
  return `${dispatcherDir}/config/always-approval-${principal}.json`
}
