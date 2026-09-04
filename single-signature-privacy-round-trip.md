# Single-Signature Privacy Round Trip — Technical Specification

| | |
|---|---|
| **Status** | Draft v0.1 for internal review |
| **Date** | 2026-09-02 |
| **Owner** | Starknet Foundation |
| **Scope** | ETH in on Ethereum mainnet → Starknet privacy pool → Ekubo swap → StarkGate-bridged ERC-20 out to a fresh Ethereum address |
| **Decision recorded** | Option 1: resumable client flow, Starknet keys derived from one off-chain Rabby signature |

Verification tags used below: **[verified]** = read directly from source on 2026-09-02 (`starkware-libs/starknet-privacy` main, `starknet-io/starkgate-contracts` main, `paulmillr/scure-starknet` main, docs.starknet.io). **[verify]** = assumption or deployment detail to confirm before build. Nothing tagged [verify] should be treated as fact.

---

## 1. Summary

A user holding ETH in Rabby signs one on-chain transaction. The ETH is bridged to Starknet through StarkGate, deposited into the Starknet privacy pool, swapped through the existing Ekubo swap anonymizer, and bridged back to an Ethereum address of the user's choosing through a new exit anonymizer. Every Starknet step is signed by an ephemeral Starknet account whose key the web client derives from a single off-chain Rabby signature.

The user sees two wallet prompts: one message to sign, one transaction to send. No Starknet wallet, no STRK, no second chain to think about. The tab can be closed at any point; re-signing the same message on any device recreates the keys and the client resumes from on-chain state.

### 1.1 Goals

- One on-chain user transaction and one off-chain signature, both in Rabby.
- Funds recoverable from any device using only the user's Ethereum wallet.
- Exit address unlinkable to deposit address for on-chain observers, to the extent the pool's cryptography allows.
- Reuse StarkWare's deployed pool, prover, discovery service and Ekubo anonymizer without modification.

### 1.2 Non-goals

- Privacy against the prover operator or the pool auditor. The pool does not offer it (§11).
- ERC-20 inputs. These need a permit periphery on L1 and are deferred to v2.
- Output tokens not serviced by StarkGate. Natively issued tokens need their issuer's bridge.
- Unattended timing delays. These need pre-signed exits plus a delayed-proving service on the prover side (§11.4).

---

## 2. Actors and components

| Component | Role in the flow | Status |
|---|---|---|
| User with Rabby | Signs the derivation message and the L1 deposit | Exists |
| Web client | Derives keys, orchestrates the Starknet leg, persists public progress, resumes | **Build** |
| StarkGate L1 bridge | `deposit`, `withdraw`, cancel and reclaim | Exists [verified] |
| StarkGate L2 bridge | Mints on deposit, `initiate_token_withdraw` on exit | Exists [verified] |
| Ephemeral account A1 | OpenZeppelin account class, one per flow, owner key derived in §4 | Class exists; deployed per user |
| Privacy pool | Notes, proof validation, anonymizer invocations | Exists, StarkWare-operated [verified] |
| Transaction prover | Proves the pool's virtual transactions; OHTTP front | Exists, StarkWare-operated [verified] |
| Discovery service | Note and channel discovery for the client | Exists [verified] |
| Ekubo swap anonymizer | Swaps inside the pool, output to an open note | Exists in repo [verified] |
| Exit anonymizer | Receives the withdrawn token and calls StarkGate `initiate_token_withdraw` | **Build** (§7) |
| Gas paymaster | SNIP-29 sponsor for A1 deploy and approve, paid in ETH from A1 | Exists (e.g. AVNU) [verify] |
| Relayer | Submits proof-carrying pool transactions as its own account; finalizes on L1; paid by an in-transaction `Withdraw` | **Build or partner** [verify] |

---

## 3. End-to-end flow

