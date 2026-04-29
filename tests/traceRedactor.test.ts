/**
 * Phase J.0 — trace redactor behavioural tests.
 *
 * Coverage spans every PII class in OD-014 plus the sixteenth-session
 * bootstrap additions (Australian addresses, passport numbers, Medicare
 * numbers). Includes false-positive resistance cases for the patterns
 * that can collide with task identifiers and order numbers.
 */

import { describe, test, expect, beforeAll } from 'bun:test'
import { writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { mkdtempSync } from 'fs'
import {
  redactString,
  redactTraceBlock,
  loadNamedIndividuals,
} from '../src/traceRedactor.js'

// Synthetic named-individuals file used across the test suite. Keeps
// the production list out of test-specific assertions and makes it
// obvious which variants the assertions depend on.
const TEST_DIR = mkdtempSync(join(tmpdir(), 'trace-redactor-test-'))
const NAMED_PATH = join(TEST_DIR, 'named-individuals.json')

beforeAll(() => {
  writeFileSync(
    NAMED_PATH,
    JSON.stringify({
      version: 1,
      lastUpdated: '2026-04-29',
      rationale: 'test fixture',
      names: [
        { canonical: 'Jeff Dusting', variants: ['Jeff Dusting', 'Jeff', 'Jad'] },
        { canonical: 'Sarah Taylor', variants: ['Sarah Taylor', 'Sarah'] },
        { canonical: 'Alex Morgan', variants: ['Alex Morgan', 'Alex'] },
        { canonical: 'Quinn', variants: ['Quinn'] },
      ],
    }),
    'utf8',
  )
  // Force the cache to load the test fixture instead of the production file.
  loadNamedIndividuals({ path: NAMED_PATH, forceReload: true })
})

const opts = { namedIndividualsPath: NAMED_PATH, forceReloadNamedIndividuals: false }

describe('redactString — emails', () => {
  test('redacts a personal email', () => {
    const r = redactString('Contact bob@example.com about the project.', opts)
    expect(r.text).toBe('Contact [REDACTED:email] about the project.')
    expect(r.counts.email).toBe(1)
  })

  test('preserves allow-listed service mailboxes', () => {
    const r = redactString('Forwarded to invoices@waterroads.xerocompute.com today.', opts)
    expect(r.text).toContain('invoices@waterroads.xerocompute.com')
    expect(r.counts.email).toBe(0)
  })

  test('redacts multiple emails on one line', () => {
    const r = redactString('From a@x.com to b@y.com via c@z.com.', opts)
    expect(r.counts.email).toBe(3)
    expect(r.text).toBe('From [REDACTED:email] to [REDACTED:email] via [REDACTED:email].')
  })
})

describe('redactString — phone numbers', () => {
  test('redacts an Australian mobile (04xx)', () => {
    const r = redactString('Call me on 0412 345 678 tomorrow.', opts)
    expect(r.text).toBe('Call me on [REDACTED:phone] tomorrow.')
    expect(r.counts.phone).toBe(1)
  })

  test('redacts an Australian landline with area code', () => {
    const r = redactString('Office line is (02) 9876 5432.', opts)
    expect(r.text).toBe('Office line is [REDACTED:phone].')
    expect(r.counts.phone).toBe(1)
  })

  test('redacts +61 international format', () => {
    const r = redactString('Try +61 412 345 678 or +61 2 9876 5432.', opts)
    expect(r.counts.phone).toBe(2)
  })

  test('does not match a long invoice number', () => {
    const r = redactString('Invoice 100200300400500 cleared.', opts)
    expect(r.counts.phone).toBe(0)
  })
})

describe('redactString — Australian addresses', () => {
  test('redacts a postcoded street + state tail', () => {
    const r = redactString('Send to 12 Bridge Street, Sydney NSW 2000 by Friday.', opts)
    expect(r.text).toContain('[REDACTED:address]')
    expect(r.counts.address).toBe(1)
  })

  test('redacts with hyphenated suffix and state code', () => {
    const r = redactString('44 Burwood Road, Belmore NSW 2192 — confirmed.', opts)
    expect(r.counts.address).toBe(1)
  })

  test('does not match a bare suburb name', () => {
    const r = redactString('Met in Sydney yesterday.', opts)
    expect(r.counts.address).toBe(0)
  })
})

describe('redactString — credit cards (Luhn-validated)', () => {
  test('redacts a Luhn-valid 16-digit number', () => {
    // 4111 1111 1111 1111 is the textbook test card and passes Luhn.
    const r = redactString('Charged to 4111-1111-1111-1111 today.', opts)
    expect(r.text).toBe('Charged to [REDACTED:credit-card] today.')
    expect(r.counts['credit-card']).toBe(1)
  })

  test('does not redact a digit string that fails Luhn', () => {
    // 1234 5678 9012 3456 — fails Luhn.
    const r = redactString('Reference 1234 5678 9012 3456 logged.', opts)
    expect(r.counts['credit-card']).toBe(0)
  })

  test('does not redact a too-short digit run', () => {
    const r = redactString('Code 4111-1111 is the prefix.', opts)
    expect(r.counts['credit-card']).toBe(0)
  })
})

describe('redactString — passport / Medicare', () => {
  test('redacts an Australian passport with the word "passport"', () => {
    const r = redactString('Passport number N12345678 expires next year.', opts)
    expect(r.text).toContain('[REDACTED:passport]')
    expect(r.counts.passport).toBe(1)
  })

  test('redacts a Medicare number with the word "Medicare"', () => {
    const r = redactString('Medicare 2123 45678 9 on file.', opts)
    expect(r.counts.medicare).toBe(1)
  })

  test('a bare 9-digit code without "passport" is not matched as passport', () => {
    const r = redactString('Reference 123456789 logged.', opts)
    expect(r.counts.passport).toBe(0)
  })
})

describe('redactString — BSB / ABN / ACN', () => {
  test('redacts BSB-account on the same line', () => {
    const r = redactString('Pay to 062-000 account 1234567 thanks.', opts)
    expect(r.counts['bsb-account']).toBe(1)
  })

  test('redacts ABN with the word "ABN"', () => {
    const r = redactString('ABN 51 824 753 556 invoiced.', opts)
    expect(r.counts.abn).toBe(1)
  })

  test('redacts ACN with the word "ACN"', () => {
    const r = redactString('ACN 005 749 986 listed.', opts)
    expect(r.counts.acn).toBe(1)
  })

  test('11-digit string without "ABN" prefix is not matched', () => {
    const r = redactString('Order 51824753556 shipped.', opts)
    expect(r.counts.abn).toBe(0)
  })
})

describe('redactString — named individuals', () => {
  test('redacts a canonical full name', () => {
    const r = redactString('Jeff Dusting reviewed the brief.', opts)
    expect(r.text).toBe('[REDACTED:name] reviewed the brief.')
    expect(r.counts.name).toBe(1)
  })

  test('redacts a first-name variant', () => {
    const r = redactString('Sarah signed off this morning.', opts)
    expect(r.counts.name).toBe(1)
  })

  test('redacts the "Jad" variant', () => {
    const r = redactString('Jad will follow up.', opts)
    expect(r.counts.name).toBe(1)
  })

  test('case-insensitive matching', () => {
    const r = redactString('JEFF and quinn met today.', opts)
    expect(r.counts.name).toBe(2)
  })

  test('word-boundary anchoring — does not match Quinn inside Quinnipiac', () => {
    const r = redactString('Quinnipiac is a university name.', opts)
    expect(r.counts.name).toBe(0)
  })
})

describe('redactTraceBlock — JSON shape walk', () => {
  test('redacts every string-valued leaf and preserves shape', () => {
    const block = {
      type: 'claude_session',
      correlationId: 'abc-123',
      principal: 'Jeff Dusting',
      payload: {
        summary: 'Email bob@example.com on Tuesday at 0412 345 678.',
        notes: ['Quinn agrees', 'Sarah unavailable'],
        cost: 0.12,
        ok: true,
      },
    }
    const r = redactTraceBlock(block, opts)
    const out = r.block as typeof block
    expect(out.type).toBe('claude_session') // not redacted
    expect(out.correlationId).toBe('abc-123')
    expect(out.principal).toBe('[REDACTED:name]')
    expect(out.payload.summary).toBe(
      'Email [REDACTED:email] on Tuesday at [REDACTED:phone].',
    )
    expect(out.payload.notes).toEqual([
      '[REDACTED:name] agrees',
      '[REDACTED:name] unavailable',
    ])
    expect(out.payload.cost).toBe(0.12) // numbers untouched
    expect(out.payload.ok).toBe(true) // booleans untouched
    expect(r.counts.email).toBe(1)
    expect(r.counts.phone).toBe(1)
    expect(r.counts.name).toBeGreaterThanOrEqual(3)
  })

  test('match paths point at the leaf JSON pointer', () => {
    const block = {
      type: 'note',
      payload: { quote: 'Sarah said yes.' },
    }
    const r = redactTraceBlock(block, opts)
    expect(r.matches[0].path).toBe('payload.quote')
  })

  test('handles arrays of nested objects', () => {
    const block = {
      type: 'multi',
      items: [
        { author: 'Alex Morgan', body: 'first' },
        { author: 'Quinn', body: 'second' },
      ],
    }
    const r = redactTraceBlock(block, opts)
    expect((r.block as { items: Array<{ author: string }> }).items[0].author).toBe('[REDACTED:name]')
    expect((r.block as { items: Array<{ author: string }> }).items[1].author).toBe('[REDACTED:name]')
    expect(r.counts.name).toBe(2)
  })
})

describe('redactString — overlap resolution', () => {
  test('email containing a name redacts as email, not name+email', () => {
    const r = redactString('Reach jeff@example.com this week.', opts)
    expect(r.text).toBe('Reach [REDACTED:email] this week.')
    // Email is single match; the "jeff" inside the email is not double-counted.
    expect(r.counts.email).toBe(1)
    expect(r.counts.name).toBe(0)
  })
})

describe('redactString — non-PII text is unchanged', () => {
  test('no redaction returns input verbatim', () => {
    const input = 'A perfectly innocuous trace log line with no PII at all.'
    const r = redactString(input, opts)
    expect(r.text).toBe(input)
    expect(Object.values(r.counts).every((n) => n === 0)).toBe(true)
  })
})
