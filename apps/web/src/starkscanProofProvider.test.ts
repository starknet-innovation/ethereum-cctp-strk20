import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProofInvocation } from '@starkware-libs/starknet-privacy-sdk'
import {
  ProofApiError,
  StarkscanProofProvider,
  type ProofCheckpoint,
  type ProofCheckpointStore,
} from './starkscanProofProvider.js'

describe('StarkscanProofProvider', () => {
  afterEach(() => vi.useRealTimers())

  it('submits an explicit block and preserves the complete proof response', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    const fetchImpl: typeof fetch = async (input, init) => {
      requests.push({ url: String(input), ...(init ? { init } : {}) })
      return new Response(
        JSON.stringify({
          jobId: 'prv_9f2c1ab34de56789012345ab',
          status: 'succeeded',
          terminal: true,
          pollToken: 'a'.repeat(64),
          result: {
            proof: 'proof-data',
            proof_facts: ['0x1'],
            l2_to_l1_messages: [
              { from_address: '0x0123', to_address: '0x456', payload: ['0x99'] },
            ],
            additional_data: {
              signature: {
                issued_at: Math.floor(Date.now() / 1_000),
                sig_r: '0x1',
                sig_s: '0x2',
              },
            },
          },
        }),
        { status: 202, headers: { 'content-type': 'application/json' } },
      )
    }
    const provider = new StarkscanProofProvider({
      apiBaseUrl: 'https://api.example',
      rpcUrl: 'https://rpc.example',
      poolAddress: '0x123',
      fetchImpl,
    })
    const invocation = {
      type: 'INVOKE',
      sender_address: '0x123',
      calldata: [],
    } as unknown as ProofInvocation

    const proof = await provider.prove(invocation, 12_446_898)

    expect(proof).toEqual({
      data: 'proof-data',
      output: ['0x99'],
      proofFacts: ['0x1'],
      additionalData: {
        signature: {
          issued_at: expect.any(Number),
          sig_r: '0x1',
          sig_s: '0x2',
        },
      },
    })
    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toBe('https://api.example/v1/proofs')
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
      block_id: { block_number: 12_446_898 },
      transaction: invocation,
    })
    expect(new Headers(requests[0]?.init?.headers).get('idempotency-key')).toMatch(
      /^[0-9a-f-]{36}$/,
    )
  })

  it('calls fetch with the browser global as its receiver', async () => {
    const fetchImpl = function (this: unknown): Promise<Response> {
      if (this !== globalThis) throw new TypeError('Illegal invocation')
      return Promise.resolve(
        new Response(
          JSON.stringify({
            jobId: 'prv_9f2c1ab34de56789012345ac',
            status: 'succeeded',
            terminal: true,
            pollToken: 'b'.repeat(64),
            result: {
              proof: 'proof-data',
              proof_facts: [],
              l2_to_l1_messages: [],
            },
          }),
          { status: 202, headers: { 'content-type': 'application/json' } },
        ),
      )
    } as typeof fetch
    const provider = new StarkscanProofProvider({
      apiBaseUrl: 'https://api.example',
      rpcUrl: 'https://rpc.example',
      poolAddress: '0x123',
      fetchImpl,
    })
    const invocation = {
      type: 'INVOKE',
      sender_address: '0x123',
      calldata: [],
    } as unknown as ProofInvocation

    await expect(provider.prove(invocation, 12_446_898)).resolves.toMatchObject({
      data: 'proof-data',
    })
  })

  it('honors Retry-After and retries a throttled proof submission', async () => {
    vi.useFakeTimers()
    let calls = 0
    let firstRequestReady!: () => void
    const firstRequest = new Promise<void>((resolve) => {
      firstRequestReady = resolve
    })
    const fetchImpl: typeof fetch = async () => {
      calls += 1
      if (calls === 1) {
        firstRequestReady()
        return new Response('{}', {
          status: 429,
          headers: { 'content-type': 'application/json', 'retry-after': '1' },
        })
      }
      return new Response(
        JSON.stringify({
          jobId: 'prv_9f2c1ab34de56789012345ad',
          status: 'succeeded',
          terminal: true,
          pollToken: 'c'.repeat(64),
          result: { proof: 'proof-after-backoff', proof_facts: [], l2_to_l1_messages: [] },
        }),
        { status: 202, headers: { 'content-type': 'application/json' } },
      )
    }
    const provider = new StarkscanProofProvider({
      apiBaseUrl: 'https://api.example',
      rpcUrl: 'https://rpc.example',
      poolAddress: '0x123',
      fetchImpl,
    })
    const proofPromise = provider.prove(
      { type: 'INVOKE', sender_address: '0x123', calldata: [] } as unknown as ProofInvocation,
      12_446_898,
    )

    await firstRequest
    await vi.advanceTimersByTimeAsync(1_000)

    await expect(proofPromise).resolves.toMatchObject({ data: 'proof-after-backoff' })
    expect(calls).toBe(2)
  })

  it('resumes a journaled proof job without submitting a duplicate', async () => {
    let checkpoint: ProofCheckpoint | undefined
    let simulateReload = true
    const checkpointStore: ProofCheckpointStore = {
      load: () => checkpoint,
      save: (value) => {
        checkpoint = structuredClone(value)
        if (simulateReload && value.job) throw new Error('simulated tab reload')
      },
      clear: () => {
        checkpoint = undefined
      },
    }
    const requests: string[] = []
    const fetchImpl: typeof fetch = async (input, init) => {
      requests.push(init?.method ?? 'GET')
      if (init?.method === 'POST') {
        return new Response(
          JSON.stringify({
            jobId: 'prv_9f2c1ab34de56789012345ae',
            status: 'queued',
            terminal: false,
            pollAfterSeconds: 1,
            pollToken: 'd'.repeat(64),
          }),
          { status: 202, headers: { 'content-type': 'application/json' } },
        )
      }
      expect(String(input)).toContain('prv_9f2c1ab34de56789012345ae')
      return new Response(
        JSON.stringify({
          jobId: 'prv_9f2c1ab34de56789012345ae',
          status: 'succeeded',
          terminal: true,
          result: { proof: 'resumed-proof', proof_facts: [], l2_to_l1_messages: [] },
        }),
        { headers: { 'content-type': 'application/json' } },
      )
    }
    const invocation = {
      type: 'INVOKE',
      sender_address: '0x123',
      calldata: [],
    } as unknown as ProofInvocation

    const interrupted = new StarkscanProofProvider({
      apiBaseUrl: 'https://api.example',
      rpcUrl: 'https://rpc.example',
      poolAddress: '0x123',
      fetchImpl,
      checkpointStore,
    })
    await expect(interrupted.prove(invocation, 12_446_898)).rejects.toThrow('simulated tab reload')

    simulateReload = false
    const resumed = new StarkscanProofProvider({
      apiBaseUrl: 'https://api.example',
      rpcUrl: 'https://rpc.example',
      poolAddress: '0x123',
      fetchImpl,
      checkpointStore,
    })
    const proofPromise = resumed.prove(invocation, 12_446_898)

    await expect(proofPromise).resolves.toMatchObject({ data: 'resumed-proof' })
    expect(requests).toEqual(['POST', 'GET'])
  })

  it('surfaces daily proof exhaustion without burst retries', async () => {
    let calls = 0
    const provider = new StarkscanProofProvider({
      apiBaseUrl: 'https://api.example',
      rpcUrl: 'https://rpc.example',
      poolAddress: '0x123',
      fetchImpl: async () => {
        calls += 1
        return new Response(
          JSON.stringify({
            error: {
              code: 'prover_daily_budget_exhausted',
              message: 'Daily proof budget exhausted',
            },
          }),
          {
            status: 429,
            headers: { 'content-type': 'application/json', 'retry-after': '3600' },
          },
        )
      },
    })

    const error = await provider
      .prove(
        { type: 'INVOKE', sender_address: '0x123', calldata: [] } as unknown as ProofInvocation,
        12_446_898,
      )
      .catch((cause: unknown) => cause)

    expect(error).toBeInstanceOf(ProofApiError)
    expect(error).toMatchObject({
      status: 429,
      code: 'prover_daily_budget_exhausted',
      retryAfterMs: 3_600_000,
    })
    expect((error as Error).message).toContain('Daily proof budget exhausted')
    expect(calls).toBe(1)
  })

  it('fails closed without an explicit block number', async () => {
    const provider = new StarkscanProofProvider({
      apiBaseUrl: 'https://api.example',
      rpcUrl: 'https://rpc.example',
      poolAddress: '0x123',
      fetchImpl: async () => {
        throw new Error('fetch should not run')
      },
    })
    const invocation = {
      type: 'INVOKE',
      sender_address: '0x123',
      calldata: [],
    } as unknown as ProofInvocation

    await expect(provider.prove(invocation, 'latest')).rejects.toThrow('explicit finalized block')
  })
})
