import { CHAIN, TOKENS, type RouteQuote, type TokenSymbol } from '@privacy-round-trip/shared'
import {
  createPublicClient,
  createWalletClient,
  custom,
  erc20Abi,
  keccak256,
  stringToHex,
  TransactionReceiptNotFoundError,
  WaitForTransactionReceiptTimeoutError,
  type Address,
  type EIP1193Provider,
  type Hex,
} from 'viem'
import { mainnet } from 'viem/chains'

const ENTRY_ABI = [
  {
    type: 'function',
    name: 'start',
    stateMutability: 'payable',
    inputs: [
      {
        name: 'intent',
        type: 'tuple',
        components: [
          { name: 'flowId', type: 'bytes32' },
          { name: 'inputAsset', type: 'uint8' },
          { name: 'amountIn', type: 'uint256' },
          { name: 'minimumUsdc', type: 'uint256' },
          { name: 'poolFee', type: 'uint24' },
          { name: 'starknetRecipient', type: 'uint256' },
          { name: 'cctpMaxFee', type: 'uint256' },
          { name: 'minFinalityThreshold', type: 'uint32' },
          { name: 'deadline', type: 'uint256' },
        ],
      },
    ],
    outputs: [{ name: 'usdcAmount', type: 'uint256' }],
  },
] as const

const SETTLEMENT_FACTORY_ABI = [
  {
    type: 'function',
    name: 'predict',
    stateMutability: 'view',
    inputs: [
      { name: 'salt', type: 'bytes32' },
      { name: 'recipient', type: 'address' },
      { name: 'outputAsset', type: 'uint8' },
      { name: 'minimumOutput', type: 'uint256' },
      { name: 'poolFee', type: 'uint24' },
      { name: 'recoverAfter', type: 'uint64' },
    ],
    outputs: [{ name: 'settlement', type: 'address' }],
  },
] as const

export interface BrowserWallet {
  provider: EIP1193Provider
  account: Address
  isRabby: boolean
}

declare global {
  interface Window {
    ethereum?: EIP1193Provider & { isRabby?: boolean }
  }
}

export async function connectRabby(): Promise<BrowserWallet> {
  const provider = window.ethereum
  if (!provider) throw new Error('Rabby was not found. Install or unlock Rabby and try again.')
  const chainId = await provider.request({ method: 'eth_chainId' })
  if (chainId !== '0x1') {
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x1' }] })
  }
  const accounts = (await provider.request({ method: 'eth_requestAccounts' })) as Address[]
  const account = accounts[0]
  if (!account) throw new Error('Rabby did not return an Ethereum account.')
  const code = (await provider.request({ method: 'eth_getCode', params: [account, 'latest'] })) as string
  if (code !== '0x') throw new Error('The POC supports Rabby EOA accounts only.')
  return { provider, account, isRabby: Boolean(provider.isRabby) }
}

export async function submitEntry(args: {
  wallet: BrowserWallet
  entryRouter: Address
  flowId: string
  quote: RouteQuote
  starknetRecipient: string
  onApproval?: (txHash: Hex) => void
}): Promise<Hex> {
  await assertWalletAccount(args.wallet)
  const transport = custom(args.wallet.provider)
  const walletClient = createWalletClient({ account: args.wallet.account, chain: mainnet, transport })
  const publicClient = createPublicClient({ chain: mainnet, transport })
  const input = args.quote.request.inputToken
  const inputAmount = BigInt(args.quote.inputAmountBase)

  if (input !== 'ETH') {
    const token = CHAIN.ethereum.tokens[input] as Address
    const allowance = await publicClient.readContract({
      address: token,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [args.wallet.account, args.entryRouter],
    })
    if (allowance < inputAmount) {
      const approval = await walletClient.writeContract({
        address: token,
        abi: erc20Abi,
        functionName: 'approve',
        args: [args.entryRouter, inputAmount],
      })
      args.onApproval?.(approval)
      try {
        await waitForEthereumReceipt(
          (parameters) => publicClient.waitForTransactionReceipt(parameters),
          approval,
          10 * 60_000,
        )
      } catch (cause) {
        if (cause instanceof Error && cause.message === 'Ethereum transaction reverted') {
          throw new Error(`${input} approval reverted`)
        }
        throw cause
      }
      // The user can select another Rabby account while the approval prompt is open. Do not send
      // the entry from the stale account captured when the route started.
      await assertWalletAccount(args.wallet)
    }
  }

  const inputAsset = { ETH: 0, USDC: 1, WBTC: 2 }[input]
  return walletClient.writeContract({
    address: args.entryRouter,
    abi: ENTRY_ABI,
    functionName: 'start',
    args: [
      {
        flowId: flowIdToBytes32(args.flowId),
        inputAsset,
        amountIn: inputAmount,
        minimumUsdc: BigInt(args.quote.minimumBridgeAmountBase),
        poolFee: args.quote.entryPoolFee,
        starknetRecipient: BigInt(args.starknetRecipient),
        cctpMaxFee: BigInt(args.quote.inboundCctpMaxFeeBase),
        minFinalityThreshold: 1_000,
        deadline: BigInt(Math.floor(Date.now() / 1000) + 15 * 60),
      },
    ],
    value: input === 'ETH' ? inputAmount : 0n,
  })
}

