import { describe, expect, it } from 'vitest'
import { env } from './support/env.js'

describe('e2e configuration', () => {
  it('targets at least one live mainnet dependency', () => {
    if (env.E2E_ALLOW_EMPTY) return
    expect(
      Boolean(env.ETHEREUM_RPC_URL || env.STARKNET_RPC_URL),
      'Set ETHEREUM_RPC_URL and/or STARKNET_RPC_URL (see e2e/.env.example). ' +
        'Set E2E_ALLOW_EMPTY=1 to acknowledge a run where every live test is skipped.',
    ).toBe(true)
  })
})
