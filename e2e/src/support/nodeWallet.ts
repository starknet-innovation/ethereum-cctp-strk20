import {
  createWalletClient,
  hexToBigInt,
  http,
  type Address,
  type EIP1193Parameters,
  type EIP1193Provider,
  type Hex,
  type LocalAccount,
  type RpcTransactionRequest,
} from 'viem'
import { mainnet } from 'viem/chains'
import type { BrowserWallet } from '../../../apps/web/src/wallet.js'

type Request = (args: EIP1193Parameters) => Promise<unknown>

/**
 * A headless stand-in for Rabby's EIP-1193 provider that lets apps/web/src/wallet.ts run in Node.
 * Account discovery is answered locally; everything else is forwarded to the JSON-RPC node. With
 * a node-managed (unlocked anvil) account, eth_sendTransaction is signed by the node itself, so
 * fork tests never hold key material.
 */
export function jsonRpcWallet(rpcUrl: string, account: Address): BrowserWallet {
  const transport = http(rpcUrl, { timeout: 60_000 })({ chain: mainnet })
  const request: Request = async ({ method, params }) => {
    switch (method) {
      case 'eth_requestAccounts':
      case 'eth_accounts':
        return [account]
      case 'wallet_switchEthereumChain':
        return null
      default:
        return transport.request({ method, params } as EIP1193Parameters)
    }
  }
  return { provider: asProvider(request), account, isRabby: false }
}

/**
 * Same shim for an operator-held canary account: eth_sendTransaction is signed locally by viem
 * and broadcast as a raw transaction, because a public mainnet RPC cannot sign for the caller.
 */
export function localAccountWallet(rpcUrl: string, account: LocalAccount): BrowserWallet {
  const transport = http(rpcUrl, { timeout: 60_000 })({ chain: mainnet })
  const wallet = createWalletClient({ account, chain: mainnet, transport: http(rpcUrl, { timeout: 60_000 }) })
  const request: Request = async ({ method, params }) => {
    switch (method) {
      case 'eth_requestAccounts':
      case 'eth_accounts':
        return [account.address]
      case 'wallet_switchEthereumChain':
        return null
      case 'eth_sendTransaction': {
        const [tx] = params as [RpcTransactionRequest]
        if (tx.from && tx.from.toLowerCase() !== account.address.toLowerCase()) {
          throw new Error('Transaction sender does not match the canary account')
        }
        return wallet.sendTransaction({
          ...(tx.to ? { to: tx.to as Address } : {}),
          ...(tx.data ? { data: tx.data as Hex } : {}),
          ...(tx.value ? { value: hexToBigInt(tx.value) } : {}),
          ...(tx.gas ? { gas: hexToBigInt(tx.gas) } : {}),
        })
      }
      default:
        return transport.request({ method, params } as EIP1193Parameters)
    }
  }
  return { provider: asProvider(request), account: account.address, isRabby: false }
}

function asProvider(request: Request): EIP1193Provider {
  const provider = {
    request,
    on: () => provider,
    removeListener: () => provider,
  }
  return provider as unknown as EIP1193Provider
}
