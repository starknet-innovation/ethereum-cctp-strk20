import type { ApiConfig } from './config.js'
import type { StateStore } from './stateStore.js'

const GWEI = 1_000_000_000n

export type RelayerMetric =
  | 'RelayerBalanceGwei'
  | 'RelayerBudgetExceeded'
  | 'RelayerLowBalance'
  | 'RelayerSubmissionAccepted'
  | 'RelayerSubmissionUnknown'

export interface RelayerReservation {
  gasLimit: bigint
  maxCostGwei: number
  budgetUsedGwei: number
}

export class RelayerGuardError extends Error {
  constructor(
    readonly code: 'disabled' | 'gas-limit' | 'low-balance' | 'daily-budget',
    readonly statusCode: 429 | 503,
    message: string,
  ) {
    super(message)
  }
}

export async function reserveRelayerSpend(args: {
  config: ApiConfig
  stateStore: StateStore
  estimateGas: () => Promise<bigint>
  estimateMaxFeePerGas: () => Promise<bigint>
  getBalance: () => Promise<bigint>
  emitMetric: (name: RelayerMetric, value: number, details?: Record<string, string | number>) => void
  now?: Date
}): Promise<RelayerReservation> {
  if (!args.config.RELAYER_ENABLED) {
    throw new RelayerGuardError('disabled', 503, 'Ethereum settlement relayer is disabled')
  }

  const estimatedGas = await args.estimateGas()
  const gasLimit = applyBasisPoints(estimatedGas, args.config.RELAYER_GAS_LIMIT_MULTIPLIER_BPS)
  if (gasLimit > args.config.RELAYER_MAX_GAS_PER_TRANSACTION) {
    throw new RelayerGuardError(
      'gas-limit',
      503,
      'Estimated transaction gas exceeds the relayer safety limit',
    )
  }

  const maxFeePerGas = await args.estimateMaxFeePerGas()
  const maxCostWei = gasLimit * maxFeePerGas
  const balance = await args.getBalance()
  const balanceGwei = Number(balance / GWEI)
  const requiredGwei = Number(divideRoundUp(maxCostWei + args.config.RELAYER_MIN_BALANCE_WEI, GWEI))
  const lowBalance = balance < maxCostWei + args.config.RELAYER_MIN_BALANCE_WEI
  args.emitMetric('RelayerBalanceGwei', balanceGwei)
  args.emitMetric('RelayerLowBalance', lowBalance ? 1 : 0, { balanceGwei, requiredGwei })
  if (lowBalance) {
    throw new RelayerGuardError(
      'low-balance',
      503,
      'Relayer balance is below the transaction cost plus its protected reserve',
    )
  }

  const maxCostGwei = Number(divideRoundUp(maxCostWei, GWEI))
  const now = args.now ?? new Date()
  const budgetUsedGwei = await args.stateStore.reserveCounter(
    dailyBudgetKey(now),
    maxCostGwei,
    args.config.RELAYER_DAILY_SPEND_LIMIT_GWEI,
    secondsUntilBudgetExpiry(now),
  )
  if (budgetUsedGwei === undefined) {
    args.emitMetric('RelayerBudgetExceeded', 1, {
      requestedGwei: maxCostGwei,
      dailyLimitGwei: args.config.RELAYER_DAILY_SPEND_LIMIT_GWEI,
    })
    throw new RelayerGuardError('daily-budget', 429, 'Relayer daily gas-spend budget is exhausted')
  }
  args.emitMetric('RelayerBudgetExceeded', 0, {
    dailyBudgetUsedGwei: budgetUsedGwei,
    dailyLimitGwei: args.config.RELAYER_DAILY_SPEND_LIMIT_GWEI,
  })

  return { gasLimit, maxCostGwei, budgetUsedGwei }
}

export function relayerMetricEvent(
  name: RelayerMetric,
  value: number,
  details: Record<string, string | number> = {},
) {
  return {
    event: name,
    ...details,
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [
        {
          Namespace: 'EthereumCctpStrk20',
          Dimensions: [['Service', 'Environment']],
          Metrics: [{ Name: name, Unit: name.endsWith('Gwei') ? 'None' : 'Count' }],
        },
      ],
    },
    Service: 'api',
    Environment: 'mainnet-poc',
    [name]: value,
  }
}

function applyBasisPoints(value: bigint, basisPoints: number): bigint {
  return divideRoundUp(value * BigInt(basisPoints), 10_000n)
}

function divideRoundUp(value: bigint, divisor: bigint): bigint {
  return (value + divisor - 1n) / divisor
}

function dailyBudgetKey(now: Date): string {
  return `qrt:relayer-budget:${now.toISOString().slice(0, 10)}`
}

function secondsUntilBudgetExpiry(now: Date): number {
  const nextDay = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)
  return Math.max(1, Math.ceil((nextDay - now.getTime()) / 1_000) + 3_600)
}
