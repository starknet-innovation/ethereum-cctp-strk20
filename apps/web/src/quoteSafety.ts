import type { QuoteRequest, RouteQuote } from '@privacy-round-trip/shared'

const FEE_CAP_FIELDS = [
  'inboundCctpProtocolFeeBase',
  'inboundCctpMaxFeeBase',
  'estimatedStarknetFeesBase',
  'outboundCctpProtocolFeeBase',
  'outboundCctpForwardingFeeBase',
  'outboundCctpMaxFeeBase',
] as const satisfies readonly (keyof RouteQuote)[]

/**
 * Apply a just-in-time market refresh without weakening anything the user reviewed. The refreshed
 * quote supplies current swap outputs and fee caps, while the original quote remains the hard
 * floor. A more expensive route is returned to the review screen before any transaction is sent.
 */
export function executionQuoteForReviewedRoute(
  reviewed: RouteQuote,
  fresh: RouteQuote,
): RouteQuote {
  if (!quoteRequestsEqual(fresh.request, reviewed.request)) {
    throw new Error('The refreshed route does not match the route you reviewed.')
  }
  if (
    BigInt(fresh.estimatedBridgeAmountBase) < BigInt(reviewed.minimumBridgeAmountBase) ||
    BigInt(fresh.estimatedOutputAmountBase) < BigInt(reviewed.minimumOutputAmountBase)
  ) {
    throw new Error('The market moved beyond the reviewed slippage limit. Review the refreshed route.')
  }
  if (fresh.entryPoolFee !== reviewed.entryPoolFee || fresh.exitPoolFee !== reviewed.exitPoolFee) {
    throw new Error('The best swap pool changed. Review the refreshed route before continuing.')
  }
  if (FEE_CAP_FIELDS.some((field) => feeRequiresReview(reviewed[field], fresh[field]))) {
    throw new Error(
      'A route fee increased or its disclosure changed. Review the refreshed fee breakdown before continuing.',
    )
  }

  return {
    ...fresh,
    minimumBridgeAmountBase: reviewed.minimumBridgeAmountBase,
    minimumOutputAmountBase: reviewed.minimumOutputAmountBase,
  }
}

export function quoteRequestsEqual(left: QuoteRequest, right: QuoteRequest): boolean {
  return (
    left.inputToken === right.inputToken &&
    left.outputToken === right.outputToken &&
    left.amount === right.amount &&
    left.slippageBps === right.slippageBps
  )
}

function feeRequiresReview(reviewed: RouteQuote[keyof RouteQuote], fresh: RouteQuote[keyof RouteQuote]): boolean {
  if (fresh === undefined) return reviewed !== undefined
  if (reviewed === undefined) return true
  if (typeof reviewed !== 'string' || typeof fresh !== 'string') return reviewed !== fresh
  return BigInt(fresh) > BigInt(reviewed)
}
