import { POC_DEPLOYMENTS, type PublicFlow, type TokenSymbol } from '@privacy-round-trip/shared'
import { isAddress, type Address, type Hex } from 'viem'
import { api } from './api.js'
import { assertPinnedDeployments } from './deployments.js'
import {
  clearIdentity,
  restoreEphemeralIdentity,
  type EphemeralIdentity,
  type SerializedEphemeralIdentity,
} from './identity.js'
import type { RecoveryProgress } from './progress.js'
import {
  isAccountDeployed,
  privateUsdcBalance,
  sponsoredDeploy,
  sponsoredMint,
  sponsoredPrivacyDeposit,
  sponsoredPrivacyExit,
  starknetUsdcBalance,
  waitForCircleAttestation,
  waitForPrivacyProvingReadyAfterTx,
  type PaymasterCapability,
} from './starknet.js'
import {
  ProofApiError,
  type ProofCheckpoint,
  type ProofCheckpointStore,
} from './starkscanProofProvider.js'
import {
  connectRabby,
  predictSettlement,
  waitForEthereumTransaction,
  waitForUsdcAt,
  type BrowserWallet,
} from './wallet.js'
import type { TransferForm } from './useRoundTrip.js'
import './recovery.css'

const STORAGE_KEY = '__privacy_round_trip_recovery_v1'
const RECOVERY_WINDOW_SECONDS = 60 * 60
// The settlement constructor rejects a recovery time at or before the current block, so a saved
// value this close to expiry is treated as stale and regenerated together with the salt.
const STALE_RECOVERY_MARGIN_SECONDS = 120

/**
 * Everything the recovery page needs, derived from the stopped tab (identity, the failed flow, the
 * payout instructions and any exit-side progress hints) plus what recovery itself learns. The
 * bundle is a same-tab `sessionStorage` object; the API never sees the exit-side fields.
 */
interface RecoveryBundle {
  version: 1 | 2
  identity: SerializedEphemeralIdentity
  sourceFlow: PublicFlow
  form: TransferForm
  progress?: Partial<RecoveryProgress>
  recoveryFlow?: PublicFlow
  writeToken?: string
  /** True once the private deposit is known to exist, with or without a transaction hash. */
  deposited?: boolean
  mintTxHash?: string
  privateAmount?: string
  depositTxHash?: string
  depositedAt?: string
  settlement?: Address
  settlementTxHash?: Hex
  salt?: Hex
  recoverAfter?: number
  exitTxHash?: string
  finalTxHash?: Hex
  depositProof?: ProofCheckpoint
  exitProof?: ProofCheckpoint
}

const status = requiredElement('recovery-status')
const detail = requiredElement('recovery-detail')
const dot = requiredElement('recovery-dot')
const retry = requiredButton('recovery-retry')
let running = false
let automaticRetry: number | undefined
let bundle: RecoveryBundle
let identity: EphemeralIdentity

window.addEventListener('beforeunload', (event) => {
  if (!bundle?.recoveryFlow || bundle.recoveryFlow.phase !== 'completed') {
    event.preventDefault()
    event.returnValue = ''
  }
})

try {
  bundle = readBundle()
  identity = restoreEphemeralIdentity(bundle.identity)
  validateBundle(bundle, identity)
  saveBundle()
  retry.addEventListener('click', () => void run())
  void run()
} catch (error) {
  fail(error, false)
}

