# Remora: prior work and NEAR hackathon scope

This disclosure accompanies the [Remora repository](https://github.com/ola-893/Remora). It records source reuse and related projects so judges can distinguish inherited work from the NEAR implementation. It does not assert that a rename, a new repository, an unfinished earlier demo or a different technology stack automatically makes a project eligible.

## Earlier submissions and repository identities

| Project | Repository | Relationship |
| --- | --- | --- |
| AgentPay | [ola-893/agentPay](https://github.com/ola-893/agentPay) | Remora's predecessor and recorded source baseline. USDC escrow streams on Ethereum Sepolia, authenticated API reuse, Chainlink CRE policy checks and a workflow dashboard. |
| Remora | [ola-893/Remora](https://github.com/ola-893/Remora) | This NEAR entry, previously published under the repository name agentStreams. Published npm identifiers remain `@ola-893/agentstreams-cli` and `@ola-893/agentstreams-core`; the CLI command remains `agentstream`. These are component names, not additional submissions. |
| Pump | [ola-893/pump](https://github.com/ola-893/pump) | Another NEAR hackathon project by the creator, centered on strategy investment and investor vaults. It is disclosed here under Q-015. |
| PumpCoin | [ola-893/Pumpcoin](https://github.com/ola-893/Pumpcoin) | Pump's EVM predecessor for self-hosted trading agents and investor vaults. Its earlier submission and code reuse are described in Pump's README. |

The creator confirmed the two project lineages: AgentPay inspired Remora, and PumpCoin inspired Pump. The creator identified Legal Hack 2026 as the earlier event in discussing AgentPay. The available link identifies the event, and the exact project entry URL is unverified. [Legal Hack 2026 bounty page](https://dorahacks.io/hackathon/legal-hack-2026/bounties) · [Pump's disclosure of PumpCoin](https://github.com/ola-893/pump#near-hackathon-disclosure)

AgentPay's public README records completed Sepolia payment runs. Those receipts are evidence for the earlier AgentPay implementation. Pump's README documents the incomplete PumpCoin hackathon demo and its separate infrastructure tests. [AgentPay results](https://github.com/ola-893/agentPay#verified-demo) · [PumpCoin disclosure in Pump](https://github.com/ola-893/pump#near-hackathon-disclosure)

## Baseline and reuse

The existing [source export script](../scripts/prepare-submission.mjs) records commit [`a52becad8121de9d3caa9e9a4400fd1e0e5999ef`](https://github.com/ola-893/agentPay/commit/a52becad8121de9d3caa9e9a4400fd1e0e5999ef) as the inherited baseline. GitHub resolves it in AgentPay, with an author timestamp of October 30, 2026 and the message “Record live frontend payment verification and responsive browser evidence.” This baseline object is not present in Remora's separate Git object history. It must be retrieved from AgentPay to reproduce the comparison; the export script alone cannot generate the baseline patch from this checkout.

Although that snapshot is dated inside the NEAR eligibility window, we conservatively treat all material inherited from it as baseline for this entry. We do not claim AgentPay's earlier submission work as new NEAR work.

A file-byte comparison against Remora commit [`5e00bd3`](https://github.com/ola-893/Remora/tree/5e00bd34bb39a82038a7c40661c1fb8ac80c43df) found:

| Comparison | Files |
| --- | ---: |
| Files in AgentPay snapshot | 1,033 |
| Tracked files in Remora snapshot | 403 |
| Identical files at the same path | 7 |
| Changed files at the same path | 18 |
| Paths present only in Remora | 378 |
| Paths present only in AgentPay | 1,008 |

The seven unchanged paths are `vite-project/.gitignore`, `eslint.config.js`, `netlify.toml`, `postcss.config.cjs`, `public/_redirects`, `src/components/ui/index.js` and `src/main.jsx`, all under `vite-project/`. Identical content also appears at relocated paths: Inter and JetBrains Mono fonts, Inter's license notice and `vite-project/public/agentstreams.svg` (matching AgentPay's `agentpay.svg`). Eighteen shared paths differ, including package files, frontend routes/layout/components, configuration, README and license text.

Treat the frontend scaffolding, adapted shared files, earlier payment-policy architecture and any carried-over patterns as inherited work. A new path, different hash or changed language does not establish original authorship. The comparison is an audit aid, not a claim that every changed line or new file is newly invented. It covers the recorded baseline, not every subsequent AgentPay revision or every external source.

- [Machine-readable hashes and matching paths](evidence/provenance/agentpay-baseline-comparison.json)
- [Cross-repository file diff and rename summary](evidence/provenance/agentpay-remora-diffstat.txt)
- [Initial NEAR workspace publication](https://github.com/ola-893/Remora/commit/e273e76)
- [Subsequent NEAR publication changes through the audited snapshot](https://github.com/ola-893/Remora/compare/e273e76...5e00bd34bb39a82038a7c40661c1fb8ac80c43df)
- [Current dedicated NEAR branch](https://github.com/ola-893/Remora/tree/codex/near-hackathon)

The comparison intentionally pins the source snapshot before this disclosure. Later documentation edits do not silently change its counts. Git author dates and publication commits are not independent proof of when every line was written. We have not rewritten history or invented a pre-hackathon tag.

## Scope submitted for NEAR judging

| Inherited foundation | NEAR implementation and extensions to evaluate |
| --- | --- |
| USDC streams, escrow, recurring API access and deterministic payment-policy concepts | Rust NEAR vault, NEP-141 token flow, typed NEAR client and native transaction/session checks |
| Agent proposes; deterministic rules gate spending | Browser-wallet authorization, named agent CLI profiles, bounded execution accounts and recovery; payment limits in the vault, execution guards in the CLI |
| Paid API gateway and session authentication | Signed decision publication, advance proposal/release/cancellation lifecycle, follower sizing and review, timed owner veto and replay prevention |
| Earlier EVM workflow dashboard and React/Vite scaffolding | Remora activity exploration, NEAR registry discovery and owner-approved delayed performance evidence |
| Earlier provider and policy process design | Attested encrypted remote decision delivery through OutLayer, with subscription checks and build-locked secrets |
| Earlier agent/model tooling concepts | Local and NEAR AI inference configuration, advisory follower review and native NEAR execution adapters |

These descriptions identify scope, not universal completion or production-security guarantees. See [implementation status](IMPLEMENTATION_STATUS.md), [execution boundaries](EXECUTION_GRANTS.md), [privacy boundaries](PRIVACY.md) and the [hackathon evidence index](HACKATHON_NEAR.md). The attached demo uses testnet execution and a localhost gated feed; separate evidence covers OutLayer. Public Rhea settlement is observable. Model review cannot override deterministic guards, and CLI guards are not all contract-enforced.

## Libraries, assets and AI assistance

Development used AI assistance, including Codex and Cursor, for implementation, debugging, testing and documentation. AI assistance does not remove the responsibility to disclose inherited source.

Third-party components include React, Vite, React Router, Tailwind and Lucide for the frontend; `near-sdk`, `near-api-js` and NEAR Connect for NEAR contracts and wallet operations; the NEAR Intents 1Click SDK for quotes; HPKE for encrypted delivery; Nova SDK and the MCP SDK for their integrations. Exact dependency versions are in [root npm](../package-lock.json), [frontend npm](../vite-project/package-lock.json) and [Rust](../near/contracts/Cargo.lock) lockfiles. CLI/core dependency declarations are in their [package](../packages/cli/package.json) [manifests](../packages/core/package.json). The frontend derives from earlier React/Vite scaffolding; it is not represented as a new framework. Fonts and model weights retain their providers' licenses. Model weights are supplied separately.

The repository includes the [MIT license](../LICENSE), retaining the existing MorphStream Contributors attribution. Retained copyright text does not independently establish source ownership or license compliance for every dependency; applicable third-party notices remain relevant.

## Reproduce the source diff

Use a new temporary directory. These commands fetch the two public, immutable source snapshots and inspect them without executing either project or altering this checkout:

```sh
AUDIT=$(mktemp -d)
mkdir "$AUDIT/agentPay" "$AUDIT/Remora"
curl -fLsS https://api.github.com/repos/ola-893/agentPay/tarball/a52becad8121de9d3caa9e9a4400fd1e0e5999ef |
  tar -xz --strip-components=1 -C "$AUDIT/agentPay"
curl -fLsS https://api.github.com/repos/ola-893/Remora/tarball/5e00bd34bb39a82038a7c40661c1fb8ac80c43df |
  tar -xz --strip-components=1 -C "$AUDIT/Remora"
git diff --no-index --no-ext-diff --stat --summary "$AUDIT/agentPay" "$AUDIT/Remora"
git diff --no-index --no-ext-diff --binary "$AUDIT/agentPay" "$AUDIT/Remora" > "$AUDIT/agentpay-to-remora.patch"
```

`git diff --no-index` returns exit status 1 when differences exist. The patch preserves additions, removals and binary changes; the checked-in diff summary is a smaller review index. Neither repository needs a shared ancestor for this comparison.

## Rule mapping and remaining submission checks

The [live NEAR rules](https://nearhackathon.com/HACKATHON.md), checked November 12, 2026, allow existing products and extensions (Q-002/Q-004), require a separated scope and linked diff (Q-003), and require disclosure of inherited libraries/templates and AI code (Q-005). The eligible window begins October 19 and ends November 14, 2026 at 23:59 UTC (Q-001).

The creator is entering Pump and Remora in NEAR HACKATHON. Remora's README names Pump, and Pump's README names Remora. Both READMEs describe their own project scope and prior work for Q-015. The creator reports that Pump's application was already submitted. Its repository README now includes the reciprocal disclosure. [Remora README](../README.md#hackathon-disclosure-and-earlier-work) · [Pump README update](https://github.com/ola-893/pump/commit/9c2a002fa674a6707a2aabb87158104a2cf335fe)

The organizers assess eligibility. Keep this repository public through judging. The creator publishes the X demo thread and uses the official change-request process for any needed changes to an already submitted application. [Request changes](https://nearhackathon.com/request-changes)
