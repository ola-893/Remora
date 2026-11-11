# Demo using the published npm CLI

This guide uses `@ola-893/agentstreams-cli@0.13.1`: no repository checkout, `source` command, `remora` wrapper, or JavaScript helper is required. Use two zsh terminals on your Mac. Setup happens before recording; enter commands individually and wait for each result.

The `shark` leader uses NEAR AI for a portfolio-rebalance decision. The `remora` follower uses local Qwen for advisory review, copies at 50%, and has a 45-second owner-veto window. Swaps and the subscription are on NEAR testnet. Rhea settlements are public; advance proposals use the existing encrypted OutLayer feed.

The agent names throughout are `shark` and `remora`. Editing this guide does not rename existing `leader`/`follower` agents or transfer their inference settings and grants. The state directories keep their role-based names (`leader-state` and `follower-state`). Inspect any existing grant before creating one for a new agent.

## 1. Install and verify npm resolution

Terminal 1:

```sh
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
npm install -g @ola-893/agentstreams-cli@0.13.1
unalias agentstream agentstreams 2>/dev/null || true
unfunction agentstream agentstreams remora remora-audit 2>/dev/null || true
rehash
agentstream --version
agentstream diagnostics --color=always
```

Expect version `0.13.1` and an installed package root such as `/opt/homebrew/lib/node_modules/@ola-893/agentstreams-cli`, rather than your Git checkout. The Node PATH above uses the working Node 22 installation already on this Mac.

Terminal 2 does not need to reinstall. Run:

```sh
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
unalias agentstream agentstreams 2>/dev/null || true
unfunction agentstream agentstreams remora remora-audit 2>/dev/null || true
rehash
agentstream --version
agentstream diagnostics --color=always
```

## 2. Preparation — Terminal 1: shark (leader)

Prerequisites: a funded NEAR testnet wallet; the existing Remora OutLayer project and a funded compute API key; `outlayer-verify` installed; a NEAR AI API key; Ollama serving `qwen2.5:1.5b` locally; and `jq`. The OutLayer compute token is test USDC.e, separate from the Circle test USDC subscription token.

The owner wallet signs initial setup in your default browser. Never enter a wallet private key. The API-key prompts below are for inference and OutLayer compute credentials only.

```sh
DEMO="$HOME/remora-demo-013"
mkdir -p "$DEMO"
cd "$DEMO"
export AGENTSTREAMS_HOME="$DEMO/leader-state"
mkdir -p "$AGENTSTREAMS_HOME"
chmod 700 "$AGENTSTREAMS_HOME"
export FORCE_COLOR=1
unset NO_COLOR

agentstream agent list
agentstream wallet show
```

Check whether `shark` is already listed. **Run creation only if it is absent:**

```sh
agentstream agent create shark
```

Connect the wallet if this role is not already connected:

```sh
agentstream wallet connect --network testnet --owner-id rudepuma4060.testnet --rpc https://test.rpc.fastnear.com
```

Inspect existing inference configuration first. Keep it if correct; otherwise configure through the CLI:

```sh
agentstream inference show --agent shark
```

```sh
NEAR_MODEL=$(agentstream inference models --provider near-ai --json | jq -er '[.models[] | select(.agentCompatible)][0].id')
agentstream inference set --agent shark --provider near-ai --model "$NEAR_MODEL" --api-key --timeout-seconds 120
```

If this role does not already have the funded OutLayer compute key configured:

```sh
agentstream outlayer key --api-key
```

Configure the activity and deterministic execution limits:

```sh
agentstream task enable portfolio-rebalance --agent shark
agentstream guard set execution --agent shark --activity portfolio-rebalance \
  --targets 0 --assets nep141:wrap.testnet,nep141:rft.tokenfactory.testnet \
  --max-inputs nep141:wrap.testnet=2000000000000000000000 --max-age 120 --max-slippage-bps 100
agentstream grant show --agent shark
```

If no active matching grant exists, create one. Do not recreate a funded grant or repeat an uncertain transaction:

```sh
agentstream grant create --agent shark --transactions 20 --hours 2 --activities portfolio-rebalance \
  --tokens wrap.testnet,rft.tokenfactory.testnet --fund-near 0.25
agentstream grant prepare --agent shark --activity portfolio-rebalance --token wrap.testnet --balance-raw 20000000000000000000000
agentstream grant prepare --agent shark --activity portfolio-rebalance --token rft.tokenfactory.testnet
agentstream grant show --agent shark
```

