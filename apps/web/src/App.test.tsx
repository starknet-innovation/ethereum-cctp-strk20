/* @vitest-environment jsdom */

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { PublicFlow, RouteQuote } from '@privacy-round-trip/shared'

const useRoundTripMock = vi.hoisted(() => vi.fn())

vi.mock('./useRoundTrip.js', () => ({
  INITIAL_FORM: {
    inputToken: 'ETH',
    outputToken: 'USDC',
    amount: '0.002',
    recipient: '0x1111111111111111111111111111111111111111',
    delayMinutes: 30,
  },
  useRoundTrip: useRoundTripMock,
}))

import { App } from './App.js'

const quote: RouteQuote = {
  quoteId: 'q_completed',
  request: { inputToken: 'ETH', outputToken: 'ETH', amount: '0.002', slippageBps: 100 },
  inputAmountBase: '2000000000000000',
  estimatedBridgeAmountBase: '7000000',
  minimumBridgeAmountBase: '6930000',
  estimatedOutputAmountBase: '601397991976400',
  minimumOutputAmountBase: '595384012056636',
  entryPoolFee: 500,
  exitPoolFee: 500,
  inboundCctpMaxFeeBase: '700',
  outboundCctpMaxFeeBase: '1400000',
  expiresAt: '2030-01-01T00:00:00.000Z',
  warnings: [],
}

const completedFlow: PublicFlow = {
  id: 'f_11111111111111111111111111111111',
  phase: 'completed',
  quote,
  ethereumSender: '0x1111111111111111111111111111111111111111',
  starknetAccount: '0x123',
  delayMinutes: 30,
  createdAt: '2030-01-01T00:00:00.000Z',
  updatedAt: '2030-01-01T00:30:00.000Z',
}

describe('completed route display', () => {
  it('hides a cached output whose asset no longer matches the form and freezes the old route', () => {
    useRoundTripMock.mockReturnValue(roundTripState({
      config: { ready: true, missing: [] },
      wallet: { account: completedFlow.ethereumSender },
      quote,
      flow: completedFlow,
      message: 'Complete.',
    }))

    const html = renderToStaticMarkup(<App />)

    expect(html).toContain('<fieldset disabled="">')
    expect(html).toContain('<output>—</output>')
    expect(html).not.toContain('601397991.9764')
    expect(html).toContain('Start another transfer')
  })

  it('formats a matching completed quote with its quoted token decimals', () => {
    const matchingQuote: RouteQuote = {
      ...quote,
      request: { ...quote.request, outputToken: 'USDC' },
      estimatedOutputAmountBase: '6013979',
      minimumOutputAmountBase: '5953840',
    }
    useRoundTripMock.mockReturnValue(roundTripState({
      config: { ready: true, missing: [] },
      wallet: { account: completedFlow.ethereumSender },
      quote: matchingQuote,
      flow: { ...completedFlow, quote: matchingQuote },
      message: 'Complete.',
    }))

    const html = renderToStaticMarkup(<App />)

    expect(html).toContain('<output>6.013979</output>')
    expect(html).not.toContain('6013979 USDC')
  })

  it('invokes the explicit reset and renders an editable, quote-free form afterward', async () => {
    const resetCompleted = vi.fn()
    useRoundTripMock.mockReturnValue(roundTripState({
      config: { ready: true, missing: [] },
      wallet: { account: completedFlow.ethereumSender },
      quote,
      flow: completedFlow,
      message: 'Complete.',
      resetCompleted,
    }))
    const container = document.createElement('div')
    const root = createRoot(container)

    await act(async () => root.render(<App />))
    const reset = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Start another transfer',
    )
    expect(reset).toBeDefined()

    await act(async () => reset!.click())
    expect(resetCompleted).toHaveBeenCalledOnce()

    useRoundTripMock.mockReturnValue(roundTripState({
      config: { ready: true, missing: [] },
      wallet: { account: completedFlow.ethereumSender },
      message: 'Ready for another mainnet route.',
    }))
    await act(async () => root.render(<App />))

    expect(container.querySelector('fieldset')?.disabled).toBe(false)
    expect(container.querySelector('output')?.textContent).toBe('—')
    expect(container.textContent).not.toContain('Start another transfer')
    await act(async () => root.unmount())
  })
})

function roundTripState(overrides: Record<string, unknown>) {
  return {
    config: undefined,
    wallet: undefined,
    quote: undefined,
    flow: undefined,
    message: '',
    error: undefined,
    busy: false,
    active: false,
    recoveryAvailable: false,
    now: Date.now(),
    connect: vi.fn(),
    preview: vi.fn(),
    start: vi.fn(),
    invalidateQuote: vi.fn(),
    resetCompleted: vi.fn(),
    ...overrides,
  }
}
