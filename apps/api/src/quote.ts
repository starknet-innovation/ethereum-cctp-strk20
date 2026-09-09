import {
  CCTP_FAST_FINALITY_THRESHOLD,
  CHAIN,
  TOKENS,
  type QuoteRequest,
  type RouteQuote,
} from '@privacy-round-trip/shared'
import {
  createPublicClient,
  http,
  parseUnits,
  zeroAddress,
  type Address,
  type PublicClient,
} from 'viem'
import { mainnet } from 'viem/chains'
import { randomUUID } from 'node:crypto'
import type { StateStore } from './stateStore.js'

const QUOTER_ABI = [
  {
    type: 'function',
    name: 'quoteExactInputSingle',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'tokenIn', type: 'address' },
      { name: 'tokenOut', type: 'address' },
      { name: 'fee', type: 'uint24' },
      { name: 'amountIn', type: 'uint256' },
      { name: 'sqrtPriceLimitX96', type: 'uint160' },
    ],
    outputs: [{ name: 'amountOut', type: 'uint256' }],
  },
] as const

interface IrisFeeRow {
  finalityThreshold: number
  minimumFee: number
  forwardFee?: { low: number; med: number; high: number }
}

export interface CctpFeeQuote {
  protocolFee: bigint
  forwardingFee: bigint
  total: bigint
}

export interface QuoteDependencies {
  quoteSwap(tokenIn: Address, tokenOut: Address, amount: bigint): Promise<{ amount: bigint; fee: number }>
  cctpMaxFee(source: number, destination: number, amount: bigint, forward: boolean): Promise<CctpFeeQuote>
}

export class QuoteService {
  constructor(
    private readonly dependencies: QuoteDependencies,
    private readonly estimatedStarknetFeesBase: bigint,
    private readonly state: StateStore,
  ) {}

  async create(request: QuoteRequest): Promise<RouteQuote> {
    const inputAmount = parseUnits(request.amount, TOKENS[request.inputToken].decimals)
    if (inputAmount <= 0n) throw new Error('Amount must be positive')

    let entryPoolFee = 0
    let bridgeAmount = inputAmount
    if (request.inputToken !== 'USDC') {
      const tokenIn = request.inputToken === 'ETH' ? CHAIN.ethereum.tokens.WETH : CHAIN.ethereum.tokens.WBTC
      const result = await this.dependencies.quoteSwap(tokenIn, CHAIN.ethereum.tokens.USDC, inputAmount)
      bridgeAmount = result.amount
      entryPoolFee = result.fee
    }

    const inboundFees = await this.dependencies.cctpMaxFee(0, 25, bridgeAmount, false)
    const afterInbound = bridgeAmount - inboundFees.total
    if (afterInbound <= this.estimatedStarknetFeesBase) throw new Error('Amount is below route fees')
    const exitBurnAmount = afterInbound - this.estimatedStarknetFeesBase
    const outboundFees = await this.dependencies.cctpMaxFee(25, 0, exitBurnAmount, true)
    const settlementUsdc = exitBurnAmount - outboundFees.total
    if (settlementUsdc <= 0n) throw new Error('Amount is below route fees')

    let outputAmount = settlementUsdc
    let exitPoolFee = 0
    if (request.outputToken !== 'USDC') {
      const tokenOut = request.outputToken === 'ETH' ? CHAIN.ethereum.tokens.WETH : CHAIN.ethereum.tokens.WBTC
      const result = await this.dependencies.quoteSwap(CHAIN.ethereum.tokens.USDC, tokenOut, settlementUsdc)
      outputAmount = result.amount
      exitPoolFee = result.fee
    }

    const slippage = BigInt(10_000 - request.slippageBps)
    const minimumBridge = (bridgeAmount * slippage) / 10_000n
    const minimumOutput = (outputAmount * slippage) / 10_000n
    const quote: RouteQuote = {
      quoteId: `q_${randomUUID().replaceAll('-', '')}`,
      request,
      inputAmountBase: inputAmount.toString(),
      estimatedBridgeAmountBase: bridgeAmount.toString(),
      minimumBridgeAmountBase: minimumBridge.toString(),
      estimatedOutputAmountBase: outputAmount.toString(),
      minimumOutputAmountBase: minimumOutput.toString(),
      entryPoolFee,
      exitPoolFee,
      inboundCctpProtocolFeeBase: inboundFees.protocolFee.toString(),
      inboundCctpMaxFeeBase: inboundFees.total.toString(),
      estimatedStarknetFeesBase: this.estimatedStarknetFeesBase.toString(),
      outboundCctpProtocolFeeBase: outboundFees.protocolFee.toString(),
      outboundCctpForwardingFeeBase: outboundFees.forwardingFee.toString(),
      outboundCctpMaxFeeBase: outboundFees.total.toString(),
      estimatedSettlementUsdcBase: settlementUsdc.toString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      warnings: [
        'Quotes use direct Uniswap V3 pools and can change before the delayed exit.',
        'CCTP deductions are maximum authorized fees from current Circle data; the actual fees may be lower.',
        'Starknet private execution fees are estimated and the actual paymaster amounts are checked before submission.',
        'The five-minute-or-longer delay reduces immediacy but does not prevent amount or timing correlation.',
      ],
    }
    await this.state.set(this.key(quote.quoteId), JSON.stringify(quote), 60)
    return quote
  }

