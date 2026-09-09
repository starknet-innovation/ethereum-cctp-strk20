import { type RouteQuote, type TokenSymbol } from '@privacy-round-trip/shared'
import { formatTokenAmount } from './wallet.js'

interface FeeBreakdownProps {
  quote: RouteQuote
  inputToken: TokenSymbol
  outputToken: TokenSymbol
  walletPrompts: string
  delayMinutes: number
}

export function FeeBreakdown({
  quote,
  inputToken,
  outputToken,
  walletPrompts,
  delayMinutes,
}: FeeBreakdownProps) {
  const detailed = detailedFees(quote)
  const difference = sameAssetDifference(quote)

  return (
    <div className="fee-breakdown">
      <p className="fee-intro">
        The estimated arrival uses the fee estimates and caps subtracted below. Private-action
        fees can vary up to the disclosed client ceiling. Costs marked “separate” are paid outside
        the amount you send.
      </p>

      <h3>Amount path</h3>
      <dl className="fee-list">
        <FeeRow label="You send" value={formatTokenAmount(quote.inputAmountBase, inputToken)} />
        <FeeRow
          label="Ethereum entry swap"
          value={
            inputToken === 'USDC'
              ? 'No swap · 0 fee'
              : `${formatTokenAmount(quote.estimatedBridgeAmountBase, 'USDC')} after swap`
          }
          detail={
            inputToken === 'USDC'
              ? undefined
              : `${poolFeePercent(quote.entryPoolFee)} Uniswap pool fee and price impact are included`
          }
        />
        <FeeRow
          fee
          label="CCTP to Starknet"
          value={`−${formatTokenAmount(
            quote.inboundCctpProtocolFeeBase ?? quote.inboundCctpMaxFeeBase,
            'USDC',
          )} max`}
          detail="Current Circle fast-transfer fee cap"
        />
        <FeeRow
          fee
          label="Starknet private actions"
          value={
            detailed
              ? `−${formatTokenAmount(detailed.starknet, 'USDC')} estimated`
              : 'Included · detailed amount unavailable'
          }
          detail={
            detailed?.maximumStarknet !== undefined && detailed.maximumStarknetPerAction !== undefined
              ? `Deposit and exit combined; up to ${formatTokenAmount(detailed.maximumStarknet, 'USDC')} accepted (${formatTokenAmount(detailed.maximumStarknetPerAction, 'USDC')} per action, with lower relative caps for small transfers)`
              : 'Private deposit and exit paymaster fees; actual amounts are checked before submission'
          }
        />
        {detailed ? (
          <>
            <FeeRow
              fee
              label="CCTP back to Ethereum"
              value={`−${formatTokenAmount(detailed.outboundProtocol, 'USDC')} max`}
              detail="Current Circle fast-transfer fee cap"
            />
            <FeeRow
              fee
              label="Circle forwarding"
              value={`−${formatTokenAmount(detailed.forwarding, 'USDC')} max`}
              detail="Delivers the return mint to the settlement contract"
            />
            <FeeRow
              total
              label="Estimated USDC deductions"
              value={`−${formatTokenAmount(detailed.totalUsdcDeductions, 'USDC')}`}
              detail="CCTP caps plus the Starknet estimate"
            />
            {detailed.maximumUsdcDeductions && (
              <FeeRow
                label="Absolute fee-cap total"
                value={`−${formatTokenAmount(detailed.maximumUsdcDeductions, 'USDC')}`}
                detail="CCTP caps plus the configured private-fee ceiling; per-transfer relative caps can make it lower"
              />
            )}
            <FeeRow
              label="USDC before payout swap"
              value={formatTokenAmount(detailed.settlementUsdc, 'USDC')}
            />
          </>
        ) : (
          <FeeRow
            fee
            label="CCTP return + forwarding"
            value={`−${formatTokenAmount(quote.outboundCctpMaxFeeBase, 'USDC')} max`}
            detail="Combined cap from the earlier quote format"
          />
        )}
        <FeeRow
          label="Ethereum payout swap"
          value={
            outputToken === 'USDC'
              ? 'No swap · 0 fee'
              : `${formatTokenAmount(quote.estimatedOutputAmountBase, outputToken)} after swap`
          }
          detail={
            outputToken === 'USDC'
              ? undefined
              : `${poolFeePercent(quote.exitPoolFee)} Uniswap pool fee and price impact are included`
          }
        />
        <FeeRow
          total
          label="Estimated recipient amount"
          value={formatTokenAmount(quote.estimatedOutputAmountBase, outputToken)}
        />
        <FeeRow
          label="Send / receive difference"
          value={
            difference
              ? `${formatTokenAmount(difference.amount, inputToken)} ${difference.direction}`
              : 'Different assets · compare through the USDC path above'
          }
          detail="Includes swap execution and route deductions; it is not one additional fee"
        />
        <FeeRow
          label={outputToken === 'USDC' ? 'Quote planning threshold' : 'On-chain swap minimum'}
          value={formatTokenAmount(quote.minimumOutputAmountBase, outputToken)}
          detail={
            outputToken === 'USDC'
              ? 'Direct USDC payout transfers the amount that arrives; the settlement contract does not enforce this value'
              : `${basisPointsPercent(quote.request.slippageBps)} below the estimate for protection; slippage is not a fee`
          }
        />
      </dl>

      <h3>Paid outside the route amount</h3>
      <dl className="fee-list external-costs">
        <FeeRow
          label="Ethereum wallet gas"
          value="Separate ETH cost"
          detail={`${walletPrompts}; Rabby shows the live gas estimate before signing`}
        />
        <FeeRow label="Starknet mint gas" value="Sponsored · 0 deducted" />
        <FeeRow label="Settlement + payout gas" value="Paid by service · 0 deducted" />
        <FeeRow label="Proof API" value="Paid by service · 0 deducted" />
        <FeeRow label="Privacy delay" value={`${delayMinutes} min · no time-based fee`} />
      </dl>

      <ul className="quote-warnings">
        {quote.warnings.map((warning) => <li key={warning}>{warning}</li>)}
      </ul>
    </div>
  )
}

