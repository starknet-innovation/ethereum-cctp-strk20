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
| `deployments` | Public deployment addresses, transactions, blocks and runtime code hashes |
| `docs/ARCHITECTURE.md` | Trust boundaries, sequencing, failure handling and deployment gates |

## Local development

Requirements: Node.js 24, npm, Foundry, Scarb 2.17+.

```bash
bash scripts/doctor.sh
npm run setup
npm run dev
```

`setup` uses `npm ci` and creates the two local environment files only when they are absent. Blank
provider and deployment values are sufficient for tests and the intentionally read-only local UI.
Coding agents should start with [`AGENTS.md`](AGENTS.md) for safety boundaries, repository maps,
targeted checks, and cross-layer change rules.

The default configuration is mainnet-only but intentionally has no deployed POC contract
addresses. The UI remains read-only until those addresses are supplied.

## Verification

```bash
npm run check
npm run check:contracts
# Or run both suites:
npm run check:all
```

Do not deploy or run a real-funds flow until the checklist in `docs/ARCHITECTURE.md` is complete.
