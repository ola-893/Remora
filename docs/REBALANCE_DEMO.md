# Two-terminal demo — CLI 0.13.0

The story: a NEAR AI leader proposes a real testnet rebalance; a local-model follower pays for the proposal, reviews it and executes at its own size. A later decision exceeds a tightened follower cap and is denied. Finally, the same paid session returns 200 before closure and 403 afterward.

Finish setup before recording. Use two fresh private state directories: execution grants are stored per owner, so sharing a state directory between these roles would conflict. Their execution accounts are separate. The subscription and swaps use NEAR testnet. Native Rhea swaps remain public; advance decisions use the encrypted OutLayer feed.

Prerequisites: Node 22.22.2+, jq, CLI 0.13.0, `outlayer-verify`, the installed Ollama `qwen2.5:1.5b` model, a NEAR AI API key, at least 4 test NEAR plus fees, and 0.002 Circle testnet USDC in the owner wallet. Use `rudepuma4060.testnet`, which owns your existing OutLayer compute key #2. The top-up helper mints faucet USDC.e and adds 0.1 to that compute key; this is separate from Circle subscription USDC.

The helper scripts use the installed CLI's modules. They do not change the released CLI or read owner wallet private keys. The close-proof helper calls the existing stream-close operation and prints HTTP status codes without printing the session credential. [Privacy and verification limits](IMPLEMENTATION_STATUS.md)

## Terminal 1 — one-time leader setup

```sh
REPO='/Users/deonorla/Documents/Github/agentstreams'
DEMO="$HOME/remora-demo-013"
CLI_ROOT="$(npm root -g)/@ola-893/agentstreams-cli"
mkdir -p "$DEMO"
cd "$DEMO"
export AGENTSTREAMS_HOME="$DEMO/leader-state"
mkdir -p "$AGENTSTREAMS_HOME"
chmod 700 "$AGENTSTREAMS_HOME"
cp -p "$HOME/.agentpay/outlayer-key.json" "$AGENTSTREAMS_HOME/outlayer-key.json"

agentstream --version
outlayer-verify --help >/dev/null
agentstream agent create leader
agentstream wallet connect --network testnet --owner-id rudepuma4060.testnet --rpc https://test.rpc.fastnear.com
node "$REPO/scripts/demo-compute-top-up.mjs" --cli-root "$CLI_ROOT"

NEAR_MODEL=$(agentstream inference models --provider near-ai --json | jq -er '[.models[] | select(.agentCompatible)][0].id')
agentstream inference set --agent leader --provider near-ai --model "$NEAR_MODEL" --api-key --timeout-seconds 120
agentstream inference show --agent leader

agentstream task enable portfolio-rebalance --agent leader
agentstream guard set execution --agent leader --activity portfolio-rebalance \
  --targets 0 --assets nep141:wrap.testnet,nep141:rft.tokenfactory.testnet \
  --max-inputs nep141:wrap.testnet=2000000000000000000000 --max-age 120 --max-slippage-bps 100
agentstream grant create --agent leader --transactions 20 --hours 2 --activities portfolio-rebalance \
  --tokens wrap.testnet,rft.tokenfactory.testnet --fund-near 0.25
agentstream grant prepare --agent leader --activity portfolio-rebalance --token wrap.testnet --balance-raw 20000000000000000000000
agentstream grant prepare --agent leader --activity portfolio-rebalance --token rft.tokenfactory.testnet
agentstream grant show --agent leader

ACTION='{"poolId":0,"base":"wrap.testnet","amount":"2000000000000000000000","weights":{"wrap.testnet":2500,"rft.tokenfactory.testnet":7500}}'
agentstream task run portfolio-rebalance --agent leader --action-json "$ACTION"
SELLER=$(agentstream wallet show --json | jq -er '.accountId')
printf '%s\n' "$SELLER" > "$DEMO/seller.txt"
agentstream publish set --agent leader --delivery outlayer --activities portfolio-rebalance \
  --recipient "$SELLER" --rate 0.000001 --duration 900 --signal-window 30
agentstream publish start --agent leader
agentstream agent show leader --json | jq -er '.id' > "$DEMO/leader-id.txt"
agentstream agent run --agent leader --json > "$DEMO/leader-feed.log" 2>&1 &
PUBLISH_PID=$!
```

