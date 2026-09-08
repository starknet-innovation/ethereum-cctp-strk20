import type { Account } from 'viem'

/** Ensure a simulated request cannot downgrade a local signer to eth_sendTransaction. */
export function bindLocalAccount<T extends { account?: unknown }>(request: T, account: Account) {
  return { ...request, account }
}
