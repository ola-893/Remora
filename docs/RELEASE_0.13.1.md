# Remora CLI 0.13.1

Published to npm on November 11, 2026 as `@ola-893/agentstreams-cli@0.13.1`, with the `latest` tag. Core remains `@ola-893/agentstreams-core@0.9.1`; its rebuilt tarball integrity matches the existing published release.

## Upgrade

```sh
npm install -g @ola-893/agentstreams-cli@0.13.1
command agentstream --version
command agentstream diagnostics --color=always
```

On the demo Mac, select the working Node 22 installation first if a fresh shell still uses the broken Homebrew Node binary:

```sh
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
```

`command agentstream` bypasses a shell function so the diagnostics show the installed npm package. Version should be 0.13.1; diagnostics also show its actual package root and renderer fingerprint. The checkout's demo shell may remain sourced for the short `remora` commands.

## Changes

- Interactive terminals show short headings and labelled facts instead of raw object dumps. Exact decimal amounts use integer arithmetic; unknown tokens stay labelled as raw units.
- Model review, deterministic policy blocks, owner vetoes, previews, paper execution, confirmed execution and uncertain outcomes have distinct labels. Repeated waiting and heartbeat messages are collapsed only in human output.
- Wallet approval prompts use the same presentation context as the command. Keys, authorization values and free-form inference content are redacted. Full structured evidence remains inspectable through JSON, with sensitive values redacted.
- `--color=auto|always|never` works across help, results, wallet prompts and errors. Auto mode honors `NO_COLOR`, `FORCE_COLOR` and terminal capabilities; explicit JSON is never decorated.
- `--verbose` adds redacted structured details. `diagnostics` reports executable resolution, package root, Git revision where available, renderer fingerprint and terminal settings without modifying agent state.
- Installed-package verification checks that the renderer actually ships and runs from the installed package, preventing the original mismatch between checkout output and the global CLI.

The underlying agent, payment, privacy, approval and execution behavior is unchanged. This release does not establish new live trading or confidentiality evidence.

## Demo workflow

The short demo launcher and closure/compute helpers are repository scripts, not new installed CLI subcommands. They pin their imports and subprocesses to the checkout and reject an explicitly different package root. The viewed follower runs in the foreground; machine lookups and internal logs can still use JSON. Transcript capture preserves TTY behavior and omits one-use wallet links.

Use [preparation](DEMO_PREPARATION.md) before recording, then the [short two-terminal sequence](REBALANCE_DEMO.md). Existing setup, funding and grants should be inspected rather than blindly repeated.

## Verification

- 119 CLI/core package tests passed.
- Strict distribution type checks passed.
- Contracts, bundled recorded UI and owner-wallet UI built successfully; no service deployment was performed.
- Local tarball installation outside the checkout passed operational smoke checks.
- npm publication, exact-version metadata, `latest` tag and tarball integrity were verified against the validated local archive.
- A clean npm registry installation passed command routing, named-agent isolation, wallet/setup inspection, inference configuration, MCP configuration, bundled UI HTTP checks, portable runtime imports, and presentation/JSON/color checks.

No owner funding, grants, deployments or trading transactions were executed for release verification. [Machine-readable release evidence](evidence/cli-presentation/release-0.13.1.json)

[npm version](https://www.npmjs.com/package/@ola-893/agentstreams-cli/v/0.13.1)
