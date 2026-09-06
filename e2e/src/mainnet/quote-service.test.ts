import { beforeAll, describe, expect, it } from 'vitest'
import { TOKENS, type RouteQuote, type TokenSymbol } from '@privacy-round-trip/shared'
import { parseUnits } from 'viem'
import { liveQuoteDependencies, QuoteService } from '../../../apps/api/src/quote.js'
import { MemoryStateStore } from '../../../apps/api/src/stateStore.js'
import { env, requireEnv, UNISWAP_FEE_TIERS } from '../support/env.js'

const STARKNET_FEE_RESERVE = 2_000_000n
const AMOUNTS: Record<TokenSymbol, string> = { ETH: '0.1', USDC: '250', WBTC: '0.005' }
const SYMBOLS: TokenSymbol[] = ['ETH', 'USDC', 'WBTC']
const PAIRS = SYMBOLS.flatMap((input) => SYMBOLS.map((output) => [input, output] as const))

describe.skipIf(!env.ETHEREUM_RPC_URL)('QuoteService against live Uniswap V3 pools and Circle fees', () => {
  let service: QuoteService

  beforeAll(() => {
    service = new QuoteService(liveQuoteDependencies(requireEnv('ETHEREUM_RPC_URL')), STARKNET_FEE_RESERVE, new MemoryStateStore())
  })

  it.each(PAIRS)('quotes %s -> %s coherently', async (inputToken, outputToken) => {
    const amount = AMOUNTS[inputToken]
    const started = Date.now()
    const quote: RouteQuote = await service.create({ inputToken, outputToken, amount, slippageBps: 100 })

    expect(BigInt(quote.inputAmountBase)).toBe(parseUnits(amount, TOKENS[inputToken].decimals))
    const estimatedBridge = BigInt(quote.estimatedBridgeAmountBase)
    const inbound = BigInt(quote.inboundCctpMaxFeeBase)
    const outbound = BigInt(quote.outboundCctpMaxFeeBase)
    const estimatedOutput = BigInt(quote.estimatedOutputAmountBase)

    expect(estimatedBridge).toBeGreaterThan(0n)
    expect(BigInt(quote.minimumBridgeAmountBase)).toBe((estimatedBridge * 9_900n) / 10_000n)
    expect(BigInt(quote.minimumOutputAmountBase)).toBe((estimatedOutput * 9_900n) / 10_000n)
    expect(estimatedOutput).toBeGreaterThan(0n)
    expect(inbound).toBeGreaterThanOrEqual(0n)
    expect(outbound).toBeGreaterThan(0n)
    expect(estimatedBridge).toBeGreaterThan(inbound + STARKNET_FEE_RESERVE + outbound)

    if (inputToken === 'USDC') {
      expect(quote.entryPoolFee).toBe(0)
      expect(estimatedBridge).toBe(BigInt(quote.inputAmountBase))
    } else {
      expect(UNISWAP_FEE_TIERS).toContain(quote.entryPoolFee)
    }
    if (outputToken === 'USDC') {
      expect(quote.exitPoolFee).toBe(0)
      expect(estimatedOutput).toBe(estimatedBridge - inbound - STARKNET_FEE_RESERVE - outbound)
    } else {
      expect(UNISWAP_FEE_TIERS).toContain(quote.exitPoolFee)
    }

    const expiresIn = Date.parse(quote.expiresAt) - started
    expect(expiresIn).toBeGreaterThan(0)
    expect(expiresIn).toBeLessThanOrEqual(61_000)
    expect(quote.warnings.length).toBeGreaterThan(0)
    expect(await service.get(quote.quoteId)).toEqual(quote)
  })

  it('round-trips a USDC amount close to what the fork suite settles with', async () => {
    const quote = await service.create({ inputToken: 'USDC', outputToken: 'ETH', amount: '200', slippageBps: 100 })
    expect(BigInt(quote.estimatedOutputAmountBase)).toBeGreaterThan(0n)
    expect(BigInt(quote.estimatedOutputAmountBase)).toBeLessThan(parseUnits('1', 18))
  })

  it('rejects amounts that cannot cover the route fees', async () => {
    await expect(service.create({ inputToken: 'USDC', outputToken: 'USDC', amount: '1', slippageBps: 100 })).rejects.toThrow(
      /below route fees/,
    )
  })
})
