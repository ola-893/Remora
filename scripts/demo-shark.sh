#!/usr/bin/env bash
# Terminal 1: NEAR AI leader. Runtime uses the published npm package only.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/demo-live-common.sh"
NAME=shark_agent
heading 'SHARK · Terminal 1 · preparation'
start_role leader
local_model_check
prepare_identity
local_inference=$(machine inference show --agent shark_agent)
if ! jq -e '.provider == "near-ai" and .apiKeyStored == true' <<< "$local_inference" >/dev/null; then
  MODEL=$(machine inference models --provider near-ai | jq -er '[.models[] | select(.agentCompatible)][0].id')
  cli inference set --agent shark_agent --provider near-ai --model "$MODEL" --api-key --timeout-seconds 120
fi
cli inference show --agent shark_agent
cli task enable "$ACTIVITY" --agent shark_agent
cli guard set execution --agent shark_agent --activity "$ACTIVITY" --targets 0 --assets "$ASSETS" \
  --max-inputs nep141:wrap.testnet=2000000000000000000000 --max-age 120 --max-slippage-bps 100
prepare_grant
cli task run "$ACTIVITY" --agent shark_agent --action-json "$ACTION"
cli publish set --agent shark_agent --delivery outlayer --activities "$ACTIVITY" --recipient "$SELLER" \
  --rate 0.000001 --duration 900 --signal-window 30
cli publish start --agent shark_agent
SHARK_ID=$(machine agent show shark_agent | jq -er '.id')
RUN_ID="$(date +%s)-$$"
RUN_STARTED=$(node -p 'new Date().toISOString()')
printf '%s\n' "$SHARK_ID" > "$DEMO/shark-id.txt"
printf '%s\n' "$SELLER" > "$DEMO/seller.txt"
# Internal transport worker only. The decision and follower runners stay human/foreground.
node "$CLI" agent run --agent shark_agent --json > "$DEMO/shark-feed.log" 2>&1 &
PUBLISH_PID=$!
sleep 2
kill -0 "$PUBLISH_PID" 2>/dev/null || die "Publisher exited. Inspect $DEMO/shark-feed.log before retrying."
jq -n --arg run "$RUN_ID" --arg id "$SHARK_ID" --arg seller "$SELLER" --argjson pid "$$" \
  '{run:$run,id:$id,seller:$seller,pid:$pid}' > "$DEMO/shark-ready.tmp"
mv "$DEMO/shark-ready.tmp" "$DEMO/shark-ready.json"
okay 'Shark is ready. Run the Remora command in Terminal 2.'
wait_file "$DEMO/$RUN_ID-remora-ready" 'Waiting for Remora setup to finish.'
pause 'Both setups are complete. Start recording now; Remora subscribes after you continue.'
printf 'start\n' > "$DEMO/$RUN_ID-record"
wait_file "$DEMO/$RUN_ID-subscribed" 'Waiting for Remora to subscribe and start its foreground runner.'
heading 'SHARK · useful decision from NEAR AI'
cli inference show --agent shark_agent
cli agent run --agent shark_agent --activity "$ACTIVITY" --max-steps 8 --prompt "$PROMPT"
cli signal list --agent shark_agent
pause 'Watch Terminal 2. Continue only after an actual confirmed Remora execution. A preview is not settlement.'
confirmed=$(other_json copy history --agent remora_agents)
jq -e --arg since "$RUN_STARTED" '.history | any(.at >= $since and .type == "strategy" and .status == "wallet-confirmed")' <<< "$confirmed" >/dev/null || die 'No confirmed follower strategy execution was recorded in this run. Inspect history before continuing.'
heading 'REMORA · tighten its independent input limit'
other guard set execution --agent remora_agents --activity "$ACTIVITY" --max-inputs nep141:wrap.testnet=500000000000000000000
other guard show --agent remora_agents
cap=$(other_json guard show --agent remora_agents | jq -er '.strategyExecution["portfolio-rebalance"].caps["nep141:wrap.testnet"]')
[[ "$cap" == 500000000000000000000 ]] || die 'Follower cap was not changed; no second decision was requested.'
heading 'SHARK · second decision, same objective'
cli agent run --agent shark_agent --activity "$ACTIVITY" --max-steps 8 --prompt "$PROMPT"
pause 'Watch Remora for the real outcome. Continue after the guard denial is visible.'
denied=$(other_json copy history --agent remora_agents)
jq -e --arg since "$RUN_STARTED" '.history | any(.at >= $since and .status == "skipped" and ((.reason // "") | startswith("STRATEGY_INPUT_LIMIT")))' <<< "$denied" >/dev/null || die 'No STRATEGY_INPUT_LIMIT denial was recorded in this run. Do not narrate a denial without evidence.'
okay 'The follower recorded a deterministic input-limit denial.'
printf 'close\n' > "$DEMO/$RUN_ID-close"
note 'Terminal 2: press Ctrl+C once to stop the viewed runner. Its launcher will close payment and show the receipt.'
wait_file "$DEMO/$RUN_ID-closed" 'Keeping the publisher alive until Remora confirms stream closure.'
heading 'SHARK · finish publication'
cli publish stop --agent shark_agent
kill -TERM "$PUBLISH_PID" 2>/dev/null || true
wait "$PUBLISH_PID" 2>/dev/null || true
PUBLISH_PID=
rm -f "$DEMO/shark-ready.json"
okay 'Demo complete. Grants remain funded for reuse; revoke them separately when finished.'
