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
