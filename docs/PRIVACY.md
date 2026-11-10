# Privacy and trust boundaries

The protected product is advance access to signed decisions, not an exclusive view of public blockchain settlements. One agent's work can benefit many subscribers, each with their own controls and limited inference.

## Protected delivery

1. The leader signs a proposal before executing. It waits through the configured first-look window, obtains fresh execution checks, and delivers a signed release before submission.
2. The client retrieves an attested transport public key for the pinned worker build. It uses RFC 9180 HPKE (P-256, HKDF-SHA256, AES-256-GCM) to encrypt protected requests. The worker encrypts each response to a fresh client reply key and binds it to the request nonce.
3. Every paid call is verified with the independent `outlayer-verify` CLI: Intel TDX authenticity, approved worker identity, execution binding, exact input and exact output must all pass. The caller, project and worker hash must match. Missing or unproven evidence fails closed. A delayed attestation lookup can be retried for the same call; a paid POST is never retried by this verifier.
4. Inside the enclave, the worker checks the finalized NEAR vault and active stream before returning decisions. Closing the stream denies further reads. A follower checks a fresh signed release status again before submission.
5. Private storage is application-sealed with AES-256-GCM and authenticated record names. Another version sharing the storage namespace cannot read those records without the protected master. The master is generated inside the keystore and reaches only runs admitted by its build restriction. No owner wallet key is requested or imported.

The implementation uses separate maintained HPKE libraries in JavaScript and Rust. Interoperability tests exercise both directions, expiry, tampering and reply substitution. Worker tests reject the wrong storage key, wrong record name, tampered ciphertext and legacy unsealed records.

## What remains observable

The gateway sees the compute payment credential, caller/project, encrypted payload sizes, request timing and traffic volume. Public listings expose agent identity, activity, price, recipient, execution mode and liveness. Approved evidence is deliberately public after its delay.

Direct native NEAR execution is public. Encrypting a feed cannot hide Rhea swaps, staking, lending, liquidity or limit-order transactions. Supported confidential spot execution is a separate adapter capability and needs separate live verification. See [execution coverage](CONFIDENTIAL_EXECUTION.md).

## What the project owner can still change

The secret is currently owned by `rudepuma4060.testnet` and its condition names one exact worker build. The CLI checks this condition before bootstrapping a transport key. Publishing a different project version does not itself grant that build access to the master.

However, the secret owner can change that policy. A current view cannot prove that the owner never temporarily admitted a malicious build and then restored the lock. Compromise of the master can expose retained sealed records and old request ciphertext; this design does not promise forward secrecy for stored data. A fully immutable operator-independent policy would require a separate governance or ownership design. The project owner can also stop service or remove storage. Encryption does not guarantee availability or an append-only public audit trail.

Authorized subscribers can retain and redistribute decisions. No software delivery mechanism can retract plaintext already received. Cancellation stops unreleased proposals; it cannot undo an already submitted follower transaction. The local host also remains trusted for follower keys, veto commands and deterministic execution guards.

## Upgrading

Stop active copies before upgrading a protocol version and keep the old stream closure receipt. The project owner deploys the worker, reviews its hash, and stores or moves the protected secret restriction to that exact build. Update the CLI pin only after deployment and verification.

Run `publish start` again so the publisher refreshes its delivery key. On the first transition from legacy storage, a changed delivery key marks old journal pointers for re-upload into sealed storage, preserving sequence continuity. The new worker never falls back to legacy unsealed private records. Previously exposed legacy traffic cannot be made private retroactively.

The CLI requires the official `outlayer-verify` executable; installation is documented in [NEAR delivery](NEAR_DELIVERY.md). A missing verifier prevents a paid call. Its reports are kept in private temporary files and deleted after verification. A minimal last-verification record is saved locally without feed data or compute credentials.

Primary references: [OutLayer verification](https://app.outlayer.ai/docs/trust-verification), [OutLayer build-restricted secrets](https://app.outlayer.ai/docs/secrets), [HPKE specification](https://www.rfc-editor.org/rfc/rfc9180.html).
