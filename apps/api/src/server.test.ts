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
  STARKSCAN_API_KEY: 'starkscan-test-key',
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
    expect(response.json().missing).toContain('STARKSCAN_API_KEY')
    await app.close()
  })

  it('submits and capability-protects Starkscan jobs, then caches the one-time result', async () => {
    const requests: Array<{ url: string; method: string }> = []
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      requests.push({ url, method })
      const headers = new Headers(init?.headers)
      expect(headers.get('x-starkscan-api-key')).toBe(config.STARKSCAN_API_KEY)

      if (method === 'POST') {
        expect(headers.get('idempotency-key')).toBe('proof-request-123456')
        return new Response(
          JSON.stringify({
            jobId: 'prv_9f2c1ab34de56789012345ab',
            status: 'queued',
            terminal: false,
            pollAfterSeconds: 10,
          }),
          { status: 202, headers: { 'content-type': 'application/json' } },
        )
      }

      return new Response(
        JSON.stringify({
          jobId: 'prv_9f2c1ab34de56789012345ab',
          status: 'succeeded',
          terminal: true,
          result: {
            proof: 'proof-data',
            proof_facts: ['0x1'],
            l2_to_l1_messages: [],
          },
        }),
        { headers: { 'content-type': 'application/json' } },
      )
    }
    const app = await buildServer(config, { quoteDependencies: dependencies, fetchImpl })
    const submitted = await app.inject({
      method: 'POST',
      url: '/v1/proofs',
      headers: { 'idempotency-key': 'proof-request-123456' },
      payload: {
        block_id: { block_number: 12_446_898 },
        transaction: { type: 'INVOKE', sender_address: '0x123', calldata: [] },
      },
    })
    expect(submitted.statusCode).toBe(202)
    const submission = submitted.json()
    expect(submission.pollToken).toMatch(/^[0-9a-f]{64}$/)

    const denied = await app.inject({
      method: 'GET',
      url: `/v1/proofs/${submission.jobId}`,
      headers: { 'x-proof-token': '0'.repeat(64) },
    })
    expect(denied.statusCode).toBe(404)

    const firstPoll = await app.inject({
      method: 'GET',
      url: `/v1/proofs/${submission.jobId}`,
      headers: { 'x-proof-token': submission.pollToken },
    })
    expect(firstPoll.statusCode).toBe(200)
    expect(firstPoll.json().result.proof).toBe('proof-data')

    const cachedPoll = await app.inject({
      method: 'GET',
      url: `/v1/proofs/${submission.jobId}`,
      headers: { 'x-proof-token': submission.pollToken },
    })
    expect(cachedPoll.json()).toEqual(firstPoll.json())
    expect(requests).toEqual([
      { url: 'https://api.starkscan.co/v1/SN_MAIN/prove', method: 'POST' },
      {
        url: 'https://api.starkscan.co/v1/SN_MAIN/prove/prv_9f2c1ab34de56789012345ab',
        method: 'GET',
      },
    ])
    await app.close()
  })
})
