# Starknet CCTP exit anonymizer

`CctpExitAnonymizer` is called only by the configured privacy pool. In one pool transaction it:

1. receives USDC from the pool withdrawal action;
2. reads its complete USDC balance;
3. approves Circle's Starknet `TokenMessengerMinterV2`;
4. burns the balance to a per-flow Ethereum settlement contract with CCTP V2 hook data; and
5. returns no open-note deposits.

Constructor order:

```text
privacy_pool, starknet_usdc, cctp_token_messenger_minter_v2
```

The client supplies the CCTP maximum fee, finality threshold and forwarding hook inside the signed
private invocation. The contract restricts finality to Circle's fast/finalized thresholds and
requires the maximum fee to be positive and lower than the balance.