  async get(id: string): Promise<RouteQuote | undefined> {
    const serialized = await this.state.get(this.key(id))
    const quote = serialized ? (JSON.parse(serialized) as RouteQuote) : undefined
    if (!quote || Date.parse(quote.expiresAt) <= Date.now()) return undefined
    return quote
  }

  private key(id: string): string {
    return `qrt:quote:${id}`
  }
}

export function liveQuoteDependencies(rpcUrl: string): QuoteDependencies {
  const client = createPublicClient({ chain: mainnet, transport: http(rpcUrl) })
  return {
    quoteSwap: (tokenIn, tokenOut, amount) => bestUniswapQuote(client, tokenIn, tokenOut, amount),
    cctpMaxFee: irisMaxFee,
  }
}

async function bestUniswapQuote(
  client: PublicClient,
  tokenIn: Address,
  tokenOut: Address,
  amount: bigint,
): Promise<{ amount: bigint; fee: number }> {
  const fees = [100, 500, 3_000, 10_000] as const
  const attempts = await Promise.allSettled(
    fees.map(async (fee) => {
      const { result } = await client.simulateContract({
        account: zeroAddress,
        address: CHAIN.ethereum.uniswap.quoter,
        abi: QUOTER_ABI,
        functionName: 'quoteExactInputSingle',
        args: [tokenIn, tokenOut, fee, amount, 0n],
      })
      return { amount: result, fee }
    }),
  )
  const quotes = attempts
    .filter(
      (item): item is PromiseFulfilledResult<{ amount: bigint; fee: (typeof fees)[number] }> =>
        item.status === 'fulfilled',
    )
    .map((item) => item.value)
    .filter((item) => item.amount > 0n)
  const best = quotes.sort((a, b) => (a.amount > b.amount ? -1 : a.amount < b.amount ? 1 : 0))[0]
  if (!best) throw new Error('No supported Uniswap V3 pool returned a quote')
  return best
}

async function irisMaxFee(
  source: number,
  destination: number,
  amount: bigint,
  forward: boolean,
): Promise<CctpFeeQuote> {
  const suffix = forward ? '?forward=true' : ''
  const response = await fetch(
    `https://iris-api.circle.com/v2/burn/USDC/fees/${source}/${destination}${suffix}`,
    { signal: AbortSignal.timeout(10_000) },
  )
  if (!response.ok) throw new Error(`Circle fee API returned ${response.status}`)
  const rows = (await response.json()) as IrisFeeRow[]
  const row = rows.find((item) => item.finalityThreshold === CCTP_FAST_FINALITY_THRESHOLD)
  if (!row) throw new Error('Circle did not return a fast-transfer fee')
  const protocolFee = ceilDiv(amount * BigInt(Math.ceil(row.minimumFee)), 10_000n)
  const forwardingFee = BigInt(forward ? (row.forwardFee?.high ?? 0) : 0)
  return { protocolFee, forwardingFee, total: protocolFee + forwardingFee }
}

function ceilDiv(value: bigint, divisor: bigint): bigint {
  return (value + divisor - 1n) / divisor
}
