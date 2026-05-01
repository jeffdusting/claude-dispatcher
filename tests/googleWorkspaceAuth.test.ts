/**
 * Tests for the google-workspace-jeff auth helper.
 *
 * The helper produces JWT credentials for the WR Workspace SA impersonating
 * `jeffdusting@waterroads.com.au`. The application-layer allow-list rejects
 * any other principal even if the Workspace DWD config would permit it.
 *
 * No test calls the live Workspace — these are unit tests covering the
 * argument validation, error paths, and key-loading behaviour.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  ALEX_PRINCIPAL,
  AuthError,
  jwtForPrincipal,
} from '../scripts/google-workspace/auth.js'

const tmp = mkdtempSync(join(tmpdir(), 'gws-auth-test-'))
const fakeKeyPath = join(tmp, 'sa.json')

const fakeKeyContents = JSON.stringify({
  type: 'service_account',
  project_id: 'waterroads-alex-morgan',
  private_key_id: 'fake-id',
  private_key:
    '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7VJTUt9Us8cKjMzEfYyjiWA4R4/M2bS1GB4t7NXp98C3SC6dVMvDuictGeurT8jNbvJZHtCSuYEvuNMoSfm76oqFvAp8Gy0iz5sxjZmSnXyCdPEovGhLa0VzMaQ8s+CLOyS56YyCFGeJZqgtzJ6GR3eqoYSW9b9UMvkBpZODSctWSNGj3P7jRFDO5VoTwCQAWbFnOjDfH5Ulgp2PKSQnSJP3AJLQNFNe7br1XbrhV//eO+t51mIpGSDCUv3E0DDFcWDTH9cXDTTlRZVEiR2BwpZOOkE/Z0/BVnhZYL71oZV34bKfWjQIt6V/isSMahdsAASACp4ZTGtwiVuNd9tybAgMBAAECggEBAKTmjaS6tkK8BlPXClTQ2vpz/N6uxDeS35mXpqasqskVlaAidgg/sWqpjXDbXr93otIMLlWsM+X0CqMDgSXKejLS2jx4GDjI1ZTXg++0AMJ8sJ74pWzVDOfmCEQ/7wXs3+cbnXhKriO8Z036q92Qc1+N87SI38nkGa0ABH9CN83HmQqt4fB7UdHzuIRe/me2PGhIq5ZBzj6h3BpoPGzEP+x3l9YmK8t/1cN0pqI+dQwYdgfGjackLu/2qH80MCF7IyQaseZUOJyKrCLtSD/Iixv/hzDEUPfOCjFDgTpzf3cwta8+oE4wHCo1iI1/4TlPkwmXx4qSXtmw4aQPz7IDQvECgYEA8KNThCO2gsC2I9PQDM/8Cw0O983WCDY+oi+7JPiNAJwv5DYBqEZB1QYdj06YD16XlC/HAZMsMku1na2TN0driwenQQWzoev3g2S7gRDoS/FCJSI3jJ+kjgtaA7Qmzlgk1TxODN+G1H91HW7t0l7VnL27IWyYo2qRRK3jzxqUiPUCgYEAx0oQs2reBQGMVZnApD1jeq7n4MvNLcPvt8b/eU9iUv6Y4Mj0Suo/AU8lYZXm8ubbqAlwz2VSVunD2tOplHyMUrtCtObAfVDUAhCndKaA9gApgfb3xw1IKbuQ1u4IF1FJl3VtumfQn//LiH1B3rXhcdyo3/vIttEk48RakUKClU8CgYEAzV7W3COOlDDcQd935DdtKBFRAPRPAlspQUnzMi5eSHMD/ISLDY5IiQHbIH83D4bvXq0X7qQoSBSNP7Dvv3HYuqMhf0DaegrlBuJllFVVq9qPVRnKxt1Il2HgxOBvbhOT+9in1BzA+YJ99UzC85O0Qz06A+CmtHEy4aZ2kj5hHjECgYEAmNS4+A8Fkss8Js1RieK2LniBxMgmYml3pfVLKGnzmng7H2+cwPLhPIzIuwytXywh2bzbsYEfYx3EoEVgMEpPhoarQnYPukrJO4gwE2o5Te6T5mJSZGlQJQj9q4ZB2Dfzet6INsK0oG8XVGXSpQvQh3RUYekCZQkBBFcpqWpbIEsCgYAnM3DQf3FJoSnXaMhrVBIovic5l0xFkEHskAjFTevO86Fsz1C2aSeRKSqGFoOQ0tmJzBEs1R6KqnHInicDTQrKhArgLXX4v3CddjfTRJkFWDbE/CkvKZNOrcf1nhaGCPspRJj2KUkj1Fhl9Cncdn/RsYEONbwQSjIfMPkvxF+8HQ==\n-----END PRIVATE KEY-----\n',
  client_email: 'alex-morgan-runtime@waterroads-alex-morgan.iam.gserviceaccount.com',
  client_id: 'fake',
  auth_uri: 'https://accounts.google.com/o/oauth2/auth',
  token_uri: 'https://oauth2.googleapis.com/token',
  auth_provider_x509_cert_url: 'https://www.googleapis.com/oauth2/v1/certs',
  client_x509_cert_url: 'fake',
})

const originalEnv = process.env.WR_ALEX_MORGAN_SA_KEY_PATH

describe('google-workspace-jeff/auth', () => {
  beforeEach(() => {
    delete process.env.WR_ALEX_MORGAN_SA_KEY_PATH
    writeFileSync(fakeKeyPath, fakeKeyContents)
  })

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.WR_ALEX_MORGAN_SA_KEY_PATH
    else process.env.WR_ALEX_MORGAN_SA_KEY_PATH = originalEnv
  })

  test('throws NO_KEY_PATH when env var unset', () => {
    expect(() => jwtForPrincipal(ALEX_PRINCIPAL)).toThrow(AuthError)
    try {
      jwtForPrincipal(ALEX_PRINCIPAL)
    } catch (e) {
      expect((e as AuthError).code).toBe('NO_KEY_PATH')
    }
  })

  test('throws KEY_FILE_UNREADABLE when path points at nothing', () => {
    process.env.WR_ALEX_MORGAN_SA_KEY_PATH = join(tmp, 'does-not-exist.json')
    try {
      jwtForPrincipal(ALEX_PRINCIPAL)
      throw new Error('expected throw')
    } catch (e) {
      expect((e as AuthError).code).toBe('KEY_FILE_UNREADABLE')
    }
  })

  test('throws KEY_FILE_INVALID_JSON when file is garbage', () => {
    const badPath = join(tmp, 'bad.json')
    writeFileSync(badPath, 'not json {{{')
    process.env.WR_ALEX_MORGAN_SA_KEY_PATH = badPath
    try {
      jwtForPrincipal(ALEX_PRINCIPAL)
      throw new Error('expected throw')
    } catch (e) {
      expect((e as AuthError).code).toBe('KEY_FILE_INVALID_JSON')
    }
  })

  test('rejects principals not on the application allow-list', () => {
    process.env.WR_ALEX_MORGAN_SA_KEY_PATH = fakeKeyPath
    try {
      // @ts-expect-error — deliberately passing a disallowed principal
      jwtForPrincipal('eve@waterroads.com.au')
      throw new Error('expected throw')
    } catch (e) {
      expect((e as AuthError).code).toBe('PRINCIPAL_NOT_ALLOWED')
    }
  })

  test('returns a JWT for the allowed principal when key is valid', () => {
    process.env.WR_ALEX_MORGAN_SA_KEY_PATH = fakeKeyPath
    const jwt = jwtForPrincipal(ALEX_PRINCIPAL)
    expect(jwt).toBeDefined()
    // googleapis JWT exposes `email` and `subject`
    expect(jwt.email).toBe('alex-morgan-runtime@waterroads-alex-morgan.iam.gserviceaccount.com')
    expect(jwt.subject).toBe(ALEX_PRINCIPAL)
  })

  test('ALEX_PRINCIPAL is the WR Workspace identity', () => {
    expect(ALEX_PRINCIPAL).toBe('jeffdusting@waterroads.com.au')
  })

  // Cleanup after the suite to keep the tmp tree minimal.
  test('zzz cleanup', () => {
    rmSync(tmp, { recursive: true, force: true })
    expect(true).toBe(true)
  })
})
