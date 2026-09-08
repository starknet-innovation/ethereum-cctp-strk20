import cors from '@fastify/cors'
import rateLimit from '@fastify/rate-limit'
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify'
import {
  CHAIN,
  STARKNET_SELECTORS,
  createFlowSchema,
  feltEquals,
  flowUpdateSchema,
  quoteRequestSchema,
  type ProofRelayJob,
  type ProofRelaySubmission,
  type PublicConfig,
  type PublicFlow,
} from '@privacy-round-trip/shared'
import { z } from 'zod'
import {
  createPublicClient,
  createWalletClient,
  http,
  parseEventLogs,
  type Address,
  type Hex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { mainnet } from 'viem/chains'
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { ApiConfig } from './config.js'
import { readiness } from './config.js'
import { FlowStore } from './flowStore.js'
import { liveQuoteDependencies, QuoteService, type QuoteDependencies } from './quote.js'
import { MemoryStateStore, ValkeyStateStore, type StateStore } from './stateStore.js'
import {
  RelayerGuardError,
  relayerMetricEvent,
  reserveRelayerSpend,
  type RelayerMetric,
} from './relayerGuard.js'

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
const proofJobParam = z.object({ jobId: z.string().regex(/^prv_[A-Za-z0-9_-]{8,128}$/) })
const proofPollTokenSchema = z.string().regex(/^[0-9a-f]{64}$/)
const proofIdempotencyKeySchema = z.string().regex(/^[\x21\x23-\x7e]{16,128}$/)
const flowIdSchema = z.string().regex(/^f_[0-9a-f]{32}$/)
const paymasterRequestSchema = z
  .object({
    jsonrpc: z.literal('2.0'),
    id: z.union([z.string(), z.number(), z.null()]).optional(),
    method: z.enum(['paymaster_buildTransaction', 'paymaster_executeTransaction']),
    params: z.record(z.unknown()),
  })
  .passthrough()
const proofResultSchema = z
  .object({
    proof: z.string().min(1),
    proof_facts: z.array(z.string()),
    l2_to_l1_messages: z.array(
      z
        .object({
          from_address: z.string(),
          to_address: z.string(),
          payload: z.array(z.string()),
        })
        .passthrough(),
    ),
    additional_data: z
      .object({
        signature: z
          .object({ issued_at: z.number().int(), sig_r: z.string(), sig_s: z.string() })
          .strict()
          .optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough()
const proofRequestSchema = z
  .object({
    block_id: z.object({ block_number: z.number().int().nonnegative() }).strict(),
    transaction: z.object({ type: z.literal('INVOKE') }).passthrough(),
  })
  .strict()
const proofJobSchema = z
  .object({
    jobId: z.string(),
    status: z.enum([
      'queued',
      'dispatched',
      'succeeded',
      'failed',
      'unavailable',
      'unknown_delivery',
    ]),
    terminal: z.boolean(),
    attemptCount: z.number().int().nonnegative().optional(),
    queuePosition: z.number().int().nonnegative().optional(),
    pollAfterSeconds: z.number().nonnegative().optional(),
    createdAt: z.string().optional(),
    completedAt: z.string().optional(),
    result: proofResultSchema.optional(),
    error: z
      .object({
        code: z.union([z.string(), z.number()]).optional(),
        message: z.string().optional(),
        data: z.unknown().optional(),
        source: z.string().optional(),
      })
      .passthrough()
      .optional(),
    resultUnavailableReason: z.string().optional(),
  })
  .passthrough()

const STARKSCAN_PROVE_URL = 'https://api.starkscan.co/v1/SN_MAIN/prove'
const MAX_PROOF_REQUEST_BYTES = 1024 * 1024
const PROOF_RESULT_TTL_SECONDS = 60 * 60

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

const ENTRY_ROUTER_ABI = [
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

/**
 * Confirms that an Ethereum transaction is a successful `PrivacyEntryRouter.start` whose CCTP burn
 * names the flow's Starknet account and was sent by the flow's Ethereum sender.
 */
export type EntryVerifier = (args: {
  txHash: string
  ethereumSender: string
  starknetAccount: string
}) => Promise<boolean>

export interface ServerOverrides {
  quoteDependencies?: QuoteDependencies
  fetchImpl?: typeof fetch
  stateStore?: StateStore
  entryVerifier?: EntryVerifier
}

export async function buildServer(config: ApiConfig, overrides: ServerOverrides = {}) {
  const app = Fastify({
    logger: process.env.NODE_ENV === 'production' ? { level: 'info' } : false,
    bodyLimit: 2 * 1024 * 1024,
    // Exactly one trusted hop (hop 0 is the socket peer, the managed ALB). Trusting hop 1 as well
    // let a client forge X-Forwarded-For and pick its own rate-limit key.
    trustProxy: (_address, hop) => hop < 1,
  })
  await app.register(cors, { origin: config.CORS_ORIGIN, methods: ['GET', 'POST', 'PATCH'] })
  await app.register(rateLimit, { global: true, max: 120, timeWindow: '1 minute' })

  const stateStore = overrides.stateStore ?? buildStateStore(config)
  const capabilitySecret = config.FLOW_TOKEN_SECRET ?? randomBytes(32).toString('hex')
  const flowStore = new FlowStore(capabilitySecret, stateStore)
  const proofResultFallback = new Map<string, { value: string; expiresAt: number }>()
  const proofPolls = new Map<string, Promise<ProofRelayJob>>()
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
  const entryVerifier =
    overrides.entryVerifier ??
    (config.ETHEREUM_RPC_URL && config.ETHEREUM_ENTRY_ROUTER
      ? liveEntryVerifier(config.ETHEREUM_RPC_URL, config.ETHEREUM_ENTRY_ROUTER as Address)
      : undefined)
  let relayerSubmissionActive = false

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
    if (parsed.data.phase === 'bridging-to-starknet') {
      // Operator-paid AVNU sponsorship opens in this phase. Tie it to a confirmed entry burn through
      // the POC router so a self-asserted phase cannot spend operator credit.
      if (!entryVerifier) return reply.code(503).send({ error: 'Entry verification is not configured' })
      const current = await flowStore.read(request.params.id, token)
      if (!current) return reply.code(404).send({ error: 'Flow not found' })
      if (!current.entryTxHash || !(await verifiedEntry(entryVerifier, current))) {
        return reply.code(409).send({ error: 'Entry transaction could not be verified on Ethereum' })
      }
      // One live flow per burn. The verified sender/account match alone would let a single burn
      // open sponsorship for any number of flows; recovery legitimately reuses a burn, but only
      // once the flow that previously held it has failed.
      if (!(await claimEntryBurn(flowStore, stateStore, current))) {
        return reply.code(409).send({ error: 'Entry transaction is already in use by an active flow' })
      }
    }
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

  app.post(
    '/v1/proofs',
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (request, reply) => {
      if (!config.STARKSCAN_API_KEY) {
        return reply.code(503).send({ error: 'Starkscan proof relay is not configured' })
      }
      const idempotencyKey = singleHeader(request.headers['idempotency-key'])
      if (!proofIdempotencyKeySchema.safeParse(idempotencyKey).success) {
        return reply.code(400).send({ error: 'A valid Idempotency-Key header is required' })
      }
      const parsed = proofRequestSchema.safeParse(request.body)
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() })
      if (Buffer.byteLength(JSON.stringify(parsed.data)) > MAX_PROOF_REQUEST_BYTES) {
        return reply.code(413).send({ error: 'Proof request exceeds Starkscan\'s 1 MiB limit' })
      }

      try {
        const response = await fetchImpl(STARKSCAN_PROVE_URL, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-starkscan-api-key': config.STARKSCAN_API_KEY,
            'idempotency-key': idempotencyKey!,
          },
          body: JSON.stringify(parsed.data),
          signal: AbortSignal.timeout(30_000),
        })
        const body = await response.json().catch(() => undefined)
        if (response.status === 404) {
          return reply.code(503).send({
            error: 'Starkscan STRK20 proof relay is not enabled yet; its documented dormant state returns 404',
          })
        }
        if (!response.ok) return forwardStarkscanError(reply, response, body)
        const job = proofJobSchema.safeParse(body)
        if (!job.success) return reply.code(502).send({ error: 'Starkscan returned an invalid proof job' })
        if (job.data.terminal) {
          await persistProofJob(
            job.data as ProofRelayJob,
            stateStore,
            proofResultFallback,
          )
        }
        const submission: ProofRelaySubmission = {
          ...(job.data as ProofRelayJob),
          pollToken: proofPollToken(capabilitySecret, job.data.jobId),
        }
        return reply.code(response.status).send(submission)
      } catch (error) {
        return reply.code(502).send({ error: `Starkscan proof submission failed: ${safeError(error)}` })
      }
    },
  )

  app.get<{ Params: { jobId: string } }>(
    '/v1/proofs/:jobId',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request, reply) => {
      if (!config.STARKSCAN_API_KEY) {
        return reply.code(503).send({ error: 'Starkscan proof relay is not configured' })
      }
      const parsed = proofJobParam.safeParse(request.params)
      const pollToken = singleHeader(request.headers['x-proof-token'])
      if (
        !parsed.success ||
        !proofPollTokenSchema.safeParse(pollToken).success ||
        !secureEqual(pollToken!, proofPollToken(capabilitySecret, parsed.data.jobId))
      ) {
        return reply.code(404).send({ error: 'Proof job not found' })
      }

      try {
        const job = await getProofJob({
          jobId: parsed.data.jobId,
          apiKey: config.STARKSCAN_API_KEY,
          fetchImpl,
          stateStore,
          fallback: proofResultFallback,
          inFlight: proofPolls,
        })
        return reply.send(job)
      } catch (error) {
        if (error instanceof StarkscanHttpError) {
          if (error.status === 404) {
            return reply.code(503).send({
              error: 'Starkscan STRK20 proof relay is not enabled yet; its documented dormant state returns 404',
            })
          }
          return reply
            .code(upstreamStatus(error.status))
            .headers(error.retryAfter ? { 'retry-after': error.retryAfter } : {})
            .send(error.body ?? { error: 'Starkscan proof polling failed' })
        }
        return reply.code(502).send({ error: `Starkscan proof polling failed: ${safeError(error)}` })
      }
    },
  )

  // This endpoint deliberately does not accept a flow id and does not persist the request. The
  // backend sees the recipient transiently while sponsoring deployment, but cannot join it to a
  // stored entry record through this API.
  app.post(
    '/v1/settlements',
    { config: { rateLimit: { max: 3, timeWindow: '10 minutes' } } },
    async (request, reply) => {
      const parsed = settlementRequest.safeParse(request.body)
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() })
      if (
        !config.ETHEREUM_RPC_URL ||
        !config.ETHEREUM_RELAYER_PRIVATE_KEY ||
        !config.ETHEREUM_EXIT_SETTLEMENT_FACTORY
      ) {
        return reply.code(503).send({ error: 'Ethereum settlement relayer is not configured' })
      }
      if (!config.RELAYER_ENABLED) {
        return reply.code(503).send({ error: 'Ethereum settlement relayer is disabled' })
      }
      if (relayerSubmissionActive) {
        return reply.code(429).send({ error: 'Ethereum settlement relayer is busy; retry shortly' })
      }
      relayerSubmissionActive = true
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
        const publicClient = createPublicClient({
          chain: mainnet,
          transport: http(config.ETHEREUM_RPC_URL),
        })
        const account = privateKeyToAccount(config.ETHEREUM_RELAYER_PRIVATE_KEY as Hex)
        const wallet = createWalletClient({
          account,
          chain: mainnet,
          transport: http(config.ETHEREUM_RPC_URL),
        })
        const factory = config.ETHEREUM_EXIT_SETTLEMENT_FACTORY as Address
        const settlement = await publicClient.readContract({
          address: factory,
          abi: SETTLEMENT_FACTORY_ABI,
          functionName: 'predict',
          args,
        })
        await publicClient.simulateContract({
          account,
          address: factory,
          abi: SETTLEMENT_FACTORY_ABI,
          functionName: 'create',
          args,
        })
        const emitMetric = metricEmitter(request)
        const reservation = await reserveRelayerSpend({
          config,
          stateStore,
          estimateGas: () =>
            publicClient.estimateContractGas({
              account,
              address: factory,
              abi: SETTLEMENT_FACTORY_ABI,
              functionName: 'create',
              args,
            }),
          estimateFeesPerGas: async () => {
            const fees = await publicClient.estimateFeesPerGas()
            return {
              maxFeePerGas: fees.maxFeePerGas,
              maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
            }
          },
          getBalance: () => publicClient.getBalance({ address: account.address }),
          emitMetric,
          // Deploying the immutable settlement bytecode costs ~898k gas on mainnet before the
          // standard 25% margin. Only this schema-checked factory call receives the higher cap.
          maxGasPerTransaction: config.RELAYER_MAX_FACTORY_CREATE_GAS,
        })
        let txHash: Hex
        try {
          txHash = await wallet.writeContract({
            account,
            chain: mainnet,
            address: factory,
            abi: SETTLEMENT_FACTORY_ABI,
            functionName: 'create',
            args,
            type: 'eip1559',
            gas: reservation.gasLimit,
            maxFeePerGas: reservation.maxFeePerGas,
            maxPriorityFeePerGas: reservation.maxPriorityFeePerGas,
          })
        } catch (error) {
          emitMetric('RelayerSubmissionUnknown', 1, { operation: 'create-settlement' })
          throw error
        }
        emitMetric('RelayerSubmissionAccepted', 1, {
          operation: 'create-settlement',
          reservedGwei: reservation.maxCostGwei,
          dailyBudgetUsedGwei: reservation.budgetUsedGwei,
        })
        return reply.code(202).send({ settlement, txHash })
      } catch (error) {
        if (error instanceof RelayerGuardError) {
          return reply.code(error.statusCode).send({ error: error.message })
        }
        return reply.code(502).send({ error: safeError(error) })
      } finally {
        relayerSubmissionActive = false
      }
    },
  )

  // Settlement is permissionless. Relaying it avoids a third wallet prompt and is intentionally
  // stateless: the request contains only the already-public settlement address.
  app.post<{ Params: { address: string } }>(
    '/v1/settlements/:address/settle',
    { config: { rateLimit: { max: 6, timeWindow: '10 minutes' } } },
    async (request, reply) => {
      const parsed = settlementParam.safeParse(request.params)
      if (!parsed.success) return reply.code(400).send({ error: 'Invalid settlement address' })
      if (!config.ETHEREUM_RPC_URL || !config.ETHEREUM_RELAYER_PRIVATE_KEY) {
        return reply.code(503).send({ error: 'Ethereum settlement relayer is not configured' })
      }
      if (!config.RELAYER_ENABLED) {
        return reply.code(503).send({ error: 'Ethereum settlement relayer is disabled' })
      }
      if (relayerSubmissionActive) {
        return reply.code(429).send({ error: 'Ethereum settlement relayer is busy; retry shortly' })
      }
      relayerSubmissionActive = true
      try {
        const publicClient = createPublicClient({
          chain: mainnet,
          transport: http(config.ETHEREUM_RPC_URL),
        })
        const account = privateKeyToAccount(config.ETHEREUM_RELAYER_PRIVATE_KEY as Hex)
        const wallet = createWalletClient({
          account,
          chain: mainnet,
          transport: http(config.ETHEREUM_RPC_URL),
        })
        const settlement = parsed.data.address as Address
        await publicClient.simulateContract({
          account,
          address: settlement,
          abi: EXIT_SETTLEMENT_ABI,
          functionName: 'settle',
        })
        const emitMetric = metricEmitter(request)
        const reservation = await reserveRelayerSpend({
          config,
          stateStore,
          estimateGas: () =>
            publicClient.estimateContractGas({
              account,
              address: settlement,
              abi: EXIT_SETTLEMENT_ABI,
              functionName: 'settle',
            }),
          estimateFeesPerGas: async () => {
            const fees = await publicClient.estimateFeesPerGas()
            return {
              maxFeePerGas: fees.maxFeePerGas,
              maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
            }
          },
          getBalance: () => publicClient.getBalance({ address: account.address }),
          emitMetric,
        })
        let txHash: Hex
        try {
          txHash = await wallet.writeContract({
            account,
            chain: mainnet,
            address: settlement,
            abi: EXIT_SETTLEMENT_ABI,
            functionName: 'settle',
            type: 'eip1559',
            gas: reservation.gasLimit,
            maxFeePerGas: reservation.maxFeePerGas,
            maxPriorityFeePerGas: reservation.maxPriorityFeePerGas,
          })
        } catch (error) {
          emitMetric('RelayerSubmissionUnknown', 1, { operation: 'settle' })
          throw error
        }
        emitMetric('RelayerSubmissionAccepted', 1, {
          operation: 'settle',
          reservedGwei: reservation.maxCostGwei,
          dailyBudgetUsedGwei: reservation.budgetUsedGwei,
        })
        return reply.code(202).send({ txHash })
      } catch (error) {
        if (error instanceof RelayerGuardError) {
          return reply.code(error.statusCode).send({ error: error.message })
        }
        return reply.code(502).send({ error: safeError(error) })
      } finally {
        relayerSubmissionActive = false
      }
    },
  )

  registerOpaqueProxy(app, '/proxy/discovery', config.DISCOVERY_URL, fetchImpl)
  registerPaymasterProxy(app, config, flowStore, fetchImpl)
  registerOpaqueProxy(app, '/proxy/starknet-rpc', config.STARKNET_RPC_URL, fetchImpl)

  return app
}

class StarkscanHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
    readonly retryAfter: string | null,
  ) {
    super(`Starkscan returned HTTP ${status}`)
  }
}

async function getProofJob(args: {
  jobId: string
  apiKey: string
  fetchImpl: typeof fetch
  stateStore: StateStore
  fallback: Map<string, { value: string; expiresAt: number }>
  inFlight: Map<string, Promise<ProofRelayJob>>
}): Promise<ProofRelayJob> {
  const key = `qrt:proof:${args.jobId}`
  const memory = args.fallback.get(key)
  if (memory && memory.expiresAt > Date.now()) return JSON.parse(memory.value) as ProofRelayJob
  if (memory) args.fallback.delete(key)
  const cached = await args.stateStore.get(key)
  if (cached) return JSON.parse(cached) as ProofRelayJob

  const existing = args.inFlight.get(args.jobId)
  if (existing) return existing
  const poll = pollAndPersistProofJob(args, key).finally(() => args.inFlight.delete(args.jobId))
  args.inFlight.set(args.jobId, poll)
  return poll
}

async function pollAndPersistProofJob(
  args: {
    jobId: string
    apiKey: string
    fetchImpl: typeof fetch
    stateStore: StateStore
    fallback: Map<string, { value: string; expiresAt: number }>
  },
  cacheKey: string,
): Promise<ProofRelayJob> {
  const response = await args.fetchImpl(`${STARKSCAN_PROVE_URL}/${encodeURIComponent(args.jobId)}`, {
    headers: { accept: 'application/json', 'x-starkscan-api-key': args.apiKey },
    signal: AbortSignal.timeout(30_000),
  })
  const body = await response.json().catch(() => undefined)
  if (!response.ok) throw new StarkscanHttpError(response.status, body, response.headers.get('retry-after'))
  const parsed = proofJobSchema.safeParse(body)
  if (!parsed.success) throw new Error('Starkscan returned an invalid proof job')
  const job = parsed.data as ProofRelayJob
  if (!job.terminal) return job

  if (job.result === undefined && job.error === undefined) {
    const raced = await args.stateStore.get(cacheKey)
    if (raced) return JSON.parse(raced) as ProofRelayJob
  }

  const value = JSON.stringify(job)
  await persistProofJob(job, args.stateStore, args.fallback, cacheKey, value)
  return job
}

