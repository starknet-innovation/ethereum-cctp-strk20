import { beforeAll, describe, expect, it } from 'vitest'
import { CHAIN, TOKENS } from '@privacy-round-trip/shared'
import { constants, type Abi, type RpcProvider } from 'starknet'
import { createEphemeralIdentity } from '../../../apps/web/src/identity.js'
import { env, requireEnv } from '../support/env.js'
import {
  abiFunction,
  callFelts,
  constructorInputs,
  shortType,
  signatureOf,
  starknetProvider,
  u256FromFelts,
  type AbiFunction,
} from '../support/starknet.js'

function expectFunction(abi: Abi, name: string): AbiFunction {
  const fn = abiFunction(abi, name)
  expect(fn, `ABI does not expose ${name}`).toBeDefined()
  return fn as AbiFunction
}

async function felt(provider: RpcProvider, address: string, entrypoint: string, calldata: string[] = []): Promise<bigint> {
  const [value] = await callFelts(provider, address, entrypoint, calldata)
  return BigInt(value ?? '0x0')
}

describe.skipIf(!env.STARKNET_RPC_URL)('Starknet mainnet dependencies pinned in @privacy-round-trip/shared', () => {
  let provider: RpcProvider

  beforeAll(() => {
    provider = starknetProvider(requireEnv('STARKNET_RPC_URL'))
  })

  it('is Starknet mainnet on an RPC spec version starknet.js supports', async () => {
    expect(await provider.getChainId()).toBe(CHAIN.starknet.chainId)
    const majorMinor = (version: string) => version.split('.').slice(0, 2).join('.')
    const supported = Object.values(constants.SupportedRpcVersion).map(majorMinor)
    expect(supported).toContain(majorMinor(await provider.getSpecVersion()))
  })

  it('USDC has 6 decimals and the ERC-20 entrypoints the browser calls', async () => {
    const { abi } = await provider.getClassAt(CHAIN.starknet.usdc)
    expect(signatureOf(expectFunction(abi, 'balance_of'))).toBe('balance_of(account: ContractAddress)')
    expect(signatureOf(expectFunction(abi, 'approve'))).toBe('approve(spender: ContractAddress, amount: u256)')
    expect(Number(await felt(provider, CHAIN.starknet.usdc, 'decimals'))).toBe(TOKENS.USDC.decimals)
  })

  it('TokenMessengerMinterV2 matches the Cairo interface in contracts/starknet and points back at Ethereum', async () => {
    const address = CHAIN.starknet.cctp.tokenMessengerMinterV2
    const { abi } = await provider.getClassAt(address)
    expect(signatureOf(expectFunction(abi, 'deposit_for_burn_with_hook'))).toBe(
      'deposit_for_burn_with_hook(amount: u256, destination_domain: u32, mint_recipient: u256, ' +
        'burn_token: ContractAddress, destination_caller: u256, max_fee: u256, min_finality_threshold: u32, ' +
        'hook_data: ByteArray)',
    )
    const remote = await callFelts(provider, address, 'remote_token_messenger', [String(CHAIN.ethereum.cctpDomain)])
    expect(u256FromFelts(remote)).toBe(BigInt(CHAIN.ethereum.cctp.tokenMessengerV2))
    expect(await felt(provider, address, 'local_message_transmitter')).toBe(BigInt(CHAIN.starknet.cctp.messageTransmitterV2))
    expect(await felt(provider, address, 'message_body_version')).toBe(1n)
    expect(await felt(provider, address, 'paused')).toBe(0n)
  })

  it('MessageTransmitterV2 serves CCTP domain 25 and accepts receive_message(ByteArray, ByteArray)', async () => {
    const address = CHAIN.starknet.cctp.messageTransmitterV2
    const { abi } = await provider.getClassAt(address)
    expect(signatureOf(expectFunction(abi, 'receive_message'))).toBe('receive_message(message: ByteArray, attestation: ByteArray)')
    expect(Number(await felt(provider, address, 'get_local_domain'))).toBe(CHAIN.starknet.cctpDomain)
    expect(await felt(provider, address, 'get_version')).toBe(1n)
    expect(await felt(provider, address, 'paused')).toBe(0n)
  })

  it('the privacy pool is deployed, unpaused, and exposes apply_actions for proven transactions', async () => {
    const address = CHAIN.starknet.privacyPool
    const { abi } = await provider.getClassAt(address)
    expect(expectFunction(abi, 'apply_actions').inputs.map((input) => input.name)).toEqual(['actions', 'screening'])
    expect(await felt(provider, address, 'is_paused')).toBe(0n)
  })

  it('the OpenZeppelin account class used for ephemeral identities is declared with a public_key constructor', async () => {
    const { abi } = await provider.getClass(CHAIN.starknet.ozAccountClassHash)
    expect(constructorInputs(abi).map((input) => `${input.name}: ${shortType(input.type)}`)).toEqual(['public_key: felt252'])
    for (const name of ['__execute__', '__validate__', '__validate_deploy__', 'is_valid_signature']) {
      expectFunction(abi, name)
    }
    expect(createEphemeralIdentity().classHash).toBe(CHAIN.starknet.ozAccountClassHash)
  })
})
