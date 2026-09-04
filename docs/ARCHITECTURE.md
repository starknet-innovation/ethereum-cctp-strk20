# Architecture and deployment gates

## Product boundary

This is a mainnet-only, Ethereum-facing proof of concept. The user interacts with Rabby on
Ethereum, chooses the final Ethereum recipient and a delay, and never needs a Starknet wallet.

```text
Rabby EOA
  │ 1 tx for ETH; approval + tx for USDC/WBTC
  ▼
PrivacyEntryRouter ── optional Uniswap V3 ── CCTP burn (domain 0 → 25)
  │
  ▼
fresh browser-held OZ Starknet account ── sponsored CCTP receive_message
  │
  ▼
Starknet privacy pool ── user-selected delay (5 minutes to 7 days)
  │ private withdraw + privacy_invoke
  ▼
CctpExitAnonymizer ── CCTP burn with forwarding hook (domain 25 → 0)
  │
  ▼
fresh ExitSettlement ── optional Uniswap V3 ── chosen Ethereum recipient
```

The delay begins only when the privacy deposit is confirmed. The browser also waits until the
deposit is at least eleven Starknet blocks behind the head before proving the exit. The effective
delay is therefore `max(user delay, proof readiness)`.

## Frontend/backend split

### Browser (`apps/web`)

- Connects a Rabby EOA and enforces Ethereum chain ID 1.
- Collects input/output token, amount, recipient, and delay.
- Generates an independent random Stark signing key and privacy viewing key in memory.
- Submits the Ethereum approval (if needed) and entry transaction.
- Polls Circle Iris, submits the sponsored Starknet mint, and builds privacy proofs locally.
- Holds the final recipient locally through the entry, bridge, deposit, and delay.
- Requests a recipient-bound settlement only after the privacy delay.
- Independently calls the factory's `predict` view and rejects a relayer response whose address
  does not match the exact recipient, output, slippage floor, fee tier, and recovery time.
- Keeps a `beforeunload` warning installed for the entire active flow.

The browser never sends the Stark private key or privacy viewing key to the API.

### Light API (`apps/api`)

- Returns allow-listed mainnet configuration.
- Quotes direct Uniswap V3 pools and current CCTP V2 fee ceilings.
- Keeps POC flow progress in an in-memory, capability-protected store.
- Proxies only the configured Starknet RPC, prover, discovery, and AVNU paymaster origins, keeping
  provider credentials server-side.
- Proxies Circle attestations.
- Sponsors deterministic settlement creation and the permissionless final `settle()` call.

The settlement endpoint intentionally accepts no flow ID and persists no request. This avoids a
direct database join between the entry record and recipient. The operator can still correlate IP,
request timing, amounts, and chain activity; the POC therefore does not claim backend anonymity.

Before exposing a relayer publicly, put the settlement routes behind an edge-enforced gas budget,
rate limits, and monitoring. The API itself is deliberately lean and does not implement production
abuse controls.

## Prompt budget

| Input | Rabby prompts | Why |
| --- | ---: | --- |
| ETH | 1 | `start` wraps ETH, swaps to USDC, and burns through CCTP atomically |
| USDC | at most 2 | exact-amount ERC-20 approval, then `start` |
| WBTC | at most 2 | exact-amount ERC-20 approval, then swap + CCTP `start` |

Rabby did not expose the EIP-5792 batching needed to combine an ERC-20 approval with the entry call
when this POC was authored. Already-sufficient allowance reduces USDC/WBTC to one prompt. Every
Starknet action is signed by the browser-generated key and submitted through the sponsored
paymaster; settlement transactions are permissionless and relayed by the backend.

## Why the settlement is deployed late

Putting the final recipient in `PrivacyEntryRouter.start`, or predeploying a recipient-bound
contract before entry, would make the public source-to-destination relation trivial. Instead:

1. The entry commits only to a random Starknet account.
2. The recipient remains in browser memory during the private holding period.
3. A random CREATE2 salt is generated after the delay.
4. The relayer deploys `ExitSettlement` with immutable recipient and route parameters.
5. The browser verifies the factory prediction before the private note is spent.
6. The privacy exit names that fresh settlement as its CCTP mint recipient.

Amount and timing correlation still exist. A five-minute delay is a UX minimum, not an anonymity
guarantee; longer randomized delays and common denominations would improve the anonymity set.

## CCTP details

- Ethereum domain: `0`; Starknet domain: `25`.
- Ethereum → Starknet uses ordinary `depositForBurn`. Circle's Forwarding Service does not support
  Starknet as a destination, so the fresh account calls `receive_message` through a sponsored
  deploy-and-invoke after Iris attests the burn.
