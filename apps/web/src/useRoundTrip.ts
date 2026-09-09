import { useCallback, useEffect, useRef, useState } from 'react'
import {
  DEFAULT_DELAY_MINUTES,
  POC_DEPLOYMENTS,
  type FlowPhase,
  type PublicConfig,
  type PublicFlow,
  type QuoteRequest,
  type RouteQuote,
  type TokenSymbol,
} from '@privacy-round-trip/shared'
import { formatUnits, isAddress, type Address, type Hex } from 'viem'
import { api } from './api.js'
import { assertPinnedDeployments } from './deployments.js'
import { reportFlowFailureBestEffort, SERVER_SAFE_FAILURE_REASON } from './flowFailure.js'
import { clearIdentity, createEphemeralIdentity, type EphemeralIdentity } from './identity.js'
import { createRecoveryProgress, type RecoveryProgress } from './progress.js'
import { executionQuoteForReviewedRoute, quoteRequestsEqual } from './quoteSafety.js'
import {
  sponsoredMint,
  sponsoredPrivacyDeposit,
  sponsoredPrivacyExit,
  starknetUsdcBalance,
  waitForCircleAttestation,
  waitForPrivacyProvingReadyAfterTx,
} from './starknet.js'
import {
  connectRabby,
  isUserRejectedRequest,
  predictSettlement,
  submitEntry,
  waitForEthereumTransaction,
  waitForUsdcAt,
  type BrowserWallet,
} from './wallet.js'

export interface TransferForm {
  inputToken: TokenSymbol
  outputToken: TokenSymbol
  amount: string
  recipient: string
  delayMinutes: number
}

export const INITIAL_FORM: TransferForm = {
  inputToken: 'ETH',
  outputToken: 'ETH',
  amount: '0.01',
  recipient: '',
  delayMinutes: DEFAULT_DELAY_MINUTES,
}

const RECOVERY_WINDOW_SECONDS = 60 * 60

