import { describe, expect, it } from 'vitest'
import { CHAIN, type PublicConfig } from '@privacy-round-trip/shared'
import { env, requireEnv } from '../support/env.js'

async function get<T>(path: string): Promise<{ status: number; body: T }> {
  const response = await fetch(`${requireEnv('E2E_API_URL').replace(/\/$/, '')}${path}`, {
    signal: AbortSignal.timeout(20_000),
  })
  return { status: response.status, body: (await response.json()) as T }
}

describe.skipIf(!env.E2E_API_URL)('Deployed API', () => {
  it('is live on mainnet', async () => {
    const { status, body } = await get<{ status: string; environment: string }>('/v1/health/live')
    expect(status).toBe(200)
    expect(body).toEqual({ status: 'ok', environment: 'mainnet' })
  })

  it('publishes the pinned public configuration', async () => {
    const { status, body } = await get<PublicConfig>('/v1/config')
    expect(status).toBe(200)
    expect(body.environment).toBe('mainnet')
    expect(body.ethereum.tokens.USDC).toBe(CHAIN.ethereum.tokens.USDC)
    expect(body.ethereum.tokens.WBTC).toBe(CHAIN.ethereum.tokens.WBTC)
    expect(body.ethereum.tokenMessengerV2).toBe(CHAIN.ethereum.cctp.tokenMessengerV2)
    expect(body.starknet.privacyPool).toBe(CHAIN.starknet.privacyPool)
    expect(body.starknet.usdc).toBe(CHAIN.starknet.usdc)
  })

  it('reports readiness consistently with its published configuration', async () => {
    const ready = await get<{ ready: boolean; missing: string[] }>('/v1/health/ready')
    const config = (await get<PublicConfig>('/v1/config')).body
    expect(ready.status).toBe(ready.body.ready ? 200 : 503)
    expect(ready.body.ready).toBe(ready.body.missing.length === 0)
    if (ready.body.ready) {
      expect(config.ready).toBe(true)
      expect(config.ethereum.entryRouter).toMatch(/^0x[0-9a-fA-F]{40}$/)
      expect(config.ethereum.exitSettlementFactory).toMatch(/^0x[0-9a-fA-F]{40}$/)
      expect(config.starknet.cctpExitAnonymizer).toMatch(/^0x[0-9a-fA-F]{1,64}$/)
    } else {
      expect(config.missing).toEqual(expect.arrayContaining(ready.body.missing.filter((name) => name !== 'STATE_CACHE_CONNECTION')))
    }
  })
})
