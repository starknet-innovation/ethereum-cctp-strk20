# Ethereum Privacy Round Trip POC

Mainnet-only proof of concept for an Ethereum-facing privacy round trip:

```text
ETH / USDC / WBTC on Ethereum
  -> optional Uniswap V3 swap to USDC
  -> Circle CCTP V2 to a browser-generated Starknet account
  -> Starknet privacy pool
  -> user-selected minimum delay
  -> private withdrawal into a CCTP exit anonymizer
  -> Circle CCTP V2 to a per-flow Ethereum settlement contract deployed at exit time
  -> optional USDC swap to ETH / WBTC
  -> recipient chosen before the first transaction, disclosed to the relayer only after the delay
```

This repository is a POC, not audited production software. Mainnet assets have real value. The web
app fails closed until every deployment address and required upstream is configured.

## Interaction budget

- ETH input: one Rabby transaction prompt.
- USDC or WBTC input: one ERC-20 approval prompt when needed, then one entry transaction prompt.
- No wallet prompt occurs after the entry transaction.

The browser generates the Stark account key and pool secret in memory. **Closing or reloading the
tab while a transfer is active destroys those secrets and can make the funds unrecoverable.** This
tradeoff is specific to the one/two-prompt POC. A production version needs recoverable key derivation
or a separately reviewed scoped delegation design.

## Workspace

| Path | Responsibility |
| --- | --- |
| `apps/web` | Rabby connection, route form, ephemeral secrets, transaction submission, privacy flow and status UI |
| `apps/api` | Mainnet quotes, Circle access, Starkscan proof jobs, allow-listed provider proxying, public flow state |
| `packages/shared` | Mainnet constants, wire types, validation and lifecycle state machine |
| `contracts/evm` | Entry router and immutable per-flow exit settlement contract |
| `contracts/starknet` | Pool-only CCTP exit anonymizer |
| `docs/ARCHITECTURE.md` | Trust boundaries, sequencing, failure handling and deployment gates |

## Local development

Requirements: Node.js 24+, npm, Foundry, Scarb 2.17+.

```bash
npm install
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env.local
npm run dev
```

The default configuration is mainnet-only but intentionally has no deployed POC contract
addresses. The UI remains read-only until those addresses are supplied.

## Verification

```bash
npm run check
forge test --root contracts/evm
scarb build --manifest-path contracts/starknet/Scarb.toml
```

### Mainnet end-to-end suite

The unit tests above use mocks. The `e2e/` workspace and `contracts/evm/test/fork/` run against
mainnet itself: read-only dependency checks, the API against live Uniswap and Circle, and the whole
Ethereum leg on an anvil fork through the real API relayer routes and browser wallet code.

```bash
cp e2e/.env.example e2e/.env   # at least ETHEREUM_RPC_URL; STARKNET_RPC_URL for Starknet checks
npm run test:fork              # Foundry contracts on a mainnet fork (skips without ETHEREUM_RPC_URL)
npm run test:e2e               # live + anvil fork suites; the real-funds canary stays skipped unless armed
```

See `e2e/README.md` for the layers, the deployment-verification mode, and the gated canary.

Do not deploy or run a real-funds flow until the checklist in `docs/ARCHITECTURE.md` is complete.
