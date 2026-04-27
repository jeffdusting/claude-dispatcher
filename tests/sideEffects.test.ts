import { describe, test, expect, beforeEach } from 'bun:test'
import {
  beginPostTurn,
  markSideEffect,
  getPendingSideEffects,
  discardPendingSideEffects,
} from '../src/sideEffects.js'
import {
  createSession,
  getSession,
  setPendingSideEffects,
} from '../src/sessions.js'

describe('sideEffects — partial-failure recovery (Phase A.9.3, Δ D-003)', () => {
  beforeEach(() => {
    // Each test uses its own threadId so cross-test session state cannot
    // collide; sessions persist across test boundaries within the bun-test
    // process, but per-thread isolation is sufficient.
  })

  test('beginPostTurn writes a pending blob discoverable via getPendingSideEffects', () => {
    const threadId = `t-side-1-${Date.now()}`
    createSession(threadId, 'side-effects-test-1')
    beginPostTurn({
      threadId,
      responseText: 'all done',
      outboxFiles: [{ path: '/tmp/a.md', name: 'a.md' }],
      entity: 'cbs',
    })
    const pending = getPendingSideEffects(threadId)
    expect(pending).toBeTruthy()
    expect(pending!.responseText).toBe('all done')
    expect(pending!.outboxFiles).toEqual([{ path: '/tmp/a.md', name: 'a.md' }])
    expect(pending!.entity).toBe('cbs')
    expect(pending!.status.responsePosted).toBe(false)
    expect(pending!.status.outboxUploaded).toBe(false)
    expect(pending!.status.attachmentsSent).toBe(false)
  })

  test('outboxFiles=[] auto-completes outboxUploaded and attachmentsSent flags', () => {
    const threadId = `t-side-2-${Date.now()}`
    createSession(threadId, 'side-effects-test-2')
    beginPostTurn({
      threadId,
      responseText: 'no files',
      outboxFiles: [],
      entity: 'wr',
    })
    const pending = getPendingSideEffects(threadId)
    expect(pending!.status.outboxUploaded).toBe(true)
    expect(pending!.status.attachmentsSent).toBe(true)
    expect(pending!.status.responsePosted).toBe(false)
  })

  test('markSideEffect on every flag clears the pending blob entirely', () => {
    const threadId = `t-side-3-${Date.now()}`
    createSession(threadId, 'side-effects-test-3')
    beginPostTurn({
      threadId,
      responseText: 'with files',
      outboxFiles: [{ path: '/tmp/x.md', name: 'x.md' }],
      entity: 'cbs',
    })
    markSideEffect(threadId, 'responsePosted')
    expect(getPendingSideEffects(threadId)).toBeTruthy()
    markSideEffect(threadId, 'outboxUploaded')
    expect(getPendingSideEffects(threadId)).toBeTruthy()
    markSideEffect(threadId, 'attachmentsSent')
    // All three set → blob cleared.
    expect(getPendingSideEffects(threadId)).toBeNull()
  })

  test('discardPendingSideEffects drops the blob without replaying', () => {
    const threadId = `t-side-4-${Date.now()}`
    createSession(threadId, 'side-effects-test-4')
    beginPostTurn({
      threadId,
      responseText: 'superseded',
      outboxFiles: [],
      entity: 'cbs',
    })
    expect(getPendingSideEffects(threadId)).toBeTruthy()
    discardPendingSideEffects(threadId, 'user typed something new')
    expect(getPendingSideEffects(threadId)).toBeNull()
  })
})
