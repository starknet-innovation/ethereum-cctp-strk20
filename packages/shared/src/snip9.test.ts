import { describe, expect, it } from 'vitest'
import { CHAIN } from './constants.js'
import { OUTSIDE_EXECUTION_TYPES, parseOutsideExecution, sameOutsideCall } from './snip9.js'

const call = { to: '0xabc', selector: '0x123', calldata: ['0x1', '0x2'] }

function v2(message: Record<string, unknown> = {}, overrides: Record<string, unknown> = {}) {
  return {
    types: OUTSIDE_EXECUTION_TYPES['2'],
    primaryType: 'OutsideExecution',
    domain: { name: 'Account.execute_from_outside', version: '2', chainId: CHAIN.starknet.chainId, revision: '1' },
    message: {
      Caller: '0x414e595f43414c4c4552',
      Nonce: '0x1',
      'Execute After': '0x0',
      'Execute Before': '0xffffffff',
      Calls: [{ To: call.to, Selector: call.selector, Calldata: call.calldata }],
      ...message,
    },
    ...overrides,
  }
}

function v1(message: Record<string, unknown> = {}, overrides: Record<string, unknown> = {}) {
  return {
    types: OUTSIDE_EXECUTION_TYPES['1'],
    primaryType: 'OutsideExecution',
    domain: { name: 'Account.execute_from_outside', version: '1', chainId: CHAIN.starknet.chainId },
    message: {
      caller: '0x414e595f43414c4c4552',
      nonce: '0x1',
      execute_after: '0x0',
      execute_before: '0xffffffff',
      calls_len: 1,
      calls: [{ to: call.to, selector: call.selector, calldata_len: 2, calldata: call.calldata }],
      ...message,
    },
    ...overrides,
  }
}

describe('strict SNIP-9 parsing', () => {
  it('parses canonical v1 and v2 payloads', () => {
    expect(parseOutsideExecution(v2())).toEqual({ version: '2', calls: [call] })
    expect(parseOutsideExecution(v1())).toEqual({ version: '1', calls: [call] })
    expect(parseOutsideExecution(v2({}, { domain: { ...v2().domain, chainId: 'SN_MAIN' } }))).toBeDefined()
  })

  it('rejects a second calls array in the other layout', () => {
    const malicious = { to: '0xbad', selector: '0x999', calldata: ['0xffff'] }
    // v1 hashes `calls`; a benign `Calls` alongside must not pass.
    expect(
      parseOutsideExecution(v1({ Calls: [{ To: call.to, Selector: call.selector, Calldata: call.calldata }], calls: [{ to: malicious.to, selector: malicious.selector, calldata_len: 1, calldata: malicious.calldata }] })),
    ).toBeUndefined()
    // v2 hashes `Calls`; a stray lowercase `calls` must not pass either.
    expect(parseOutsideExecution(v2({ calls: [malicious] }))).toBeUndefined()
  })

  it('rejects non-canonical types, domains, versions, chains and keys', () => {
    expect(parseOutsideExecution(v2({}, { types: {} }))).toBeUndefined()
    const truncated = { ...OUTSIDE_EXECUTION_TYPES['2'], OutsideExecution: OUTSIDE_EXECUTION_TYPES['2'].OutsideExecution.slice(0, 4) }
    expect(parseOutsideExecution(v2({}, { types: truncated }))).toBeUndefined()
    expect(parseOutsideExecution(v2({}, { primaryType: 'Call' }))).toBeUndefined()
    expect(parseOutsideExecution(v2({}, { domain: { ...v2().domain, version: '3' } }))).toBeUndefined()
    expect(parseOutsideExecution(v2({}, { domain: { ...v2().domain, chainId: '0x534e5f5345504f4c4941' } }))).toBeUndefined()
    expect(parseOutsideExecution(v2({}, { domain: { ...v2().domain, name: 'Other' } }))).toBeUndefined()
    expect(parseOutsideExecution(v2({}, { domain: { ...v2().domain, revision: '0' } }))).toBeUndefined()
    expect(parseOutsideExecution(v2({ Extra: '0x1' }))).toBeUndefined()
    expect(parseOutsideExecution(v2({ Calls: [{ To: '0x1', Selector: '0x2', Calldata: [], Extra: 1 }] }))).toBeUndefined()
    expect(parseOutsideExecution(v1({ calls_len: 2 }))).toBeUndefined()
    expect(parseOutsideExecution(v1({ calls: [{ to: '0x1', selector: '0x2', calldata_len: 3, calldata: ['0x1'] }] }))).toBeUndefined()
    expect(parseOutsideExecution(v2({}, { domain: { ...v2().domain, version: '1' } }))).toBeUndefined()
    expect(parseOutsideExecution(null)).toBeUndefined()
  })

  it('compares calls by felt value', () => {
    expect(sameOutsideCall({ to: '0x0abc', selector: '0x123', calldata: ['1', '0x02'] }, call)).toBe(true)
    expect(sameOutsideCall({ to: '0xabc', selector: '0x123', calldata: ['0x1'] }, call)).toBe(false)
    expect(sameOutsideCall(undefined, call)).toBe(false)
  })
})
