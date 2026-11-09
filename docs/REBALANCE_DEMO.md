# Ten-minute rebalance with a NEAR AI leader and a local follower

The leader uses NEAR AI to submit guarded rebalances on Rhea Exchange pool `0` on testnet. The follower uses a local model to review each copied candidate. You approve the candidate in the CLI and the follower's grant signs it. Both roles use separate funded execution accounts, even if you connect the same Meteor owner in both terminals.

Use Node.js 22.22.2 or later, `jq`, a NEAR AI API key, and a running local OpenAI-compatible endpoint such as Ollama. The browser wallet needs at least 6 test NEAR for fresh vault setup, additional test NEAR for two grants and fees, and 0.002 Circle testnet USDC for the follower. Finish wallet setup before starting the ten-minute clock. [Testnet setup and faucet](NEAR.md)

```sh
npm install -g @ola-893/agentstreams-cli@0.10.0
agentstream --version
```

## Terminal 1. Prepare the NEAR AI leader and start its feed

Use a fresh workspace. `AGENTSTREAMS_HOME` separates the two roles' local state and grants. Enter the inference key through the CLI's hidden prompt.

```sh
DEMO="$HOME/remora-rebalance-demo"
mkdir -p "$DEMO"
cd "$DEMO"
export AGENTSTREAMS_HOME="$DEMO/leader-state"

agentstream agent create leader
agentstream wallet connect --network testnet
SELLER=$(agentstream wallet show | jq -er '.accountId')
agentstream inference models --provider near-ai | jq -r '.models[].id'
NEAR_MODEL='Qwen/Qwen3.6-35B-A3B-FP8'
agentstream inference set --agent leader --provider near-ai --model "$NEAR_MODEL" \
  --api-key --timeout-seconds 40
agentstream inference show --agent leader

agentstream task enable portfolio-rebalance --agent leader
agentstream guard set execution --agent leader --activity portfolio-rebalance \
  --targets 0 --assets nep141:wrap.testnet,nep141:rft.tokenfactory.testnet \
  --max-inputs nep141:wrap.testnet=2000000000000000000000 --max-age 120 --max-slippage-bps 100
agentstream grant create --agent leader --transactions 20 --hours 2 \
  --activities portfolio-rebalance --tokens wrap.testnet,rft.tokenfactory.testnet --fund-near 0.25
agentstream grant prepare --agent leader --activity portfolio-rebalance \
  --token wrap.testnet --balance-raw 20000000000000000000000
agentstream grant show

ACTION='{"poolId":0,"base":"wrap.testnet","amount":"2000000000000000000000","weights":{"wrap.testnet":2500,"rft.tokenfactory.testnet":7500}}'
agentstream task run portfolio-rebalance --agent leader --action-json "$ACTION"

ORIGIN='http://127.0.0.1:5380'
agentstream publish set --agent leader --activities portfolio-rebalance \
  --url "$ORIGIN" --recipient "$SELLER" --rate 0.000001 --duration 900
agentstream publish start --agent leader
agentstream agent run --agent leader > "$DEMO/leader-feed.log" 2>&1 &
PUBLISH_PID=$!
```

If the example model ID has changed, choose a listed ID. Keep the feed process running and copy the full `id` from `publish start` and the `SELLER` account to Terminal 2. A follower only receives actions published after its stream opens.

## Terminal 2. Prepare the local follower and open the stream

Configure a small local model and prepare the second grant before opening the stream. The example uses Ollama. If you use a different local endpoint, set `LOCAL_URL` and `LOCAL_MODEL` to match it.

