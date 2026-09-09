import { describe, expect, it } from 'vitest'
import { CHAIN, OUTSIDE_EXECUTION_TYPES, STARKNET_SELECTORS } from '@privacy-round-trip/shared'
import { encodeAbiParameters, encodeEventTopics, keccak256, stringToHex, type Hex } from 'viem'
import { buildServer, matchEntryEvent, type EntryVerifier } from './server.js'
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

/** Records which flow each entry burn was started for, the way the router event would. */
function burnRegistry() {
  const burns = new Map<string, Hex>()
  const verifier: EntryVerifier = async ({ txHash }) => {
    const flowId = burns.get(txHash.toLowerCase())
    return flowId ? { flowId } : undefined
  }
  return {
    verifier,
    register: (txHash: string, flowId: string) => burns.set(txHash.toLowerCase(), keccak256(stringToHex(flowId))),
  }
}
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
    types: OUTSIDE_EXECUTION_TYPES['2'],
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

async function bridgingFlow(app: Awaited<ReturnType<typeof buildServer>>, registry: ReturnType<typeof burnRegistry>) {
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
  registry.register(ENTRY_TX, access.flow.id)
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
    const registry = burnRegistry()
    const app = await buildServer(config, { quoteDependencies: dependencies, entryVerifier: registry.verifier })
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

    registry.register(`0x${'44'.repeat(32)}`, created.flow.id)
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
        return undefined
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

  it('binds an entry burn to the flow it names and lets only that flow\'s capability hand it over', async () => {
    const registry = burnRegistry()
    const app = await buildServer(config, { quoteDependencies: dependencies, entryVerifier: registry.verifier })
    const open = async () => {
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
      const access = created.json() as { flow: { id: string }; writeToken: string }
      await app.inject({
        method: 'PATCH',
        url: `/v1/flows/${access.flow.id}`,
        headers: { 'x-flow-token': access.writeToken },
        payload: { phase: 'entry-submitted', txHash: ENTRY_TX },
      })
      return access
    }
    const patch = (access: { flow: { id: string }; writeToken: string }, payload: Record<string, unknown>) =>
      app.inject({
        method: 'PATCH',
        url: `/v1/flows/${access.flow.id}`,
        headers: { 'x-flow-token': access.writeToken },
        payload,
      })

    const first = await open()
    registry.register(ENTRY_TX, first.flow.id)
    const stranger = await open()
    // A stranger who copied the public sender/account from the mempool is not the flow the burn names.
    const strangerFirst = await patch(stranger, { phase: 'bridging-to-starknet' })
    expect(strangerFirst.statusCode).toBe(403)
    expect(strangerFirst.json().error).toMatch(/different flow/)
    expect((await patch(first, { phase: 'bridging-to-starknet' })).statusCode).toBe(200)
    // Nor can the stranger get in later, with or without a forged release.
    expect((await patch(stranger, { phase: 'bridging-to-starknet' })).statusCode).toBe(403)
    expect(
      (await patch(stranger, { phase: 'bridging-to-starknet', release: { flowId: first.flow.id, token: 'x'.repeat(43) } })).statusCode,
    ).toBe(403)
    // The holder keeps its claim: the lifecycle rejects the duplicate transition, the next one works.
    const duplicate = await patch(first, { phase: 'bridging-to-starknet' })
    expect(duplicate.statusCode).toBe(409)
    expect(duplicate.json().error).toMatch(/Invalid flow transition/)
    expect((await patch(first, { phase: 'starknet-funded', txHash: '0xabc' })).statusCode).toBe(200)

    // Recovery flows present the stopped flow's own capability. Exactly one of two racing takes over,
    // and the stopped flow is retired even though it never wrote its own failed marker.
    const release = { flowId: first.flow.id, token: first.writeToken }
    const recoveryA = await open()
    const recoveryB = await open()
    const raced = await Promise.all([
      patch(recoveryA, { phase: 'bridging-to-starknet', release }),
      patch(recoveryB, { phase: 'bridging-to-starknet', release }),
    ])
    expect(raced.map((response) => response.statusCode).sort()).toEqual([200, 409])
    const retired = await app.inject({ method: 'GET', url: `/v1/flows/${first.flow.id}`, headers: { 'x-flow-token': first.writeToken } })
    expect(retired.json().phase).toBe('failed')
    // While the winner is live, a further recovery attempt with the same capability is refused.
    const recoveryC = await open()
    expect((await patch(recoveryC, { phase: 'bridging-to-starknet', release })).statusCode).toBe(409)
    // A release for a flow the burn does not name is worthless even with a valid token.
    expect(
      (await patch(recoveryC, { phase: 'bridging-to-starknet', release: { flowId: stranger.flow.id, token: stranger.writeToken } })).statusCode,
    ).toBe(403)
    await app.close()
  })

  it('matches the router event by address, sender, recipient and returns its flow id', () => {
    const router = config.ETHEREUM_ENTRY_ROUTER as `0x${string}`
    const flowId = keccak256(stringToHex('f_' + 'a'.repeat(32)))
    const abi = [
      {
        type: 'event',
        name: 'EntryStarted',
        inputs: [
          { name: 'flowId', type: 'bytes32', indexed: true },
          { name: 'sender', type: 'address', indexed: true },
          { name: 'inputAsset', type: 'uint8', indexed: true },
          { name: 'inputAmount', type: 'uint256', indexed: false },
          { name: 'usdcBurned', type: 'uint256', indexed: false },
          { name: 'starknetRecipient', type: 'uint256', indexed: false },
        ],
      },
    ] as const
    const log = (address: `0x${string}`, sender: `0x${string}`, recipient: bigint) => ({
      address,
      topics: encodeEventTopics({ abi, eventName: 'EntryStarted', args: { flowId, sender, inputAsset: 0 } }),
      data: encodeAbiParameters(
        [{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }],
        [10n ** 16n, 25_000_000n, recipient],
      ),
    })
    const receipt = (logs: ReturnType<typeof log>[], status = 'success') => ({ status, logs: logs as never })

    expect(matchEntryEvent(receipt([log(router, SENDER, BigInt(ACCOUNT))]), router, SENDER, ACCOUNT)).toEqual({ flowId })
    // Case-insensitive address and sender, felt-normalised recipient.
    expect(matchEntryEvent(receipt([log(router, SENDER, BigInt(ACCOUNT))]), router.toLowerCase() as `0x${string}`, SENDER.toUpperCase().replace('0X', '0x'), '0x0456')).toEqual({ flowId })
    // Wrong emitter, sender, or recipient, or a reverted receipt: no match.
    expect(matchEntryEvent(receipt([log('0x9999999999999999999999999999999999999999', SENDER, BigInt(ACCOUNT))]), router, SENDER, ACCOUNT)).toBeUndefined()
    expect(matchEntryEvent(receipt([log(router, '0x4444444444444444444444444444444444444444', BigInt(ACCOUNT))]), router, SENDER, ACCOUNT)).toBeUndefined()
    expect(matchEntryEvent(receipt([log(router, SENDER, 0x999n)]), router, SENDER, ACCOUNT)).toBeUndefined()
    expect(matchEntryEvent(receipt([log(router, SENDER, BigInt(ACCOUNT))], 'reverted'), router, SENDER, ACCOUNT)).toBeUndefined()
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
    const registry = burnRegistry()
    const app = await buildServer(config, {
      quoteDependencies: dependencies,
      fetchImpl,
      entryVerifier: registry.verifier,
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

    const access = await bridgingFlow(app, registry)
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
    const registry = burnRegistry()
    const app = await buildServer(config, {
      quoteDependencies: dependencies,
      fetchImpl,
      entryVerifier: registry.verifier,
    })
    const access = await bridgingFlow(app, registry)
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

    // A benign `Calls` next to a malicious lowercase `calls` (the array a v1 schema would hash).
    const mixed = execute([receiveMessageCall])
    ;(mixed.params.transaction.invoke.typed_data.message as Record<string, unknown>).calls = [
      { to: CHAIN.starknet.usdc, selector: STARKNET_SELECTORS.approve, calldata_len: 1, calldata: ['0xbad'] },
    ]
    expect((await app.inject({ method: 'POST', url: '/proxy/paymaster', headers, payload: mixed })).statusCode).toBe(403)

    // Non-canonical types could move the signed calls elsewhere; refuse them outright.
    const foreignTypes = execute([receiveMessageCall])
    ;(foreignTypes.params.transaction.invoke.typed_data as Record<string, unknown>).types = {}
    expect((await app.inject({ method: 'POST', url: '/proxy/paymaster', headers, payload: foreignTypes })).statusCode).toBe(403)

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
    const registry = burnRegistry()
    const app = await buildServer(config, {
      quoteDependencies: dependencies,
      fetchImpl,
      entryVerifier: registry.verifier,
    })
    const access = await bridgingFlow(app, registry)
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
