# Mainnet end-to-end canary

This runner exercises the deployed backend and the complete real-funds route. It is intentionally
not part of the normal test suite. It uses the production API for configuration, quotes, flow
capabilities, Circle messages, Starknet RPC, AVNU sponsorship, Starkscan proofs, settlement
creation, and final settlement.

The Ethereum signer is loaded from a dedicated encrypted Foundry keystore. The private key is
captured in the process and is never printed, passed on the command line, or written to the
recovery journal. Do not reuse a treasury, deployer, or relayer account.

Create the dedicated account interactively:

```bash
cast wallet new ~/.foundry/keystores/ethereum-cctp-strk20-canary
cast wallet address --account ethereum-cctp-strk20-canary
```

Fund only the intended canary input plus gas. The runner hard-caps a single input at `0.01 ETH`,
`25 USDC`, or `0.0005 WBTC` and requires input and output to match. It rejects a quote whose
worst-case output exceeds the configured loss ceiling.

First prepare a flow and run all non-transaction checks:

```bash
npm run canary:mainnet -- \
  --mainnet \
  --preflight-only \
  --account ethereum-cctp-strk20-canary \
  --input ETH \
  --output ETH \
  --amount 0.005 \
  --delay 5
```

The command prints an encrypted journal path. After reviewing the preflight result, execute or
resume the same flow:

```bash
npm run canary:mainnet -- \
  --mainnet \
  --account ethereum-cctp-strk20-canary \
  --resume .canary/<journal>.json.enc
```

The process must stay running. The encrypted journal is updated around every cross-chain phase
and can only be decrypted by the same Ethereum private key. Do not delete it until the run is
complete. A failure deliberately does not mark the backend flow terminal so an operator can
inspect and resume it.

By default, user-signed Ethereum transactions use the project's public Alchemy mainnet endpoint.
Set `CANARY_ETHEREUM_RPC_URL` to another trusted mainnet endpoint if needed. The deployed backend
URL can be overridden with `--api`, but it must use HTTPS and still report a ready mainnet config.