Approve initial wallet setup requests. Enter only the NEAR AI API key at the CLI's hidden prompt. The `cp` above copies an already configured OutLayer compute credential locally, without displaying it; it copies no wallet key. Run this setup once in a fresh demo directory. Start Terminal 2 next, and finish its setup before asking the leader to act.

## Terminal 2 — one-time follower setup

```sh
REPO='/Users/deonorla/Documents/Github/agentstreams'
DEMO="$HOME/remora-demo-013"
CLI_ROOT="$(npm root -g)/@ola-893/agentstreams-cli"
cd "$DEMO"
export AGENTSTREAMS_HOME="$DEMO/follower-state"
mkdir -p "$AGENTSTREAMS_HOME"
chmod 700 "$AGENTSTREAMS_HOME"
cp -p "$HOME/.agentpay/outlayer-key.json" "$AGENTSTREAMS_HOME/outlayer-key.json"
SELLER=$(cat "$DEMO/seller.txt")
LEADER_ID=$(cat "$DEMO/leader-id.txt")

agentstream agent create follower
agentstream wallet connect --network testnet --owner-id "$SELLER" --rpc https://test.rpc.fastnear.com
agentstream inference set --agent follower --provider local --base-url http://127.0.0.1:11434/v1 \
  --model qwen2.5:1.5b --max-output-tokens 384 --timeout-seconds 45
curl -fsS http://127.0.0.1:11434/v1/chat/completions -H 'Content-Type: application/json' \
  --data '{"model":"qwen2.5:1.5b","messages":[{"role":"user","content":"Reply ready."}],"max_tokens":8}' | jq -r '.choices[0].message.content'
agentstream inference show --agent follower

agentstream agent setup --agent follower --network testnet --recipient "$SELLER" --rpc https://test.rpc.fastnear.com --deploy
agentstream guard set payment --agent follower --budget 0.01 --max-stream 0.002 \
  --max-rate 0.000001 --max-duration 900 --recipient "$SELLER"
agentstream fund 0.002 --agent follower
agentstream payments --enable --agent follower
agentstream guard set payment --agent follower --poll-seconds 10 --idle-timeout 600 --close-on-exit false

agentstream task enable portfolio-rebalance --agent follower
agentstream guard set execution --agent follower --activity portfolio-rebalance \
  --targets 0 --assets nep141:wrap.testnet,nep141:rft.tokenfactory.testnet \
  --max-inputs nep141:wrap.testnet=1000000000000000000000 --copy-bps 5000 --max-age 120 --max-slippage-bps 100
agentstream grant create --agent follower --transactions 20 --hours 2 --activities portfolio-rebalance \
  --tokens wrap.testnet,rft.tokenfactory.testnet --fund-near 0.25
agentstream grant prepare --agent follower --activity portfolio-rebalance --token wrap.testnet --balance-raw 20000000000000000000000
agentstream grant prepare --agent follower --activity portfolio-rebalance --token rft.tokenfactory.testnet
agentstream grant show --agent follower
```

The preview in Terminal 1 must succeed, both grants must report active, and the local completion must return text before recording. Fresh deployment needs browser-approved funding and configuration; do not skip failed setup commands. A grant preparation failure must be reconciled before repeating any uncertain transaction.

## Record — Terminal 2 starts paying and listening

```sh
agentstream copy "$LEADER_ID" --agent follower
agentstream guard show --agent follower
agentstream copy start "$LEADER_ID" --activity portfolio-rebalance --agent follower
agentstream copy mode veto --agent follower --veto-seconds 45
agentstream stream status --agent follower
agentstream agent run --agent follower --json > "$DEMO/follower.log" 2>&1 &
FOLLOWER_PID=$!
tail -f "$DEMO/follower.log"
```

