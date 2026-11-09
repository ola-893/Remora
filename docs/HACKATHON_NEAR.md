# Remora for the NEAR hackathon

## Submission description

Smart agents decide, cheap agents do, and the limits aren't up to the model.

Smart models are too expensive to run for every follower, and cheaper models can make costly mistakes when they control funds. Today, the same agent is expected to reason and hold the authority to act on that reasoning.

Remora separates those jobs. One leader publishes signed moves to a gated feed. Followers pay for access by the second through a NEAR USDC stream and mirror eligible moves on their own accounts. An optional follower model reviews actions while the CLI enforces the operator's limits.

The stream is the subscription. Its on-chain state controls access to the feed. The follower's deterministic guards decide which moves can run.

In a recorded test, a follower with no model mirrored 14 paper fills from live signed NEAR Intents quotes on one testnet stream. A stale preview was denied. Closing the stream changed the feed response from 200 to 403, and the next leader fill went uncopied. A separate testnet Rhea rebalance used one Meteor funding approval and an isolated execution account.

Remora uses NEAR smart contracts, test USDC, browser wallet signing and NEAR Intents 1Click quotes. Leaders can use local inference or NEAR AI.

## Inspiration

The remora fish follows a shark. That relationship is the model for sharing expensive reasoning across followers that each keep their own authority to act.

## What judges can check

- [Demo commands and expected results](NEAR_DEMO.md)
- [Hour-long recording](evidence/copy-trading/hour-2026-11-07/evidence.json) and [archived follower inference check](evidence/copy-trading/hour-2026-11-07/follower-inference-check.json)
- [Rhea grant-signed execution and recovery](evidence/near/remora-execution-grant.json)
- [Live limit-order placements, cancellations and paid follower queue](evidence/near/remora-limit-orders.json)

The recorded leader used local Gemma. NEAR AI is an available provider, and the copy demo has no hosted-model or independently verified attestation result. The paid limit-order QA used two CLI profiles on the same testnet wallet. The follower's two wallet requests expired, so the receipts demonstrate live leader execution, a paid queue and stream closure.

## Source and baseline

The source export script records `a52becad8121de9d3caa9e9a4400fd1e0e5999ef` as the inherited baseline. The public checkout starts with the NEAR workspace and includes the vault, CLI, copy feed and Remora frontend. [Source export script](../scripts/prepare-submission.mjs#L10)
