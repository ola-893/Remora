# Record the two-terminal Remora demo

The leader publishes a useful rebalance decision. The follower pays for protected delivery, reviews it with a local model, and acts within its own controls. A second decision is blocked by the follower's tighter limit. Closing the stream ends paid access.

Finish [preparation](DEMO_PREPARATION.md) before recording. This guide uses the **updated checkout**, not the old global npm package. The npm version remains 0.13.0; use the audit's package path, Git revision and renderer fingerprint to distinguish builds.

## Open the two idle terminals

Finish or cancel any hidden API-key prompt before sourcing commands. These commands change only shell routing and select the role's existing state home; they do not fund or deploy anything.

Terminal 1 — leader:

```sh
source /Users/deonorla/Documents/Github/agentstreams/scripts/demo-shell.zsh leader
remora inspect
```

Terminal 2 — follower:

```sh
source /Users/deonorla/Documents/Github/agentstreams/scripts/demo-shell.zsh follower
remora inspect
```

Each shell prints its previous resolution and the checkout now in use. `remora-audit` repeats the check. `CLI_ROOT` and helper imports use this checkout. The source script also selects the working Homebrew Node 22 executable when available, avoiding the broken default Node installation found during QA.

The demo shell explicitly selects `--color=always`, including wallet and setup commands. Ordinary CLI `--color=auto` honors `NO_COLOR`, `FORCE_COLOR` and `TERM`; `--color=never` produces plain output. Set `REMORA_COLOR=never` for the entire demo shell if desired. Explicit `--json` remains undecorated in every mode. Keep JSON for command substitutions and internal logs only.

## 1. Terminal 2 — pay and listen

Preview first, then open the subscription and choose the existing 45-second veto mode. Each command is one visible step:

```sh
remora preview
remora subscribe
remora veto-mode
remora run
```

The last command runs in the foreground, with no redirection and no `--json`. Do not launch another follower runner. The prepared leader feed service must already be running, as described in preparation.

For a transcript, replace only `remora run` with:

```sh
remora --capture "$REMORA_DEMO/follower-terminal.log" run
```

This uses macOS `script` to preserve TTY behavior. Approval links are omitted from the transcript while the real request still opens in the default browser. API keys and free-form inference content remain redacted. The transcript is local; do not distribute it without review.

## 2. Terminal 1 — produce a decision

```sh
remora decide
```

This launches the checkout CLI with the configured NEAR AI model and the same rebalance objective as the previous runbook. The limit is 0.002 wNEAR, with 25%/75% target weights for wNEAR/RFT. It requests one preview and one guarded execution. A model refusal, a technical error or an uncertain outcome is displayed as such; do not describe it as an executed trade.

Terminal 2 shows the signal, proposed follower action, advisory review and veto deadline. Allow the 30-second publication window and the follower's 45-second veto window. With no veto, the existing execution path rechecks the guards before attempting execution.

To demonstrate an owner veto from Terminal 1 while Terminal 2 keeps running:

```sh
remora --role follower veto ACTION_ID
```

Replace `ACTION_ID` with the full pending ID shown by the follower. The role flag selects the follower's state home, not the leader's. A veto is distinct from a policy block.

## 3. Terminal 1 — tighten the follower's limit

After one action has actually completed:

```sh
remora --role follower tighten
remora decide
```

The first command applies the same deterministic 0.0005 wNEAR follower cap from the previous runbook. The leader's maximum remains 0.002 wNEAR; the follower still sizes at 50%. An eligible 0.001 wNEAR copied input exceeds that cap and is denied. Check the actual output rather than assuming the model proposed the expected action. If a state lock is busy, the local policy command fails without changing the limit; inspect before retrying.

## 4. Terminal 2 — stop and prove denied access

The prepared follower uses `close-on-exit false`. Ctrl+C stops its foreground runner and leaves the subscription charging. Close promptly:

```sh
remora stop
```

The helper retains one session credential in memory, checks access, closes the stream and checks the same credential again. It prints the actual before/after HTTP statuses and close receipt. A successful proof shows HTTP 200 before closure and HTTP 403 afterward. It refuses to close while a runner lock names a live process. It never prints the credential. Keep the leader feed running until after this proof.

A read-only closure check is available before recording:

```sh
"$REMORA_NODE" "$REMORA_REPO/scripts/demo-close-proof.mjs" --project "$REMORA_DEMO" --agent follower --check --color=always
```

## Cleanup

After recording, inspect each grant before revoking it. `agentstream grant revoke --agent follower` and the corresponding leader command perform recovery transactions and are separate from presentation QA. Stop the publisher only after checking its saved PID and current command; do not blindly kill a PID from an old recording. For uncertain outcomes, use the relevant `wallet reconcile`, `grant reconcile` or `signal reconcile ID --hash HASH` command before any retry.

## What this QA established

The old global package lacked the presentation renderer despite sharing version 0.13.0. Redirected `--json` runners and raw helper logging also bypassed it. The launcher now pins the checkout for both roles and subprocesses. Read-only commands and an actual idle source runner were inspected through live PTYs at split-screen width; [presentation evidence](CLI_OUTPUT.md#actual-execution-path-verification).

No funding, grants, deployment or trading was repeated for output verification. The current `remora-demo-013` directory had a leader but no prepared follower at inspection time. Preparation must finish before the funded story can run. This QA does not establish a new complete funded demo run.
