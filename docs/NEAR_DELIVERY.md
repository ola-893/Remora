# NEAR discovery and protected decision delivery

Remora lets useful decisions from one agent benefit others. The shared directory helps followers find those decisions; a paid session authorizes delivery; each follower retains its own inference, budgets and execution rules.

## Components

- The static Cloudflare frontend reads a NEAR testnet publisher registry. It needs no Railway backend or private browser API key.
- The registry stores publisher ID, feed origin, public signing key, owner, last heartbeat and publication status. It contains no action journal.
- The leader runner uses a restricted NEAR function-call key for `heartbeat` and `stop`, with a 0.05 test NEAR fee allowance. It cannot transfer owner funds or call another contract. Registration and adding this key require initial browser approvals.
- OutLayer executes the protected feed worker. Public storage contains signed listings and health. Worker storage encrypts action records, publication controls and the delivery signing seed.
- Each paid action request checks the actual finalized NEAR vault and stream, including vault code hash, token, recipient, rate, quote, session signature, expiry and available stream deposit. The worker checks access again immediately before returning a signed page.

The follower verifies the publisher's signature on each action. The publisher's signed listing delegates a separate public key for delivery pages; it does not delegate authority to change the action.

## Configure through the CLI

Keep owner wallet keys in the browser wallet. Use the default browser profile that already contains the wallet. CLI credentials are configured through hidden prompts, without `.env` files.

```sh
agentstream wallet connect --network testnet
agentstream outlayer show
agentstream outlayer key --api-key
agentstream registry show
```

Create an OutLayer testnet payment key restricted to the project printed by `outlayer show`. The client requests at most 2,000 micro-USDC (0.002 test USDC.e) per call; configure the key's per-call cap accordingly. Compute charges are separate from the USDC stream paid to a leader. OutLayer testnet compute uses `usdc.fakes.testnet`; Remora subscription vaults use the Circle test token. These balances are not interchangeable.

```sh
agentstream publish set --delivery outlayer --activities portfolio-rebalance \
  --rate 0.000001 --recipient YOUR_ACCOUNT.testnet --public-history
agentstream publish start
agentstream agent run
```

Configure and enable the selected activity before publishing. Review the initial registration and restricted-key requests in the browser wallet. Subsequent heartbeats do not require owner approval. Stopping the runner stops advertising; abrupt process or network failure expires registry liveness within 120 seconds. Explore refreshes the directory every 15 seconds.

Followers can resolve the full ID copied from Explore:

```sh
agentstream discover --activity portfolio-rebalance
agentstream copy ap_REPLACE_WITH_FULL_PUBLISHER_ID
```

The usual payment limits, funded subscription vault, enabled activity and execution controls remain required before `copy start`. A follower that requests OutLayer-protected pages also needs its own configured compute key. The public website needs none.

## What is public

Discovery exposes the publisher identity, activity, price, payment recipient, execution mode and liveness. Optional history contains daily counts delayed at least 24 hours. Optional performance contains delayed, publisher-reported daily values. New listings omit transaction hashes, exact action timestamps, assets, sizes and order instructions. Recorded demo pages and repository evidence remain public historical evidence.

## What this does not make private

Native Rhea/Ref swaps, staking, lending, liquidity and order transactions are public on NEAR. Observers can follow their accounts directly. Protecting Remora's feed does not hide those transactions or prevent independent chain indexing. Payment buys authenticated delivery and integration, not exclusive knowledge of a public settlement.

The `confidential` adapter option is only a request for supported spot execution; a missing confirmation cannot be treated as private execution. It does not make all six activities confidential.

This integration pins the worker build and verifies delegated page signatures. It does not yet perform client-side hardware-attestation verification or application-level end-to-end encryption to the enclave. HTTPS requests pass through OutLayer's API gateway. Do not claim that the gateway cannot observe request/response plaintext. An authorized subscriber can also retain or redistribute data it receives.

Before claiming private execution, a future adapter needs a verifiable confidential settlement path with a defined threat model. Delayed website statistics and encrypted feed storage alone do not provide that.

## Deployment and verification

The shared registry address is recorded in [CLI configuration](../packages/cli/src/registry-network.json) and [frontend configuration](../vite-project/public/registry.json). The deployed OutLayer project and pinned worker hash are in [outlayer-network.json](../near/lib/outlayer-network.json). The frontend also serves the public worker binary; execution and encrypted storage run on OutLayer.

```sh
npm run build:near
node scripts/build-distribution.mjs --runtime-only
node --test near/test/registry.test.mjs
node --test packages/test/outlayer.test.mjs
cargo test --manifest-path near/outlayer-feed/Cargo.toml --locked
npm --prefix vite-project test
npm run build:web
```

Registry tests use a real local NEAR sandbox. Worker session tests use a session generated by the JavaScript signing protocol and reject closed, exhausted, mismatched and forged sessions. Those automated tests do not substitute for a live OutLayer paid-stream test.
