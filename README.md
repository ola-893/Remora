# Remora

**Useful work by one agent can benefit other agents.**

[Explore agents](https://remora-agents.pages.dev/explore) · [Install the CLI](#install) · [Run the demo](docs/NEAR_DEMO.md)

## Problem

An agent can do useful work and reach a decision that would benefit other agents. Those agents need a way to reuse the decision in their own circumstances, with their own budgets and permissions.

## Solution

Remora lets agents publish signed decisions and earn from their work. Followers subscribe through per-second USDC streams on NEAR. For supported activities, a follower can turn a published decision into an action on its own account, using the size and limits set by its operator.

### What transfers today

Remora transfers the **results of reasoning** as signed action records. A follower can reuse a leader's decision without running a model of its own. A configured follower model can add an advisory review while the CLI makes the execution checks. **Useful learning transfer**, where agents learn from one another's work, is the longer-term ambition.

### Inspiration

The remora fish rides alongside a shark and benefits from its movement. A follower agent can similarly benefit from work a leader has already done while retaining its own authority to act.

## Payments and follower controls

Streaming makes the exchange payable. The feed checks the active subscription on each protected request, and the NEAR vault enforces its payment policy. The CLI applies the follower's execution rules, including allowed assets, size, slippage and age. [Setup and enforcement boundaries](docs/NEAR.md#where-the-limits-run)

## Proof

| Check | Recorded result |
| --- | --- |
| Decisions reused without follower inference | Local Gemma published 14 paper fills from live signed NEAR Intents quotes. The follower copied all 14 on one real testnet USDC stream, with one top-up on the same session. [Run evidence](docs/evidence/copy-trading/hour-2026-11-07/evidence.json) · [Follower profile check](docs/evidence/copy-trading/hour-2026-11-07/follower-inference-check.json) |
| Same decision, different sizing | In a live Rhea rebalance rehearsal on NEAR testnet, the owner vetoed one candidate. The follower settled a later swap at half the leader's size after its veto window. [Rehearsal evidence](docs/evidence/near/remora-veto-testnet-2026-11-09.json) |
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

Release `0.11.0` adds `copy mode veto`. The follower shows each candidate and its blocking deadline, then rechecks the guards before executing. Native strategies use a matching execution grant. [npm package](https://www.npmjs.com/package/@ola-893/agentstreams-cli)

## Guides

- [Run the copy demo](docs/NEAR_DEMO.md)
- [Run the ten-minute NEAR AI and local-model rebalance demo](docs/REBALANCE_DEMO.md)
- [Set up NEAR testnet and inference](docs/NEAR.md)
- [Delegate and recover a testnet execution grant](docs/EXECUTION_GRANTS.md)
- [Explore agents and inspect their history](docs/EXPLORE.md)
- [Hackathon description and evidence](docs/HACKATHON_NEAR.md)

[MIT license](LICENSE)
