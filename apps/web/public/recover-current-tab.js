const STORAGE_KEY = '__privacy_round_trip_recovery_v1'
const PROGRESS_KIND = 'privacy-round-trip-progress'

try {
  const roots = reactRoots()
  const identities = []
  const flows = []
  const forms = []
  const progressHints = []
  const visited = new Set()

  for (const root of roots) visit(root)

  const identity = identities.find((value) => value.privateKey && value.viewingKey > 0n)
  // Any stopped flow that left Ethereum can be recovered. The API record may lag the chain (the
  // entry-submitted PATCH can fail after the Ethereum transaction succeeded), so the entry hash is
  // taken from either the record or the tab's own progress hint for that flow.
  const accountFlows = flows.filter(
    (value) => identity && sameFelt(value.starknetAccount, identity.address) && value.phase !== 'completed',
  )
  const progressFor = (flow) =>
    progressHints.find((value) => value.flowId === flow.id) ??
    (progressHints.length === 1 ? progressHints[0] : undefined)
  const candidates = accountFlows.filter((flow) => flow.entryTxHash || progressFor(flow)?.entryTxHash)
  const sourceFlow = candidates.find((value) => value.phase === 'failed') ?? candidates[0]
  const progress = sourceFlow ? progressFor(sourceFlow) ?? {} : {}
  const form = forms.find(
    (value) =>
      typeof value.recipient === 'string' &&
      /^0x[0-9a-fA-F]{40}$/.test(value.recipient) &&
      ['ETH', 'USDC', 'WBTC'].includes(value.outputToken),
  )

  if (!identity) throw new Error('The one-use account key was not found. Keep this tab open.')
  if (!sourceFlow) throw new Error('No stopped flow with an Ethereum entry was found. Keep this tab open.')
  if (!form) throw new Error('The Ethereum payout instructions were not found. Keep this tab open.')

  const payload = {
    version: 2,
    identity: {
      address: identity.address,
      classHash: identity.classHash,
      salt: identity.salt,
      publicKey: identity.publicKey,
      privateKey: identity.privateKey,
      viewingKey: identity.viewingKey.toString(),
    },
    sourceFlow: {
      ...sourceFlow,
      ...(sourceFlow.entryTxHash ? {} : { entryTxHash: progress.entryTxHash }),
    },
    form: {
      inputToken: form.inputToken,
      outputToken: form.outputToken,
      amount: form.amount,
      recipient: form.recipient,
      delayMinutes: form.delayMinutes,
    },
    progress: {
      ...(progress.writeToken ? { writeToken: progress.writeToken } : {}),
      ...(progress.entryTxHash ? { entryTxHash: progress.entryTxHash } : {}),
      ...(progress.inboundMintTxHash ? { inboundMintTxHash: progress.inboundMintTxHash } : {}),
      ...(progress.depositTxHash ? { depositTxHash: progress.depositTxHash } : {}),
      ...(progress.depositedAt ? { depositedAt: progress.depositedAt } : {}),
      ...(progress.privateAmount ? { privateAmount: progress.privateAmount } : {}),
      ...(progress.salt ? { salt: progress.salt } : {}),
      ...(progress.recoverAfter ? { recoverAfter: progress.recoverAfter } : {}),
      ...(progress.settlement ? { settlement: progress.settlement } : {}),
      ...(progress.settlementTxHash ? { settlementTxHash: progress.settlementTxHash } : {}),
      ...(progress.exitTxHash ? { exitTxHash: progress.exitTxHash } : {}),
      ...(progress.finalTxHash ? { finalTxHash: progress.finalTxHash } : {}),
    },
  }
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(payload))
  location.assign('/recovery.html')

  function visit(fiber) {
    if (!fiber || visited.has(fiber)) return
    visited.add(fiber)
    let hook = fiber.memoizedState
    const hooksSeen = new Set()
    while (hook && typeof hook === 'object' && !hooksSeen.has(hook)) {
      hooksSeen.add(hook)
      const value = hook.memoizedState
      if (isIdentity(value?.current)) identities.push(value.current)
      if (isProgress(value?.current)) progressHints.push(value.current)
      if (isFlow(value)) flows.push(value)
      if (isForm(value)) forms.push(value)
      hook = hook.next
    }
    visit(fiber.child)
    visit(fiber.sibling)
    visit(fiber.alternate)
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  alert(`Recovery could not start: ${message}`)
  throw error
}

function reactRoots() {
  const root = document.getElementById('root')
  if (!root) throw new Error('Application root was not found')
  const elements = [root, ...root.querySelectorAll('*')]
  for (const element of elements) {
    const key = Reflect.ownKeys(element).find(
      (value) => typeof value === 'string' && value.startsWith('__reactFiber$'),
    )
    if (!key) continue
    let fiber = element[key]
    while (fiber?.return) fiber = fiber.return
    if (fiber) return [fiber]
  }

  const hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__
  if (hook?.getFiberRoots && hook?.renderers) {
    const roots = []
    for (const rendererId of hook.renderers.keys()) roots.push(...hook.getFiberRoots(rendererId))
    if (roots.length) return roots.map((value) => value.current ?? value)
  }
  throw new Error('React session state was not found')
}

function isIdentity(value) {
  return Boolean(
    value &&
      typeof value === 'object' &&
      typeof value.address === 'string' &&
      typeof value.privateKey === 'string' &&
      typeof value.viewingKey === 'bigint' &&
      typeof value.publicKey === 'string',
  )
}

function isProgress(value) {
  return Boolean(value && typeof value === 'object' && value.kind === PROGRESS_KIND)
}

function isFlow(value) {
  return Boolean(
    value &&
      typeof value === 'object' &&
      typeof value.id === 'string' &&
      value.id.startsWith('f_') &&
      typeof value.starknetAccount === 'string' &&
      typeof value.phase === 'string',
  )
}

function isForm(value) {
  return Boolean(
    value &&
      typeof value === 'object' &&
      typeof value.inputToken === 'string' &&
      typeof value.outputToken === 'string' &&
      typeof value.amount === 'string' &&
      typeof value.delayMinutes === 'number',
  )
}

function sameFelt(left, right) {
  try {
    return BigInt(left) === BigInt(right)
  } catch {
    return false
  }
}
