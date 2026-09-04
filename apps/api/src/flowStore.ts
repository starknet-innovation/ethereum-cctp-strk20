import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { applyFlowUpdate, type FlowUpdate, type PublicFlow, type RouteQuote } from '@privacy-round-trip/shared'

interface StoredFlow {
  flow: PublicFlow
  tokenHash: Buffer
}

export class FlowStore {
  private readonly flows = new Map<string, StoredFlow>()

  constructor(private readonly secret: string) {}

  create(args: {
    quote: RouteQuote
    ethereumSender: string
    starknetAccount: string
    delayMinutes: number
  }): { flow: PublicFlow; writeToken: string } {
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
    this.flows.set(flow.id, { flow, tokenHash: this.digest(writeToken) })
    return { flow, writeToken }
  }

  read(id: string, token: string): PublicFlow | undefined {
    const stored = this.authorized(id, token)
    return stored ? structuredClone(stored.flow) : undefined
  }

  update(id: string, token: string, update: FlowUpdate): PublicFlow | undefined {
    const stored = this.authorized(id, token)
    if (!stored) return undefined
    stored.flow = applyFlowUpdate(stored.flow, update)
    return structuredClone(stored.flow)
  }

  private authorized(id: string, token: string): StoredFlow | undefined {
    const stored = this.flows.get(id)
    if (!stored) return undefined
    const candidate = this.digest(token)
    return candidate.length === stored.tokenHash.length && timingSafeEqual(candidate, stored.tokenHash)
      ? stored
      : undefined
  }

  private digest(value: string): Buffer {
    return createHmac('sha256', this.secret).update(value).digest()
  }
}
