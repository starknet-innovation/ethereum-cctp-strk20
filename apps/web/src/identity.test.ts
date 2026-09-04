import { describe, expect, it } from 'vitest'
import { ec, hash } from 'starknet'
import { createEphemeralIdentity } from './identity.js'

describe('ephemeral Starknet identity', () => {
  it('creates independent signing and viewing secrets for the computed OZ account', () => {
    const identity = createEphemeralIdentity()
    expect(identity.privateKey).toMatch(/^0x[0-9a-f]+$/i)
    expect(identity.viewingKey).toBeGreaterThan(0n)
    expect(BigInt(identity.privateKey)).not.toBe(identity.viewingKey)
    expect(ec.starkCurve.getStarkKey(identity.privateKey)).toBe(identity.publicKey)
    expect(
      hash.calculateContractAddressFromHash(
        identity.salt,
        identity.classHash,
        [identity.publicKey],
        0,
      ),
    ).toBe(identity.address)
  })
})
