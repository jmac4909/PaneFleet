#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
TOKEN_FILE="${ORCHESTRATOR_ACCESS_TOKEN_FILE:-$ROOT/data/access-token}"

if [[ ! -f "$TOKEN_FILE" || -L "$TOKEN_FILE" ]]; then
  printf 'access token file is missing or unsafe: %s\n' "$TOKEN_FILE" >&2
  printf 'It is created automatically after PaneFleet first starts on a non-loopback bind.\n' >&2
  exit 1
fi

mode="$(stat -c '%a' "$TOKEN_FILE")"
owner="$(stat -c '%u' "$TOKEN_FILE")"
if [[ "$mode" != 600 || "$owner" != "$(id -u)" ]]; then
  printf 'access token file must be owned by the current user with mode 600\n' >&2
  exit 2
fi

token="$(<"$TOKEN_FILE")"
if (( ${#token} < 24 )); then
  printf 'access token file is invalid\n' >&2
  exit 3
fi

printf '%s\n' "$token"