async function persistProofJob(
  job: ProofRelayJob,
  stateStore: StateStore,
  fallback: Map<string, { value: string; expiresAt: number }>,
  key = `qrt:proof:${job.jobId}`,
  value = JSON.stringify(job),
): Promise<void> {
  fallback.set(key, {
    value,
    expiresAt: Date.now() + PROOF_RESULT_TTL_SECONDS * 1_000,
  })
  await stateStore.set(key, value, PROOF_RESULT_TTL_SECONDS)
}

function proofPollToken(secret: string, jobId: string): string {
  return createHmac('sha256', secret).update(`proof:${jobId}`).digest('hex')
}

function secureEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left)
  const rightBytes = Buffer.from(right)
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes)
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function forwardStarkscanError(reply: FastifyReply, response: Response, body: unknown) {
  const retryAfter = response.headers.get('retry-after')
  if (retryAfter) reply.header('retry-after', retryAfter)
  return reply.code(upstreamStatus(response.status)).send(body ?? { error: 'Starkscan request failed' })
}

function upstreamStatus(status: number): number {
  return status >= 400 && status <= 599 ? status : 502
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

function registerPaymasterProxy(
  app: ReturnType<typeof Fastify>,
  config: ApiConfig,
  flowStore: FlowStore,
  fetchImpl: typeof fetch,
) {
  app.post(
    '/proxy/paymaster',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!config.PAYMASTER_URL || !config.AVNU_PAYMASTER_API_KEY) {
        return reply.code(503).send({ error: 'AVNU Paymaster is not configured' })
      }

      const flowId = singleHeader(request.headers['x-flow-id'])
      const token = flowToken(request.headers['x-flow-token'])
      const flow = flowIdSchema.safeParse(flowId).success && token
        ? await flowStore.read(flowId!, token)
        : undefined
      if (!flow) return reply.code(404).send({ error: 'Flow not found' })

      const parsed = paymasterRequestSchema.safeParse(request.body)
      if (!parsed.success) return reply.code(400).send({ error: 'Unsupported Paymaster request' })
      if (!paymasterRequestAllowed(flow, parsed.data)) {
        return reply.code(403).send({ error: 'Paymaster request is outside this flow' })
      }

      try {
        const response = await fetchImpl(config.PAYMASTER_URL.replace(/\/$/, ''), {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: request.headers.accept ?? 'application/json',
            'x-paymaster-api-key': config.AVNU_PAYMASTER_API_KEY,
          },
          body: JSON.stringify(parsed.data),
          signal: AbortSignal.timeout(60_000),
        })
        const body = await response.arrayBuffer()
        const retryAfter = response.headers.get('retry-after')
        if (retryAfter) reply.header('retry-after', retryAfter)
        return reply
          .code(response.status)
          .header('content-type', response.headers.get('content-type') ?? 'application/json')
          .send(Buffer.from(body))
      } catch (error) {
        return reply.code(502).send({ error: safeError(error) })
      }
    },
  )
}

