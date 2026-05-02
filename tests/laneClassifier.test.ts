/**
 * Tests for the lane classifier (R-952).
 *
 * Pins the rule-based first-pass behaviour so future drift is caught.
 * Mirrors the smoke-test cases in the source Python (`lane_classifier.py`).
 */

import { describe, test, expect } from 'bun:test'
import { classify } from '../src/lanes/classifier.js'
import { isGovernmentDomain, senderDomain } from '../src/lanes/govDomain.js'

describe('isGovernmentDomain', () => {
  test('matches AU gov domains', () => {
    expect(isGovernmentDomain('transport.nsw.gov.au')).toBe(true)
    expect(isGovernmentDomain('health.gov.au')).toBe(true)
    expect(isGovernmentDomain('amsa.gov.au')).toBe(true)
    expect(isGovernmentDomain('minister.nsw.gov.au')).toBe(true)
  })

  test('matches international gov domains', () => {
    expect(isGovernmentDomain('gov.uk')).toBe(true)
    expect(isGovernmentDomain('dft.gov.uk')).toBe(true)
    expect(isGovernmentDomain('foreign.gov.sg')).toBe(true)
    expect(isGovernmentDomain('state.gov')).toBe(true)
  })

  test('matches NZ govt.nz exception', () => {
    expect(isGovernmentDomain('mot.govt.nz')).toBe(true)
    expect(isGovernmentDomain('govt.nz')).toBe(true)
  })

  test('does not match commercial or advocacy lookalikes', () => {
    expect(isGovernmentDomain('government.com')).toBe(false)
    expect(isGovernmentDomain('sydney.org.au')).toBe(false)
    expect(isGovernmentDomain('committee-for-sydney.com')).toBe(false)
    expect(isGovernmentDomain('')).toBe(false)
  })
})

describe('senderDomain', () => {
  test('extracts from RFC-822 header with display name', () => {
    expect(senderDomain('Drew Jones <drew.jones@transport.nsw.gov.au>')).toBe('transport.nsw.gov.au')
  })

  test('extracts from bare email', () => {
    expect(senderDomain('drew@transport.nsw.gov.au')).toBe('transport.nsw.gov.au')
  })

  test('returns empty for malformed input', () => {
    expect(senderDomain('')).toBe('')
    expect(senderDomain('not an email')).toBe('')
  })
})

describe('classify — principal_only (hard rules)', () => {
  test('ministerial outreach from gov domain → principal_only', () => {
    const r = classify({
      subject: 'Ministerial direct from gov domain',
      body: 'The Minister would like to meet with Jeff',
      fromHeader: 'office@minister.nsw.gov.au',
    })
    expect(r.lane).toBe('principal_only')
    expect(r.confidence).toBeGreaterThanOrEqual(0.9)
    expect(r.topicTags).toContain('government')
  })

  test('media enquiry → principal_only', () => {
    const r = classify({
      subject: 'Interview request — SMH ferry story',
      body: "Hi Jeff, I'm writing on the Rhodes ferry. Quote for publication?",
      fromHeader: 'reporter@smh.com.au',
    })
    expect(r.lane).toBe('principal_only')
    expect(r.topicTags).toContain('media')
  })

  test('commitment ask → principal_only', () => {
    const r = classify({
      subject: 'Speaking slot at our forum',
      body: 'Would Jeff be available for a keynote?',
      fromHeader: 'events@bizforum.com',
    })
    expect(r.lane).toBe('principal_only')
    expect(r.topicTags).toContain('commitment')
  })

  test('HR signal → principal_only', () => {
    const r = classify({
      subject: 'Performance review query',
      body: 'A grievance has been raised that I need to discuss',
      fromHeader: 'hr@employer.com.au',
    })
    expect(r.lane).toBe('principal_only')
    expect(r.topicTags).toContain('hr')
  })

  test('counterparty profile principal-only topic match → principal_only', () => {
    const r = classify({
      subject: 'Re: WREI funding update',
      body: 'Quick question on the funding numbers',
      fromHeader: 'someone@partner.com',
      counterpartyProfile: {
        id: 'partner-firm',
        category: 'advisor',
        jeff_only_topics: ['funding numbers', 'equity raise'],
      },
    })
    expect(r.lane).toBe('principal_only')
    expect(r.topicTags).toContain('profile-flag')
  })

  test('NON-gov sender mentioning a minister → NOT principal_only', () => {
    const r = classify({
      subject: 'Upcoming events — ministers attending',
      body: 'Minister Rose Jackson will speak at our forum next month',
      fromHeader: 'events@sydney.org.au',
    })
    expect(r.lane).not.toBe('principal_only')
  })
})

