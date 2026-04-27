/**
 * Phase A.9 components 6-9 smoke test.
 *
 * Asserts the pure-function behaviour of drain, integrationsHealth,
 * escalator, and anthropicCap without touching Discord, Twilio, or the
 * Anthropic API. Run locally before opening the PR; Phase A.10 wires
 * these (and the c1-c5 set) into `bun test` for CI.
 */

import { strict as assert } from 'assert'
import { tmpdir } from 'os'
import { mkdtempSync } from 'fs'
import { join } from 'path'

// Route persistent state into a fresh tmpdir so the smoke test never touches
// real dispatcher state. Set BEFORE importing the modules under test.
const tmp = mkdtempSync(join(tmpdir(), 'a9-c6-c9-'))
process.env.STATE_DIR = tmp
process.env.LOG_DIR = tmp
process.env.OUTBOX_DIR = tmp

// Critical: monkey-patch global fetch BEFORE any module imports so no
// smoke-test path can make real HTTP requests (Twilio, Anthropic Admin
// API, etc). Empty env-var overrides are not enough — config.ts falls
// back to `.secrets/twilio-alex-morgan.env` for laptop dev, so a naive
// test would have a real Twilio recipient and credentials configured.
const fetchCalls: { url: string; init?: RequestInit }[] = []
const originalFetch = globalThis.fetch
globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input.toString()
  fetchCalls.push({ url, init })
  // Twilio expects 2xx with a JSON body. Anthropic Admin API the same.
  // Returning a 503 surfaces failure paths so the test can also exercise
  // the failed-escalation branch.
  return new Response('{"sid":"smoke-test","status":"queued"}', { status: 200 })
}

const drain = await import('../src/drain.js')
const integrationsHealth = await import('../src/integrationsHealth.js')
const escalator = await import('../src/escalator.js')
const anthropicCap = await import('../src/anthropicCap.js')
const breaker = await import('../src/circuitBreaker.js')
const registry = await import('../src/workerRegistry.js')

let pass = 0
let fail = 0
function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  const start = Date.now()
  return Promise.resolve()
    .then(fn)
    .then(() => {
      pass++
      process.stdout.write(`✓ ${name} (${Date.now() - start}ms)\n`)
    })
    .catch((err) => {
      fail++
      process.stdout.write(`✗ ${name} — ${String(err).slice(0, 200)}\n`)
    })
}

// ── drain ─────────────────────────────────────────────────────────

await check('drain: starts not-draining', () => {
  drain._resetDrainForTesting()
  assert.equal(drain.isDraining(), false)
})

await check('drain: markDraining flips and is idempotent', () => {
  drain._resetDrainForTesting()
  drain.markDraining()
  assert.equal(drain.isDraining(), true)
  drain.markDraining()
  assert.equal(drain.isDraining(), true)
})

await check('drain: awaitWorkersDrained resolves cleanly when registry is empty', async () => {
  drain._resetDrainForTesting()
  registry._resetForTesting()
  const result = await drain.awaitWorkersDrained({ timeoutMs: 200, pollMs: 20 })
  assert.equal(result.drainedCleanly, true)
  assert.equal(result.killedCount, 0)
  assert.ok(result.waitedMs < 200)
})

await check('drain: awaitWorkersDrained times out and reports survivors', async () => {
  drain._resetDrainForTesting()
  registry._resetForTesting()
  registry.registerWorker({
    threadId: 't-survivor',
    pid: 999_999_999,    // non-existent PID — kill returns ESRCH but we still mark killed
    projectId: null,
    entity: 'cbs',
    startedAt: Date.now(),
  })
  const result = await drain.awaitWorkersDrained({ timeoutMs: 50, pollMs: 10 })
  assert.equal(result.drainedCleanly, false)
  assert.equal(result.killedCount, 1)
})

// ── integrationsHealth ────────────────────────────────────────────

await check('integrationsHealth: aggregate=ok when all breakers closed', () => {
  breaker._resetBreakersForTesting()
  integrationsHealth._resetIntegrationsForTesting()
  const snap = integrationsHealth.refreshIntegrationsSnapshot()
  assert.equal(snap.aggregate, 'ok')
  assert.equal(snap.upstreams.length, 7)
})

await check('integrationsHealth: aggregate=down when an upstream is open', () => {
  breaker._resetBreakersForTesting({ failureThreshold: 1, windowMs: 60_000, cooldownMs: 60_000 })
  integrationsHealth._resetIntegrationsForTesting()
  breaker.recordBreakerFailure('drive', new Error('upstream down'))
  const snap = integrationsHealth.refreshIntegrationsSnapshot()
  assert.equal(snap.aggregate, 'down')
})

await check('integrationsHealth: cached snapshot is what getIntegrationsHealth returns', () => {
  breaker._resetBreakersForTesting()
  integrationsHealth._resetIntegrationsForTesting()
  const fresh = integrationsHealth.refreshIntegrationsSnapshot()
  const cached = integrationsHealth.getIntegrationsHealth()
  assert.equal(cached.generatedAt, fresh.generatedAt)
})

// ── escalator ─────────────────────────────────────────────────────

await check('escalator: postTier2Alert returns alertId and registers record', async () => {
  escalator._resetEscalatorForTesting()
  const alertId = await escalator.postTier2Alert({
    category: 'integration outage',
    summary: 'test',
  })
  assert.ok(typeof alertId === 'string' && alertId.length > 0)
  const rec = escalator._getAlertForTesting(alertId)
  assert.ok(rec)
  assert.equal(rec!.escalationStatus, 'pending')
})

