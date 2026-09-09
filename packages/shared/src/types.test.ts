import { describe, expect, it } from 'vitest'
import { flowUpdateSchema } from './types.js'

describe('cross-chain transaction hash validation', () => {
  it('accepts canonical Starknet field-element hashes without left padding', () => {
    expect(
      flowUpdateSchema.parse({ phase: 'starknet-funded', txHash: '0x123abc' }).txHash,
    ).toBe('0x123abc')
  })

  it('accepts 32-byte Ethereum hashes and rejects oversized or empty hashes', () => {
    expect(
      flowUpdateSchema.safeParse({ phase: 'entry-submitted', txHash: `0x${'a'.repeat(64)}` })
        .success,
    ).toBe(true)
    expect(
      flowUpdateSchema.safeParse({ phase: 'starknet-funded', txHash: `0x${'a'.repeat(65)}` })
        .success,
    ).toBe(false)
    expect(flowUpdateSchema.safeParse({ phase: 'starknet-funded', txHash: '0x' }).success).toBe(
      false,
    )
  })
})

describe('exit-side data never reaches the server-side flow record', () => {
  it('rejects a settlement address on any transition', () => {
    expect(
      flowUpdateSchema.safeParse({
        phase: 'bridging-to-ethereum',
        settlementAddress: '0x2222222222222222222222222222222222222222',
      }).success,
    ).toBe(false)
  })

  it('rejects transaction hashes on exit-side phases but allows bare transitions', () => {
    for (const phase of ['bridging-to-ethereum', 'settling', 'completed'] as const) {
      expect(flowUpdateSchema.safeParse({ phase, txHash: `0x${'a'.repeat(64)}` }).success).toBe(false)
      expect(flowUpdateSchema.safeParse({ phase }).success).toBe(true)
    }
  })
})
