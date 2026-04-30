/**
 * Phase H §12.3 — tender classifier behavioural tests.
 *
 * Coverage spans the three signal classes called out in the migration
 * plan and the bootstrap brief (channel name, content keywords, forwarded
 * email subjects), plus the precision-bias rules that single weak
 * signals do not auto-route while paired weak signals do.
 */

import { describe, test, expect } from 'bun:test'
import { classifyTender } from '../src/tenderClassifier.js'

describe('classifyTender — channel-name signal', () => {
  test('channel name containing "tender" routes regardless of brief content', () => {
    const r = classifyTender({
      brief: 'Please review the attached opportunity.',
      channelName: 'wr-tenders',
      entity: 'wr',
    })
    expect(r.isTender).toBe(true)
    expect(r.signals).toContain('channel-name')
  })

  test('channel name without tender does not contribute', () => {
    const r = classifyTender({
      brief: 'Please review the attached opportunity.',
      channelName: 'general',
      entity: 'cbs',
    })
    expect(r.isTender).toBe(false)
    expect(r.signals).not.toContain('channel-name')
  })
})

describe('classifyTender — strong keyword signals', () => {
  test('RFI alone is sufficient', () => {
    const r = classifyTender({ brief: 'New RFI from Brisbane City Council.' })
    expect(r.isTender).toBe(true)
    expect(r.signals).toContain('keyword:rfi')
  })

  test('RFT alone is sufficient', () => {
    const r = classifyTender({ brief: 'RFT opens Monday.' })
    expect(r.isTender).toBe(true)
  })

  test('RFQ alone is sufficient', () => {
    const r = classifyTender({ brief: 'RFQ for cleaning services.' })
    expect(r.isTender).toBe(true)
  })

  test('RFP alone is sufficient', () => {
    const r = classifyTender({ brief: 'RFP attached.' })
    expect(r.isTender).toBe(true)
  })

  test('EOI alone is sufficient', () => {
    const r = classifyTender({ brief: 'EOI deadline tomorrow.' })
    expect(r.isTender).toBe(true)
  })

  test('"expression of interest" prose form fires', () => {
    const r = classifyTender({ brief: 'They issued an expression of interest last week.' })
    expect(r.isTender).toBe(true)
    expect(r.signals).toContain('keyword:expression-of-interest')
  })

  test('"tender notice" fires', () => {
    const r = classifyTender({ brief: 'Tender notice published on AusTender.' })
    expect(r.isTender).toBe(true)
    expect(r.signals).toContain('keyword:tender-notice')
    expect(r.signals).toContain('keyword:austender')
  })

  test('AusTender alone is sufficient', () => {
    const r = classifyTender({ brief: 'See AusTender for the latest opportunity.' })
    expect(r.isTender).toBe(true)
  })

  test('"tender number" / "tender ID" / "tender ref" fire', () => {
    expect(classifyTender({ brief: 'Tender number 42.' }).isTender).toBe(true)
    expect(classifyTender({ brief: 'Tender ID ABC-123.' }).isTender).toBe(true)
    expect(classifyTender({ brief: 'Tender reference XYZ.' }).isTender).toBe(true)
  })

  test('word-boundary anchoring — "drft" does not match RFT', () => {
    const r = classifyTender({ brief: 'Working on a drft of the proposal.' })
    expect(r.isTender).toBe(false)
  })

  test('word-boundary anchoring — "TRFI" does not match RFI', () => {
    const r = classifyTender({ brief: 'Internal TRFI report due.' })
    expect(r.isTender).toBe(false)
  })
})

describe('classifyTender — weak signal pairing', () => {
  test('the word "tender" alone does not fire', () => {
    const r = classifyTender({ brief: 'They will tender their resignation tomorrow.' })
    expect(r.isTender).toBe(false)
  })

  test('"closing date" alone does not fire', () => {
    const r = classifyTender({ brief: 'The closing date for offers is next Friday.' })
    expect(r.isTender).toBe(false)
  })

  test('"tender" + "closing date" together fire', () => {
    const r = classifyTender({
      brief: 'Forwarded the tender; closing date next Friday.',
    })
    expect(r.isTender).toBe(true)
    expect(r.signals).toContain('weak:tender-word')
    expect(r.signals).toContain('weak:closing-date')
  })

  test('"procurement" + "submission deadline" fire as a pair', () => {
    const r = classifyTender({
      brief: 'Council procurement; submission deadline 5pm.',
    })
    expect(r.isTender).toBe(true)
  })

  test('forwarded email subject alone is not enough', () => {
    const r = classifyTender({ brief: 'Fwd: lunch on Friday' })
    expect(r.isTender).toBe(false)
  })

  test('forwarded email + tender word fires', () => {
    const r = classifyTender({
      brief: 'Fwd: tender for civil works',
    })
    expect(r.isTender).toBe(true)
    expect(r.signals).toContain('structural:forwarded-email')
    expect(r.signals).toContain('weak:tender-word')
  })
})

describe('classifyTender — recommended-agent selection by entity', () => {
  test('WR-owned tender → tender-review', () => {
    const r = classifyTender({
      brief: 'RFP from Sydney Water.',
      entity: 'wr',
    })
    expect(r.recommendedAgent).toBe('tender-review')
  })

  test('CBS-owned tender → office-management', () => {
    const r = classifyTender({
      brief: 'RFI for managed services.',
      entity: 'cbs',
    })
    expect(r.recommendedAgent).toBe('office-management')
  })

  test('entity unknown → office-management (CBS triage default)', () => {
    const r = classifyTender({ brief: 'EOI for advisory panel.' })
    expect(r.recommendedAgent).toBe('office-management')
  })

  test('non-tender → recommendedAgent is null', () => {
    const r = classifyTender({ brief: 'Casual chat about weekend plans.' })
    expect(r.isTender).toBe(false)
    expect(r.recommendedAgent).toBeNull()
  })
})

describe('classifyTender — false-positive resistance', () => {
  test('an internal project brief does not match', () => {
    const r = classifyTender({
      brief: 'Build the new dashboard. Deploy to staging by Friday. Iterate.',
      channelName: 'project-leo',
      entity: 'cbs',
    })
    expect(r.isTender).toBe(false)
    expect(r.signals).toEqual([])
  })

  test('common abbreviations not in our list do not match', () => {
    expect(classifyTender({ brief: 'Quick API and DB review.' }).isTender).toBe(false)
    expect(classifyTender({ brief: 'CRM update tomorrow.' }).isTender).toBe(false)
  })

  test('a brief that is mostly capitals does not match unless our keywords appear', () => {
    const r = classifyTender({ brief: 'PLEASE REVIEW THE BRIEF AND RESPOND.' })
    expect(r.isTender).toBe(false)
  })
})

describe('classifyTender — channel-name + content combination', () => {
  test('channel-name match plus a strong content match yields multiple signals', () => {
    const r = classifyTender({
      brief: 'Forwarded RFT — closing date 14 May.',
      channelName: 'wr-tenders',
      entity: 'wr',
    })
    expect(r.isTender).toBe(true)
    expect(r.signals).toContain('channel-name')
    expect(r.signals).toContain('keyword:rft')
    expect(r.signals).toContain('weak:closing-date')
    expect(r.recommendedAgent).toBe('tender-review')
  })
})
