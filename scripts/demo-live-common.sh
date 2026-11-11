#!/usr/bin/env bash
# Launch helpers only. All agent operations go through the installed npm CLI.
set -Eeuo pipefail
umask 077

DEMO_VERSION=0.13.1
DEMO="${REMORA_DEMO:-$HOME/remora-shark-demo}"
ACTIVITY=portfolio-rebalance
RPC=https://test.rpc.fastnear.com
ASSETS=nep141:wrap.testnet,nep141:rft.tokenfactory.testnet
TOKENS=wrap.testnet,rft.tokenfactory.testnet
ACTION='{"poolId":0,"base":"wrap.testnet","amount":"2000000000000000000000","weights":{"wrap.testnet":2500,"rft.tokenfactory.testnet":7500}}'
PROMPT="Evaluate this testnet rebalance objective: $ACTION. Read strategy_guard, call strategy_preview, examine its live Rhea evidence, and use strategy_apply exactly once with this objective if the guard and preview permit it. Stop after a confirmed result or a refusal. Never invent execution."
if [[ -x /opt/homebrew/opt/node@22/bin/node ]]; then
  export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
fi
COLOR=always
TEAL=$'\033[36m'; GREEN=$'\033[32m'; AMBER=$'\033[33m'; CORAL=$'\033[31m'; RESET=$'\033[0m'
if [[ -n "${NO_COLOR+x}" || ! -t 1 ]]; then
  COLOR=never; TEAL=; GREEN=; AMBER=; CORAL=; RESET=
fi
heading() { printf '\n%s› %s%s\n' "$TEAL" "$*" "$RESET"; }
note() { printf '%s… %s%s\n' "$AMBER" "$*" "$RESET"; }
okay() { printf '%s✓ %s%s\n' "$GREEN" "$*" "$RESET"; }
die() { printf '%sStopped: %s%s\n' "$CORAL" "$*" "$RESET" >&2; exit 1; }
pause() { note "$*"; IFS= read -r -p 'Press Enter to continue: ' _; }
on_error() {
  printf '\n%sStopped at a failed step. No transaction is retried automatically.%s\n' "$CORAL" "$RESET" >&2
  printf 'Resolve the displayed error before rerunning. Demo state: %s\n' "$DEMO" >&2
}
trap on_error ERR

usage() {
  printf 'Usage: bash %s [--check | --help]\n' "$0"
  printf 'No flags: guided setup, then live demo. --check: read-only prerequisite checks.\n'
  printf 'Uses npm CLI %s; default project: %s\n' "$DEMO_VERSION" "$DEMO"
  printf 'Initial wallet approvals and hidden API-key prompts remain interactive.\n'
}

resolve_cli() {
  command -v node >/dev/null || die 'Install Node >=22.22.2 first.'
  node -e 'const [a,b,c]=process.versions.node.split(".").map(Number);process.exit(a>22||a===22&&(b>22||b===22&&c>=2)?0:1)' || die 'Node >=22.22.2 is required.'
  command -v npm >/dev/null || die 'npm is required.'
  command -v jq >/dev/null || die 'Install jq first (brew install jq).'
  CLI_ROOT="$(npm root -g)/@ola-893/agentstreams-cli"
  [[ ! -L "$CLI_ROOT" ]] || die 'The global package is npm-linked. Install the published npm package before this demo.'
  local installed=''
  if [[ -f "$CLI_ROOT/package.json" ]]; then
    installed=$(node -e 'console.log(require(process.argv[1]).version)' "$CLI_ROOT/package.json")
  fi
  if [[ "$installed" != "$DEMO_VERSION" ]]; then
    if [[ "$MODE" == --check ]]; then die "Install npm CLI: npm install -g @ola-893/agentstreams-cli@$DEMO_VERSION"; fi
    note "Installing @ola-893/agentstreams-cli@$DEMO_VERSION from npm."
    npm install -g "@ola-893/agentstreams-cli@$DEMO_VERSION"
  fi
  CLI="$CLI_ROOT/bin/agentstreams.mjs"
  [[ -f "$CLI" ]] || die 'The global npm CLI entry point is missing.'
  # npm root -g and an explicit node entry point bypass interactive aliases.
  [[ "$(node "$CLI" --version)" == "$DEMO_VERSION" ]] || die 'Unexpected installed CLI version.'
  okay "npm CLI $DEMO_VERSION · $CLI_ROOT"
}
cli() { node "$CLI" --color="$COLOR" "$@"; }
machine() { node "$CLI" --json --color=never "$@"; }
other() { AGENTSTREAMS_HOME="$DEMO/follower-state" cli "$@"; }
other_json() { AGENTSTREAMS_HOME="$DEMO/follower-state" machine "$@"; }

