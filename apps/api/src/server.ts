import cors from '@fastify/cors'
import rateLimit from '@fastify/rate-limit'
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify'
import {
  CHAIN,
  createFlowSchema,
  flowUpdateSchema,
  quoteRequestSchema,
  type PublicConfig,
} from '@privacy-round-trip/shared'
import { z } from 'zod'
import {
  createPublicClient,
  createWalletClient,
  http,
  type Address,
  type Hex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { mainnet } from 'viem/chains'
import { randomBytes } from 'node:crypto'
import type { ApiConfig } from './config.js'
import { readiness } from './config.js'
import { FlowStore } from './flowStore.js'
import { liveQuoteDependencies, QuoteService, type QuoteDependencies } from './quote.js'
import { MemoryStateStore, ValkeyStateStore, type StateStore } from './stateStore.js'

const hashParam = z.object({ txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/) })
const settlementRequest = z
  .object({
    salt: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
    recipient: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
    outputToken: z.enum(['ETH', 'USDC', 'WBTC']),
    minimumOutput: z.string().regex(/^\d+$/),
    poolFee: z.union([z.literal(100), z.literal(500), z.literal(3_000), z.literal(10_000)]),
    recoverAfter: z.number().int().positive(),
  })
  .strict()
const settlementParam = z.object({ address: z.string().regex(/^0x[0-9a-fA-F]{40}$/) })

const SETTLEMENT_FACTORY_ABI = [
  {
    type: 'function',
    name: 'predict',
    stateMutability: 'view',
    inputs: [
      { name: 'salt', type: 'bytes32' },
      { name: 'recipient', type: 'address' },
      { name: 'outputAsset', type: 'uint8' },
      { name: 'minimumOutput', type: 'uint256' },
      { name: 'poolFee', type: 'uint24' },
      { name: 'recoverAfter', type: 'uint64' },
    ],
    outputs: [{ name: 'settlement', type: 'address' }],
  },
  {
    type: 'function',
    name: 'create',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'salt', type: 'bytes32' },
      { name: 'recipient', type: 'address' },
      { name: 'outputAsset', type: 'uint8' },
      { name: 'minimumOutput', type: 'uint256' },
      { name: 'poolFee', type: 'uint24' },
      { name: 'recoverAfter', type: 'uint64' },
    ],
    outputs: [{ name: 'settlement', type: 'address' }],
  },
] as const

const EXIT_SETTLEMENT_ABI = [
  {
    type: 'function',
    name: 'settle',
    stateMutability: 'nonpayable',
    inputs: [],
    outputs: [{ name: 'output', type: 'uint256' }],
  },
] as const

export interface ServerOverrides {
  quoteDependencies?: QuoteDependencies
  fetchImpl?: typeof fetch
  stateStore?: StateStore
}