```mermaid
sequenceDiagram
    autonumber
    actor U as User (Rabby)
    participant C as Web client
    participant L1 as StarkGate L1
    participant L2B as StarkGate L2
    participant A1 as Account A1
    participant P as Prover
    participant R as Relayer
    participant Pool as Privacy pool
    participant X as Anonymizers

    U->>C: personal_sign(fixed message)
    C->>C: derive k_sign, k_view; compute A1 address
    U->>L1: deposit(ETH, amount, A1)  msg.value = amount + fee
    L1-->>L2B: L1→L2 message (minutes)
    L2B->>A1: mint ETH to A1
    C->>A1: deploy + approve(pool) via gas paymaster
    Note over C,A1: wait ≥ 10 blocks
    C->>P: signed virtual tx 1 (register, deposit, swap) over OHTTP
    P-->>C: proof + facts
    C->>R: callAndProof 1
    R->>Pool: apply_actions (proof attached)
    Pool->>X: Ekubo anonymizer swaps ETH→USDC into open note
    Note over C,Pool: wait finality + 10 blocks, or return later
    C->>P: signed virtual tx 2 (exit)
    P-->>C: proof + facts
    C->>R: callAndProof 2
    R->>Pool: apply_actions
    Pool->>X: Exit anonymizer: initiate_token_withdraw(USDC, recipient)
    X-->>L1: L2→L1 message (hours)
    R->>L1: withdraw(USDC, amount, recipient)
```

| Phase | Signer | Chain | Typical latency | Client must be online |
|---|---|---|---|---|
| P0 Key derivation | User, `personal_sign` | none | seconds | yes |
| P1 L1 deposit | User, transaction | Ethereum | L1 inclusion | yes |
| P2 Arrival on L2 | nobody | StarkGate message | minutes [verify] | no (polls when open) |
| P3 Account setup | A1 key via paymaster | Starknet | seconds, then 10-block wait | yes |
| P4 Private tx 1: register, deposit, swap | A1 key → prover → relayer | Starknet | about a minute | yes |
| P5 Private tx 2: exit | A1 key → prover → relayer | Starknet | about a minute after the 10-block wait, or after the user returns | yes |
| P6 L2→L1 message and L1 finalization | Relayer or anyone | Ethereum | hours [verify] | no |

The mandatory online window is P3 through P5, on the order of ten to twenty minutes when exiting immediately. P6 needs neither the user nor the key.

---

## 4. Key derivation

### 4.1 The prompt

The client requests one EIP-191 `personal_sign` over a fixed message. The message contains no nonce and no timestamp, because the same signature must be reproducible later for recovery. Deterministic ECDSA (RFC 6979) makes re-signing the same message yield the same signature for EOA signers.

Message template (final wording to be reviewed):

```
<App name> private transfer keys

Signing this message derives the Starknet keys that hold your funds
while a private transfer is in progress. Only sign it on <origin>.

Origin: https://<app-domain>
Ethereum chain: 1
Key version: 1
```

The signature is consumed in the page and discarded. It is never sent to any server, never logged, never persisted.

EIP-712 typed data would give Rabby a structured domain display and is acceptable if hardware-wallet support through Rabby is confirmed [verify]. `personal_sign` is the default because Ledger and Trezor support it without blind signing.

### 4.2 Derivation

Inputs: the 65-byte signature `sig` and the exact message string `msg`.

1. `prk = HKDF-Extract(SHA-256, salt = SHA-256(msg), ikm = sig)`
2. `seed_sign = HKDF-Expand(prk, info = "snf-privacy/stark-signing-key/v1", 32 bytes)`
3. `seed_view = HKDF-Expand(prk, info = "snf-privacy/pool-viewing-key/v1", 32 bytes)`
4. `k_sign = grindKey(seed_sign)`, `k_view = grindKey(seed_view)`

`grindKey` is the StarkWare key-grinding procedure implemented in `@scure/starknet` [verified]: it hashes `seed || counter` with SHA-256 and rejection-samples until the result is below the largest multiple of the STARK curve order, then reduces modulo the order. Both outputs are therefore uniform in `[1, n)`. The pool requires the viewing key to be non-zero and canonical [verified]; any value below the curve order satisfies that.

`ethSigToPrivate` in the same library is the single-key variant of this construction and grinds only `r`. Two domain-separated HKDF outputs are used instead so that the signing key and the viewing key are independent.

