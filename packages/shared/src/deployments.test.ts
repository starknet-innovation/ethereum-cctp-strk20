import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { POC_DEPLOYMENTS, feltEquals } from './constants.js'

const root = new URL('../../../deployments/', import.meta.url)
const ethereum = JSON.parse(readFileSync(new URL('ethereum-mainnet.json', root), 'utf8'))
const starknet = JSON.parse(readFileSync(new URL('starknet-mainnet.json', root), 'utf8'))

describe('pinned POC deployments', () => {
  it('mirror the recorded Ethereum mainnet deployments', () => {
    expect(POC_DEPLOYMENTS.ethereum.entryRouter.toLowerCase()).toBe(
      ethereum.contracts.privacyEntryRouter.address.toLowerCase(),
    )
    expect(POC_DEPLOYMENTS.ethereum.exitSettlementFactory.toLowerCase()).toBe(
      ethereum.contracts.exitSettlementFactory.address.toLowerCase(),
    )
  })

  it('mirror the recorded Starknet mainnet deployment', () => {
    expect(feltEquals(POC_DEPLOYMENTS.starknet.cctpExitAnonymizer, starknet.contract.address)).toBe(true)
  })

  it('compare felts by value', () => {
    expect(feltEquals('0x0001', '0x1')).toBe(true)
    expect(feltEquals('0xABC', '0xabc')).toBe(true)
    expect(feltEquals('10', '0xa')).toBe(true)
    expect(feltEquals('0x1', '0x2')).toBe(false)
    expect(feltEquals(undefined, '0x1')).toBe(false)
    expect(feltEquals('not-a-felt', '0x1')).toBe(false)
  })
})
