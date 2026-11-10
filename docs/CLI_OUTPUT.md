# Rehearse the CLI presentation

Useful work by one agent can benefit other agents. Streaming makes that exchange payable; guardrails let each follower use it on its own terms. The terminal now presents that story through short state changes, rather than requiring the viewer to interpret transaction objects.

This presentation pass is in the source checkout. It has **not** been published to npm. Package versions stay unchanged. No services were deployed and no funded transactions were run for this pass.

## Output modes

| Invocation | Output |
| --- | --- |
| Normal interactive terminal | Concise headings, labelled facts and necessary next steps |
| Redirected or piped output | Existing structured objects and pretty-printed framing |
| `--json` | One JSON value per line; a finite command normally prints one value, a runner prints an event stream |
| `--verbose` in a terminal | Summaries plus redacted structured details |
| `NO_COLOR=1` or `TERM=dumb` | Plain status words without ANSI color; dumb terminals use ASCII heading markers |

`--help --json` and `--version --json` return JSON strings. Diagnostics remain on stderr; explicit JSON command failures use a JSON error object there and preserve exit code 1. MCP's stdio protocol is unchanged. Existing script consumers, including the distribution verifier and copy QA helpers, parse piped JSON and keep that behavior.

Private keys, API keys, authorization fields and free-form inference text are redacted in all output modes, including verbose/JSON. Structured review status and evidence references remain visible. Object field names, status identifiers, integer amount strings and evidence objects retain their schemas; redaction deliberately replaces sensitive values. A one-use browser approval URL is printed once on stderr, unwrapped, because it is needed to complete the request. Keep that URL out of shared recordings.

Amounts use decimal string/BigInt arithmetic. NEAR units, wrapped NEAR and the existing fixed USDC token IDs have pinned metadata. Unknown tokens are explicitly labelled `raw units`; the renderer does not make network calls to guess their symbols or decimals. Full IDs and receipt payloads remain available with `--json`; recipients are shown in full before wallet approval and transaction details remain in the browser wallet.

## Offline presentation rehearsal

Run these commands in your terminal, using the current source rather than the global npm installation:

```sh
cd /Users/deonorla/Documents/Github/agentstreams
node scripts/rehearse-cli-output.mjs --width 72
node scripts/rehearse-cli-output.mjs --width 48 --no-delay
NO_COLOR=1 node scripts/rehearse-cli-output.mjs --width 64 --no-delay
node scripts/rehearse-cli-output.mjs --json --no-delay | jq -c .
```

The rehearsal is explicitly labelled **synthetic presentation fixtures**. It exercises the same renderer as the CLI but does not call RPC, inference, OutLayer, a wallet, or a trading venue. Its confirmation and closure events contain fake receipt labels and are not execution evidence. It shows a subscription rate, a proposed decision, an advisory model review, a veto deadline, a confirmation, a policy block, an owner veto, a paper fill and an uncertain outcome. It also demonstrates collapsing repeated waiting messages.

For an actual local CLI runner with no subscription or transactions, use a fresh temporary project:

```sh
REPO=/Users/deonorla/Documents/Github/agentstreams
REHEARSAL=$(mktemp -d /tmp/remora-output.XXXXXX)
mkdir -m 700 "$REHEARSAL/private"
export AGENTSTREAMS_HOME="$REHEARSAL/private"
cd "$REHEARSAL"
agentstream() { node "$REPO/packages/cli/bin/agentstreams.mjs" "$@"; }

agentstream agent create rehearsal
agentstream agent use rehearsal
agentstream inference show
agentstream agent show
agentstream agent run
# Press Ctrl+C to stop the idle runner.

agentstream agent show --json
agentstream agent show --verbose
```

This isolates the rehearsal from existing wallets, grants and paid subscriptions. Open a new shell for your funded demo so you do not accidentally use this temporary configuration home.

## Record the prepared two-terminal demo

Complete the setup in [the rebalance demo](REBALANCE_DEMO.md) first. The following commands use its existing `leader` and `follower` agents, separate private state homes and the saved `ACTION`. They do not replace provisioning, inference configuration, funding, guards or grants.

In **both terminals**, select the source CLI for this presentation pass:

```sh
REPO=/Users/deonorla/Documents/Github/agentstreams
DEMO="$HOME/remora-demo-013"
cd "$DEMO"
agentstream() { node "$REPO/packages/cli/bin/agentstreams.mjs" "$@"; }
```

