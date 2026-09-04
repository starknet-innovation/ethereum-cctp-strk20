import { describe, expect, it } from 'vitest'
import type { ProofInvocation } from '@starkware-libs/starknet-privacy-sdk'
import { StarkscanProofProvider } from './starkscanProofProvider.js'

describe('StarkscanProofProvider', () => {
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
