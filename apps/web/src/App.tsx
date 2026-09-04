import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { TOKENS, type FlowPhase, type TokenSymbol } from '@privacy-round-trip/shared'
import { formatUnits } from 'viem'
import { formatTokenAmount } from './wallet.js'
import { INITIAL_FORM, useRoundTrip, type TransferForm } from './useRoundTrip.js'

const TOKEN_OPTIONS: TokenSymbol[] = ['ETH', 'USDC', 'WBTC']

const STEPS: Array<{ phases: FlowPhase[]; label: string; detail: string }> = [
  { phases: ['prepared', 'allowance-required'], label: 'Authorize', detail: 'One or two Rabby prompts' },
  { phases: ['entry-submitted'], label: 'Enter', detail: 'Swap to USDC on Ethereum' },
  { phases: ['bridging-to-starknet'], label: 'Bridge in', detail: 'Circle CCTP attestation' },
  { phases: ['starknet-funded', 'pool-depositing'], label: 'Shield', detail: 'Sponsored Starknet proof' },
  { phases: ['privacy-delay'], label: 'Private delay', detail: 'Your selected quiet period' },
  { phases: ['pool-withdrawing'], label: 'Exit pool', detail: 'Private note spend' },
  { phases: ['bridging-to-ethereum'], label: 'Bridge out', detail: 'CCTP forwarding' },
  { phases: ['settling', 'completed'], label: 'Settle', detail: 'Optional swap and payout' },
]