Zeroize `sig`, `prk`, and both seeds after step 4.

### 4.3 Account address

A1 is an OpenZeppelin account with a single STARK-curve owner key:

- class hash: the OpenZeppelin account class declared on Starknet mainnet [verify: pin exact hash and version]
- salt: `pub(k_sign)`
- constructor calldata: `[pub(k_sign)]`
- deployer address: 0

The address is the standard Starknet contract-address hash over these inputs. It is computed before the L1 deposit and used as `l2Recipient`. StarkGate mints to it whether or not the account is deployed.

### 4.4 Persistence and resumption

Secrets live in page memory for the session only. On a fresh session the client asks for the signature again and re-derives.

Public state persisted in IndexedDB: L1 deposit transaction hash and message nonce, A1 address, the chosen L1 recipient, amounts, current phase, Starknet transaction hashes, the open note id from transaction 1. Notes and channels are never persisted; the pool SDK's stateless mode rebuilds them from the discovery service on every action [verified].

Resumption from a new device: re-sign, derive, compute A1, read the user's own StarkGate `Deposit` events for `l2Recipient == A1`, then read A1's balance and the pool's discovery service to find which phase the flow is in.

### 4.5 Wallet compatibility

Supported: EOA signers, meaning Rabby software keys and Ledger or Trezor through Rabby. All produce deterministic signatures.

Unsupported: contract accounts such as Safe, which sign through EIP-1271, and MPC signers that do not use deterministic nonces. Gate: `eth_getCode(address)` must return empty bytecode before the derivation prompt; otherwise show an unsupported-wallet message.

Recovery check: after re-derivation, the computed A1 must equal the `l2Recipient` of the user's L1 deposit event. A mismatch means a different wallet or a non-deterministic signer, and the client says so instead of proceeding.

### 4.6 Threats specific to derivation

- Any website can present the same message text. The origin line, the wallet's message display, and in-app education are the mitigations. This is the accepted weakness of signature-derived keys.
- The signature must never be derived from the on-chain transaction signature. That signature is public.
- Page compromise during a session exposes both keys. Strict CSP, no third-party scripts, pinned SDK version, subresource integrity.

---

## 5. Ethereum leg

### 5.1 Deposit

The user calls `deposit(address token, uint256 amount, uint256 l2Recipient)` on the StarkGate ETH bridge [verified]. For the ETH bridge `msg.value` must be at least `amount`; the remainder is the L1→L2 message fee [verified]. The client sets `msg.value = amount + estimateDepositFeeWei()` [verified] with a small margin. `l2Recipient` is A1.

Preconditions the client checks before prompting: the bridge's max total balance is not exceeded (`MAX_BALANCE_EXCEEDED` otherwise) [verified].

The client records the transaction hash and the nonce from the `Deposit` event for the cancellation path.

### 5.2 Failure: the L2 handler never runs

If the L1→L2 message is never consumed, the user recovers with `depositCancelRequest(token, amount, l2Recipient, nonce)` [verified] and, after the messaging cancellation delay of five days per Starknet docs [verified], `depositReclaim` with the same identifiers. Both require Rabby signatures. This is a failure path only; in the normal flow the user signs nothing after the deposit.

---

## 6. Starknet leg

### 6.1 Arrival detection

Poll the ETH ERC-20 balance of A1, or watch the L2 bridge's deposit-handled event for `l2_recipient == A1`. Record block `B0`.

### 6.2 Account setup (transparent transactions)

Through a SNIP-29 gas paymaster paying in ETH from A1 [verify]: deploy A1 with the parameters from §4.3, and call `approve(pool, amount)` on the ETH token. Record block `B1`.

Then wait until `latest ≥ max(B0, B1) + 10`. The pool's prover reads finalized state, and the sequencer accepts proofs whose base block is at least ten blocks old; any state the proof reads must have been written at least ten blocks before the base block. Register cannot follow deploy within ten blocks, and deposit cannot follow funding within ten blocks [verified].

### 6.3 Private transaction 1: register, deposit, swap

Built with the pool SDK. Actions, in pool phase order [verified]:

