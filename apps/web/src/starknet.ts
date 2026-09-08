import { createPrivateTransfers } from '@starkware-libs/starknet-privacy-sdk'
import {
  CHAIN,
  FORWARDING_HOOK_DATA,
  MAX_PRIVATE_FEE_BASE,
  MAX_PRIVATE_FEE_BPS,
  feltEquals,
} from '@privacy-round-trip/shared'
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
import {
  StarkscanProofProvider,
  type ProofCheckpoint,
  type ProofCheckpointStore,
} from './starkscanProofProvider.js'

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

export interface PaymasterCall {
  to: string
  selector: string
  calldata: string[]
}

interface CallAndProof {
  call: Call
  proof: { data: string; proofFacts: string[] }
}

export interface PaymasterCapability {
  flowId: string
  flowToken: string
}

type BuiltPaymasterTransaction = Awaited<ReturnType<Account['buildPaymasterTransaction']>>
type AccountDeployment = Extract<BuiltPaymasterTransaction, { type: 'deploy' }>['deployment']

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

/**
 * Deploy the browser-generated account and claim the inbound CCTP mint in one sponsored tx.
 *
 * starknet.js skips its call-equality check when the fee mode is `sponsored`, so the typed data
 * AVNU returns is verified here before the account signs it. Without this a compromised relay or
 * paymaster could append a `transfer` of the freshly minted USDC to the outside execution.
 */
export async function sponsoredMint(
  identity: EphemeralIdentity,
  message: `0x${string}`,
  attestation: `0x${string}`,
  capability: PaymasterCapability,
): Promise<string> {
  const provider = providerForApp()
  const paymaster = new PaymasterRpc({ nodeUrl: PAYMASTER_URL, headers: paymasterHeaders(capability) })
  const account = new Account({
    provider,
    address: identity.address,
    signer: identity.signer,
    paymaster,
  })
  const deployed = await isAccountDeployed(identity.address, provider)
  const call: Call = {
    contractAddress: CHAIN.starknet.cctp.messageTransmitterV2,
    entrypoint: 'receive_message',
    calldata: [
      ...bytesToByteArrayCalldata(hexToBytes(message)),
      ...bytesToByteArrayCalldata(hexToBytes(attestation)),
    ],
  }
  const built = await account.buildPaymasterTransaction([call], {
    feeMode: { mode: 'sponsored' as const },
    ...(deployed ? {} : { deploymentData: deploymentDataFor(identity) }),
  })
  if (built.type === 'deploy') throw new Error('Paymaster dropped the CCTP claim from the sponsored transaction')
  if (built.type === 'deploy_and_invoke') assertExpectedDeployment(built.deployment, identity)
  else if (!deployed) throw new Error('Paymaster omitted the required account deployment')
  assertTypedDataCalls(built.typed_data, [toPaymasterCall(call)])

  const prepared = await account.preparePaymasterTransaction(built)
  const result = await paymaster.executeTransaction(prepared, built.parameters)
  await waitForSuccessfulTransaction(provider, result.transaction_hash)
  return result.transaction_hash
}

/**
 * Deploy the browser-generated account on its own. Used by recovery when a third party already
 * called the permissionless `receive_message`, which mints to the address without deploying it.
 * Returns undefined when the account already exists.
 */
