import { RpcProvider, type Abi } from 'starknet'

export function starknetProvider(rpcUrl: string): RpcProvider {
  return new RpcProvider({ nodeUrl: rpcUrl })
}

export interface AbiFunction {
  name: string
  inputs: Array<{ name: string; type: string }>
  outputs: Array<{ type: string }>
  state_mutability?: string
}

/** Flatten a Cairo ABI (top-level functions plus embedded interfaces) into its functions. */
export function abiFunctions(abi: Abi): AbiFunction[] {
  const functions: AbiFunction[] = []
  for (const item of abi as Array<Record<string, unknown>>) {
    if (item.type === 'function') functions.push(item as unknown as AbiFunction)
    if (item.type === 'interface') {
      for (const inner of (item.items as Array<Record<string, unknown>>) ?? []) {
        if (inner.type === 'function') functions.push(inner as unknown as AbiFunction)
      }
    }
  }
  return functions
}

export function abiFunction(abi: Abi, name: string): AbiFunction | undefined {
  return abiFunctions(abi).find((item) => item.name === name)
}

export function constructorInputs(abi: Abi): Array<{ name: string; type: string }> {
  const item = (abi as Array<Record<string, unknown>>).find((entry) => entry.type === 'constructor')
  return (item?.inputs as Array<{ name: string; type: string }>) ?? []
}

/** Last path segment of a Cairo type, e.g. `core::integer::u256` -> `u256`. */
export function shortType(type: string): string {
  return type.split('::').pop() ?? type
}

export function signatureOf(fn: AbiFunction): string {
  return `${fn.name}(${fn.inputs.map((input) => `${input.name}: ${shortType(input.type)}`).join(', ')})`
}

export async function callFelts(
  provider: RpcProvider,
  contractAddress: string,
  entrypoint: string,
  calldata: string[] = [],
): Promise<string[]> {
  return provider.callContract({ contractAddress, entrypoint, calldata })
}

export function u256FromFelts(felts: string[]): bigint {
  const [low = '0x0', high = '0x0'] = felts
  return BigInt(low) | (BigInt(high) << 128n)
}
