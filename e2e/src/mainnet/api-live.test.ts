import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CHAIN, type CreateFlowResponse, type PublicConfig, type PublicFlow, type RouteQuote } from '@privacy-round-trip/shared'
import type { ApiConfig } from '../../../apps/api/src/config.js'
import { buildServer } from '../../../apps/api/src/server.js'
import { MemoryStateStore } from '../../../apps/api/src/stateStore.js'
import { env, requireEnv, SYNTHETIC_TX_HASH } from '../support/env.js'
import { call, type Api } from '../support/inject.js'

describe.skipIf(!env.ETHEREUM_RPC_URL)('API server against live mainnet upstreams', () => {
  let app: Api

  beforeAll(async () => {
    const config: ApiConfig = {
      HOST: '127.0.0.1',
      PORT: 8787,
      CORS_ORIGIN: 'http://localhost:5173',
      ETHEREUM_RPC_URL: requireEnv('ETHEREUM_RPC_URL'),
      ...(env.STARKNET_RPC_URL ? { STARKNET_RPC_URL: env.STARKNET_RPC_URL } : {}),
      STATE_CACHE_PORT: 6379,
      ESTIMATED_STARKNET_FEES_USDC: 2,
    }
    app = await buildServer(config, { stateStore: new MemoryStateStore() })
  })

  afterAll(async () => {
    await app?.close()
  })

  it('publishes the pinned mainnet configuration and reports missing deployment values honestly', async () => {
    const config = await call<PublicConfig>(app, { method: 'GET', url: '/v1/config' }, 200)
    expect(config.environment).toBe('mainnet')
    expect(config.ready).toBe(false)
    expect(config.missing).toEqual(expect.arrayContaining(['ETHEREUM_ENTRY_ROUTER', 'ETHEREUM_EXIT_SETTLEMENT_FACTORY', 'STARKNET_CCTP_EXIT_ANONYMIZER']))
    expect(config.ethereum.tokens).toEqual({
      ETH: CHAIN.ethereum.tokens.ETH,
      USDC: CHAIN.ethereum.tokens.USDC,
      WBTC: CHAIN.ethereum.tokens.WBTC,
    })
    expect(config.ethereum.tokenMessengerV2).toBe(CHAIN.ethereum.cctp.tokenMessengerV2)
    expect(config.starknet.privacyPool).toBe(CHAIN.starknet.privacyPool)
    expect(config.starknet.usdc).toBe(CHAIN.starknet.usdc)
    expect(config.ethereum.entryRouter).toBeUndefined()

    const ready = await app.inject({ method: 'GET', url: '/v1/health/ready' })
    expect(ready.statusCode).toBe(503)
    expect(ready.json().ready).toBe(false)
  })

  it('quotes a live route, creates a capability-protected flow and enforces its lifecycle', async () => {
    const quote = await call<RouteQuote>(
      app,
      { method: 'POST', url: '/v1/quotes', payload: { inputToken: 'ETH', outputToken: 'ETH', amount: '0.05', slippageBps: 100 } },
      200,
    )
    expect(BigInt(quote.estimatedBridgeAmountBase)).toBeGreaterThan(0n)
    expect(BigInt(quote.estimatedOutputAmountBase)).toBeGreaterThan(0n)

    const created = await call<CreateFlowResponse>(
      app,
      {
        method: 'POST',
        url: '/v1/flows',
        payload: {
          quoteId: quote.quoteId,
          ethereumSender: CHAIN.ethereum.tokens.WETH,
          starknetAccount: CHAIN.starknet.privacyPool,
          delayMinutes: 5,
        },
      },
      201,
    )
    expect(created.flow.phase).toBe('prepared')
    expect(created.writeToken.length).toBeGreaterThanOrEqual(32)

    const unauthenticated = await app.inject({ method: 'GET', url: `/v1/flows/${created.flow.id}` })
    expect(unauthenticated.statusCode).toBe(404)

    const headers = { 'x-flow-token': created.writeToken }
    const submitted = await call<PublicFlow>(
      app,
      { method: 'PATCH', url: `/v1/flows/${created.flow.id}`, headers, payload: { phase: 'entry-submitted', txHash: SYNTHETIC_TX_HASH } },
      200,
    )
    expect(submitted.entryTxHash).toBe(SYNTHETIC_TX_HASH)

    const skipped = await app.inject({
      method: 'PATCH',
      url: `/v1/flows/${created.flow.id}`,
      headers,
      payload: { phase: 'privacy-delay' },
    })
    expect(skipped.statusCode).toBe(409)

    const read = await call<PublicFlow>(app, { method: 'GET', url: `/v1/flows/${created.flow.id}`, headers }, 200)
    expect(read.phase).toBe('entry-submitted')
  })

  it('proxies Circle message lookups verbatim, including not-found responses', async () => {
    const response = await app.inject({ method: 'GET', url: `/v1/cctp/messages/0x${'00'.repeat(32)}` })
    expect(response.statusCode).toBe(404)
    expect(typeof response.json().error).toBe('string')
  })

  it.skipIf(!env.STARKNET_RPC_URL)('proxies Starknet JSON-RPC to the configured upstream', async () => {
    const response = await call<{ result?: string }>(
      app,
      { method: 'POST', url: '/proxy/starknet-rpc', payload: { jsonrpc: '2.0', id: 1, method: 'starknet_chainId', params: [] } },
      200,
    )
    expect(response.result).toBe(CHAIN.starknet.chainId)
  })

  it('fails closed on relaying when no relayer or upstream is configured', async () => {
    const settlement = await app.inject({
      method: 'POST',
      url: '/v1/settlements',
      payload: {
        salt: `0x${'22'.repeat(32)}`,
        recipient: CHAIN.ethereum.tokens.WETH,
        outputToken: 'USDC',
        minimumOutput: '1',
        poolFee: 500,
        recoverAfter: Math.floor(Date.now() / 1_000) + 3_600,
      },
    })
    expect(settlement.statusCode).toBe(503)
    const settle = await app.inject({ method: 'POST', url: `/v1/settlements/${CHAIN.ethereum.tokens.WETH}/settle` })
    expect(settle.statusCode).toBe(503)
    const prover = await app.inject({ method: 'POST', url: '/proxy/prover', payload: {} })
    expect(prover.statusCode).toBe(503)
  })
})
