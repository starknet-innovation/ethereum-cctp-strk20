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
const THROTTLED_RETRY_SECONDS = 60
const MIN_ATTESTATION_MARGIN_SECONDS = 60
const RETRYABLE_HTTP_STATUSES = new Set([429, 502, 503, 504])

export interface ProofCheckpoint {
  version: 1
  provingBlockId: number
  requestHash?: string
  idempotencyKey?: string
  job?: ProofRelaySubmission
}

export interface ProofCheckpointStore {
  load(): ProofCheckpoint | undefined
  save(checkpoint: ProofCheckpoint): void
  clear(): void
}

export class StarkscanProofProvider implements ProofProviderInterface {
  private readonly defaults: ProvingServiceProofProvider
  private readonly proofsUrl: string
  private readonly fetchImpl: typeof fetch
  private readonly checkpointStore: ProofCheckpointStore | undefined

  constructor(args: {
    apiBaseUrl: string
    rpcUrl: string
    poolAddress: string
    fetchImpl?: typeof fetch
    checkpointStore?: ProofCheckpointStore
  }) {
    this.proofsUrl = `${args.apiBaseUrl.replace(/\/$/, '')}/v1/proofs`
    // Window.fetch is not a context-free function in every browser. Keeping the native function
    // as a class property and invoking it as `this.fetchImpl(...)` changes its receiver to this
    // provider, which Chromium/WebKit reject with "Illegal invocation". Bind the implementation
    // once so native fetch always receives the global object as its receiver.
    this.fetchImpl = (args.fetchImpl ?? fetch).bind(globalThis)
    this.checkpointStore = args.checkpointStore
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
    const deadline = Date.now() + PROOF_TIMEOUT_MS
    const body = { block_id: { block_number: blockNumber }, transaction: invocation }
    const requestHash = await sha256(JSON.stringify(body))
    const saved = this.checkpointStore?.load()
    // A checkpoint is only resumable for the identical request. The SDK injects fresh randomness
    // into every rebuilt invocation, so a different hash or block means a different proof: start
    // it under a new idempotency key instead of replaying a job that belongs to another transaction.
    const resumable =
      saved !== undefined && saved.provingBlockId === blockNumber && saved.requestHash === requestHash
    const idempotencyKey = resumable && saved.idempotencyKey ? saved.idempotencyKey : crypto.randomUUID()
    const checkpoint: ProofCheckpoint = {
      version: 1,
      provingBlockId: blockNumber,
      requestHash,
      idempotencyKey,
      ...(resumable && saved.job ? { job: saved.job } : {}),
    }
    this.checkpointStore?.save(checkpoint)

    let job = checkpoint.job
    if (!job) {
      job = await this.submit(body, idempotencyKey, deadline)
      checkpoint.job = job
      this.checkpointStore?.save(checkpoint)
    }

    while (!job.terminal) {
      if (Date.now() >= deadline) {
        throw new Error(`Starkscan proof job ${job.jobId} timed out; keep this tab open and retry`)
      }
      await sleep(pollDelayMs(job.pollAfterSeconds))
      job = await this.poll(job.jobId, job.pollToken, deadline)
      checkpoint.job = job
      this.checkpointStore?.save(checkpoint)
    }

    if (job.status !== 'succeeded' || !job.result) {
      this.checkpointStore?.clear()
      throw proofJobError(job)
    }
    try {
      assertUsableAttestation(job.result)
    } catch (error) {
      this.checkpointStore?.clear()
      throw error
    }
    return toSdkProof(job.result, invocation.sender_address)
  }

  private async submit(
    body: unknown,
    idempotencyKey: string,
    deadline: number,
  ): Promise<ProofRelaySubmission> {
    let lastError: unknown
    for (let attempt = 0; attempt < 4; attempt += 1) {
      if (Date.now() >= deadline) throw lastError ?? new Error('Starkscan proof submission timed out')
      try {
        const response = await this.fetchImpl(this.proofsUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(35_000),
        })
        if (response.ok) return parseSubmission(await response.json())
        const error = await responseError(response)
        if (isDailyBudgetError(error) || !RETRYABLE_HTTP_STATUSES.has(response.status) || attempt === 3) {
          throw error
        }
        lastError = error
      } catch (error) {
        lastError = error
        if (
          attempt === 3 ||
          isDailyBudgetError(error) ||
          (error instanceof HttpError && !RETRYABLE_HTTP_STATUSES.has(error.status))
        ) {
          throw error
        }
      }
      const fallback =
        lastError instanceof HttpError && lastError.status === 429
          ? THROTTLED_RETRY_SECONDS * 1_000
          : Math.min(1_000 * 2 ** attempt, 8_000)
      await sleep(Math.min(retryDelayMs(lastError, fallback), Math.max(0, deadline - Date.now())))
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
        if (error instanceof HttpError && !RETRYABLE_HTTP_STATUSES.has(error.status)) throw error
        await sleep(retryDelayMs(error, DEFAULT_POLL_SECONDS * 1_000))
      }
    }
  }
}

export class ProofApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly retryAfterMs?: number,
    readonly code?: string,
  ) {
    super(message)
  }
}

class HttpError extends ProofApiError {}

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
  const body = await response.json().catch(() => undefined)
  const detail = upstreamErrorDetail(body)
  const message = detail?.text
    ? `Starkscan proof API returned HTTP ${response.status}: ${detail.text}`
    : `Starkscan proof API returned HTTP ${response.status}`
  const retryAfterMs =
    parseRetryAfterMs(response.headers.get('retry-after')) ??
    (detail?.code === 'prover_daily_budget_exhausted' ? untilNextUtcDayMs() : undefined)
  return new HttpError(response.status, message, retryAfterMs, detail?.code)
}

function upstreamErrorDetail(value: unknown): { text: string; code?: string } | undefined {
  const body = optionalRecord(value)
  if (!body) return undefined
  if (typeof body.error === 'string') return { text: body.error }
  const nested = optionalRecord(body.error)
  const code = stringOrNumber(nested?.code ?? body.code)
  const message = firstString(nested?.message, body.message, nested?.detail, body.detail)
  if (code && message) return { text: `${code}: ${message}`, code }
  if (code) return { text: code, code }
  return message ? { text: message } : undefined
}

function isDailyBudgetError(error: unknown): boolean {
  return (
    error instanceof ProofApiError &&
    (error.code === 'prover_daily_budget_exhausted' || /daily.+budget|budget.+exhausted/i.test(error.message))
  )
}

function retryDelayMs(error: unknown, fallbackMs: number): number {
  return error instanceof HttpError && error.retryAfterMs !== undefined
    ? error.retryAfterMs
    : fallbackMs
}

function parseRetryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1_000, 24 * 60 * 60_000)
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return undefined
  return Math.min(Math.max(0, timestamp - Date.now()), 24 * 60 * 60_000)
}

function untilNextUtcDayMs(): number {
  const now = new Date()
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1) - now.getTime()
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
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

function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && value.length > 0)
}

function stringOrNumber(value: unknown): string | undefined {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : undefined
}

function formatDetail(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value).slice(0, 500)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, ms))
}
