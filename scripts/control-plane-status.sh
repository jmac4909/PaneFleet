#!/usr/bin/env bash
set -euo pipefail

UNIT="${ORCH_SYSTEMD_UNIT:-agent-orchestrator.service}"
WORKLOAD_UNIT="${ORCH_WORKLOAD_SYSTEMD_UNIT:-panefleet-workloads.service}"
MANAGED_SOCKET="${ORCH_MANAGED_TMUX_SOCKET:-host-control-managed}"
HOST="${ORCH_HEALTH_HOST:-127.0.0.1}"
PORT="${ORCH_PORT:-8787}"
CURRENT_USER="$(id -un 2>/dev/null || true)"
PROC_ROOT="${ORCH_PROC_ROOT:-/proc}"

[[ "$UNIT" =~ ^[A-Za-z0-9][A-Za-z0-9_.@-]{0,127}\.service$ ]] || { printf 'invalid ORCH_SYSTEMD_UNIT\n' >&2; exit 2; }
[[ "$WORKLOAD_UNIT" =~ ^[A-Za-z0-9][A-Za-z0-9_.@-]{0,127}\.service$ ]] || { printf 'invalid ORCH_WORKLOAD_SYSTEMD_UNIT\n' >&2; exit 2; }
[[ "$MANAGED_SOCKET" =~ ^[A-Za-z0-9_.-]{1,128}$ ]] || { printf 'invalid ORCH_MANAGED_TMUX_SOCKET\n' >&2; exit 2; }
[[ "$HOST" =~ ^[A-Za-z0-9.:-]+$ ]] || { printf 'invalid ORCH_HEALTH_HOST\n' >&2; exit 2; }
[[ "$PORT" =~ ^[0-9]+$ ]] && (( PORT >= 1 && PORT <= 65535 )) || { printf 'invalid ORCH_PORT\n' >&2; exit 2; }
if [[ "$PROC_ROOT" != /proc ]]; then
  [[ "${ORCH_TEST_MODE:-0}" == 1 && "$PROC_ROOT" == /* && -d "$PROC_ROOT" && ! -L "$PROC_ROOT" ]] || {
    printf 'invalid ORCH_PROC_ROOT\n' >&2
    exit 2
  }
fi

process_cgroup() {
  local pid="$1"
  [[ "$pid" =~ ^[1-9][0-9]*$ && -r "$PROC_ROOT/$pid/cgroup" ]] || return 1
  awk -F: '$1 == "0" { print $3; exit }' "$PROC_ROOT/$pid/cgroup"
}

active="$(systemctl --user is-active "$UNIT" 2>/dev/null || true)"
enabled="$(systemctl --user is-enabled "$UNIT" 2>/dev/null || true)"
main_pid="$(systemctl --user show "$UNIT" -p MainPID --value 2>/dev/null || true)"
linger="unknown"
if [[ "$CURRENT_USER" =~ ^[A-Za-z_][A-Za-z0-9_.-]{0,127}$ ]]; then
  linger="$(loginctl show-user "$CURRENT_USER" -p Linger --value 2>/dev/null || true)"
fi
health="down"
if curl -fsS --max-time 2 "http://$HOST:$PORT/healthz" >/dev/null 2>&1; then
  health="ok"
fi
listener="$(ss -H -ltnp "sport = :$PORT" 2>/dev/null || true)"
listener_pid="$(printf '%s\n' "$listener" | sed -n 's/.*pid=\([0-9][0-9]*\),.*/\1/p' | head -n 1)"
workload_tmux="absent"
workload_cgroup="absent"
workloads=0
tmux_pid="$(tmux display-message -p '#{pid}' 2>/dev/null || true)"
if command -v tmux >/dev/null && [[ "$tmux_pid" =~ ^[1-9][0-9]*$ ]]; then
  workload_tmux="present"
  sessions="$(tmux list-sessions -F '#{session_name}' 2>/dev/null || true)"
  if [[ -n "$sessions" ]]; then
    workloads="$(printf '%s\n' "$sessions" \
      | awk 'NF && $0 != "agent-orchestrator" && $0 != "agent-orchestrator-watchdog"' \
      | wc -l | tr -d ' ')"
  fi
  dashboard_cgroup="$(process_cgroup "$main_pid" 2>/dev/null || true)"
  tmux_cgroup="$(process_cgroup "$tmux_pid" 2>/dev/null || true)"
  workload_service_cgroup="$(systemctl --user show "$WORKLOAD_UNIT" -p ControlGroup --value 2>/dev/null || true)"
  if [[ -n "$dashboard_cgroup" && -n "$tmux_cgroup" ]]; then
    if [[ "$dashboard_cgroup" == "$tmux_cgroup" ]]; then
      workload_cgroup="shared"
    elif [[ -n "$workload_service_cgroup" && "$tmux_cgroup" == "$workload_service_cgroup" ]]; then
      workload_cgroup="separate"
    else
      workload_cgroup="unmanaged"
    fi
  else
    workload_cgroup="unknown"
  fi
fi
managed_tmux="absent"
managed_cgroup="absent"
managed_tmux_pid="$(tmux -L "$MANAGED_SOCKET" display-message -p '#{pid}' 2>/dev/null || true)"
if [[ "$managed_tmux_pid" =~ ^[1-9][0-9]*$ ]]; then
  managed_tmux="present"
  dashboard_cgroup="$(process_cgroup "$main_pid" 2>/dev/null || true)"
  managed_tmux_cgroup="$(process_cgroup "$managed_tmux_pid" 2>/dev/null || true)"
  workload_service_cgroup="$(systemctl --user show "$WORKLOAD_UNIT" -p ControlGroup --value 2>/dev/null || true)"
  if [[ -n "$dashboard_cgroup" && -n "$managed_tmux_cgroup" ]]; then
    if [[ "$dashboard_cgroup" == "$managed_tmux_cgroup" ]]; then
      managed_cgroup="shared"
    elif [[ -n "$workload_service_cgroup" && "$managed_tmux_cgroup" == "$workload_service_cgroup" ]]; then
      managed_cgroup="separate"
    else
      managed_cgroup="unmanaged"
    fi
  else
    managed_cgroup="unknown"
  fi
fi
legacy="no"
if [[ "$workload_tmux" == present ]] && { tmux has-session -t '=agent-orchestrator' 2>/dev/null || tmux has-session -t '=agent-orchestrator-watchdog' 2>/dev/null; }; then
  legacy="yes"
fi
isolation="attention"
cgroup_safe="no"
if [[ "$workload_cgroup" == separate && "$managed_cgroup" == separate ]]; then
  cgroup_safe="yes"
fi
if [[ "$enabled" == enabled && "$active" == active && "$health" == ok && "$linger" == yes && "$main_pid" =~ ^[1-9][0-9]*$ && "$listener_pid" == "$main_pid" && "$legacy" == no && "$cgroup_safe" == yes ]]; then
  isolation="ok"
fi

printf 'isolation=%s unit=%s enabled=%s active=%s pid=%s listener_pid=%s health=%s linger=%s legacy_tmux=%s workload_tmux=%s workload_cgroup=%s workloads=%s managed_tmux=%s managed_cgroup=%s\n' \
  "$isolation" "$UNIT" "${enabled:-unknown}" "${active:-unknown}" "${main_pid:-0}" \
  "${listener_pid:-0}" "$health" "${linger:-unknown}" "$legacy" "$workload_tmux" "$workload_cgroup" "$workloads" "$managed_tmux" "$managed_cgroup"