export async function sponsoredDeploy(
  identity: EphemeralIdentity,
  capability: PaymasterCapability,
): Promise<string | undefined> {
  const provider = providerForApp()
  if (await isAccountDeployed(identity.address, provider)) return undefined
  const paymaster = new PaymasterRpc({ nodeUrl: PAYMASTER_URL, headers: paymasterHeaders(capability) })
  const account = new Account({
    provider,
    address: identity.address,
    signer: identity.signer,
    paymaster,
  })
  const built = await account.buildPaymasterTransaction([], {
    feeMode: { mode: 'sponsored' as const },
    deploymentData: deploymentDataFor(identity),
  })
  if (built.type !== 'deploy') throw new Error('Paymaster attached calls to a deployment-only request')
  assertExpectedDeployment(built.deployment, identity)
  const prepared = await account.preparePaymasterTransaction(built)
  const result = await paymaster.executeTransaction(prepared, built.parameters)
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

/** Sum of the account's unspent private USDC notes, discovered through the pool indexer. */
export async function privateUsdcBalance(identity: EphemeralIdentity): Promise<bigint> {
  const { notes } = await poolClient(identity, memoryProofCheckpoint()).discoverNotes({
    tokens: [BigInt(CHAIN.starknet.usdc)],
  })
  return (notes.get(CHAIN.starknet.usdc) ?? []).reduce((total, note) => total + BigInt(note.amount), 0n)
}

export async function isAccountDeployed(address: string, provider = providerForApp()): Promise<boolean> {
  try {
    await provider.getClassHashAt(address)
    return true
  } catch {
    return false
  }
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
  capability: PaymasterCapability
  proofCheckpoint?: ProofCheckpointStore
  onTransactionSubmitted?: (result: { txHash: string; privateAmount: bigint; fee: bigint }) => void
}): Promise<{ txHash: string; privateAmount: bigint; fee: bigint }> {
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
  }, args.capability)
  // The account signs `typed_data` verbatim, so it must carry exactly the pool approval requested.
  assertTypedDataCalls(built.typed_data, [approve])
  const fee = validateFee(built.fee_action, CHAIN.starknet.usdc, args.amount)

  const proofCheckpoint = args.proofCheckpoint ?? memoryProofCheckpoint()
  const result = await withFreshProvingBlock(() => {
    const builder = poolClient(args.identity, proofCheckpoint)
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
  }, proofCheckpoint)

  const signature = stark.signatureToHexArray(
    await args.identity.signer.signMessage(built.typed_data, args.identity.address),
  )
  const response = await executeInvokeAndApply({
    identity: args.identity,
    typedData: built.typed_data,
    signature,
    callAndProof: result.callAndProof as CallAndProof,
    mode,
    capability: args.capability,
  })
  const submitted = { txHash: response.transaction_hash, privateAmount: args.amount - fee, fee }
  args.onTransactionSubmitted?.(submitted)
  proofCheckpoint.clear()
  await waitForSuccessfulTransaction(providerForApp(), response.transaction_hash)
  return submitted
}

/** Spend the private note directly into the CCTP anonymizer and start the return bridge. */
export async function sponsoredPrivacyExit(args: {
  identity: EphemeralIdentity
  privateAmount: bigint
  settlement: string
  cctpExitAnonymizer: string
  cctpMaxFee: bigint
  capability: PaymasterCapability
  proofCheckpoint?: ProofCheckpointStore
  onTransactionSubmitted?: (txHash: string) => void
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
    args.capability,
  )
  const fee = validateFee(built.fee_action, CHAIN.starknet.usdc, args.privateAmount)
  const amountToBridge = args.privateAmount - fee
  if (amountToBridge <= args.cctpMaxFee) {
    throw new Error('Private balance is below the privacy and return-bridge fees')
  }

  const proofCheckpoint = args.proofCheckpoint ?? memoryProofCheckpoint()
  const result = await withFreshProvingBlock(() => {
    const builder = poolClient(args.identity, proofCheckpoint)
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
  }, proofCheckpoint)

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
  }, args.capability)
  args.onTransactionSubmitted?.(response.transaction_hash)
  proofCheckpoint.clear()
  await waitForSuccessfulTransaction(providerForApp(), response.transaction_hash)
  return response.transaction_hash
}

/**
 * Verify that SNIP-9 typed data (v1 or v2 layout) authorises exactly the requested calls and
 * targets Starknet mainnet. Throws otherwise; nothing is signed until this passes.
 */
export function assertTypedDataCalls(typedData: unknown, expected: PaymasterCall[]): void {
  const data = record(typedData)
  const domain = record(data?.domain)
  const message = record(data?.message)
  if (!data || !domain || !message) throw new Error('Paymaster returned malformed typed data')
  if (domain.chainId !== 'SN_MAIN' && !feltEquals(domain.chainId, CHAIN.starknet.chainId)) {
    throw new Error('Paymaster typed data targets another Starknet chain')
  }
  const calls = Array.isArray(message.Calls)
    ? message.Calls
    : Array.isArray(message.calls)
      ? message.calls
      : undefined
  if (!calls || calls.length !== expected.length) {
    throw new Error(
      `Paymaster typed data carries ${calls?.length ?? 0} call(s); expected ${expected.length}`,
    )
  }
  calls.forEach((entry, index) => {
    const call = record(entry)
    const want = expected[index]!
    const calldata = call?.Calldata ?? call?.calldata
    const matches =
      call !== undefined &&
      feltEquals(call.To ?? call.to, want.to) &&
      feltEquals(call.Selector ?? call.selector, want.selector) &&
      Array.isArray(calldata) &&
      calldata.length === want.calldata.length &&
      calldata.every((value, position) => feltEquals(value, want.calldata[position]))
    if (!matches) throw new Error(`Paymaster typed data call ${index} does not match the requested call`)
  })
}

/** Deployment data for the flow's own OpenZeppelin account: public key as salt and sole argument. */
function deploymentDataFor(identity: EphemeralIdentity) {
  return {
    address: identity.address,
    class_hash: identity.classHash,
    salt: identity.salt,
    calldata: [identity.publicKey],
    version: 1 as const,
  }
}

