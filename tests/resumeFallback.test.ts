/**
 * Tests for `isResumeFailed` — the resume-fallback discriminator.
 *
 * The dispatcher's runSession path falls back from `--resume <session>` to a
 * fresh session when stderr matches one of the recognised resume-failure
 * patterns. New Claude Code error phrasings appear over time as the CLI
 * upstream tweaks its messages; this test pins the patterns we recognise.
 */

import { describe, test, expect } from 'bun:test'
import { isResumeFailed } from '../src/claude.js'

describe('isResumeFailed', () => {
  test('matches "session not found"', () => {
    expect(isResumeFailed('Error: session not found: abc123')).toBe(true)
  })

  test('matches "could not find session"', () => {
    expect(isResumeFailed('Could not find session abc123')).toBe(true)
  })

  test('matches "no session"', () => {
    expect(isResumeFailed('No session for that id')).toBe(true)
  })

  test('matches "invalid session"', () => {
    expect(isResumeFailed('Invalid session id abc123')).toBe(true)
  })

  test('matches the "No conversation found with session ID" phrasing', () => {
    // Observed 2026-05-02 after fly redeploys evicted session state across
    // container respawns. The exact phrasing the operator surfaced was:
    //   Error: Error: No conversation found with session ID: d03f3dd9-...
    expect(
      isResumeFailed(
        'Error: Error: No conversation found with session ID: d03f3dd9-3988-4290-8e8e-b049f13091d3',
      ),
    ).toBe(true)
  })

  test('matches case-insensitively', () => {
    expect(isResumeFailed('NO CONVERSATION FOUND with session id')).toBe(true)
  })

  test('does not match unrelated errors', () => {
    expect(isResumeFailed('rate limited')).toBe(false)
    expect(isResumeFailed('connection refused')).toBe(false)
    expect(isResumeFailed('')).toBe(false)
  })

  test('does not match a successful run (empty stderr)', () => {
    expect(isResumeFailed('')).toBe(false)
  })
})
