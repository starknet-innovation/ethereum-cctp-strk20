import { describe, expect, it } from 'vitest'
import { ec, hash } from 'starknet'
import { MAX_VIEWING_KEY } from '@starkware-libs/starknet-privacy-sdk'
import {
  createEphemeralIdentity,
  createViewingKey,
  isCanonicalViewingKey,
} from './identity.js'

describe('ephemeral Starknet identity', () => {
  it('creates independent signing and viewing secrets for the computed OZ account', () => {
    const identity = createEphemeralIdentity()
    expect(identity.privateKey).toMatch(/^0x[0-9a-f]+$/i)
    expect(identity.viewingKey).toBeGreaterThan(0n)
    expect(identity.viewingKey).toBeLessThanOrEqual(MAX_VIEWING_KEY)
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

  it('keeps privacy viewing keys in the pool canonical scalar range', () => {
    for (let index = 0; index < 64; index += 1) {
      expect(isCanonicalViewingKey(createViewingKey())).toBe(true)
    }
    expect(isCanonicalViewingKey(0n)).toBe(false)
    expect(isCanonicalViewingKey(MAX_VIEWING_KEY + 1n)).toBe(false)
  })
})
