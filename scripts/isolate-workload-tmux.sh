#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
WORKLOAD_UNIT="panefleet-workloads.service"
DASHBOARD_UNIT="${ORCH_SYSTEMD_UNIT:-agent-orchestrator.service}"
MANAGED_SOCKET="${ORCH_MANAGED_TMUX_SOCKET:-host-control-managed}"
TEMPLATE="$ROOT/ops/panefleet-workloads.service.in"
CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
USER_UNIT_DIR="$CONFIG_HOME/systemd/user"
WORKLOAD_UNIT_PATH="$USER_UNIT_DIR/$WORKLOAD_UNIT"
DASHBOARD_DROPIN_DIR="$USER_UNIT_DIR/$DASHBOARD_UNIT.d"
DASHBOARD_DROPIN_PATH="$DASHBOARD_DROPIN_DIR/workload-isolation.conf"
NODE_BIN="$(command -v node || true)"

[[ "$DASHBOARD_UNIT" =~ ^[A-Za-z0-9][A-Za-z0-9_.@-]{0,127}\.service$ ]] || { printf 'invalid ORCH_SYSTEMD_UNIT\n' >&2; exit 2; }
[[ "$MANAGED_SOCKET" =~ ^[A-Za-z0-9_.-]{1,128}$ ]] || { printf 'invalid ORCH_MANAGED_TMUX_SOCKET\n' >&2; exit 2; }
[[ "$ROOT" == /* && -d "$ROOT" && "$ROOT" != *$'\n'* ]] || { printf 'invalid project root\n' >&2; exit 2; }
[[ "$HOME" == /* && -d "$HOME" && "$HOME" != *$'\n'* ]] || { printf 'invalid HOME\n' >&2; exit 2; }
[[ "$CONFIG_HOME" == /* && "$CONFIG_HOME" != *$'\n'* ]] || { printf 'invalid XDG_CONFIG_HOME\n' >&2; exit 2; }
[[ "$NODE_BIN" == /* && -x "$NODE_BIN" ]] || { printf 'node is required\n' >&2; exit 2; }
[[ -f "$TEMPLATE" && ! -L "$TEMPLATE" ]] || { printf 'workload unit template is missing or unsafe\n' >&2; exit 2; }
command -v tmux >/dev/null || { printf 'tmux is required\n' >&2; exit 2; }
command -v systemctl >/dev/null || { printf 'systemctl is required\n' >&2; exit 2; }
command -v systemd-analyze >/dev/null || { printf 'systemd-analyze is required\n' >&2; exit 2; }

tmux_server() {
  local socket="$1"
  shift
  if [[ -n "$socket" ]]; then
    tmux -L "$socket" "$@"
  else
    tmux "$@"
  fi
}

workload_inventory() {
  local label socket pid panes
  while IFS='|' read -r label socket; do
    pid="$(tmux_server "$socket" display-message -p '#{pid}' 2>/dev/null || true)"
    if [[ ! "$pid" =~ ^[1-9][0-9]*$ ]]; then
      printf '%s|server=absent\n' "$label"
      continue
    fi
    panes="$(tmux_server "$socket" list-panes -a -F '#{session_name}|#{session_id}|#{session_created}|#{window_index}.#{pane_index}|#{pane_id}|#{pane_pid}|#{pane_start_command}' 2>/dev/null || true)"
    if [[ -z "$panes" ]]; then
      printf '%s|server=empty|pid=%s\n' "$label" "$pid"
      continue
    fi
    printf '%s\n' "$panes" | sed "s/^/$label|/" | LC_ALL=C sort
  done <<EOF
default|
managed|$MANAGED_SOCKET
EOF
}

process_cgroup() {
  local pid="$1"
  [[ "$pid" =~ ^[1-9][0-9]*$ && -r "/proc/$pid/cgroup" ]] || return 1
  awk -F: '$1 == "0" { print $3; exit }' "/proc/$pid/cgroup"
}

descendant_pids() {
  local root_pid="$1"
  ps -e -o pid=,ppid= | awk -v root="$root_pid" '
    { parent[$1] = $2 }
    END {
      for (pid in parent) {
        current = pid
        while (current in parent && current > 1) {
          if (current == root) { print pid; break }
          current = parent[current]
        }
      }
    }
  ' | LC_ALL=C sort -n
}

escape_sed() { printf '%s' "$1" | sed 's/[&|]/\\&/g'; }
root_sed="$(escape_sed "$ROOT")"
home_sed="$(escape_sed "$HOME")"
node_dir_sed="$(escape_sed "$(dirname "$NODE_BIN")")"
unit_tmp="$(mktemp)"
dropin_tmp="$(mktemp)"
trap 'rm -f -- "$unit_tmp" "$dropin_tmp"' EXIT
sed \
  -e "s|@ROOT@|$root_sed|g" \
  -e "s|@HOME@|$home_sed|g" \
  -e "s|@NODE_DIR@|$node_dir_sed|g" \
  "$TEMPLATE" > "$unit_tmp"
cat > "$dropin_tmp" <<EOF
[Unit]
Wants=$WORKLOAD_UNIT
After=$WORKLOAD_UNIT
EOF

mkdir -p -- "$USER_UNIT_DIR" "$DASHBOARD_DROPIN_DIR"
install -m 0600 "$unit_tmp" "$WORKLOAD_UNIT_PATH"
install -m 0600 "$dropin_tmp" "$DASHBOARD_DROPIN_PATH"
systemctl --user daemon-reload
systemd-analyze --user verify "$WORKLOAD_UNIT_PATH"
systemctl --user enable "$WORKLOAD_UNIT"
systemctl --user start "$WORKLOAD_UNIT"
systemctl --user is-active --quiet "$WORKLOAD_UNIT" || { printf 'workload isolation unit did not start\n' >&2; exit 3; }

target_cgroup="$(systemctl --user show "$WORKLOAD_UNIT" -p ControlGroup --value)"
dashboard_cgroup="$(systemctl --user show "$DASHBOARD_UNIT" -p ControlGroup --value)"
expected_prefix="/user.slice/user-$(id -u).slice/user@$(id -u).service/"
[[ "$target_cgroup" == "$expected_prefix"* && "$target_cgroup" != "$dashboard_cgroup" ]] || {
  printf 'unsafe workload cgroup target\n' >&2
  exit 3
}
target_procs="/sys/fs/cgroup$target_cgroup/cgroup.procs"
[[ -w "$target_procs" && ! -L "$target_procs" ]] || { printf 'workload cgroup is not writable\n' >&2; exit 3; }

dashboard_pid="$(systemctl --user show "$DASHBOARD_UNIT" -p MainPID --value)"
before="$(workload_inventory)"

approved_transient_agent_scope() {
  [[ "$1" =~ /panefleet-agent-[A-Za-z0-9_.-]+\.(scope|service)$ ]] \
    || [[ "$1" =~ /panefleet-planning-[a-f0-9]{24}\.scope$ ]]
}

isolate_tmux_server() {
  local socket="$1"
  local label="$2"
  local tmux_pid source_cgroup moved remaining pid current_cgroup
  tmux_pid="$(tmux_server "$socket" display-message -p '#{pid}' 2>/dev/null || true)"
  [[ "$tmux_pid" =~ ^[1-9][0-9]*$ && -r "/proc/$tmux_pid/stat" ]] || {
    printf 'could not resolve %s tmux server\n' "$label" >&2
    return 1
  }
  [[ "$tmux_pid" != "$dashboard_pid" ]] || { printf 'dashboard cannot be the %s tmux server\n' "$label" >&2; return 1; }
  source_cgroup="$(process_cgroup "$tmux_pid" || true)"
  [[ -n "$source_cgroup" ]] || { printf 'could not resolve %s tmux cgroup\n' "$label" >&2; return 1; }
  if [[ "$source_cgroup" == "$target_cgroup" ]]; then
    return 0
  fi

  printf '%s\n' "$tmux_pid" > "$target_procs"
  for _ in $(seq 1 10); do
    moved=0
    while IFS= read -r pid; do
      [[ "$pid" =~ ^[1-9][0-9]*$ && -r "/proc/$pid/cgroup" ]] || continue
      current_cgroup="$(process_cgroup "$pid" || true)"
      if [[ "$current_cgroup" == "$source_cgroup" ]]; then
        printf '%s\n' "$pid" > "$target_procs" 2>/dev/null || true
        moved=1
      elif [[ "$current_cgroup" == "$target_cgroup" ]] || approved_transient_agent_scope "$current_cgroup"; then
        :
      else
        printf '%s tmux descendant %s is in unexpected cgroup %s\n' "$label" "$pid" "$current_cgroup" >&2
        return 1
      fi
    done < <(descendant_pids "$tmux_pid")
    [[ "$moved" == 0 ]] && break
    sleep 0.1
  done

  remaining=0
  while IFS= read -r pid; do
    [[ "$pid" =~ ^[1-9][0-9]*$ && -r "/proc/$pid/cgroup" ]] || continue
    current_cgroup="$(process_cgroup "$pid" || true)"
    if [[ "$current_cgroup" != "$target_cgroup" ]] && ! approved_transient_agent_scope "$current_cgroup"; then
      printf '%s tmux descendant %s did not enter an approved workload cgroup\n' "$label" "$pid" >&2
      remaining=1
    fi
  done < <(descendant_pids "$tmux_pid")
  [[ "$remaining" == 0 ]]
}

isolate_tmux_server '' 'default' || exit 4
isolate_tmux_server "$MANAGED_SOCKET" 'managed' || exit 4
[[ "$(process_cgroup "$dashboard_pid")" == "$dashboard_cgroup" ]] || { printf 'dashboard cgroup changed unexpectedly\n' >&2; exit 5; }

after="$(workload_inventory)"
if [[ "$before" != "$after" ]]; then
  printf 'workload inventory changed during cgroup isolation\n' >&2
  diff -u <(printf '%s\n' "$before") <(printf '%s\n' "$after") >&2 || true
  exit 6
fi

printf 'workload tmux servers isolated in %s; inventory unchanged\n' "$WORKLOAD_UNIT"
