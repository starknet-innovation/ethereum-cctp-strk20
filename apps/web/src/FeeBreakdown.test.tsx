import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { RouteQuote } from '@privacy-round-trip/shared'
import { FeeBreakdown, poolFeePercent } from './FeeBreakdown.js'

const quote: RouteQuote = {
  quoteId: 'q_fee_breakdown',
  request: { inputToken: 'ETH', outputToken: 'WBTC', amount: '1', slippageBps: 100 },
  inputAmountBase: '1000000000000000000',
  estimatedBridgeAmountBase: '25000000',
  minimumBridgeAmountBase: '24750000',
  estimatedOutputAmountBase: '50000',
  minimumOutputAmountBase: '49500',
  entryPoolFee: 500,
  exitPoolFee: 3000,
  inboundCctpProtocolFeeBase: '250000',
  inboundCctpMaxFeeBase: '250000',
  estimatedStarknetFeesBase: '2000000',
  outboundCctpProtocolFeeBase: '400000',
  outboundCctpForwardingFeeBase: '600000',
  outboundCctpMaxFeeBase: '1000000',
  estimatedSettlementUsdcBase: '21750000',
  expiresAt: '2030-01-01T00:00:00.000Z',
  warnings: ['Delayed swaps can change.'],
}

describe('fee breakdown', () => {
  it('shows every route deduction, included swap fee, separate gas cost, and output floor', () => {
    const html = renderToStaticMarkup(
      <FeeBreakdown
        quote={quote}
        inputToken="ETH"
        outputToken="WBTC"
        walletPrompts="1 transaction"
        delayMinutes={30}
      />,
    )

    expect(html).toContain('0.05% Uniswap pool fee')
    expect(html).toContain('0.3% Uniswap pool fee')
    expect(html).toContain('0.25 USDC')
    expect(html).toContain('2.0 USDC')
    expect(html).toContain('0.4 USDC')
    expect(html).toContain('0.6 USDC')
    expect(html).toContain('3.25 USDC')
    expect(html).toContain('21.75 USDC')
    expect(html).toContain('Separate ETH cost')
    expect(html).toContain('0.000495 WBTC')
    expect(html).toContain('Different assets')
    expect(html).toContain('Delayed swaps can change.')
  })

  it('renders an older persisted quote without inventing missing fee components', () => {
    const legacy: RouteQuote = { ...quote }
    delete legacy.inboundCctpProtocolFeeBase
    delete legacy.estimatedStarknetFeesBase
    delete legacy.outboundCctpProtocolFeeBase
    delete legacy.outboundCctpForwardingFeeBase
    delete legacy.estimatedSettlementUsdcBase
    const html = renderToStaticMarkup(
      <FeeBreakdown
        quote={legacy}
        inputToken="ETH"
        outputToken="WBTC"
        walletPrompts="1 transaction"
        delayMinutes={30}
      />,
    )

    expect(html).toContain('detailed amount unavailable')
    expect(html).toContain('CCTP return + forwarding')
    expect(html).not.toContain('USDC before payout swap')
  })

  it('states the numeric send-to-receive difference when both assets match', () => {
    const sameAsset: RouteQuote = {
      ...quote,
      request: { inputToken: 'USDC', outputToken: 'USDC', amount: '25', slippageBps: 100 },
      inputAmountBase: '25000000',
      estimatedOutputAmountBase: '21750000',
      minimumOutputAmountBase: '21532500',
      entryPoolFee: 0,
      exitPoolFee: 0,
    }
    const html = renderToStaticMarkup(
      <FeeBreakdown
        quote={sameAsset}
        inputToken="USDC"
        outputToken="USDC"
        walletPrompts="up to 2 transactions"
        delayMinutes={30}
      />,
    )

    expect(html).toContain('3.25 USDC less')
    expect(html.match(/No swap · 0 fee/g)).toHaveLength(2)
  })

  it('formats every supported Uniswap fee tier as a percentage', () => {
    expect([100, 500, 3_000, 10_000].map(poolFeePercent)).toEqual(['0.01%', '0.05%', '0.3%', '1%'])
  })
})