| Phase | Action | Content |
|---|---|---|
| 0 | `SetViewingKey` | via `autoRegister`, publishes `pub(k_view)` for A1 |
| 3 | `Deposit` | ETH, `amount_in` |
| 5 | `CreateOpenNote` | output token, recipient self, amount `Open` |
| 6 | `Withdraw` | ETH, `swap_amount`, to the Ekubo swap anonymizer |
| 6 | `Withdraw` | ETH, `relayer_fee`, to the relayer's fee address |
| 7 | `InvokeExternal` | Ekubo swap anonymizer `privacy_invoke(router, TokenAmount{ETH, swap_amount}, PoolKey, minimum_received, skip_ahead, open_note_id)` |

`amount_in = swap_amount + relayer_fee` so that every token balance in the transaction nets to zero, which the pool enforces [verified]. The pool allows one `InvokeExternal` per transaction [verified].

Slippage: `minimum_received` from an Ekubo quote times `(1 − tolerance)`. The anonymizer enforces a full swap and reverts on partial fills [verified].

Builder sketch, adapted from the SDK README:

```ts
const { callAndProof } = await transfers
  .build({
    autoRegister: true,
    autoSetup: true,
    autoDiscover: { notes: "refresh", channels: "refresh" },
    provingBlockId: { block_number: latest - 10 },
  })
  .with(ETH, (t) =>
    t.deposit({ amount: amountIn })
     .withdraw({ recipient: EKUBO_SWAP_ANONYMIZER, amount: swapAmount })
     .withdraw({ recipient: relayerFeeAddress, amount: relayerFee }))
  .with(USDC, (t) => t.transfer({ recipient: self, amount: Open }))
  .invoke((args) => ({
    contractAddress: EKUBO_SWAP_ANONYMIZER,
    calldata: [
      EKUBO_ROUTER,
      ETH, swapAmount, 0n,                       // TokenAmount { token, i129 { mag, sign } }
      POOL_TOKEN0, POOL_TOKEN1, POOL_FEE, TICK_SPACING, EXTENSION,
      minimumReceived.low, minimumReceived.high,
      SKIP_AHEAD,
      args.openNotes[0].noteId,
    ],
  }))
  .execute();
```

Proving: `ProvingServiceProofProvider` with OHTTP enabled [verified], base block `latest − 10`. The virtual transaction carries `(A1, k_view, actions)` in calldata and is signed with `k_sign`; the pool checks the signature against A1 [verified].

Submission: the client sends `callAndProof` to the relayer, which submits `apply_actions(actions, screening)` as its own account with the proof attached. The pool checks the caller only to collect its STRK fee [verified]; the relayer pays it and recovers it through the in-transaction `Withdraw`.

Screening: the prover's sidecar screens A1 as the depositor and returns a screening attestation the SDK packs into `apply_actions` calldata; a sanctioned address gets JSON-RPC error 10000 and no proof [verified].

### 6.4 Sequencing before the exit

Wait for transaction 1 to be `ACCEPTED_ON_L2`, then `latest ≥ block(tx1) + 10`. Proofs expire after the pool's `proof_validity_blocks` [verified], configured per deployment [verify: current value; README example is 450 blocks], so submit promptly after proving.

### 6.5 Private transaction 2: exit

Discover notes; the open note now holds `amount_out` of the output token.

| Phase | Action | Content |
|---|---|---|
| 4 | `UseNote` | the output-token open note |
| 6 | `Withdraw` | output token, `amount_out − relayer_fee`, to the exit anonymizer |
| 6 | `Withdraw` | output token, `relayer_fee`, to the relayer's fee address |
| 7 | `InvokeExternal` | exit anonymizer `privacy_invoke(l1_token, l1_recipient)` |

The relayer submits. A1 does not appear on-chain in this transaction: the `Withdrawal` event carries `to_addr`, token, amount and the user address encrypted to the auditor [verified].

### 6.6 Profiles

