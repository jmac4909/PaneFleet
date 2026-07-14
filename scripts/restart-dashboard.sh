#!/usr/bin/env bash
set -euo pipefail

UNIT="${ORCH_SYSTEMD_UNIT:-agent-orchestrator.service}"
HOST="${ORCH_HEALTH_HOST:-127.0.0.1}"
PORT="${ORCH_PORT:-8787}"
HEALTH_URL="http://$HOST:$PORT/healthz"
LOCK_FILE="${XDG_RUNTIME_DIR:-/tmp}/agent-orchestrator-restart.lock"

[[ "$PORT" =~ ^[0-9]+$ ]] && (( PORT >= 1 && PORT <= 65535 )) || {
  printf 'invalid ORCH_PORT\n' >&2
  exit 2
}

command -v systemctl >/dev/null || { printf 'systemctl is required\n' >&2; exit 2; }
command -v curl >/dev/null || { printf 'curl is required\n' >&2; exit 2; }
command -v flock >/dev/null || { printf 'flock is required\n' >&2; exit 2; }
command -v ss >/dev/null || { printf 'ss is required\n' >&2; exit 2; }

workload_inventory() {
  if ! command -v tmux >/dev/null || ! tmux list-panes -a >/dev/null 2>&1; then
    printf 'server=absent\n'
    return 0
  fi
  local panes
  panes="$(tmux list-panes -a -F '#{session_name}|#{session_id}|#{session_created}|#{window_index}.#{pane_index}|#{pane_id}|#{pane_pid}|#{pane_start_command}' 2>/dev/null \
    | awk -F '|' '$1 != "agent-orchestrator" && $1 != "agent-orchestrator-watchdog"' \
    | LC_ALL=C sort)"
  if [[ -n "$panes" ]]; then
    printf '%s\n' "$panes"
  else
    printf 'server=present:no-workloads\n'
  fi
}

exec 9>"$LOCK_FILE"
flock -n 9 || { printf 'another Host Control restart is already running\n' >&2; exit 3; }

systemctl --user is-enabled --quiet "$UNIT" || {
  printf '%s is not installed and enabled; run scripts/install-control-plane.sh --migrate first\n' "$UNIT" >&2
  exit 4
}

before="$(workload_inventory)"
systemctl --user restart "$UNIT"

ready=0
for _ in $(seq 1 80); do
  if systemctl --user is-active --quiet "$UNIT" && curl -fsS --max-time 2 "$HEALTH_URL" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 0.25
done

if [[ "$ready" != 1 ]]; then
  printf 'Host Control did not become healthy after restart\n' >&2
  systemctl --user --no-pager --full status "$UNIT" >&2 || true
  exit 5
fi

sleep 0.25
curl -fsS --max-time 2 "$HEALTH_URL" >/dev/null 2>&1 || {
  printf 'Host Control health was not stable across two samples\n' >&2
  exit 5
}

main_pid="$(systemctl --user show "$UNIT" -p MainPID --value)"
listener="$(ss -H -ltnp "sport = :$PORT" 2>/dev/null || true)"
if [[ ! "$main_pid" =~ ^[1-9][0-9]*$ || "$listener" != *"pid=$main_pid,"* ]]; then
  printf 'port %s listener is not owned by %s MainPID %s\n' "$PORT" "$UNIT" "${main_pid:-unknown}" >&2
  exit 5
fi

after="$(workload_inventory)"
if [[ "$before" != "$after" ]]; then
  printf 'workload tmux inventory changed during dashboard restart; investigate immediately\n' >&2
  diff -u <(printf '%s\n' "$before") <(printf '%s\n' "$after") >&2 || true
  exit 6
fi

printf 'Host Control healthy on %s (unit=%s pid=%s); workload tmux inventory unchanged\n' "$HEALTH_URL" "$UNIT" "$main_pid"
