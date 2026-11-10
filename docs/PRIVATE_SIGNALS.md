# Decisions before public execution

Useful decisions can reach subscribers before their settlements become visible on NEAR. A publishing leader now journals a signed proposal before execution, waits through a private first-look window, obtains a fresh preview, then releases the same immutable decision before submitting it. The follower uses its own account, sizing, advisory inference and deterministic guards.

This is a protocol change. The updated CLI and updated OutLayer worker must be deployed together before using it remotely. Old settlement records remain readable. An older CLI must be upgraded to consume the new signal records.

## Lifecycle

`proposed → released → settled | failed | uncertain`

`proposed → cancelled`

`uncertain → settled | failed` through reconciliation only.

The publisher chooses `--signal-window 15` through `60` seconds with `publish set`; the default is 30 seconds. Each signal expires 120 seconds after its creation. Changing phase does not extend its lifetime. Each phase has its own signed journal ID; the action hash and logical signal ID stay fixed.

A publishing leader must receive delivery acknowledgement before leaving either the proposal or release step. Native strategies preview before proposing and recheck the execution plan and policy before releasing. Spot strategies fetch another quote after the window and reject an adverse price movement before release. Publication failure prevents execution. An uncertain submitted transaction prevents a new proposal until its outcome is reconciled.

A subscriber may inspect and review the proposal during its own veto window. Merely receiving a proposal never authorizes a transaction. Before submission the follower fetches a new paid, signed status proof bound to its session and a fresh random nonce. A cancelled, failed, uncertain, expired, stale or conflicting signal fails closed. Both the subscription and the follower's execution guards must still pass. Delivery status does not replace those guards.

A release permits independent execution; it does not guarantee that the leader settles successfully. Cancellation is possible **only before release**. After release, a failed leader cannot undo a follower transaction already submitted. Settlement updates never reopen an expired action or cause another execution.

## Inspect, cancel and recover

```sh
agentstream signal list
agentstream signal show SIGNAL_ID
agentstream signal cancel SIGNAL_ID
```

Cancel in a second shell while the leader is waiting. The first shell exits without executing the proposal. A cancelled signal remains in the private journal, and followers discard its queued candidate.

For an uncertain native transaction, inspect the transaction and reconcile its exact saved plan:

```sh
agentstream signal reconcile SIGNAL_ID --hash TRANSACTION_HASH
```

For a spot swap with a known correlation ID:

```sh
agentstream reconcile
```

Neither reconciliation command resubmits a swap. A missing correlation ID or unknown native receipt requires investigation; do not clear the state to force another execution.

## Public information and privacy

Only subscribers receive proposals and lifecycle updates. Public listings may advertise the window duration, but contain no proposal action, hash or expiry. The website displays delayed summaries rather than this private journal.

The advance window protects access to a decision **before** public execution. Direct NEAR swaps, staking, liquidity, lending and limit-order transactions remain publicly observable after submission. A subscriber can also retain or redistribute information it legitimately receives. See [delivery trust boundaries](NEAR_DELIVERY.md).

## Tests and evidence

`node --test packages/test/signals.test.mjs` covers immutable action bindings, expiry, cancellation, phase conflicts, fresh signed status proofs, nonce/session replay, and the actual leader spot runtime. Its protocol service fixture verifies proposal and release ordering, cancellation, price movement, refunds and uncertain-outcome reconciliation without executing a real swap. Worker Rust tests cover matching lifecycle and session checks. These tests are not evidence of a live confidential settlement.
