import { describe, expect, it } from 'vitest'
import { CCTP_FAST_FINALITY_THRESHOLD, CHAIN } from '@privacy-round-trip/shared'
import { parseUnits } from 'viem'
import { liveQuoteDependencies } from '../../../apps/api/src/quote.js'
import { env } from '../support/env.js'

const IRIS = 'https://iris-api.circle.com/v2'

interface FeeRow {
  finalityThreshold: number
  minimumFee: number
  forwardFee?: { low: number; med: number; high: number }
}

async function fees(source: number, destination: number, forward: boolean): Promise<FeeRow[]> {
  const response = await fetch(`${IRIS}/burn/USDC/fees/${source}/${destination}${forward ? '?forward=true' : ''}`, {
    signal: AbortSignal.timeout(20_000),
  })
  expect(response.status).toBe(200)
  return (await response.json()) as FeeRow[]
}

describe.skipIf(!env.ETHEREUM_RPC_URL && !env.STARKNET_RPC_URL)('Circle Iris CCTP V2 endpoints for the pinned domains', () => {
  it('publishes a fast-transfer fee row for Ethereum -> Starknet', async () => {
    const rows = await fees(CHAIN.ethereum.cctpDomain, CHAIN.starknet.cctpDomain, false)
    const fast = rows.find((row) => row.finalityThreshold === CCTP_FAST_FINALITY_THRESHOLD)
    expect(fast).toBeDefined()
    expect(fast?.minimumFee).toBeGreaterThanOrEqual(0)
  })

  it('publishes a forwarded fast-transfer fee row for Starknet -> Ethereum', async () => {
    const rows = await fees(CHAIN.starknet.cctpDomain, CHAIN.ethereum.cctpDomain, true)
    const fast = rows.find((row) => row.finalityThreshold === CCTP_FAST_FINALITY_THRESHOLD)
    expect(fast).toBeDefined()
    expect(fast?.forwardFee?.high).toBeGreaterThan(0)
  })

  it('answers unknown burn transactions with the structured error the API proxies verbatim', async () => {
    const response = await fetch(`${IRIS}/messages/${CHAIN.ethereum.cctpDomain}?transactionHash=0x${'00'.repeat(32)}`, {
      signal: AbortSignal.timeout(20_000),
    })
    expect(response.status).toBe(404)
    const body = (await response.json()) as { error?: unknown }
    expect(typeof body.error).toBe('string')
  })

  it.skipIf(!env.ETHEREUM_RPC_URL)('yields CCTP max fees the API can bound quotes with', async () => {
    const { cctpMaxFee } = liveQuoteDependencies(env.ETHEREUM_RPC_URL ?? '')
    const amount = parseUnits('100', 6)
    const inbound = await cctpMaxFee(CHAIN.ethereum.cctpDomain, CHAIN.starknet.cctpDomain, amount, false)
    const outbound = await cctpMaxFee(CHAIN.starknet.cctpDomain, CHAIN.ethereum.cctpDomain, amount, true)
    expect(inbound).toBeGreaterThanOrEqual(0n)
    expect(inbound).toBeLessThan(amount / 100n)
    const rows = await fees(CHAIN.starknet.cctpDomain, CHAIN.ethereum.cctpDomain, true)
    const forwardHigh = rows.find((row) => row.finalityThreshold === CCTP_FAST_FINALITY_THRESHOLD)?.forwardFee?.high ?? 0
    expect(outbound).toBeGreaterThanOrEqual(BigInt(forwardHigh))
  })
})
