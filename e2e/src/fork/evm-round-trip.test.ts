import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  CHAIN,
  type CreateFlowResponse,
  type FlowUpdate,
  type PublicFlow,
  type QuoteRequest,
  type RouteQuote,
  type TokenSymbol,
} from '@privacy-round-trip/shared'
import { createWalletClient, erc20Abi, http, keccak256, parseEther, toHex, type Address, type Hex, type PublicClient } from 'viem'
import { mainnet } from 'viem/chains'
import type { ApiConfig } from '../../../apps/api/src/config.js'
import { buildServer } from '../../../apps/api/src/server.js'
import { MemoryStateStore } from '../../../apps/api/src/stateStore.js'
import { createEphemeralIdentity } from '../../../apps/web/src/identity.js'
import { predictSettlement, submitEntry, waitForUsdcAt } from '../../../apps/web/src/wallet.js'
import { advanceChainTo, anvilRpc, startAnvil, type AnvilInstance } from '../support/anvil.js'
import { loadArtifact, type ContractName } from '../support/artifacts.js'
import { env, requireEnv } from '../support/env.js'
import {
  decodeCctpMessage,
  ENTRY_ROUTER_VIEWS_ABI,
  ERC20_METADATA_ABI,
  findDepositForBurn,
  findMessageSent,
  OUTPUT_ASSET_INDEX,
  publicClient,
  randomBytes32,
  SETTLEMENT_ABI,
} from '../support/ethereum.js'
import { call, type Api } from '../support/inject.js'
import { jsonRpcWallet } from '../support/nodeWallet.js'
import { buyWithEth, erc20Balance, transferToken } from '../support/tokens.js'

const { USDC, WBTC, WETH } = CHAIN.ethereum.tokens
const CCTP_FAST_FINALITY = 1_000
/** Mirrors ESTIMATED_STARKNET_FEES_USDC=2 in the API config below. */
const STARKNET_FEE_RESERVE = 2_000_000n
const ENTRY_AMOUNTS: Record<TokenSymbol, string> = { ETH: '0.05', USDC: '100', WBTC: '0.001' }
const PURCHASE_ETH: Record<Exclude<TokenSymbol, 'ETH'>, bigint> = { USDC: parseEther('0.1'), WBTC: parseEther('0.2') }
const SETTLEMENT_INPUT_USDC = '200'
const TOKENS_IN: TokenSymbol[] = ['ETH', 'USDC', 'WBTC']
/**
 * Payout recipient: a derived, never-used address rather than one of anvil's genesis accounts.
 * Production recipients are arbitrary EOAs, and anvil reports the pre-funded genesis balance for
 * its own dev accounts on a fork, which would hide ETH payouts.
 */
const RECIPIENT = `0x${keccak256(toHex('privacy-round-trip e2e recipient')).slice(-40)}` as Address

/**
 * Exercises the complete Ethereum leg the way production does, on an anvil fork of mainnet:
 * the real Uniswap V3 router, real USDC/WBTC/WETH, the real Circle CCTP V2 contracts, this
 * repository's contracts deployed from Foundry artifacts, the real API (quotes, flows and the
 * settlement relayer routes) and the real browser wallet code from apps/web. Only the CCTP mint
 * on the return leg is simulated, by transferring USDC to the settlement contract.
 */
