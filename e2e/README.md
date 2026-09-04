# Mainnet end-to-end suite

This workspace holds the integration tests that run against Ethereum and Starknet **mainnet**.
There is no testnet deployment of this POC, so every layer here targets real mainnet state:
either read-only, or on an anvil fork where transactions are free, or (gated) with real funds.

```bash
cp e2e/.env.example e2e/.env   # fill in at least ETHEREUM_RPC_URL
npm run test:fork              # Foundry: contracts against a mainnet fork
npm run test:e2e               # vitest: live checks + anvil-forked round trip (+ canary if armed)
```

Requirements: Node 24, Foundry (`forge` and `anvil`), a mainnet Ethereum JSON-RPC endpoint and,
for the Starknet checks, a Starknet mainnet JSON-RPC endpoint serving spec 0.9 or 0.10.

## Layers

| Layer | Location | Moves funds | What it proves |
| --- | --- | --- | --- |
| Foundry fork | `contracts/evm/test/fork/` | No (fork) | `PrivacyEntryRouter`, `ExitSettlementFactory` and `ExitSettlement` against the real Uniswap V3 router, real USDC/WBTC/WETH and the real Circle CCTP V2 contracts: swaps, burns, decoded CCTP V2 messages, settlement payouts in ETH/USDC/WBTC, slippage floor, recovery window, replay and value checks. |
| Live dependencies | `src/mainnet/*-dependencies.test.ts`, `circle-iris.test.ts` | No | Every address and constant pinned in `@privacy-round-trip/shared` is what the code assumes: decimals, CCTP domains, cross-chain TokenMessenger registrations on **both** chains, the Cairo ABIs the browser and `CctpExitAnonymizer` call, the privacy pool and OpenZeppelin account class, Circle's fast-transfer fee rows. |
| Live services | `src/mainnet/quote-service.test.ts`, `api-live.test.ts` | No | The API's quote math over all nine token pairs with live Uniswap and Circle fees, flow lifecycle, Circle and Starknet proxies, fail-closed relayer routes. |
| Anvil fork round trip | `src/fork/evm-round-trip.test.ts` | No (fork) | The complete Ethereum leg as production runs it: contracts deployed from Foundry artifacts, the real API (quotes, flows, settlement relayer routes with a node-managed relayer account), and the real browser wallet code from `apps/web` driven through a headless EIP-1193 shim. ETH, USDC and WBTC entries; ETH, USDC and WBTC settlements; recovery path. |
| Deployment verification | `src/mainnet/deployment.test.ts`, `remote-api.test.ts` | No | When `ETHEREUM_ENTRY_ROUTER`, `ETHEREUM_EXIT_SETTLEMENT_FACTORY`, `STARKNET_CCTP_EXIT_ANONYMIZER` or `E2E_API_URL` are set: deployed immutables match the pinned constants, the factory embeds the `ExitSettlement` creation code compiled from this tree, the anonymizer routes through the pinned pool, the deployed API publishes the same values. |
| Canary | `src/canary/mainnet-canary.test.ts` | **Yes** | Deployment gate 7: the full route including the Starknet privacy leg, using the same `apps/web` modules the browser runs, against a ready API. |

Tests whose configuration is missing are reported as skipped. The preflight test fails when no RPC
URL is configured at all, unless `E2E_ALLOW_EMPTY=1` acknowledges an all-skipped run.

## What is not covered on a fork

The Starknet privacy leg (sponsored mint, pool deposit, delay, private exit) depends on the live
prover, discovery service and AVNU paymaster. It cannot be forked; only the read-only dependency
checks and the canary exercise it. On the anvil fork the return CCTP mint is simulated by
transferring USDC to the settlement contract.

## Canary

The canary spends real mainnet funds and is refused unless `E2E_MAINNET_CANARY` equals the arming
sentinel in `src/support/env.ts`. It also needs `E2E_API_URL` (a **ready** API), `E2E_RECIPIENT`
(distinct from the canary wallet) and `E2E_ETHEREUM_PRIVATE_KEY` for a dedicated, capped canary
wallet. It refuses to start when the quoted bridge amount exceeds `E2E_MAX_BRIDGE_USDC`.

Expect the run to last at least `E2E_DELAY_MINUTES` plus two CCTP attestations and two proofs.
Keep the process alive: like the browser, the ephemeral Starknet key lives only in memory, and a
failure log prints the account address so operators can assess stranded funds. Run one pair at a
time and repeat for each pair listed in the architecture gate.

## CI

`.github/workflows/e2e-mainnet.yml` runs the Foundry, live and anvil layers on manual dispatch
using the `ETHEREUM_RPC_URL` and `STARKNET_RPC_URL` secrets plus optional deployment
variables. The canary is never run in CI.
