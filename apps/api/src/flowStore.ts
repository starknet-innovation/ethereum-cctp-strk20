import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { applyFlowUpdate, type FlowUpdate, type PublicFlow, type RouteQuote } from '@privacy-round-trip/shared'
import type { StateStore } from './stateStore.js'

interface StoredFlow {
  flow: PublicFlow
  tokenHash: string
}

export class FlowStore {
  private static readonly ttlSeconds = 8 * 24 * 60 * 60

  constructor(
    private readonly secret: string,
    private readonly state: StateStore,
  ) {}

  create(args: {
    quote: RouteQuote
    ethereumSender: string
    starknetAccount: string
    delayMinutes: number
  }): Promise<{ flow: PublicFlow; writeToken: string }> {
    const now = new Date().toISOString()
    const flow: PublicFlow = {
      id: `f_${randomUUID().replaceAll('-', '')}`,
      phase: args.quote.request.inputToken === 'ETH' ? 'prepared' : 'allowance-required',
      quote: args.quote,
      ethereumSender: args.ethereumSender,
      starknetAccount: args.starknetAccount,
      delayMinutes: args.delayMinutes,
      createdAt: now,
      updatedAt: now,
    }
    const writeToken = randomBytes(32).toString('base64url')
    return this.state
      .set(this.key(flow.id), JSON.stringify({ flow, tokenHash: this.digest(writeToken) }), FlowStore.ttlSeconds)
      .then(() => ({ flow, writeToken }))
  }

  async read(id: string, token: string): Promise<PublicFlow | undefined> {
    const stored = await this.authorized(id, token)
    return stored ? structuredClone(stored.flow) : undefined
  }

  async update(id: string, token: string, update: FlowUpdate): Promise<PublicFlow | undefined> {
    const stored = await this.authorized(id, token)
    if (!stored) return undefined
    stored.flow = applyFlowUpdate(stored.flow, update)
    await this.state.set(this.key(id), JSON.stringify(stored), FlowStore.ttlSeconds)
    return structuredClone(stored.flow)
  }

  private async authorized(id: string, token: string): Promise<StoredFlow | undefined> {
    const serialized = await this.state.get(this.key(id))
    if (!serialized) return undefined
    const stored = JSON.parse(serialized) as StoredFlow
    const candidate = Buffer.from(this.digest(token), 'base64')
    const expected = Buffer.from(stored.tokenHash, 'base64')
    return candidate.length === expected.length && timingSafeEqual(candidate, expected)
      ? stored
      : undefined
  }

  private digest(value: string): string {
    return createHmac('sha256', this.secret).update(value).digest('base64')
  }

  private key(id: string): string {
    return `qrt:flow:${id}`
  }
}