async function run(): Promise<void> {
  if (running) return
  if (automaticRetry !== undefined) window.clearTimeout(automaticRetry)
  automaticRetry = undefined
  running = true
  retry.hidden = true
  dot.className = 'pulse'
  try {
    const wallet = await connectedWallet(bundle.sourceFlow.ethereumSender)
    assertPinnedDeployments(await api.config())
    let flow = await recoveryFlow()
    const capability = capabilityFor(flow)

    if (flow.phase === 'bridging-to-starknet') {
      flow = await completeInbound(flow, capability)
    }

    if (flow.phase === 'starknet-funded') {
      flow = await transition(flow, 'pool-depositing')
    }

    if (flow.phase === 'pool-depositing') {
      if (!bundle.deposited) {
        update('The bridged USDC is safe. Generating and submitting the private deposit proof…')
        const balance = await starknetUsdcBalance(identity.address)
        if (balance <= 0n) throw new Error('No public USDC remains in the recovery account')
        const deposit = await sponsoredPrivacyDeposit({
          identity,
          amount: balance,
          capability,
          proofCheckpoint: proofCheckpoint('depositProof'),
          onTransactionSubmitted: (submitted) => recordDeposit(submitted.txHash, submitted.privateAmount),
        })
        recordDeposit(deposit.txHash, deposit.privateAmount)
      }
      proofCheckpoint('depositProof').clear()
      flow = await transition(flow, 'privacy-delay', {
        ...(bundle.depositTxHash ? { txHash: bundle.depositTxHash } : {}),
        occurredAt: bundle.depositedAt ?? new Date().toISOString(),
      })
    }

    if (flow.phase === 'privacy-delay') {
      const depositHash = flow.poolDepositTxHash ?? bundle.depositTxHash
      const eligibleAt = Date.parse(requiredString(flow.exitEligibleAt, 'privacy exit time'))
      update(`Private note created. Holding until ${new Date(eligibleAt).toLocaleTimeString()}…`)
      await Promise.all([
        waitUntil(eligibleAt),
        depositHash ? waitForPrivacyProvingReadyAfterTx(depositHash) : Promise.resolve(),
      ])
      flow = await transition(flow, 'pool-withdrawing')
    }

    if (flow.phase === 'pool-withdrawing') {
      update('Delay complete. Locating the private note…')
      const privateAmount = bundle.privateAmount
        ? BigInt(bundle.privateAmount)
        : await privateUsdcBalance(identity)
      if (privateAmount <= 0n) throw new Error('No private USDC note was found for the recovery account')
      bundle.privateAmount = privateAmount.toString()
      saveBundle()

      update('Creating the recipient-bound Ethereum settlement…')
      await ensureSettlement(wallet, flow)
      if (!bundle.exitTxHash) {
        update('Generating the private exit proof and starting CCTP back to Ethereum…')
        bundle.exitTxHash = await sponsoredPrivacyExit({
          identity,
          privateAmount,
          settlement: requiredString(bundle.settlement, 'settlement address'),
          cctpExitAnonymizer: POC_DEPLOYMENTS.starknet.cctpExitAnonymizer,
          cctpMaxFee: BigInt(flow.quote.outboundCctpMaxFeeBase),
          capability,
          proofCheckpoint: proofCheckpoint('exitProof'),
          onTransactionSubmitted: (txHash) => {
            bundle.exitTxHash = txHash
            saveBundle()
          },
        })
        saveBundle()
      }
      proofCheckpoint('exitProof').clear()
      // Exit-side hashes and the settlement address never go to the API record.
      flow = await transition(flow, 'bridging-to-ethereum')
    }

    if (flow.phase === 'bridging-to-ethereum') {
      update('Private exit complete. Waiting for Circle to forward USDC to Ethereum…')
      await waitForUsdcAt(wallet, requiredString(bundle.settlement, 'settlement address') as Address)
      flow = await transition(flow, 'settling')
    }

    if (flow.phase === 'settling') {
      update(`USDC arrived. Relaying the final ${bundle.form.outputToken} payout…`)
      if (!bundle.finalTxHash) {
        const final = await api.settle(requiredString(bundle.settlement, 'settlement address') as Address)
        bundle.finalTxHash = final.txHash
        saveBundle()
      }
      await waitForEthereumTransaction(wallet, bundle.finalTxHash)
      flow = await transition(flow, 'completed')
    }

    if (flow.phase !== 'completed') throw new Error(`Recovery stopped at unexpected phase ${flow.phase}`)
    status.textContent = 'Recovery complete.'
    detail.textContent = `Funds were paid to ${short(bundle.form.recipient)} on Ethereum.`
    dot.className = ''
    clearIdentity(identity)
    bundle.identity.privateKey = ''
    bundle.identity.viewingKey = '0'
    sessionStorage.removeItem(STORAGE_KEY)
  } catch (error) {
    saveBundle()
    const retryAt = dailyBudgetRetryAt(error)
    fail(error, true, retryAt)
    if (retryAt !== undefined) {
      automaticRetry = window.setTimeout(
        () => {
          automaticRetry = undefined
          void run()
        },
        Math.max(1_000, retryAt - Date.now()),
      )
    }
  } finally {
    running = false
  }
}