export async function buildServer(config: ApiConfig, overrides: ServerOverrides = {}) {
  const app = Fastify({
    logger: process.env.NODE_ENV === 'production' ? { level: 'info' } : false,
    bodyLimit: 2 * 1024 * 1024,
    trustProxy: (_address, hop) => hop <= 1,
  })
  await app.register(cors, { origin: config.CORS_ORIGIN, methods: ['GET', 'POST', 'PATCH'] })
  await app.register(rateLimit, { global: true, max: 120, timeWindow: '1 minute' })

  const stateStore = overrides.stateStore ?? buildStateStore(config)
  const flowStore = new FlowStore(config.FLOW_TOKEN_SECRET ?? randomBytes(32).toString('hex'), stateStore)
  const dependencies =
    overrides.quoteDependencies ??
    (config.ETHEREUM_RPC_URL ? liveQuoteDependencies(config.ETHEREUM_RPC_URL) : undefined)
  const quoteService = dependencies
    ? new QuoteService(
        dependencies,
        BigInt(Math.ceil(config.ESTIMATED_STARKNET_FEES_USDC * 1e6)),
        stateStore,
      )
    : undefined
  const fetchImpl = overrides.fetchImpl ?? fetch

  app.addHook('onClose', async () => stateStore.close())

  app.get('/v1/health/live', { config: { rateLimit: false } }, async () => ({ status: 'ok', environment: 'mainnet' }))
  app.get('/v1/health/ready', { config: { rateLimit: false } }, async (_, reply) => {
    const missing = readiness(config)
    try {
      await stateStore.ping()
    } catch {
      missing.push('STATE_CACHE_CONNECTION')
    }
    return reply.code(missing.length === 0 ? 200 : 503).send({ ready: missing.length === 0, missing })
  })

  app.get('/v1/config', async (): Promise<PublicConfig> => {
    const missing = readiness(config)
    return {
      environment: 'mainnet',
      ready: missing.length === 0,
      missing,
      ethereum: {
        ...(config.ETHEREUM_ENTRY_ROUTER ? { entryRouter: config.ETHEREUM_ENTRY_ROUTER } : {}),
        ...(config.ETHEREUM_EXIT_SETTLEMENT_FACTORY
          ? { exitSettlementFactory: config.ETHEREUM_EXIT_SETTLEMENT_FACTORY }
          : {}),
        tokens: {
          ETH: CHAIN.ethereum.tokens.ETH,
          USDC: CHAIN.ethereum.tokens.USDC,
          WBTC: CHAIN.ethereum.tokens.WBTC,
        },
        tokenMessengerV2: CHAIN.ethereum.cctp.tokenMessengerV2,
      },
      starknet: {
        privacyPool: CHAIN.starknet.privacyPool,
        ...(config.STARKNET_CCTP_EXIT_ANONYMIZER
          ? { cctpExitAnonymizer: config.STARKNET_CCTP_EXIT_ANONYMIZER }
          : {}),
        usdc: CHAIN.starknet.usdc,
      },
    }
  })

  app.post('/v1/quotes', async (request, reply) => {
    if (!quoteService) return reply.code(503).send({ error: 'Ethereum quote service is not configured' })
    const parsed = quoteRequestSchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() })
    try {
      return await quoteService.create(parsed.data)
    } catch (error) {
      return reply.code(502).send({ error: safeError(error) })
    }
  })

  app.post('/v1/flows', async (request, reply) => {
    if (!quoteService) return reply.code(503).send({ error: 'Quote service is not configured' })
    const parsed = createFlowSchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() })
    const quote = await quoteService.get(parsed.data.quoteId)
    if (!quote) return reply.code(409).send({ error: 'Quote expired; request a new quote' })
    return reply.code(201).send(await flowStore.create({ quote, ...parsed.data }))
  })

  app.get<{ Params: { id: string } }>('/v1/flows/:id', async (request, reply) => {
    const token = flowToken(request.headers['x-flow-token'])
    const flow = token ? await flowStore.read(request.params.id, token) : undefined
    return flow ? flow : reply.code(404).send({ error: 'Flow not found' })
  })

  app.patch<{ Params: { id: string } }>('/v1/flows/:id', async (request, reply) => {
    const token = flowToken(request.headers['x-flow-token'])
    const parsed = flowUpdateSchema.safeParse(request.body)
    if (!token || !parsed.success) return reply.code(400).send({ error: 'Invalid update' })
    try {
      const flow = await flowStore.update(request.params.id, token, parsed.data)
      return flow ? flow : reply.code(404).send({ error: 'Flow not found' })
    } catch (error) {
      return reply.code(409).send({ error: safeError(error) })
    }
  })

  app.get('/v1/cctp/messages/:txHash', async (request, reply) => {
    const parsed = hashParam.safeParse(request.params)
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid transaction hash' })
    const response = await fetchImpl(
      `https://iris-api.circle.com/v2/messages/0?transactionHash=${parsed.data.txHash}`,
      { signal: AbortSignal.timeout(15_000) },
    )
    const body = await response.json().catch(() => ({ error: 'Circle returned malformed JSON' }))
    return reply.code(response.status).send(body)
  })

  // This endpoint deliberately does not accept a flow id and does not persist the request. The
  // backend sees the recipient transiently while sponsoring deployment, but cannot join it to a
  // stored entry record through this API.
  app.post('/v1/settlements', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (request, reply) => {
    const parsed = settlementRequest.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() })
    if (
      !config.ETHEREUM_RPC_URL ||
      !config.ETHEREUM_RELAYER_PRIVATE_KEY ||
      !config.ETHEREUM_EXIT_SETTLEMENT_FACTORY
    ) {
      return reply.code(503).send({ error: 'Ethereum settlement relayer is not configured' })
    }
    const outputAsset = { ETH: 0, USDC: 1, WBTC: 2 }[parsed.data.outputToken]
    const args = [
      parsed.data.salt as Hex,
      parsed.data.recipient as Address,
      outputAsset,
      BigInt(parsed.data.minimumOutput),
      parsed.data.poolFee,
      BigInt(parsed.data.recoverAfter),
    ] as const
    try {
      const publicClient = createPublicClient({ chain: mainnet, transport: http(config.ETHEREUM_RPC_URL) })
      const account = privateKeyToAccount(config.ETHEREUM_RELAYER_PRIVATE_KEY as Hex)
      const wallet = createWalletClient({ account, chain: mainnet, transport: http(config.ETHEREUM_RPC_URL) })
      const factory = config.ETHEREUM_EXIT_SETTLEMENT_FACTORY as Address
      const settlement = await publicClient.readContract({
        address: factory,
        abi: SETTLEMENT_FACTORY_ABI,
        functionName: 'predict',
        args,
      })
      const { request: transaction } = await publicClient.simulateContract({
        account,
        address: factory,
        abi: SETTLEMENT_FACTORY_ABI,
        functionName: 'create',
        args,
      })
      const txHash = await wallet.writeContract(transaction)
      return reply.code(202).send({ settlement, txHash })
    } catch (error) {
      return reply.code(502).send({ error: safeError(error) })
    }
  })

  // Settlement is permissionless. Relaying it avoids a third wallet prompt and is intentionally
  // stateless: the request contains only the already-public settlement address.
  app.post<{ Params: { address: string } }>(
    '/v1/settlements/:address/settle',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
    const parsed = settlementParam.safeParse(request.params)
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid settlement address' })
    if (!config.ETHEREUM_RPC_URL || !config.ETHEREUM_RELAYER_PRIVATE_KEY) {
      return reply.code(503).send({ error: 'Ethereum settlement relayer is not configured' })
    }
    try {
      const publicClient = createPublicClient({ chain: mainnet, transport: http(config.ETHEREUM_RPC_URL) })
      const account = privateKeyToAccount(config.ETHEREUM_RELAYER_PRIVATE_KEY as Hex)
      const wallet = createWalletClient({ account, chain: mainnet, transport: http(config.ETHEREUM_RPC_URL) })
      const { request: transaction } = await publicClient.simulateContract({
        account,
        address: parsed.data.address as Address,
        abi: EXIT_SETTLEMENT_ABI,
        functionName: 'settle',
      })
      const txHash = await wallet.writeContract(transaction)
      return reply.code(202).send({ txHash })
    } catch (error) {
      return reply.code(502).send({ error: safeError(error) })
    }
    },
  )

  registerOpaqueProxy(app, '/proxy/prover', config.PROVER_URL, fetchImpl)
  registerOpaqueProxy(app, '/proxy/discovery', config.DISCOVERY_URL, fetchImpl)
  registerOpaqueProxy(app, '/proxy/paymaster', config.PAYMASTER_URL, fetchImpl)
  registerOpaqueProxy(app, '/proxy/starknet-rpc', config.STARKNET_RPC_URL, fetchImpl)

  return app
}

