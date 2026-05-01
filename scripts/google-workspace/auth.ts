/**
 * Google Workspace authentication helper.
 *
 * Loads the Workspace service account JSON from the env-var-pointed file
 * and produces JWT credentials with domain-wide-delegation impersonation
 * of an allowed principal.
 *
 * Hard-coded principal allow-list is the application-layer guard on top
 * of the scope-level guard set at the Workspace admin DWD config. The
 * allow-list lives in code so changing it requires a code review, not
 * an ops change. Mirrors the pre-migration laptop runtime convention
 * (~/claude-workspace/alex-morgan/runtime/google_auth.py).
 */

import { readFileSync } from 'fs'
import { google } from 'googleapis'
import type { JWT } from 'google-auth-library'

export type Principal = 'jeffdusting@waterroads.com.au'

const ALLOWED_PRINCIPALS: readonly Principal[] = [
  'jeffdusting@waterroads.com.au',
] as const

const JEFF_SCOPES: readonly string[] = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/contacts.readonly',
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/tasks',
] as const

const PRINCIPAL_SCOPES: Record<Principal, readonly string[]> = {
  'jeffdusting@waterroads.com.au': JEFF_SCOPES,
}

export class AuthError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'NO_KEY_PATH'
      | 'KEY_FILE_UNREADABLE'
      | 'KEY_FILE_INVALID_JSON'
      | 'PRINCIPAL_NOT_ALLOWED',
  ) {
    super(message)
    this.name = 'AuthError'
  }
}

interface ServiceAccountKey {
  type: string
  project_id: string
  client_email: string
  private_key: string
  [k: string]: unknown
}

function loadKey(): ServiceAccountKey {
  const keyPath = process.env.WR_ALEX_MORGAN_SA_KEY_PATH
  if (!keyPath) {
    throw new AuthError(
      'WR_ALEX_MORGAN_SA_KEY_PATH not set — cannot locate service account JSON',
      'NO_KEY_PATH',
    )
  }
  let raw: string
  try {
    raw = readFileSync(keyPath, 'utf8')
  } catch (e) {
    throw new AuthError(
      `cannot read service account JSON at ${keyPath}: ${(e as Error).message}`,
      'KEY_FILE_UNREADABLE',
    )
  }
  let parsed: ServiceAccountKey
  try {
    parsed = JSON.parse(raw) as ServiceAccountKey
  } catch (e) {
    throw new AuthError(
      `service account JSON at ${keyPath} is not valid JSON: ${(e as Error).message}`,
      'KEY_FILE_INVALID_JSON',
    )
  }
  return parsed
}

export function jwtForPrincipal(principal: Principal): JWT {
  if (!ALLOWED_PRINCIPALS.includes(principal)) {
    throw new AuthError(
      `principal '${principal}' is not on the application-layer allow-list`,
      'PRINCIPAL_NOT_ALLOWED',
    )
  }
  const key = loadKey()
  const scopes = PRINCIPAL_SCOPES[principal]
  return new google.auth.JWT({
    email: key.client_email,
    key: key.private_key,
    scopes: [...scopes],
    subject: principal,
  })
}

export function gmailService(principal: Principal) {
  const auth = jwtForPrincipal(principal)
  return google.gmail({ version: 'v1', auth })
}

export function calendarService(principal: Principal) {
  const auth = jwtForPrincipal(principal)
  return google.calendar({ version: 'v3', auth })
}

export const ALEX_PRINCIPAL: Principal = 'jeffdusting@waterroads.com.au'
