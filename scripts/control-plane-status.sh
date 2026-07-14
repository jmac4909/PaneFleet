#!/usr/bin/env bash
set -euo pipefail

UNIT="${ORCH_SYSTEMD_UNIT:-agent-orchestrator.service}"
HOST="${ORCH_HEALTH_HOST:-127.0.0.1}"
PORT="${ORCH_PORT:-8787}"

active="$(systemctl --user is-active "$UNIT" 2>/dev/null || true)"
enabled="$(systemctl --user is-enabled "$UNIT" 2>/dev/null || true)"
main_pid="$(systemctl --user show "$UNIT" -p MainPID --value 2>/dev/null || true)"
linger="$(loginctl show-user "$USER" -p Linger --value 2>/dev/null || true)"
health="down"
if curl -fsS --max-time 2 "http://$HOST:$PORT/healthz" >/dev/null 2>&1; then
  health="ok"
fi
listener="$(ss -H -ltnp "sport = :$PORT" 2>/dev/null || true)"
listener_pid="$(printf '%s\n' "$listener" | sed -n 's/.*pid=\([0-9][0-9]*\),.*/\1/p' | head -n 1)"
workloads="$(tmux list-sessions -F '#{session_name}' 2>/dev/null \
  | awk '$0 != "agent-orchestrator" && $0 != "agent-orchestrator-watchdog"' \
  | wc -l | tr -d ' ')"
legacy="no"
if tmux has-session -t '=agent-orchestrator' 2>/dev/null || tmux has-session -t '=agent-orchestrator-watchdog' 2>/dev/null; then
  legacy="yes"
fi
isolation="attention"
if [[ "$enabled" == enabled && "$active" == active && "$health" == ok && "$linger" == yes && "$main_pid" =~ ^[1-9][0-9]*$ && "$listener_pid" == "$main_pid" && "$legacy" == no ]]; then
  isolation="ok"
fi

printf 'isolation=%s unit=%s enabled=%s active=%s pid=%s listener_pid=%s health=%s linger=%s legacy_tmux=%s workloads=%s\n' \
  "$isolation" "$UNIT" "${enabled:-unknown}" "${active:-unknown}" "${main_pid:-0}" \
  "${listener_pid:-0}" "$health" "${linger:-unknown}" "$legacy" "$workloads"
