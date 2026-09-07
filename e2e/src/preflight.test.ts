import { describe, expect, it } from 'vitest'
import { env } from './support/env.js'

/**
 * Chains this run intends to cover, e.g. `E2E_REQUIRE=ethereum` for the fork-only command. A
 * targeted run that names a chain must be able to reach it: individual tests skip when their own
 * configuration is absent, so without this the command would report success having exercised
 * nothing it was asked to exercise.
 */
const RPC_VARS = { ethereum: 'ETHEREUM_RPC_URL', starknet: 'STARKNET_RPC_URL' } as const
type Chain = keyof typeof RPC_VARS

const required = (process.env.E2E_REQUIRE ?? '')
  .split(',')
  .map((name) => name.trim().toLowerCase())
  .filter(Boolean)

const configured: Record<Chain, string | undefined> = {
  ethereum: env.ETHEREUM_RPC_URL,
  starknet: env.STARKNET_RPC_URL,
}

describe('e2e configuration', () => {
  it('can reach every chain this run intends to cover', () => {
    if (env.E2E_ALLOW_EMPTY) return

    expect(
      Boolean(env.ETHEREUM_RPC_URL || env.STARKNET_RPC_URL),
      'Set ETHEREUM_RPC_URL and/or STARKNET_RPC_URL (see e2e/.env.example). ' +
        'Set E2E_ALLOW_EMPTY=1 to acknowledge a run where every live test is skipped.',
    ).toBe(true)

    const unknown = required.filter((name) => !(name in RPC_VARS))
    expect(unknown, `E2E_REQUIRE names unknown chains: ${unknown.join(', ')}`).toEqual([])

    const missing = required.filter((name) => !configured[name as Chain])
    expect(
      missing,
      `This run declared E2E_REQUIRE=${required.join(',')}, but ` +
        `${missing.map((name) => RPC_VARS[name as Chain]).join(' and ')} is unset. Its tests would ` +
        'skip for want of configuration and the run would report success with no coverage.',
    ).toEqual([])
  })
})