/**
 * Create the account-scoped recovery flow and walk it to the phase matching what already happened.
 * The API re-verifies the original entry burn on Ethereum before it opens sponsorship, so the flow
 * cannot be pushed past `entry-submitted` without a genuine burn to this account.
 */
async function recoveryFlow(): Promise<PublicFlow> {
  if (bundle.recoveryFlow && bundle.writeToken) {
    const latest = await api.getFlow(bundle.recoveryFlow.id, bundle.writeToken)
    bundle.recoveryFlow = latest
    saveBundle()
    return latest
  }

  update('Creating a fresh, account-scoped recovery capability…')
  const quote = await api.quote(bundle.sourceFlow.quote.request)
  const created = await api.createFlow({
    quoteId: quote.quoteId,
    ethereumSender: bundle.sourceFlow.ethereumSender,
    starknetAccount: identity.address,
    delayMinutes: bundle.form.delayMinutes,
  })
  bundle.recoveryFlow = created.flow
  bundle.writeToken = created.writeToken
  saveBundle()

  let flow = created.flow
  flow = await transition(flow, 'entry-submitted', {
    txHash: requiredString(bundle.sourceFlow.entryTxHash, 'original Ethereum entry transaction'),
  })
  flow = await transition(flow, 'bridging-to-starknet')
  if (!bundle.deposited) return flow
  flow = await transition(flow, 'starknet-funded', bundle.mintTxHash ? { txHash: bundle.mintTxHash } : {})
  flow = await transition(flow, 'pool-depositing')
  return transition(flow, 'privacy-delay', {
    ...(bundle.depositTxHash ? { txHash: bundle.depositTxHash } : {}),
    occurredAt: bundle.depositedAt ?? new Date().toISOString(),
  })
}

/**
 * Bring the inbound leg to "funded and deployed" from whatever state the chain is actually in:
 * mint if the attestation was never claimed, tolerate a third party having claimed it, deploy the
 * account if the mint landed on an undeployed address, and detect a deposit that already happened.
 */
async function completeInbound(flow: PublicFlow, capability: PaymasterCapability): Promise<PublicFlow> {
  update('Checking the bridged USDC on Starknet…')
  let balance = await starknetUsdcBalance(identity.address)
  if (balance === 0n && !bundle.deposited && !bundle.mintTxHash) {
    update('Waiting for Circle attestation and claiming USDC on Starknet…')
    const attested = await waitForCircleAttestation(
      requiredString(bundle.sourceFlow.entryTxHash, 'original Ethereum entry transaction'),
    )
    try {
      bundle.mintTxHash = await sponsoredMint(identity, attested.message, attested.attestation as Hex, capability)
      saveBundle()
    } catch (error) {
      // `receive_message` is permissionless; someone else may already have minted to this account.
      balance = await starknetUsdcBalance(identity.address)
      if (balance === 0n) throw error
    }
    balance = await starknetUsdcBalance(identity.address)
  }

  if (balance === 0n && !bundle.deposited) {
    const shielded = await privateUsdcBalance(identity)
    if (shielded === 0n) throw new Error('No public or private USDC was found for the recovery account')
    bundle.deposited = true
    bundle.privateAmount = shielded.toString()
    bundle.depositedAt ??= new Date().toISOString()
    saveBundle()
  } else if (balance > 0n && !(await isAccountDeployed(identity.address))) {
    update('Deploying the one-use Starknet account…')
    await sponsoredDeploy(identity, capability)
  }

  flow = await transition(flow, 'starknet-funded', bundle.mintTxHash ? { txHash: bundle.mintTxHash } : {})
  flow = await transition(flow, 'pool-depositing')
  if (bundle.deposited) {
    flow = await transition(flow, 'privacy-delay', {
      ...(bundle.depositTxHash ? { txHash: bundle.depositTxHash } : {}),
      occurredAt: bundle.depositedAt ?? new Date().toISOString(),
    })
  }
  return flow
}

