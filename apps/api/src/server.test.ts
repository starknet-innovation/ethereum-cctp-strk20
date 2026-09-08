import { describe, expect, it } from 'vitest'
import { CHAIN, STARKNET_SELECTORS } from '@privacy-round-trip/shared'
import { buildServer, type EntryVerifier } from './server.js'
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
  AVNU_PAYMASTER_API_KEY: 'avnu-test-key',
  ETHEREUM_ENTRY_ROUTER: '0x1111111111111111111111111111111111111111',
  ETHEREUM_EXIT_SETTLEMENT_FACTORY: '0x2222222222222222222222222222222222222222',
  STARKNET_CCTP_EXIT_ANONYMIZER: '0x123',
  ETHEREUM_RELAYER_PRIVATE_KEY: `0x${'11'.repeat(32)}`,
  RELAYER_ENABLED: true,
  RELAYER_DAILY_SPEND_LIMIT_GWEI: 5_000_000,
  RELAYER_MIN_BALANCE_WEI: 2_000_000_000_000_000n,
  RELAYER_MAX_GAS_PER_TRANSACTION: 800_000n,
  RELAYER_MAX_FACTORY_CREATE_GAS: 1_300_000n,
  RELAYER_GAS_LIMIT_MULTIPLIER_BPS: 12_500,
  FLOW_TOKEN_SECRET: 'x'.repeat(32),
  STATE_CACHE_PORT: 6379,
  ESTIMATED_STARKNET_FEES_USDC: 2,
}

const dependencies: QuoteDependencies = {
  quoteSwap: async (_in, _out, amount) => ({ amount: amount * 2n, fee: 500 }),
  cctpMaxFee: async (_source, _destination, _amount, forward) => (forward ? 1_500_000n : 100_000n),
}

const verifiedEntry: EntryVerifier = async () => true
const SENDER = '0x3333333333333333333333333333333333333333'
const ACCOUNT = '0x456'
const PUBLIC_KEY = '0x77'
const ENTRY_TX = `0x${'22'.repeat(32)}`

interface TestCall {
  to: string
  selector: string
  calldata: string[]
}

const deployment: Record<string, unknown> = {
  address: ACCOUNT,
  class_hash: CHAIN.starknet.ozAccountClassHash,
  salt: PUBLIC_KEY,
  calldata: [PUBLIC_KEY],
  version: 1,
}

const receiveMessageCall: TestCall = {
  to: CHAIN.starknet.cctp.messageTransmitterV2,
  selector: STARKNET_SELECTORS.receive_message,
  calldata: ['0x1', '0x2'],
}

function typedData(calls: TestCall[]) {
  return {
    types: {},
    primaryType: 'OutsideExecution',
    domain: { name: 'Account.execute_from_outside', version: '2', chainId: CHAIN.starknet.chainId, revision: '1' },
    message: {
      Caller: '0x414e595f43414c4c4552',
      Nonce: '0x1',
      'Execute After': '0x0',
      'Execute Before': '0xffffffff',
      Calls: calls.map((call) => ({ To: call.to, Selector: call.selector, Calldata: call.calldata })),
    },
  }
}

async function bridgingFlow(app: Awaited<ReturnType<typeof buildServer>>) {
  const quote = await app.inject({
    method: 'POST',
    url: '/v1/quotes',
    payload: { inputToken: 'ETH', outputToken: 'USDC', amount: '1', slippageBps: 100 },
  })
  const created = await app.inject({
    method: 'POST',
    url: '/v1/flows',
    payload: {
      quoteId: quote.json().quoteId,
      ethereumSender: SENDER,
      starknetAccount: ACCOUNT,
      delayMinutes: 5,
    },
  })
  const access = created.json()
  for (const phase of ['entry-submitted', 'bridging-to-starknet']) {
    const transition = await app.inject({
      method: 'PATCH',
      url: `/v1/flows/${access.flow.id}`,
      headers: { 'x-flow-token': access.writeToken },
      payload: { phase, ...(phase === 'entry-submitted' ? { txHash: ENTRY_TX } : {}) },
    })
    expect(transition.statusCode).toBe(200)
  }
  return access as { flow: { id: string }; writeToken: string }
}

function recordingFetch() {
  const requests: Array<{ url: string; key: string | null; body: unknown }> = []
  const fetchImpl: typeof fetch = async (input, init) => {
    requests.push({
      url: String(input),
      key: new Headers(init?.headers).get('x-paymaster-api-key'),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    })
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { accepted: true } }), {
      headers: { 'content-type': 'application/json' },
    })
  }
  return { requests, fetchImpl }
}

