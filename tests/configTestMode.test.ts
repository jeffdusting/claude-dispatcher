import { describe, test, expect } from 'bun:test'
import {
  DISPATCHER_TEST_MODE,
  DISCORD_BOT_TOKEN,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_FROM_NUMBER,
  OPERATOR_MOBILE,
  SARAH_MOBILE,
  CBS_DRIVE_FOLDER_ID,
  WR_DRIVE_FOLDER_ID,
  CBS_DRIVE_SA_KEY_PATH,
  WR_DRIVE_SA_KEY_PATH,
} from '../src/config.js'

describe('config.ts — DISPATCHER_TEST_MODE (Δ OD-034)', () => {
  test('the test-mode flag is on for the bun test process', () => {
    expect(DISPATCHER_TEST_MODE).toBe(true)
  })

  test('Discord bot token is empty in test mode (no .env fallback read)', () => {
    expect(DISCORD_BOT_TOKEN).toBe('')
  })

  test('every Twilio credential resolves to null in test mode', () => {
    expect(TWILIO_ACCOUNT_SID).toBeNull()
    expect(TWILIO_AUTH_TOKEN).toBeNull()
    expect(TWILIO_FROM_NUMBER).toBeNull()
    expect(OPERATOR_MOBILE).toBeNull()
    expect(SARAH_MOBILE).toBeNull()
  })

  test('Drive folder IDs and SA key paths resolve to empty/null in test mode', () => {
    expect(CBS_DRIVE_FOLDER_ID).toBeNull()
    expect(WR_DRIVE_FOLDER_ID).toBeNull()
    expect(CBS_DRIVE_SA_KEY_PATH).toBe('')
    expect(WR_DRIVE_SA_KEY_PATH).toBe('')
  })
})