```sh
DEMO="$HOME/remora-rebalance-demo"
cd "$DEMO"
export AGENTSTREAMS_HOME="$DEMO/follower-state"
ORIGIN='http://127.0.0.1:5380'
SELLER='REPLACE_WITH_THE_LEADER_WALLET.testnet'
PUBLISHER_ID='REPLACE_WITH_THE_FULL_ap_ID'

agentstream agent create follower
agentstream wallet connect --network testnet
LOCAL_URL='http://127.0.0.1:11434/v1'
LOCAL_MODEL='qwen2.5:1.5b'
ollama pull "$LOCAL_MODEL"
curl -fsS "$LOCAL_URL/models" | jq -r '.data[].id'
curl -fsS --max-time 90 "$LOCAL_URL/chat/completions" -H 'Content-Type: application/json' \
  --data "$(jq -cn --arg model "$LOCAL_MODEL" '{model:$model,messages:[{role:"user",content:"Reply ready."}],max_tokens:8}')" \
  | jq -er '.choices[0].message.content'
agentstream inference set --agent follower --provider local --base-url "$LOCAL_URL" --model "$LOCAL_MODEL" \
  --max-output-tokens 384
agentstream inference show --agent follower

agentstream agent setup --agent follower --network testnet --recipient "$SELLER"
agentstream agent setup --agent follower --network testnet --recipient "$SELLER" --deploy
agentstream guard set payment --agent follower --budget 0.01 --max-stream 0.002 \
  --max-rate 0.000001 --max-duration 900 --recipient "$SELLER"
agentstream fund 0.002 --agent follower
agentstream payments --enable --agent follower

agentstream task enable portfolio-rebalance --agent follower
agentstream guard set execution --agent follower --activity portfolio-rebalance \
  --targets 0 --assets nep141:wrap.testnet,nep141:rft.tokenfactory.testnet \
  --max-inputs nep141:wrap.testnet=1000000000000000000000 --copy-bps 5000 \
  --max-age 120 --max-slippage-bps 100
agentstream grant create --agent follower --transactions 20 --hours 2 \
  --activities portfolio-rebalance --tokens wrap.testnet,rft.tokenfactory.testnet --fund-near 0.25
agentstream grant prepare --agent follower --activity portfolio-rebalance \
  --token wrap.testnet --balance-raw 20000000000000000000000
agentstream grant show

agentstream copy "$PUBLISHER_ID" --url "$ORIGIN" --agent follower
agentstream copy start "$PUBLISHER_ID" --url "$ORIGIN" --activity portfolio-rebalance --agent follower
agentstream copy mode approve --agent follower
```

The 900-second offer reserves 0.0009 test USDC and leaves time to close after the ten-minute run. If setup took several minutes, run the short local completion again before starting the leader.

## Start the clock in Terminal 1

Run five NEAR AI passes spaced two minutes apart. Each pass asks for one guarded swap of at most 0.002 test wNEAR. The shell stops on a missing or unconfirmed result so you can investigate before submitting again. The final wait brings the session to ten minutes if each pass finishes within its slot.

```sh
(
  set -e
  STARTED=$(date +%s)
  for PASS in 0 1 2 3 4; do
    DELAY=$((STARTED + PASS * 120 - $(date +%s)))
    if [ "$DELAY" -gt 0 ]; then sleep "$DELAY"; fi
    RESULT=$(agentstream agent run --agent leader --activity portfolio-rebalance --max-steps 8 --json \
      --prompt "Do exactly one testnet portfolio-rebalance using this action: $ACTION. Call strategy_guard, strategy_preview, then strategy_apply with that exact action once. Stop after the tool returns. If a guard refuses, report the refusal and stop.")
    printf '%s\n' "$RESULT" | jq '{activity, result, inference: [.events[] | select(.type == "inference")]}'
    printf '%s\n' "$RESULT" | jq -e '.results | length == 1 and (.[0].transactionHash != null) and (.[0].signing == "grant")' >/dev/null
  done
  DELAY=$((STARTED + 600 - $(date +%s)))
  if [ "$DELAY" -gt 0 ]; then sleep "$DELAY"; fi
)
agentstream publish history --agent leader
```

## Copy each round in Terminal 2

After the leader prints a transaction hash, run these commands. The first command polls once and waits for the local review. Look for `type: copy-review` with its note, then choose the matching pending action. Approve promptly. The signed action expires after two minutes.

```sh
agentstream agent run --agent follower --once
agentstream copy pending --agent follower
ACTION_ID='REPLACE_WITH_THE_PENDING_ACTION_ID'
agentstream copy approve "$ACTION_ID" --agent follower
agentstream copy history --agent follower
```

Repeat for the next round. The follower applies the same target weights with half the leader's maximum input. The venue plan, quote and receipt are for the follower's own execution account. `copy approve` remains required. A matching grant signs the Rhea transaction without a new Meteor window. An unavailable local review is shown separately from execution status.

## Close and recover

In Terminal 2, close the paid stream before stopping the publisher.

```sh
agentstream copy stop --agent follower
agentstream copy status --agent follower
agentstream grant revoke --agent follower
```

In Terminal 1, stop publication and recover the leader's grant balance.

```sh
agentstream publish stop --agent leader
kill "$PUBLISH_PID"
agentstream grant revoke --agent leader
```

For an uncertain wallet or grant transaction, use `wallet reconcile` or `grant reconcile` in the terminal for that role before retrying. [Recovery details](EXECUTION_GRANTS.md#recover-funds)
