# Source once in each idle demo pane. Only this shell's routing is changed.
function _remora_demo_source() {
  local role="$1"
  if [[ "$role" != leader && "$role" != follower ]]; then
    print -u2 'Use: source /path/to/scripts/demo-shell.zsh leader|follower'
    return 1
  fi
  local root="${${(%):-%x}:A:h:h}"
  local before="$(whence -w agentstream 2>/dev/null); PATH executable: ${commands[agentstream]:-<none>}"
  local body="$(functions agentstream 2>/dev/null)"
  local aliased="$(alias agentstream 2>/dev/null)"
  local requested_cli_root="${CLI_ROOT:-<unset>}"
  export REMORA_REPO="$root"
  export REMORA_DEMO="${REMORA_DEMO:-$HOME/remora-demo-013}"
  export REMORA_ROLE="$role"
  if [[ -z "$REMORA_NODE" ]]; then
    if [[ -x /opt/homebrew/opt/node@22/bin/node ]]; then
      export REMORA_NODE=/opt/homebrew/opt/node@22/bin/node
    elif [[ -x /usr/local/opt/node@22/bin/node ]]; then
      export REMORA_NODE=/usr/local/opt/node@22/bin/node
    else
      export REMORA_NODE="${commands[node]}"
    fi
  fi
  export CLI_ROOT="$root/packages/cli"
  export AGENTSTREAMS_HOME="$REMORA_DEMO/$role-state"
  cd "$REMORA_DEMO" || return
  unalias agentstream agentstreams remora 2>/dev/null
  function agentstream() { command "$REMORA_NODE" "$REMORA_REPO/packages/cli/bin/agentstreams.mjs" --color="${REMORA_COLOR:-always}" "$@"; }
  function agentstreams() { agentstream "$@"; }
  function remora() { command "$REMORA_NODE" "$REMORA_REPO/scripts/demo.mjs" --role "$REMORA_ROLE" --color="${REMORA_COLOR:-always}" "$@"; }
  # The short audit runs inside THIS live shell, so it can see aliases/functions.
  function remora-audit() {
    print -r -- "Pane: $REMORA_ROLE"
    print -r -- "Before: ${_REMORA_BEFORE:-<not captured>}"
    print -r -- "Previous CLI_ROOT: ${_REMORA_OLD_ROOT:-<unset>}"
    print -r -- "Now: $(whence -v agentstream) -> $CLI_ROOT/bin/agentstreams.mjs"
    command "$REMORA_NODE" "$CLI_ROOT/bin/agentstreams.mjs" diagnostics --color=always
  }
  typeset -g _REMORA_BEFORE="$before"
  typeset -g _REMORA_OLD_ROOT="$requested_cli_root"
  # Do not print arbitrary user function bodies; scan routing paths only.
  if [[ "$body $aliased" == *'/opt/homebrew/'* ]]; then
    _REMORA_BEFORE+=' (routes through Homebrew/global installation)'
  fi
  remora-audit
}
_remora_demo_source "$@"
unfunction _remora_demo_source