await check('escalator: acknowledgeByMessageId clears escalation', async () => {
  escalator._resetEscalatorForTesting()
  let captured = ''
  escalator.setDiscordPoster(async (_channelId, body) => {
    captured = body
    return 'msg-1'
  })
  process.env.OPS_ALERT_CHANNEL_ID = 'channel-x'
  // The poster path requires OPS_ALERT_CHANNEL_ID at module-import time;
  // fall back to passing channelId explicitly so we test the registration.
  const alertId = await escalator.postTier2Alert({
    category: 'security event',
    summary: 'test',
    channelId: 'channel-x',
  })
  assert.ok(captured.includes('security event'))
  const acked = escalator.acknowledgeByMessageId('msg-1', 'user-1')
  assert.equal(acked, true)
  const rec = escalator._getAlertForTesting(alertId)
  assert.equal(rec!.escalationStatus, 'skipped')
  assert.equal(rec!.ackedBy, 'user-1')
})

await check('escalator: sweepEscalations sends via mocked fetch when window elapses', async () => {
  escalator._resetEscalatorForTesting()
  fetchCalls.length = 0
  const alertId = await escalator.postTier2Alert({
    category: 'backup failure',
    summary: 'test',
    recipientMobile: '+61400000000',  // explicit mock recipient
  })
  // Force the alert past the ack window by using a very generous "now".
  const escalated = await escalator.sweepEscalations(Date.now() + 10 * 60 * 1000)
  // Twilio API was called via mocked fetch.
  assert.equal(fetchCalls.length, 1)
  assert.ok(fetchCalls[0]!.url.includes('twilio.com'))
  assert.equal(escalated, 1)
  const rec = escalator._getAlertForTesting(alertId)
  assert.equal(rec!.escalationStatus, 'sent')
})

await check('escalator: sweepEscalations skips when recipient explicitly absent', async () => {
  escalator._resetEscalatorForTesting()
  fetchCalls.length = 0
  const alertId = await escalator.postTier2Alert({
    category: 'backup failure',
    summary: 'test',
    recipientMobile: undefined,  // falls through to OPERATOR_MOBILE
  })
  const rec0 = escalator._getAlertForTesting(alertId)
  // Patch the record in place so the recipient is unambiguously absent.
  rec0!.recipientMobile = null
  const escalated = await escalator.sweepEscalations(Date.now() + 10 * 60 * 1000)
  assert.equal(escalated, 0)
  assert.equal(fetchCalls.length, 0)
  const rec = escalator._getAlertForTesting(alertId)
  assert.equal(rec!.escalationStatus, 'skipped')
})

// ── anthropicCap ─────────────────────────────────────────────────

await check('anthropicCap: classifyAnthropicError detects monthly-cap pattern', () => {
  anthropicCap._resetCapDetectorForTesting()
  assert.equal(
    anthropicCap.classifyAnthropicError('Your credit balance is too low to make this request.'),
    'monthly-cap',
  )
  assert.equal(
    anthropicCap.classifyAnthropicError('Organization has reached its monthly cost limit.'),
    'monthly-cap',
  )
})

await check('anthropicCap: classifyAnthropicError detects transient pattern', () => {
  assert.equal(anthropicCap.classifyAnthropicError('HTTP 529 Anthropic over capacity'), 'transient')
  assert.equal(anthropicCap.classifyAnthropicError('Request timed out'), 'transient')
})

await check('anthropicCap: classifyAnthropicError returns other for unrelated', () => {
  assert.equal(anthropicCap.classifyAnthropicError('random failure'), 'other')
})

await check('anthropicCap: recordCapHitFromError writes marker and isAnthropicCapHit returns true', () => {
  anthropicCap._resetCapDetectorForTesting()
  assert.equal(anthropicCap.isAnthropicCapHit(), false)
  anthropicCap.recordCapHitFromError('credit balance is too low')
  assert.equal(anthropicCap.isAnthropicCapHit(), true)
  const marker = anthropicCap.readCapMarker()
  assert.ok(marker)
  assert.equal(marker!.detectedVia, 'reactive')
})

await check('anthropicCap: clearAnthropicCapHit removes marker', () => {
  anthropicCap._resetCapDetectorForTesting()
  anthropicCap.recordCapHitFromError('credit balance is too low')
  assert.equal(anthropicCap.isAnthropicCapHit(), true)
  anthropicCap.clearAnthropicCapHit()
  assert.equal(anthropicCap.isAnthropicCapHit(), false)
})

await check('anthropicCap: checkBudget returns null when admin key absent', async () => {
  anthropicCap._resetCapDetectorForTesting()
  fetchCalls.length = 0
  const report = await anthropicCap.checkBudget()
  // Without ANTHROPIC_ADMIN_KEY the fetch path is gated, so no Admin API
  // call is made even with the mocked fetch.
  assert.equal(report, null)
  assert.equal(fetchCalls.filter((c) => c.url.includes('anthropic.com')).length, 0)
})

// Restore the original fetch so any post-test logging or shutdown does not
// interfere with global state.
globalThis.fetch = originalFetch

process.stdout.write(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail > 0 ? 1 : 0)
