import type {
  CreateFlowResponse,
  FlowUpdate,
  PublicConfig,
  PublicFlow,
  QuoteRequest,
  RouteQuote,
  TokenSymbol,
} from '@privacy-round-trip/shared'

const API =
  (import.meta.env?.VITE_API_URL as string | undefined)?.replace(/\/$/, '') ??
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
    ?.CANARY_API_URL?.replace(/\/$/, '') ??
  (import.meta.env?.DEV ? 'http://localhost:8787' : '')

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers)
  if (init?.body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', 'application/json')
  }
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers,
  })
  const body = (await response.json()) as T & { error?: unknown }
  if (!response.ok) {
    const detail = typeof body.error === 'string' ? body.error : JSON.stringify(body.error)
    throw new Error(detail || `Request failed (${response.status})`)
  }
  return body
}

export const api = {
  baseUrl: API,
  config: () => json<PublicConfig>('/v1/config'),
  quote: (request: QuoteRequest) =>
    json<RouteQuote>('/v1/quotes', { method: 'POST', body: JSON.stringify(request) }),
  createFlow: (body: {
    quoteId: string
    ethereumSender: string
    starknetAccount: string
    delayMinutes: number
  }) => json<CreateFlowResponse>('/v1/flows', { method: 'POST', body: JSON.stringify(body) }),
  getFlow: (id: string, token: string) =>
    json<PublicFlow>(`/v1/flows/${id}`, { headers: { 'x-flow-token': token } }),
  updateFlow: (id: string, token: string, update: FlowUpdate) =>
    json<PublicFlow>(`/v1/flows/${id}`, {
      method: 'PATCH',
      headers: { 'x-flow-token': token },
      body: JSON.stringify(update),
    }),
  circleMessages: (txHash: string) =>
    json<{ messages?: CircleMessage[] }>(`/v1/cctp/messages/${txHash}`),
  createSettlement: (body: {
    salt: `0x${string}`
    recipient: `0x${string}`
    outputToken: TokenSymbol
    minimumOutput: string
    poolFee: 100 | 500 | 3000 | 10000
    recoverAfter: number
  }) =>
    json<{ settlement: `0x${string}`; txHash: `0x${string}` }>('/v1/settlements', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  settle: (settlement: `0x${string}`) =>
    json<{ txHash: `0x${string}` }>(`/v1/settlements/${settlement}/settle`, { method: 'POST' }),
}

export interface CircleMessage {
  message: `0x${string}`
  attestation: `0x${string}` | 'PENDING'
  status: 'pending_confirmations' | 'complete'
  decodedMessage?: Record<string, unknown>
}
