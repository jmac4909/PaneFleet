#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${ORCH_ROOT:-$(cd -- "$SCRIPT_DIR/.." && pwd)}"
SESSION="${ORCH_SESSION:-agent-orchestrator}"
HOST="${ORCH_HOST:-127.0.0.1}"
PORT="${ORCH_PORT:-8787}"
INTERVAL="${ORCH_WATCHDOG_INTERVAL:-30}"
LOG="$ROOT/watchdog.log"

if [[ "${ALLOW_LEGACY_TMUX_WATCHDOG:-}" != 1 ]]; then
  printf 'legacy tmux watchdog is disabled; Host Control is supervised by agent-orchestrator.service\n' >&2
  exit 2
fi

[[ -d "$ROOT" ]] || { printf 'watchdog root does not exist: %s\n' "$ROOT" >&2; exit 2; }
[[ "$SESSION" =~ ^[A-Za-z0-9_.-]{1,128}$ ]] || { printf 'invalid tmux session name\n' >&2; exit 2; }
[[ "$HOST" =~ ^[A-Za-z0-9.:-]+$ ]] || { printf 'invalid bind host\n' >&2; exit 2; }
[[ "$PORT" =~ ^[0-9]+$ ]] && (( PORT >= 1 && PORT <= 65535 )) || { printf 'invalid port\n' >&2; exit 2; }
[[ "$INTERVAL" =~ ^[0-9]+$ ]] && (( INTERVAL >= 1 )) || { printf 'invalid watchdog interval\n' >&2; exit 2; }

start_orchestrator() {
  if tmux has-session -t "=$SESSION" 2>/dev/null; then
    printf '%s unhealthy %s still exists; refusing destructive restart\n' "$(date -Is)" "$SESSION" >> "$LOG"
    return 1
  fi
  tmux new-session -d -s "$SESSION" -c "$ROOT" \
    -e "HOST=$HOST" -e "PORT=$PORT" \
    'npm start >> server.log 2>&1'
}

while true; do
  if ! curl -fsS --max-time 3 "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then
    printf '%s restarting %s on port %s\n' "$(date -Is)" "$SESSION" "$PORT" >> "$LOG"
    start_orchestrator || true
    sleep 5
  elif ! tmux has-session -t "=$SESSION" 2>/dev/null; then
    printf '%s tmux session missing for healthy port, recreating %s\n' "$(date -Is)" "$SESSION" >> "$LOG"
    start_orchestrator
    sleep 5
  fi
  sleep "$INTERVAL"
done
