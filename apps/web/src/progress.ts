import type { Address, Hex } from 'viem'

export const RECOVERY_PROGRESS_KIND = 'privacy-round-trip-progress' as const

/**
 * Exit-side progress the browser keeps for itself. None of it is sent to the API (the server-side
 * flow record deliberately stops at entry-side data). Same-tab recovery reads it to resume after
 * the private deposit without re-quoting or re-deploying a settlement.
 */
export interface RecoveryProgress {
  kind: typeof RECOVERY_PROGRESS_KIND
  flowId?: string
  entryTxHash?: string
  inboundMintTxHash?: string
  depositTxHash?: string
  depositedAt?: string
  privateAmount?: string
  salt?: Hex
  recoverAfter?: number
  settlement?: Address
  settlementTxHash?: Hex
  exitTxHash?: string
  finalTxHash?: Hex
}

export function createRecoveryProgress(): RecoveryProgress {
  return { kind: RECOVERY_PROGRESS_KIND }
}

export function isRecoveryProgress(value: unknown): value is RecoveryProgress {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { kind?: unknown }).kind === RECOVERY_PROGRESS_KIND
  )
}
