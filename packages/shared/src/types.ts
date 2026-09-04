import { z } from 'zod'
import { MAX_DELAY_MINUTES, MIN_DELAY_MINUTES } from './constants.js'

export const tokenSymbolSchema = z.enum(['ETH', 'USDC', 'WBTC'])
export type TokenSymbol = z.infer<typeof tokenSymbolSchema>

export const addressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'Invalid Ethereum address')
export const feltSchema = z.string().regex(/^0x[0-9a-fA-F]{1,64}$/, 'Invalid Starknet felt')
export const hashSchema = z.string().regex(/^0x[0-9a-fA-F]{64}$/, 'Invalid transaction hash')

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
  inboundCctpMaxFeeBase: string
  outboundCctpMaxFeeBase: string
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

export interface PublicFlow {
  id: string
  phase: FlowPhase
  quote: RouteQuote
  ethereumSender: string
  starknetAccount: string
  delayMinutes: number
  settlementAddress?: string
  entryTxHash?: string
  inboundMintTxHash?: string
  poolDepositTxHash?: string
  privacyDepositConfirmedAt?: string
  exitEligibleAt?: string
  poolExitTxHash?: string
  outboundMintTxHash?: string
  settlementTxHash?: string
  failureReason?: string
  createdAt: string
  updatedAt: string
}

export const createFlowSchema = z
  .object({
    quoteId: z.string().min(8).max(128),
    ethereumSender: addressSchema,
    starknetAccount: feltSchema,
    delayMinutes: z.number().int().min(MIN_DELAY_MINUTES).max(MAX_DELAY_MINUTES),
  })
  .strict()

export const flowUpdateSchema = z
  .object({
    phase: flowPhaseSchema,
    txHash: hashSchema.optional(),
    settlementAddress: addressSchema.optional(),
    failureReason: z.string().min(1).max(500).optional(),
    occurredAt: z.string().datetime().optional(),
  })
  .strict()

export type FlowUpdate = z.infer<typeof flowUpdateSchema>

export interface CreateFlowResponse {
  flow: PublicFlow
  writeToken: string
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
