import {
  CHAIN,
  CCTP_FAST_FINALITY_THRESHOLD,
  TOKENS,
  canTransition,
  type FlowPhase,
  type PublicFlow,
  type RouteQuote,
  type TokenSymbol,
} from '@privacy-round-trip/shared'
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import {
  createPublicClient,
  createWalletClient,
  erc20Abi,
  formatUnits,
  http,
  isAddress,
  keccak256,
  parseUnits,
  stringToHex,
  type Address,
  type Hex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { mainnet } from 'viem/chains'
import { Signer } from 'starknet'
import type { EphemeralIdentity } from '../../web/src/identity.js'

const DEFAULT_API_URL =
  'https://et-3a2b9d82b0504dbe9e8af1be336446d6.ecs.eu-west-3.on.aws'
const DEFAULT_ACCOUNT = 'ethereum-cctp-strk20-canary'
const MIN_GAS_RESERVE_WEI = parseUnits('0.001', 18)
const MAX_INPUT: Record<TokenSymbol, bigint> = {
  ETH: parseUnits('0.01', 18),
  USDC: parseUnits('25', 6),
  WBTC: parseUnits('0.0005', 8),
}
const ENTRY_ABI = [
  {
    type: 'function',
    name: 'start',
    stateMutability: 'payable',
    inputs: [
      {
        name: 'intent',
        type: 'tuple',
        components: [
          { name: 'flowId', type: 'bytes32' },
          { name: 'inputAsset', type: 'uint8' },
          { name: 'amountIn', type: 'uint256' },
          { name: 'minimumUsdc', type: 'uint256' },
          { name: 'poolFee', type: 'uint24' },
          { name: 'starknetRecipient', type: 'uint256' },
          { name: 'cctpMaxFee', type: 'uint256' },
          { name: 'minFinalityThreshold', type: 'uint32' },
          { name: 'deadline', type: 'uint256' },
        ],
      },
    ],
    outputs: [{ name: 'usdcAmount', type: 'uint256' }],
  },
] as const
const SETTLEMENT_FACTORY_ABI = [
  {
    type: 'function',
    name: 'predict',
    stateMutability: 'view',
    inputs: [
      { name: 'salt', type: 'bytes32' },
      { name: 'recipient', type: 'address' },
      { name: 'outputAsset', type: 'uint8' },
      { name: 'minimumOutput', type: 'uint256' },
      { name: 'poolFee', type: 'uint24' },
      { name: 'recoverAfter', type: 'uint64' },
    ],
    outputs: [{ name: 'settlement', type: 'address' }],
  },
] as const

type Stage =
  | 'prepared'
  | 'entry-submitted'
  | 'bridging-to-starknet'
  | 'starknet-funded'
  | 'privacy-delay'
  | 'settlement-created'
  | 'bridging-to-ethereum'
  | 'settling'
  | 'completed'

interface Options {
  account: string
  apiUrl: string
  amount: string
  delayMinutes: number
  inputToken: TokenSymbol
  outputToken: TokenSymbol
  recipient?: Address
  maxLossBps: number
  recoveryFile?: string
  resume?: string
  passwordFile?: string
  mainnetAcknowledged: boolean
  preflightOnly: boolean
}

interface StoredIdentity {
  address: string
  classHash: string
  salt: string
  publicKey: string
  privateKey: string
  viewingKey: string
}

interface CanaryState {
  version: 1
  stage: Stage
  apiUrl: string
  walletAddress: Address
  recipient: Address
  inputToken: TokenSymbol
  outputToken: TokenSymbol
  amount: string
  delayMinutes: number
  maxLossBps: number
  quote: RouteQuote
  flowId: string
  writeToken: string
  identity: StoredIdentity
  createdAt: string
  updatedAt: string
  entryTxHash?: Hex
  mintTxHash?: string
  depositTxHash?: string
  depositedAt?: string
  privateAmount?: string
  settlement?: Address
  settlementSalt?: Hex
  settlementCreateTxHash?: Hex
  recoverAfter?: number
  poolFee?: 100 | 500 | 3000 | 10000
  exitTxHash?: string
  finalTxHash?: Hex
  finalOutput?: string
  lastError?: string
}

interface EncryptedState {
  version: 1
  walletAddress: Address
  salt: string
  iv: string
  tag: string
  ciphertext: string
}

async function main() {
  if (process.argv.slice(2).includes('--help')) {
    printUsage()
    return
  }
  const options = parseOptions(process.argv.slice(2))
  if (!options.mainnetAcknowledged) {
    throw new Error('Refusing to run without --mainnet; this canary moves real mainnet funds')
  }
  process.env.CANARY_API_URL = options.apiUrl

  const privateKey = loadPrivateKey(options)
  const account = privateKeyToAccount(privateKey)
  const statePath = options.resume
    ? resolve(options.resume)
    : resolve(
        options.recoveryFile ??
          `.canary/${new Date().toISOString().replaceAll(':', '-')}-${account.address}.json.enc`,
      )
  const save = (state: CanaryState) => writeEncryptedState(statePath, state, privateKey)

  const [{ api }, identityModule, starknetModule] = await Promise.all([
    import('../../web/src/api.js'),
    import('../../web/src/identity.js'),
    import('../../web/src/starknet.js'),
  ])
  // The deployed backend publishes the canonical Ethereum RPC only server-side. The canary uses
  // the same verified public mainnet endpoint configured for this project for user-signed calls.
  const ethereumRpcUrl = process.env.CANARY_ETHEREUM_RPC_URL ?? 'https://eth-mainnet.g.alchemy.com/public'
  const ethereumClient = createPublicClient({ chain: mainnet, transport: http(ethereumRpcUrl) })
  const walletClient = createWalletClient({ account, chain: mainnet, transport: http(ethereumRpcUrl) })

  let state = options.resume
    ? readEncryptedState(statePath, privateKey)
    : await prepareState({ options, account: account.address, ethereumClient, api, identityModule })
  assertResumeMatches(state, options, account.address)
  save(state)
  log(`Recovery journal: ${statePath}`)

  try {
    await preflight({ state, account: account.address, ethereumClient, api })
    if (options.preflightOnly) {
      log('PREFLIGHT PASS: no transaction was submitted; resume this journal to execute the canary')
      return
    }
    if (state.stage === 'prepared') {
      state = await refreshPreparedFlow(state, api)
      save(state)
    }
    const identity = restoreIdentity(state.identity)

    if (state.stage === 'prepared') {
      state.entryTxHash = await submitEntry({ state, account: account.address, ethereumClient, walletClient })
      state.stage = 'entry-submitted'
      state.updatedAt = new Date().toISOString()
      save(state)
    }

    if (state.stage === 'entry-submitted') {
      await transition(api, state, 'entry-submitted', {
        txHash: required(state.entryTxHash, 'entry transaction'),
      })
      await waitForEthereumTransaction(ethereumClient, required(state.entryTxHash, 'entry transaction'))
      await transition(api, state, 'bridging-to-starknet')
      state.stage = 'bridging-to-starknet'
      state.updatedAt = new Date().toISOString()
      save(state)
    }

    if (state.stage === 'bridging-to-starknet') {
      log('Waiting for Circle attestation and claiming USDC on Starknet…')
      if (!state.mintTxHash) {
        const attested = await starknetModule.waitForCircleAttestation(
          required(state.entryTxHash, 'entry transaction'),
        )
        state.mintTxHash = await starknetModule.sponsoredMint(
          identity,
          attested.message,
          attested.attestation as Hex,
          capability(state),
        )
        state.updatedAt = new Date().toISOString()
        save(state)
      }
      await transition(api, state, 'starknet-funded', {
        txHash: required(state.mintTxHash, 'mint transaction'),
      })
      state.stage = 'starknet-funded'
      state.updatedAt = new Date().toISOString()
      save(state)
    }

    if (state.stage === 'starknet-funded') {
      await starknetModule.waitForPrivacyProvingReadyAfterTx(required(state.mintTxHash, 'mint transaction'))
      const minted = await starknetModule.starknetUsdcBalance(identity.address)
      if (minted <= 0n) throw new Error('CCTP claim completed without a positive Starknet USDC balance')
      await transition(api, state, 'pool-depositing')
      if (!state.depositTxHash) {
        log('Generating and submitting the real privacy deposit proof…')
        const deposit = await starknetModule.sponsoredPrivacyDeposit({
          identity,
          amount: minted,
          capability: capability(state),
        })
        state.depositTxHash = deposit.txHash
        state.privateAmount = deposit.privateAmount.toString()
        state.depositedAt = new Date().toISOString()
        state.updatedAt = new Date().toISOString()
        save(state)
      }
      await transition(api, state, 'privacy-delay', {
        txHash: required(state.depositTxHash, 'deposit transaction'),
        occurredAt: required(state.depositedAt, 'deposit timestamp'),
      })
      state.stage = 'privacy-delay'
      state.updatedAt = new Date().toISOString()
      save(state)
    }

    if (state.stage === 'privacy-delay') {
      await transition(api, state, 'privacy-delay', {
        txHash: required(state.depositTxHash, 'deposit transaction'),
        occurredAt: required(state.depositedAt, 'deposit timestamp'),
      })
      log(`Waiting for the ${state.delayMinutes}-minute privacy delay and proof-safe depth…`)
      await Promise.all([
        waitUntil(Date.parse(required(state.depositedAt, 'deposit timestamp')) + state.delayMinutes * 60_000),
        starknetModule.waitForPrivacyProvingReadyAfterTx(required(state.depositTxHash, 'deposit transaction')),
      ])
      await transition(api, state, 'pool-withdrawing')
      const salt = randomHex32()
      const poolFee = (state.quote.exitPoolFee || 500) as 100 | 500 | 3000 | 10000
      const recoverAfter = Math.floor(Date.now() / 1_000) + 60 * 60
      const expected = await predictSettlement({ state, salt, poolFee, recoverAfter, ethereumClient })
      const created = await api.createSettlement({
        salt,
        recipient: state.recipient,
        outputToken: state.outputToken,
        minimumOutput: state.quote.minimumOutputAmountBase,
        poolFee,
        recoverAfter,
      })
      if (created.settlement.toLowerCase() !== expected.toLowerCase()) {
        throw new Error('Backend returned an unexpected deterministic settlement address')
      }
      state.settlement = created.settlement
      state.settlementSalt = salt
      state.settlementCreateTxHash = created.txHash
      state.recoverAfter = recoverAfter
      state.poolFee = poolFee
      state.stage = 'settlement-created'
      state.updatedAt = new Date().toISOString()
      save(state)
    }

    if (state.stage === 'settlement-created') {
      await waitForEthereumTransaction(
        ethereumClient,
        required(state.settlementCreateTxHash, 'settlement creation transaction'),
      )
      log('Generating the private exit proof and starting CCTP back to Ethereum…')
      if (!state.exitTxHash) {
        state.exitTxHash = await starknetModule.sponsoredPrivacyExit({
          identity,
          privateAmount: BigInt(required(state.privateAmount, 'private amount')),
          settlement: required(state.settlement, 'settlement address'),
          cctpExitAnonymizer: required(
            (await api.config()).starknet.cctpExitAnonymizer,
            'Starknet CCTP exit anonymizer',
          ),
          cctpMaxFee: BigInt(state.quote.outboundCctpMaxFeeBase),
          capability: capability(state),
        })
        state.updatedAt = new Date().toISOString()
        save(state)
      }
      await transition(api, state, 'bridging-to-ethereum', {
        txHash: required(state.exitTxHash, 'private exit transaction'),
        settlementAddress: required(state.settlement, 'settlement address'),
      })
      state.stage = 'bridging-to-ethereum'
      state.updatedAt = new Date().toISOString()
      save(state)
    }

    if (state.stage === 'bridging-to-ethereum') {
      log('Waiting for Circle to mint USDC into the Ethereum settlement…')
      await waitForTokenBalance(
        ethereumClient,
        CHAIN.ethereum.tokens.USDC,
        required(state.settlement, 'settlement address'),
      )
      await transition(api, state, 'settling')
      state.stage = 'settling'
      state.updatedAt = new Date().toISOString()
      save(state)
    }

    if (state.stage === 'settling') {
      const before = await outputBalance(ethereumClient, state.outputToken, state.recipient)
      const final = state.finalTxHash
        ? { txHash: state.finalTxHash }
        : await api.settle(required(state.settlement, 'settlement address'))
      state.finalTxHash = final.txHash
      save(state)
      await waitForEthereumTransaction(ethereumClient, final.txHash)
      const after = await outputBalance(ethereumClient, state.outputToken, state.recipient)
      const output = after - before
      if (output < BigInt(state.quote.minimumOutputAmountBase)) {
        throw new Error(
          `Final output ${output} is below quoted minimum ${state.quote.minimumOutputAmountBase}`,
        )
      }
      state.finalOutput = output.toString()
      await transition(api, state, 'completed', { txHash: final.txHash })
      state.stage = 'completed'
      state.identity.privateKey = ''
      state.identity.viewingKey = '0'
      state.writeToken = ''
      delete state.lastError
      state.updatedAt = new Date().toISOString()
      save(state)
    }

    log(
      `PASS: received ${formatUnits(BigInt(required(state.finalOutput, 'final output')), TOKENS[state.outputToken].decimals)} ${state.outputToken} at ${state.recipient}`,
    )
  } catch (error) {
    state.lastError = errorText(error).slice(0, 2_000)
    state.updatedAt = new Date().toISOString()
    save(state)
    throw new Error(`${state.lastError}\nEncrypted recovery journal: ${statePath}`)
  }
}

function parseOptions(args: string[]): Options {
  const values = new Map<string, string>()
  let mainnetAcknowledged = false
  let preflightOnly = false
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index]!
    if (name === '--mainnet') {
      mainnetAcknowledged = true
      continue
    }
    if (name === '--preflight-only') {
      preflightOnly = true
      continue
    }
    if (!name.startsWith('--')) throw new Error(`Unexpected argument: ${name}`)
    const value = args[index + 1]
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${name}`)
    values.set(name, value)
    index += 1
  }

  const inputToken = token(values.get('--input') ?? 'ETH', '--input')
  const outputToken = token(values.get('--output') ?? inputToken, '--output')
  const delayMinutes = integer(values.get('--delay') ?? '5', '--delay')
  const maxLossBps = integer(values.get('--max-loss-bps') ?? '4000', '--max-loss-bps')
  const recipientValue = values.get('--recipient')
  if (recipientValue && !isAddress(recipientValue)) throw new Error('Invalid --recipient address')
  const recipient = recipientValue as Address | undefined
  const apiUrl = new URL(values.get('--api') ?? DEFAULT_API_URL)
  if (apiUrl.protocol !== 'https:') throw new Error('--api must use HTTPS')
  if (delayMinutes < 5 || delayMinutes > 10_080) throw new Error('--delay must be from 5 to 10080')
  if (maxLossBps < 0 || maxLossBps > 5_000) {
    throw new Error('--max-loss-bps must be from 0 to 5000')
  }

  const resume = values.get('--resume')
  const amount = values.get('--amount') ?? ''
  if (!resume && !amount) throw new Error('--amount is required for a new canary')
  if (!resume && inputToken !== outputToken) {
    throw new Error('The mainnet canary requires the same input and output token')
  }
  return {
    account: values.get('--account') ?? DEFAULT_ACCOUNT,
    apiUrl: apiUrl.toString().replace(/\/$/, ''),
    amount,
    delayMinutes,
    inputToken,
    outputToken,
    ...(recipient ? { recipient } : {}),
    maxLossBps,
    ...(values.get('--recovery-file')
      ? { recoveryFile: values.get('--recovery-file') as string }
      : {}),
    ...(resume ? { resume } : {}),
    ...(values.get('--password-file')
      ? { passwordFile: values.get('--password-file') as string }
      : {}),
    mainnetAcknowledged,
    preflightOnly,
  }
}

function printUsage() {
  process.stdout.write(`Mainnet end-to-end canary (moves real funds)

New preflight:
  npm run canary:mainnet -- --mainnet --preflight-only --account ${DEFAULT_ACCOUNT} --input ETH --output ETH --amount 0.005 --delay 5

Execute a prepared canary:
  npm run canary:mainnet -- --mainnet --account ${DEFAULT_ACCOUNT} --resume .canary/<journal>.json.enc

Options:
  --mainnet                 Required acknowledgement for every run
  --preflight-only          Validate and prepare a flow without submitting a transaction
  --account NAME            Encrypted Foundry keystore account (default: ${DEFAULT_ACCOUNT})
  --password-file PATH      Optional Foundry keystore password file
  --api URL                 Backend URL (default: deployed production backend)
  --input TOKEN             ETH, USDC, or WBTC (default: ETH)
  --output TOKEN            Must match input for a canary
  --amount VALUE            Required for a new canary
  --recipient ADDRESS       Defaults to the canary account
  --delay MINUTES           5 to 10080 (default: 5)
  --max-loss-bps BPS        Maximum quoted worst-case loss (default: 4000; hard max: 5000)
  --recovery-file PATH      Encrypted journal path for a new canary
  --resume PATH             Resume an encrypted journal
`)
}

function token(value: string, flag: string): TokenSymbol {
  if (value === 'ETH' || value === 'USDC' || value === 'WBTC') return value
  throw new Error(`${flag} must be ETH, USDC, or WBTC`)
}

function integer(value: string, flag: string): number {
  const parsed = Number(value)
  if (!Number.isInteger(parsed)) throw new Error(`${flag} must be an integer`)
  return parsed
}

function loadPrivateKey(options: Options): Hex {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(options.account)) {
    throw new Error('Invalid Foundry account name')
  }
  const args = ['wallet', 'private-key', '--account', options.account, '--color', 'never']
  if (options.passwordFile) args.push('--password-file', resolve(options.passwordFile))
  const result = spawnSync('cast', args, {
    encoding: 'utf8',
    stdio: ['inherit', 'pipe', 'inherit'],
    maxBuffer: 1024 * 1024,
  })
  if (result.error) throw new Error(`Could not run cast: ${result.error.message}`)
  if (result.status !== 0) throw new Error(`cast could not unlock Foundry account ${options.account}`)
  const key = result.stdout.trim()
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error('cast returned an invalid private key')
  return key as Hex
}

async function prepareState(args: {
  options: Options
  account: Address
  ethereumClient: ReturnType<typeof createPublicClient>
  api: typeof import('../../web/src/api.js')['api']
  identityModule: typeof import('../../web/src/identity.js')
}): Promise<CanaryState> {
  const { options, account, ethereumClient, api, identityModule } = args
  const decimals = TOKENS[options.inputToken].decimals
  const amountBase = parseUnits(options.amount, decimals)
  if (amountBase <= 0n) throw new Error('--amount must be positive')
  if (amountBase > MAX_INPUT[options.inputToken]) {
    throw new Error(
      `Canary input exceeds the hard ${formatUnits(MAX_INPUT[options.inputToken], decimals)} ${options.inputToken} cap`,
    )
  }

  const recipient = options.recipient ?? account
  const config = await api.config()
  assertBackendConfig(config)
  const quote = await api.quote({
    inputToken: options.inputToken,
    outputToken: options.outputToken,
    amount: options.amount,
    slippageBps: 100,
  })
  if (BigInt(quote.inputAmountBase) !== amountBase) {
    throw new Error('Backend quote input does not match the requested amount')
  }
  const minimum = BigInt(quote.minimumOutputAmountBase)
  if (minimum <= 0n) throw new Error('Backend quote has no positive minimum output')
  const lossBps = Number(((amountBase - minimum) * 10_000n) / amountBase)
  if (lossBps > options.maxLossBps) {
    throw new Error(
      `Quoted worst-case loss is ${lossBps} bps, above the ${options.maxLossBps} bps canary limit`,
    )
  }

  const identity = identityModule.createEphemeralIdentity()
  await assertWalletFunding(ethereumClient, account, options.inputToken, amountBase)
  const created = await api.createFlow({
    quoteId: quote.quoteId,
    ethereumSender: account,
    starknetAccount: identity.address,
    delayMinutes: options.delayMinutes,
  })
  const now = new Date().toISOString()
  log(
    `Prepared ${options.amount} ${options.inputToken} -> at least ${formatUnits(minimum, TOKENS[options.outputToken].decimals)} ${options.outputToken}; flow ${created.flow.id}`,
  )
  return {
    version: 1,
    stage: 'prepared',
    apiUrl: options.apiUrl,
    walletAddress: account,
    recipient,
    inputToken: options.inputToken,
    outputToken: options.outputToken,
    amount: options.amount,
    delayMinutes: options.delayMinutes,
    maxLossBps: options.maxLossBps,
    quote,
    flowId: created.flow.id,
    writeToken: created.writeToken,
    identity: serializeIdentity(identity),
    createdAt: now,
    updatedAt: now,
  }
}

async function preflight(args: {
  state: CanaryState
  account: Address
  ethereumClient: ReturnType<typeof createPublicClient>
  api: typeof import('../../web/src/api.js')['api']
}): Promise<void> {
  const { state, account, ethereumClient, api } = args
  const [config, chainId, accountCode] = await Promise.all([
    api.config(),
    ethereumClient.getChainId(),
    ethereumClient.getBytecode({ address: account }),
  ])
  assertBackendConfig(config)
  if (chainId !== 1) throw new Error(`Ethereum RPC returned chain ID ${chainId}, expected 1`)
  if (accountCode && accountCode !== '0x') throw new Error('Canary signer must be an EOA')
  const entryRouter = required(config.ethereum.entryRouter, 'Ethereum entry router') as Address
  const settlementFactory = required(
    config.ethereum.exitSettlementFactory,
    'Ethereum settlement factory',
  ) as Address
  const [entryCode, factoryCode] = await Promise.all([
    ethereumClient.getBytecode({ address: entryRouter }),
    ethereumClient.getBytecode({ address: settlementFactory }),
  ])
  if (!entryCode || entryCode === '0x') throw new Error('Configured Ethereum entry router has no code')
  if (!factoryCode || factoryCode === '0x') {
    throw new Error('Configured Ethereum settlement factory has no code')
  }
  if (state.stage === 'prepared') {
    await assertWalletFunding(
      ethereumClient,
      account,
      state.inputToken,
      BigInt(state.quote.inputAmountBase),
    )
  }
  if (state.stage !== 'completed') {
    const flow = await api.getFlow(state.flowId, state.writeToken)
    if (flow.ethereumSender.toLowerCase() !== account.toLowerCase()) {
      throw new Error('Backend flow belongs to a different Ethereum sender')
    }
    if (flow.starknetAccount.toLowerCase() !== state.identity.address.toLowerCase()) {
      throw new Error('Backend flow belongs to a different Starknet identity')
    }
    if (flow.phase === 'failed') throw new Error(`Backend flow is terminal: ${flow.failureReason ?? 'failed'}`)
  }
  log('Preflight passed: backend ready, chain ID 1, deployments present, signer is an EOA')
}

async function refreshPreparedFlow(
  state: CanaryState,
  api: typeof import('../../web/src/api.js')['api'],
): Promise<CanaryState> {
  const freshQuote = await api.quote({
    inputToken: state.inputToken,
    outputToken: state.outputToken,
    amount: state.amount,
    slippageBps: 100,
  })
  if (
    BigInt(freshQuote.estimatedBridgeAmountBase) < BigInt(state.quote.minimumBridgeAmountBase) ||
    BigInt(freshQuote.estimatedOutputAmountBase) < BigInt(state.quote.minimumOutputAmountBase)
  ) {
    throw new Error(
      'Fresh quote is worse than the reviewed preflight minimum; run a new preflight instead',
    )
  }
  const executionQuote: RouteQuote = {
    ...freshQuote,
    minimumBridgeAmountBase: state.quote.minimumBridgeAmountBase,
    minimumOutputAmountBase: state.quote.minimumOutputAmountBase,
  }
  const amount = BigInt(executionQuote.inputAmountBase)
  const minimum = BigInt(executionQuote.minimumOutputAmountBase)
  const lossBps = Number(((amount - minimum) * 10_000n) / amount)
  if (lossBps > state.maxLossBps) {
    throw new Error(
      `Fresh quote loss is ${lossBps} bps, above the ${state.maxLossBps} bps canary limit`,
    )
  }
  const created = await api.createFlow({
    quoteId: freshQuote.quoteId,
    ethereumSender: state.walletAddress,
    starknetAccount: state.identity.address,
    delayMinutes: state.delayMinutes,
  })
  log(
    `Fresh execution quote accepted: minimum ${formatUnits(minimum, TOKENS[state.outputToken].decimals)} ${state.outputToken}; flow ${created.flow.id}`,
  )
  return {
    ...state,
    quote: executionQuote,
    flowId: created.flow.id,
    writeToken: created.writeToken,
    updatedAt: new Date().toISOString(),
  }
}

function assertBackendConfig(config: Awaited<ReturnType<typeof import('../../web/src/api.js')['api']['config']>>) {
  if (config.environment !== 'mainnet') throw new Error('Backend is not configured for mainnet')
  if (!config.ready) throw new Error(`Backend is not ready: ${config.missing.join(', ')}`)
  required(config.ethereum.entryRouter, 'Ethereum entry router')
  required(config.ethereum.exitSettlementFactory, 'Ethereum settlement factory')
  required(config.starknet.cctpExitAnonymizer, 'Starknet CCTP exit anonymizer')
}

async function assertWalletFunding(
  client: ReturnType<typeof createPublicClient>,
  account: Address,
  inputToken: TokenSymbol,
  amount: bigint,
) {
  const ethBalance = await client.getBalance({ address: account })
  const requiredEth = MIN_GAS_RESERVE_WEI + (inputToken === 'ETH' ? amount : 0n)
  if (ethBalance < requiredEth) {
    throw new Error(
      `Canary wallet needs at least ${formatUnits(requiredEth, 18)} ETH; balance is ${formatUnits(ethBalance, 18)} ETH`,
    )
  }
  if (inputToken === 'ETH') return
  const balance = await client.readContract({
    address: CHAIN.ethereum.tokens[inputToken],
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [account],
  })
  if (balance < amount) {
    throw new Error(
      `Canary wallet needs ${formatUnits(amount, TOKENS[inputToken].decimals)} ${inputToken}; balance is ${formatUnits(balance, TOKENS[inputToken].decimals)}`,
    )
  }
}

async function submitEntry(args: {
  state: CanaryState
  account: Address
  ethereumClient: ReturnType<typeof createPublicClient>
  walletClient: ReturnType<typeof createWalletClient>
}): Promise<Hex> {
  const { state, account, ethereumClient, walletClient } = args
  const config = await (await import('../../web/src/api.js')).api.config()
  const entryRouter = required(config.ethereum.entryRouter, 'Ethereum entry router') as Address
  const amount = BigInt(state.quote.inputAmountBase)

  if (state.inputToken !== 'ETH') {
    const tokenAddress = CHAIN.ethereum.tokens[state.inputToken]
    const allowance = await ethereumClient.readContract({
      address: tokenAddress,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [account, entryRouter],
    })
    if (allowance < amount) {
      const { request } = await ethereumClient.simulateContract({
        account,
        address: tokenAddress,
        abi: erc20Abi,
        functionName: 'approve',
        args: [entryRouter, amount],
      })
      const approval = await walletClient.writeContract(request)
      log(`${state.inputToken} approval submitted: ${approval}`)
      await waitForEthereumTransaction(ethereumClient, approval)
    }
  }

  const intent = {
    flowId: keccak256(stringToHex(state.flowId)),
    inputAsset: { ETH: 0, USDC: 1, WBTC: 2 }[state.inputToken],
    amountIn: amount,
    minimumUsdc: BigInt(state.quote.minimumBridgeAmountBase),
    poolFee: state.quote.entryPoolFee,
    starknetRecipient: BigInt(state.identity.address),
    cctpMaxFee: BigInt(state.quote.inboundCctpMaxFeeBase),
    minFinalityThreshold: CCTP_FAST_FINALITY_THRESHOLD,
    deadline: BigInt(Math.floor(Date.now() / 1_000) + 15 * 60),
  }
  const { request } = await ethereumClient.simulateContract({
    account,
    address: entryRouter,
    abi: ENTRY_ABI,
    functionName: 'start',
    args: [intent],
    value: state.inputToken === 'ETH' ? amount : 0n,
  })
  const hash = await walletClient.writeContract(request)
  log(`Ethereum entry submitted: ${hash}`)
  return hash
}

async function predictSettlement(args: {
  state: CanaryState
  salt: Hex
  poolFee: 100 | 500 | 3000 | 10000
  recoverAfter: number
  ethereumClient: ReturnType<typeof createPublicClient>
}): Promise<Address> {
  const config = await (await import('../../web/src/api.js')).api.config()
  return args.ethereumClient.readContract({
    address: required(config.ethereum.exitSettlementFactory, 'Ethereum settlement factory') as Address,
    abi: SETTLEMENT_FACTORY_ABI,
    functionName: 'predict',
    args: [
      args.salt,
      args.state.recipient,
      { ETH: 0, USDC: 1, WBTC: 2 }[args.state.outputToken],
      BigInt(args.state.quote.minimumOutputAmountBase),
      args.poolFee,
      BigInt(args.recoverAfter),
    ],
  })
}

async function waitForEthereumTransaction(
  client: ReturnType<typeof createPublicClient>,
  hash: Hex,
): Promise<void> {
  const receipt = await client.waitForTransactionReceipt({ hash, timeout: 10 * 60_000 })
  if (receipt.status !== 'success') throw new Error(`Ethereum transaction reverted: ${hash}`)
}

async function waitForTokenBalance(
  client: ReturnType<typeof createPublicClient>,
  tokenAddress: Address,
  owner: Address,
  timeoutMs = 45 * 60_000,
): Promise<bigint> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const balance = await client.readContract({
      address: tokenAddress,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [owner],
    })
    if (balance > 0n) return balance
    await sleep(8_000)
  }
  throw new Error(`Timed out waiting for token balance at ${owner}`)
}

async function outputBalance(
  client: ReturnType<typeof createPublicClient>,
  token: TokenSymbol,
  owner: Address,
): Promise<bigint> {
  if (token === 'ETH') return client.getBalance({ address: owner })
  return client.readContract({
    address: CHAIN.ethereum.tokens[token],
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [owner],
  })
}

async function transition(
  api: typeof import('../../web/src/api.js')['api'],
  state: CanaryState,
  phase: FlowPhase,
  options: { txHash?: string; settlementAddress?: string; occurredAt?: string } = {},
): Promise<PublicFlow> {
  const flow = await api.getFlow(state.flowId, state.writeToken)
  if (flow.phase === phase) return flow
  if (flow.phase === 'failed') {
    throw new Error(`Backend flow is terminal: ${flow.failureReason ?? 'failed'}`)
  }
  if (phaseRank(flow.phase) > phaseRank(phase)) return flow
  if (!canTransition(flow.phase, phase)) {
    throw new Error(`Backend flow cannot transition ${flow.phase} -> ${phase}`)
  }
  return api.updateFlow(state.flowId, state.writeToken, { phase, ...options })
}

function phaseRank(phase: FlowPhase): number {
  return {
    prepared: 0,
    'allowance-required': 0,
    'entry-submitted': 1,
    'bridging-to-starknet': 2,
    'starknet-funded': 3,
    'pool-depositing': 4,
    'privacy-delay': 5,
    'pool-withdrawing': 6,
    'bridging-to-ethereum': 7,
    settling: 8,
    completed: 9,
    failed: 10,
  }[phase]
}

function serializeIdentity(identity: EphemeralIdentity): StoredIdentity {
  return {
    address: identity.address,
    classHash: identity.classHash,
    salt: identity.salt,
    publicKey: identity.publicKey,
    privateKey: identity.privateKey,
    viewingKey: identity.viewingKey.toString(),
  }
}

function restoreIdentity(identity: StoredIdentity): EphemeralIdentity {
  if (!/^0x[0-9a-fA-F]+$/.test(identity.privateKey)) {
    throw new Error('Recovery journal no longer contains an active Starknet private key')
  }
  return {
    address: identity.address,
    classHash: identity.classHash,
    salt: identity.salt,
    publicKey: identity.publicKey,
    privateKey: identity.privateKey,
    viewingKey: BigInt(identity.viewingKey),
    signer: new Signer(identity.privateKey),
  }
}

function capability(state: CanaryState) {
  return { flowId: state.flowId, flowToken: state.writeToken }
}

function assertResumeMatches(state: CanaryState, options: Options, account: Address) {
  if (state.version !== 1) throw new Error('Unsupported recovery journal version')
  if (state.walletAddress.toLowerCase() !== account.toLowerCase()) {
    throw new Error('Recovery journal was encrypted for a different Foundry account')
  }
  if (state.apiUrl !== options.apiUrl) {
    throw new Error(`Recovery journal targets ${state.apiUrl}, not ${options.apiUrl}`)
  }
}

function writeEncryptedState(path: string, state: CanaryState, privateKey: Hex) {
  const salt = randomBytes(32)
  const iv = randomBytes(12)
  const key = scryptSync(Buffer.from(privateKey.slice(2), 'hex'), salt, 32)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.from(state.walletAddress.toLowerCase()))
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(state), 'utf8'),
    cipher.final(),
  ])
  const payload: EncryptedState = {
    version: 1,
    walletAddress: state.walletAddress,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(payload)}\n`, { encoding: 'utf8', mode: 0o600 })
  renameSync(temporary, path)
  chmodSync(path, 0o600)
}

