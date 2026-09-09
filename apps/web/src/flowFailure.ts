import type { FlowUpdate, PublicFlow } from '@privacy-round-trip/shared'

type UpdateFlow = (id: string, token: string, update: FlowUpdate) => Promise<PublicFlow>

/** Report a terminal browser failure without making local recovery or retry wait on the API. */
export function reportFlowFailureBestEffort(
  updateFlow: UpdateFlow,
  id: string,
  token: string,
  failureReason: string,
): void {
  try {
    void updateFlow(id, token, { phase: 'failed', failureReason }).catch(() => undefined)
  } catch {
    // Failure reporting must never hold or replace the original browser failure.
  }
}