local_model_check() {
  local models
  models=$(curl --fail --silent --show-error --max-time 10 http://127.0.0.1:11434/v1/models)
  jq -e '.data | any(.id == "qwen2.5:1.5b")' <<< "$models" >/dev/null || die 'Run ollama pull qwen2.5:1.5b, and start Ollama.'
  okay 'Local Qwen is available.'
}

start_role() {
  local role=$1
  [[ -t 0 && -t 1 ]] || die 'Run this launcher in an interactive terminal; do not pipe its output.'
  mkdir -p "$DEMO"
  cd "$DEMO"
  DEMO=$(pwd -P)
  export AGENTSTREAMS_HOME="$DEMO/$role-state"
  mkdir -p "$AGENTSTREAMS_HOME"
  chmod 700 "$AGENTSTREAMS_HOME"
  LOCK="$DEMO/.$NAME-launch.lock"
  mkdir "$LOCK" 2>/dev/null || die "A $NAME launcher lock exists. Check $LOCK/pid and its process before removing a stale lock."
  printf '%s\n' "$$" > "$LOCK/pid"
  trap 'role_exit' EXIT
}
role_exit() {
  if [[ -n "${PUBLISH_PID:-}" ]]; then
    note "Shark publisher PID $PUBLISH_PID is still running. Keep it alive until Remora closes its stream."
    note "After closure: AGENTSTREAMS_HOME='$DEMO/leader-state' node '$CLI' --project '$DEMO' publish stop --agent shark"
    note "Then inspect PID $PUBLISH_PID before terminating that worker."
  fi
  [[ -z "${LOCK:-}" ]] || { rm -f "$LOCK/pid"; rmdir "$LOCK"; }
}

prepare_identity() {
  local exists state wallet
  exists=$(machine agent list)
  if ! jq -e --arg name "$NAME" '.agents | any(.name == $name)' <<< "$exists" >/dev/null; then
    cli agent create "$NAME"
  fi
  state=$(machine status --agent "$NAME")
  jq -e '(.pendingTrade | not) and (.subscription == null or .subscription.status == "stopped") and (.publicationEnabled | not)' <<< "$state" >/dev/null || die "Existing active or unresolved $NAME state. Inspect status and reconcile before setup."
  local lock
  while IFS= read -r lock; do
    [[ ! -f "$lock" ]] || die "Existing runner lock: $lock. Inspect its process before proceeding."
  done < <(find "$AGENTSTREAMS_HOME/agents" -path "*/$NAME/runner.lock" -type f)
  wallet=$(machine wallet show)
  if ! jq -e '.signer == "browser-wallet" and (.accountId | type == "string")' <<< "$wallet" >/dev/null; then
    cli wallet connect --network testnet --rpc "$RPC" --owner-id "${SELLER:-rudepuma4060.testnet}"
    wallet=$(machine wallet show)
  fi
  jq -e '.network == "testnet" and .signer == "browser-wallet" and (.accountId | type == "string")' <<< "$wallet" >/dev/null || die 'A connected testnet wallet is required.'
  if [[ -n "${SELLER:-}" ]]; then
    [[ "$(jq -r '.accountId' <<< "$wallet")" == "$SELLER" ]] || die 'This run expects the same owner wallet and separate execution accounts.'
  fi
  SELLER=$(jq -er '.accountId' <<< "$wallet")
  cli wallet show
  if [[ ! -f "$AGENTSTREAMS_HOME/outlayer-key.json" ]]; then
    note 'Enter the funded OutLayer compute API key; never enter a wallet private key.'
    cli outlayer key --api-key
  fi
  command -v outlayer-verify >/dev/null || die 'Install the OutLayer attestation verifier before publication.'
}

prepare_grant() {
  local grant id
  id=$(machine agent show "$NAME" | jq -er '.id')
  grant=$(machine grant show --agent "$NAME")
  if jq -e '.granted == true' <<< "$grant" >/dev/null; then
    jq -e --arg id "$id" '.agentId == $id and (.activities | index("portfolio-rebalance")) != null' <<< "$grant" >/dev/null || die 'Existing grant belongs to another agent or activity. Inspect grant show; do not overwrite it.'
    okay 'Reusing the active grant.'
  elif jq -e 'has("state") or has("pending")' <<< "$grant" >/dev/null; then
    cli grant show --agent "$NAME"
    die 'Existing inactive/pending grant must be reconciled or revoked before creating a replacement.'
  else
    note 'Approve the initial 0.25 test NEAR execution-account funding in your wallet.'
    cli grant create --agent "$NAME" --transactions 20 --hours 2 --activities "$ACTIVITY" --tokens "$TOKENS" --fund-near 0.25
  fi
  # Target balances: preparation reads current balances before submitting differences.
  cli grant prepare --agent "$NAME" --activity "$ACTIVITY" --token wrap.testnet --balance-raw 20000000000000000000000
  cli grant prepare --agent "$NAME" --activity "$ACTIVITY" --token rft.tokenfactory.testnet
  cli grant show --agent "$NAME"
}

wait_file() {
  local file=$1 message=$2
  note "$message"
  until [[ -f "$file" ]]; do sleep 2; done
}

MODE="${1:-run}"
case "$MODE" in
  --help|-h) usage; exit 0 ;;
  run|--check) ;;
  *) usage; exit 2 ;;
esac
resolve_cli
if [[ "$MODE" == --check ]]; then
  cli diagnostics
  local_model_check
  command -v outlayer-verify >/dev/null || die 'outlayer-verify is not on PATH.'
  okay 'Read-only checks passed. No agent, wallet, grant or stream was changed.'
  exit 0
fi
