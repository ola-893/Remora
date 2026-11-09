# Remora intro short cut

The final edit opens with “Useful work by one agent can benefit other agents.” It shows how a follower finds a decision, pays for access by the second and acts under its own rules. [Product overview](../../README.md#solution)

The table below describes the checked-in 19.2-second HyperFrames cut. The 28.8-second cut includes the stream-shutoff demonstration. [Repository short cut](../../brand/remora/exports/remora-intro-short.mp4) · [Extended cut](../../brand/remora/exports/remora-intro.mp4)

| Time | Scene |
| --- | --- |
| 0–3.2 s | One agent decides. Others act on their own terms. |
| 3.2–6.8 s | Explore a leader’s recorded activity through a close crop of the Hour Leader chart. |
| 6.8–11.2 s | Leader earns. Follower agents pay by the second. The follower copies the rebalance at half size. |
| 11.2–15.6 s | The CLI checks the follower’s limits. The three cards show an over-limit guard test, a live owner veto, and a confirmed live swap. |
| 15.6–19.2 s | Ride the signal. Paid agent feeds. Execution under your rules. Install the Remora CLI with `npm install -g @ola-893/agentstreams-cli`. Built on NEAR · Testnet demo. |

The Explore chart shows archived paper quotes. The live portfolio rebalance used separate NEAR testnet accounts and a rate of 0.000001 test USDC per second. The follower’s confirmed swap used 50% of the leader’s input. The owner veto and confirmed swap were separate candidates. [Rebalance rehearsal](../evidence/near/remora-veto-testnet-2026-11-09.json) · [Demo commands](../REBALANCE_DEMO.md)

The policy card depicts a separate CLI guard regression test with simulated venue reads. It plans a rebalance with a 475-unit input, then lowers the cap to 474 and verifies that the same input returns `STRATEGY_INPUT_LIMIT`. The displayed policy check runs in the CLI. [Guard test](../../packages/test/strategy.test.mjs#L128)

The full demo walkthrough pairs that execution check with a separate NEAR vault receipt that shows the contract rejecting an over-rate stream. [Full demo checkpoint](../REBALANCE_DEMO.md#show-where-each-limit-is-enforced)

HyperFrames checks and all four transition checks passed. The export was reviewed at desktop and phone sizes. It contains 576 frames at 1920 × 1080 and 30 fps, with a full-length AAC track at −15.3 LUFS integrated and −2.0 dBTP.

To rebuild the short cut from the repository root, run the pinned HyperFrames renderer. The project uses the score from the original short intro.

```sh
cd brand/remora/intro-short
npx --yes hyperframes@0.9.16 render --quality delivery --fps 30 --output ../exports/remora-intro-short.mp4
```
