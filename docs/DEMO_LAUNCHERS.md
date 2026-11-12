# One command in each terminal

These launchers use **the globally installed npm CLI 0.13.1**, not checkout CLI code. They install that npm version if missing. The three shell files live in this repository; no new npm release is needed. Use Terminal 1 for Shark and Terminal 2 for Remora.

Terminal 1:

```sh
bash /Users/deonorla/Documents/Github/agentstreams/scripts/demo-shark.sh
```

Terminal 2:

```sh
bash /Users/deonorla/Documents/Github/agentstreams/scripts/demo-remora.sh
```

Run both commands now. Setup happens first, with visible progress. Initial wallet approvals open in your default browser; enter your NEAR AI API key only at the CLI's hidden prompt. Never enter an owner wallet private key. Shark uses NEAR AI; Remora uses local `qwen2.5:1.5b`. Both use the same owner wallet and **separate funded execution accounts**.

Prerequisites: Node >=22.22.2, npm, jq, running Ollama with `qwen2.5:1.5b`, a funded testnet wallet, a NEAR AI API key, and port 5380 available on this Mac. No OutLayer compute key, compute top-up, or attestation verifier is required. NEAR AI inference can consume your provider credit; blockchain execution uses testnet assets only.

This same-machine demo uses the CLI's built-in **localhost subscription-gated feed** at `http://127.0.0.1:5380`. The follower supplies that URL explicitly, and feed access still checks the NEAR payment stream. It does not demonstrate OutLayer encrypted/attested delivery or discovery by remote machines. The separate npm OutLayer delivery path still requires compute credentials; a sponsored, key-free OutLayer user flow is not implemented by these launcher changes.

The default workspace is **`$HOME/remora-shark-demo`**, separate from your earlier `remora-demo-013` agents. First use needs fresh agent configuration and initial approvals. Both scripts must use the same workspace. To choose a different project, prefix **both** commands with the same `REMORA_DEMO=/absolute/path` value. Agent state and credentials stay in the CLI's private local storage, not `.env` files.

For fresh state, each execution account is funded with 0.25 test NEAR. The follower subscription vault is topped up only to 0.002 Circle test USDC, deducting its current available balance. Existing active grants are reused only if they belong to the correct agent/activity. An expired or exhausted grant for this demo's rebalance activity gets an explicit recovery prompt: continuing recovers supported assets, retires the old execution account, then requests a new wallet-approved 0.25 test NEAR grant. Pending, mismatched, or incompletely recovered grants still stop setup. Targeted grant preparation fills only missing balances. The launchers never retry a failed transaction automatically.

## While recording

1. Wait for **“Both setups are complete. Start recording now”** in Terminal 1. Start your recording, then press Enter there. Remora subscribes automatically and runs visibly in the foreground.
2. Shark requests its first NEAR AI decision. Watch Remora's local-model review, 45-second veto deadline, and actual execution. The leader's publication window is 30 seconds. **Wait for the real confirmed result**, then press Enter at Shark's prompt.
3. Shark's launcher lowers Remora's input cap, displays it, and requests the second decision. Wait for the actual `STRATEGY_INPUT_LIMIT` denial in Terminal 2, then press Enter at Shark's next prompt. It verifies the denial exists in this run's history.
4. When Terminal 1 asks, press **Ctrl+C once in Terminal 2**. This stops the foreground runner; the Remora launcher then closes the stream, displays the actual close/status results, checks the vault has no active session, and disables automatic reopening. Keep Terminal 1 open until it reports completion.
5. Shark stops its publication and only the publisher worker started by this invocation. Grants remain funded for reuse; they are not revoked automatically.

The first two Enter prompts require actual outcomes, not estimates of elapsed time. If the model refuses to trade, inference fails, a transaction is uncertain, or the guard does not deny the second candidate, the launcher stops with the real error. It does not print a successful story over a failed run.

The transport worker alone uses an internal JSON log (`shark-feed.log`). The viewed decision and follower runners use the npm CLI's human renderer, with terminal colors and no `tail`. Setting `NO_COLOR=1` makes launcher and CLI output plain.

## Interruptions and recovery

Remora attempts closure on a normal runner exit, Ctrl+C, or termination after a confirmed subscription start. An uncertain close is **not retried automatically**. A power loss, forced kill, network failure, or uncertain subscription-open result can leave payment active; inspect/reconcile its on-chain state. Stopping Shark early deliberately leaves its publisher alive so Remora can finish closing. The launcher prints the exact publication-stop command and worker PID for recovery. Inspect the PID before terminating it.

If a launch lock remains after a crash, read its `pid` file and inspect that process before removing the lock directory. The scripts do not remove existing runner locks or interrupt agents from another session.

On a repeat run, a paused follower is accepted only after the vault confirms no active session or pending funds. A leftover local Shark publication is reset only when no Shark runner lock remains and the previous demo follower has no active/unresolved subscription or vault session. Remote/registered publications still require explicit shutdown. These checks preserve the agent identities and inference settings rather than deleting the demo state.

Read-only preflight, without funding or starting agents:

```sh
bash /Users/deonorla/Documents/Github/agentstreams/scripts/demo-shark.sh --check
bash /Users/deonorla/Documents/Github/agentstreams/scripts/demo-remora.sh --check
```

For reconciliation boundaries, see [the npm runbook](NPM_DEMO.md); its manual transport example uses OutLayer, unlike these localhost launchers. For narration, see [the voice-over script](DEMO_VOICEOVER.md).

## Claims this recording supports

Name only events that actually appear. Local-model review is advisory; deterministic execution guards are CLI checks. The separate execution account's funded balance is the on-chain spending bound. This recording uses public Rhea testnet settlement, not confidential execution. Closing the stream proves closure through the actual transaction and vault state. CLI 0.13.1 does not include a same-credential HTTP 200→403 probe; this launcher does not claim to measure one.

## Validation

Both launchers passed Bash syntax checks and real read-only preflight against globally installed npm CLI 0.13.1. A terminal-attached check verified human output with colors, and another verified plain output with `NO_COLOR`. The offline two-terminal PTY test (`python3 scripts/test-demo-launchers.py`) verifies subscription-before-veto ordering, foreground execution, Ctrl+C followed by confirmed closure, and a failed close without automatic retry. Its CLI outcomes are fixtures, not blockchain evidence. A newly funded pair has not been rehearsed end to end by these checks.

The installed npm CLI also served a real localhost feed from an isolated temporary agent without an OutLayer key: the listing was available, an action-feed request without a session returned HTTP 402, and an invalid session returned HTTP 403. That check used no funded transactions. It is not the same-credential, before/after-stream-closure proof.
