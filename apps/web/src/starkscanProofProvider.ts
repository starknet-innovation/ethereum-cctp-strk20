import {
  ProvingServiceProofProvider,
  type Proof,
  type ProofInvocation,
  type ProofInvocationFactoryDetails,
  type ProofProviderInterface,
  type ProvingBlockId,
} from '@starkware-libs/starknet-privacy-sdk'
import type { ProofRelayJob, ProofRelayResult, ProofRelaySubmission } from '@privacy-round-trip/shared'
import { constants } from 'starknet'

const PROOF_TIMEOUT_MS = 30 * 60_000
const DEFAULT_POLL_SECONDS = 10
const MIN_ATTESTATION_MARGIN_SECONDS = 60

export class StarkscanProofProvider implements ProofProviderInterface {
  private readonly defaults: ProvingServiceProofProvider
  private readonly proofsUrl: string
  private readonly fetchImpl: typeof fetch

  constructor(args: {
    apiBaseUrl: string
    rpcUrl: string
    poolAddress: string
    fetchImpl?: typeof fetch
  }) {
    this.proofsUrl = `${args.apiBaseUrl.replace(/\/$/, '')}/v1/proofs`
    this.fetchImpl = args.fetchImpl ?? fetch
    this.defaults = new ProvingServiceProofProvider(this.proofsUrl, constants.StarknetChainId.SN_MAIN, {
      nodeUrl: args.rpcUrl,
      poolAddress: args.poolAddress,
    })
  }

  getDefaultDetails(): Promise<ProofInvocationFactoryDetails> {
    return this.defaults.getDefaultDetails()
  }

  invalidateNonceCache(): void {
    this.defaults.invalidateNonceCache()
  }

  async prove(invocation: ProofInvocation, blockIdentifier?: ProvingBlockId): Promise<Proof> {
    const blockNumber = explicitBlockNumber(blockIdentifier)
    const idempotencyKey = crypto.randomUUID()
    let job = await this.submit(
      { block_id: { block_number: blockNumber }, transaction: invocation },
      idempotencyKey,
    )
    const deadline = Date.now() + PROOF_TIMEOUT_MS

    while (!job.terminal) {
      if (Date.now() >= deadline) {
        throw new Error(`Starkscan proof job ${job.jobId} timed out; keep this tab open and retry`)
      }
      await sleep(pollDelayMs(job.pollAfterSeconds))
      job = await this.poll(job.jobId, job.pollToken, deadline)
    }

    if (job.status !== 'succeeded' || !job.result) throw proofJobError(job)
    assertUsableAttestation(job.result)
    return toSdkProof(job.result, invocation.sender_address)
  }

  private async submit(body: unknown, idempotencyKey: string): Promise<ProofRelaySubmission> {
    let lastError: unknown
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        const response = await this.fetchImpl(this.proofsUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(35_000),
        })
        if (response.ok) return parseSubmission(await response.json())
        const error = await responseError(response)
        if (![502, 503, 504].includes(response.status) || attempt === 3) throw error
        lastError = error
      } catch (error) {
        lastError = error
        if (attempt === 3 || (error instanceof HttpError && ![502, 503, 504].includes(error.status))) {
          throw error
        }
      }
      await sleep(Math.min(1_000 * 2 ** attempt, 8_000))
    }
    throw lastError
  }

  private async poll(
    jobId: string,
    pollToken: string,
    deadline: number,
  ): Promise<ProofRelaySubmission> {
    for (;;) {
      if (Date.now() >= deadline) {
        throw new Error(`Starkscan proof job ${jobId} timed out; keep this tab open and retry`)
      }
      try {
        const response = await this.fetchImpl(`${this.proofsUrl}/${encodeURIComponent(jobId)}`, {
          headers: { accept: 'application/json', 'x-proof-token': pollToken },
          signal: AbortSignal.timeout(35_000),
        })
        if (!response.ok) throw await responseError(response)
        return { ...parseJob(await response.json()), pollToken }
      } catch (error) {
        if (error instanceof HttpError && ![502, 503, 504].includes(error.status)) throw error
        await sleep(DEFAULT_POLL_SECONDS * 1_000)
      }
    }
  }
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