function paymasterRequestAllowed(
  flow: PublicFlow,
  request: z.infer<typeof paymasterRequestSchema>,
): boolean {
  const transaction = record(request.params.transaction)
  const parameters = record(request.params.parameters)
  const feeMode = record(parameters?.fee_mode)
  if (!transaction || parameters?.version !== '0x1' || !feeMode) return false
  // On execute the account signs whatever `typed_data` carries, so that is what must be checked;
  // the `calls` array only exists on build.
  const executing = request.method === 'paymaster_executeTransaction'

  if (flow.phase === 'bridging-to-starknet') {
    if (feeMode.mode !== 'sponsored') return false
    const type = String(transaction.type)
    if (!['deploy', 'deploy_and_invoke', 'invoke'].includes(type)) return false
    if (type !== 'invoke' && !expectedDeployment(record(transaction.deployment), flow)) return false
    if (type === 'deploy') return true
    const invoke = record(transaction.invoke)
    if (!invoke || !feltEquals(invoke.user_address, flow.starknetAccount)) return false
    const calls = executing ? typedDataCalls(record(invoke.typed_data)) : requestCalls(invoke.calls)
    return (
      calls !== undefined &&
      calls.length === 1 &&
      isCall(calls[0], CHAIN.starknet.cctp.messageTransmitterV2, STARKNET_SELECTORS.receive_message)
    )
  }

  if (flow.phase === 'pool-depositing') {
    if (transaction.type !== 'invoke_and_apply_action' || !privateUsdcFee(feeMode)) return false
    const invoke = record(transaction.invoke)
    if (!invoke || !feltEquals(invoke.user_address, flow.starknetAccount)) return false
    const applyAction = record(transaction.apply_action)
    if (!applyAction) return false
    if (executing ? !expectedApplyActionsCall(applyAction) : !expectedPool(applyAction)) return false
    const calls = executing ? typedDataCalls(record(invoke.typed_data)) : requestCalls(invoke.calls)
    if (!calls || calls.length !== 1) return false
    const approve = calls[0]
    return (
      isCall(approve, CHAIN.starknet.usdc, STARKNET_SELECTORS.approve) &&
      feltEquals(approve?.calldata[0], CHAIN.starknet.privacyPool)
    )
  }

  if (flow.phase === 'pool-withdrawing') {
    if (transaction.type !== 'apply_action' || !privateUsdcFee(feeMode)) return false
    const applyAction = record(transaction.apply_action)
    if (!applyAction) return false
    return executing ? expectedApplyActionsCall(applyAction) : expectedPool(applyAction)
  }

  return false
}

