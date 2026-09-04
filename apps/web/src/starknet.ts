import { createPrivateTransfers } from '@starkware-libs/starknet-privacy-sdk'
import { CHAIN, FORWARDING_HOOK_DATA } from '@privacy-round-trip/shared'
import {
  Account,
  hash,
  PaymasterRpc,
  RpcProvider,
  stark,
  type Call,
  type TypedData,
} from 'starknet'
import { api, type CircleMessage } from './api.js'
import type { EphemeralIdentity } from './identity.js'
import { StarkscanProofProvider } from './starkscanProofProvider.js'

const RPC_URL = `${api.baseUrl}/proxy/starknet-rpc`
const PAYMASTER_URL = `${api.baseUrl}/proxy/paymaster`
const DISCOVERY_URL = `${api.baseUrl}/proxy/discovery`
const PROVING_BLOCK_DEPTH = 10
const POLL_MS = 5_000

interface FeeAction {
  type: 'withdraw'
  recipient: string
  token: string
  amount: string
}

interface PaymasterCall {
  to: string
  selector: string
  calldata: string[]
}

interface CallAndProof {
  call: Call
  proof: { data: string; proofFacts: string[] }
}

export async function waitForCircleAttestation(
  ethereumTxHash: string,
  timeoutMs = 30 * 60_000,
): Promise<CircleMessage> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const result = await api.circleMessages(ethereumTxHash)
    const complete = result.messages?.find(
      (message) => message.status === 'complete' && message.attestation !== 'PENDING',
    )
    if (complete?.message.startsWith('0x') && complete.attestation.startsWith('0x')) return complete
    await sleep(8_000)
  }
  throw new Error('Circle attestation timed out. Keep this tab open and retry when Iris recovers.')
}

/** Deploy the browser-generated account and claim the inbound CCTP mint in one sponsored tx. */
export async function sponsoredMint(
  identity: EphemeralIdentity,
  message: `0x${string}`,
  attestation: `0x${string}`,
): Promise<string> {
  const provider = providerForApp()
  const paymaster = new PaymasterRpc({ nodeUrl: PAYMASTER_URL })
  const account = new Account({
    provider,
    address: identity.address,
    signer: identity.signer,
    paymaster,
  })
  const deployed = await isDeployed(provider, identity.address)
  const call: Call = {
    contractAddress: CHAIN.starknet.cctp.messageTransmitterV2,
    entrypoint: 'receive_message',
    calldata: [
      ...bytesToByteArrayCalldata(hexToBytes(message)),
      ...bytesToByteArrayCalldata(hexToBytes(attestation)),
    ],
  }
  const options = {
    feeMode: { mode: 'sponsored' as const },
    ...(deployed
      ? {}
      : {
          deploymentData: {
            address: identity.address,
            class_hash: identity.classHash,
            salt: identity.salt,
            calldata: [identity.publicKey],
            version: 1 as const,
          },
        }),
  }
  const result = await account.executePaymasterTransaction([call], options)
  await waitForSuccessfulTransaction(provider, result.transaction_hash)
  return result.transaction_hash
}

export async function starknetUsdcBalance(owner: string): Promise<bigint> {
  const result = await providerForApp().callContract({
    contractAddress: CHAIN.starknet.usdc,
    entrypoint: 'balance_of',
    calldata: [owner],
  })
  return u256FromParts(result[0] ?? '0', result[1] ?? '0')
}

export async function waitForPrivacyProvingReadyAfterTx(
  txHash: string,
  timeoutMs = 6 * 60_000,
): Promise<void> {
  const provider = providerForApp()
  const receipt = await provider.waitForTransaction(txHash)
  const rawBlock = (receipt as { block_number?: number | string }).block_number
  const transactionBlock = typeof rawBlock === 'number' ? rawBlock : Number(rawBlock)
  if (!Number.isFinite(transactionBlock)) return

  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if ((await provider.getBlockNumber()) - transactionBlock >= PROVING_BLOCK_DEPTH + 1) return
    await sleep(POLL_MS)
  }
  throw new Error('Starknet is not proof-ready yet. Keep this tab open and retry shortly.')
}

