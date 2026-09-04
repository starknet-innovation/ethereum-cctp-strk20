import { describe, expect, it } from 'vitest'
import { buildServer } from './server.js'
import type { ApiConfig } from './config.js'
import type { QuoteDependencies } from './quote.js'

const config: ApiConfig = {
  HOST: '127.0.0.1',
  PORT: 8787,
  CORS_ORIGIN: 'http://localhost:5173',
  ETHEREUM_RPC_URL: 'https://rpc.example',
  STARKNET_RPC_URL: 'https://starknet.example',
  PROVER_URL: 'https://prover.example',
  DISCOVERY_URL: 'https://discovery.example',
  PAYMASTER_URL: 'https://paymaster.example',
  ETHEREUM_ENTRY_ROUTER: '0x1111111111111111111111111111111111111111',
  ETHEREUM_EXIT_SETTLEMENT_FACTORY: '0x2222222222222222222222222222222222222222',
  STARKNET_CCTP_EXIT_ANONYMIZER: '0x123',
  ETHEREUM_RELAYER_PRIVATE_KEY: `0x${'11'.repeat(32)}`,
  FLOW_TOKEN_SECRET: 'x'.repeat(32),
  STATE_CACHE_PORT: 6379,
  ESTIMATED_STARKNET_FEES_USDC: 2,
}

const dependencies: QuoteDependencies = {
  quoteSwap: async (_in, _out, amount) => ({ amount: amount * 2n, fee: 500 }),
  cctpMaxFee: async (_source, _destination, _amount, forward) => (forward ? 1_500_000n : 100_000n),
}

describe('api', () => {
  it('creates a private-capability-protected flow and enforces lifecycle order', async () => {
    const app = await buildServer(config, { quoteDependencies: dependencies })
    const quoteResponse = await app.inject({
      method: 'POST',
      url: '/v1/quotes',
      payload: {
        inputToken: 'USDC',
        outputToken: 'USDC',
        amount: '20',
        slippageBps: 100,
      },
    })
    expect(quoteResponse.statusCode).toBe(200)
    const quote = quoteResponse.json()

    const createResponse = await app.inject({
      method: 'POST',
      url: '/v1/flows',
      payload: {
        quoteId: quote.quoteId,
        ethereumSender: '0x3333333333333333333333333333333333333333',
        starknetAccount: '0x456',
        delayMinutes: 45,
      },
    })
    expect(createResponse.statusCode).toBe(201)
    const created = createResponse.json()
    expect(created.flow.phase).toBe('allowance-required')

    const denied = await app.inject({ method: 'GET', url: `/v1/flows/${created.flow.id}` })
    expect(denied.statusCode).toBe(404)

    const skipped = await app.inject({
      method: 'PATCH',
      url: `/v1/flows/${created.flow.id}`,
      headers: { 'x-flow-token': created.writeToken },
      payload: { phase: 'privacy-delay' },
    })
    expect(skipped.statusCode).toBe(409)
    await app.close()
  })

  it('reports missing deployment configuration without pretending to be ready', async () => {
    const app = await buildServer({
      HOST: '127.0.0.1',
      PORT: 8787,
      CORS_ORIGIN: 'http://localhost:5173',
      STATE_CACHE_PORT: 6379,
      ESTIMATED_STARKNET_FEES_USDC: 2,
    })
    const response = await app.inject({ method: 'GET', url: '/v1/health/ready' })
    expect(response.statusCode).toBe(503)
    expect(response.json().missing).toContain('ETHEREUM_ENTRY_ROUTER')
    await app.close()
  })
})
