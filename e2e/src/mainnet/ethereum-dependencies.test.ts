import { beforeAll, describe, expect, it } from 'vitest'
import { CHAIN, TOKENS } from '@privacy-round-trip/shared'
import { getAddress, parseUnits, type PublicClient } from 'viem'
import { liveQuoteDependencies } from '../../../apps/api/src/quote.js'
import { env, requireEnv, UNISWAP_FEE_TIERS } from '../support/env.js'
import {
  ERC20_METADATA_ABI,
  MESSAGE_TRANSMITTER_V2_ABI,
  publicClient,
  TOKEN_MESSENGER_V2_ABI,
  UNISWAP_PERIPHERY_ABI,
} from '../support/ethereum.js'

const { USDC, WBTC, WETH } = CHAIN.ethereum.tokens

describe.skipIf(!env.ETHEREUM_RPC_URL)('Ethereum mainnet dependencies pinned in @privacy-round-trip/shared', () => {
  let client: PublicClient
  let rpc: string

  beforeAll(() => {
    rpc = requireEnv('ETHEREUM_RPC_URL')
    client = publicClient(rpc)
  })

  it('is Ethereum mainnet', async () => {
    expect(await client.getChainId()).toBe(CHAIN.ethereum.chainId)
  })

  it.each([
    ['USDC', USDC, TOKENS.USDC.decimals],
    ['WBTC', WBTC, TOKENS.WBTC.decimals],
    ['WETH', WETH, 18],
  ] as const)('%s is deployed with the expected symbol and decimals', async (symbol, address, decimals) => {
    expect(await client.getCode({ address }), `${symbol} has no code`).toBeDefined()
    expect(await client.readContract({ address, abi: ERC20_METADATA_ABI, functionName: 'decimals' })).toBe(decimals)
    expect(await client.readContract({ address, abi: ERC20_METADATA_ABI, functionName: 'symbol' })).toBe(symbol)
  })

  it('TokenMessengerV2 is wired to the pinned MessageTransmitterV2 and the Starknet TokenMessengerMinterV2', async () => {
    const address = CHAIN.ethereum.cctp.tokenMessengerV2
    const [transmitter, bodyVersion, remote, minter] = await Promise.all([
      client.readContract({ address, abi: TOKEN_MESSENGER_V2_ABI, functionName: 'localMessageTransmitter' }),
      client.readContract({ address, abi: TOKEN_MESSENGER_V2_ABI, functionName: 'messageBodyVersion' }),
      client.readContract({
        address,
        abi: TOKEN_MESSENGER_V2_ABI,
        functionName: 'remoteTokenMessengers',
        args: [CHAIN.starknet.cctpDomain],
      }),
      client.readContract({ address, abi: TOKEN_MESSENGER_V2_ABI, functionName: 'localMinter' }),
    ])
    expect(getAddress(transmitter)).toBe(getAddress(CHAIN.ethereum.cctp.messageTransmitterV2))
    expect(bodyVersion).toBe(1)
    expect(BigInt(remote)).toBe(BigInt(CHAIN.starknet.cctp.tokenMessengerMinterV2))
    expect(BigInt(minter)).not.toBe(0n)
  })

  it('MessageTransmitterV2 serves CCTP domain 0 at message version 1 and is not paused', async () => {
    const address = CHAIN.ethereum.cctp.messageTransmitterV2
    const [domain, version, paused] = await Promise.all([
      client.readContract({ address, abi: MESSAGE_TRANSMITTER_V2_ABI, functionName: 'localDomain' }),
      client.readContract({ address, abi: MESSAGE_TRANSMITTER_V2_ABI, functionName: 'version' }),
      client.readContract({ address, abi: MESSAGE_TRANSMITTER_V2_ABI, functionName: 'paused' }),
    ])
    expect(domain).toBe(CHAIN.ethereum.cctpDomain)
    expect(version).toBe(1)
    expect(paused).toBe(false)
  })

  it('Uniswap SwapRouter and Quoter share WETH9 and the V3 factory', async () => {
    const { swapRouter, quoter } = CHAIN.ethereum.uniswap
    const [routerWeth, quoterWeth, routerFactory, quoterFactory] = await Promise.all([
      client.readContract({ address: swapRouter, abi: UNISWAP_PERIPHERY_ABI, functionName: 'WETH9' }),
      client.readContract({ address: quoter, abi: UNISWAP_PERIPHERY_ABI, functionName: 'WETH9' }),
      client.readContract({ address: swapRouter, abi: UNISWAP_PERIPHERY_ABI, functionName: 'factory' }),
      client.readContract({ address: quoter, abi: UNISWAP_PERIPHERY_ABI, functionName: 'factory' }),
    ])
    expect(getAddress(routerWeth)).toBe(getAddress(WETH))
    expect(getAddress(quoterWeth)).toBe(getAddress(WETH))
    expect(BigInt(routerFactory)).not.toBe(0n)
    expect(getAddress(routerFactory)).toBe(getAddress(quoterFactory))
  })

  it('has a direct Uniswap V3 pool for every swap leg the router and settlement can take', async () => {
    const { quoteSwap } = liveQuoteDependencies(rpc)
    const legs = [
      ['WETH -> USDC', WETH, USDC, parseUnits('1', 18)],
      ['WBTC -> USDC', WBTC, USDC, parseUnits('0.01', 8)],
      ['USDC -> WETH', USDC, WETH, parseUnits('1000', 6)],
      ['USDC -> WBTC', USDC, WBTC, parseUnits('1000', 6)],
    ] as const
    for (const [label, tokenIn, tokenOut, amount] of legs) {
      const result = await quoteSwap(tokenIn, tokenOut, amount)
      expect(result.amount, label).toBeGreaterThan(0n)
      expect(UNISWAP_FEE_TIERS, label).toContain(result.fee)
    }
  })

  it('prices 1 ETH inside a broad sanity band, guarding against decimals or token mix-ups', async () => {
    const { amount } = await liveQuoteDependencies(rpc).quoteSwap(WETH, USDC, parseUnits('1', 18))
    expect(amount).toBeGreaterThan(parseUnits('100', 6))
    expect(amount).toBeLessThan(parseUnits('1000000', 6))
  })
})