/** Shield all transfer-scoped USDC, paying the AVNU fee from the same deposit. */
export async function sponsoredPrivacyDeposit(args: {
  identity: EphemeralIdentity
  amount: bigint
}): Promise<{ txHash: string; privateAmount: bigint }> {
  if (args.amount <= 0n) throw new Error('No Starknet USDC is available to shield')
  const mode = privateFeeMode()
  const approve = toPaymasterCall({
    contractAddress: CHAIN.starknet.usdc,
    entrypoint: 'approve',
    calldata: [CHAIN.starknet.privacyPool, ...u256(args.amount)],
  })
  const built = await paymasterRpc<{
    type: 'invoke_and_apply_action'
    typed_data: TypedData
    fee_action: FeeAction
  }>('paymaster_buildTransaction', {
    transaction: {
      type: 'invoke_and_apply_action',
      invoke: { user_address: felt(args.identity.address), calls: [approve] },
      apply_action: { pool_address: felt(CHAIN.starknet.privacyPool) },
    },
    parameters: { version: '0x1', fee_mode: mode },
  })
  const fee = validateFee(built.fee_action, CHAIN.starknet.usdc, args.amount)

  const result = await withFreshProvingBlock(() => {
    const builder = poolClient(args.identity)
      .build({
        autoRegister: true,
        autoSetup: true,
        autoDiscover: { notes: 'refresh', channels: 'refresh' },
        autoSelectNotes: 'naive',
      })
      .surplusTo(args.identity.address)
    builder.with(CHAIN.starknet.usdc, (token: any) =>
      token
        .deposit({ amount: args.amount })
        .withdraw({ amount: fee, recipient: built.fee_action.recipient }),
    )
    return builder
  })

  const signature = stark.signatureToHexArray(
    await args.identity.signer.signMessage(built.typed_data, args.identity.address),
  )
  const response = await executeInvokeAndApply({
    identity: args.identity,
    typedData: built.typed_data,
    signature,
    callAndProof: result.callAndProof as CallAndProof,
    mode,
  })
  await waitForSuccessfulTransaction(providerForApp(), response.transaction_hash)
  return { txHash: response.transaction_hash, privateAmount: args.amount - fee }
}

/** Spend the private note directly into the CCTP anonymizer and start the return bridge. */
export async function sponsoredPrivacyExit(args: {
  identity: EphemeralIdentity
  privateAmount: bigint
  settlement: string
  cctpExitAnonymizer: string
  cctpMaxFee: bigint
}): Promise<string> {
  const mode = privateFeeMode()
  const built = await paymasterRpc<{ type: 'apply_action'; fee_action: FeeAction }>(
    'paymaster_buildTransaction',
    {
      transaction: {
        type: 'apply_action',
        apply_action: { pool_address: felt(CHAIN.starknet.privacyPool) },
      },
      parameters: { version: '0x1', fee_mode: mode },
    },
  )
  const fee = validateFee(built.fee_action, CHAIN.starknet.usdc, args.privateAmount)
  const amountToBridge = args.privateAmount - fee
  if (amountToBridge <= args.cctpMaxFee) {
    throw new Error('Private balance is below the privacy and return-bridge fees')
  }

  const result = await withFreshProvingBlock(() => {
    const builder = poolClient(args.identity)
      .build({
        autoDiscover: { notes: 'refresh', channels: 'refresh' },
        autoSelectNotes: 'all',
      })
      .surplusTo(args.identity.address)
    builder.with(CHAIN.starknet.usdc, (token: any) =>
      token
        .withdraw({ amount: amountToBridge, recipient: args.cctpExitAnonymizer })
        .withdraw({ amount: fee, recipient: built.fee_action.recipient }),
    )
    builder.invoke(() => ({
      contractAddress: args.cctpExitAnonymizer,
      calldata: [
        ...u256(BigInt(args.settlement)),
        ...u256(args.cctpMaxFee),
        '1000',
        ...bytesToByteArrayCalldata(hexToBytes(FORWARDING_HOOK_DATA)),
      ],
    }))
    return builder
  })

  const callAndProof = result.callAndProof as CallAndProof
  const response = await paymasterRpc<{ transaction_hash: string }>('paymaster_executeTransaction', {
    transaction: {
      type: 'apply_action',
      apply_action: {
        apply_actions_call: toPaymasterCall(callAndProof.call),
        proof: callAndProof.proof.data,
        proof_facts: callAndProof.proof.proofFacts.map(felt),
      },
    },
    parameters: { version: '0x1', fee_mode: mode },
  })
  await waitForSuccessfulTransaction(providerForApp(), response.transaction_hash)
  return response.transaction_hash
}

async function executeInvokeAndApply(args: {
  identity: EphemeralIdentity
  typedData: TypedData
  signature: string[]
  callAndProof: CallAndProof
  mode: ReturnType<typeof privateFeeMode>
}): Promise<{ transaction_hash: string }> {
  return paymasterRpc('paymaster_executeTransaction', {
    transaction: {
      type: 'invoke_and_apply_action',
      invoke: {
        user_address: felt(args.identity.address),
        typed_data: args.typedData,
        signature: args.signature,
      },
      apply_action: {
        apply_actions_call: toPaymasterCall(args.callAndProof.call),
        proof: args.callAndProof.proof.data,
        proof_facts: args.callAndProof.proof.proofFacts.map(felt),
      },
    },
    parameters: { version: '0x1', fee_mode: args.mode },
  })
}

