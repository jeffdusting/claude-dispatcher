/**
 * bun test preload (Phase A.10).
 *
 * Runs once before any *.test.ts file is loaded. Two responsibilities:
 *
 *  1. Route every persistent path the dispatcher writes to into a fresh
 *     tmp directory. config.ts resolves STATE_DIR / LOG_DIR / OUTBOX_DIR
 *     once at module load via envOr; setting the env vars here means the
 *     constants resolve to tmp paths for the test process and never collide
 *     with the operator's real ~/claude-workspace state.
 *
 *  2. Set DISPATCHER_TEST_MODE=1 (Δ OD-034). Belt-and-braces in addition to
 *     the package.json script — preload guarantees the flag is set even if
 *     a developer runs `bun test` directly without the npm script wrapper.
 *
 * Also installs a default fetch stub that throws on any network call so an
 * accidental real upstream hit (Twilio, Anthropic Admin API, Discord REST)
 * surfaces immediately rather than silently making the call. Tests that
 * exercise a fetch path replace `globalThis.fetch` with a recording stub
 * via `tests/helpers/fetchStub.ts`.
 */

import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const tmp = mkdtempSync(join(tmpdir(), 'dispatcher-test-'))
process.env.STATE_DIR = tmp
process.env.LOG_DIR = tmp
process.env.OUTBOX_DIR = tmp
// ACCESS_FILE under tmp so tests can probe loadAccess()/updateAccess() without
// touching the operator's real ~/.claude/channels/discord/access.json. The
// env-override path is the same one the cloud uses (B-013).
process.env.ACCESS_FILE = join(tmp, 'discord-access.json')
process.env.DISPATCHER_TEST_MODE = '1'

// Memory thresholds for the A.9.6 sweep tests. Set here (preload) so
// config.ts captures them at module load — once it has, the constants are
// frozen for the process and per-test env mutation cannot move them.
process.env.WORKER_MEMORY_WARN_BYTES = '100'
process.env.WORKER_MEMORY_KILL_BYTES = '200'

// Mailroom-cycle thresholds (Migration Plan §14.2.3 backpressure tests).
// Set here for the same reason — eaMailroomCycle.ts captures these at
// module load via parseInt(process.env.X ?? default).
process.env.MAILROOM_DEPTH_ALARM_THRESHOLD = '3'
process.env.MAILROOM_AGE_ALARM_MS = '60000'           // 1 minute
process.env.MAILROOM_DEPTH_ALARM_REPEAT_MS = '600000' // 10 minutes

// Default fetch: surface unexpected network access loudly. Tests override
// per-suite via installFetchStub() when the code under test makes a fetch.
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = typeof input === 'string' ? input : (input as { toString(): string }).toString()
  throw new Error(
    `Unexpected fetch during test: ${url}. Install a fetchStub for this suite.`,
  )
}) as typeof globalThis.fetch
