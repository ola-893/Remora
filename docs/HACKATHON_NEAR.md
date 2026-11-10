# Remora for the NEAR hackathon

## Submission description

Useful work by one agent can benefit other agents.

An agent can do useful work and reach a decision that would benefit other agents. Those agents need a way to reuse the decision in their own circumstances, with their own budgets and permissions.

Remora lets agents publish signed decisions and earn from their work. Followers pay by the second through NEAR USDC streams and turn eligible decisions into actions on their own accounts. The NEAR vault enforces payment limits, and the CLI enforces each follower's execution rules.

Today Remora transfers the results of reasoning as signed action records. Followers can reuse decisions with limited inference, using a model for advisory review. Useful learning transfer, where agents learn from one another's work, is the longer-term ambition.

In a recorded test, a follower reused 14 decisions as paper fills priced by live signed NEAR Intents quotes on one testnet USDC stream. The CLI denied a stale preview, and closing the stream changed the feed response from HTTP 200 to 403. In a separate live testnet Rhea rehearsal, the owner vetoed one candidate. The follower's local model reviewed a later candidate, and the follower executed it at half the leader's size.

Remora uses NEAR smart contracts, test USDC, browser wallet signing and NEAR Intents 1Click quotes. Leaders can use local inference or NEAR AI.

## Inspiration

The remora fish rides alongside a shark and benefits from its movement. In Remora, a leader's work becomes useful to followers that each keep their own authority to act.

## What judges can check

- [Demo commands and expected results](NEAR_DEMO.md)
- [Hour-long recording](evidence/copy-trading/hour-2026-11-07/evidence.json) and [archived follower inference check](evidence/copy-trading/hour-2026-11-07/follower-inference-check.json)
- [Rhea grant-signed execution and recovery](evidence/near/remora-execution-grant.json)
- [Live follower sizing, veto and execution](evidence/near/remora-veto-testnet-2026-11-09.json)
- [Live limit-order placements, cancellations and paid follower queue](evidence/near/remora-limit-orders.json)

The recorded leader used local Gemma. NEAR AI is an available provider, and the copy demo has no hosted-model or independently verified model-response attestation result. OutLayer delivery attestation is a separate capability, verified in the [encrypted-feed QA](evidence/near/privacy-2026-11-10/evidence.json). The paid limit-order QA used two CLI profiles on the same testnet wallet. The follower's two wallet requests expired, so the receipts demonstrate live leader execution, a paid queue and stream closure.

## Source and baseline

The source export script records `a52becad8121de9d3caa9e9a4400fd1e0e5999ef` as the inherited baseline. The public checkout starts with the NEAR workspace and includes the vault, CLI, copy feed and Remora frontend. [Source export script](../scripts/prepare-submission.mjs#L10)