interface NormalizedCall {
  to: unknown
  selector: unknown
  calldata: unknown[]
}

function requestCalls(value: unknown): NormalizedCall[] | undefined {
  if (!Array.isArray(value)) return undefined
  const calls: NormalizedCall[] = []
  for (const entry of value) {
    const call = record(entry)
    if (!call) return undefined
    calls.push({
      to: call.to,
      selector: call.selector,
      calldata: Array.isArray(call.calldata) ? call.calldata : [],
    })
  }
  return calls
}

/** The calls the account will actually authorise, from SNIP-9 typed data in the v1 or v2 layout. */
function typedDataCalls(typedData: Record<string, unknown> | undefined): NormalizedCall[] | undefined {
  const message = record(typedData?.message)
  const domain = record(typedData?.domain)
  if (!message || !domain || !expectedChain(domain.chainId)) return undefined
  const raw = Array.isArray(message.Calls)
    ? message.Calls
    : Array.isArray(message.calls)
      ? message.calls
      : undefined
  if (!raw) return undefined
  const calls: NormalizedCall[] = []
  for (const entry of raw) {
    const call = record(entry)
    if (!call) return undefined
    const calldata = call.Calldata ?? call.calldata
    calls.push({
      to: call.To ?? call.to,
      selector: call.Selector ?? call.selector,
      calldata: Array.isArray(calldata) ? calldata : [],
    })
  }
  return calls
}

