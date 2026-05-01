#!/usr/bin/env bun
/**
 * Smoke test for google-workspace-jeff skill end-to-end.
 *
 * Run from the laptop after `op signin`:
 *
 *   export WR_ALEX_MORGAN_SA_KEY_PATH=/tmp/wr-alex-morgan-gcp-sa.json
 *   op read "op://CoS-Dispatcher/drive-wr-alex-morgan/sa-json" > "$WR_ALEX_MORGAN_SA_KEY_PATH"
 *   chmod 600 "$WR_ALEX_MORGAN_SA_KEY_PATH"
 *   bun scripts/google-workspace/smoke-test.ts
 *
 * Or, on the cos-dispatcher Fly container after deploy:
 *
 *   flyctl ssh console -a cos-dispatcher --command \
 *     "env WR_ALEX_MORGAN_SA_KEY_PATH=/data/.secrets/wr-alex-morgan-gcp-sa.json bun /app/scripts/google-workspace/smoke-test.ts"
 *
 * Note on the SSH form: `entrypoint.sh` exports `WR_ALEX_MORGAN_SA_KEY_PATH`
 * to the dispatcher process and its spawned `claude` workers (so Alex's
 * runtime invocations work cleanly), but a fresh `flyctl ssh console`
 * session does not inherit that export. Either pass the env explicitly
 * (above) or rely on the canonical-path fallback this script now applies
 * automatically when the env var is unset. The fallback is `cos-dispatcher`-
 * specific (`/data/.secrets/wr-alex-morgan-gcp-sa.json`) and is only useful
 * when the script runs on the Fly container itself.
 *
 * The test:
 *   1. Reads the SA JSON via the auth helper.
 *   2. Calls gmail.users.getProfile (read-only, no side effects).
 *   3. Calls calendar.calendarList.list (read-only, no side effects).
 *   4. Prints OK/FAIL per call.
 *
 * No drafts are created, no events are touched.
 */

import { existsSync } from 'fs'
import { ALEX_PRINCIPAL, gmailService, calendarService, AuthError } from './auth.js'

const COS_DISPATCHER_DEFAULT_KEY_PATH = '/data/.secrets/wr-alex-morgan-gcp-sa.json'

function applyKeyPathFallback(): { applied: boolean; path: string | null } {
  if (process.env.WR_ALEX_MORGAN_SA_KEY_PATH) {
    return { applied: false, path: process.env.WR_ALEX_MORGAN_SA_KEY_PATH }
  }
  if (existsSync(COS_DISPATCHER_DEFAULT_KEY_PATH)) {
    process.env.WR_ALEX_MORGAN_SA_KEY_PATH = COS_DISPATCHER_DEFAULT_KEY_PATH
    return { applied: true, path: COS_DISPATCHER_DEFAULT_KEY_PATH }
  }
  return { applied: false, path: null }
}

async function main() {
  const fallback = applyKeyPathFallback()
  const results: Record<string, unknown> = {
    principal: ALEX_PRINCIPAL,
    keyPath: fallback.path,
    fallbackApplied: fallback.applied,
  }
  let exitCode = 0

  try {
    const gmail = gmailService(ALEX_PRINCIPAL)
    const profile = await gmail.users.getProfile({ userId: 'me' })
    results.gmail = {
      ok: true,
      emailAddress: profile.data.emailAddress,
      messagesTotal: profile.data.messagesTotal,
      threadsTotal: profile.data.threadsTotal,
    }
  } catch (e) {
    exitCode = 1
    if (e instanceof AuthError) {
      results.gmail = { ok: false, code: e.code, error: e.message }
    } else {
      results.gmail = { ok: false, code: 'API_ERROR', error: (e as Error).message }
    }
  }

  try {
    const cal = calendarService(ALEX_PRINCIPAL)
    const list = await cal.calendarList.list({ maxResults: 5 })
    results.calendar = {
      ok: true,
      count: list.data.items?.length ?? 0,
      primary: list.data.items?.find((c) => c.primary)?.summary ?? null,
    }
  } catch (e) {
    exitCode = 1
    if (e instanceof AuthError) {
      results.calendar = { ok: false, code: e.code, error: e.message }
    } else {
      results.calendar = { ok: false, code: 'API_ERROR', error: (e as Error).message }
    }
  }

  console.log(JSON.stringify(results, null, 2))
  process.exit(exitCode)
}

main()