function poolClient(identity: EphemeralIdentity) {
  return createPrivateTransfers({
    account: { address: identity.address, signer: identity.signer },
    viewingKeyProvider: { getViewingKey: async () => identity.viewingKey },
    provingProvider: new StarkscanProofProvider({
      apiBaseUrl: api.baseUrl,
      rpcUrl: RPC_URL,
      poolAddress: CHAIN.starknet.privacyPool,
    }),
    discoveryProvider: { url: DISCOVERY_URL },
    poolContractAddress: CHAIN.starknet.privacyPool,
  })
}

async function withFreshProvingBlock<T extends { execute(options: { provingBlockId: number }): Promise<unknown> }>(
  makeBuilder: () => T,
): Promise<any> {
  const provider = providerForApp()
  let lastError: unknown
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const provingBlockId = Math.max(0, (await provider.getBlockNumber()) - PROVING_BLOCK_DEPTH)
    try {
      return await makeBuilder().execute({ provingBlockId })
    } catch (error) {
      lastError = error
      if (!isRetryableProofError(error) || attempt === 5) throw error
      await sleep(POLL_MS)
    }
  }
  throw lastError
}

async function paymasterRpc<T>(method: string, params: unknown): Promise<T> {
  const response = await fetch(PAYMASTER_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method, params }),
  })
  const json = (await response.json()) as {
    result?: T
    error?: { code?: number; message?: string; data?: unknown }
  }
  if (!response.ok || json.error || json.result === undefined) {
    const detail = json.error?.data ? `: ${JSON.stringify(json.error.data)}` : ''
    throw new Error(`Paymaster ${method} failed: ${json.error?.message ?? response.status}${detail}`)
  }
  return json.result
}

function privateFeeMode() {
  return {
    mode: 'sponsored_private' as const,
    pool_fee_token: felt(CHAIN.starknet.usdc),
    tip: 'normal' as const,
  }
}

function validateFee(action: FeeAction, token: string, available: bigint): bigint {
  if (action.type !== 'withdraw' || felt(action.token) !== felt(token)) {
    throw new Error('Paymaster returned an invalid private fee token')
  }
  const fee = BigInt(action.amount)
  if (fee < 0n || fee >= available) throw new Error('Paymaster fee consumes the transfer')
  return fee
}

function toPaymasterCall(call: Call): PaymasterCall {
  const calldata = Array.isArray(call.calldata) ? call.calldata : []
  return {
    to: felt(call.contractAddress),
    selector: felt(hash.getSelectorFromName(call.entrypoint)),
    calldata: calldata.map((value) => felt(value)),
  }
}

function felt(value: unknown): string {
  if (typeof value === 'bigint' || typeof value === 'number') return `0x${BigInt(value).toString(16)}`
  if (typeof value !== 'string' || !/^(0x[0-9a-fA-F]+|\d+)$/.test(value)) {
    throw new Error('Expected a felt-compatible value')
  }
  return `0x${BigInt(value).toString(16)}`
}

function u256(value: bigint): [string, string] {
  if (value < 0n) throw new Error('u256 cannot be negative')
  const mask = (1n << 128n) - 1n
  return [(value & mask).toString(), (value >> 128n).toString()]
}

function u256FromParts(low: string, high: string): bigint {
  return BigInt(low) | (BigInt(high) << 128n)
}

function hexToBytes(value: string): Uint8Array {
  const hex = value.startsWith('0x') ? value.slice(2) : value
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) throw new Error('Invalid hex bytes')
  return Uint8Array.from(hex.match(/.{2}/g) ?? [], (byte) => Number.parseInt(byte, 16))
}

function bytesToByteArrayCalldata(bytes: Uint8Array): string[] {
  const fullWords = Math.floor(bytes.length / 31)
  const output = [fullWords.toString()]
  for (let index = 0; index < fullWords; index += 1) {
    let word = 0n
    for (let offset = 0; offset < 31; offset += 1) {
      word = (word << 8n) | BigInt(bytes[index * 31 + offset]!)
    }
    output.push(word.toString())
  }
  let pending = 0n
  const remaining = bytes.length - fullWords * 31
  for (let index = 0; index < remaining; index += 1) {
    pending = (pending << 8n) | BigInt(bytes[fullWords * 31 + index]!)
  }
  output.push(pending.toString(), remaining.toString())
  return output
}

function providerForApp(): RpcProvider {
  return new RpcProvider({ nodeUrl: RPC_URL })
}

async function isDeployed(provider: RpcProvider, address: string): Promise<boolean> {
  try {
    await provider.getClassHashAt(address)
    return true
  } catch {
    return false
  }
}

async function waitForSuccessfulTransaction(provider: RpcProvider, hashValue: string): Promise<void> {
  const receipt = await provider.waitForTransaction(hashValue)
  if ('isSuccess' in receipt && typeof receipt.isSuccess === 'function' && !receipt.isSuccess()) {
    throw new Error(`Starknet transaction ${hashValue} failed`)
  }
}

function isRetryableProofError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /too recent|base block|not deployed|reverted transactions|attestation.+validity|502|503|504/i.test(message)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