function expectedChain(chainId: unknown): boolean {
  return chainId === 'SN_MAIN' || feltEquals(chainId, CHAIN.starknet.chainId)
}

function isCall(call: NormalizedCall | undefined, to: string, selector: string): boolean {
  return call !== undefined && feltEquals(call.to, to) && feltEquals(call.selector, selector)
}

/** Only the flow's own OpenZeppelin account, with its public key as salt and sole constructor arg. */
function expectedDeployment(deployment: Record<string, unknown> | undefined, flow: PublicFlow): boolean {
  if (!deployment) return false
  const calldata = Array.isArray(deployment.calldata) ? deployment.calldata : undefined
  return (
    feltEquals(deployment.class_hash, CHAIN.starknet.ozAccountClassHash) &&
    feltEquals(deployment.address, flow.starknetAccount) &&
    calldata !== undefined &&
    calldata.length === 1 &&
    feltEquals(deployment.salt, calldata[0]) &&
    (deployment.version === 1 || deployment.version === '1' || deployment.version === '0x1')
  )
}

function expectedApplyActionsCall(applyAction: Record<string, unknown>): boolean {
  const call = record(applyAction.apply_actions_call)
  return (
    call !== undefined &&
    feltEquals(call.to, CHAIN.starknet.privacyPool) &&
    feltEquals(call.selector, STARKNET_SELECTORS.apply_actions)
  )
}