async function ensureSettlement(wallet: BrowserWallet, flow: PublicFlow): Promise<void> {
  // Reuse a settlement that already exists on-chain, whether this page or the stopped tab created it.
  if (bundle.settlement && (await hasCode(wallet, bundle.settlement))) return
  if (bundle.settlement && bundle.settlementTxHash) {
    try {
      await waitForEthereumTransaction(wallet, bundle.settlementTxHash)
    } catch {
      // Reverted or unknown transaction: fall through and deploy a fresh settlement.
    }
    if (await hasCode(wallet, bundle.settlement)) return
  }

  const now = Math.floor(Date.now() / 1_000)
  if (!bundle.salt || !bundle.recoverAfter || bundle.recoverAfter <= now + STALE_RECOVERY_MARGIN_SECONDS) {
    bundle.salt = randomHex32()
    bundle.recoverAfter = now + RECOVERY_WINDOW_SECONDS
    delete bundle.settlement
    delete bundle.settlementTxHash
    saveBundle()
  }
  const factory = POC_DEPLOYMENTS.ethereum.exitSettlementFactory
  const poolFee = (flow.quote.exitPoolFee || 500) as 100 | 500 | 3000 | 10000
  const predicted = await predictSettlement({
    wallet,
    factory,
    salt: bundle.salt,
    recipient: bundle.form.recipient as Address,
    outputToken: bundle.form.outputToken,
    minimumOutput: BigInt(flow.quote.minimumOutputAmountBase),
    poolFee,
    recoverAfter: bundle.recoverAfter,
  })
  bundle.settlement = predicted
  saveBundle()
  if (await hasCode(wallet, predicted)) return

  const created = await api.createSettlement({
    salt: bundle.salt,
    recipient: bundle.form.recipient as Address,
    outputToken: bundle.form.outputToken,
    minimumOutput: flow.quote.minimumOutputAmountBase,
    poolFee,
    recoverAfter: bundle.recoverAfter,
  })
  if (created.settlement.toLowerCase() !== predicted.toLowerCase()) {
    throw new Error('The settlement relayer returned an unexpected deterministic address')
  }
  bundle.settlementTxHash = created.txHash
  saveBundle()
  await waitForEthereumTransaction(wallet, created.txHash)
  if (!(await hasCode(wallet, predicted))) {
    throw new Error('The settlement transaction confirmed without code at the predicted address')
  }
}

async function hasCode(wallet: BrowserWallet, address: Address): Promise<boolean> {
  const code = (await wallet.provider.request({ method: 'eth_getCode', params: [address, 'latest'] })) as string
  return typeof code === 'string' && code !== '0x'
}

function recordDeposit(txHash: string, privateAmount: bigint): void {
  bundle.deposited = true
  bundle.depositTxHash = txHash
  bundle.privateAmount = privateAmount.toString()
  bundle.depositedAt ??= new Date().toISOString()
  saveBundle()
}

async function transition(
  flow: PublicFlow,
  phase: PublicFlow['phase'],
  options: { txHash?: string; occurredAt?: string } = {},
): Promise<PublicFlow> {
  const updated = await api.updateFlow(flow.id, requiredString(bundle.writeToken, 'recovery capability'), {
    phase,
    ...options,
  })
  bundle.recoveryFlow = updated
  saveBundle()
  return updated
}

function capabilityFor(flow: PublicFlow): PaymasterCapability {
  return { flowId: flow.id, flowToken: requiredString(bundle.writeToken, 'recovery capability') }
}

async function connectedWallet(expected: string): Promise<BrowserWallet> {
  const wallet = await connectRabby()
  if (wallet.account.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`Reconnect the original Ethereum account ${short(expected)}`)
  }
  return wallet
}

function readBundle(): RecoveryBundle {
  const encoded = sessionStorage.getItem(STORAGE_KEY)
  if (!encoded) throw new Error('No recovery material was found in this tab')
  const value = JSON.parse(encoded) as RecoveryBundle
  if (value.version !== 1 && value.version !== 2) throw new Error('Unsupported recovery material version')
  seedFromHints(value)
  return value
}