function buildStateStore(config: ApiConfig): StateStore {
  if (!config.STATE_CACHE_ENDPOINT || !config.STATE_CACHE_USERNAME || !config.STATE_CACHE_PASSWORD) {
    return new MemoryStateStore()
  }
  return new ValkeyStateStore({
    host: config.STATE_CACHE_ENDPOINT,
    port: config.STATE_CACHE_PORT,
    username: config.STATE_CACHE_USERNAME,
    password: config.STATE_CACHE_PASSWORD,
  })
}

function registerOpaqueProxy(
  app: ReturnType<typeof Fastify>,
  path: string,
  upstream: string | undefined,
  fetchImpl: typeof fetch,
) {
  const handler = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!upstream) return reply.code(503).send({ error: `${path} is not configured` })
    const requestUrl = request.raw.url ?? path
    const suffix = requestUrl.startsWith(path) ? requestUrl.slice(path.length) : ''
    const target = `${upstream.replace(/\/$/, '')}${suffix}`
    const method = request.method.toUpperCase()
    const response = await fetchImpl(target, {
      method,
      headers: {
        'content-type': request.headers['content-type'] ?? 'application/json',
        accept: request.headers.accept ?? 'application/json',
      },
      ...(method === 'GET' || method === 'HEAD' ? {} : { body: JSON.stringify(request.body) }),
      signal: AbortSignal.timeout(60_000),
    })
    const body = await response.arrayBuffer()
    return reply
      .code(response.status)
      .header('content-type', response.headers.get('content-type') ?? 'application/json')
      .send(Buffer.from(body))
  }
  app.all(path, handler)
  app.all(`${path}/*`, handler)
}

function flowToken(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' && value.length >= 32 ? value : undefined
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error'
}