function privateUsdcFee(feeMode: Record<string, unknown>): boolean {
  return feeMode.mode === 'sponsored_private' && feltEquals(feeMode.pool_fee_token, CHAIN.starknet.usdc)
}

function expectedPool(applyAction: Record<string, unknown>): boolean {
  return feltEquals(applyAction.pool_address, CHAIN.starknet.privacyPool)
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

async function claimEntryBurn(
  flowStore: FlowStore,
  stateStore: StateStore,
  flow: PublicFlow,
): Promise<boolean> {
  const key = `qrt:entry-claim:${(flow.entryTxHash ?? '').toLowerCase()}`
  const holder = await stateStore.claim(key, flow.id, FlowStore.ttlSeconds)
  if (holder === flow.id) return true
  const previous = await flowStore.peek(holder)
  if (previous && previous.phase !== 'failed') return false
  // Hand over atomically: of several recovery flows racing for a failed holder's burn, exactly
  // one swaps the claim; the others observe a new holder and are refused.
  return stateStore.compareAndSwap(key, holder, flow.id, FlowStore.ttlSeconds)
}

async function verifiedEntry(verifier: EntryVerifier, flow: PublicFlow): Promise<boolean> {
  try {
    return await verifier({
      txHash: flow.entryTxHash ?? '',
      ethereumSender: flow.ethereumSender,
      starknetAccount: flow.starknetAccount,
    })
  } catch {
    return false
  }
}

function liveEntryVerifier(rpcUrl: string, entryRouter: Address): EntryVerifier {
  const client = createPublicClient({ chain: mainnet, transport: http(rpcUrl) })
  return async ({ txHash, ethereumSender, starknetAccount }) => {
    if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) return false
    const receipt = await client.waitForTransactionReceipt({ hash: txHash as Hex, timeout: 30_000 })
    if (receipt.status !== 'success') return false
    const events = parseEventLogs({ abi: ENTRY_ROUTER_ABI, eventName: 'EntryStarted', logs: receipt.logs })
    return events.some(
      (event) =>
        event.address.toLowerCase() === entryRouter.toLowerCase() &&
        event.args.sender.toLowerCase() === ethereumSender.toLowerCase() &&
        event.args.starknetRecipient === BigInt(starknetAccount),
    )
  }
}

function flowToken(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' && value.length >= 32 ? value : undefined
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error'
}

function metricEmitter(request: FastifyRequest) {
  return (
    name: RelayerMetric,
    value: number,
    details?: Record<string, string | number>,
  ) => request.log.info(relayerMetricEvent(name, value, details))
}
