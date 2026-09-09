import { describe, expect, it } from 'vitest'
import type { RouteQuote } from '@privacy-round-trip/shared'
import { executionQuoteForReviewedRoute } from './quoteSafety.js'

const reviewed: RouteQuote = {
  quoteId: 'q_reviewed',
  request: { inputToken: 'ETH', outputToken: 'ETH', amount: '1', slippageBps: 100 },
  inputAmountBase: '1000000000000000000',
  estimatedBridgeAmountBase: '100000000',
  minimumBridgeAmountBase: '99000000',
  estimatedOutputAmountBase: '1000000000000000000',
  minimumOutputAmountBase: '990000000000000000',
  entryPoolFee: 500,
  exitPoolFee: 500,
  inboundCctpProtocolFeeBase: '10000',
  inboundCctpMaxFeeBase: '10000',
  estimatedStarknetFeesBase: '2000000',
  outboundCctpProtocolFeeBase: '100000',
  outboundCctpForwardingFeeBase: '1000000',
  outboundCctpMaxFeeBase: '1100000',
  estimatedSettlementUsdcBase: '96890000',
  expiresAt: '2030-01-01T00:00:00.000Z',
  warnings: [],
}

describe('execution quote safety', () => {
  it('keeps the reviewed floors when the refreshed estimates remain acceptable', () => {
    const fresh: RouteQuote = {
      ...reviewed,
      quoteId: 'q_fresh',
      estimatedBridgeAmountBase: reviewed.minimumBridgeAmountBase,
      minimumBridgeAmountBase: '98010000',
      estimatedOutputAmountBase: reviewed.minimumOutputAmountBase,
      minimumOutputAmountBase: '980100000000000000',
    }

    const execution = executionQuoteForReviewedRoute(reviewed, fresh)

    expect(execution.quoteId).toBe('q_fresh')
    expect(execution.minimumBridgeAmountBase).toBe(reviewed.minimumBridgeAmountBase)
    expect(execution.minimumOutputAmountBase).toBe(reviewed.minimumOutputAmountBase)
  })

  it('requires another review when a fee cap increases', () => {
    expect(() => executionQuoteForReviewedRoute(reviewed, {
      ...reviewed,
      quoteId: 'q_fresh',
      outboundCctpMaxFeeBase: '1100001',
    })).toThrow('A route fee increased or its disclosure changed')
  })

  it('requires another review when a newly deployed backend adds a previously undisclosed fee', () => {
    const legacy = { ...reviewed }
    delete legacy.estimatedStarknetFeesBase

    expect(() => executionQuoteForReviewedRoute(legacy, {
      ...reviewed,
      quoteId: 'q_fresh',
    })).toThrow('A route fee increased or its disclosure changed')
  })

  it('requires another review when the market crosses either reviewed floor', () => {
    expect(() => executionQuoteForReviewedRoute(reviewed, {
      ...reviewed,
      quoteId: 'q_fresh',
      estimatedOutputAmountBase: '989999999999999999',
    })).toThrow('market moved beyond')
  })

  it('requires another review when the selected pool changes', () => {
    expect(() => executionQuoteForReviewedRoute(reviewed, {
      ...reviewed,
      quoteId: 'q_fresh',
      entryPoolFee: 3000,
    })).toThrow('best swap pool changed')
  })
})
