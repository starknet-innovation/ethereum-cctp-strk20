import type { FlowPhase, FlowUpdate, PublicFlow } from './types.js'

const ALLOWED: Record<FlowPhase, readonly FlowPhase[]> = {
  prepared: ['allowance-required', 'entry-submitted', 'failed'],
  'allowance-required': ['entry-submitted', 'failed'],
  'entry-submitted': ['bridging-to-starknet', 'failed'],
  'bridging-to-starknet': ['starknet-funded', 'failed'],
  'starknet-funded': ['pool-depositing', 'failed'],
  'pool-depositing': ['privacy-delay', 'failed'],
  'privacy-delay': ['pool-withdrawing', 'failed'],
  'pool-withdrawing': ['bridging-to-ethereum', 'failed'],
  'bridging-to-ethereum': ['settling', 'failed'],
  settling: ['completed', 'failed'],
  completed: [],
  failed: [],
}

export function canTransition(from: FlowPhase, to: FlowPhase): boolean {
  return ALLOWED[from].includes(to)
}

export function applyFlowUpdate(flow: PublicFlow, update: FlowUpdate, now = new Date()): PublicFlow {
  if (!canTransition(flow.phase, update.phase)) {
    throw new Error(`Invalid flow transition: ${flow.phase} -> ${update.phase}`)
  }

  const occurredAt = update.occurredAt ?? now.toISOString()
  const patch: Partial<PublicFlow> = { phase: update.phase, updatedAt: occurredAt }
  if (update.settlementAddress) patch.settlementAddress = update.settlementAddress
  if (update.failureReason) patch.failureReason = update.failureReason

  if (update.txHash) {
    const key = transactionField(update.phase)
    if (key) patch[key] = update.txHash
  }

  if (update.phase === 'privacy-delay') {
    patch.privacyDepositConfirmedAt = occurredAt
    patch.exitEligibleAt = new Date(
      new Date(occurredAt).getTime() + flow.delayMinutes * 60_000,
    ).toISOString()
  }

  return { ...flow, ...patch }
}

function transactionField(
  phase: FlowPhase,
):
  | 'entryTxHash'
  | 'inboundMintTxHash'
  | 'poolDepositTxHash'
  | 'poolExitTxHash'
  | 'outboundMintTxHash'
  | 'settlementTxHash'
  | undefined {
  switch (phase) {
    case 'entry-submitted':
      return 'entryTxHash'
    case 'starknet-funded':
      return 'inboundMintTxHash'
    case 'privacy-delay':
      return 'poolDepositTxHash'
    case 'bridging-to-ethereum':
      return 'poolExitTxHash'
    case 'settling':
      return 'outboundMintTxHash'
    case 'completed':
      return 'settlementTxHash'
    default:
      return undefined
  }
}

export function remainingDelayMs(flow: PublicFlow, now = Date.now()): number {
  if (!flow.exitEligibleAt) return 0
  return Math.max(0, new Date(flow.exitEligibleAt).getTime() - now)
}
