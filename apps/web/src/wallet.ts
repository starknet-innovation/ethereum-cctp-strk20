import { CHAIN, TOKENS, type RouteQuote, type TokenSymbol } from '@privacy-round-trip/shared'
import {
  createPublicClient,
  createWalletClient,
  custom,
  erc20Abi,
  keccak256,
  stringToHex,
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
      const receipt = await publicClient.waitForTransactionReceipt({ hash: approval })
      if (receipt.status !== 'success') throw new Error(`${input} approval reverted`)
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

export async function waitForEthereumTransaction(wallet: BrowserWallet, hash: Hex): Promise<void> {
  const client = createPublicClient({ chain: mainnet, transport: custom(wallet.provider) })
  const receipt = await client.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success') throw new Error('Ethereum transaction reverted')
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
