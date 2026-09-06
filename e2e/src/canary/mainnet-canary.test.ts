import { describe, expect, it } from 'vitest'
import { CHAIN, type FlowPhase, type FlowUpdate, type PublicFlow, type QuoteRequest, type TokenSymbol } from '@privacy-round-trip/shared'
import { erc20Abi, parseUnits, type Address, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { api } from '../../../apps/web/src/api.js'
import { clearIdentity, createEphemeralIdentity } from '../../../apps/web/src/identity.js'
import {
  sponsoredMint,
  sponsoredPrivacyDeposit,
  sponsoredPrivacyExit,
  starknetUsdcBalance,
  waitForCircleAttestation,
  waitForPrivacyProvingReadyAfterTx,
} from '../../../apps/web/src/starknet.js'
import { predictSettlement, submitEntry, waitForEthereumTransaction, waitForUsdcAt } from '../../../apps/web/src/wallet.js'
import { CANARY_ARMED_VALUE, env } from '../support/env.js'
import { publicClient, randomBytes32 } from '../support/ethereum.js'
import { localAccountWallet } from '../support/nodeWallet.js'

/**
 * Deployment gate 7 in docs/ARCHITECTURE.md: "a deliberately tiny mainnet canary for every token
 * pair". This drives the complete production route, including the Starknet privacy leg, using
 * the same browser modules the web app runs, against a ready API. It spends real funds and takes
 * at least the selected privacy delay plus two CCTP attestations and two proofs.
 *
 * It is refused unless E2E_MAINNET_CANARY equals the arming sentinel. The orchestration mirrors
 * apps/web/src/useRoundTrip.ts; keep the two in step when the flow changes.
 */
const armed = env.E2E_MAINNET_CANARY === CANARY_ARMED_VALUE
const missing = (
  [
    ['ETHEREUM_RPC_URL', env.ETHEREUM_RPC_URL],
    ['E2E_API_URL', env.E2E_API_URL],
    ['E2E_ETHEREUM_PRIVATE_KEY', env.E2E_ETHEREUM_PRIVATE_KEY],
    ['E2E_RECIPIENT', env.E2E_RECIPIENT],
  ] as const
)
  .filter(([, value]) => !value)
  .map(([name]) => name)

const FOUR_HOURS = 4 * 60 * 60_000

describe.skipIf(!armed)('mainnet canary (spends real funds)', () => {
  it('has every operator value it needs', () => {
    expect(missing, `missing canary configuration: ${missing.join(', ')}`).toEqual([])
  })

  it.skipIf(missing.length > 0)(
    `round-trips ${env.E2E_AMOUNT} ${env.E2E_INPUT_TOKEN} -> ${env.E2E_OUTPUT_TOKEN} through the full privacy route`,
    { timeout: FOUR_HOURS },
    async () => {
      const rpc = env.ETHEREUM_RPC_URL as string
      const apiUrl = (env.E2E_API_URL as string).replace(/\/$/, '')
      const recipient = env.E2E_RECIPIENT as Address
      const inputToken: TokenSymbol = env.E2E_INPUT_TOKEN
      const outputToken: TokenSymbol = env.E2E_OUTPUT_TOKEN
      const log = (message: string) => console.log(`[canary ${new Date().toISOString()}] ${message}`)

      expect(api.baseUrl, 'E2E_API_URL must reach the browser API module (see support/setup.ts)').toBe(apiUrl)
      const account = privateKeyToAccount(env.E2E_ETHEREUM_PRIVATE_KEY as Hex)
      expect(recipient.toLowerCase(), 'use a recipient distinct from the canary wallet so payout accounting excludes gas').not.toBe(
        account.address.toLowerCase(),
      )
      const wallet = localAccountWallet(rpc, account)
      const client = publicClient(rpc)
      expect(await client.getChainId()).toBe(CHAIN.ethereum.chainId)

      const config = await api.config()
      expect(config.ready, `API is not ready: ${config.missing.join(', ')}`).toBe(true)
      const entryRouter = config.ethereum.entryRouter as Address
      const factory = config.ethereum.exitSettlementFactory as Address
      const cctpExitAnonymizer = config.starknet.cctpExitAnonymizer as string
      if (env.ETHEREUM_ENTRY_ROUTER) expect(entryRouter.toLowerCase()).toBe(env.ETHEREUM_ENTRY_ROUTER.toLowerCase())
      if (env.ETHEREUM_EXIT_SETTLEMENT_FACTORY) expect(factory.toLowerCase()).toBe(env.ETHEREUM_EXIT_SETTLEMENT_FACTORY.toLowerCase())
      if (env.STARKNET_CCTP_EXIT_ANONYMIZER) expect(BigInt(cctpExitAnonymizer)).toBe(BigInt(env.STARKNET_CCTP_EXIT_ANONYMIZER))

      const request: QuoteRequest = { inputToken, outputToken, amount: env.E2E_AMOUNT, slippageBps: 100 }
      const quote = await api.quote(request)
      const cap = parseUnits(String(env.E2E_MAX_BRIDGE_USDC), 6)
      expect(
        BigInt(quote.estimatedBridgeAmountBase) <= cap,
        `quoted bridge amount ${quote.estimatedBridgeAmountBase} exceeds E2E_MAX_BRIDGE_USDC`,
      ).toBe(true)
      log(`quote ${quote.quoteId}: bridge ~${quote.estimatedBridgeAmountBase} USDC base units, minimum output ${quote.minimumOutputAmountBase}`)

      const balanceOf = async (owner: Address): Promise<bigint> =>
        outputToken === 'ETH'
          ? client.getBalance({ address: owner })
          : client.readContract({ address: CHAIN.ethereum.tokens[outputToken], abi: erc20Abi, functionName: 'balanceOf', args: [owner] })
      const recipientBefore = await balanceOf(recipient)

      const identity = createEphemeralIdentity()
      const created = await api.createFlow({
        quoteId: quote.quoteId,
        ethereumSender: account.address,
        starknetAccount: identity.address,
        delayMinutes: env.E2E_DELAY_MINUTES,
      })
      let flow: PublicFlow = created.flow
      const transition = async (phase: FlowPhase, options: Omit<FlowUpdate, 'phase'> = {}) => {
        flow = await api.updateFlow(flow.id, created.writeToken, { phase, ...options })
        log(`flow ${flow.id} -> ${phase}`)
      }

      try {
        const entryHash = await submitEntry({
          wallet,
          entryRouter,
          flowId: flow.id,
          quote,
          starknetRecipient: identity.address,
          onApproval: (hash) => log(`approval ${hash}`),
        })
        log(`entry ${entryHash}`)
        await transition('entry-submitted', { txHash: entryHash })
        await waitForEthereumTransaction(wallet, entryHash)
        await transition('bridging-to-starknet')

        const attested = await waitForCircleAttestation(entryHash)
        const mintHash = await sponsoredMint(identity, attested.message, attested.attestation as Hex)
        log(`starknet mint ${mintHash}`)
        await transition('starknet-funded', { txHash: mintHash })

        await waitForPrivacyProvingReadyAfterTx(mintHash)
        const minted = await starknetUsdcBalance(identity.address)
        expect(minted).toBeGreaterThan(0n)
        await transition('pool-depositing')
        const deposit = await sponsoredPrivacyDeposit({ identity, amount: minted })
        const depositedAt = new Date().toISOString()
        log(`pool deposit ${deposit.txHash}`)
        await transition('privacy-delay', { txHash: deposit.txHash, occurredAt: depositedAt })

        await Promise.all([
          sleepUntil(Date.parse(depositedAt) + env.E2E_DELAY_MINUTES * 60_000),
          waitForPrivacyProvingReadyAfterTx(deposit.txHash),
        ])
        await transition('pool-withdrawing')

        const salt = randomBytes32()
        const poolFee = (quote.exitPoolFee || 500) as 100 | 500 | 3000 | 10000
        const recoverAfter = Math.floor(Date.now() / 1_000) + 60 * 60
        const minimumOutput = BigInt(quote.minimumOutputAmountBase)
        const predicted = await predictSettlement({ wallet, factory, salt, recipient, outputToken, minimumOutput, poolFee, recoverAfter })
        const settlement = await api.createSettlement({
          salt,
          recipient,
          outputToken,
          minimumOutput: quote.minimumOutputAmountBase,
          poolFee,
          recoverAfter,
        })
        expect(settlement.settlement.toLowerCase()).toBe(predicted.toLowerCase())
        await waitForEthereumTransaction(wallet, settlement.txHash)
        log(`settlement ${settlement.settlement} deployed in ${settlement.txHash}`)

        const exitHash = await sponsoredPrivacyExit({
          identity,
          privateAmount: deposit.privateAmount,
          settlement: settlement.settlement,
          cctpExitAnonymizer,
          cctpMaxFee: BigInt(quote.outboundCctpMaxFeeBase),
        })
        log(`pool exit ${exitHash}`)
        await transition('bridging-to-ethereum', { txHash: exitHash, settlementAddress: settlement.settlement })

        const arrived = await waitForUsdcAt(wallet, settlement.settlement)
        log(`${arrived} USDC base units arrived at the settlement`)
        await transition('settling')
        const final = await api.settle(settlement.settlement)
        await waitForEthereumTransaction(wallet, final.txHash)
        await transition('completed', { txHash: final.txHash })
        log(`settled in ${final.txHash}`)

        const paid = (await balanceOf(recipient)) - recipientBefore
        expect(paid).toBeGreaterThanOrEqual(minimumOutput)
        clearIdentity(identity)
      } catch (error) {
        // Match the browser: record the failure but keep the in-memory secrets for manual recovery.
        log(`FAILED at phase ${flow.phase}: ${error instanceof Error ? error.message : String(error)}`)
        log(`ephemeral Starknet account ${identity.address} may still hold funds; do not discard this process output`)
        if (flow.phase !== 'completed' && flow.phase !== 'failed') {
          await api
            .updateFlow(flow.id, created.writeToken, {
              phase: 'failed',
              failureReason: (error instanceof Error ? error.message : String(error)).slice(0, 500),
            })
            .catch(() => undefined)
        }
        throw error
      }
    },
  )
})

function sleepUntil(timestamp: number): Promise<void> {
  return new Promise((resolve) => {
    const tick = () => {
      const remaining = timestamp - Date.now()
      if (remaining <= 0) resolve()
      else setTimeout(tick, Math.min(remaining, 5_000))
    }
    tick()
  })
}