- Starknet → Ethereum uses `deposit_for_burn_with_hook` and Circle's static 32-byte
  `cctp-forward` hook. The settlement address is the CCTP mint recipient.
- Fast-transfer finality threshold is `1000`; all max fees come from Circle's live fee endpoint.

Pinned mainnet dependencies:

| Contract | Address |
| --- | --- |
| Ethereum USDC | `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` |
| Ethereum TokenMessenger V2 | `0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d` |
| Ethereum MessageTransmitter V2 | `0x81D40F21F12A8F0E3252Bccb954D722d4c464B64` |
| Starknet USDC | `0x033068F6539f8e6e6b131e6B2B814e6c34A5224bC66947c47DaB9dFeE93b35fb` |
| Starknet TokenMessengerMinter V2 | `0x07d421B9cA8aA32DF259965cDA8ACb93F7599F69209A41872AE84638B2A20F2a` |
| Starknet MessageTransmitter V2 | `0x02EBB5777B6dD8B26ea11D68Fdf1D2c85cD2099335328Be845a28c77A8AEf183` |
| Starknet privacy pool | `0x040337b1af3c663e86e333bab5a4b28da8d4652a15a69beee2b677776ffe812a` |

Primary references: [Circle domains](https://developers.circle.com/cctp/concepts/supported-chains-and-domains),
[contract addresses](https://developers.circle.com/cctp/references/contract-addresses),
[Starknet contracts](https://developers.circle.com/cctp/references/starknet-contracts), and
[Forwarding Service transfer guide](https://developers.circle.com/cctp/howtos/transfer-usdc-with-forwarding-service).

## Contract responsibilities

`PrivacyEntryRouter` accepts only ETH, USDC, or WBTC. It uses exact-amount transfers and direct
Uniswap V3 `exactInputSingle`, enforces a user-visible minimum USDC result, then approves and burns
the whole USDC result through CCTP. The final Ethereum recipient is not an entry parameter.

`CctpExitAnonymizer` can only be invoked by the configured privacy pool. It burns its full USDC
balance to the supplied 256-bit Ethereum settlement recipient, validates the finality bucket and
fee bound, and uses Circle's forwarding hook.

`ExitSettlement` has immutable recipient, output asset, Uniswap pool fee, minimum output, and
recovery time. Anyone may call `settle()`. If a delayed swap cannot meet the fixed slippage floor,
the recipient can receive USDC through `recoverAsUsdc()` after the one-hour recovery window.

## POC failure and recovery model

- Before the Ethereum entry transaction: no funds moved; retry normally.
- After entry but before shielding: the USDC belongs to the browser-generated Stark account.
- After shielding: only the in-memory viewing/signing material can build the private exit.
- After the private exit: CCTP replay protection and the immutable settlement protect the payout.
- After CCTP mint but before settlement: `settle()` is permissionless; after the recovery time,
  `recoverAsUsdc()` bypasses a stale swap quote.

The current UI preserves secrets after an error but has no reload-resume path. Closing or reloading
an incomplete flow can permanently strand assets. A production design must replace random
memory-only keys with audited recoverable derivation or a tightly scoped, revocable delegation.

## Provenance

The implementation uses the Starkware privacy SDK built from `starkware-libs/starknet-privacy` commit
`bc75e4bac71ad0ce10c6e63effc33b5b25131a4f`. The exact SDK package is vendored under `vendor/` so
the private proof API cannot silently drift.

## Mainnet deployment gates

Do not open the route button until all of these are complete:

1. Audit the Solidity and Cairo contracts, including token edge cases and CCTP fee behavior.
2. Deploy `PrivacyEntryRouter`, `ExitSettlementFactory`, and `CctpExitAnonymizer` with the pinned
   mainnet addresses; verify source and constructor arguments on explorers.
3. Confirm the deployed privacy-pool class hash is compatible with the vendored SDK.
4. Configure funded, capped relayer and AVNU sponsor policies; never use an unrestricted treasury
   key.
5. Put prover, discovery, RPC, and paymaster credentials behind the API proxy.
6. Add edge rate limits, per-day gas budgets, alarms, and an emergency relayer shutdown.
7. Run a forked end-to-end test, then a deliberately tiny mainnet canary for every token pair.
8. Add durable state and an audited recovery design before calling the product resumable.

The `/v1/health/ready` endpoint fails closed and the UI displays the exact missing deployment
configuration until these runtime values are supplied.
