import { describe, expect, it, vi } from 'vitest'
import {
  TransactionReceiptNotFoundError,
  WaitForTransactionReceiptTimeoutError,
  type Address,
  type EIP1193Provider,
  type Hex,
} from 'viem'
import { assertWalletAccount, waitForEthereumReceipt, type BrowserWallet } from './wallet.js'

const FIRST = '0x1111111111111111111111111111111111111111' as Address
const SECOND = '0x2222222222222222222222222222222222222222' as Address
const HASH = `0x${'33'.repeat(32)}` as Hex

function provider(responses: { chainId?: string; accounts?: Address[] }): EIP1193Provider {
  return {
    request: vi.fn(async ({ method }) => {
      if (method === 'eth_chainId') return responses.chainId ?? '0x1'
      if (method === 'eth_accounts') return responses.accounts ?? [FIRST]
      throw new Error(`Unexpected method ${method}`)
    }),
    on: vi.fn(),
    removeListener: vi.fn(),
  } as EIP1193Provider
}

function wallet(current: Address[] = [FIRST]): BrowserWallet {
  return { provider: provider({ accounts: current }), account: FIRST, isRabby: true }
}

describe('wallet account guard', () => {
  it('accepts the cached account only while it is still selected on mainnet', async () => {
    await expect(assertWalletAccount(wallet())).resolves.toBeUndefined()
  })

  it('stops before submission when Rabby changed accounts', async () => {
    await expect(assertWalletAccount(wallet([SECOND]))).rejects.toThrow(
      'Rabby changed accounts from 0x1111\u20261111 to 0x2222\u20262222',
    )
  })

  it('stops before submission when Rabby changed networks', async () => {
    const connected = wallet()
    connected.provider = provider({ chainId: '0xaa36a7', accounts: [FIRST] })
    await expect(assertWalletAccount(connected)).rejects.toThrow('Ethereum mainnet')
  })
})

describe('Ethereum receipt polling', () => {
  it('retries a transient replacement-receipt visibility race', async () => {
    const wait = vi
      .fn()
      .mockRejectedValueOnce(new TransactionReceiptNotFoundError({ hash: HASH }))
      .mockResolvedValueOnce({ status: 'success' })

    await expect(waitForEthereumReceipt(wait, HASH, 10_000, async () => undefined)).resolves.toBeUndefined()
    expect(wait).toHaveBeenCalledTimes(2)
  })

  it('does not hide transaction failures', async () => {
    await expect(
      waitForEthereumReceipt(async () => ({ status: 'reverted' }), HASH, 10_000),
    ).rejects.toThrow('Ethereum transaction reverted')
  })

  it('preserves genuine viem timeouts', async () => {
    const timeout = new WaitForTransactionReceiptTimeoutError({ hash: HASH })
    await expect(waitForEthereumReceipt(async () => Promise.reject(timeout), HASH, 10_000)).rejects.toBe(timeout)
  })
})
