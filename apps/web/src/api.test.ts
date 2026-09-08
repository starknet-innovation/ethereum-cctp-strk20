import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from './api.js'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('api client', () => {
  it('does not claim an empty settlement request contains JSON', async () => {
    const fetchMock = vi.fn(async (_input: unknown, _init?: RequestInit) =>
      new Response(JSON.stringify({ txHash: `0x${'11'.repeat(32)}` }), {
        headers: { 'content-type': 'application/json' },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await api.settle('0x2222222222222222222222222222222222222222')

    const [, init] = fetchMock.mock.calls[0]!
    expect(init?.method).toBe('POST')
    expect(init?.body).toBeUndefined()
    expect(new Headers(init?.headers).has('content-type')).toBe(false)
  })
})
