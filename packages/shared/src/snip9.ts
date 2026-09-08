import { CHAIN, feltEquals } from './constants.js'

/**
 * Canonical SNIP-9 outside-execution typed-data schemas (mirrors starknet.js
 * `OutsideExecutionTypesV1` / `OutsideExecutionTypesV2`; a web test enforces the mirror).
 */
export const OUTSIDE_EXECUTION_TYPES = {
  '1': {
    StarkNetDomain: [
      { name: 'name', type: 'felt' },
      { name: 'version', type: 'felt' },
      { name: 'chainId', type: 'felt' },
    ],
    OutsideExecution: [
      { name: 'caller', type: 'felt' },
      { name: 'nonce', type: 'felt' },
      { name: 'execute_after', type: 'felt' },
      { name: 'execute_before', type: 'felt' },
      { name: 'calls_len', type: 'felt' },
      { name: 'calls', type: 'OutsideCall*' },
    ],
    OutsideCall: [
      { name: 'to', type: 'felt' },
      { name: 'selector', type: 'felt' },
      { name: 'calldata_len', type: 'felt' },
      { name: 'calldata', type: 'felt*' },
    ],
  },
  '2': {
    StarknetDomain: [
      { name: 'name', type: 'shortstring' },
      { name: 'version', type: 'shortstring' },
      { name: 'chainId', type: 'shortstring' },
      { name: 'revision', type: 'shortstring' },
    ],
    OutsideExecution: [
      { name: 'Caller', type: 'ContractAddress' },
      { name: 'Nonce', type: 'felt' },
      { name: 'Execute After', type: 'u128' },
      { name: 'Execute Before', type: 'u128' },
      { name: 'Calls', type: 'Call*' },
    ],
    Call: [
      { name: 'To', type: 'ContractAddress' },
      { name: 'Selector', type: 'selector' },
      { name: 'Calldata', type: 'felt*' },
    ],
  },
} as const

const OUTSIDE_EXECUTION_NAME = 'Account.execute_from_outside'
const V1_DOMAIN_KEYS = ['name', 'version', 'chainId']
const V2_DOMAIN_KEYS = ['name', 'version', 'chainId', 'revision']
const V1_MESSAGE_KEYS = ['caller', 'nonce', 'execute_after', 'execute_before', 'calls_len', 'calls']
const V2_MESSAGE_KEYS = ['Caller', 'Nonce', 'Execute After', 'Execute Before', 'Calls']
const V1_CALL_KEYS = ['to', 'selector', 'calldata_len', 'calldata']
const V2_CALL_KEYS = ['To', 'Selector', 'Calldata']

export interface OutsideExecutionCall {
  to: unknown
  selector: unknown
  calldata: unknown[]
}

export interface ParsedOutsideExecution {
  version: '1' | '2'
  calls: OutsideExecutionCall[]
}

/**
 * Strictly parse SNIP-9 typed data. Returns the calls the signature covers only when the payload is
 * exactly the canonical v1 or v2 schema for Starknet mainnet: canonical `types`, canonical domain,
 * a message with exactly the canonical keys, and calls with exactly the canonical keys. Anything
 * else (an unknown version, extra or mixed-case keys, a second calls array, a foreign chain) is
 * rejected, so the calls that are validated are the calls that are signed.
 */
export function parseOutsideExecution(
  typedData: unknown,
  chainId: string = CHAIN.starknet.chainId,
): ParsedOutsideExecution | undefined {
  const data = record(typedData)
  if (!data || data.primaryType !== 'OutsideExecution') return undefined
  const domain = record(data.domain)
  const message = record(data.message)
  const types = record(data.types)
  if (!domain || !message || !types) return undefined
  const version = domain.version === '1' ? '1' : domain.version === '2' ? '2' : undefined
  if (!version) return undefined
  if (!sameTypes(types, OUTSIDE_EXECUTION_TYPES[version])) return undefined
  if (domain.name !== OUTSIDE_EXECUTION_NAME || !expectedChain(domain.chainId, chainId)) return undefined

  if (version === '1') {
    if (!exactKeys(domain, V1_DOMAIN_KEYS) || !exactKeys(message, V1_MESSAGE_KEYS)) return undefined
    if (!Array.isArray(message.calls) || !feltEquals(message.calls_len, message.calls.length)) return undefined
    const calls: OutsideExecutionCall[] = []
    for (const entry of message.calls) {
      const call = record(entry)
      if (!call || !exactKeys(call, V1_CALL_KEYS) || !Array.isArray(call.calldata)) return undefined
      if (!feltEquals(call.calldata_len, call.calldata.length)) return undefined
      calls.push({ to: call.to, selector: call.selector, calldata: call.calldata })
    }
    return { version, calls }
  }

  if (!exactKeys(domain, V2_DOMAIN_KEYS) || domain.revision !== '1') return undefined
  if (!exactKeys(message, V2_MESSAGE_KEYS) || !Array.isArray(message.Calls)) return undefined
  const calls: OutsideExecutionCall[] = []
  for (const entry of message.Calls) {
    const call = record(entry)
    if (!call || !exactKeys(call, V2_CALL_KEYS) || !Array.isArray(call.Calldata)) return undefined
    calls.push({ to: call.To, selector: call.Selector, calldata: call.Calldata })
  }
  return { version, calls }
}

/** True when `call` targets `to` with `selector` and exactly `calldata` (compared by felt value). */
export function sameOutsideCall(
  call: OutsideExecutionCall | undefined,
  expected: { to: unknown; selector: unknown; calldata: unknown[] },
): boolean {
  return (
    call !== undefined &&
    feltEquals(call.to, expected.to) &&
    feltEquals(call.selector, expected.selector) &&
    call.calldata.length === expected.calldata.length &&
    call.calldata.every((value, index) => feltEquals(value, expected.calldata[index]))
  )
}

function expectedChain(actual: unknown, chainId: string): boolean {
  return actual === 'SN_MAIN' || feltEquals(actual, chainId)
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const present = Object.keys(value)
  return present.length === keys.length && keys.every((key) => Object.hasOwn(value, key))
}

function sameTypes(actual: Record<string, unknown>, canonical: Record<string, readonly { name: string; type: string }[]>): boolean {
  const names = Object.keys(canonical)
  if (!exactKeys(actual, names)) return false
  return names.every((name) => {
    const fields = actual[name]
    const expected = canonical[name]!
    if (!Array.isArray(fields) || fields.length !== expected.length) return false
    return fields.every((field, index) => {
      const entry = record(field)
      return (
        entry !== undefined &&
        exactKeys(entry, ['name', 'type']) &&
        entry.name === expected[index]!.name &&
        entry.type === expected[index]!.type
      )
    })
  })
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}
