#!/usr/bin/env bash
set -euo pipefail

unset TMUX TMUX_PANE
command -v tmux >/dev/null || { printf 'tmux is required\n' >&2; exit 2; }
command -v sleep >/dev/null || { printf 'sleep is required\n' >&2; exit 2; }

MANAGED_SOCKET="${ORCH_MANAGED_TMUX_SOCKET:-host-control-managed}"
SUPERVISOR_SECONDS="${PANEFLEET_TMUX_SUPERVISOR_SECONDS:-2}"
[[ "$MANAGED_SOCKET" =~ ^[A-Za-z0-9_.-]{1,128}$ ]] || { printf 'invalid ORCH_MANAGED_TMUX_SOCKET\n' >&2; exit 2; }
[[ "$SUPERVISOR_SECONDS" =~ ^[1-9][0-9]*$ && "$SUPERVISOR_SECONDS" -le 60 ]] || {
  printf 'invalid PANEFLEET_TMUX_SUPERVISOR_SECONDS\n' >&2
  exit 2
}

tmux_server() {
  local socket="$1"
  shift
  if [[ -n "$socket" ]]; then
    tmux -L "$socket" "$@"
  else
    tmux "$@"
  fi
}

ensure_server() {
  local socket="$1"
  if tmux_server "$socket" display-message -p '#{pid}' >/dev/null 2>&1; then
    return 0
  fi
  tmux_server "$socket" start-server \; set-option -g exit-empty off
  tmux_server "$socket" display-message -p '#{pid}' >/dev/null
}

# Keep both PaneFleet tmux servers alive inside this service cgroup. The default
# server owns normal agents and allowlisted services; the named server owns the
# isolated review agent. If tmux itself crashes, recreate only the empty server
# and let PaneFleet's exact-rollout recovery restore eligible agents.
ensure_server ''
ensure_server "$MANAGED_SOCKET"
while sleep "$SUPERVISOR_SECONDS"; do
  ensure_server ''
  ensure_server "$MANAGED_SOCKET"
done
