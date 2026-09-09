export const CHAIN = {
  ethereum: {
    chainId: 1,
    cctpDomain: 0,
    tokens: {
      ETH: '0x0000000000000000000000000000000000000000',
      WETH: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
      USDC: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      WBTC: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599',
    },
    cctp: {
      tokenMessengerV2: '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d',
      messageTransmitterV2: '0x81D40F21F12A8F0E3252Bccb954D722d4c464B64',
    },
    uniswap: {
      swapRouter: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
      quoter: '0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6',
    },
  },
  starknet: {
    chainId: '0x534e5f4d41494e',
    cctpDomain: 25,
    usdc: '0x033068F6539f8e6e6b131e6B2B814e6c34A5224bC66947c47DaB9dFeE93b35fb',
    cctp: {
      tokenMessengerMinterV2:
        '0x07d421B9cA8aA32DF259965cDA8ACb93F7599F69209A41872AE84638B2A20F2a',
      messageTransmitterV2:
        '0x02EBB5777B6dD8B26ea11D68Fdf1D2c85cD2099335328Be845a28c77A8AEf183',
    },
    privacyPool: '0x040337b1af3c663e86e333bab5a4b28da8d4652a15a69beee2b677776ffe812a',
    ozAccountClassHash:
      '0x01d1777db36cdd06dd62cfde77b1b6ae06412af95d57a13dc40ac77b8a702381',
  },
} as const

export const TOKENS = {
  ETH: { symbol: 'ETH', decimals: 18 },
  USDC: { symbol: 'USDC', decimals: 6 },
  WBTC: { symbol: 'WBTC', decimals: 8 },
} as const

export const FORWARDING_HOOK_DATA =
  '0x636374702d666f72776172640000000000000000000000000000000000000000' as const

export const MIN_DELAY_MINUTES = 5
export const MAX_DELAY_MINUTES = 7 * 24 * 60
export const DEFAULT_DELAY_MINUTES = 30
export const CCTP_FAST_FINALITY_THRESHOLD = 1_000

/**
 * Reviewed mainnet POC deployments, mirrored from `deployments/*.json` (a test enforces the
 * mirror). Clients pin these and refuse runtime configuration that names other contracts, so a
 * compromised API cannot redirect the entry, the private exit, or the settlement prediction.
 */
export const POC_DEPLOYMENTS = {
  ethereum: {
    entryRouter: '0xa56A5CF49B7071C014c4B3795bC8972e9E5E3637',
    exitSettlementFactory: '0xAf40741d8A074CF61AE760af0f90EB0A1EDf8c21',
  },
  starknet: {
    cctpExitAnonymizer: '0x038bc3151769a0aa4a2d43a6dc2f3f0b0830a91ec4d61bfe1058e58eefa4b58e',
  },
} as const

/** sn_keccak entrypoint selectors the paymaster allow-lists compare against. */
export const STARKNET_SELECTORS = {
  receive_message: '0x1393a4f3bb1f09f5dfb8bb3553b247a31fef369ac2eb0c5df64a0c808244965',
  approve: '0x219209e083275171774dab1df80982e9df2096516f06319c5c6d71ae0a8480c',
  apply_actions: '0x246333a752c1ac637ff1591c5c885e27d56060d241a29aad8475072da0777db',
} as const

/**
 * Hard client-side ceilings on each AVNU `sponsored_private` fee. The paymaster response names
 * the fee; without a ceiling a malicious paymaster or relay could take almost the whole note.
 */
export const MAX_PRIVATE_FEE_BASE = 2_000_000n
export const MAX_PRIVATE_FEE_BPS = 2_000
/** Two private paymaster actions occur in a complete route: pool deposit and pool exit. */
export const MAX_PRIVATE_TOTAL_FEE_BASE = MAX_PRIVATE_FEE_BASE * 2n

/** Compare two felt/address encodings by value (leading zeros, case, decimal all normalise). */
export function feltEquals(actual: unknown, expected: unknown): boolean {
  try {
    if (
      (typeof actual !== 'string' && typeof actual !== 'number' && typeof actual !== 'bigint') ||
      (typeof expected !== 'string' && typeof expected !== 'number' && typeof expected !== 'bigint')
    ) {
      return false
    }
    return BigInt(actual) === BigInt(expected)
  } catch {
    return false
  }
}
