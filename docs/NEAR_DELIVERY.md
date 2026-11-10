# NEAR discovery and protected decision delivery

Remora lets useful decisions from one agent benefit others. The shared directory helps followers find those decisions; a paid session authorizes delivery; each follower retains its own inference, budgets and execution rules.

## Components

- The static Cloudflare frontend reads a NEAR testnet publisher registry. It needs no Railway backend or private browser API key.
- The registry stores publisher ID, feed origin, public signing key, owner, last heartbeat and publication status. It contains no action journal.
- The leader runner uses a restricted NEAR function-call key for `heartbeat` and `stop`, with a 0.05 test NEAR fee allowance. It cannot transfer owner funds or call another contract. Registration and adding this key require initial browser approvals.
- OutLayer executes the protected feed worker. Public storage contains signed listings and health. The worker application seals action records and publication controls with AES-256-GCM, in addition to OutLayer storage encryption. Its delivery key is derived inside the enclave from a protected secret rather than stored as a readable seed.
- Each paid action request checks the actual finalized NEAR vault and stream, including vault code hash, token, recipient, rate, quote, session signature, expiry and available stream deposit. The worker checks access again immediately before returning a signed page.

The CLI verifies each paid call with the independent OutLayer verifier, checks the pinned binary and onchain secret build restriction, and uses HPKE for feed requests and responses. The follower also verifies the publisher's signature on each action. The publisher's signed listing delegates a separate public key for delivery pages; it does not delegate authority to change the action.

## Configure through the CLI

Keep owner wallet keys in the browser wallet. Use the default browser profile that already contains the wallet. CLI credentials are configured through hidden prompts, without `.env` files.

```sh
cargo install --git https://github.com/out-layer/outlayer-verify \
  --rev 90c27d9d4fc843194ddc6f8ebaafa4eb320c3bb6 --locked outlayer-verify
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

## Decisions before execution

The new signal protocol publishes signed proposals before execution and requires a fresh release check before a follower can submit. See [lifecycle, cancellation and recovery](PRIVATE_SIGNALS.md). Deploy the matching CLI and worker together; rebuilding a local CLI does not update the live worker.

The shared project uses the generated `PROTECTED_FEED_MASTER` in author profile `remora-feed-v1`. Its onchain access condition must be exactly the approved worker hash. The project owner creates this secret in the OutLayer browser UI; subscribers never enter its value. The CLI refuses a missing or broadened restriction before bootstrapping encryption. See [trust boundaries and upgrades](PRIVACY.md).

## What is public

Discovery exposes the publisher identity, activity, price, payment recipient, execution mode and liveness. Optional history contains daily counts delayed at least 24 hours. Optional performance contains delayed, publisher-reported daily values. Separately approved evidence uses an explicit per-action release policy and a full-day privacy delay; [public reporting details](PUBLIC_PERFORMANCE.md). Listings omit exact action timestamps, assets, sizes and order instructions. Transaction hashes are omitted unless the owner explicitly approves a receipt release. Recorded demo pages and repository evidence remain public historical evidence.

## What this does not make private

Native Rhea/Ref swaps, staking, lending, liquidity and order transactions are public on NEAR. Observers can follow their accounts directly. Protecting Remora's feed does not hide those transactions or prevent independent chain indexing. Payment buys authenticated delivery and integration, not exclusive knowledge of a public settlement.

The `confidential` adapter option is only a request for supported spot execution; a missing confirmation cannot be treated as private execution. It does not make all six activities confidential.

The current integration verifies call attestations and encrypts protected payloads to the enclave. The gateway still observes traffic metadata and compute credentials. The secret owner retains the ability to change its access policy; the client checks the current lock but cannot prove it was never broadened in the past. Authorized subscribers can retain or redistribute received data. See the complete [privacy threat model](PRIVACY.md). Existing legacy plaintext transport records are not retroactively protected.

Before claiming private execution, an adapter needs a verifiable confidential settlement path with a defined threat model. See [confidential execution coverage](CONFIDENTIAL_EXECUTION.md). Delayed website statistics and encrypted feed storage alone do not provide that.

## Deployment and verification

The shared registry address is recorded in [CLI configuration](../packages/cli/src/registry-network.json) and [frontend configuration](../vite-project/public/registry.json). The deployed OutLayer project and pinned worker hash are in [outlayer-network.json](../near/lib/outlayer-network.json). The frontend also serves the public worker binary; execution and encrypted storage run on OutLayer.

To rebuild the worker, install Rust's `wasm32-wasip2` target and run `cargo build --manifest-path near/outlayer-feed/Cargo.toml --target wasm32-wasip2 --release --locked`. Compare its SHA-256 with the pinned worker hash. Updating the live worker requires an OutLayer project-version deployment, matching CLI pin and frontend binary update; rebuilding the frontend alone does not deploy new worker code.

```sh
npm run build:near
node scripts/build-distribution.mjs --runtime-only
node --test near/test/registry.test.mjs
node --test packages/test/outlayer.test.mjs
cargo test --manifest-path near/outlayer-feed/Cargo.toml --locked
npm --prefix vite-project test
npm run build:web
```

Registry tests use a real local NEAR sandbox. Worker session tests use a session generated by the JavaScript signing protocol and reject closed, exhausted, mismatched and forged sessions.

The [November 10 live delivery check](evidence/near/remora-near-delivery-2026-11-10.json) verified automatic running/stopped status in production Explore. A real NEAR testnet stream authorized one signed paper action through OutLayer (200); no credential returned 402, a direct public encrypted-record read returned 403, and the same session returned 403 after onchain closure. The action used a signed live NEAR Intents dry-run quote. This verifies protected delivery, not a new live swap or confidential native settlement.

The [encrypted signal QA](evidence/near/privacy-2026-11-10/evidence.json) verifies advance proposal delivery, release-gated copying, cancellation, replay prevention and real stream closure through the new attested encrypted transport. Its [verification bundle](evidence/near/privacy-2026-11-10/attestation-proof.json) contains ciphertext inputs/outputs and can be checked with `outlayer-verify bundle FILE --offline`. This run used paper execution; it does not establish live confidential settlement or investment returns.