describe('api', () => {
  it('creates a private-capability-protected flow and enforces lifecycle order', async () => {
    const app = await buildServer(config, { quoteDependencies: dependencies, entryVerifier: verifiedEntry })
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
        ethereumSender: SENDER,
        starknetAccount: ACCOUNT,
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

    for (const [phase, txHash] of [
      ['entry-submitted', `0x${'44'.repeat(32)}`],
      ['bridging-to-starknet', undefined],
      ['starknet-funded', '0x123abc'],
    ] as const) {
      const transition = await app.inject({
        method: 'PATCH',
        url: `/v1/flows/${created.flow.id}`,
        headers: { 'x-flow-token': created.writeToken },
        payload: { phase, ...(txHash ? { txHash } : {}) },
      })
      expect(transition.statusCode).toBe(200)
    }

    const joined = await app.inject({
      method: 'PATCH',
      url: `/v1/flows/${created.flow.id}`,
      headers: { 'x-flow-token': created.writeToken },
      payload: { phase: 'pool-depositing', settlementAddress: SENDER },
    })
    expect(joined.statusCode).toBe(400)
    await app.close()
  })

  it('refuses to open sponsorship until the entry burn is verified on Ethereum', async () => {
    const seen: Parameters<EntryVerifier>[0][] = []
    const app = await buildServer(config, {
      quoteDependencies: dependencies,
      entryVerifier: async (args) => {
        seen.push(args)
        return false
      },
    })
    const quote = await app.inject({
      method: 'POST',
      url: '/v1/quotes',
      payload: { inputToken: 'ETH', outputToken: 'USDC', amount: '1', slippageBps: 100 },
    })
    const created = await app.inject({
      method: 'POST',
      url: '/v1/flows',
      payload: { quoteId: quote.json().quoteId, ethereumSender: SENDER, starknetAccount: ACCOUNT, delayMinutes: 5 },
    })
    const access = created.json()
    const headers = { 'x-flow-token': access.writeToken }
    const unverifiable = await app.inject({
      method: 'PATCH',
      url: `/v1/flows/${access.flow.id}`,
      headers,
      payload: { phase: 'bridging-to-starknet' },
    })
    expect(unverifiable.statusCode).toBe(409)
    expect(seen).toEqual([])

    await app.inject({
      method: 'PATCH',
      url: `/v1/flows/${access.flow.id}`,
      headers,
      payload: { phase: 'entry-submitted', txHash: ENTRY_TX },
    })
    const rejected = await app.inject({
      method: 'PATCH',
      url: `/v1/flows/${access.flow.id}`,
      headers,
      payload: { phase: 'bridging-to-starknet' },
    })
    expect(rejected.statusCode).toBe(409)
    expect(seen).toEqual([{ txHash: ENTRY_TX, ethereumSender: SENDER, starknetAccount: ACCOUNT }])
    await app.close()
  })

  it('reports missing deployment configuration without pretending to be ready', async () => {
    const app = await buildServer({
      HOST: '127.0.0.1',
      PORT: 8787,
      CORS_ORIGIN: 'http://localhost:5173',
      RELAYER_ENABLED: false,
      RELAYER_DAILY_SPEND_LIMIT_GWEI: 5_000_000,
      RELAYER_MIN_BALANCE_WEI: 2_000_000_000_000_000n,
      RELAYER_MAX_GAS_PER_TRANSACTION: 800_000n,
      RELAYER_MAX_FACTORY_CREATE_GAS: 1_300_000n,
      RELAYER_GAS_LIMIT_MULTIPLIER_BPS: 12_500,
      STATE_CACHE_PORT: 6379,
      ESTIMATED_STARKNET_FEES_USDC: 2,
    })
    const response = await app.inject({ method: 'GET', url: '/v1/health/ready' })
    expect(response.statusCode).toBe(503)
    expect(response.json().missing).toContain('ETHEREUM_ENTRY_ROUTER')
    expect(response.json().missing).toContain('STARKSCAN_API_KEY')
    expect(response.json().missing).toContain('AVNU_PAYMASTER_API_KEY')
    await app.close()
  })

  it('fails closed when the Ethereum relayer switch is disabled', async () => {
    const app = await buildServer(
      { ...config, RELAYER_ENABLED: false },
      { quoteDependencies: dependencies },
    )
    const response = await app.inject({
      method: 'POST',
      url: '/v1/settlements',
      payload: {
        salt: `0x${'22'.repeat(32)}`,
        recipient: SENDER,
        outputToken: 'USDC',
        minimumOutput: '1',
        poolFee: 500,
        recoverAfter: 1,
      },
    })
    expect(response.statusCode).toBe(503)
    expect(response.json()).toEqual({ error: 'Ethereum settlement relayer is disabled' })
    await app.close()
  })

  it('keys rate limits on the trusted proxy hop, not a forged X-Forwarded-For chain', async () => {
    const app = await buildServer(config, { quoteDependencies: dependencies })
    const seen: string[] = []
    app.addHook('onRequest', async (request) => {
      seen.push(request.ip)
    })
    await app.inject({
      method: 'GET',
      url: '/v1/health/live',
      remoteAddress: '10.0.0.1',
      headers: { 'x-forwarded-for': '1.2.3.4, 203.0.113.9' },
    })
    expect(seen).toEqual(['203.0.113.9'])
    await app.close()
  })

  it('keeps the AVNU key server-side and scopes sponsorship to a flow capability', async () => {
    const { requests, fetchImpl } = recordingFetch()
    const app = await buildServer(config, {
      quoteDependencies: dependencies,
      fetchImpl,
      entryVerifier: verifiedEntry,
    })
    const payload = {
      jsonrpc: '2.0',
      id: 1,
      method: 'paymaster_buildTransaction',
      params: {
        transaction: {
          type: 'deploy_and_invoke',
          invoke: { user_address: ACCOUNT, calls: [receiveMessageCall] },
          deployment,
        },
        parameters: { version: '0x1', fee_mode: { mode: 'sponsored' } },
      },
    }

    const denied = await app.inject({ method: 'POST', url: '/proxy/paymaster', payload })
    expect(denied.statusCode).toBe(404)

    const access = await bridgingFlow(app)
    const headers = { 'x-flow-id': access.flow.id, 'x-flow-token': access.writeToken }

    const allowed = await app.inject({
      method: 'POST',
      url: '/proxy/paymaster',
      headers: { ...headers, 'x-paymaster-api-key': 'attacker-controlled' },
      payload,
    })
    expect(allowed.statusCode).toBe(200)
    expect(requests.map((r) => [r.url, r.key])).toEqual([[config.PAYMASTER_URL, config.AVNU_PAYMASTER_API_KEY]])

    const wrongTarget = structuredClone(payload)
    wrongTarget.params.transaction.invoke.calls = [{ ...receiveMessageCall, to: CHAIN.starknet.usdc }]
    expect((await app.inject({ method: 'POST', url: '/proxy/paymaster', headers, payload: wrongTarget })).statusCode).toBe(403)

    const wrongSelector = structuredClone(payload)
    wrongSelector.params.transaction.invoke.calls = [{ ...receiveMessageCall, selector: STARKNET_SELECTORS.approve }]
    expect((await app.inject({ method: 'POST', url: '/proxy/paymaster', headers, payload: wrongSelector })).statusCode).toBe(403)

    const foreignClass = structuredClone(payload)
    foreignClass.params.transaction.deployment = { ...deployment, class_hash: '0xdead' }
    expect((await app.inject({ method: 'POST', url: '/proxy/paymaster', headers, payload: foreignClass })).statusCode).toBe(403)

    const otherAccount = structuredClone(payload)
    otherAccount.params.transaction.deployment = { ...deployment, address: '0x999' }
    expect((await app.inject({ method: 'POST', url: '/proxy/paymaster', headers, payload: otherAccount })).statusCode).toBe(403)

    expect(requests).toHaveLength(1)
    await app.close()
  })

  it('validates the calls the account actually signs on paymaster_executeTransaction', async () => {
    const { requests, fetchImpl } = recordingFetch()
    const app = await buildServer(config, {
      quoteDependencies: dependencies,
      fetchImpl,
      entryVerifier: verifiedEntry,
    })
    const access = await bridgingFlow(app)
    const headers = { 'x-flow-id': access.flow.id, 'x-flow-token': access.writeToken }
    const execute = (calls: TestCall[], extra: Record<string, unknown> = {}) => ({
      jsonrpc: '2.0',
      id: 2,
      method: 'paymaster_executeTransaction',
      params: {
        transaction: {
          type: 'deploy_and_invoke',
          invoke: { user_address: ACCOUNT, typed_data: typedData(calls), signature: ['0x1', '0x2'] },
          deployment,
          ...extra,
        },
        parameters: { version: '0x1', fee_mode: { mode: 'sponsored' } },
      },
    })

    const drain = await app.inject({
      method: 'POST',
      url: '/proxy/paymaster',
      headers,
      payload: execute([
        receiveMessageCall,
        { to: CHAIN.starknet.usdc, selector: STARKNET_SELECTORS.approve, calldata: ['0xbad', '0xffff', '0x0'] },
      ]),
    })
    expect(drain.statusCode).toBe(403)

    const substituted = await app.inject({
      method: 'POST',
      url: '/proxy/paymaster',
      headers,
      payload: execute([{ to: CHAIN.starknet.usdc, selector: STARKNET_SELECTORS.approve, calldata: ['0xbad'] }]),
    })
    expect(substituted.statusCode).toBe(403)

    const wrongChain = execute([receiveMessageCall])
    ;(wrongChain.params.transaction.invoke.typed_data.domain as { chainId: string }).chainId = '0x534e5f5345504f4c4941'
    expect((await app.inject({ method: 'POST', url: '/proxy/paymaster', headers, payload: wrongChain })).statusCode).toBe(403)

    const genuine = await app.inject({ method: 'POST', url: '/proxy/paymaster', headers, payload: execute([receiveMessageCall]) })
    expect(genuine.statusCode).toBe(200)

    // A bare sponsored deployment of the flow's own account is allowed (recovery of an undeployed account).
    const deployOnly = await app.inject({
      method: 'POST',
      url: '/proxy/paymaster',
      headers,
      payload: {
        jsonrpc: '2.0',
        id: 3,
        method: 'paymaster_executeTransaction',
        params: { transaction: { type: 'deploy', deployment }, parameters: { version: '0x1', fee_mode: { mode: 'sponsored' } } },
      },
    })
    expect(deployOnly.statusCode).toBe(200)
    expect(requests).toHaveLength(2)
    await app.close()
  })

  it('pins the private deposit to the pool approve and the pool apply_actions call', async () => {
    const { requests, fetchImpl } = recordingFetch()
    const app = await buildServer(config, {
      quoteDependencies: dependencies,
      fetchImpl,
      entryVerifier: verifiedEntry,
    })
    const access = await bridgingFlow(app)
    const headers = { 'x-flow-id': access.flow.id, 'x-flow-token': access.writeToken }
    for (const phase of ['starknet-funded', 'pool-depositing']) {
      const transition = await app.inject({
        method: 'PATCH',
        url: `/v1/flows/${access.flow.id}`,
        headers: { 'x-flow-token': access.writeToken },
        payload: { phase, ...(phase === 'starknet-funded' ? { txHash: '0xabc' } : {}) },
      })
      expect(transition.statusCode).toBe(200)
    }
    const feeMode = { mode: 'sponsored_private', pool_fee_token: CHAIN.starknet.usdc, tip: 'normal' }
    const approve: TestCall = {
      to: CHAIN.starknet.usdc,
      selector: STARKNET_SELECTORS.approve,
      calldata: [CHAIN.starknet.privacyPool, '0x64', '0x0'],
    }
    const applyActions: TestCall = {
      to: CHAIN.starknet.privacyPool,
      selector: STARKNET_SELECTORS.apply_actions,
      calldata: ['0x1'],
    }
    const execute = (calls: TestCall[], applyActionsCall: TestCall) => ({
      jsonrpc: '2.0',
      id: 4,
      method: 'paymaster_executeTransaction',
      params: {
        transaction: {
          type: 'invoke_and_apply_action',
          invoke: { user_address: ACCOUNT, typed_data: typedData(calls), signature: ['0x1', '0x2'] },
          apply_action: { apply_actions_call: applyActionsCall, proof: 'p', proof_facts: ['0x1'] },
        },
        parameters: { version: '0x1', fee_mode: feeMode },
      },
    })

    expect((await app.inject({ method: 'POST', url: '/proxy/paymaster', headers, payload: execute([approve], applyActions) })).statusCode).toBe(200)
    const transferInstead = { ...approve, selector: '0x83afd3f4caedc6eebf44246fe54e38c95e3179a5ec9ea81740eca5b482d12e' }
    expect((await app.inject({ method: 'POST', url: '/proxy/paymaster', headers, payload: execute([transferInstead], applyActions) })).statusCode).toBe(403)
    const foreignSpender = { ...approve, calldata: ['0xbad', '0x64', '0x0'] }
    expect((await app.inject({ method: 'POST', url: '/proxy/paymaster', headers, payload: execute([foreignSpender], applyActions) })).statusCode).toBe(403)
    const foreignPool = { ...applyActions, to: '0xbad' }
    expect((await app.inject({ method: 'POST', url: '/proxy/paymaster', headers, payload: execute([approve], foreignPool) })).statusCode).toBe(403)
    expect(requests).toHaveLength(1)
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
