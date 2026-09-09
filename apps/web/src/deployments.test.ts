import { describe, expect, it } from 'vitest'
import { CHAIN, POC_DEPLOYMENTS, type PublicConfig } from '@privacy-round-trip/shared'
import { assertPinnedDeployments } from './deployments.js'

function config(
  overrides: Partial<PublicConfig['ethereum']> = {},
  anonymizer: string = POC_DEPLOYMENTS.starknet.cctpExitAnonymizer,
): PublicConfig {
  return {
    environment: 'mainnet',
    ready: true,
    missing: [],
    ethereum: {
      entryRouter: POC_DEPLOYMENTS.ethereum.entryRouter.toLowerCase(),
      exitSettlementFactory: POC_DEPLOYMENTS.ethereum.exitSettlementFactory,
      tokens: { ETH: CHAIN.ethereum.tokens.ETH, USDC: CHAIN.ethereum.tokens.USDC, WBTC: CHAIN.ethereum.tokens.WBTC },
      tokenMessengerV2: CHAIN.ethereum.cctp.tokenMessengerV2,
      ...overrides,
    },
    starknet: { privacyPool: CHAIN.starknet.privacyPool, cctpExitAnonymizer: anonymizer, usdc: CHAIN.starknet.usdc },
  }
}

describe('pinned deployments', () => {
  it('accepts the reviewed deployments regardless of address casing or felt padding', () => {
    expect(() => assertPinnedDeployments(config())).not.toThrow()
    expect(() =>
      assertPinnedDeployments(config({}, `0x${POC_DEPLOYMENTS.starknet.cctpExitAnonymizer.slice(3).toUpperCase()}`)),
    ).not.toThrow()
  })

  it('refuses an API that names a different exit anonymizer, factory, or entry router', () => {
    expect(() => assertPinnedDeployments(config({}, '0x1234'))).toThrow(/exit anonymizer/)
    expect(() =>
      assertPinnedDeployments(config({ exitSettlementFactory: '0x1111111111111111111111111111111111111111' })),
    ).toThrow(/settlement factory/)
    expect(() =>
      assertPinnedDeployments(config({ entryRouter: '0x1111111111111111111111111111111111111111' })),
    ).toThrow(/entry router/)
    const { entryRouter: _omitted, ...rest } = config().ethereum
    expect(() => assertPinnedDeployments({ ...config(), ethereum: rest })).toThrow(/entry router/)
  })
})
