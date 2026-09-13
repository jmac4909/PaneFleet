#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
SESSION="${1:-}"
COMMAND="${2:-}"
STATE_DIR="${PANEFLEET_AGENT_STATE_DIR:-$ROOT/data/agent-runtime}"
# Start reclaim below the kill boundary so long Codex sessions can spill cold
# pages to the host's dedicated swap instead of dying at a sudden hard cap.
MEMORY_HIGH="${PANEFLEET_AGENT_MEMORY_HIGH:-3G}"
MEMORY_MAX="${PANEFLEET_AGENT_MEMORY_MAX:-4G}"
MEMORY_SWAP_MAX="${PANEFLEET_AGENT_MEMORY_SWAP_MAX:-4G}"

[[ "$SESSION" =~ ^codex([A-Za-z0-9_-]*)$ ]] || { printf 'invalid agent session\n' >&2; exit 2; }
[[ ! "$SESSION" =~ ^codex-planning- ]] || { printf 'planning sessions require the dedicated planning launcher\n' >&2; exit 2; }
[[ -n "$COMMAND" ]] || { printf 'invalid agent command\n' >&2; exit 2; }
[[ "$STATE_DIR" == /* && "$STATE_DIR" != *$'\n'* ]] || { printf 'invalid agent state directory\n' >&2; exit 2; }
for value in "$MEMORY_HIGH" "$MEMORY_MAX" "$MEMORY_SWAP_MAX"; do
  [[ "$value" =~ ^[1-9][0-9]*(K|M|G|T)$ ]] || { printf 'invalid agent memory limit\n' >&2; exit 2; }
done
command -v systemd-run >/dev/null || { printf 'systemd-run is required\n' >&2; exit 2; }

umask 0077
mkdir -p -- "$STATE_DIR"
STATE_PATH="$STATE_DIR/$SESSION.state"

write_state() {
  local state="$1"
  local exit_code="$2"
  local temporary
  temporary="$(mktemp "$STATE_DIR/.${SESSION}.XXXXXX")"
  printf 'version=1\nstate=%s\nexit_code=%s\nupdated_at=%s\n' \
    "$state" "$exit_code" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$temporary"
  chmod 0600 "$temporary"
  mv -f -- "$temporary" "$STATE_PATH"
}

scope_suffix="$(date -u +%Y%m%d%H%M%S)-$$"
scope_unit="panefleet-agent-${SESSION#codex-}-$scope_suffix"
write_state running 0

set +e
systemd-run --user --scope --quiet --collect \
  --unit="$scope_unit" \
  --property="MemoryHigh=$MEMORY_HIGH" \
  --property="MemoryMax=$MEMORY_MAX" \
  --property="MemorySwapMax=$MEMORY_SWAP_MAX" \
  --property=TasksMax=256 \
  --property=ManagedOOMMemoryPressure=auto \
  --property=ManagedOOMSwap=auto \
  bash -lc "$COMMAND"
exit_code=$?
set -e

if [[ "$exit_code" == 0 ]]; then
  write_state exited 0
else
  write_state crashed "$exit_code"
fi
exit "$exit_code"
