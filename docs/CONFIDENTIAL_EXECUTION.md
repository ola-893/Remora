# Confidential execution coverage

Remora protects advance decisions and their paid delivery. This does not make every supported DeFi venue confidential.

| Path | Execution visibility | Current verification |
| --- | --- | --- |
| NEAR Intents through Agent Connect with `--confidential` | Confidential execution requested from the provider | Request/response contract tests; settlement must explicitly confirm confidentiality |
| NEAR Intents paper quotes | Virtual execution | Signed quote verification; no confidential settlement occurs |
| Direct Rhea portfolio rebalance | Public NEAR transactions | Existing testnet settlement evidence |
| Staking moves | Public NEAR transactions | Existing testnet settlement evidence |
| Concentrated liquidity | Public NEAR transactions | Existing testnet settlement evidence |
| Lending/yield reallocation | Public NEAR transactions | Existing testnet settlement evidence |
| Rhea limit orders | Public NEAR transactions | Existing testnet settlement evidence |

For Agent Connect, enable the supported flag when configuring the task:

```sh
agentstream task enable spot-trading --intents-agent-id YOUR_PROVISIONED_AGENT --live --confidential
```

This adapter uses Agent Connect's boolean `confidential` field, not the separate 1Click API's confidentiality enum. It forwards the request for both dry quotes and live execution, and requires `details.confidential === true` on success. A missing or false confirmation leaves execution unreconciled; it is never silently treated as a private swap. Settlement checks still bind the agent, correlation ID, requested assets, size and minimum output.

The adapter distinguishes **provider-confirmed** confidentiality from **independently verified** confidentiality. Its current response sets independent verification to false. A receipt or an API response saying confidential is not an end-to-end proof of what external observers can learn.

A funded, authorized Agent Connect account on a supported network is required for a live confidential-swap test. The encrypted-feed QA uses paper quotes and a real testnet payment stream; it does not substitute for that test. No mainnet confidential swap is claimed in this release.

## Why the other activities remain public

A private feed, browser wallet, execution grant or confidential swap flag cannot hide a direct call to a public staking, lending, liquidity or order contract. Those paths would need suitable confidential venues or new confidential adapters. Advertising them as private would mislead subscribers.

The paid advantage on these paths is advance access to signed decisions before the leader submits them, plus automated translation into the follower's own circumstances and controls. Once a public transaction is submitted, another agent can independently index it. Authorized subscribers can also retain or redistribute decisions.

Primary API references: [Agent Connect OpenAPI](https://api.agentsonintents.com/openapi.json), [NEAR Intents confidential swaps](https://docs.near-intents.org/integration/distribution-channels/1click-api/quickstart/confidential-swaps).
