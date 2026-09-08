import { describe, expect, it } from 'vitest'
import {
  CHAIN,
  MAX_PRIVATE_FEE_BASE,
  OUTSIDE_EXECUTION_TYPES,
  STARKNET_SELECTORS,
} from '@privacy-round-trip/shared'
import { OutsideExecutionTypesV1, OutsideExecutionTypesV2, hash } from 'starknet'
import { assertTypedDataCalls, validateFee, type PaymasterCall } from './starknet.js'

const approve: PaymasterCall = {
  to: CHAIN.starknet.usdc,
  selector: STARKNET_SELECTORS.approve,
  calldata: [CHAIN.starknet.privacyPool, '0x64', '0x0'],
}

function v2(calls: PaymasterCall[], chainId: string = CHAIN.starknet.chainId) {
  return {
    types: OUTSIDE_EXECUTION_TYPES['2'],
    primaryType: 'OutsideExecution',
    domain: { name: 'Account.execute_from_outside', version: '2', chainId, revision: '1' },
    message: {
      Caller: '0x414e595f43414c4c4552',
      Nonce: '0x1',
      'Execute After': '0x0',
      'Execute Before': '0xffffffff',
      Calls: calls.map((call) => ({ To: call.to, Selector: call.selector, Calldata: call.calldata })),
    },
  }
}

function v1(calls: PaymasterCall[]) {
  return {
    types: OUTSIDE_EXECUTION_TYPES['1'],
    primaryType: 'OutsideExecution',
    domain: { name: 'Account.execute_from_outside', version: '1', chainId: CHAIN.starknet.chainId },
    message: {
      caller: '0x414e595f43414c4c4552',
      nonce: '0x1',
      execute_after: '0x0',
      execute_before: '0xffffffff',
      calls_len: calls.length,
      calls: calls.map((call) => ({
        to: call.to,
        selector: call.selector,
        calldata_len: call.calldata.length,
        calldata: call.calldata,
      })),
    },
  }
}

describe('paymaster typed data verification', () => {
  it('accepts typed data that carries exactly the requested calls in either layout', () => {
    expect(() => assertTypedDataCalls(v2([approve]), [approve])).not.toThrow()
    expect(() => assertTypedDataCalls(v1([approve]), [approve])).not.toThrow()
    // Encodings differ, values match.
    const padded = v2([{ ...approve, to: `0x0${approve.to.slice(2)}`, calldata: ['0x0' + CHAIN.starknet.privacyPool.slice(2), '100', '0'] }])
    expect(() => assertTypedDataCalls(padded, [approve])).not.toThrow()
  })

  it('rejects an appended drain call', () => {
    const drain: PaymasterCall = {
      to: CHAIN.starknet.usdc,
      selector: hash.getSelectorFromName('transfer'),
      calldata: ['0xbad', '0xffffffff', '0x0'],
    }
    expect(() => assertTypedDataCalls(v2([approve, drain]), [approve])).toThrow(/carries 2 call/)
  })

  it('rejects substituted targets, selectors, calldata, and chains', () => {
    expect(() => assertTypedDataCalls(v2([{ ...approve, to: '0xbad' }]), [approve])).toThrow(/call 0/)
    expect(() =>
      assertTypedDataCalls(v2([{ ...approve, selector: hash.getSelectorFromName('transfer') }]), [approve]),
    ).toThrow(/call 0/)
    expect(() =>
      assertTypedDataCalls(v2([{ ...approve, calldata: ['0xbad', '0x64', '0x0'] }]), [approve]),
    ).toThrow(/call 0/)
    expect(() => assertTypedDataCalls(v2([approve], '0x534e5f5345504f4c4941'), [approve])).toThrow(/not canonical/)
    expect(() => assertTypedDataCalls({ message: {} }, [approve])).toThrow(/not canonical/)
  })

  it('rejects a payload that carries both layouts or non-canonical types', () => {
    const drain: PaymasterCall = { to: CHAIN.starknet.usdc, selector: hash.getSelectorFromName('transfer'), calldata: ['0xbad'] }
    const mixedV1 = v1([drain]) as { message: Record<string, unknown> }
    mixedV1.message.Calls = [{ To: approve.to, Selector: approve.selector, Calldata: approve.calldata }]
    expect(() => assertTypedDataCalls(mixedV1, [approve])).toThrow(/not canonical/)
    const mixedV2 = v2([approve]) as { message: Record<string, unknown> }
    mixedV2.message.calls = [{ to: drain.to, selector: drain.selector, calldata_len: 1, calldata: drain.calldata }]
    expect(() => assertTypedDataCalls(mixedV2, [approve])).toThrow(/not canonical/)
    expect(() => assertTypedDataCalls({ ...v2([approve]), types: {} }, [approve])).toThrow(/not canonical/)
  })

  it('pins the canonical SNIP-9 schemas starknet.js signs against', () => {
    expect(JSON.parse(JSON.stringify(OUTSIDE_EXECUTION_TYPES['1']))).toEqual(OutsideExecutionTypesV1)
    expect(JSON.parse(JSON.stringify(OUTSIDE_EXECUTION_TYPES['2']))).toEqual(OutsideExecutionTypesV2)
  })
})

describe('private fee ceiling', () => {
  const fee = (amount: bigint) => ({
    type: 'withdraw' as const,
    recipient: '0x1',
    token: CHAIN.starknet.usdc,
    amount: amount.toString(),
  })

  it('accepts a fee under both the absolute and relative ceilings', () => {
    expect(validateFee(fee(500_000n), CHAIN.starknet.usdc, 10_000_000n)).toBe(500_000n)
  })

  it('rejects a fee that would take most of the note', () => {
    expect(() => validateFee(fee(9_999_999n), CHAIN.starknet.usdc, 10_000_000n)).toThrow(/ceiling/)
    expect(() => validateFee(fee(2_000_001n), CHAIN.starknet.usdc, 1_000_000_000n)).toThrow(/ceiling/)
    expect(validateFee(fee(MAX_PRIVATE_FEE_BASE), CHAIN.starknet.usdc, 1_000_000_000n)).toBe(MAX_PRIVATE_FEE_BASE)
  })

  it('rejects the wrong token or a fee that consumes everything', () => {
    expect(() => validateFee({ ...fee(1n), token: '0x1' }, CHAIN.starknet.usdc, 10n)).toThrow(/invalid private fee token/)
    expect(() => validateFee(fee(10n), CHAIN.starknet.usdc, 10n)).toThrow(/consumes/)
  })
})

describe('pinned Starknet selectors', () => {
  it('match starknet.js selector derivation', () => {
    for (const [name, selector] of Object.entries(STARKNET_SELECTORS)) {
      expect(BigInt(selector)).toBe(BigInt(hash.getSelectorFromName(name)))
    }
  })
})