function explicitBlockNumber(blockIdentifier: ProvingBlockId | undefined): number {
  if (typeof blockIdentifier === 'number' || typeof blockIdentifier === 'bigint') {
    const value = Number(blockIdentifier)
    if (Number.isSafeInteger(value) && value >= 0) return value
  }
  throw new Error('Starkscan requires an explicit finalized block number for every proof')
}

function parseSubmission(value: unknown): ProofRelaySubmission {
  const job = parseJob(value)
  const pollToken = record(value).pollToken
  if (typeof pollToken !== 'string' || !/^[0-9a-f]{64}$/.test(pollToken)) {
    throw new Error('Proof API returned an invalid poll capability')
  }
  return { ...job, pollToken }
}

function parseJob(value: unknown): ProofRelayJob {
  const job = record(value)
  if (
    typeof job.jobId !== 'string' ||
    typeof job.status !== 'string' ||
    !['queued', 'dispatched', 'succeeded', 'failed', 'unavailable', 'unknown_delivery'].includes(
      job.status,
    ) ||
    typeof job.terminal !== 'boolean'
  ) {
    throw new Error('Proof API returned an invalid Starkscan job')
  }
  return value as ProofRelayJob
}

function toSdkProof(result: ProofRelayResult, senderAddress: string): Proof {
  if (
    typeof result.proof !== 'string' ||
    !Array.isArray(result.proof_facts) ||
    !result.proof_facts.every((value) => typeof value === 'string') ||
    !Array.isArray(result.l2_to_l1_messages)
  ) {
    throw new Error('Starkscan returned an invalid proof result')
  }
  const sender = normalizeFelt(senderAddress)
  const poolMessage = result.l2_to_l1_messages.find(
    (message) => normalizeFelt(message.from_address) === sender && Array.isArray(message.payload),
  )
  return {
    data: result.proof,
    output: poolMessage?.payload ?? [],
    proofFacts: result.proof_facts,
    ...(result.additional_data ? { additionalData: result.additional_data } : {}),
  }
}

function assertUsableAttestation(result: ProofRelayResult): void {
  const issuedAt = result.additional_data?.signature?.issued_at
  if (issuedAt === undefined) return
  const remaining = issuedAt + 300 - Math.floor(Date.now() / 1_000)
  if (remaining < MIN_ATTESTATION_MARGIN_SECONDS) {
    throw new Error('Starkscan deposit attestation has too little validity remaining; request a fresh proof')
  }
}

function proofJobError(job: ProofRelayJob): Error {
  const code = job.error?.code === undefined ? '' : ` (${String(job.error.code)})`
  const detail = job.error?.data === undefined ? '' : `: ${formatDetail(job.error.data)}`
  const message = job.error?.message ?? job.resultUnavailableReason ?? 'proof did not succeed'
  return new Error(`Starkscan proof ${job.status}${code}: ${message}${detail}`)
}

async function responseError(response: Response): Promise<HttpError> {
  const body = (await response.json().catch(() => undefined)) as { error?: unknown } | undefined
  const message = typeof body?.error === 'string' ? body.error : `Proof API returned HTTP ${response.status}`
  return new HttpError(response.status, message)
}

function pollDelayMs(value: number | undefined): number {
  const seconds = Number.isFinite(value) ? Number(value) : DEFAULT_POLL_SECONDS
  return Math.max(1, Math.min(seconds, 60)) * 1_000
}

function normalizeFelt(value: string): string {
  return `0x${BigInt(value).toString(16)}`
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Proof API returned malformed JSON')
  }
  return value as Record<string, unknown>
}

function formatDetail(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value).slice(0, 500)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}