| | Fast | Private |
|---|---|---|
| Transaction 1 | deposit + swap | deposit into an encrypted self-note |
| Between | 10-block wait | user returns after a random delay of hours to days, re-signs |
| Swap | in transaction 1 | separate transaction, standard denominations |
| Exit | full open note, immediately | encrypted notes split into standard denominations, exited at separate times, optionally to several recipients |
| Private transactions | 2 | 4 or more |
| Linkability for a chain analyst | trivial by amount and timing | depends on how many users exit the same denomination in the same window |

Fast is the MVP default. Private is the same code path with different scheduling and is where the product's privacy claim has to be earned.

---

## 7. Exit anonymizer (new Cairo contract)

### 7.1 Purpose

Turn a pool `Withdraw` into a StarkGate L2→L1 withdrawal inside the same transaction, so the L1 recipient is introduced only on the exit side.

### 7.2 Interface

```cairo
#[starknet::interface]
pub trait IStarkgateExitAnonymizer<T> {
    /// Called by the privacy pool via `privacy_invoke`. Bridges this contract's entire
    /// balance of the L2 token mapped to `l1_token` to `l1_recipient` on Ethereum.
    /// Returns an empty span: no open notes are deposited.
    fn privacy_invoke(
        ref self: T, l1_token: EthAddress, l1_recipient: EthAddress,
    ) -> Span<OpenNoteDeposit>;

    fn get_bridge(self: @T, l1_token: EthAddress) -> (ContractAddress, ContractAddress);
}
```

Pool calldata serialization: `[l1_token, l1_recipient]`.

### 7.3 Storage and constructor

- `privacy_pool: ContractAddress`, immutable.
- `routes: Map<EthAddress, (l2_token, l2_bridge)>`, set in the constructor, immutable. Adding a token means deploying a new instance. This keeps the contract free of admin keys; an upgradable registry is a possible v2 if the token list churns.

### 7.4 Logic

1. `assert(get_caller_address() == privacy_pool, 'UNAUTHORIZED_CALLER')`
2. `(l2_token, bridge) = routes[l1_token]`; assert both non-zero, `'UNKNOWN_TOKEN'`
3. `amount = IERC20(l2_token).balance_of(self)`; assert non-zero, `'ZERO_BALANCE'`
4. `ITokenBridge(bridge).initiate_token_withdraw(l1_token, l1_recipient, amount)`
5. emit `ExitInitiated { l1_token, l1_recipient, amount }`
6. return `array![].span()`

Step 4 works without an approval: the bridge checks the caller's balance and burns from the caller [verified]. Bridging the full balance means the client controls the exit amount purely through the pool `Withdraw`, and no dust is stranded.

### 7.5 Why no pool governance is needed

The pool applies open-note screening policy only when an invoke returns deposits. An empty deposit span skips that branch entirely [verified]. The contract can be deployed and used permissionlessly.

### 7.6 Failure behaviour

If the bridge's withdrawal limit is active and the quota is exhausted, `initiate_token_withdraw` reverts [verified] and the whole pool transaction reverts. Nothing is spent; the client retries later. Same for a zero or unknown route.

### 7.7 Tests

snforge, in the `starknet-privacy` workspace style:

- happy path with a mock bridge that records `(l1_token, l1_recipient, amount)` and burns
- caller is not the pool → revert
- unknown `l1_token` → revert
- zero balance → revert
- bridge reverts (quota) → whole call reverts, balance unchanged
- integration: pool test harness performs `Withdraw` to the anonymizer and `InvokeExternal` in one transaction; assert `FINAL_BALANCE_MUST_BE_ZERO` is satisfied and the bridge mock saw the full amount

---

## 8. L2→L1 message and L1 finalization

The StarkGate L2 bridge asserts a non-zero recipient, a known token, a non-zero amount not above the caller's balance, consumes withdrawal quota when a limit is active, burns from the caller, and emits `WithdrawInitiated { l1_token, l1_recipient, amount, caller_address }` [verified]. The L2→L1 payload is `[TRANSFER_FROM_STARKNET, recipient, token, amount_low, amount_high]` [verified].

