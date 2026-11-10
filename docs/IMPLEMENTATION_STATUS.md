# Implementation status — November 10, 2026

Remora transfers useful decisions between agents under each follower's own controls. It does not promise that public DeFi settlement becomes invisible, or that copying a decision trains the follower's model.

| Gap | Current result | Evidence or remaining limit |
| --- | --- | --- |
| Signals before execution | Implemented and live-tested through encrypted OutLayer delivery | Proposed/released/settled lifecycle; [live checks](evidence/near/privacy-2026-11-10/evidence.json) |
| Cancellation, expiry and replay | Implemented | Signed immutable phases, bounded expiry, fresh nonce/session-bound status, cancellation and duplicate-poll checks |
| Follower inference and veto | Implemented | Review gets the bound proposed action; model remains advisory; an owner veto survives a busy network/state lock |
| Confidential Intents spot execution | Adapter request/settlement handling tested; live confidential settlement unverified | Testing remains testnet-only at the owner's request. No funded supported confidential-swap account was provisioned for this run |
| Native activity privacy | Advance delivery is protected; settlement remains public | Public Rhea/staking/lending/order contracts cannot be privatized by this feed integration |
| Public reporting policy | Implemented | Explicit per-action approval, optional receipt disclosure, whole-day delay, frontend field allowlists |
| Activity performance | Confirmation and execution-quality metrics implemented for all six activities | Full investment-return analytics, realized yield/APY, LP fees/impermanent loss and longitudinal portfolio valuation remain unfinished; counts are not returns |
| Worker trust and encryption | Implemented, deployed and live-verified | Independent TDX verifier, encrypted requests/replies, sealed storage and current secret build lock; [offline proof](evidence/near/privacy-2026-11-10/attestation-proof.json) |
| Operator-independent immutable governance | Not implemented | The secret owner can still change its access condition; a current lock check cannot prove its complete history |
| Regression QA | Passed | 98 CLI/core tests, 30 NEAR sandbox tests, 15 frontend tests, four worker Rust tests; installed-package smoke checks |

The new full delivery rehearsal used signed live NEAR Intents quotes with **paper execution** and a **real NEAR testnet USDC subscription**. It does not establish six new live native settlements or a live confidential swap. Existing native execution receipts and builder/guard regression tests remain separately documented.

The production website showed the QA publisher as Running and then Unavailable after shutdown. The paid stream was closed and the QA runner stopped. No owner wallet private key was imported, and no mainnet funds were used.

For implementation details, see [private signals](PRIVATE_SIGNALS.md), [public evidence](PUBLIC_PERFORMANCE.md), [confidential execution](CONFIDENTIAL_EXECUTION.md), and [privacy boundaries](PRIVACY.md).