`Ctrl+C` stops this log viewer, while the follower remains running in the background. Do not close the terminal. The 900-second offer lasts at most 15 minutes; the idle policy is 10 minutes, so perform the two decisions and closure promptly.

## Record — Terminal 1 asks for the first decision

```sh
agentstream inference show --agent leader
agentstream agent run --agent leader --activity portfolio-rebalance --max-steps 8 \
  --prompt "Evaluate this testnet rebalance objective: $ACTION. Read strategy_guard, call strategy_preview, examine its live Rhea evidence, and use strategy_apply exactly once if the guard and preview permit it. Explain your decision using the returned evidence. Stop after the confirmed result or a refusal."
agentstream signal list --agent leader
```

Show the NEAR AI tool output, `evidence.source` / Rhea venue data, the proposal and the receipt. In Terminal 2, wait for a `copy-review` note and an execution with `status: wallet-confirmed`. Allow the 30-second leader window and the follower's 45-second veto window; they overlap. Keep the publisher running.

## Record — Terminal 2 tightens its own limit

Press `Ctrl+C` to leave the log viewer, then run:

```sh
agentstream copy history --agent follower --json | jq '.history[-12:]'
agentstream guard set execution --agent follower --activity portfolio-rebalance \
  --max-inputs nep141:wrap.testnet=500000000000000000000
agentstream guard show --agent follower
tail -f "$DEMO/follower.log"
```

The follower still copies at 50%, but now permits at most 0.0005 wNEAR. The next leader objective allows 0.002 wNEAR, making the copied request 0.001 wNEAR. For this freshly funded portfolio, that exceeds the follower cap. This demonstrates a deterministic guard denial, not an owner veto or a model changing policy.

## Record — Terminal 1 asks for the second decision

Run the same `agentstream agent run ... --prompt ...` command again. The leader's limits are unchanged. Terminal 2 should report `status: skipped` with `STRATEGY_INPUT_LIMIT`; the second follower action must have no transaction receipt. If the leader reports a refusal or an uncertain transaction, investigate it rather than claiming that a second action executed.

An optional owner-veto demonstration uses `agentstream copy pending --agent follower`, then `agentstream copy block ACTION_ID --agent follower` before `blockUntil`. Do that on an eligible candidate with the original larger cap. The block command prints `status: blocked`; it is distinct from `STRATEGY_INPUT_LIMIT`.

## Record — Terminal 2 closes and proves denied access

Press `Ctrl+C` to leave the log viewer. Stop the follower runner and wait for it to release its state lock. `close-on-exit false` deliberately preserves the active stream for this single close-and-probe command.

```sh
kill -TERM "$FOLLOWER_PID"
wait "$FOLLOWER_PID"
node "$REPO/scripts/demo-close-proof.mjs" --project "$DEMO" --agent follower --cli-root "$CLI_ROOT"
agentstream stream status --agent follower
agentstream copy history --agent follower --json | jq '.history[-12:]'
```

The helper must print `beforeCloseHTTP: 200`, a real `closeTransaction`, and `afterCloseHTTP: 403` for the same in-memory session credential. It prints actual results and exits unsuccessfully if these assertions fail. Keep the leader running until after the proof, so the denial comes from stream closure rather than publisher shutdown. If the helper fails before closing, run `agentstream copy stop --agent follower` and inspect the stream status.

## Cleanup — after the recording

Terminal 2:

```sh
agentstream grant revoke --agent follower
```

Terminal 1:

```sh
agentstream publish stop --agent leader
kill -TERM "$PUBLISH_PID"
wait "$PUBLISH_PID"
agentstream grant revoke --agent leader
```

Revocation sweeps recoverable grant assets before deleting the execution account. For an uncertain transaction, use the relevant `wallet reconcile`, `grant reconcile` or `signal reconcile ID --hash HASH` command before retrying. This runbook has been checked against CLI 0.13.0 and the current public Rhea pool, but a newly provisioned NEAR AI rebalance pair has not been fully rehearsed with these exact setup commands. The new encrypted delivery lifecycle was live-tested with signed paper quotes and real testnet subscription payments.
