import { describe, expect, it } from 'vitest'
import { applyFlowUpdate, canTransition, remainingDelayMs } from './lifecycle.js'
import type { PublicFlow, RouteQuote } from './types.js'

const quote: RouteQuote = {
  quoteId: 'quote_12345678',
  request: {
    inputToken: 'ETH',
    outputToken: 'WBTC',
    amount: '1',
    slippageBps: 100,
  },
  inputAmountBase: '1000000000000000000',
  estimatedBridgeAmountBase: '3000000000',
  minimumBridgeAmountBase: '2970000000',
  estimatedOutputAmountBase: '5000000',
  minimumOutputAmountBase: '4950000',
  entryPoolFee: 500,
  exitPoolFee: 3000,
  inboundCctpMaxFeeBase: '1000000',
  outboundCctpMaxFeeBase: '1000000',
  expiresAt: '2030-01-01T00:00:00.000Z',
  warnings: [],
}

const flow: PublicFlow = {
  id: 'flow_123',
  phase: 'pool-depositing',
  quote,
  ethereumSender: '0x2222222222222222222222222222222222222222',
  starknetAccount: '0x123',
  delayMinutes: 30,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}

describe('flow lifecycle', () => {
  it('starts the chosen delay when the pool deposit is confirmed', () => {
    const updated = applyFlowUpdate(
      flow,
      {
        phase: 'privacy-delay',
        txHash: `0x${'a'.repeat(64)}`,
        occurredAt: '2026-01-01T00:00:00.000Z',
      },
    )
    expect(updated.exitEligibleAt).toBe('2026-01-01T00:30:00.000Z')
    expect(remainingDelayMs(updated, Date.parse('2026-01-01T00:20:00.000Z'))).toBe(600_000)
  })

  it('rejects skips and terminal transitions', () => {
    expect(canTransition('prepared', 'privacy-delay')).toBe(false)
    expect(canTransition('completed', 'failed')).toBe(false)
    expect(() => applyFlowUpdate(flow, { phase: 'completed' })).toThrow(/Invalid flow transition/)
  })
})
