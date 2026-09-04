import { Cluster } from 'iovalkey'

export interface StateStore {
  get(key: string): Promise<string | undefined>
  set(key: string, value: string, ttlSeconds: number): Promise<void>
  ping(): Promise<void>
  close(): Promise<void>
}

interface MemoryValue {
  value: string
  expiresAt: number
}

export class MemoryStateStore implements StateStore {
  private readonly values = new Map<string, MemoryValue>()

  async get(key: string): Promise<string | undefined> {
    const stored = this.values.get(key)
    if (!stored) return undefined
    if (stored.expiresAt <= Date.now()) {
      this.values.delete(key)
      return undefined
    }
    return stored.value
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    this.values.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1_000 })
  }

  async ping(): Promise<void> {}

  async close(): Promise<void> {}
}

export class ValkeyStateStore implements StateStore {
  private readonly client: Cluster
  private connection: Promise<void> | undefined

  constructor(args: { host: string; port: number; username: string; password: string }) {
    this.client = new Cluster([{ host: args.host, port: args.port }], {
      lazyConnect: true,
      enableOfflineQueue: false,
      dnsLookup: (address, callback) => callback(null, address),
      clusterRetryStrategy: (attempt) => (attempt > 5 ? null : Math.min(100 * attempt, 1_000)),
      slotsRefreshTimeout: 5_000,
      redisOptions: {
        username: args.username,
        password: args.password,
        tls: { servername: args.host },
        connectTimeout: 5_000,
        commandTimeout: 5_000,
        maxRetriesPerRequest: 2,
      },
    })
    // Connection failures are surfaced by commands; this listener prevents EventEmitter's
    // unhandled-error behavior while the cluster is retrying.
    this.client.on('error', () => undefined)
  }

  async get(key: string): Promise<string | undefined> {
    await this.connect()
    return (await this.client.get(key)) ?? undefined
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    await this.connect()
    await this.client.set(key, value, 'EX', ttlSeconds)
  }

  async ping(): Promise<void> {
    await this.connect()
    await this.client.ping()
  }

  async close(): Promise<void> {
    this.client.disconnect()
  }

  private async connect(): Promise<void> {
    if (this.client.status === 'ready') return
    this.connection ??= this.client.connect().catch((error: unknown) => {
      this.connection = undefined
      throw error
    })
    await this.connection
  }
}
