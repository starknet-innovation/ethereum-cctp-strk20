import { describe, expect, it } from 'vitest'
import { CHAIN } from '@privacy-round-trip/shared'
import { QuoteService, type QuoteDependencies } from './quote.js'
import { MemoryStateStore } from './stateStore.js'

describe('route quote fee disclosure', () => {
  it('returns every deducted fee component and the USDC amount before the exit swap', async () => {
    const dependencies: QuoteDependencies = {
      quoteSwap: async (tokenIn, _tokenOut, amount) => {
        if (tokenIn === CHAIN.ethereum.tokens.WETH) {
          expect(amount).toBe(1_000_000_000_000_000_000n)
          return { amount: 25_000_000n, fee: 500 }
        }
        expect(tokenIn).toBe(CHAIN.ethereum.tokens.USDC)
        expect(amount).toBe(21_750_000n)
        return { amount: 50_000n, fee: 3_000 }
      },
      cctpMaxFee: async (source, destination, _amount, forward) => {
        if (source === 0 && destination === 25 && !forward) {
          return { protocolFee: 250_000n, forwardingFee: 0n, total: 250_000n }
        }
        expect({ source, destination, forward }).toEqual({ source: 25, destination: 0, forward: true })
        return { protocolFee: 400_000n, forwardingFee: 600_000n, total: 1_000_000n }
      },
    }
    const service = new QuoteService(dependencies, 2_000_000n, new MemoryStateStore())

    const quote = await service.create({
      inputToken: 'ETH',
      outputToken: 'WBTC',
      amount: '1',
      slippageBps: 100,
    })

    expect(quote).toMatchObject({
      inputAmountBase: '1000000000000000000',
      estimatedBridgeAmountBase: '25000000',
      entryPoolFee: 500,
      inboundCctpProtocolFeeBase: '250000',
      inboundCctpMaxFeeBase: '250000',
      estimatedStarknetFeesBase: '2000000',
      outboundCctpProtocolFeeBase: '400000',
      outboundCctpForwardingFeeBase: '600000',
      outboundCctpMaxFeeBase: '1000000',
      estimatedSettlementUsdcBase: '21750000',
      estimatedOutputAmountBase: '50000',
      minimumOutputAmountBase: '49500',
      exitPoolFee: 3000,
    })
  })
})
