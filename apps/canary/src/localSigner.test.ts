import { describe, expect, it } from 'vitest'
import { createWalletClient, custom, type Hex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { mainnet } from 'viem/chains'
import { bindLocalAccount } from './localSigner.js'

describe('local canary signer', () => {
  it('signs locally and submits a raw transaction after simulation supplied only an address', async () => {
    const account = privateKeyToAccount(generatePrivateKey())
    const methods: string[] = []
    const expectedHash = `0x${'22'.repeat(32)}` as Hex
    const wallet = createWalletClient({
      account,
      chain: mainnet,
      transport: custom({
        async request({ method, params }) {
          methods.push(method)
          if (method === 'eth_fillTransaction') {
            throw Object.assign(new Error('method not supported'), { code: -32601 })
          }
          expect(method).toBe('eth_sendRawTransaction')
          expect(String(params?.[0])).toMatch(/^0x[0-9a-f]+$/i)
          return expectedHash
        },
      }),
    })

    const hash = await wallet.sendTransaction(
      bindLocalAccount(
        {
          account: account.address,
          to: '0x1111111111111111111111111111111111111111',
          value: 1n,
          gas: 21_000n,
          nonce: 0,
          maxFeePerGas: 2n,
          maxPriorityFeePerGas: 1n,
          chain: mainnet,
        },
        account,
      ),
    )

    expect(hash).toBe(expectedHash)
    expect(methods).toContain('eth_sendRawTransaction')
    expect(methods).not.toContain('eth_sendTransaction')
    expect(methods.at(-1)).toBe('eth_sendRawTransaction')
  })
})
