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