Prepare the objective and prompt before recording. The task command is a preview: it has no `--execute` flag.

```sh
ACTION='{"poolId":0,"base":"wrap.testnet","amount":"2000000000000000000000","weights":{"wrap.testnet":2500,"rft.tokenfactory.testnet":7500}}'
PROMPT="Evaluate this testnet rebalance objective: $ACTION. Read strategy_guard, call strategy_preview, examine its live Rhea evidence, and use strategy_apply exactly once if the guard and preview permit it. Stop after a confirmed result or a refusal."
agentstream task run portfolio-rebalance --agent shark --action-json "$ACTION"
```

Continue only after the preview succeeds. Configure the publication, then start its internal feed worker. Keep this worker alive throughout the recording:

```sh
SELLER=$(agentstream wallet show --json | jq -er '.accountId')
printf '%s\n' "$SELLER" > "$DEMO/seller.txt"
agentstream publish set --agent shark --delivery outlayer --activities portfolio-rebalance \
  --recipient "$SELLER" --rate 0.000001 --duration 900 --signal-window 30
agentstream publish start --agent shark
agentstream agent show shark --json | jq -er '.id' > "$DEMO/shark-id.txt"
agentstream agent run --agent shark --json > "$DEMO/shark-feed.log" 2>&1 &
PUBLISH_PID=$!
```

The background worker's JSON file is internal diagnostics. Do not tail it during the presentation. If publication or a worker is already running, inspect its state before starting another or changing publication settings.

## 3. Preparation — Terminal 2: remora (follower)

```sh
DEMO="$HOME/remora-demo-013"
cd "$DEMO"
export AGENTSTREAMS_HOME="$DEMO/follower-state"
mkdir -p "$AGENTSTREAMS_HOME"
chmod 700 "$AGENTSTREAMS_HOME"
export FORCE_COLOR=1
unset NO_COLOR
SELLER=$(cat "$DEMO/seller.txt")
SHARK_ID=$(cat "$DEMO/shark-id.txt")

agentstream agent list
agentstream wallet show
```

Create `remora` only if absent, then connect its browser wallet if necessary:

```sh
agentstream agent create remora
agentstream wallet connect --network testnet --owner-id "$SELLER" --rpc https://test.rpc.fastnear.com
```

Configure its model and, if not already configured, the funded compute API key:

```sh
agentstream inference set --agent remora --provider local --base-url http://127.0.0.1:11434/v1 \
  --model qwen2.5:1.5b --max-output-tokens 384 --timeout-seconds 45
agentstream inference show --agent remora
agentstream outlayer key --api-key
```

Confirm the local server/model is available with `ollama list`. Configuration output alone is not an inference test.

For a fresh follower, deploy and configure the subscription vault. These steps require initial owner approvals. Inspect an existing deployment/balance first and skip completed funding; reconcile uncertain operations before retrying.

```sh
agentstream agent setup --agent remora --network testnet --recipient "$SELLER" --rpc https://test.rpc.fastnear.com --deploy
agentstream guard set payment --agent remora --budget 0.01 --max-stream 0.002 \
  --max-rate 0.000001 --max-duration 900 --recipient "$SELLER"
agentstream fund 0.002 --agent remora
agentstream payments --enable --agent remora
agentstream guard set payment --agent remora --poll-seconds 10 --idle-timeout 600 --close-on-exit false
```

Enable copying at 50% with a maximum 0.001 wNEAR input:

```sh
agentstream task enable portfolio-rebalance --agent remora
agentstream guard set execution --agent remora --activity portfolio-rebalance \
  --targets 0 --assets nep141:wrap.testnet,nep141:rft.tokenfactory.testnet \
  --max-inputs nep141:wrap.testnet=1000000000000000000000 --copy-bps 5000 --max-age 120 --max-slippage-bps 100
agentstream grant show --agent remora
```

If there is no active matching follower grant:

```sh
agentstream grant create --agent remora --transactions 20 --hours 2 --activities portfolio-rebalance \
  --tokens wrap.testnet,rft.tokenfactory.testnet --fund-near 0.25
agentstream grant prepare --agent remora --activity portfolio-rebalance --token wrap.testnet --balance-raw 20000000000000000000000
agentstream grant prepare --agent remora --activity portfolio-rebalance --token rft.tokenfactory.testnet
agentstream grant show --agent remora
```