export function useRoundTrip() {
  const [config, setConfig] = useState<PublicConfig>()
  const [wallet, setWallet] = useState<BrowserWallet>()
  const [quote, setQuote] = useState<RouteQuote>()
  const [flow, setFlow] = useState<PublicFlow>()
  const [message, setMessage] = useState('Connect Rabby to prepare a route.')
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [active, setActive] = useState(false)
  const [recoveryAvailable, setRecoveryAvailable] = useState(false)
  const [now, setNow] = useState(Date.now())
  const identityRef = useRef<EphemeralIdentity | undefined>(undefined)
  // React state disables the button on the next render; this synchronous lock closes the smaller
  // window in which two click handlers could both enter start().
  const startingRef = useRef(false)
  // Browser-only exit-side progress; read by same-tab recovery, never sent to the API.
  const progressRef = useRef<RecoveryProgress>(createRecoveryProgress())

  useEffect(() => {
    api.config().then(setConfig).catch((cause) => setError(errorText(cause)))
  }, [])

  useEffect(() => {
    if (!active) return
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    window.addEventListener('beforeunload', warn)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('beforeunload', warn)
    }
  }, [active])

  const connect = useCallback(async () => {
    setBusy(true)
    setError(undefined)
    try {
      const connected = await connectRabby()
      setWallet(connected)
      setMessage(`Connected ${short(connected.account)} on Ethereum mainnet.`)
      return connected
    } catch (cause) {
      setError(errorText(cause))
      throw cause
    } finally {
      setBusy(false)
    }
  }, [])

  const preview = useCallback(async (form: TransferForm) => {
    validateForm(form)
    setBusy(true)
    setError(undefined)
    setQuote(undefined)
    try {
      const next = await api.quote(quoteRequest(form))
      setQuote(next)
      setMessage('Route ready. Review it, then keep this tab open for the complete round trip.')
      return next
    } catch (cause) {
      setError(errorText(cause))
      throw cause
    } finally {
      setBusy(false)
    }
  }, [])

  const start = useCallback(
    async (form: TransferForm) => {
      if (startingRef.current) return
      startingRef.current = true
      setBusy(true)
      let connected: BrowserWallet
      try {
        validateForm(form)
        if (!quote || !quoteRequestsEqual(quote.request, quoteRequest(form))) {
          throw new Error('The route changed. Request a fresh mainnet quote before starting.')
        }
        if (!config?.ready) {
          throw new Error(`POC deployment is not ready: ${config?.missing.join(', ') || 'configuration unavailable'}`)
        }
        // Only the reviewed deployments compiled into this bundle are ever used.
        assertPinnedDeployments(config)
        // Refresh the provider selection at the transaction boundary. The account cached when the
        // user first connected may no longer be Rabby's active account by the time they start.
        connected = await connectRabby()
        setWallet(connected)
      } catch (cause) {
        setError(errorText(cause))
        setBusy(false)
        startingRef.current = false
        throw cause
      }
      setActive(true)
      setRecoveryAvailable(false)
      setError(undefined)

      let currentFlow: PublicFlow | undefined
      let writeToken: string | undefined
      let entryWriteAttempted = false
      let executionQuote: RouteQuote | undefined
      const identity = createEphemeralIdentity()
      identityRef.current = identity
      const progress = createRecoveryProgress()
      progressRef.current = progress
      const note = (patch: Partial<Omit<RecoveryProgress, 'kind'>>) => Object.assign(progress, patch)

      const transition = async (
        phase: FlowPhase,
        options: { txHash?: string; occurredAt?: string } = {},
      ) => {
        if (!currentFlow || !writeToken) return
        const updated = await api.updateFlow(currentFlow.id, writeToken, { phase, ...options })
        // Keep the reviewed floors in React state: same-tab recovery extracts this local flow and
        // must not fall back to the weaker minima from the API's just-in-time quote.
        currentFlow = executionQuote ? { ...updated, quote: executionQuote } : updated
        setFlow(currentFlow)
      }

      try {
        setMessage('Refreshing the mainnet route and Circle fee limits…')
        const freshQuote = await api.quote(quoteRequest(form))
        setQuote(freshQuote)
        executionQuote = executionQuoteForReviewedRoute(quote, freshQuote)
        setQuote(executionQuote)
        const created = await api.createFlow({
          quoteId: executionQuote.quoteId,
          ethereumSender: connected.account,
          starknetAccount: identity.address,
          delayMinutes: form.delayMinutes,
        })
        currentFlow = { ...created.flow, quote: executionQuote }
        writeToken = created.writeToken
        note({ flowId: created.flow.id, writeToken: created.writeToken })
        const paymasterCapability = { flowId: created.flow.id, flowToken: created.writeToken }
        setFlow(currentFlow)

        setMessage(
          form.inputToken === 'ETH'
            ? 'Confirm the one Ethereum entry transaction in Rabby.'
            : `Rabby will ask for a scoped ${form.inputToken} approval, then the entry transaction.`,
        )
        const entryHash = await submitEntry({
          wallet: connected,
          entryRouter: POC_DEPLOYMENTS.ethereum.entryRouter,
          flowId: currentFlow.id,
          quote: executionQuote,
          starknetRecipient: identity.address,
          onApproval: () => setMessage('Approval confirmed. Confirm the entry transaction in Rabby.'),
          onEntryAttempt: () => {
            entryWriteAttempted = true
          },
        })
        note({ entryTxHash: entryHash })
        setRecoveryAvailable(true)
        await transition('entry-submitted', { txHash: entryHash })
        setMessage('Entry submitted. Waiting for Ethereum confirmation…')
        await waitForEthereumTransaction(connected, entryHash)
        // The API verifies this entry burn on Ethereum before it opens sponsored Starknet actions.
        await transition('bridging-to-starknet')

        setMessage('Ethereum confirmed. Waiting for Circle CCTP attestation…')
        const attested = await waitForCircleAttestation(entryHash)
        setMessage('Circle attested. Deploying the one-use Starknet account and claiming USDC…')
        const mintHash = await sponsoredMint(
          identity,
          attested.message,
          attested.attestation as `0x${string}`,
          paymasterCapability,
        )
        note({ inboundMintTxHash: mintHash })
        await transition('starknet-funded', { txHash: mintHash })

        setMessage('USDC is on Starknet. Waiting for a proof-safe finalized block…')
        await waitForPrivacyProvingReadyAfterTx(mintHash)
        const minted = await starknetUsdcBalance(identity.address)
        if (minted <= 0n) throw new Error('The CCTP claim completed without a positive USDC balance')

        await transition('pool-depositing')
        setMessage('Generating the private deposit proof. This can take a few minutes…')
        const deposit = await sponsoredPrivacyDeposit({
          identity,
          amount: minted,
          capability: paymasterCapability,
          onTransactionSubmitted: (submitted) =>
            note({
              depositTxHash: submitted.txHash,
              privateAmount: submitted.privateAmount.toString(),
              depositedAt: new Date().toISOString(),
            }),
        })
        const depositedAt = progress.depositedAt ?? new Date().toISOString()
        note({ depositTxHash: deposit.txHash, privateAmount: deposit.privateAmount.toString(), depositedAt })
        await transition('privacy-delay', {
          txHash: deposit.txHash,
          occurredAt: depositedAt,
        })

        setMessage(
          `Private note created (paymaster fee ${formatUnits(deposit.fee, 6)} USDC). Holding for the selected ${form.delayMinutes}-minute delay…`,
        )
        await Promise.all([
          waitUntil(Date.parse(depositedAt) + form.delayMinutes * 60_000),
          waitForPrivacyProvingReadyAfterTx(deposit.txHash),
        ])

        await transition('pool-withdrawing')
        setMessage('Delay complete. Creating a fresh recipient-bound Ethereum settlement…')
        const salt = randomHex32()
        const poolFee = (executionQuote.exitPoolFee || 500) as 100 | 500 | 3000 | 10000
        const recoverAfter = Math.floor(Date.now() / 1_000) + RECOVERY_WINDOW_SECONDS
        note({ salt, recoverAfter })
        const expectedSettlement = await predictSettlement({
          wallet: connected,
          factory: POC_DEPLOYMENTS.ethereum.exitSettlementFactory,
          salt,
          recipient: form.recipient as Address,
          outputToken: form.outputToken,
          minimumOutput: BigInt(executionQuote.minimumOutputAmountBase),
          poolFee,
          recoverAfter,
        })
        note({ settlement: expectedSettlement })
        const settlement = await api.createSettlement({
          salt,
          recipient: form.recipient as Address,
          outputToken: form.outputToken,
          minimumOutput: executionQuote.minimumOutputAmountBase,
          poolFee,
          recoverAfter,
        })
        if (settlement.settlement.toLowerCase() !== expectedSettlement.toLowerCase()) {
          throw new Error('The settlement relayer returned an unexpected deterministic address')
        }
        note({ settlementTxHash: settlement.txHash })
        await waitForEthereumTransaction(connected, settlement.txHash)

        setMessage('Generating the private exit proof and starting CCTP back to Ethereum…')
        const exitHash = await sponsoredPrivacyExit({
          identity,
          privateAmount: deposit.privateAmount,
          settlement: settlement.settlement,
          cctpExitAnonymizer: POC_DEPLOYMENTS.starknet.cctpExitAnonymizer,
          cctpMaxFee: BigInt(executionQuote.outboundCctpMaxFeeBase),
          capability: paymasterCapability,
          onTransactionSubmitted: (txHash) => note({ exitTxHash: txHash }),
        })
        note({ exitTxHash: exitHash })
        // Exit-side hashes and the settlement address stay in this tab; the API record ends at
        // entry-side data so it cannot join the entry to the recipient.
        await transition('bridging-to-ethereum')

        setMessage('Private exit complete. Circle is forwarding USDC to Ethereum…')
        await waitForUsdcAt(connected, settlement.settlement)
        await transition('settling')
        setMessage(
          form.outputToken === 'USDC'
            ? 'USDC arrived. Relaying the final payout…'
            : `USDC arrived. Relaying the final ${form.outputToken} swap and payout…`,
        )
        const final = await api.settle(settlement.settlement)
        note({ finalTxHash: final.txHash })
        await waitForEthereumTransaction(connected, final.txHash)
        await transition('completed')
        setMessage(`Complete. Funds were paid to ${short(form.recipient)} on Ethereum.`)
        clearIdentity(identity)
        identityRef.current = undefined
        progressRef.current = createRecoveryProgress()
        setActive(false)
        setRecoveryAvailable(false)
      } catch (cause) {
        const reason = errorText(cause)
        setError(reason)
        const entryWasSubmitted = Boolean(progress.entryTxHash)
        const submissionIsUncertain = entryWriteAttempted && !entryWasSubmitted && !isUserRejectedRequest(cause)
        const recoveryMaterialMustBePreserved = entryWasSubmitted || submissionIsUncertain
        setMessage(
          entryWasSubmitted
            ? 'The automatic flow stopped. Do not close or reload this tab; the in-memory recovery key is still present.'
            : submissionIsUncertain
              ? 'Rabby may have submitted the entry without returning its hash. Do not close or reload this tab; check Rabby activity and contact the operator.'
              : 'No entry transaction was submitted and no transfer left Ethereum. You can start again.',
        )
        const failureTarget =
          currentFlow && writeToken && currentFlow.phase !== 'failed' && currentFlow.phase !== 'completed'
            ? { id: currentFlow.id, token: writeToken }
            : undefined
        if (recoveryMaterialMustBePreserved && failureTarget && currentFlow) {
          currentFlow = {
            ...currentFlow,
            phase: 'failed',
            failureReason: SERVER_SAFE_FAILURE_REASON,
            updatedAt: new Date().toISOString(),
          }
          setFlow(currentFlow)
        }
        if (!recoveryMaterialMustBePreserved) {
          clearIdentity(identity)
          identityRef.current = undefined
          progressRef.current = createRecoveryProgress()
          setFlow(undefined)
          setActive(false)
          setRecoveryAvailable(false)
        }
        // Release all browser-local state before starting the unbounded, best-effort PATCH. A
        // stalled API must not keep the Start button or synchronous click lock engaged.
        setBusy(false)
        startingRef.current = false
        if (failureTarget) {
          reportFlowFailureBestEffort(
            api.updateFlow,
            failureTarget.id,
            failureTarget.token,
          )
        }
      } finally {
        setBusy(false)
        startingRef.current = false
      }
    },
    [config, quote],
  )

  const invalidateQuote = useCallback(() => {
    if (!active && !flow) setQuote(undefined)
  }, [active, flow])

  return {
    config,
    wallet,
    quote,
    flow,
    message,
    error,
    busy,
    active,
    recoveryAvailable,
    now,
    connect,
    preview,
    start,
    invalidateQuote,
  }
}

function quoteRequest(form: TransferForm): QuoteRequest {
  return {
    inputToken: form.inputToken,
    outputToken: form.outputToken,
    amount: form.amount,
    slippageBps: 100,
  }
}

function validateForm(form: TransferForm): void {
  if (!/^\d+(\.\d+)?$/.test(form.amount) || Number(form.amount) <= 0) {
    throw new Error('Enter a positive token amount')
  }
  if (!isAddress(form.recipient)) throw new Error('Enter a valid Ethereum recipient')
  if (!Number.isInteger(form.delayMinutes) || form.delayMinutes < 5 || form.delayMinutes > 10_080) {
    throw new Error('Delay must be between 5 minutes and 7 days')
  }
}

function randomHex32(): Hex {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`
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

function short(value: string): string {
  return `${value.slice(0, 6)}…${value.slice(-4)}`
}

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