Terminal 1 uses `export AGENTSTREAMS_HOME="$DEMO/leader-state"`. Keep the publisher runner from the runbook alive in the background. The prompted leader run will show model tool requests, previews, their evidence source and the returned execution outcome:

```sh
export AGENTSTREAMS_HOME="$DEMO/leader-state"
ACTION='{"poolId":0,"base":"wrap.testnet","amount":"2000000000000000000000","weights":{"wrap.testnet":2500,"rft.tokenfactory.testnet":7500}}'
agentstream inference show --agent leader
agentstream agent run --agent leader --activity portfolio-rebalance --max-steps 8 \
  --prompt "Evaluate this testnet rebalance objective: $ACTION. Read strategy_guard, call strategy_preview, examine its live Rhea evidence, and use strategy_apply exactly once if the guard and preview permit it. Explain your decision using the returned evidence. Stop after the confirmed result or a refusal."
```

In Terminal 2, after starting the paid subscription and selecting veto mode as described in the runbook, run the follower **in the foreground** so stdout is a terminal:

```sh
export AGENTSTREAMS_HOME="$DEMO/follower-state"
agentstream copy status --agent follower
agentstream guard show --agent follower
agentstream agent run --agent follower
```

Do not also start the background follower from the older log-viewing instructions: only one runner can hold an agent's lock. A `tail` of a redirected runner log shows machine JSON, because redirection deliberately preserves script output. For a human-readable recording with a saved terminal transcript on macOS, replace the foreground runner command with:

```sh
script -q "$DEMO/follower-terminal.log" node "$REPO/packages/cli/bin/agentstreams.mjs" agent run --agent follower
```

To block an eligible candidate while Terminal 2 continues running, run this from Terminal 1, replacing the example ID with the full action ID shown by the follower:

```sh
AGENTSTREAMS_HOME="$DEMO/follower-state" agentstream copy pending --agent follower
AGENTSTREAMS_HOME="$DEMO/follower-state" agentstream copy block YOUR_ACTION_ID --agent follower
```

An owner veto is labelled separately from a policy block. If the owner does not veto in time, the renderer reports the outcome returned by the existing execution path; it does not grant approval or skip checks. Model review is advisory, including when the model reports no concern or inference is unavailable.

For the cap-change and closure steps, stop the foreground runner with Ctrl+C before issuing Terminal 2's next commands. The runbook configures `close-on-exit false`, so this preserves the paid stream: it continues charging until closed or exhausted. Keep the interruption brief, restart the foreground runner after changing the cap, and use the runbook's close-and-probe helper when finished. Because the foreground runner has already exited, omit the old background `FOLLOWER_PID` kill/wait commands. Use `CLI_ROOT="$REPO/packages/cli"` for the close-proof helper to use this checkout's modules.

## Representative before and after

These examples use the synthetic policy-block fixture, not a new live transaction.

Before:

```json
{"type":"strategy","actionId":"fixture-candidate-02","status":"skipped","reason":"STRATEGY_INPUT_LIMIT: nep141:wrap.testnet"}
```

After:

```text
! Action blocked by policy
  Action ID      fixture-candidate-02
  Reason         The proposed input exceeds your execution limit.
  Code           STRATEGY_INPUT_LIMIT: nep141:wrap.testnet

  Your execution limits remain unchanged.
```

An uncertain error does not claim that nothing was submitted:

```text
! Outcome needs reconciliation
  Reason         STRATEGY_OUTCOME_UNCONFIRMED
  Submission     Outcome uncertain; do not submit again yet.

  Inspect agentstream status, stream status and reconcile
  before another paid operation.
```

## Validation and limits

Focused tests cover output mode/schema compatibility, secret redaction, exact large amounts, unknown token metadata, pending/paper/policy/veto/failure/confirmation distinctions, no-color mode, narrow layouts and repeated-event collapsing. The CLI/core suite also exercises the existing copy, payment, grant, inference and wallet paths. Representative fixtures and a fresh local idle runner were inspected in actual PTYs, including split-screen widths.

This pass does not establish new trading, payment, confidentiality or attestation evidence. Free-form model prose is deliberately hidden, so the recording should explain the displayed structured review and tool evidence. Maintenance heartbeat receipts and repeated waiting/error messages are collapsed only in terminal summaries; machine streams retain every event. Use JSON for full receipt inspection. Underlying strategy, payment, approval, privacy and execution rules remain unchanged.