Once the Starknet state update containing that block is accepted on L1, the relayer calls `withdraw(address token, uint256 amount, address recipient)` on the L1 bridge. The function is public, requires a non-zero recipient, consumes the message, applies the per-token withdrawal quota when enabled, and transfers to `recipient` [verified]. The recipient needs no ETH.

The relayer finds pending exits by filtering `WithdrawInitiated` events where `caller_address` is the exit anonymizer. No extra message from the client is needed.

Fallback: the user, or anyone, can call `withdraw` from any wallet.

---

## 9. Fees and gas

| Cost | Paid by | In | Mechanism |
|---|---|---|---|
| L1 gas for `deposit` | user | ETH | Rabby transaction |
| StarkGate L1→L2 message fee | user | ETH | `msg.value − amount` [verified] |
| A1 deploy and `approve` | user | ETH from A1 | SNIP-29 gas paymaster [verify] |
| Pool STRK fee on `apply_actions`, if configured | relayer | STRK | recovered via in-transaction `Withdraw` [verified] |
| Starknet gas for both proof-carrying transactions | relayer | STRK | same |
| Ekubo swap fee and slippage | user | in-swap | `minimum_received` bound |
| L1 gas for `withdraw` finalization | relayer | ETH | same in-transaction fee, quoted up front |

Fee quoting follows the SDK's gasless recipe [verified]: simulate the transaction with a placeholder fee withdrawal, obtain a quote from the relayer, rebuild with the quoted amount, prove, execute.

---

## 10. Timing and sequencing rules

| Rule | Value | Source |
|---|---|---|
| Any state a proof reads must be at least 10 blocks older than the base block | 10 blocks | SDK README [verified] |
| Sequencer accepts proofs whose base block is at least 10 blocks old | 10 blocks | SDK README [verified] |
| Proof expiry | `proof_validity_blocks`, pool config | contract [verified]; value [verify] |
| Prover latency | about 4 s per SDK README | [verified] |
| L1→L2 message delivery | minutes | [verify] |
| L2→L1 finalization | next Starknet state update on L1, hours | docs [verified]; cadence [verify] |
| Deposit cancellation delay | 5 days | docs [verified] |

---

## 11. Privacy analysis

### 11.1 What is public at each step

| Step | Public data | Links |
|---|---|---|
| L1 `deposit` | user's L1 address, amount, `l2Recipient = A1` | user → A1 |
| L2 mint | A1 balance | |
| A1 deploy and approve | A1, pool address | |
| Pool `Deposit` event | A1, token, amount | A1 → pool deposit |
| `OpenNoteDeposited` | anonymizer as depositor, token, `note_id`, `amount_out` | swap output amount |
| Ekubo swap | router trade, amounts | same transaction as the deposit in Fast profile |
| Exit `Withdrawal` event | `to_addr` = exit anonymizer, token, amount, user address encrypted to auditor | |
| `WithdrawInitiated` | `l1_recipient`, amount | recipient → amount |
| L1 `Withdrawal` | recipient, token, amount | |

### 11.2 Linkage vectors

- **Amount.** `amount_out` is public when the open note is filled and again when it is withdrawn. Exiting exactly `amount_out` links the two. The Private profile splits into standard denominations.
- **Timing.** Deposit and exit minutes apart are linkable regardless of cryptography. Only delay fixes this, which in Option 1 means the user returns.
- **Prover operator.** The virtual transaction contains A1, `k_view`, and every action in plaintext. The prover can link deposit and exit for every user. OHTTP hides the client's network identity from it, nothing more [verified].
- **Auditor.** Every `Withdraw` encrypts the user address to the auditor's key; the auditor can de-anonymize exits by design [verified].
- **Screening.** Elliptic screens A1 at deposit. A1 is a fresh address whose only funding is a StarkGate transfer from the user's L1 address, so screening effectively covers that address.
- **Relayer.** Sees `callAndProof`, which is public data once submitted, and the client's IP unless the client reaches it through OHTTP or similar.

### 11.3 What the product can honestly claim

Against a blockchain explorer and casual observers: the exit address is not derivable from the deposit address. Against a chain analyst: only the Private profile, with denominations and delays, and only in proportion to how many other users exit the same denomination in the same window. Against StarkWare's prover and the pool auditor: nothing. This wording should be reviewed before anything user-facing is written.

