import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import type { Address, Hex } from 'viem'

export interface AnvilInstance {
  url: string
  /** Node-managed, unlocked developer accounts. Transactions from them are signed by anvil. */
  accounts: Address[]
  stop(): Promise<void>
}

export interface AnvilOptions {
  forkUrl: string
  forkBlock?: number
  readyTimeoutMs?: number
}

/** Start an anvil fork of Ethereum mainnet on a free local port and wait until it answers RPC. */
export async function startAnvil(options: AnvilOptions): Promise<AnvilInstance> {
  const port = await freePort()
  const url = `http://127.0.0.1:${port}`
  const args = ['--port', String(port), '--fork-url', options.forkUrl, '--silent', '--retries', '5', '--timeout', '60000']
  if (options.forkBlock) args.push('--fork-block-number', String(options.forkBlock))

  const child = spawn('anvil', args, { stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString()))
  child.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString()))
  const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)))
  const spawnError = new Promise<never>((_, reject) =>
    child.once('error', (error: NodeJS.ErrnoException) =>
      reject(
        new Error(
          error.code === 'ENOENT'
            ? 'anvil was not found on PATH. Install Foundry (https://getfoundry.sh) to run fork tests.'
            : `anvil failed to start: ${error.message}`,
        ),
      ),
    ),
  )

  const deadline = Date.now() + (options.readyTimeoutMs ?? 120_000)
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`anvil exited with code ${child.exitCode} before it was ready:\n${output}`)
    }
    const ready = await Promise.race([
      anvilRpc(url, 'eth_chainId').then(() => true, () => false),
      spawnError,
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1_000)),
    ])
    if (ready) break
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  if (child.exitCode !== null || Date.now() >= deadline) {
    child.kill('SIGKILL')
    throw new Error(`anvil did not become ready in time:\n${output}`)
  }

  const accounts = (await anvilRpc<Address[]>(url, 'eth_accounts')).map(
    (account) => account.toLowerCase() as Address,
  )
  return {
    url,
    accounts,
    stop: () => stopProcess(child, exited),
  }
}

export async function anvilRpc<T>(url: string, method: string, params: unknown[] = []): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(60_000),
  })
  const json = (await response.json()) as { result?: T; error?: { message?: string } }
  if (json.error) throw new Error(`${method} failed: ${json.error.message ?? 'unknown error'}`)
  return json.result as T
}

/** Move the fork clock forward and mine one block so time-gated contract paths can be exercised. */
export async function increaseTime(url: string, seconds: number): Promise<void> {
  await anvilRpc(url, 'evm_increaseTime', [seconds])
  await anvilRpc(url, 'evm_mine', [])
}
/**
 * Advance the fork so the next block's timestamp is at least `timestamp`. Chain time on a fork
 * starts at the forked block and lags the wall clock, so wall-clock deadlines must be reached
 * relative to the chain's own clock rather than by a fixed offset.
 */
export async function advanceChainTo(url: string, timestamp: number): Promise<void> {
  const latest = await anvilRpc<{ timestamp: Hex }>(url, 'eth_getBlockByNumber', ['latest', false])
  const now = Number.parseInt(latest.timestamp, 16)
  if (now < timestamp) await increaseTime(url, timestamp - now + 1)
}

async function stopProcess(child: ChildProcess, exited: Promise<number | null>): Promise<void> {
  if (child.exitCode !== null) return
  child.kill('SIGTERM')
  const timer = setTimeout(() => child.kill('SIGKILL'), 5_000)
  await exited
  clearTimeout(timer)
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') return reject(new Error('no port assigned'))
      server.close(() => resolve(address.port))
    })
  })
}
