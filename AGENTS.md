# Agent guide

This file is the operational entry point for coding agents. Read `README.md` for the product
overview and `docs/ARCHITECTURE.md` before changing a trust boundary, transaction sequence,
deployment gate, or recovery behavior.

## Safety boundary

This is unaudited, mainnet-only software that can move real assets.

- Do not deploy contracts, submit transactions, run `canary:mainnet`, or enable the relayer unless
  the user explicitly asks. Normal development and tests are transaction-free.
- Never print, commit, or move secrets into `VITE_*` variables. Browser configuration is public;
  RPC, Starkscan, paymaster, relayer, cache, and flow-token credentials are server-only.
- Preserve the privacy split: the API must never receive the Stark private key. The final recipient
  and settlement address may transit only the deliberately stateless exit routes after the delay;
  they and exit-side transaction hashes must never be persisted with or joined to entry-side flow
  state. See `docs/ARCHITECTURE.md` for the exact allowed state.
- Keep the application mainnet-only and fail-closed. Do not add testnet fallbacks, placeholder
  deployment addresses, or permissive validation to make a flow appear ready.
- Treat `vendor/starkware-libs-starknet-privacy-sdk-0.14.3-rc.6.tgz` as pinned source provenance.
  Replace it only as part of an explicit, reviewed SDK upgrade.

## First run

Requirements are Node.js 24, npm, Foundry (`forge`), and Scarb 2.17 or newer. JavaScript-only work
does not require Foundry or Scarb.

```bash
bash scripts/doctor.sh
npm run setup
```

`setup` runs the lockfile-exact `npm ci` and creates untracked local environment files from the
examples only when they do not already exist. Blank values are sufficient for unit tests and the
read-only local UI. Never overwrite an existing environment file.

If setup is inappropriate for the current environment, the equivalent manual commands are:

```bash
npm ci
test -e apps/api/.env || cp apps/api/.env.example apps/api/.env
test -e apps/web/.env.local || cp apps/web/.env.example apps/web/.env.local
```

## Repository map

| Path | Owns | Notes |
| --- | --- | --- |
| `packages/shared` | Wire types, validation, lifecycle, chain constants | Build before dependent workspace checks |
| `apps/api` | Fastify API, provider proxies, relayer guards, capability state | Secrets and entry-side state only |
| `apps/web` | React UI, Rabby flow, ephemeral keys, recovery | Recipient and exit-side state stay in the tab |
| `apps/canary` | Explicit real-mainnet operator runner | Never part of routine verification |
| `contracts/evm` | Entry router and exit settlement contracts | Foundry project rooted here |
| `contracts/starknet` | Pool-only CCTP exit anonymizer | Scarb project rooted here |
| `deployments` | Public address and provenance records | Must stay aligned with shared constants and env gates |
| `infra/aws` | Production backend and IAM infrastructure | Account- and region-specific; deploy only explicitly |

Tests live beside TypeScript source as `*.test.ts` / `*.test.tsx`; Foundry tests live in
`contracts/evm/test`.

## Commands

Use the narrowest relevant command while iterating, then run the required completion check.

```bash
# Start API and web app together
npm run dev

# One TypeScript workspace
npm test --workspace @privacy-round-trip/shared
npm test --workspace @privacy-round-trip/api
npm test --workspace @privacy-round-trip/web
npm test --workspace @privacy-round-trip/canary

# All TypeScript workspaces: types, unit tests, production bundles
npm run check

# Contract tests and Cairo build
npm run check:contracts

# Rewrite contract source with the configured formatters
npm run format:contracts

# Everything above (requires Node, Foundry, and Scarb)
npm run check:all
```

For a single Vitest file, build shared first when the test imports it:

```bash
npm run build --workspace @privacy-round-trip/shared
npx vitest run apps/api/src/server.test.ts
```

## Change rules

- Shared schema or lifecycle changes: update producers and consumers in both `apps/api` and
  `apps/web`, add boundary tests, then run `npm run check`.
- API changes: keep all upstream origins allow-listed and credentials server-side. Exercise
  rejected requests as well as the success path.
- Web flow changes: preserve the unload warning, same-tab recovery checkpoints, exact signed-call
  verification, and the rule that there is no wallet prompt after entry.
- EVM changes: add or update Foundry safety tests and run `npm run check:contracts`. Preserve
  permissionless, repeatable settlement so an early dust transfer cannot lock the real mint.
- Cairo changes: keep the pool-only caller check and fee/finality bounds, format and build through
  the contract commands above, and update cross-layer calldata tests when selectors or arguments
  move.
- Deployment changes: update `deployments/*.json`, `packages/shared/src/constants.ts`, relevant
  environment gates, and deployment tests together. Recorded addresses must have real provenance;
  never invent them.
- Infrastructure changes: preserve least privilege, secret indirection, immutable images, guarded
  CloudFormation change sets, budgets, and the emergency relayer switch.

Generated directories (`node_modules`, `dist`, `out`, `target`, `coverage`, `.canary`) are not
source. Do not hand-edit or commit them.

## Completion checklist

1. Keep the change scoped and preserve unrelated worktree changes.
2. Add regression tests for behavior changes, including rejection/failure paths at trust boundaries.
3. Run `npm run check` for TypeScript changes and `npm run check:contracts` for contract changes.
4. Update `README.md`, `docs/ARCHITECTURE.md`, environment examples, or deployment records when an
   operator-visible contract changes.
5. Report any check not run and the exact missing tool or external dependency. Never substitute a
   mainnet call for a local verification step.
