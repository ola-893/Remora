#!/usr/bin/env bash
# Terminal 2: local Qwen follower. Runtime uses the published npm package only.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/demo-live-common.sh"
NAME=remora-agents
heading 'REMORA · Terminal 2 · preparation'
start_role follower
local_model_check
wait_file "$DEMO/shark-ready.json" 'Waiting for Shark setup in Terminal 1.'
ready=$(cat "$DEMO/shark-ready.json")
SHARK_ID=$(jq -er '.id' <<< "$ready")
SELLER=$(jq -er '.seller' <<< "$ready")
RUN_ID=$(jq -er '.run' <<< "$ready")
SHARK_PID=$(jq -er '.pid' <<< "$ready")
kill -0 "$SHARK_PID" 2>/dev/null || die 'The saved Shark launcher is no longer running. Start Terminal 1 first.'
prepare_identity
cli inference set --agent remora-agents --provider local --base-url http://127.0.0.1:11434/v1 \
  --model qwen2.5:1.5b --max-output-tokens 384 --timeout-seconds 45
cli inference show --agent remora-agents
setup=$(machine agent show remora-agents)
if ! jq -e '.setup.configured == true' <<< "$setup" >/dev/null; then
  cli agent setup --agent remora-agents --network testnet --recipient "$SELLER" --rpc "$RPC" --deploy
fi
cli guard set payment --agent remora-agents --budget 0.01 --max-stream 0.002 \
  --max-rate 0.000001 --max-duration 900 --recipient "$SELLER"
balance=$(machine balance --agent remora-agents)
jq -e '.vault.active_session == null and .vault.pending_total == "0"' <<< "$balance" >/dev/null || die 'An active session or pending vault transfer requires inspection first.'
FUND=$(node -e 'const x=JSON.parse(process.argv[1]);const a=BigInt(x.vault.available);const d=2000n-a;console.log(d>0n?"0."+d.toString().padStart(6,"0"):"0")' "$balance")
if [[ "$FUND" != 0 ]]; then cli fund "$FUND" --agent remora-agents; fi
cli payments --enable --agent remora-agents
cli guard set payment --agent remora-agents --poll-seconds 10 --idle-timeout 600 --close-on-exit false
cli task enable "$ACTIVITY" --agent remora-agents
cli guard set execution --agent remora-agents --activity "$ACTIVITY" --targets 0 --assets "$ASSETS" \
  --max-inputs nep141:wrap.testnet=1000000000000000000000 --copy-bps 5000 --max-age 120 --max-slippage-bps 100
prepare_grant
printf 'ready\n' > "$DEMO/$RUN_ID-remora-ready"
wait_file "$DEMO/$RUN_ID-record" 'Setup complete. Terminal 1 controls the start of recording.'
heading 'REMORA · subscribe to Shark'
cli copy "$SHARK_ID" --agent remora-agents
cli guard show --agent remora-agents
close_stream() {
  CLOSURE_ATTEMPTED=1
  heading 'REMORA · close payment'
  cli copy stop --agent remora-agents || return
  cli copy status --agent remora-agents || return
  cli stream status --agent remora-agents || return
  cli payments --disable --agent remora-agents || return
  local status balance
  status=$(machine copy status --agent remora-agents) || return
  balance=$(machine balance --agent remora-agents) || return
  jq -e '.subscription.status == "stopped" and (.tradePending | not)' <<< "$status" >/dev/null || return
  jq -e '.vault.active_session == null' <<< "$balance" >/dev/null || return
  STREAM_OPEN=0
  printf 'closed\n' > "$DEMO/$RUN_ID-closed"
  okay 'Payment is closed and automatic payment reopening is disabled.'
}
remora_exit() {
  if [[ "${STREAM_OPEN:-0}" == 1 ]]; then
    if [[ "${CLOSURE_ATTEMPTED:-0}" == 0 ]]; then
      note 'Closing the subscription opened by this launcher before exit.'
      close_stream || true
    fi
    if [[ "${STREAM_OPEN:-0}" == 1 ]]; then
      printf 'Closure is unconfirmed. Inspect/reconcile before retrying.\n' >&2
      printf "AGENTSTREAMS_HOME='%s/follower-state' node '%s' --project '%s' copy status --agent remora-agents\n" "$DEMO" "$CLI" "$DEMO" >&2
    fi
  fi
  role_exit
}
trap remora_exit EXIT
trap 'exit 143' TERM
cli copy start "$SHARK_ID" --activity "$ACTIVITY" --agent remora-agents
STREAM_OPEN=1
cli copy mode veto --agent remora-agents --veto-seconds 45
printf 'subscribed\n' > "$DEMO/$RUN_ID-subscribed"
note 'Live local-model review and timed veto. Leave this runner in the foreground.'
note 'After the second decision is blocked, press Ctrl+C ONCE. This launcher will close the stream.'
# Bash must survive the foreground child's Ctrl+C so closure runs afterward.
trap ':' INT
if cli agent run --agent remora-agents; then
  runner_status=0
else
  runner_status=$?
fi
trap - INT
if [[ "$runner_status" != 0 && "$runner_status" != 130 ]]; then
  note "Runner exited with status $runner_status. Closing its subscription; inspect its last result."
fi
close_stream || die 'Closure is unconfirmed. Do not claim payment stopped; inspect and reconcile.'
okay 'Grants remain funded for reuse. No grants were revoked automatically.'
