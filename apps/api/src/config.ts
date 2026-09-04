import { z } from 'zod'

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/)
const felt = z.string().regex(/^0x[0-9a-fA-F]{1,64}$/)

const schema = z.object({
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(8787),
  CORS_ORIGIN: z.string().url().default('http://localhost:5173'),
  ETHEREUM_RPC_URL: z.string().url().optional(),
  STARKNET_RPC_URL: z.string().url().optional(),
  PROVER_URL: z.string().url().optional(),
  DISCOVERY_URL: z.string().url().optional(),
  PAYMASTER_URL: z.string().url().optional(),
  ETHEREUM_ENTRY_ROUTER: address.optional(),
  ETHEREUM_EXIT_SETTLEMENT_FACTORY: address.optional(),
  STARKNET_CCTP_EXIT_ANONYMIZER: felt.optional(),
  ETHEREUM_RELAYER_PRIVATE_KEY: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional(),
  FLOW_TOKEN_SECRET: z.string().min(32).optional(),
  ESTIMATED_STARKNET_FEES_USDC: z.coerce.number().positive().default(2),
})

export type ApiConfig = z.infer<typeof schema>

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  return schema.parse(blankToUndefined(env))
}

function blankToUndefined(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).map(([key, value]) => [key, value === '' ? undefined : value]),
  )
}

export function readiness(config: ApiConfig): string[] {
  const required: Array<[keyof ApiConfig, unknown]> = [
    ['ETHEREUM_RPC_URL', config.ETHEREUM_RPC_URL],
    ['STARKNET_RPC_URL', config.STARKNET_RPC_URL],
    ['PROVER_URL', config.PROVER_URL],
    ['DISCOVERY_URL', config.DISCOVERY_URL],
    ['PAYMASTER_URL', config.PAYMASTER_URL],
    ['ETHEREUM_ENTRY_ROUTER', config.ETHEREUM_ENTRY_ROUTER],
    ['ETHEREUM_EXIT_SETTLEMENT_FACTORY', config.ETHEREUM_EXIT_SETTLEMENT_FACTORY],
    ['STARKNET_CCTP_EXIT_ANONYMIZER', config.STARKNET_CCTP_EXIT_ANONYMIZER],
    ['ETHEREUM_RELAYER_PRIVATE_KEY', config.ETHEREUM_RELAYER_PRIVATE_KEY],
    ['FLOW_TOKEN_SECRET', config.FLOW_TOKEN_SECRET],
  ]
  return required.filter(([, value]) => !value).map(([name]) => name)
}
