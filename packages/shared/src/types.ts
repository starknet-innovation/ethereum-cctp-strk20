import { z } from 'zod'
import { MAX_DELAY_MINUTES, MIN_DELAY_MINUTES } from './constants.js'

export const tokenSymbolSchema = z.enum(['ETH', 'USDC', 'WBTC'])
export type TokenSymbol = z.infer<typeof tokenSymbolSchema>

export const addressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'Invalid Ethereum address')
export const feltSchema = z.string().regex(/^0x[0-9a-fA-F]{1,64}$/, 'Invalid Starknet felt')
// Flow transitions carry both 32-byte Ethereum hashes and Starknet field-element hashes. Starknet
// RPCs canonically omit leading zeroes, so requiring exactly 64 hex digits rejects valid results.
export const hashSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{1,64}$/, 'Invalid cross-chain transaction hash')

export const quoteRequestSchema = z
  .object({
    inputToken: tokenSymbolSchema,
    outputToken: tokenSymbolSchema,
    amount: z.string().regex(/^\d+(\.\d+)?$/),
    slippageBps: z.number().int().min(10).max(500),
  })
  .strict()

export type QuoteRequest = z.infer<typeof quoteRequestSchema>

export interface RouteQuote {
  quoteId: string
  request: QuoteRequest
  inputAmountBase: string
  estimatedBridgeAmountBase: string
  minimumBridgeAmountBase: string
  estimatedOutputAmountBase: string
  minimumOutputAmountBase: string
  entryPoolFee: number
  exitPoolFee: number
  /** Optional during rolling upgrades and for flows quoted before fee-component disclosure. */
  inboundCctpProtocolFeeBase?: string
  inboundCctpMaxFeeBase: string
  estimatedStarknetFeesBase?: string
  outboundCctpProtocolFeeBase?: string
  outboundCctpForwardingFeeBase?: string
  outboundCctpMaxFeeBase: string
  estimatedSettlementUsdcBase?: string
  expiresAt: string
  warnings: string[]
}

export const flowPhaseSchema = z.enum([
  'prepared',
  'allowance-required',
  'entry-submitted',
  'bridging-to-starknet',
  'starknet-funded',
  'pool-depositing',
  'privacy-delay',
  'pool-withdrawing',
  'bridging-to-ethereum',
  'settling',
  'completed',
  'failed',
])
export type FlowPhase = z.infer<typeof flowPhaseSchema>

/**
 * Server-side flow record. It deliberately carries only entry-side identifiers. The settlement
 * address and every exit-side transaction hash resolve on-chain to the final recipient, so storing
 * them next to `ethereumSender`/`entryTxHash` would be a direct sender-to-recipient join. Exit-side
 * progress lives only in the browser (memory or the same-tab recovery bundle).
 */
export interface PublicFlow {
  id: string
  phase: FlowPhase
  quote: RouteQuote
  ethereumSender: string
  starknetAccount: string
  delayMinutes: number
  entryTxHash?: string
  inboundMintTxHash?: string
  poolDepositTxHash?: string
  privacyDepositConfirmedAt?: string
  exitEligibleAt?: string
  failureReason?: string
  createdAt: string
  updatedAt: string
}

/** Phases whose transition may carry a transaction hash. Exit-side phases never do (see PublicFlow). */
export const TX_HASH_PHASES: readonly FlowPhase[] = ['entry-submitted', 'starknet-funded', 'privacy-delay']

export const createFlowSchema = z
  .object({
    quoteId: z.string().min(8).max(128),
    ethereumSender: addressSchema,
    starknetAccount: feltSchema,
    delayMinutes: z.number().int().min(MIN_DELAY_MINUTES).max(MAX_DELAY_MINUTES),
  })
  .strict()

export const flowIdSchema = z.string().regex(/^f_[0-9a-f]{32}$/)

/**
 * Presented on the `bridging-to-starknet` transition by a recovery flow: the id and write
 * capability of the stopped flow whose id the entry burn names on-chain. Proves the caller
 * controls that flow, so a stranger who merely observed the burn cannot take it over.
 */
export const entryReleaseSchema = z.object({ flowId: flowIdSchema, token: z.string().min(32).max(512) }).strict()

export const flowUpdateSchema = z
  .object({
    phase: flowPhaseSchema,
    txHash: hashSchema.optional(),
    failureReason: z.string().min(1).max(500).optional(),
    occurredAt: z.string().datetime().optional(),
    release: entryReleaseSchema.optional(),
  })
  .strict()
  .superRefine((update, context) => {
    if (update.txHash && !TX_HASH_PHASES.includes(update.phase)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['txHash'],
        message: 'Exit-side transaction hashes are not stored server-side',
      })
    }
    if (update.release && update.phase !== 'bridging-to-starknet') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['release'],
        message: 'An entry release only accompanies the bridging-to-starknet transition',
      })
    }
  })

export type FlowUpdate = z.infer<typeof flowUpdateSchema>

export interface CreateFlowResponse {
  flow: PublicFlow
  writeToken: string
}

export type ProofJobStatus =
  | 'queued'
  | 'dispatched'
  | 'succeeded'
  | 'failed'
  | 'unavailable'
  | 'unknown_delivery'

export interface ProofRelayResult {
  proof: string
  proof_facts: string[]
  l2_to_l1_messages: Array<{
    from_address: string
    to_address: string
    payload: string[]
  }>
  additional_data?: {
    signature?: {
      issued_at: number
      sig_r: string
      sig_s: string
    }
  }
}

export interface ProofRelayJob {
  jobId: string
  status: ProofJobStatus
  terminal: boolean
  attemptCount?: number
  queuePosition?: number
  pollAfterSeconds?: number
  createdAt?: string
  completedAt?: string
  result?: ProofRelayResult
  error?: {
    code?: string | number
    message?: string
    data?: unknown
    source?: string
  }
  resultUnavailableReason?: string
}

export interface ProofRelaySubmission extends ProofRelayJob {
  pollToken: string
}

export interface PublicConfig {
  environment: 'mainnet'
  ready: boolean
  missing: string[]
  ethereum: {
    entryRouter?: string
    exitSettlementFactory?: string
    tokens: Record<TokenSymbol, string>
    tokenMessengerV2: string
  }
  starknet: {
    privacyPool: string
    cctpExitAnonymizer?: string
    usdc: string
  }
}
