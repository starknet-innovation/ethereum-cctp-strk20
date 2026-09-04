import { tokenSymbolSchema } from '@privacy-round-trip/shared'
import { z } from 'zod'

const url = z.string().url()
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/)
const felt = z.string().regex(/^0x[0-9a-fA-F]{1,64}$/)

const schema = z.object({
  ETHEREUM_RPC_URL: url.optional(),
  STARKNET_RPC_URL: url.optional(),
  ETHEREUM_FORK_BLOCK: z.coerce.number().int().positive().optional(),
  ETHEREUM_ENTRY_ROUTER: address.optional(),
  ETHEREUM_EXIT_SETTLEMENT_FACTORY: address.optional(),
  STARKNET_CCTP_EXIT_ANONYMIZER: felt.optional(),
  E2E_API_URL: url.optional(),
  E2E_ALLOW_EMPTY: z.enum(['1', 'true']).optional(),
  E2E_MAINNET_CANARY: z.string().optional(),
  E2E_ETHEREUM_PRIVATE_KEY: z.string().min(1).optional(),
  E2E_RECIPIENT: address.optional(),
  E2E_INPUT_TOKEN: tokenSymbolSchema.default('USDC'),
  E2E_OUTPUT_TOKEN: tokenSymbolSchema.default('USDC'),
  E2E_AMOUNT: z.string().regex(/^\d+(\.\d+)?$/).default('10'),
  E2E_DELAY_MINUTES: z.coerce.number().int().min(5).max(7 * 24 * 60).default(5),
  E2E_MAX_BRIDGE_USDC: z.coerce.number().positive().default(25),
})

export type E2eEnv = z.infer<typeof schema>

export const env: E2eEnv = schema.parse(
  Object.fromEntries(
    Object.entries(process.env).map(([key, value]) => [key, value === '' ? undefined : value]),
  ),
)

/** Exact value E2E_MAINNET_CANARY must hold before the real-funds canary is allowed to run. */
export const CANARY_ARMED_VALUE = 'I_UNDERSTAND_THIS_SPENDS_REAL_MAINNET_FUNDS'

/** Obviously synthetic 32-byte value for lifecycle tests that never touch a chain. */
export const SYNTHETIC_TX_HASH = `0x${'11'.repeat(32)}` as const

export const UNISWAP_FEE_TIERS = [100, 500, 3_000, 10_000] as const

/** Read a configured value inside a test that is only collected when the value is present. */
export function requireEnv<K extends keyof E2eEnv>(key: K): NonNullable<E2eEnv[K]> {
  const value = env[key]
  if (value === undefined || value === null) throw new Error(`${key} is required for this test`)
  return value as NonNullable<E2eEnv[K]>
}
