import type { FlowUpdate, PublicFlow } from '@privacy-round-trip/shared'

type UpdateFlow = (id: string, token: string, update: FlowUpdate) => Promise<PublicFlow>

export const SERVER_SAFE_FAILURE_REASON =
  'Browser flow stopped before completion. Recovery may be required in the original tab.'

/** Report a terminal browser failure without making local recovery or retry wait on the API. */
export function reportFlowFailureBestEffort(
  updateFlow: UpdateFlow,
  id: string,
  token: string,
): void {
  try {
    // Never accept raw error text here: provider and transaction errors can contain exit-side
    // hashes that must not be joined to the entry-side API record.
    void updateFlow(id, token, {
      phase: 'failed',
      failureReason: SERVER_SAFE_FAILURE_REASON,
    }).catch(() => undefined)
  } catch {
    // Failure reporting must never hold or replace the original browser failure.
  }
}