function FeeRow({
  label,
  value,
  detail,
  fee = false,
  total = false,
}: {
  label: string
  value: string
  detail?: string | undefined
  fee?: boolean
  total?: boolean
}) {
  return (
    <div className={`${fee ? 'fee-row' : ''} ${total ? 'total-row' : ''}`.trim()}>
      <dt>{label}</dt>
      <dd>
        <span>{value}</span>
        {detail && <small>{detail}</small>}
      </dd>
    </div>
  )
}

function detailedFees(quote: RouteQuote) {
  if (
    quote.estimatedStarknetFeesBase === undefined ||
    quote.outboundCctpProtocolFeeBase === undefined ||
    quote.outboundCctpForwardingFeeBase === undefined ||
    quote.estimatedSettlementUsdcBase === undefined
  ) {
    return undefined
  }
  const starknet = BigInt(quote.estimatedStarknetFeesBase)
  const maximumStarknet = quote.maximumStarknetFeesBase === undefined
    ? undefined
    : BigInt(quote.maximumStarknetFeesBase)
  const outboundProtocol = BigInt(quote.outboundCctpProtocolFeeBase)
  const forwarding = BigInt(quote.outboundCctpForwardingFeeBase)
  return {
    starknet: starknet.toString(),
    maximumStarknet: maximumStarknet?.toString(),
    maximumStarknetPerAction: maximumStarknet === undefined
      ? undefined
      : (maximumStarknet / 2n).toString(),
    outboundProtocol: outboundProtocol.toString(),
    forwarding: forwarding.toString(),
    settlementUsdc: quote.estimatedSettlementUsdcBase,
    totalUsdcDeductions: (
      BigInt(quote.inboundCctpMaxFeeBase) + starknet + BigInt(quote.outboundCctpMaxFeeBase)
    ).toString(),
    maximumUsdcDeductions: maximumStarknet === undefined
      ? undefined
      : (
          BigInt(quote.inboundCctpMaxFeeBase) +
          maximumStarknet +
          BigInt(quote.outboundCctpMaxFeeBase)
        ).toString(),
  }
}

function sameAssetDifference(quote: RouteQuote): { amount: string; direction: 'less' | 'more' } | undefined {
  if (quote.request.inputToken !== quote.request.outputToken) return undefined
  const difference = BigInt(quote.inputAmountBase) - BigInt(quote.estimatedOutputAmountBase)
  return difference >= 0n
    ? { amount: difference.toString(), direction: 'less' }
    : { amount: (-difference).toString(), direction: 'more' }
}

export function poolFeePercent(feePips: number): string {
  return `${trimDecimal((feePips / 10_000).toFixed(4))}%`
}

function basisPointsPercent(basisPoints: number): string {
  return `${trimDecimal((basisPoints / 100).toFixed(2))}%`
}

function trimDecimal(value: string): string {
  return value.replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1')
}
