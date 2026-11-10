# Prepare the rebalance demo before recording

This page contains owner-approved setup, funding and grant operations. Do these before recording, one command at a time. **Do not rerun provisioning to inspect formatting.** Inspect existing state first with `remora inspect`, `agentstream grant show`, `agentstream stream status` and the helper `--check` options. An uncertain operation must be reconciled before repeating it.

Use the working checkout, not npm 0.13.0: its version number is shared with the unpublished presentation changes. Each sourced demo shell pins `CLI_ROOT`, the CLI function, subprocesses and a working Node 22 executable. The two roles have separate state homes. `source` prints an audit of the actual shell's prior resolution and the selected checkout revision/fingerprint.

Prerequisites: Node 22.22.2+, jq, `outlayer-verify`, Ollama with `qwen2.5:1.5b`, a NEAR AI API key, and the testnet balances described by the wallet requests. Use `rudepuma4060.testnet`, the owner of compute key #2. All owner keys remain in the browser wallet; enter only inference API keys at hidden CLI prompts.

The top-up helper is optional when the existing compute balance is sufficient. It requests **0.1 test USDC.e** and does not fund the separate Circle test USDC subscription vault. Use `"$REMORA_NODE" "$REPO/scripts/demo-compute-top-up.mjs" --check` for a read-only check.

## Terminal 1 — one-time leader setup

```sh
REPO='/Users/deonorla/Documents/Github/agentstreams'
DEMO="$HOME/remora-demo-013"
mkdir -p "$DEMO"
source "$REPO/scripts/demo-shell.zsh" leader
cd "$DEMO"
export AGENTSTREAMS_HOME="$DEMO/leader-state"
mkdir -p "$AGENTSTREAMS_HOME"
chmod 700 "$AGENTSTREAMS_HOME"
cp -p "$HOME/.agentpay/outlayer-key.json" "$AGENTSTREAMS_HOME/outlayer-key.json"

agentstream --version
outlayer-verify --help >/dev/null
agentstream agent create leader
agentstream wallet connect --network testnet --owner-id rudepuma4060.testnet --rpc https://test.rpc.fastnear.com
"$REMORA_NODE" "$REPO/scripts/demo-compute-top-up.mjs" --cli-root "$CLI_ROOT"

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
"$REMORA_NODE" "$CLI_ROOT/bin/agentstreams.mjs" agent run --agent leader --json > "$DEMO/leader-feed.log" 2>&1 &
PUBLISH_PID=$!
printf '%s\n' "$PUBLISH_PID" > "$DEMO/leader-feed.pid"
```

Approve initial wallet setup requests. Enter only the NEAR AI API key at the CLI's hidden prompt. The `cp` above copies an already configured OutLayer compute credential locally, without displaying it; it copies no wallet key. Run this setup once in a fresh demo directory. Start Terminal 2 next, and finish its setup before asking the leader to act.

## Terminal 2 — one-time follower setup

```sh
REPO='/Users/deonorla/Documents/Github/agentstreams'
DEMO="$HOME/remora-demo-013"
source "$REPO/scripts/demo-shell.zsh" follower
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


## Before recording

- Verify the leader preview succeeds, both grants are active, and both inference configurations are present.
- The background leader process above is an internal feed service. Its JSON log is for diagnostics, not the visible presentation. The follower runs in the foreground during recording.
- Keep `close-on-exit false` for the follower as configured above. Exiting its runner leaves the stream charging until it is explicitly closed or exhausted. Do not interrupt a different existing runner without checking its state and exit policy.
- Never paste commands into the hidden API-key prompt; finish or cancel that input first.

Then follow [the short two-terminal recording sequence](REBALANCE_DEMO.md).
