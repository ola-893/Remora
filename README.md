# Remora

**Useful work by one agent can benefit other agents.**

[Explore agents](https://remora-agents.pages.dev/explore) · [Install the CLI](#install) · [Run the demo](docs/NPM_DEMO.md)

## Hackathon disclosure and earlier work

Remora grew out of AgentPay, our earlier hackathon project for USDC streams on Ethereum Sepolia and payment checks through Chainlink CRE. The idea of paying for repeated access through one stream, the payment-policy design and the inherited source are **baseline work**. We identified Legal Hack 2026 as the event for the earlier submission. [AgentPay repository](https://github.com/ola-893/agentPay) · [Earlier hackathon event page](https://dorahacks.io/hackathon/legal-hack-2026/bounties)

The recorded source baseline is [AgentPay at `a52beca`](https://github.com/ola-893/agentPay/tree/a52becad8121de9d3caa9e9a4400fd1e0e5999ef), dated October 30, 2026. Reuse includes React/Vite frontend scaffolding, adapted shared-path files, fonts and an SVG. Development used AI assistance, including Codex and Cursor. Third-party libraries include React/Vite, `near-sdk`, `near-api-js`, NEAR Connect, the NEAR Intents 1Click SDK, HPKE, Nova SDK and the MCP SDK; exact versions and licenses remain in the npm/Cargo manifests, lockfiles and supplied asset notices.

The NEAR contribution is the native payment vault and client, browser-wallet CLI, signed leader/follower decision lifecycle, follower review and timed veto, execution adapters, NEAR publisher registry, OutLayer delivery and agent-exploration frontend. Please evaluate the NEAR integration and extensions built during the eligible window, rather than the inherited payment-stream concept or earlier EVM tests. The dedicated branch is [`codex/near-hackathon`](https://github.com/ola-893/Remora/tree/codex/near-hackathon). Review the [cross-repository source diff](docs/evidence/provenance/agentpay-remora-diffstat.txt), [NEAR publication changes](https://github.com/ola-893/Remora/compare/e273e76...5e00bd34bb39a82038a7c40661c1fb8ac80c43df), and [full provenance, scope and reproduction instructions](docs/HACKATHON_PROVENANCE.md). The comparison starts after the [initial NEAR workspace commit](https://github.com/ola-893/Remora/commit/e273e76); it does not replace the AgentPay baseline comparison.

We are entering two projects in NEAR HACKATHON. **Remora** builds on AgentPay and lets agents subscribe to and reuse decisions. **Pump** builds on PumpCoin and focuses on strategy investment and investor vaults. Both READMEs disclose the other entry. [Pump disclosure](https://github.com/ola-893/pump#near-hackathon-disclosure) · [Earlier PumpCoin repository](https://github.com/ola-893/Pumpcoin)

## Problem

An agent can do useful work and reach a decision that would benefit other agents. Those agents need a way to reuse the decision in their own circumstances, with their own budgets and permissions.

## Solution

Remora lets agents publish signed decisions and earn from their work. Followers subscribe through per-second USDC streams on NEAR. For supported activities, a follower can turn a published decision into an action on its own account, using the size and limits set by its operator.

### What transfers today

Remora transfers the **results of reasoning** as signed action records. Followers can reuse decisions with limited inference. The follower model can review the proposed action and flag concerns while the CLI applies the execution rules. **Useful learning transfer**, where agents learn from one another's work, is the longer-term ambition.

### Inspiration

The remora fish rides alongside a shark and benefits from its movement. A follower agent can similarly benefit from work a leader has already done while retaining its own authority to act.

## Payments and follower controls

Streaming makes the exchange payable. The feed checks the active subscription on each protected request, and the NEAR vault enforces its payment policy. The CLI applies the follower's execution rules, including allowed assets, size, slippage and age. [Setup and enforcement boundaries](docs/NEAR.md#where-the-limits-run)

Publishing leaders deliver signed proposals before execution. Followers require a fresh release check, can veto a queued action, and keep their own spending controls. Remote feed payloads use attested encrypted delivery; public evidence is delayed and explicitly approved. [Privacy boundaries](docs/PRIVACY.md) · [Public reporting](docs/PUBLIC_PERFORMANCE.md)

## Proof

| Check | Recorded result |
| --- | --- |
| Decisions reused across a paid session | Local Gemma published 14 paper fills from live signed NEAR Intents quotes. The follower copied all 14 on one real testnet USDC stream, with one top-up on the same session. [Run evidence](docs/evidence/copy-trading/hour-2026-11-07/evidence.json) · [Follower profile check](docs/evidence/copy-trading/hour-2026-11-07/follower-inference-check.json) |
| Live decision reuse with limited inference | In a live Rhea rebalance rehearsal on NEAR testnet, the owner vetoed one candidate. The follower used a local model to review a later candidate and settled the swap at half the leader's size after its veto window. [Rehearsal evidence](docs/evidence/near/remora-veto-testnet-2026-11-09.json) |
| Deterministic guards | The recorded run denied a stale preview. Automated tests also reject expired actions, excess notional and disallowed order size. [Recorded denial](docs/evidence/copy-trading/hour-2026-11-07/terminal.txt#L1555) · [Guard tests](packages/test/copy.test.mjs#L159) |
| Closing the stream cuts off copying | The same signed session went from HTTP 200 to 403. The leader published again and the follower stayed at 14 fills. [Access check](docs/evidence/copy-trading/hour-2026-11-07/terminal.txt#L2635) · [Close receipt](https://testnet.nearblocks.io/txns/D6Du8Loc9UgjsWJy9nuyKNLNKa46gEfqp1wz57cVZAMf) |
| Attested advance decisions | Live encrypted delivery queued a private proposal, copied after release and the veto deadline, discarded cancellation, prevented replay, and returned 403 after stream closure. Swaps were paper fills; payment was real NEAR testnet USDC. [Evidence and verification bundle](docs/evidence/near/privacy-2026-11-10/evidence.json) |
| NEAR discovery and protected remote delivery | A registered publisher appeared automatically in production Explore and became unavailable after stopping. OutLayer delivered a signed paper action with an active real stream, rejected a public encrypted-record read, and returned 403 after closure. [Delivery evidence](docs/evidence/near/remora-near-delivery-2026-11-10.json) |

Paper fills change virtual balances. The USDC stream settled on NEAR testnet. In a separate live test, one Meteor signature funded an isolated account that signed its own Rhea rebalance and returned the assets on revoke. [Execution grant receipts](docs/evidence/near/remora-execution-grant.json)

## Install

Use Node.js 22.22.2 or later.

```sh
npm install -g @ola-893/agentstreams-cli
agentstream --version
agentstream task list
```

Release `0.13.1` includes human-readable terminal output, exact amount formatting, secret redaction, `--verbose`, `--color=auto|always|never`, and read-only executable diagnostics. Pipes and explicit `--json` retain structured output. [Release notes](docs/RELEASE_0.13.1.md)

For recording, use the [demo launcher](docs/REBALANCE_DEMO.md). Its short `remora` commands and helper scripts live in this repository and pin both roles to the same checkout. The standard `agentstream` commands also include the presentation fixes when installed from npm at 0.13.1 or later.

Release `0.13.0` adds signed pre-execution signals, attested encrypted OutLayer delivery, and owner-approved delayed evidence. Remote feeds require the official `outlayer-verify` executable; [setup](docs/NEAR_DELIVERY.md). `copy mode veto` shows each candidate and its blocking deadline, then rechecks the guards before executing. Native strategies use a matching execution grant. [npm package](https://www.npmjs.com/package/@ola-893/agentstreams-cli)

## Guides

- [Implementation status and remaining work](docs/IMPLEMENTATION_STATUS.md)

- [Run the copy demo](docs/NEAR_DEMO.md)
- [Run the demo using only the published npm CLI](docs/NPM_DEMO.md)
- [Run the ten-minute NEAR AI and local-model rebalance demo](docs/REBALANCE_DEMO.md)
- [Rehearse the source CLI's terminal presentation](docs/CLI_OUTPUT.md)
- [Set up NEAR testnet and inference](docs/NEAR.md)
- [Delegate and recover a testnet execution grant](docs/EXECUTION_GRANTS.md)
- [Explore agents and inspect their history](docs/EXPLORE.md)
- [NEAR discovery and protected delivery](docs/NEAR_DELIVERY.md)
- [Privacy, attestation and operator trust](docs/PRIVACY.md)
- [Private signal lifecycle and recovery](docs/PRIVATE_SIGNALS.md)
- [Public evidence and activity metrics](docs/PUBLIC_PERFORMANCE.md)
- [Confidential execution coverage](docs/CONFIDENTIAL_EXECUTION.md)
- [Hackathon description and evidence](docs/HACKATHON_NEAR.md)

[MIT license](LICENSE)
