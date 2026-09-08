import { TOKENS, type PublicFlow, type TokenSymbol } from '@privacy-round-trip/shared'
import { formatUnits, isAddress, type Address, type Hex } from 'viem'
import { api } from './api.js'
import {
  clearIdentity,
  restoreEphemeralIdentity,
  type EphemeralIdentity,
  type SerializedEphemeralIdentity,
} from './identity.js'
import {
  sponsoredPrivacyDeposit,
  sponsoredPrivacyExit,
  starknetUsdcBalance,
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

interface RecoveryBundle {
  version: 1
  identity: SerializedEphemeralIdentity
  sourceFlow: PublicFlow
  form: TransferForm
  recoveryFlow?: PublicFlow
  writeToken?: string
  privateAmount?: string
  depositTxHash?: string
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
    let flow = await recoveryFlow()
    const capability = capabilityFor(flow)

    if (flow.phase === 'pool-depositing') {
      update('The bridged USDC is safe. Generating and submitting the private deposit proof…')
      const balance = await starknetUsdcBalance(identity.address)
      if (!bundle.depositTxHash) {
        if (balance <= 0n) throw new Error('No public USDC remains in the recovery account')
        const deposit = await sponsoredPrivacyDeposit({
          identity,
          amount: balance,
          capability,
          proofCheckpoint: proofCheckpoint('depositProof'),
          onTransactionSubmitted: (submitted) => {
            bundle.depositTxHash = submitted.txHash
            bundle.privateAmount = submitted.privateAmount.toString()
            saveBundle()
          },
        })
        bundle.depositTxHash = deposit.txHash
        bundle.privateAmount = deposit.privateAmount.toString()
        saveBundle()
      }
      proofCheckpoint('depositProof').clear()
      flow = await transition(flow, 'privacy-delay', {
        txHash: requiredString(bundle.depositTxHash, 'privacy deposit transaction'),
        occurredAt: new Date().toISOString(),
      })
    }

    if (flow.phase === 'privacy-delay') {
      const depositHash = requiredString(flow.poolDepositTxHash ?? bundle.depositTxHash, 'privacy deposit transaction')
      const eligibleAt = Date.parse(requiredString(flow.exitEligibleAt, 'privacy exit time'))
      update(`Private note created. Holding until ${new Date(eligibleAt).toLocaleTimeString()}…`)
      await Promise.all([waitUntil(eligibleAt), waitForPrivacyProvingReadyAfterTx(depositHash)])
      flow = await transition(flow, 'pool-withdrawing')
    }

    if (flow.phase === 'pool-withdrawing') {
      update('Delay complete. Creating the recipient-bound Ethereum settlement…')
      await ensureSettlement(wallet, flow)
      if (!bundle.exitTxHash) {
        update('Generating the private exit proof and starting CCTP back to Ethereum…')
        bundle.exitTxHash = await sponsoredPrivacyExit({
          identity,
          privateAmount: BigInt(requiredString(bundle.privateAmount, 'private amount')),
          settlement: requiredString(bundle.settlement, 'settlement address'),
          cctpExitAnonymizer: requiredString((await api.config()).starknet.cctpExitAnonymizer, 'exit anonymizer'),
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
      flow = await transition(flow, 'bridging-to-ethereum', {
        txHash: bundle.exitTxHash,
        settlementAddress: requiredString(bundle.settlement, 'settlement address'),
      })
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
      flow = await transition(flow, 'completed', { txHash: bundle.finalTxHash })
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

async function recoveryFlow(): Promise<PublicFlow> {
  if (bundle.recoveryFlow && bundle.writeToken) {
    const latest = await api.getFlow(bundle.recoveryFlow.id, bundle.writeToken)
    bundle.recoveryFlow = latest
    saveBundle()
    return latest
  }

  update('Creating a fresh, account-scoped recovery capability…')
  const balance = await starknetUsdcBalance(identity.address)
  if (balance <= 0n) throw new Error('No public USDC remains in the recovery account')
  const quote = await api.quote({
    inputToken: 'USDC',
    outputToken: bundle.form.outputToken,
    amount: formatUnits(balance, TOKENS.USDC.decimals),
    slippageBps: 100,
  })
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
  flow = await transition(flow, 'starknet-funded', {
    txHash: requiredString(bundle.sourceFlow.inboundMintTxHash, 'original Starknet mint transaction'),
  })
  return transition(flow, 'pool-depositing')
}

async function ensureSettlement(wallet: BrowserWallet, flow: PublicFlow): Promise<void> {
  if (!bundle.salt) bundle.salt = randomHex32()
  if (!bundle.recoverAfter) bundle.recoverAfter = Math.floor(Date.now() / 1_000) + 60 * 60
  const config = await api.config()
  const factory = requiredString(config.ethereum.exitSettlementFactory, 'settlement factory') as Address
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
  const deployedCode = (await wallet.provider.request({
    method: 'eth_getCode',
    params: [predicted, 'latest'],
  })) as string
  if (deployedCode !== '0x') return
  if (bundle.settlementTxHash) {
    await waitForEthereumTransaction(wallet, bundle.settlementTxHash)
    return
  }
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
}

async function transition(
  flow: PublicFlow,
  phase: PublicFlow['phase'],
  options: { txHash?: string; settlementAddress?: string; occurredAt?: string } = {},
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
  if (value.version !== 1) throw new Error('Unsupported recovery material version')
  return value
}

function validateBundle(value: RecoveryBundle, restored: EphemeralIdentity): void {
  if (value.sourceFlow.starknetAccount.toLowerCase() !== restored.address.toLowerCase()) {
    throw new Error('Recovery account does not match the stopped flow')
  }
  if (!value.sourceFlow.entryTxHash || !value.sourceFlow.inboundMintTxHash) {
    throw new Error('The stopped flow did not complete its inbound bridge')
  }
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
