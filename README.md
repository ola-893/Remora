# Remora

**Smart agents decide, cheap agents do, and the limits aren't up to the model.**

[Explore agents](https://remora-agents.pages.dev/explore) · [Install the CLI](#install) · [Run the demo](docs/NEAR_DEMO.md)

## Problem

Smart models are too expensive to run for every follower, and cheaper models can make costly mistakes when they control funds. When reasoning and spending authority live inside the same agent, every follower pays to think through the same decision and has to trust the model that acts on it.

## Solution

One leader reasons once and publishes a signed move. Followers subscribe to that feed with a per-second USDC stream on NEAR. The copy runner uses the follower's own account and checks the move against limits set by the operator. A configured follower model adds an advisory note about the action. Inference is optional.

The name comes from the remora fish that rides alongside a shark. The leader supplies the signal. The follower chooses what it can afford to follow.

## Why the pieces fit

The stream is the subscription. It pays for access to the signed moves, and the feed checks the active stream on each protected request. A follower applies its own execution guards before acting, so access to a leader's decision never gives that leader spending authority over the follower. The NEAR vault enforces the subscription's payment policy. The CLI enforces trade rules such as assets, size, slippage and age. [Setup and enforcement boundaries](docs/NEAR.md)

## Proof

| Check | Recorded result |
| --- | --- |
| One leader, no model on the follower | Local Gemma published 14 paper fills from live signed NEAR Intents quotes. The follower copied all 14 on one real testnet USDC stream, with one top-up on the same session. [Run evidence](docs/evidence/copy-trading/hour-2026-11-07/evidence.json) · [Follower profile check](docs/evidence/copy-trading/hour-2026-11-07/follower-inference-check.json) |
| Deterministic guards | The recorded run denied a stale preview. Automated tests also reject expired actions, excess notional and disallowed order size. [Recorded denial](docs/evidence/copy-trading/hour-2026-11-07/terminal.txt#L1555) · [Guard tests](packages/test/copy.test.mjs#L159) |
| Closing the stream cuts off copying | The same signed session went from HTTP 200 to 403. The leader published again and the follower stayed at 14 fills. [Access check](docs/evidence/copy-trading/hour-2026-11-07/terminal.txt#L2635) · [Close receipt](https://testnet.nearblocks.io/txns/D6Du8Loc9UgjsWJy9nuyKNLNKa46gEfqp1wz57cVZAMf) |

Paper fills change virtual balances. The USDC stream settled on NEAR testnet. In a separate live test, one Meteor signature funded an isolated account that signed its own Rhea rebalance and returned the assets on revoke. [Execution grant receipts](docs/evidence/near/remora-execution-grant.json)

## Install

Use Node.js 22.22.2 or later.

```sh
npm install -g @ola-893/agentstreams-cli
agentstream --version
agentstream task list
```

Release `0.10.0` includes execution grants, limit orders and automatic copy review with a configured local or NEAR AI model. The package and executable names retain their agentStreams identifiers. [npm package](https://www.npmjs.com/package/@ola-893/agentstreams-cli)

## Guides

- [Run the copy demo](docs/NEAR_DEMO.md)
- [Run the ten-minute NEAR AI and local-model rebalance demo](docs/REBALANCE_DEMO.md)
- [Set up NEAR testnet and inference](docs/NEAR.md)
- [Delegate and recover a testnet execution grant](docs/EXECUTION_GRANTS.md)
- [Explore agents and inspect their history](docs/EXPLORE.md)
- [Hackathon description and evidence](docs/HACKATHON_NEAR.md)

[MIT license](LICENSE)