export async function waitForEthereumTransaction(
  wallet: BrowserWallet,
  hash: Hex,
  timeoutMs = 10 * 60_000,
): Promise<void> {
  const client = createPublicClient({ chain: mainnet, transport: custom(wallet.provider) })
  return waitForEthereumReceipt(
    (parameters) => client.waitForTransactionReceipt(parameters),
    hash,
    timeoutMs,
  )
}

type ReceiptWaiter = (parameters: { hash: Hex; timeout: number }) => Promise<{ status: string }>

/**
 * Rabby's RPC can observe a pending transaction or its replacement one block before the matching
 * receipt is available. viem's replacement check currently surfaces that normal indexing race as
 * TransactionReceiptNotFoundError instead of continuing to poll, so retry it within our original
 * deadline. Other errors (including a genuine overall timeout) still stop the flow.
 */
export async function waitForEthereumReceipt(
  waitForReceipt: ReceiptWaiter,
  hash: Hex,
  timeoutMs: number,
  retry: () => Promise<void> = () => sleep(1_000),
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (true) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new WaitForTransactionReceiptTimeoutError({ hash })
    try {
      const receipt = await waitForReceipt({ hash, timeout: remaining })
      if (receipt.status !== 'success') throw new Error('Ethereum transaction reverted')
      return
    } catch (cause) {
      if (!(cause instanceof TransactionReceiptNotFoundError)) throw cause
      if (Date.now() >= deadline) throw new WaitForTransactionReceiptTimeoutError({ hash })
      await retry()
    }
  }
}

/** Ensure a cached route still belongs to Rabby's currently selected mainnet account. */
export async function assertWalletAccount(wallet: BrowserWallet): Promise<void> {
  const chainId = await wallet.provider.request({ method: 'eth_chainId' })
  if (chainId !== '0x1') throw new Error('Switch Rabby to Ethereum mainnet and try again.')

  const accounts = (await wallet.provider.request({ method: 'eth_accounts' })) as Address[]
  const current = accounts[0]
  if (!current) throw new Error('Rabby is disconnected. Reconnect it and try again.')
  if (current.toLowerCase() !== wallet.account.toLowerCase()) {
    throw new Error(
      `Rabby changed accounts from ${short(wallet.account)} to ${short(current)}. Start again with the currently selected account.`,
    )
  }
}

/**
 * Status of a transaction whose hash was recorded at submission time. 'unknown' means no receipt
 * within the polling window, so the transaction may be pending or dropped.
 */
export async function ethereumTransactionStatus(
  wallet: BrowserWallet,
  hash: Hex,
  attempts = 6,
): Promise<'success' | 'reverted' | 'unknown'> {
  const client = createPublicClient({ chain: mainnet, transport: custom(wallet.provider) })
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const receipt = await client.getTransactionReceipt({ hash })
      return receipt.status === 'success' ? 'success' : 'reverted'
    } catch {
      if (attempt < attempts - 1) await sleep(5_000)
    }
  }
  return 'unknown'
}

export async function usdcBalanceAt(wallet: BrowserWallet, owner: Address): Promise<bigint> {
  const client = createPublicClient({ chain: mainnet, transport: custom(wallet.provider) })
  return client.readContract({
    address: CHAIN.ethereum.tokens.USDC,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [owner],
  })
}

export async function predictSettlement(args: {
  wallet: BrowserWallet
  factory: Address
  salt: Hex
  recipient: Address
  outputToken: TokenSymbol
  minimumOutput: bigint
  poolFee: 100 | 500 | 3000 | 10000
  recoverAfter: number
}): Promise<Address> {
  const client = createPublicClient({ chain: mainnet, transport: custom(args.wallet.provider) })
  return client.readContract({
    address: args.factory,
    abi: SETTLEMENT_FACTORY_ABI,
    functionName: 'predict',
    args: [
      args.salt,
      args.recipient,
      { ETH: 0, USDC: 1, WBTC: 2 }[args.outputToken],
      args.minimumOutput,
      args.poolFee,
      BigInt(args.recoverAfter),
    ],
  })
}

export async function waitForUsdcAt(
  wallet: BrowserWallet,
  owner: Address,
  timeoutMs = 30 * 60_000,
): Promise<bigint> {
  const client = createPublicClient({ chain: mainnet, transport: custom(wallet.provider) })
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const balance = await client.readContract({
      address: CHAIN.ethereum.tokens.USDC,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [owner],
    })
    if (balance > 0n) return balance
    await sleep(8_000)
  }
  throw new Error('Timed out waiting for the CCTP mint on Ethereum')
}

export function formatTokenAmount(amount: string, token: TokenSymbol): string {
  const decimals = TOKENS[token].decimals
  const value = BigInt(amount)
  const whole = value / 10n ** BigInt(decimals)
  const fraction = (value % 10n ** BigInt(decimals)).toString().padStart(decimals, '0').slice(0, 6)
  return `${whole}.${fraction.replace(/0+$/, '') || '0'} ${token}`
}

function flowIdToBytes32(id: string): Hex {
  return keccak256(stringToHex(id))
}

function short(value: string): string {
  return `${value.slice(0, 6)}\u2026${value.slice(-4)}`
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
