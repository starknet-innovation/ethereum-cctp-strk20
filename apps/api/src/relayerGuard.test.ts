import { describe, expect, it } from 'vitest'
import type { ApiConfig } from './config.js'
import {
  RelayerGuardError,
  reserveRelayerSpend,
  type RelayerMetric,
} from './relayerGuard.js'
import { MemoryStateStore } from './stateStore.js'

const config = {
  RELAYER_ENABLED: true,
  RELAYER_DAILY_SPEND_LIMIT_GWEI: 500_000,
  RELAYER_MIN_BALANCE_WEI: 2_000_000_000_000_000n,
  RELAYER_MAX_GAS_PER_TRANSACTION: 800_000n,
  RELAYER_MAX_FACTORY_CREATE_GAS: 1_300_000n,
  RELAYER_GAS_LIMIT_MULTIPLIER_BPS: 12_500,
} as ApiConfig

function attempt(
  stateStore: MemoryStateStore,
  overrides: Partial<{
    config: ApiConfig
    gas: bigint
    fee: bigint
    balance: bigint
    maxGasPerTransaction: bigint
    emitMetric: (name: RelayerMetric, value: number) => void
  }> = {},
) {
  return reserveRelayerSpend({
    config: overrides.config ?? config,
    stateStore,
    estimateGas: async () => overrides.gas ?? 100_000n,
    estimateFeesPerGas: async () => ({
      maxFeePerGas: overrides.fee ?? 2_000_000_000n,
      maxPriorityFeePerGas: 0n,
    }),
    getBalance: async () => overrides.balance ?? 10_000_000_000_000_000n,
    emitMetric: overrides.emitMetric ?? (() => undefined),
    ...(overrides.maxGasPerTransaction === undefined
      ? {}
      : { maxGasPerTransaction: overrides.maxGasPerTransaction }),
    now: new Date('2026-09-08T12:00:00Z'),
  })
}

describe('relayer guard', () => {
  it('reserves conservative maximum spend atomically and enforces the daily cap', async () => {
    const stateStore = new MemoryStateStore()
    const reservations = await Promise.allSettled([
      attempt(stateStore),
      attempt(stateStore),
      attempt(stateStore),
    ])

    expect(reservations.filter(({ status }) => status === 'fulfilled')).toHaveLength(2)
    const rejected = reservations.find(({ status }) => status === 'rejected')
    expect(rejected).toMatchObject({
      status: 'rejected',
      reason: expect.objectContaining({ code: 'daily-budget', statusCode: 429 }),
    })
    expect(await stateStore.get('qrt:relayer-budget:2026-09-08')).toBe('500000')
  })

  it('keeps a protected balance reserve and emits a low-balance metric', async () => {
    const metrics: RelayerMetric[] = []
    await expect(attempt(new MemoryStateStore(), {
      balance: 2_100_000_000_000_000n,
      emitMetric: (name) => metrics.push(name),
    })).rejects.toMatchObject({ code: 'low-balance', statusCode: 503 })
    expect(metrics).toEqual(['RelayerBalanceGwei', 'RelayerLowBalance'])
  })

  it('rejects excessive gas estimates and an operationally disabled relayer', async () => {
    await expect(attempt(new MemoryStateStore(), { gas: 700_000n })).rejects.toMatchObject({
      code: 'gas-limit',
      message: 'Estimated transaction gas limit 875000 exceeds the relayer safety limit 800000',
    })
    await expect(attempt(new MemoryStateStore(), {
      config: { ...config, RELAYER_ENABLED: false },
    })).rejects.toEqual(expect.any(RelayerGuardError))
  })

  it('permits a narrowly scoped higher ceiling without changing the default ceiling', async () => {
    await expect(attempt(new MemoryStateStore(), {
      config: { ...config, RELAYER_DAILY_SPEND_LIMIT_GWEI: 5_000_000 },
      gas: 897_646n,
      maxGasPerTransaction: 1_300_000n,
    })).resolves.toMatchObject({ gasLimit: 1_122_058n })
    await expect(attempt(new MemoryStateStore(), { gas: 897_646n })).rejects.toMatchObject({
      code: 'gas-limit',
    })
  })

  it('applies a non-zero priority fee and a one-gwei maximum fee floor', async () => {
    await expect(attempt(new MemoryStateStore(), { fee: 200_000_000n })).resolves.toMatchObject({
      maxFeePerGas: 1_000_000_000n,
      maxPriorityFeePerGas: 50_000_000n,
    })
  })
})