function readEncryptedState(path: string, privateKey: Hex): CanaryState {
  const payload = JSON.parse(readFileSync(path, 'utf8')) as EncryptedState
  if (
    payload.version !== 1 ||
    !isAddress(payload.walletAddress) ||
    !payload.salt ||
    !payload.iv ||
    !payload.tag ||
    !payload.ciphertext
  ) {
    throw new Error('Invalid encrypted recovery journal')
  }
  const salt = Buffer.from(payload.salt, 'base64')
  const key = scryptSync(Buffer.from(privateKey.slice(2), 'hex'), salt, 32)
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(payload.iv, 'base64'))
  decipher.setAAD(Buffer.from(payload.walletAddress.toLowerCase()))
  decipher.setAuthTag(Buffer.from(payload.tag, 'base64'))
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, 'base64')),
    decipher.final(),
  ])
  return JSON.parse(plaintext.toString('utf8')) as CanaryState
}

function randomHex32(): Hex {
  return `0x${randomBytes(32).toString('hex')}`
}

function required<T>(value: T | undefined | null, label: string): NonNullable<T> {
  if (value === undefined || value === null || value === '') throw new Error(`Missing ${label}`)
  return value as NonNullable<T>
}

async function waitUntil(timestamp: number) {
  while (Date.now() < timestamp) await sleep(Math.min(timestamp - Date.now(), 5_000))
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function log(message: string) {
  process.stdout.write(`[canary] ${message}\n`)
}

main().catch((error: unknown) => {
  process.stderr.write(`[canary] FAIL: ${errorText(error)}\n`)
  process.exitCode = 1
})
