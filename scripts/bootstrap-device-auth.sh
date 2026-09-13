#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
DATA_DIR="${ORCHESTRATOR_DATA_DIR:-$ROOT/data}"
AUTH_FILE="${ORCHESTRATOR_DEVICE_AUTH_FILE:-$DATA_DIR/device-auth.json}"
USERNAME="${1:-}"

[[ "$DATA_DIR" == /* && "$AUTH_FILE" == "$DATA_DIR/"* ]] || {
  printf 'device auth paths must be absolute and contained by the PaneFleet data directory\n' >&2
  exit 2
}
[[ "$USERNAME" =~ ^[A-Za-z0-9_.@-]{1,128}$ ]] || {
  printf 'usage: %s USERNAME < bcrypt-hash\n' "$0" >&2
  exit 2
}

IFS= read -r PASSWORD_HASH || {
  printf 'one bcrypt hash is required on stdin\n' >&2
  exit 2
}
if IFS= read -r EXTRA_INPUT; then
  printf 'stdin must contain exactly one bcrypt hash\n' >&2
  exit 2
fi
if [[ ! "$PASSWORD_HASH" =~ ^\$2[aby]\$([0-9]{2})\$[./A-Za-z0-9]{53}$ ]]; then
  printf 'stdin is not a supported bcrypt hash\n' >&2
  exit 2
fi
BCRYPT_COST=$((10#${BASH_REMATCH[1]}))
(( BCRYPT_COST >= 10 && BCRYPT_COST <= 16 )) || {
  printf 'bcrypt cost must be between 10 and 16\n' >&2
  exit 2
}

mkdir -p -- "$DATA_DIR"
chmod 700 -- "$DATA_DIR"
[[ -d "$DATA_DIR" && ! -L "$DATA_DIR" && -O "$DATA_DIR" ]] || {
  printf 'PaneFleet data directory is not a private operator-owned directory\n' >&2
  exit 3
}
[[ ! -e "$AUTH_FILE" && ! -L "$AUTH_FILE" ]] || {
  printf 'device auth file already exists; refusing to replace it\n' >&2
  exit 4
}

TEMPORARY="$(mktemp "$DATA_DIR/.device-auth.XXXXXX")"
cleanup() { unlink -- "$TEMPORARY" 2>/dev/null || true; }
trap cleanup EXIT
chmod 600 -- "$TEMPORARY"
printf '{"version":1,"username":"%s","passwordHash":"%s"}\n' \
  "$USERNAME" "$PASSWORD_HASH" > "$TEMPORARY"
ln -- "$TEMPORARY" "$AUTH_FILE"
unlink -- "$TEMPORARY"
trap - EXIT

printf 'Created private PaneFleet device-auth configuration at %s\n' "$AUTH_FILE"