describe.skipIf(!env.ETHEREUM_RPC_URL)('forked mainnet: EVM round trip through the API relayer and browser wallet code', () => {
  let anvil: AnvilInstance
  let client: PublicClient
  let app: Api
  let router: Address
  let factory: Address
  let deployer: Address
  let user: Address
  let relayer: Address
  const recipient: Address = RECIPIENT
  let clientCounter = 0
  /** Distinct simulated client per relayer request; production rate limits are per client IP. */
  const nextClient = () => `10.0.${Math.floor(clientCounter / 250)}.${(clientCounter++ % 250) + 1}`
  /** Balances the freshly deployed router already holds on the fork (well-known addresses carry dust). */
  let routerBaseline: Record<'ETH' | 'USDC' | 'WETH' | 'WBTC', bigint>

  async function deploy(name: ContractName, args: readonly unknown[]): Promise<Address> {
    const { abi, bytecode } = loadArtifact(name)
    const wallet = createWalletClient({ account: deployer, chain: mainnet, transport: http(anvil.url, { timeout: 60_000 }) })
    const hash = await wallet.deployContract({ abi, bytecode, args })
    const receipt = await client.waitForTransactionReceipt({ hash })
    if (receipt.status !== 'success' || !receipt.contractAddress) throw new Error(`${name} deployment failed`)
    return receipt.contractAddress
  }

  function quote(request: QuoteRequest): Promise<RouteQuote> {
    return call<RouteQuote>(app, { method: 'POST', url: '/v1/quotes', payload: request }, 200)
  }

  function patch(flow: PublicFlow, token: string, update: FlowUpdate): Promise<PublicFlow> {
    return call<PublicFlow>(app, { method: 'PATCH', url: `/v1/flows/${flow.id}`, headers: { 'x-flow-token': token }, payload: update }, 200)
  }

  function balanceOf(token: TokenSymbol, owner: Address): Promise<bigint> {
    return token === 'ETH' ? client.getBalance({ address: owner }) : erc20Balance(client, CHAIN.ethereum.tokens[token], owner)
  }

  async function routerHoldings(): Promise<Record<'ETH' | 'USDC' | 'WETH' | 'WBTC', bigint>> {
    return {
      ETH: await client.getBalance({ address: router }),
      USDC: await erc20Balance(client, USDC, router),
      WETH: await erc20Balance(client, WETH, router),
      WBTC: await erc20Balance(client, WBTC, router),
    }
  }

  /** USDC the API expects to reach the settlement after both CCTP legs and the Starknet fee reserve. */
  function impliedSettlementUsdc(routeQuote: RouteQuote): bigint {
    return (
      BigInt(routeQuote.estimatedBridgeAmountBase) -
      BigInt(routeQuote.inboundCctpMaxFeeBase) -
      STARKNET_FEE_RESERVE -
      BigInt(routeQuote.outboundCctpMaxFeeBase)
    )
  }

  async function createSettlement(args: {
    outputToken: TokenSymbol
    minimumOutput: bigint
    poolFee: 100 | 500 | 3000 | 10000
    recoverAfter: number
    salt?: Hex
  }): Promise<{ settlement: Address; salt: Hex }> {
    const salt = args.salt ?? randomBytes32()
    const predicted = await predictSettlement({
      wallet: jsonRpcWallet(anvil.url, user),
      factory,
      salt,
      recipient,
      outputToken: args.outputToken,
      minimumOutput: args.minimumOutput,
      poolFee: args.poolFee,
      recoverAfter: args.recoverAfter,
    })
    const created = await call<{ settlement: Address; txHash: Hex }>(
      app,
      {
        method: 'POST',
        url: '/v1/settlements',
        remoteAddress: nextClient(),
        payload: {
          salt,
          recipient,
          outputToken: args.outputToken,
          minimumOutput: args.minimumOutput.toString(),
          poolFee: args.poolFee,
          recoverAfter: args.recoverAfter,
        },
      },
      202,
    )
    expect(created.settlement.toLowerCase(), 'relayer must deploy the browser-predicted address').toBe(predicted.toLowerCase())
    const receipt = await client.waitForTransactionReceipt({ hash: created.txHash })
    expect(receipt.status).toBe('success')
    expect(await client.getCode({ address: created.settlement })).toBeDefined()
    return { settlement: created.settlement, salt }
  }

  beforeAll(async () => {
    anvil = await startAnvil({
      forkUrl: requireEnv('ETHEREUM_RPC_URL'),
      ...(env.ETHEREUM_FORK_BLOCK ? { forkBlock: env.ETHEREUM_FORK_BLOCK } : {}),
    })
    const accounts = anvil.accounts
    if (accounts.length < 3) throw new Error('anvil exposed fewer than three developer accounts')
    deployer = accounts[0] as Address
    user = accounts[1] as Address
    relayer = accounts[2] as Address
    client = publicClient(anvil.url)

    router = await deploy('PrivacyEntryRouter', [USDC, WBTC, WETH, CHAIN.ethereum.uniswap.swapRouter, CHAIN.ethereum.cctp.tokenMessengerV2])
    factory = await deploy('ExitSettlementFactory', [USDC, WBTC, WETH, CHAIN.ethereum.uniswap.swapRouter])
    routerBaseline = await routerHoldings()

    const config: ApiConfig = {
      HOST: '127.0.0.1',
      PORT: 8787,
      CORS_ORIGIN: 'http://localhost:5173',
      ETHEREUM_RPC_URL: anvil.url,
      ETHEREUM_ENTRY_ROUTER: router,
      ETHEREUM_EXIT_SETTLEMENT_FACTORY: factory,
      FLOW_TOKEN_SECRET: 'forked-mainnet-e2e-flow-token-secret-0123456789',
      STATE_CACHE_PORT: 6379,
      ESTIMATED_STARKNET_FEES_USDC: 2,
    }
    app = await buildServer(config, {
      relayerAccount: { address: relayer, type: 'json-rpc' },
      stateStore: new MemoryStateStore(),
    })

    // Hold a USDC reserve up front so funding settlements later does not move the pools that the
    // quotes in each test were priced against.
    await buyWithEth(anvil.url, user, USDC, parseEther('2'))
  })

  afterAll(async () => {
    await app?.close()
    await anvil?.stop()
  })

  it('deployed the POC contracts against the pinned mainnet dependencies', async () => {
    expect(await client.readContract({ address: router, abi: ENTRY_ROUTER_VIEWS_ABI, functionName: 'tokenMessenger' })).toBe(
      CHAIN.ethereum.cctp.tokenMessengerV2,
    )
    expect(await client.readContract({ address: router, abi: ENTRY_ROUTER_VIEWS_ABI, functionName: 'STARKNET_DOMAIN' })).toBe(
      CHAIN.starknet.cctpDomain,
    )
    const config = await call<{ ready: boolean; ethereum: { entryRouter?: string; exitSettlementFactory?: string } }>(
      app,
      { method: 'GET', url: '/v1/config' },
      200,
    )
    expect(config.ethereum.entryRouter).toBe(router)
    expect(config.ethereum.exitSettlementFactory).toBe(factory)
  })

  for (const inputToken of TOKENS_IN) {
    it(`enters with ${inputToken} and burns USDC to the ephemeral Starknet account through Circle`, async () => {
      const identity = createEphemeralIdentity()
      const routeQuote = await quote({ inputToken, outputToken: 'USDC', amount: ENTRY_AMOUNTS[inputToken], slippageBps: 100 })
      const created = await call<CreateFlowResponse>(
        app,
        {
          method: 'POST',
          url: '/v1/flows',
          payload: { quoteId: routeQuote.quoteId, ethereumSender: user, starknetAccount: identity.address, delayMinutes: 5 },
        },
        201,
      )
      let flow = created.flow
      expect(flow.phase).toBe(inputToken === 'ETH' ? 'prepared' : 'allowance-required')

      if (inputToken !== 'ETH') {
        const bought = await buyWithEth(anvil.url, user, CHAIN.ethereum.tokens[inputToken], PURCHASE_ETH[inputToken])
        expect(bought).toBeGreaterThanOrEqual(BigInt(routeQuote.inputAmountBase))
      }

      const wallet = jsonRpcWallet(anvil.url, user)
      const supplyBefore = await client.readContract({ address: USDC, abi: ERC20_METADATA_ABI, functionName: 'totalSupply' })
      const approvals: Hex[] = []
      const txHash = await submitEntry({
        wallet,
        entryRouter: router,
        flowId: flow.id,
        quote: routeQuote,
        starknetRecipient: identity.address,
        onApproval: (hash) => approvals.push(hash),
      })
      const receipt = await client.waitForTransactionReceipt({ hash: txHash })
      expect(receipt.status).toBe('success')
      expect(approvals, 'ERC-20 inputs need exactly one scoped approval; ETH needs none').toHaveLength(inputToken === 'ETH' ? 0 : 1)

      const burn = findDepositForBurn(receipt)
      expect(burn.destinationDomain).toBe(CHAIN.starknet.cctpDomain)
      expect(BigInt(burn.mintRecipient)).toBe(BigInt(identity.address))
      expect(BigInt(burn.destinationTokenMessenger)).toBe(BigInt(CHAIN.starknet.cctp.tokenMessengerMinterV2))
      expect(BigInt(burn.destinationCaller)).toBe(0n)
      expect(burn.burnToken.toLowerCase()).toBe(USDC.toLowerCase())
      expect(burn.depositor.toLowerCase()).toBe(router.toLowerCase())
      expect(burn.minFinalityThreshold).toBe(CCTP_FAST_FINALITY)
      expect(burn.maxFee).toBe(BigInt(routeQuote.inboundCctpMaxFeeBase))
      expect(burn.hookData).toBe('0x')
      expect(burn.amount).toBeGreaterThanOrEqual(BigInt(routeQuote.minimumBridgeAmountBase))
      if (inputToken === 'USDC') expect(burn.amount).toBe(BigInt(routeQuote.inputAmountBase))

      const message = decodeCctpMessage(findMessageSent(receipt))
      expect(message.version).toBe(1)
      expect(message.sourceDomain).toBe(CHAIN.ethereum.cctpDomain)
      expect(message.destinationDomain).toBe(CHAIN.starknet.cctpDomain)
      expect(BigInt(message.sender)).toBe(BigInt(CHAIN.ethereum.cctp.tokenMessengerV2))
      expect(BigInt(message.recipient)).toBe(BigInt(CHAIN.starknet.cctp.tokenMessengerMinterV2))
      expect(BigInt(message.destinationCaller)).toBe(0n)
      expect(message.minFinalityThreshold).toBe(CCTP_FAST_FINALITY)
      expect(message.finalityThresholdExecuted).toBe(0)
      expect(message.body.version).toBe(1)
      expect(BigInt(message.body.burnToken)).toBe(BigInt(USDC))
      expect(BigInt(message.body.mintRecipient)).toBe(BigInt(identity.address))
      expect(message.body.amount).toBe(burn.amount)
      expect(BigInt(message.body.messageSender)).toBe(BigInt(router))
      expect(message.body.maxFee).toBe(burn.maxFee)
      expect(message.body.feeExecuted).toBe(0n)
      expect(message.body.expirationBlock).toBe(0n)
      expect(message.body.hookData).toBe('0x')

      const supplyAfter = await client.readContract({ address: USDC, abi: ERC20_METADATA_ABI, functionName: 'totalSupply' })
      expect(supplyBefore - supplyAfter, 'USDC must be burned, not parked').toBe(burn.amount)
      expect(await routerHoldings(), 'the router must be a pure pass-through').toEqual(routerBaseline)

      flow = await patch(flow, created.writeToken, { phase: 'entry-submitted', txHash })
      expect(flow.entryTxHash).toBe(txHash)
      flow = await patch(flow, created.writeToken, { phase: 'bridging-to-starknet' })
      expect(flow.phase).toBe('bridging-to-starknet')
    })
  }

  it('rejects a replayed flow id on-chain', async () => {
    const identity = createEphemeralIdentity()
    const routeQuote = await quote({ inputToken: 'USDC', outputToken: 'USDC', amount: '50', slippageBps: 100 })
    const wallet = jsonRpcWallet(anvil.url, user)
    const flowId = `replay-${randomBytes32()}`
    const first = await submitEntry({ wallet, entryRouter: router, flowId, quote: routeQuote, starknetRecipient: identity.address })
    expect((await client.waitForTransactionReceipt({ hash: first })).status).toBe('success')

    // A wallet that simulates first rejects the replay; a node that does not mines it as a revert.
    const replay = await submitEntry({ wallet, entryRouter: router, flowId, quote: routeQuote, starknetRecipient: identity.address }).then(
      (hash) => ({ hash }),
      (error: unknown) => ({ error }),
    )
    if ('hash' in replay) {
      expect((await client.waitForTransactionReceipt({ hash: replay.hash })).status, 'replayed flow id must revert').toBe('reverted')
    } else {
      expect(String(replay.error)).toMatch(/AlreadyStarted|revert/i)
    }
  })

  for (const outputToken of TOKENS_IN) {
    it(`deploys a recipient-bound settlement through the relayer and pays ${outputToken} after the CCTP mint`, async () => {
      const routeQuote = await quote({ inputToken: 'USDC', outputToken, amount: SETTLEMENT_INPUT_USDC, slippageBps: 100 })
      const settlementUsdc = impliedSettlementUsdc(routeQuote)
      const minimumOutput = BigInt(routeQuote.minimumOutputAmountBase)
      const poolFee = (routeQuote.exitPoolFee || 500) as 100 | 500 | 3000 | 10000
      const recoverAfter = Math.floor(Date.now() / 1_000) + 3_600

      const { settlement } = await createSettlement({ outputToken, minimumOutput, poolFee, recoverAfter })
      expect((await client.readContract({ address: settlement, abi: SETTLEMENT_ABI, functionName: 'recipient' })).toLowerCase()).toBe(recipient)
      expect(await client.readContract({ address: settlement, abi: SETTLEMENT_ABI, functionName: 'outputAsset' })).toBe(OUTPUT_ASSET_INDEX[outputToken])
      expect(await client.readContract({ address: settlement, abi: SETTLEMENT_ABI, functionName: 'minimumOutput' })).toBe(minimumOutput)
      expect(await client.readContract({ address: settlement, abi: SETTLEMENT_ABI, functionName: 'recoverAfter' })).toBe(BigInt(recoverAfter))

      // Stand in for Circle's forwarded mint on Ethereum.
      await transferToken(anvil.url, user, USDC, settlement, settlementUsdc)
      expect(await waitForUsdcAt(jsonRpcWallet(anvil.url, user), settlement, 30_000)).toBe(settlementUsdc)

      const before = await balanceOf(outputToken, recipient)
      const settled = await call<{ txHash: Hex }>(
        app,
        { method: 'POST', url: `/v1/settlements/${settlement}/settle`, remoteAddress: nextClient() },
        202,
      )
      const receipt = await client.waitForTransactionReceipt({ hash: settled.txHash })
      expect(receipt.status).toBe('success')
      expect(receipt.from.toLowerCase(), 'settle() is relayed by the configured relayer account').toBe(relayer)

      const paid = (await balanceOf(outputToken, recipient)) - before
      expect(paid).toBeGreaterThanOrEqual(minimumOutput)
      if (outputToken === 'USDC') expect(paid).toBe(settlementUsdc)
      expect(await erc20Balance(client, USDC, settlement)).toBe(0n)
      expect(await client.readContract({ address: settlement, abi: SETTLEMENT_ABI, functionName: 'settled' })).toBe(true)

      const again = await app.inject({ method: 'POST', url: `/v1/settlements/${settlement}/settle`, remoteAddress: nextClient() })
      expect(again.statusCode).toBe(502)
      expect(again.json().error).toMatch(/AlreadySettled|revert/i)
    })
  }

  it('rejects malformed settlement requests and rate-limits the relayer per client as production does', async () => {
    const remoteAddress = nextClient()
    const statuses: number[] = []
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/settlements',
        remoteAddress,
        payload: { salt: '0x1234', recipient, outputToken: 'USDC', minimumOutput: '1', poolFee: 500, recoverAfter: 1 },
      })
      statuses.push(response.statusCode)
    }
    // Five requests per minute per client, validation failures included; the sixth is throttled.
    expect(statuses).toEqual([400, 400, 400, 400, 400, 429])
  })

  it('does not relay settle() for a settlement that has not received USDC', async () => {
    const recoverAfter = Math.floor(Date.now() / 1_000) + 3_600
    const { settlement } = await createSettlement({ outputToken: 'USDC', minimumOutput: 1n, poolFee: 500, recoverAfter })
    const response = await app.inject({ method: 'POST', url: `/v1/settlements/${settlement}/settle`, remoteAddress: nextClient() })
    expect(response.statusCode).toBe(502)
    expect(response.json().error).toMatch(/EmptyBalance|revert/i)
  })

  it('lets USDC be recovered after the window when the fixed swap floor cannot be met', async () => {
    const snapshot = await anvilRpc<string>(anvil.url, 'evm_snapshot')
    try {
      const routeQuote = await quote({ inputToken: 'USDC', outputToken: 'WBTC', amount: SETTLEMENT_INPUT_USDC, slippageBps: 100 })
      const settlementUsdc = impliedSettlementUsdc(routeQuote)
      const recoverAfter = Math.floor(Date.now() / 1_000) + 3_600
      const { settlement } = await createSettlement({
        outputToken: 'WBTC',
        minimumOutput: 2n ** 200n,
        poolFee: (routeQuote.exitPoolFee || 3000) as 100 | 500 | 3000 | 10000,
        recoverAfter,
      })
      await transferToken(anvil.url, user, USDC, settlement, settlementUsdc)

      const stuck = await app.inject({ method: 'POST', url: `/v1/settlements/${settlement}/settle`, remoteAddress: nextClient() })
      expect(stuck.statusCode).toBe(502)
      expect(stuck.json().error).toMatch(/Too little received|revert/i)

      // recoverAsUsdc() is permissionless; anyone (here the relayer) can trigger the fallback payout.
      await expect(
        client.simulateContract({ account: relayer, address: settlement, abi: SETTLEMENT_ABI, functionName: 'recoverAsUsdc' }),
      ).rejects.toThrow(/RecoveryNotReady/)

      await advanceChainTo(anvil.url, recoverAfter)
      const before = await erc20Balance(client, USDC, recipient)
      const wallet = createWalletClient({ account: relayer, chain: mainnet, transport: http(anvil.url, { timeout: 60_000 }) })
      const hash = await wallet.writeContract({ address: settlement, abi: SETTLEMENT_ABI, functionName: 'recoverAsUsdc' })
      expect((await client.waitForTransactionReceipt({ hash })).status).toBe('success')
      expect((await erc20Balance(client, USDC, recipient)) - before).toBe(settlementUsdc)
      expect(await client.readContract({ address: settlement, abi: SETTLEMENT_ABI, functionName: 'settled' })).toBe(true)
    } finally {
      // Undo the clock jump so later Date.now()-based deadlines stay valid.
      await anvilRpc(anvil.url, 'evm_revert', [snapshot])
    }
  })
})