### 11.4 Future: unattended delays

A signed exit virtual transaction has no expiry, and the prover takes the block id at proving time [verified]. Once the swap has landed and `amount_out` is known, the client could sign the exit and hand it to the prover operator to prove and submit after a delay. The holder cannot redirect funds because the recipient is fixed in the signed calldata, and the prover already sees `k_view`. This needs a scheduled-proving feature on the prover side and is out of scope here; it is the route to timing decorrelation without the user returning.

---

## 12. Failure modes and recovery

| Failure | Effect | Recovery |
|---|---|---|
| Tab closed at any point | flow pauses; funds at A1 or in pool notes owned by `k_view` and `k_sign` | re-sign, re-derive, resume from on-chain state (§4.4) |
| L1→L2 message never consumed | ETH held by L1 bridge | `depositCancelRequest`, five days, `depositReclaim`; two Rabby signatures |
| Wallet is a contract account or non-deterministic signer | derivation not reproducible | blocked at onboarding by the bytecode gate; on recovery, address mismatch error |
| Paymaster unavailable | A1 not deployed | retry; alternative paymaster; ETH still at A1 |
| Screening blocks A1 | no proof for the deposit; ETH stays at A1 | client offers a direct StarkGate withdrawal from A1 back to any L1 address, no privacy, no loss |
| Swap reverts on slippage or partial fill | transaction 1 fails; nothing spent | requote, retry |
| Proof expires before submission | `PROOF_EXPIRED` | reprove at a fresh base block |
| Prover down | cannot progress | wait; funds unaffected |
| Exit reverts on bridge withdrawal quota | transaction 2 fails; note unspent | retry later |
| L1 finalization delayed by withdrawal limit | funds locked in L1 bridge until quota | relayer retries; anyone can call `withdraw` |
| Relayer disappears | client can submit `apply_actions` from any funded Starknet account, at the cost of that account appearing as sender | fallback path in client |

---

## 13. Security considerations

- Secrets exist only in page memory. No `localStorage`, no IndexedDB, no logging of `sig`, `k_sign`, `k_view`.
- The derivation message is fixed per app origin and key version. Changing it changes every user's keys; version bumps must ship a migration that derives both versions and sweeps.
- Strict CSP, no third-party scripts, SRI on every script. A compromised page during a session equals a compromised hot wallet.
- Pin the pool SDK to the release matching the deployed pool contract. The compatibility matrix in the repo README is authoritative; ABI drift silently breaks screening detection [verified].
- Exit anonymizer: pool-only caller, immutable routes, no admin keys, no held balances between transactions.
- Anyone can send tokens to A1 or to the anonymizer; neither creates a liability. Anyone can deploy A1 first with identical parameters; the result is the same account.
- Rabby simulation will show a StarkGate deposit to an unfamiliar L2 address. The UI must show the same A1 address so the user can compare.
- Operating this flow touches sanctions screening and mixer-adjacent territory. Compliance framing needs legal review before launch.

---

## 14. Open items to verify before build

- [ ] Mainnet addresses and versions: privacy pool, Ekubo swap anonymizer, discovery service, prover endpoint and OHTTP gateway.
- [ ] Pool `fee_amount` and `proof_validity_blocks` on mainnet.
- [ ] OpenZeppelin account class hash to pin, and SNIP-9 outside-execution support for the paymaster.
- [ ] SNIP-29 paymaster that sponsors account deployment and accepts ETH as the gas token.
- [ ] Whether AVNU or another party already relays proof-carrying pool transactions; otherwise scope the relayer.
- [ ] Output token: confirm it is StarkGate-bridged on mainnet and which L2 bridge contract serves it. Natively issued USDC would need a CCTP exit instead.
- [ ] Ekubo router address and pool key for the chosen pair; expected depth for the target amounts.
- [ ] StarkGate L1 token identifier used by the ETH bridge for `deposit`.
- [ ] Current L1→L2 delivery time and L2→L1 state-update cadence.
- [ ] Rabby behaviour for `personal_sign` with Ledger and Trezor; EIP-712 as alternative.
- [ ] Legal review of user-facing privacy and compliance wording.