export function App() {
  const roundTrip = useRoundTrip()
  const [form, setForm] = useState<TransferForm>(INITIAL_FORM)

  useEffect(() => {
    if (roundTrip.wallet && !form.recipient) {
      setForm((current) => ({ ...current, recipient: roundTrip.wallet!.account }))
    }
  }, [roundTrip.wallet, form.recipient])

  const remaining = useMemo(() => {
    if (!roundTrip.flow?.exitEligibleAt) return undefined
    const seconds = Math.max(0, Math.ceil((Date.parse(roundTrip.flow.exitEligibleAt) - roundTrip.now) / 1_000))
    const minutes = Math.floor(seconds / 60)
    return `${minutes}:${String(seconds % 60).padStart(2, '0')}`
  }, [roundTrip.flow?.exitEligibleAt, roundTrip.now])

  const update = <K extends keyof TransferForm>(key: K, value: TransferForm[K]) => {
    setForm((current) => ({ ...current, [key]: value }))
    if (key === 'inputToken' || key === 'outputToken' || key === 'amount') {
      roundTrip.invalidateQuote()
    }
  }

  const preview = async (event: FormEvent) => {
    event.preventDefault()
    try {
      await roundTrip.preview(form)
    } catch {
      // Hook renders the error.
    }
  }

  const start = async () => {
    try {
      await roundTrip.start(form)
    } catch {
      // Pre-flight errors are surfaced below by the hook or browser console.
    }
  }

  const ready = roundTrip.config?.ready === true
  const prompts = form.inputToken === 'ETH' ? '1 Rabby transaction' : 'Up to 2 Rabby transactions'

  return (
    <div className="shell">
      <header className="topbar">
        <a className="brand" href="#top" aria-label="Privacy Round Trip home">
          <span className="brand-mark">S</span>
          <span>privacy / ethereum</span>
        </a>
        <div className="network"><span /> Ethereum mainnet only</div>
      </header>

      {(roundTrip.active || roundTrip.flow?.phase === 'failed') && (
        <aside className="critical" role="alert">
          <strong>DO NOT CLOSE OR RELOAD THIS WINDOW</strong>
          <span>
            This POC keeps the one-use Starknet key and privacy secret only in this tab. Closing it
            before completion can make funds unrecoverable.
          </span>
        </aside>
      )}

      <main id="top">
        <section className="hero">
          <div className="eyebrow">PRIVATE ROUND TRIP · POC</div>
          <h1>Leave Ethereum.<br /><em>Return quietly.</em></h1>
          <p className="lede">
            Start with ETH, USDC, or WBTC. The browser routes through USDC and Starknet’s privacy
            pool, waits as long as you choose, then pays any Ethereum address—without another wallet prompt.
          </p>
          <div className="trust-strip">
            <span>Non-custodial</span><i />
            <span>{prompts}</span><i />
            <span>User-selected delay</span>
          </div>
        </section>

        <section className="workspace">
          <form className="route-card" onSubmit={preview}>
            <div className="card-head">
              <div><span className="step-no">01</span><h2>Compose route</h2></div>
              {roundTrip.wallet ? (
                <button type="button" className="wallet-pill" disabled>
                  {short(roundTrip.wallet.account)}
                </button>
              ) : (
                <button
                  type="button"
                  className="wallet-pill connect"
                  disabled={roundTrip.busy}
                  onClick={() => void roundTrip.connect().catch(() => undefined)}
                >
                  Connect Rabby
                </button>
              )}
            </div>

            <fieldset disabled={roundTrip.active || roundTrip.busy}>
              <label className="amount-field">
                <span>You send</span>
                <div>
                  <input
                    value={form.amount}
                    inputMode="decimal"
                    aria-label="Amount"
                    onChange={(event) => update('amount', event.target.value)}
                  />
                  <select
                    value={form.inputToken}
                    aria-label="Input token"
                    onChange={(event) => update('inputToken', event.target.value as TokenSymbol)}
                  >
                    {TOKEN_OPTIONS.map((token) => <option key={token}>{token}</option>)}
                  </select>
                </div>
              </label>

              <div className="route-line"><span>↓</span><i /></div>

              <label className="amount-field receive">
                <span>Recipient receives</span>
                <div>
                  <output>
                    {roundTrip.quote
                      ? formatTokenAmount(roundTrip.quote.estimatedOutputAmountBase, form.outputToken).split(' ')[0]
                      : '—'}
                  </output>
                  <select
                    value={form.outputToken}
                    aria-label="Output token"
                    onChange={(event) => update('outputToken', event.target.value as TokenSymbol)}
                  >
                    {TOKEN_OPTIONS.map((token) => <option key={token}>{token}</option>)}
                  </select>
                </div>
              </label>

              <div className="field-grid">
                <label>
                  <span>Ethereum recipient</span>
                  <input
                    className="address-input"
                    value={form.recipient}
                    placeholder="0x…"
                    spellCheck={false}
                    onChange={(event) => update('recipient', event.target.value)}
                  />
                </label>
                <label>
                  <span>Private delay</span>
                  <div className="delay-input">
                    <input
                      type="number"
                      min={5}
                      max={10_080}
                      step={1}
                      value={form.delayMinutes}
                      onChange={(event) => update('delayMinutes', Number(event.target.value))}
                    />
                    <b>minutes</b>
                  </div>
                </label>
              </div>

              {!roundTrip.wallet ? (
                <button type="button" className="primary" onClick={() => void roundTrip.connect().catch(() => undefined)}>
                  Connect Rabby
                </button>
              ) : (
                <button type="submit" className="primary">Get mainnet route</button>
              )}
            </fieldset>

            {!ready && roundTrip.config && (
              <div className="config-gate">
                <strong>Deployment gate closed</strong>
                <span>Missing: {roundTrip.config.missing.join(', ')}</span>
              </div>
            )}
          </form>

          <section className="status-card" aria-live="polite">
            <div className="card-head">
              <div><span className="step-no">02</span><h2>Round trip</h2></div>
              {roundTrip.flow && <span className={`phase phase-${roundTrip.flow.phase}`}>{humanPhase(roundTrip.flow.phase)}</span>}
            </div>

            {roundTrip.quote && !roundTrip.active && !roundTrip.flow ? (
              <div className="quote-review">
                <div className="quote-main">
                  <span>Estimated arrival</span>
                  <strong>{formatTokenAmount(roundTrip.quote.estimatedOutputAmountBase, form.outputToken)}</strong>
                  <small>Minimum {formatTokenAmount(roundTrip.quote.minimumOutputAmountBase, form.outputToken)}</small>
                </div>
                <dl>
                  <div><dt>USDC entering CCTP</dt><dd>{formatUnits(BigInt(roundTrip.quote.estimatedBridgeAmountBase), TOKENS.USDC.decimals)} USDC</dd></div>
                  <div><dt>Slippage protection</dt><dd>1.00%</dd></div>
                  <div><dt>Wallet prompts</dt><dd>{form.inputToken === 'ETH' ? '1' : '≤ 2'}</dd></div>
                  <div><dt>Privacy delay</dt><dd>{form.delayMinutes} min</dd></div>
                </dl>
                <button className="primary invert" disabled={!ready || roundTrip.busy} onClick={() => void start()}>
                  Start private round trip
                </button>
                <p className="consent-note">Mainnet POC · real assets · unaudited contracts</p>
              </div>
            ) : roundTrip.flow ? (
              <div className="timeline-wrap">
                {remaining !== undefined && roundTrip.flow.phase === 'privacy-delay' && (
                  <div className="countdown"><span>Quiet period remaining</span><strong>{remaining}</strong></div>
                )}
                <ol className="timeline">
                  {STEPS.map((step, index) => {
                    const state = stepState(roundTrip.flow!.phase, index)
                    return (
                      <li key={step.label} className={state}>
                        <span className="dot">{state === 'done' ? '✓' : index + 1}</span>
                        <div><strong>{step.label}</strong><small>{step.detail}</small></div>
                      </li>
                    )
                  })}
                </ol>
              </div>
            ) : (
              <div className="empty-state">
                <div className="orbit"><i /><i /><i /></div>
                <strong>No route yet</strong>
                <span>Your private path will appear here before anything is signed.</span>
              </div>
            )}

            <div className="live-message">
              <i className={roundTrip.busy || roundTrip.active ? 'pulse' : ''} />
              <span>{roundTrip.message}</span>
            </div>
            {roundTrip.error && <div className="error-box"><strong>Flow stopped</strong>{roundTrip.error}</div>}
          </section>
        </section>

        <section className="warning-panel">
          <span className="warning-icon">!</span>
          <div>
            <h2>Keep this browser window open</h2>
            <p>
              To stay within the one/two-prompt goal, this POC generates a one-use Starknet key and
              privacy secret locally. They are never sent to the backend and are not recoverable after a reload.
            </p>
          </div>
          <div className="warning-meta"><b>Minimum delay</b><span>5 minutes</span></div>
        </section>

        <section className="how">
          <div className="eyebrow">THE PATH</div>
          <h2>Public edges.<br />Private middle.</h2>
          <div className="path-grid">
            <article><b>01</b><h3>Ethereum entry</h3><p>Optional Uniswap V3 swap, then a normal CCTP burn to a fresh Starknet account.</p></article>
            <article><b>02</b><h3>Shield + wait</h3><p>AVNU sponsors account deployment and the proof. The recipient is absent from the entry transaction.</p></article>
            <article><b>03</b><h3>Fresh exit</h3><p>After your delay, a new settlement contract is bound to the chosen Ethereum recipient.</p></article>
            <article><b>04</b><h3>Ethereum payout</h3><p>CCTP forwards USDC back; the settlement optionally swaps and pays the recipient.</p></article>
          </div>
        </section>
      </main>

      <footer><span>Ethereum Privacy Round Trip POC</span><span>Unaudited · Mainnet-only · Privacy is not anonymity</span></footer>
    </div>
  )
}

function stepState(phase: FlowPhase, step: number): 'pending' | 'active' | 'done' | 'failed' {
  if (phase === 'failed') return 'failed'
  if (phase === 'completed') return 'done'
  const active = STEPS.findIndex((item) => item.phases.includes(phase))
  return step < active ? 'done' : step === active ? 'active' : 'pending'
}

function humanPhase(phase: FlowPhase): string {
  return phase.replaceAll('-', ' ')
}

function short(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`
}
