import { describe, expect, it } from 'vitest'
import { loadConfig } from './config.js'

describe('runtime configuration', () => {
  it('loads allow-listed fields from the opaque ECS secret and lets explicit env values win', () => {
    const config = loadConfig({
      RUNTIME_CONFIG: JSON.stringify({
        ETHEREUM_RPC_URL: 'https://secret-rpc.example',
        STARKNET_RPC_URL: 'https://starknet.example',
        STARKSCAN_API_KEY: 'operator-issued-key',
        PROVER_URL: 'https://ignored-legacy.example',
      }),
      ETHEREUM_RPC_URL: 'https://explicit-rpc.example',
    })

    expect(config.ETHEREUM_RPC_URL).toBe('https://explicit-rpc.example')
    expect(config.STARKNET_RPC_URL).toBe('https://starknet.example')
    expect(config.STARKSCAN_API_KEY).toBe('operator-issued-key')
    expect(config).not.toHaveProperty('PROVER_URL')
  })

  it('rejects malformed opaque runtime configuration', () => {
    expect(() => loadConfig({ RUNTIME_CONFIG: 'not-json' })).toThrow(
      'RUNTIME_CONFIG must contain a JSON object',
    )
  })
})
