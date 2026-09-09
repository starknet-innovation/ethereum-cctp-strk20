import { describe, expect, it, vi } from 'vitest'
import {
  TransactionReceiptNotFoundError,
  WaitForTransactionReceiptTimeoutError,
  type Address,
  type EIP1193Provider,
  type Hex,
} from 'viem'
import type { RouteQuote } from '@privacy-round-trip/shared'
import {
  assertWalletAccount,
  isUserRejectedRequest,
  submitEntry,
  waitForEthereumReceipt,
  type BrowserWallet,
} from './wallet.js'

const FIRST = '0x1111111111111111111111111111111111111111' as Address
const SECOND = '0x2222222222222222222222222222222222222222' as Address
const HASH = `0x${'33'.repeat(32)}` as Hex
const ROUTER = '0x3333333333333333333333333333333333333333' as Address
const USDC_QUOTE: RouteQuote = {
  quoteId: 'q_wallet_guard',
  request: { inputToken: 'USDC', outputToken: 'USDC', amount: '0.000001', slippageBps: 100 },
  inputAmountBase: '1',
  estimatedBridgeAmountBase: '1',
  minimumBridgeAmountBase: '1',
  estimatedOutputAmountBase: '1',
  minimumOutputAmountBase: '1',
  entryPoolFee: 500,
  exitPoolFee: 500,
  inboundCctpMaxFeeBase: '0',
  outboundCctpMaxFeeBase: '0',
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  warnings: [],
}

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

  it.each([
    ['approval', 0n],
    ['entry with an existing allowance', 1n],
  ])('rechecks after the allowance read before the %s write', async (_label, allowance) => {
    let current = FIRST
    const send = vi.fn(async () => HASH)
    const changingProvider = {
      request: vi.fn(async ({ method }: { method: string }) => {
        if (method === 'eth_chainId') return '0x1'
        if (method === 'eth_accounts') return [current]
        if (method === 'eth_call') {
          current = SECOND
          return `0x${allowance.toString(16).padStart(64, '0')}`
        }
        if (method === 'eth_sendTransaction') return send()
        throw new Error(`Unexpected method ${method}`)
      }),
      on: vi.fn(),
      removeListener: vi.fn(),
    } as unknown as EIP1193Provider

    await expect(
      submitEntry({
        wallet: { provider: changingProvider, account: FIRST, isRabby: true },
        entryRouter: ROUTER,
        flowId: 'f_11111111111111111111111111111111',
        quote: USDC_QUOTE,
        starknetRecipient: '0x1',
      }),
    ).rejects.toThrow('Rabby changed accounts')
    expect(send).not.toHaveBeenCalled()
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

  it('bounds a receipt-race retry by the original deadline', async () => {
    let currentTime = 100
    const wait = vi
      .fn()
      .mockImplementationOnce(async () => {
        currentTime += 9
        throw new TransactionReceiptNotFoundError({ hash: HASH })
      })
      .mockResolvedValueOnce({ status: 'success' })
    const retry = vi.fn(async (delayMs: number) => {
      currentTime += delayMs
    })

    await waitForEthereumReceipt(wait, HASH, 10, retry, () => currentTime)

    expect(retry).toHaveBeenCalledWith(0)
    expect(wait).toHaveBeenNthCalledWith(2, { hash: HASH, timeout: 1 })
  })

  it('limits the final receipt window to one immediate retry', async () => {
    let currentTime = 100
    const wait = vi.fn(async () => {
      currentTime = 109
      throw new TransactionReceiptNotFoundError({ hash: HASH })
    })
    const retry = vi.fn(async (delayMs: number) => {
      currentTime += delayMs
    })

    await expect(waitForEthereumReceipt(wait, HASH, 10, retry, () => currentTime)).rejects.toBeInstanceOf(
      WaitForTransactionReceiptTimeoutError,
    )

    expect(wait).toHaveBeenCalledTimes(2)
    expect(retry).toHaveBeenCalledTimes(1)
  })
})

describe('entry submission errors', () => {
  it('recognizes direct and wrapped EIP-1193 user rejection', () => {
    expect(isUserRejectedRequest({ code: 4_001 })).toBe(true)
    expect(isUserRejectedRequest({ cause: { cause: { code: 4_001 } } })).toBe(true)
  })

  it('keeps transport and RPC failures ambiguous', () => {
    expect(isUserRejectedRequest({ code: -32_603 })).toBe(false)
    expect(isUserRejectedRequest(new Error('response lost after broadcast'))).toBe(false)
  })
})
