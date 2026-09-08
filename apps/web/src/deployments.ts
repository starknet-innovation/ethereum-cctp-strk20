import { POC_DEPLOYMENTS, feltEquals, type PublicConfig } from '@privacy-round-trip/shared'

export type PinnedConfig = PublicConfig & {
  ethereum: { entryRouter: string; exitSettlementFactory: string }
  starknet: { cctpExitAnonymizer: string }
}

/**
 * The API tells the browser which contracts to use, but the browser only trusts the reviewed
 * deployments compiled into this bundle. A compromised API could otherwise name an attacker's
 * exit anonymizer (receiving the whole private note) or an attacker's settlement factory (making
 * the browser's `predict` check pass against the wrong contract).
 */
export function assertPinnedDeployments(config: PublicConfig): asserts config is PinnedConfig {
  const mismatches: string[] = []
  if (!sameAddress(config.ethereum.entryRouter, POC_DEPLOYMENTS.ethereum.entryRouter)) {
    mismatches.push('Ethereum entry router')
  }
  if (!sameAddress(config.ethereum.exitSettlementFactory, POC_DEPLOYMENTS.ethereum.exitSettlementFactory)) {
    mismatches.push('Ethereum settlement factory')
  }
  if (!feltEquals(config.starknet.cctpExitAnonymizer, POC_DEPLOYMENTS.starknet.cctpExitAnonymizer)) {
    mismatches.push('Starknet CCTP exit anonymizer')
  }
  if (mismatches.length > 0) {
    throw new Error(
      `API configuration does not match the reviewed mainnet deployments (${mismatches.join(', ')}). Refusing to continue.`,
    )
  }
}

function sameAddress(actual: string | undefined, expected: string): boolean {
  return typeof actual === 'string' && actual.toLowerCase() === expected.toLowerCase()
}
