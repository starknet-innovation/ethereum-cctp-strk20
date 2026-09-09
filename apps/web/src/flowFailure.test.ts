import { describe, expect, it, vi } from 'vitest'
import { reportFlowFailureBestEffort } from './flowFailure.js'

describe('best-effort flow failure reporting', () => {
  it('returns immediately when the API update never settles', () => {
    const updateFlow = vi.fn(() => new Promise<never>(() => undefined))

    expect(
      reportFlowFailureBestEffort(updateFlow, 'f_stalled', 'write-token', 'entry was not submitted'),
    ).toBeUndefined()
    expect(updateFlow).toHaveBeenCalledWith('f_stalled', 'write-token', {
      phase: 'failed',
      failureReason: 'entry was not submitted',
    })
  })

  it('also absorbs a synchronous reporter failure', () => {
    const updateFlow = vi.fn(() => {
      throw new Error('fetch setup failed')
    })

    expect(() =>
      reportFlowFailureBestEffort(updateFlow, 'f_failed', 'write-token', 'original failure'),
    ).not.toThrow()
  })
})