describe('classify — approval lane', () => {
  test('commercial signal → approval', () => {
    const r = classify({
      subject: 'Pricing for battery supply',
      body: 'What are your commercial terms?',
      fromHeader: 'supplier@skeletontech.com',
    })
    expect(r.lane).toBe('approval')
    expect(r.topicTags).toContain('commercial')
  })

  test('government regular (non-ministerial) → approval', () => {
    const r = classify({
      subject: 'Briefing request',
      body: 'Could we schedule 30 min?',
      fromHeader: 'officer@transport.nsw.gov.au',
    })
    expect(r.lane).toBe('approval')
    expect(r.topicTags).toContain('government')
  })

  test('counterparty category = board → approval', () => {
    const r = classify({
      subject: 'Board matters',
      body: 'Sarah asked me to confirm the board agenda',
      fromHeader: 'paul.miller@deutschmiller.com',
      counterpartyProfile: { id: 'paul-miller', category: 'board' },
    })
    expect(r.lane).toBe('approval')
    expect(r.topicTags).toContain('board')
  })

  test('substantive question → approval', () => {
    const r = classify({
      subject: 'Question on the brief',
      body: 'Could you confirm the timeline?',
      fromHeader: 'colleague@partner.com',
    })
    expect(r.lane).toBe('approval')
  })
})

describe('classify — autonomous lane', () => {
  test('routine subject pattern → autonomous', () => {
    const r = classify({
      subject: 'Re: confirmed for Tuesday',
      body: 'See you then.',
      fromHeader: 'colleague@partner.com',
    })
    expect(r.lane).toBe('autonomous')
    expect(r.topicTags).toContain('routine')
  })

  test('ack-only body → autonomous', () => {
    const r = classify({
      subject: 'Update',
      body: 'Thanks for that, noted.',
      fromHeader: 'someone@vessev.com',
    })
    expect(r.lane).toBe('autonomous')
    expect(r.topicTags).toContain('ack')
  })

  test('scheduling ask → autonomous', () => {
    // Body that matches SCHEDULING_BODY but NOT SUBSTANTIVE_ASK_PATTERNS.
    // Substantive-ask (trailing `?`, "could you", etc.) takes priority over
    // scheduling — a scheduling-flavoured question still routes to approval.
    const r = classify({
      subject: 'Quick chat',
      body: 'Tuesday afternoon would be convenient if you are free.',
      fromHeader: 'colleague@partner.com',
    })
    expect(r.lane).toBe('autonomous')
    expect(r.topicTags).toContain('scheduling')
  })

  test('internal domain with no substantive ask → autonomous', () => {
    const r = classify({
      subject: 'Update',
      body: 'Will do.',
      fromHeader: 'jim@waterroads.com.au',
      internalDomains: ['waterroads.com.au'],
    })
    expect(r.lane).toBe('autonomous')
    expect(r.topicTags).toContain('internal')
  })
})

describe('classify — defaults', () => {
  test('ambiguous → default approval', () => {
    const r = classify({
      subject: 'Following up',
      body: 'Just checking in.',
      fromHeader: 'unknown@somewhere.org',
    })
    expect(r.lane).toBe('approval')
    expect(r.confidence).toBe(0.5)
    expect(r.topicTags).toContain('ambiguous')
  })

  test('returns the canonical shape', () => {
    const r = classify({ subject: '', body: '', fromHeader: '' })
    expect(typeof r.lane).toBe('string')
    expect(typeof r.confidence).toBe('number')
    expect(Array.isArray(r.reasons)).toBe(true)
    expect(Array.isArray(r.topicTags)).toBe(true)
  })
})
