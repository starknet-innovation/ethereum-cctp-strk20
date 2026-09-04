import { beforeAll, describe, expect, it } from 'vitest'
import { CHAIN, type PublicConfig } from '@privacy-round-trip/shared'
import { encodeDeployData, getAddress, getContractAddress, type Address, type PublicClient } from 'viem'
import type { RpcProvider } from 'starknet'
import { env, requireEnv } from '../support/env.js'
import { forgeAvailable, loadArtifact } from '../support/artifacts.js'
import { ENTRY_ROUTER_VIEWS_ABI, FACTORY_ABI, OUTPUT_ASSET_INDEX, publicClient, randomBytes32 } from '../support/ethereum.js'
import { callFelts, starknetProvider } from '../support/starknet.js'

const { USDC, WBTC, WETH } = CHAIN.ethereum.tokens
const router = env.ETHEREUM_ENTRY_ROUTER as Address | undefined
const factory = env.ETHEREUM_EXIT_SETTLEMENT_FACTORY as Address | undefined
const anonymizer = env.STARKNET_CCTP_EXIT_ANONYMIZER
const anyDeployment = Boolean(router || factory || anonymizer)

describe.skipIf(!anyDeployment)('Reviewed mainnet deployments match the pinned constants and this source tree', () => {
  describe.skipIf(!(env.ETHEREUM_RPC_URL && router))('PrivacyEntryRouter', () => {
    let client: PublicClient
    beforeAll(() => {
      client = publicClient(requireEnv('ETHEREUM_RPC_URL'))
    })

    it('is deployed with the pinned token, Uniswap and Circle addresses', async () => {
      const address = router as Address
      expect(await client.getCode({ address })).toBeDefined()
      const read = (functionName: 'usdc' | 'wbtc' | 'weth' | 'swapRouter' | 'tokenMessenger') =>
        client.readContract({ address, abi: ENTRY_ROUTER_VIEWS_ABI, functionName })
      expect(getAddress(await read('usdc'))).toBe(getAddress(USDC))
      expect(getAddress(await read('wbtc'))).toBe(getAddress(WBTC))
      expect(getAddress(await read('weth'))).toBe(getAddress(WETH))
      expect(getAddress(await read('swapRouter'))).toBe(getAddress(CHAIN.ethereum.uniswap.swapRouter))
      expect(getAddress(await read('tokenMessenger'))).toBe(getAddress(CHAIN.ethereum.cctp.tokenMessengerV2))
      expect(await client.readContract({ address, abi: ENTRY_ROUTER_VIEWS_ABI, functionName: 'STARKNET_DOMAIN' })).toBe(
        CHAIN.starknet.cctpDomain,
      )
    })
  })

  describe.skipIf(!(env.ETHEREUM_RPC_URL && factory))('ExitSettlementFactory', () => {
    let client: PublicClient
    beforeAll(() => {
      client = publicClient(requireEnv('ETHEREUM_RPC_URL'))
    })

    it('is deployed with the pinned token and Uniswap addresses', async () => {
      const address = factory as Address
      expect(await client.getCode({ address })).toBeDefined()
      const read = (functionName: 'usdc' | 'wbtc' | 'weth' | 'swapRouter') =>
        client.readContract({ address, abi: FACTORY_ABI, functionName })
      expect(getAddress(await read('usdc'))).toBe(getAddress(USDC))
      expect(getAddress(await read('wbtc'))).toBe(getAddress(WBTC))
      expect(getAddress(await read('weth'))).toBe(getAddress(WETH))
      expect(getAddress(await read('swapRouter'))).toBe(getAddress(CHAIN.ethereum.uniswap.swapRouter))
    })

    it('predicts deterministic, recipient-bound, not-yet-deployed settlement addresses', async () => {
      const address = factory as Address
      const salt = randomBytes32()
      const recoverAfter = BigInt(Math.floor(Date.now() / 1_000) + 3_600)
      const predict = (recipient: Address) =>
        client.readContract({
          address,
          abi: FACTORY_ABI,
          functionName: 'predict',
          args: [salt, recipient, OUTPUT_ASSET_INDEX.USDC, 1n, 500, recoverAfter],
        })
      const first = await predict(address)
      expect(await predict(address)).toBe(first)
      expect(await predict(WETH)).not.toBe(first)
      expect(await client.getCode({ address: first })).toBeUndefined()
    })

    it.skipIf(!forgeAvailable())('embeds the ExitSettlement creation code compiled from this source tree', async () => {
      const address = factory as Address
      const salt = randomBytes32()
      const recoverAfter = BigInt(Math.floor(Date.now() / 1_000) + 3_600)
      const args = [salt, address, OUTPUT_ASSET_INDEX.WBTC, 123n, 3_000, recoverAfter] as const
      const onChain = await client.readContract({ address, abi: FACTORY_ABI, functionName: 'predict', args })
      const settlement = loadArtifact('ExitSettlement')
      const local = getContractAddress({
        opcode: 'CREATE2',
        from: address,
        salt,
        bytecode: encodeDeployData({
          abi: settlement.abi,
          bytecode: settlement.bytecode,
          args: [USDC, WBTC, WETH, CHAIN.ethereum.uniswap.swapRouter, address, OUTPUT_ASSET_INDEX.WBTC, 123n, 3_000, recoverAfter],
        }),
      })
      expect(getAddress(onChain)).toBe(getAddress(local))
    })
  })

  describe.skipIf(!(env.STARKNET_RPC_URL && anonymizer))('CctpExitAnonymizer', () => {
    let provider: RpcProvider
    beforeAll(() => {
      provider = starknetProvider(requireEnv('STARKNET_RPC_URL'))
    })

    it('routes only from the pinned privacy pool through pinned USDC and TokenMessengerMinterV2', async () => {
      const address = anonymizer as string
      expect(await provider.getClassHashAt(address)).toMatch(/^0x[0-9a-fA-F]+$/)
      const [pool, usdc, messenger] = await callFelts(provider, address, 'get_route')
      expect(BigInt(pool ?? '0x0')).toBe(BigInt(CHAIN.starknet.privacyPool))
      expect(BigInt(usdc ?? '0x0')).toBe(BigInt(CHAIN.starknet.usdc))
      expect(BigInt(messenger ?? '0x0')).toBe(BigInt(CHAIN.starknet.cctp.tokenMessengerMinterV2))
    })
  })

  it.skipIf(!env.E2E_API_URL)('the deployed API publishes the same addresses', async () => {
    const response = await fetch(`${requireEnv('E2E_API_URL').replace(/\/$/, '')}/v1/config`, { signal: AbortSignal.timeout(20_000) })
    expect(response.status).toBe(200)
    const config = (await response.json()) as PublicConfig
    if (router) expect(getAddress(config.ethereum.entryRouter as Address)).toBe(getAddress(router))
    if (factory) expect(getAddress(config.ethereum.exitSettlementFactory as Address)).toBe(getAddress(factory))
    if (anonymizer) expect(BigInt(config.starknet.cctpExitAnonymizer ?? '0x0')).toBe(BigInt(anonymizer))
  })
})
