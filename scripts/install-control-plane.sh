#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${ORCH_ROOT:-$(cd -- "$SCRIPT_DIR/.." && pwd)}"
UNIT="${ORCH_SYSTEMD_UNIT:-agent-orchestrator.service}"
NODE_BIN="${ORCH_NODE_BIN:-$(command -v node || true)}"
BIND_HOST="${ORCH_BIND_HOST:-127.0.0.1}"
HEALTH_HOST="${ORCH_HEALTH_HOST:-127.0.0.1}"
PORT="${ORCH_PORT:-8787}"
TEMPLATE="$ROOT/ops/agent-orchestrator.service.in"
USER_UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT_PATH="$USER_UNIT_DIR/$UNIT"
MIGRATE=false

case "${1:-}" in
  --migrate) MIGRATE=true ;;
  '') ;;
  *) printf 'usage: %s [--migrate]\n' "$0" >&2; exit 2 ;;
esac

[[ "$ROOT" == /* && -d "$ROOT" && "$ROOT" != *$'\n'* ]] || { printf 'invalid ORCH_ROOT\n' >&2; exit 2; }
[[ "$NODE_BIN" == /* && -x "$NODE_BIN" && "$NODE_BIN" != *$'\n'* ]] || { printf 'absolute executable ORCH_NODE_BIN required\n' >&2; exit 2; }
[[ "$BIND_HOST" =~ ^[A-Za-z0-9.:-]+$ ]] || { printf 'invalid ORCH_BIND_HOST\n' >&2; exit 2; }
[[ "$HEALTH_HOST" =~ ^[A-Za-z0-9.:-]+$ ]] || { printf 'invalid ORCH_HEALTH_HOST\n' >&2; exit 2; }
[[ "$PORT" =~ ^[0-9]+$ ]] && (( PORT >= 1 && PORT <= 65535 )) || { printf 'invalid ORCH_PORT\n' >&2; exit 2; }
[[ -f "$TEMPLATE" ]] || { printf 'missing unit template: %s\n' "$TEMPLATE" >&2; exit 2; }
command -v systemctl >/dev/null || { printf 'systemctl is required\n' >&2; exit 2; }
command -v curl >/dev/null || { printf 'curl is required\n' >&2; exit 2; }
command -v ss >/dev/null || { printf 'ss is required\n' >&2; exit 2; }

escape_sed() { printf '%s' "$1" | sed 's/[&|]/\\&/g'; }
root_sed="$(escape_sed "$ROOT")"
node_sed="$(escape_sed "$NODE_BIN")"
home_sed="$(escape_sed "$HOME")"
node_dir_sed="$(escape_sed "$(dirname "$NODE_BIN")")"
bind_host_sed="$(escape_sed "$BIND_HOST")"
port_sed="$(escape_sed "$PORT")"
temporary="$(mktemp)"
trap 'rm -f "$temporary"' EXIT
sed \
  -e "s|@ROOT@|$root_sed|g" \
  -e "s|@NODE@|$node_sed|g" \
  -e "s|@NODE_DIR@|$node_dir_sed|g" \
  -e "s|@HOME@|$home_sed|g" \
  -e "s|@HOST@|$bind_host_sed|g" \
  -e "s|@PORT@|$port_sed|g" \
  "$TEMPLATE" > "$temporary"

mkdir -p "$USER_UNIT_DIR"
install -m 0600 "$temporary" "$UNIT_PATH"
systemctl --user daemon-reload
if command -v systemd-analyze >/dev/null; then
  systemd-analyze --user verify "$UNIT_PATH"
fi

if [[ "$MIGRATE" != true ]]; then
  systemctl --user enable "$UNIT"
  systemctl --user start "$UNIT"
  ready=0
  for _ in $(seq 1 80); do
    if systemctl --user is-active --quiet "$UNIT" && curl -fsS --max-time 2 "http://$HEALTH_HOST:$PORT/healthz" >/dev/null 2>&1; then
      ready=1
      break
    fi
    sleep 0.25
  done
  [[ "$ready" == 1 ]] || { systemctl --user --no-pager --full status "$UNIT" >&2 || true; exit 5; }
  printf 'installed and started %s on %s:%s\n' "$UNIT_PATH" "$BIND_HOST" "$PORT"
  exit 0
fi

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

stop_legacy_session() {
  local session="$1"
  local expected_command="$2"
  if ! tmux has-session -t "=$session" 2>/dev/null; then
    return 0
  fi
  local signature
  signature="$(tmux list-panes -t "=$session" -F '#{pane_id}|#{pane_current_path}|#{pane_start_command}')"
  if [[ "$(printf '%s\n' "$signature" | wc -l)" != 1 ]]; then
    printf 'legacy session %s is not a single-pane control session; refusing migration\n' "$session" >&2
    return 1
  fi
  local pane_id pane_cwd pane_command
  IFS='|' read -r pane_id pane_cwd pane_command <<< "$signature"
  if [[ ! "$pane_id" =~ ^%[0-9]+$ || "$pane_cwd" != "$ROOT" || "$pane_command" != *"$expected_command"* ]]; then
    printf 'legacy session %s identity does not match the expected control process; refusing migration\n' "$session" >&2
    return 1
  fi
  if ! tmux send-keys -t "$pane_id" C-c; then
    printf 'legacy session %s exact pane %s rejected the interrupt; refusing migration\n' "$session" "$pane_id" >&2
    return 1
  fi
  for _ in $(seq 1 40); do
    if ! tmux has-session -t "=$session" 2>/dev/null; then
      return 0
    fi
    sleep 0.1
  done
  printf 'legacy session %s did not stop after an explicit interrupt; refusing forced cleanup\n' "$session" >&2
  return 1
}

command -v loginctl >/dev/null || { printf 'loginctl is required for persistent user supervision\n' >&2; exit 3; }
command -v sudo >/dev/null || { printf 'sudo is required to enable user lingering\n' >&2; exit 3; }
sudo -n loginctl enable-linger "$USER"
linger="$(loginctl show-user "$USER" -p Linger --value)"
[[ "$linger" == yes ]] || { printf 'user lingering was not enabled; refusing migration\n' >&2; exit 3; }
systemctl --user enable "$UNIT"

before="$(workload_inventory)"
stop_legacy_session agent-orchestrator-watchdog 'scripts/watchdog.sh'
stop_legacy_session agent-orchestrator 'npm start'

port_closed=0
for _ in $(seq 1 40); do
  if [[ -z "$(ss -H -ltnp "sport = :$PORT" 2>/dev/null || true)" ]]; then
    port_closed=1
    break
  fi
  sleep 0.1
done
[[ "$port_closed" == 1 ]] || { printf 'port %s is still owned by the legacy control plane; refusing migration\n' "$PORT" >&2; exit 4; }

systemctl --user start "$UNIT"
ready=0
for _ in $(seq 1 80); do
  if systemctl --user is-active --quiet "$UNIT" && curl -fsS --max-time 2 "http://$HEALTH_HOST:$PORT/healthz" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 0.25
done
[[ "$ready" == 1 ]] || { systemctl --user --no-pager --full status "$UNIT" >&2 || true; exit 5; }

sleep 0.25
curl -fsS --max-time 2 "http://$HEALTH_HOST:$PORT/healthz" >/dev/null 2>&1 || {
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
  printf 'workload tmux inventory changed during control-plane migration\n' >&2
  diff -u <(printf '%s\n' "$before") <(printf '%s\n' "$after") >&2 || true
  exit 6
fi

printf 'migrated Host Control to %s; workload tmux inventory unchanged\n' "$UNIT"
