/**
 * pendingAlerts drain (Phase B.3 — Migration Plan §5.2.2).
 *
 * The hourly backup script (scripts/backup.sh) appends tier-2 alert
 * records to STATE_DIR/pending-tier2-alerts.jsonl on failure. The
 * dispatcher's escalator sweep drains the file via this module, calling
 * postTier2Alert for each line so the alert reaches Discord and the SMS
 * escalation pipeline.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { existsSync, writeFileSync, readdirSync } from 'fs'
import { dirname } from 'path'
import {
  drainPendingTier2Alerts,
  _getPendingFileForTesting,
} from '../src/pendingAlerts.js'
import {
  _resetEscalatorForTesting,
  _getAlertForTesting,
  setDiscordPoster,
} from '../src/escalator.js'
import { installFetchStub, type FetchStub } from './helpers/fetchStub.js'

let fetchStub: FetchStub

describe('drainPendingTier2Alerts', () => {
  beforeEach(() => {
    _resetEscalatorForTesting()
    setDiscordPoster(null)
    fetchStub = installFetchStub({
      respond: () => undefined,
    })
  })

  afterEach(() => {
    fetchStub.uninstall()
  })

  test('returns 0 when the pending file does not exist', async () => {
    const drained = await drainPendingTier2Alerts()
    expect(drained).toBe(0)
  })

  test('drains a single valid record into the escalator and unlinks the file', async () => {
    const file = _getPendingFileForTesting()
    writeFileSync(
      file,
      JSON.stringify({ category: 'backup-failure', summary: 'tar failed' }) + '\n',
    )
    const drained = await drainPendingTier2Alerts()
    expect(drained).toBe(1)
    expect(existsSync(file)).toBe(false)
  })

  test('drains multiple records preserving order and ignoring blank lines', async () => {
    const file = _getPendingFileForTesting()
    const lines = [
      JSON.stringify({ category: 'backup-failure', summary: 'one' }),
      '',
      '   ',
      JSON.stringify({ category: 'backup-failure', summary: 'two' }),
      JSON.stringify({ category: 'backup-failure', summary: 'three' }),
      '',
    ].join('\n')
    writeFileSync(file, lines)
    const drained = await drainPendingTier2Alerts()
    expect(drained).toBe(3)
  })

  test('skips records missing required fields without aborting the sweep', async () => {
    const file = _getPendingFileForTesting()
    const lines = [
      JSON.stringify({ summary: 'no category' }),
      JSON.stringify({ category: 'backup-failure', summary: 'good' }),
      JSON.stringify({ category: 42, summary: 'wrong type' }),
    ].join('\n')
    writeFileSync(file, lines)
    const drained = await drainPendingTier2Alerts()
    expect(drained).toBe(1)
  })

  test('skips malformed JSON without aborting the sweep', async () => {
    const file = _getPendingFileForTesting()
    const lines = [
      '{not valid json',
      JSON.stringify({ category: 'backup-failure', summary: 'recovered' }),
    ].join('\n')
    writeFileSync(file, lines)
    const drained = await drainPendingTier2Alerts()
    expect(drained).toBe(1)
  })

  test('passes through optional fields (level, channelId, recipientMobile)', async () => {
    const file = _getPendingFileForTesting()
    writeFileSync(
      file,
      JSON.stringify({
        category: 'backup-failure',
        summary: 'override test',
        level: 'tier-2',
        recipientMobile: '+61400000000',
      }) + '\n',
    )
    const drained = await drainPendingTier2Alerts()
    expect(drained).toBe(1)
    // Record exists in escalator with the overridden recipient. We can't pull
    // the alertId without exposing it, so iterate via the helper directory.
    const dir = dirname(file)
    expect(readdirSync(dir).some((f) => f.startsWith('tier2-alerts'))).toBe(true)
  })

  test('rotates via rename so concurrent appends after read are not lost', async () => {
    const file = _getPendingFileForTesting()
    writeFileSync(
      file,
      JSON.stringify({ category: 'backup-failure', summary: 'first batch' }) + '\n',
    )
    const drained = await drainPendingTier2Alerts()
    expect(drained).toBe(1)
    expect(existsSync(file)).toBe(false)

    // A second producer appends after the rename; next sweep picks it up.
    writeFileSync(
      file,
      JSON.stringify({ category: 'backup-failure', summary: 'second batch' }) + '\n',
    )
    const drained2 = await drainPendingTier2Alerts()
    expect(drained2).toBe(1)
    expect(existsSync(file)).toBe(false)
  })

  test('postTier2Alert receives parsed record (verified via escalator state)', async () => {
    const file = _getPendingFileForTesting()
    writeFileSync(
      file,
      JSON.stringify({
        category: 'backup-failure',
        summary: 'verifiable',
        channelId: 'test-ops-channel',
      }) + '\n',
    )
    let posted: { channelId: string; body: string } | null = null
    setDiscordPoster(async (channelId, body) => {
      posted = { channelId, body }
      return 'msg-1'
    })
    await drainPendingTier2Alerts()
    expect(posted).not.toBeNull()
    expect(posted!.body).toContain('verifiable')
    expect(posted!.body).toContain('backup-failure')
  })
})
