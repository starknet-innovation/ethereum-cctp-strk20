import { CHAIN } from '@privacy-round-trip/shared'
import {
  createPublicClient,
  hexToBigInt,
  hexToNumber,
  http,
  parseEventLogs,
  slice,
  type Address,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
} from 'viem'
import { mainnet } from 'viem/chains'

export function publicClient(rpcUrl: string): PublicClient {
  return createPublicClient({ chain: mainnet, transport: http(rpcUrl, { timeout: 60_000 }) })
}

export const ERC20_METADATA_ABI = [
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'totalSupply', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
] as const

export const TOKEN_MESSENGER_V2_ABI = [
  { type: 'function', name: 'localMessageTransmitter', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'localMinter', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'messageBodyVersion', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint32' }] },
  {
    type: 'function',
    name: 'remoteTokenMessengers',
    stateMutability: 'view',
    inputs: [{ name: 'domain', type: 'uint32' }],
    outputs: [{ type: 'bytes32' }],
  },
  {
    type: 'event',
    name: 'DepositForBurn',
    inputs: [
      { name: 'burnToken', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
      { name: 'depositor', type: 'address', indexed: true },
      { name: 'mintRecipient', type: 'bytes32', indexed: false },
      { name: 'destinationDomain', type: 'uint32', indexed: false },
      { name: 'destinationTokenMessenger', type: 'bytes32', indexed: false },
      { name: 'destinationCaller', type: 'bytes32', indexed: false },
      { name: 'maxFee', type: 'uint256', indexed: false },
      { name: 'minFinalityThreshold', type: 'uint32', indexed: true },
      { name: 'hookData', type: 'bytes', indexed: false },
    ],
  },
] as const

export const MESSAGE_TRANSMITTER_V2_ABI = [
  { type: 'function', name: 'localDomain', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint32' }] },
  { type: 'function', name: 'version', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint32' }] },
  { type: 'function', name: 'paused', stateMutability: 'view', inputs: [], outputs: [{ type: 'bool' }] },
  {
    type: 'event',
    name: 'MessageSent',
    inputs: [{ name: 'message', type: 'bytes', indexed: false }],
  },
] as const

export const UNISWAP_PERIPHERY_ABI = [
  { type: 'function', name: 'WETH9', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'factory', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
] as const

export const SWAP_ROUTER_ABI = [
  {
    type: 'function',
    name: 'exactInputSingle',
    stateMutability: 'payable',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          { name: 'tokenIn', type: 'address' },
          { name: 'tokenOut', type: 'address' },
          { name: 'fee', type: 'uint24' },
          { name: 'recipient', type: 'address' },
          { name: 'deadline', type: 'uint256' },
          { name: 'amountIn', type: 'uint256' },
          { name: 'amountOutMinimum', type: 'uint256' },
          { name: 'sqrtPriceLimitX96', type: 'uint160' },
        ],
      },
    ],
    outputs: [{ name: 'amountOut', type: 'uint256' }],
  },
] as const

export const ENTRY_ROUTER_VIEWS_ABI = [
  { type: 'function', name: 'usdc', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'wbtc', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'weth', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'swapRouter', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'tokenMessenger', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'STARKNET_DOMAIN', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint32' }] },
  {
    type: 'function',
    name: 'started',
    stateMutability: 'view',
    inputs: [{ name: 'flowId', type: 'bytes32' }],
    outputs: [{ type: 'bool' }],
  },
] as const

const SETTLEMENT_PARAMS = [
  { name: 'salt', type: 'bytes32' },
  { name: 'recipient', type: 'address' },
  { name: 'outputAsset', type: 'uint8' },
  { name: 'minimumOutput', type: 'uint256' },
  { name: 'poolFee', type: 'uint24' },
  { name: 'recoverAfter', type: 'uint64' },
] as const

export const FACTORY_ABI = [
  { type: 'function', name: 'usdc', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'wbtc', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'weth', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'swapRouter', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  {
    type: 'function',
    name: 'settlements',
    stateMutability: 'view',
    inputs: [{ name: 'salt', type: 'bytes32' }],
    outputs: [{ type: 'address' }],
  },
  { type: 'function', name: 'predict', stateMutability: 'view', inputs: SETTLEMENT_PARAMS, outputs: [{ type: 'address' }] },
  { type: 'function', name: 'create', stateMutability: 'nonpayable', inputs: SETTLEMENT_PARAMS, outputs: [{ type: 'address' }] },
] as const

export const SETTLEMENT_ABI = [
  { type: 'function', name: 'recipient', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'outputAsset', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  { type: 'function', name: 'minimumOutput', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'poolFee', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint24' }] },
  { type: 'function', name: 'recoverAfter', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint64' }] },
  { type: 'function', name: 'settled', stateMutability: 'view', inputs: [], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'settle', stateMutability: 'nonpayable', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'recoverAsUsdc', stateMutability: 'nonpayable', inputs: [], outputs: [] },
  { type: 'error', name: 'AlreadySettled', inputs: [] },
  { type: 'error', name: 'EmptyBalance', inputs: [] },
  { type: 'error', name: 'RecoveryNotReady', inputs: [] },
] as const

export const OUTPUT_ASSET_INDEX = { ETH: 0, USDC: 1, WBTC: 2 } as const

export interface DepositForBurnEvent {
  burnToken: Address
  amount: bigint
  depositor: Address
  mintRecipient: Hex
  destinationDomain: number
  destinationTokenMessenger: Hex
  destinationCaller: Hex
  maxFee: bigint
  minFinalityThreshold: number
  hookData: Hex
}

/** The single CCTP V2 DepositForBurn emitted by the pinned TokenMessengerV2 in a receipt. */
export function findDepositForBurn(receipt: TransactionReceipt): DepositForBurnEvent {
  const logs = parseEventLogs({
    abi: TOKEN_MESSENGER_V2_ABI,
    eventName: 'DepositForBurn',
    logs: receipt.logs,
  }).filter((log) => log.address.toLowerCase() === CHAIN.ethereum.cctp.tokenMessengerV2.toLowerCase())
  const [log] = logs
  if (!log || logs.length !== 1) {
    throw new Error(`expected exactly one DepositForBurn from TokenMessengerV2, found ${logs.length}`)
  }
  return log.args
}

/** The raw CCTP V2 message bytes emitted by the pinned MessageTransmitterV2 in a receipt. */
export function findMessageSent(receipt: TransactionReceipt): Hex {
  const logs = parseEventLogs({
    abi: MESSAGE_TRANSMITTER_V2_ABI,
    eventName: 'MessageSent',
    logs: receipt.logs,
  }).filter((log) => log.address.toLowerCase() === CHAIN.ethereum.cctp.messageTransmitterV2.toLowerCase())
  const [log] = logs
  if (!log || logs.length !== 1) {
    throw new Error(`expected exactly one MessageSent from MessageTransmitterV2, found ${logs.length}`)
  }
  return log.args.message
}

export interface CctpMessageV2 {
  version: number
  sourceDomain: number
  destinationDomain: number
  nonce: Hex
  sender: Hex
  recipient: Hex
  destinationCaller: Hex
  minFinalityThreshold: number
  finalityThresholdExecuted: number
  body: {
    version: number
    burnToken: Hex
    mintRecipient: Hex
    amount: bigint
    messageSender: Hex
    maxFee: bigint
    feeExecuted: bigint
    expirationBlock: bigint
    hookData: Hex
  }
}

/**
 * Decode a CCTP V2 message (MessageV2 header + BurnMessageV2 body) exactly as Circle's
 * attestation service and the Starknet MessageTransmitter will read it.
 */
export function decodeCctpMessage(message: Hex): CctpMessageV2 {
  const u32 = (offset: number) => hexToNumber(slice(message, offset, offset + 4))
  const b32 = (offset: number) => slice(message, offset, offset + 32)
  const u256 = (offset: number) => hexToBigInt(slice(message, offset, offset + 32))
  const HEADER = 148
  const bodyAt = (offset: number) => HEADER + offset
  return {
    version: u32(0),
    sourceDomain: u32(4),
    destinationDomain: u32(8),
    nonce: b32(12),
    sender: b32(44),
    recipient: b32(76),
    destinationCaller: b32(108),
    minFinalityThreshold: u32(140),
    finalityThresholdExecuted: u32(144),
    body: {
      version: u32(bodyAt(0)),
      burnToken: b32(bodyAt(4)),
      mintRecipient: b32(bodyAt(36)),
      amount: u256(bodyAt(68)),
      messageSender: b32(bodyAt(100)),
      maxFee: u256(bodyAt(132)),
      feeExecuted: u256(bodyAt(164)),
      expirationBlock: u256(bodyAt(196)),
      hookData: message.length > 2 * bodyAt(228) + 2 ? slice(message, bodyAt(228)) : '0x',
    },
  }
}

export function randomBytes32(): Hex {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`
}
