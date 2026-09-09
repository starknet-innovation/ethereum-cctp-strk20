import { describe, expect, it, vi } from 'vitest'
import { reportFlowFailureBestEffort, SERVER_SAFE_FAILURE_REASON } from './flowFailure.js'

describe('best-effort flow failure reporting', () => {
  it('returns immediately when the API update never settles', () => {
    const updateFlow = vi.fn(() => new Promise<never>(() => undefined))

    expect(
      reportFlowFailureBestEffort(updateFlow, 'f_stalled', 'write-token'),
    ).toBeUndefined()
    expect(updateFlow).toHaveBeenCalledWith('f_stalled', 'write-token', {
      phase: 'failed',
      failureReason: SERVER_SAFE_FAILURE_REASON,
    })
  })

  it('also absorbs a synchronous reporter failure', () => {
    const updateFlow = vi.fn(() => {
      throw new Error('fetch setup failed')
    })

    expect(() =>
      reportFlowFailureBestEffort(updateFlow, 'f_failed', 'write-token'),
    ).not.toThrow()
  })
})