function assertExpectedDeployment(deployment: AccountDeployment, identity: EphemeralIdentity): void {
  const calldata = Array.isArray(deployment.calldata) ? deployment.calldata : []
  const matches =
    feltEquals(deployment.address, identity.address) &&
    feltEquals(deployment.class_hash, CHAIN.starknet.ozAccountClassHash) &&
    feltEquals(deployment.salt, identity.salt) &&
    calldata.length === 1 &&
    feltEquals(calldata[0], identity.publicKey)
  if (!matches) throw new Error('Paymaster changed the account deployment parameters')
}

async function executeInvokeAndApply(args: {
  identity: EphemeralIdentity
  typedData: TypedData
  signature: string[]
  callAndProof: CallAndProof
  mode: ReturnType<typeof privateFeeMode>
  capability: PaymasterCapability
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
  }, args.capability)
}

function poolClient(identity: EphemeralIdentity, checkpointStore: ProofCheckpointStore) {
  return createPrivateTransfers({
    account: { address: identity.address, signer: identity.signer },
    viewingKeyProvider: { getViewingKey: async () => identity.viewingKey },
    provingProvider: new StarkscanProofProvider({
      apiBaseUrl: api.baseUrl,
      rpcUrl: RPC_URL,
      poolAddress: CHAIN.starknet.privacyPool,
      checkpointStore,
    }),
    discoveryProvider: { url: DISCOVERY_URL },
    poolContractAddress: CHAIN.starknet.privacyPool,
  })
}

async function withFreshProvingBlock<T extends { execute(options: { provingBlockId: number }): Promise<unknown> }>(
  makeBuilder: () => T,
  checkpointStore: ProofCheckpointStore,
): Promise<any> {
  const provider = providerForApp()
  let lastError: unknown
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const saved = checkpointStore.load()
    const provingBlockId =
      saved?.provingBlockId ?? Math.max(0, (await provider.getBlockNumber()) - PROVING_BLOCK_DEPTH)
    if (!saved) checkpointStore.save({ version: 1, provingBlockId })
    try {
      return await makeBuilder().execute({ provingBlockId })
    } catch (error) {
      lastError = error
      if (!isRetryableProofError(error) || attempt === 5) throw error
      // With no submitted job there is nothing to resume; let the next attempt pick a fresh block.
      if (!checkpointStore.load()?.job) checkpointStore.clear()
      await sleep(POLL_MS)
    }
  }
  throw lastError
}

function memoryProofCheckpoint(): ProofCheckpointStore {
  let checkpoint: ProofCheckpoint | undefined
  return {
    load: () => checkpoint,
    save: (value) => {
      checkpoint = value
    },
    clear: () => {
      checkpoint = undefined
    },
  }
}

async function paymasterRpc<T>(method: string, params: unknown, capability: PaymasterCapability): Promise<T> {
  const response = await fetch(PAYMASTER_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...paymasterHeaders(capability) },
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

function paymasterHeaders(capability: PaymasterCapability): Record<string, string> {
  return { 'x-flow-id': capability.flowId, 'x-flow-token': capability.flowToken }
}

function privateFeeMode() {
  return {
    mode: 'sponsored_private' as const,
    pool_fee_token: felt(CHAIN.starknet.usdc),
    tip: 'normal' as const,
  }
}

/**
 * Accept a paymaster fee only if it is in USDC, leaves something to move, and stays under the
 * client-side ceiling (absolute and relative). The paymaster response names the fee, so without a
 * ceiling a malicious paymaster or relay could take almost the whole note.
 */
export function validateFee(action: FeeAction, token: string, available: bigint): bigint {
  if (action.type !== 'withdraw' || felt(action.token) !== felt(token)) {
    throw new Error('Paymaster returned an invalid private fee token')
  }
  const fee = BigInt(action.amount)
  if (fee < 0n || fee >= available) throw new Error('Paymaster fee consumes the transfer')
  const relativeCap = (available * BigInt(MAX_PRIVATE_FEE_BPS)) / 10_000n
  const cap = relativeCap < MAX_PRIVATE_FEE_BASE ? relativeCap : MAX_PRIVATE_FEE_BASE
  if (fee > cap) {
    throw new Error(
      `Paymaster fee ${formatUsdc(fee)} USDC exceeds the ${formatUsdc(cap)} USDC ceiling for this transfer`,
    )
  }
  return fee
}

function formatUsdc(value: bigint): string {
  const whole = value / 1_000_000n
  const fraction = (value % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '')
  return fraction ? `${whole}.${fraction}` : whole.toString()
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

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
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