/** Prefer what the stopped tab knew over what the (possibly stale) API record says. */
function seedFromHints(value: RecoveryBundle): void {
  const progress = value.progress ?? {}
  const mintTxHash = value.mintTxHash ?? progress.inboundMintTxHash ?? value.sourceFlow.inboundMintTxHash
  if (mintTxHash) value.mintTxHash = mintTxHash
  const depositTxHash = value.depositTxHash ?? progress.depositTxHash ?? value.sourceFlow.poolDepositTxHash
  if (depositTxHash) value.depositTxHash = depositTxHash
  const depositedAt = value.depositedAt ?? progress.depositedAt ?? value.sourceFlow.privacyDepositConfirmedAt
  if (depositedAt) value.depositedAt = depositedAt
  if (!value.privateAmount && progress.privateAmount) value.privateAmount = progress.privateAmount
  if (!value.salt && progress.salt) value.salt = progress.salt
  if (!value.recoverAfter && progress.recoverAfter) value.recoverAfter = progress.recoverAfter
  if (!value.settlement && progress.settlement) value.settlement = progress.settlement
  if (!value.settlementTxHash && progress.settlementTxHash) value.settlementTxHash = progress.settlementTxHash
  if (!value.exitTxHash && progress.exitTxHash) value.exitTxHash = progress.exitTxHash
  if (!value.finalTxHash && progress.finalTxHash) value.finalTxHash = progress.finalTxHash
  value.deposited = value.deposited ?? Boolean(value.depositTxHash)
}

function validateBundle(value: RecoveryBundle, restored: EphemeralIdentity): void {
  if (value.sourceFlow.starknetAccount.toLowerCase() !== restored.address.toLowerCase()) {
    throw new Error('Recovery account does not match the stopped flow')
  }
  if (!value.sourceFlow.entryTxHash) {
    throw new Error('The stopped flow has no Ethereum entry transaction; nothing left Ethereum')
  }
  if (value.sourceFlow.phase === 'completed') throw new Error('The stopped flow already completed')
  if (!isAddress(value.form.recipient)) throw new Error('Recovery recipient is invalid')
  if (!['ETH', 'USDC', 'WBTC'].includes(value.form.outputToken as TokenSymbol)) {
    throw new Error('Recovery output token is invalid')
  }
}

function saveBundle(): void {
  if (bundle) sessionStorage.setItem(STORAGE_KEY, JSON.stringify(bundle))
}

function proofCheckpoint(field: 'depositProof' | 'exitProof'): ProofCheckpointStore {
  return {
    load: () => bundle[field],
    save: (checkpoint) => {
      bundle[field] = checkpoint
      saveBundle()
    },
    clear: () => {
      delete bundle[field]
      saveBundle()
    },
  }
}

function update(message: string): void {
  status.textContent = 'Recovery in progress.'
  detail.textContent = message
}

function fail(error: unknown, canRetry: boolean, retryAt?: number): void {
  status.textContent = 'Recovery paused. Keep this tab open.'
  detail.textContent =
    retryAt === undefined
      ? error instanceof Error
        ? error.message
        : String(error)
      : `Starkscan's daily proof capacity is exhausted. This tab will retry automatically at ${new Date(
          retryAt,
        ).toLocaleString()}.`
  dot.className = 'failed'
  retry.hidden = !canRetry
}

function dailyBudgetRetryAt(error: unknown): number | undefined {
  if (!(error instanceof ProofApiError) || error.status !== 429) return undefined
  if (
    error.code !== 'prover_daily_budget_exhausted' &&
    !/daily.+budget|budget.+exhausted/i.test(error.message)
  ) {
    return undefined
  }
  return Date.now() + (error.retryAfterMs ?? 60_000)
}

function waitUntil(timestamp: number): Promise<void> {
  return new Promise((resolve) => {
    const tick = () => {
      const remaining = timestamp - Date.now()
      if (remaining <= 0) resolve()
      else window.setTimeout(tick, Math.min(remaining, 5_000))
    }
    tick()
  })
}

function randomHex32(): Hex {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`
}

function requiredString(value: string | undefined, label: string): string {
  if (!value) throw new Error(`Missing ${label}`)
  return value
}

function requiredElement(id: string): HTMLElement {
  const element = document.getElementById(id)
  if (!element) throw new Error(`Recovery UI is missing ${id}`)
  return element
}

function requiredButton(id: string): HTMLButtonElement {
  const element = requiredElement(id)
  if (!(element instanceof HTMLButtonElement)) throw new Error(`Recovery UI is missing ${id}`)
  return element
}

function short(value: string): string {
  return `${value.slice(0, 6)}…${value.slice(-4)}`
}
