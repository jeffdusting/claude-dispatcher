import { describe, test, expect } from 'bun:test'
import {
  driveEnabled,
  _getEntityDriveConfigForTesting,
} from '../src/drive.js'
import { CBS_DRIVE_SA_KEY_PATH, WR_DRIVE_SA_KEY_PATH } from '../src/config.js'

describe('drive.ts — per-entity routing (Phase A.5.1)', () => {
  test('CBS and WR each have their own config entry exposed via the routing accessor', () => {
    const cbs = _getEntityDriveConfigForTesting('cbs')
    const wr = _getEntityDriveConfigForTesting('wr')
    // Under DISPATCHER_TEST_MODE both paths/folders are empty/null — the
    // distinctness in production is enforced by config.ts statically (CBS
    // routes to google-drive-sa.json, WR routes to wr-drive-sa.json).
    // The test asserts the routing surface exists and is shape-correct
    // for both entities; the test-mode flag verifies that fallbacks are
    // gated, not that the paths are different.
    expect(typeof cbs.saKeyPath).toBe('string')
    expect(typeof wr.saKeyPath).toBe('string')
    expect(cbs).toHaveProperty('folderId')
    expect(wr).toHaveProperty('folderId')
  })

  test('under DISPATCHER_TEST_MODE the SA key paths are empty (Δ OD-034)', () => {
    // setup.ts sets DISPATCHER_TEST_MODE=1 before config.ts loads, so the
    // secret-path fallback returned '' and the exports inherited that.
    expect(CBS_DRIVE_SA_KEY_PATH).toBe('')
    expect(WR_DRIVE_SA_KEY_PATH).toBe('')
  })

  test('driveEnabled returns false for both entities under DISPATCHER_TEST_MODE', () => {
    // With empty key paths and null folder IDs, the dispatcher must not
    // attempt to upload. The secret-resolution gate is what makes the test
    // closed-by-default — `driveEnabled` is the consumer that observes it.
    expect(driveEnabled('cbs')).toBe(false)
    expect(driveEnabled('wr')).toBe(false)
  })

  test('folder IDs are null under DISPATCHER_TEST_MODE (env-file fallback gated)', () => {
    expect(_getEntityDriveConfigForTesting('cbs').folderId).toBeNull()
    expect(_getEntityDriveConfigForTesting('wr').folderId).toBeNull()
  })
})