Both roles may connect the same owner wallet in this test. Their grants create separate execution accounts; this is not proof of two independent owners. Model review is advisory; execution guards remain deterministic CLI checks. The funded execution-account balance is the on-chain spending bound.

## 4. Recording — Terminal 2: remora subscribes and listens

Clear the setup output and run one command at a time:

```sh
clear
agentstream copy "$SHARK_ID" --agent remora
agentstream guard show --agent remora
agentstream copy start "$SHARK_ID" --activity portfolio-rebalance --agent remora
agentstream copy mode veto --agent remora --veto-seconds 45
agentstream agent run --agent remora
```

The last command stays in the foreground. No `--json`, redirection, backgrounding or `tail` is used for the viewed runner.

## 5. Recording — Terminal 1: shark produces a decision

```sh
clear
agentstream inference show --agent shark
agentstream agent run --agent shark --activity portfolio-rebalance --max-steps 8 --prompt "$PROMPT"
```

The follower should show the proposed action, advisory local-model review, veto deadline and actual execution outcome. Wait for confirmation; a preview or model response is not settlement. Allow the leader's 30-second publication window and follower's 45-second veto window.

## 6. Recording — Terminal 1: tighten remora’s cap, then shark decides again

Keep the follower running in Terminal 2. Target its state home explicitly for this one local policy command:

```sh
AGENTSTREAMS_HOME="$DEMO/follower-state" agentstream guard set execution --agent remora \
  --activity portfolio-rebalance --max-inputs nep141:wrap.testnet=500000000000000000000
AGENTSTREAMS_HOME="$DEMO/follower-state" agentstream guard show --agent remora
```

Proceed only after the displayed follower cap is 0.0005 wNEAR. If the local update reports `AGENT_BUSY`, it did not change the cap; retry that local configuration command after the runner checkpoint. Then request the second leader decision:

```sh
agentstream agent run --agent shark --activity portfolio-rebalance --max-steps 8 --prompt "$PROMPT"
```

The follower still sizes at 50%, but its cap is now 0.0005 wNEAR. An actual copied input above that cap is blocked with `STRATEGY_INPUT_LIMIT`. Do not assume the model proposed a trade: show the returned evidence. This is a policy denial, distinct from an owner veto.

For an optional owner-veto example, while an eligible action is still inside its window, run from Terminal 1:

```sh
AGENTSTREAMS_HOME="$DEMO/follower-state" agentstream copy pending --agent remora
AGENTSTREAMS_HOME="$DEMO/follower-state" agentstream copy block ACTION_ID --agent remora
```

Replace `ACTION_ID` with the actual pending ID. Use an eligible candidate before tightening the cap if demonstrating this separately.

## 7. Recording — Terminal 2: remora closes the stream

Press **Ctrl+C** to stop the foreground runner. Setup deliberately selected `close-on-exit false`: payment continues until explicitly closed or exhausted. Close promptly:

```sh
agentstream copy stop --agent remora
agentstream copy status --agent remora
agentstream stream status --agent remora
agentstream payments --disable --agent remora
```

Show the actual close transaction and the vault's lack of an active session. Disabling payments prevents a later guarded request from silently opening a new subscription.

**HTTP proof boundary:** npm CLI 0.13.1 does not expose the repository helper's same-credential HTTP 200→403 probe as a built-in command. This npm-only sequence proves stream closure, not a freshly measured HTTP 403. Do not run `request` after closure and claim it is that probe: the guarded request command can open a new stream when payments are enabled. Existing recorded 200→403 evidence is separate from this live npm-only recording.

## 8. Cleanup after recording

Terminal 2, after verifying closure:

```sh
agentstream grant revoke --agent remora
```

Terminal 1, after closure has been demonstrated:

```sh
agentstream publish stop --agent shark
```

Inspect the current worker before terminating the PID saved by this session:

```sh
ps -p "$PUBLISH_PID" -o pid=,args=
```

Only if it is the leader worker started above:

```sh
kill -TERM "$PUBLISH_PID"
wait "$PUBLISH_PID"
agentstream grant revoke --agent shark
```

Grant revocation performs recovery transactions. For uncertain outcomes, use the appropriate `wallet reconcile`, `grant reconcile` or `signal reconcile ID --hash HASH` command before retrying.

## Validation

Commands were checked against the npm 0.13.1 installation and its published command parser. The release passed 119 package tests and clean registry-install checks. This guide does not claim a new funded NEAR AI/Qwen pair has been rehearsed end to end. Finish preparation before opening a paid subscription, and make one practice pass before recording.