---

## 15. Build plan

| Milestone | Deliverable | Depends on |
|---|---|---|
| M1 | Exit anonymizer contract, tests, Sepolia deployment | routes for test tokens |
| M2 | Client MVP, Fast profile, Sepolia integration pool per the repo's demo setup | M1, paymaster, prover access |
| M3 | Relayer: quote, submit, L1 finalize; monitoring | M2 |
| M4 | Resume-from-any-device hardening, wallet gating, failure paths in §12 | M2 |
| M5 | Private profile scheduling, denominations, delays | M4 |
| M6 | Mainnet: pinned addresses, legal-reviewed copy, limits | M3, M5 |

---

## Appendix A: verified interfaces

StarkGate L1, `StarknetTokenBridge.sol` and `StarknetEthBridge.sol`:

```solidity
function deposit(address token, uint256 amount, uint256 l2Recipient) external payable;
function estimateDepositFeeWei() external pure returns (uint256);
function withdraw(address token, uint256 amount, address recipient) public;
function withdraw(address token, uint256 amount) external;           // recipient = msg.sender
function depositCancelRequest(address token, uint256 amount, uint256 l2Recipient, uint256 nonce) external;
function depositReclaim(...);                                         // same identifiers, after the delay
// ETH bridge: require(msg.value >= amount); fee = msg.value - amount
```

StarkGate L2, `packages/bridge/src/interfaces.cairo`:

```cairo
fn initiate_token_withdraw(ref self, l1_token: EthAddress, l1_recipient: EthAddress, amount: u256);
fn on_receive(ref self, l2_token: ContractAddress, amount: u256, depositor: EthAddress, message: Span<felt252>) -> bool; // not used here
```

Privacy pool, `packages/privacy/src/interface.cairo` and `actions.cairo`:

```cairo
// virtual tx, proven off-chain: calldata = (user_addr, user_private_key /* viewing key */, client_actions)
fn __execute__(ref self, calls: Array<Call>);
// on-chain, any caller: proof facts read from tx info; caller pays STRK fee if configured
fn apply_actions(ref self, actions: Span<ServerAction>, screening: Option<ScreeningAttestation>);

struct WithdrawInput { to_addr, token, amount: u128, random }
struct InvokeExternalInput { contract_address, calldata: Span<felt252> }
// phases: 0 SetViewingKey, 1 OpenChannel, 2 OpenSubchannel, 3 Deposit, 4 UseNote,
//         5 CreateEncNote | CreateOpenNote, 6 Withdraw, 7 InvokeExternal (max one)
// invariant: every token balance nets to zero (FINAL_BALANCE_MUST_BE_ZERO)
```

Ekubo swap anonymizer, `packages/ekubo_swap_anonymizer/src/ekubo_swap_anonymizer.cairo`:

```cairo
fn privacy_invoke(ref self, router_addr: ContractAddress, token_amount: TokenAmount, pool_key: PoolKey,
                  minimum_received: u256, skip_ahead: u128, note_id: felt252) -> Span<OpenNoteDeposit>;
```

`@scure/starknet`:

```ts
grindKey(seed: Hex): string        // SHA-256 counter loop, rejection sampling, mod curve order
ethSigToPrivate(signature: string) // grinds r of a 65-byte Ethereum signature
getStarkKey(privateKey: Hex)       // x-coordinate of the public key
```

## Appendix B: references

- https://github.com/starkware-libs/starknet-privacy (README, `packages/privacy`, `packages/ekubo_swap_anonymizer`, `sdk/README.md`, `proof-interceptor/README.md`)
- https://github.com/starknet-io/starkgate-contracts (`src/solidity/StarknetTokenBridge.sol`, `StarknetEthBridge.sol`, `packages/bridge/src`)
- https://docs.starknet.io/learn/protocol/starkgate and https://docs.starknet.io/learn/cheatsheets/starkgate-reference/
- https://github.com/paulmillr/scure-starknet
