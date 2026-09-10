#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
SERVICE_USER=""
APP_ROOT=""
CORPUS_ROOT=""
INBOX=""
DB_PATH=""
BUN_PATH=""
NODE_PATH=""
PYTHON_PATH=""
MCP_HOST="127.0.0.1"
MCP_PORT="8089"
MCP_PATH="/mcp"
STABILITY_MS="1500"
RECONCILE_SECONDS="60"
DESTDIR=${DESTDIR:-}
CREATE_INBOX=0
START=0

usage() {
  cat <<'EOF'
Usage: sudo ./ops/systemd/install.sh \
  --user <account> --app-root <dir> --corpus-root <dir> \
  --inbox <dir> --db <corpus.sqlite> [options]

Options:
  --bun <absolute-path>       Bun executable (default: command -v bun)
  --node <absolute-path>      Node executable (default: command -v node)
  --python <absolute-path>    Python executable (default: command -v python3)
  --mcp-host <host>           Default: 127.0.0.1
  --mcp-port <port>           Default: 8089
  --mcp-path <path>           Default: /mcp
  --stability-ms <ms>         Default: 1500
  --reconcile-seconds <sec>   Default: 60
  --create-inbox              Create the configured inbox when absent
  --start                     Restart/start bw-forge.target after installation
  --destdir <dir>             Stage files beneath a packaging/test root; skip systemctl
EOF
}

die() { printf 'bw-forge systemd install: %s\n' "$*" >&2; exit 1; }
need_value() { [ "$#" -ge 2 ] && [ -n "$2" ] || die "missing value for $1"; }

while [ "$#" -gt 0 ]; do
  case "$1" in
    --user) need_value "$@"; SERVICE_USER=$2; shift 2 ;;
    --app-root) need_value "$@"; APP_ROOT=$2; shift 2 ;;
    --corpus-root) need_value "$@"; CORPUS_ROOT=$2; shift 2 ;;
    --inbox) need_value "$@"; INBOX=$2; shift 2 ;;
    --db) need_value "$@"; DB_PATH=$2; shift 2 ;;
    --bun) need_value "$@"; BUN_PATH=$2; shift 2 ;;
    --node) need_value "$@"; NODE_PATH=$2; shift 2 ;;
    --python) need_value "$@"; PYTHON_PATH=$2; shift 2 ;;
    --mcp-host) need_value "$@"; MCP_HOST=$2; shift 2 ;;
    --mcp-port) need_value "$@"; MCP_PORT=$2; shift 2 ;;
    --mcp-path) need_value "$@"; MCP_PATH=$2; shift 2 ;;
    --stability-ms) need_value "$@"; STABILITY_MS=$2; shift 2 ;;
    --reconcile-seconds) need_value "$@"; RECONCILE_SECONDS=$2; shift 2 ;;
    --destdir) need_value "$@"; DESTDIR=$2; shift 2 ;;
    --create-inbox) CREATE_INBOX=1; shift ;;
    --start) START=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

[ -n "$SERVICE_USER" ] || die "--user is required"
[ -n "$APP_ROOT" ] || die "--app-root is required"
[ -n "$CORPUS_ROOT" ] || die "--corpus-root is required"
[ -n "$INBOX" ] || die "--inbox is required"
[ -n "$DB_PATH" ] || die "--db is required"

validate_text() {
  local name=$1 value=$2
  [ -n "$value" ] || die "$name must not be empty"
  case "$value" in *$'\n'*|*$'\r'*) die "$name contains a newline" ;; esac
}
absolute_path() { case "$2" in /*) ;; *) die "$1 must be an absolute path: $2" ;; esac; }
for pair in "app root|$APP_ROOT" "corpus root|$CORPUS_ROOT" "inbox|$INBOX" "database|$DB_PATH"; do
  name=${pair%%|*}; value=${pair#*|}; validate_text "$name" "$value"; absolute_path "$name" "$value"
done
[[ "$SERVICE_USER" =~ ^[A-Za-z_][A-Za-z0-9_.-]*$ ]] || die "invalid service user"
id -- "$SERVICE_USER" >/dev/null 2>&1 || die "service user does not exist: $SERVICE_USER"
[ "$(id -u -- "$SERVICE_USER")" != "0" ] || die "service user must not be root"

if [ -z "$DESTDIR" ] && [ "$(id -u)" != "0" ]; then die "run as root (sudo), or use --destdir for packaging/tests"; fi
if [ -n "$DESTDIR" ]; then absolute_path "destdir" "$DESTDIR"; fi

resolve_executable() {
  local label=$1 configured=$2 fallback=$3 candidate
  if [ -n "$configured" ]; then candidate=$configured; else candidate=$(command -v "$fallback" 2>/dev/null || true); fi
  [ -n "$candidate" ] || die "$label executable was not found; pass --${label,,} <absolute-path>"
  absolute_path "$label executable" "$candidate"
  [ -f "$candidate" ] && [ -x "$candidate" ] || die "$label executable is not an executable file: $candidate"
  printf '%s' "$candidate"
}
BUN_PATH=$(resolve_executable Bun "$BUN_PATH" bun)
NODE_PATH=$(resolve_executable Node "$NODE_PATH" node)
PYTHON_PATH=$(resolve_executable Python "$PYTHON_PATH" python3)

[ -d "$APP_ROOT" ] || die "app root is not a directory: $APP_ROOT"
[ -r "$APP_ROOT/apps/cli/src/main.ts" ] || die "BW Forge CLI is missing or unreadable: $APP_ROOT/apps/cli/src/main.ts"
[ -d "$CORPUS_ROOT" ] || die "corpus root is not a directory: $CORPUS_ROOT"
[ -f "$DB_PATH" ] || die "Corpus database does not exist; refusing to initialize it: $DB_PATH"
DB_DIR=$(dirname -- "$DB_PATH")
[ -d "$DB_DIR" ] || die "database directory is not a directory: $DB_DIR"

CORPUS_REAL=$(realpath -m -- "$CORPUS_ROOT")
INBOX_REAL=$(realpath -m -- "$INBOX")
paths_overlap() {
  [ "$1" = "$2" ] || [[ "$1/" == "$2/"* ]] || [[ "$2/" == "$1/"* ]]
}
for managed in "$CORPUS_REAL/replays" "$CORPUS_REAL/analyses" "$CORPUS_REAL/work" "$CORPUS_REAL/db"; do
  paths_overlap "$INBOX_REAL" "$managed" && die "inbox overlaps managed corpus storage: $INBOX"
done
[ "$INBOX_REAL" != "$CORPUS_REAL" ] || die "inbox must not be the corpus root"

if [ ! -e "$INBOX" ]; then
  [ "$CREATE_INBOX" = 1 ] || die "inbox does not exist (pass --create-inbox to create it): $INBOX"
  INBOX_PARENT=$(dirname -- "$INBOX")
  [ -d "$INBOX_PARENT" ] || die "inbox parent does not exist: $INBOX_PARENT"
  SERVICE_GROUP=$(id -gn -- "$SERVICE_USER")
  if [ "$(id -u)" = "0" ]; then install -d -m 0750 -o "$SERVICE_USER" -g "$SERVICE_GROUP" -- "$INBOX"
  else install -d -m 0750 -- "$INBOX"
  fi
fi
[ -d "$INBOX" ] || die "inbox is not a directory: $INBOX"

as_service_user() {
  if [ "$(id -u)" = "0" ]; then
    command -v runuser >/dev/null 2>&1 || die "runuser is required to validate service-user access"
    runuser -u "$SERVICE_USER" -- "$@"
  else
    [ "$(id -un)" = "$SERVICE_USER" ] || die "non-root staging can validate only the current user"
    "$@"
  fi
}
check_access() { as_service_user /usr/bin/test "$1" "$3" || die "service user '$SERVICE_USER' needs $2 access: $3"; }
check_access -x "traverse" "$APP_ROOT"
check_access -r "read" "$APP_ROOT/apps/cli/src/main.ts"
for path in "$CORPUS_ROOT" "$INBOX" "$DB_DIR"; do
  check_access -r "read" "$path"; check_access -w "write" "$path"; check_access -x "traverse" "$path"
done
check_access -r "read" "$DB_PATH"; check_access -w "write" "$DB_PATH"
for path in "$BUN_PATH" "$NODE_PATH" "$PYTHON_PATH"; do check_access -x "execute" "$path"; done

case "$MCP_PORT" in ''|*[!0-9]*) die "MCP port must be an integer" ;; esac
[ "$MCP_PORT" -ge 1 ] && [ "$MCP_PORT" -le 65535 ] || die "MCP port must be 1..65535"
case "$STABILITY_MS" in ''|*[!0-9]*) die "stability milliseconds must be a non-negative integer" ;; esac
case "$RECONCILE_SECONDS" in ''|*[!0-9]*) die "reconcile seconds must be a positive integer" ;; esac
[ "$RECONCILE_SECONDS" -ge 1 ] || die "reconcile seconds must be a positive integer"
case "$MCP_PATH" in /*) ;; *) die "MCP path must start with /" ;; esac
validate_text "MCP host" "$MCP_HOST"; validate_text "MCP path" "$MCP_PATH"
[[ "$MCP_HOST" =~ ^[A-Za-z0-9_.:-]+$ ]] || die "MCP host contains unsupported characters"
if [ "$MCP_HOST" != "127.0.0.1" ] && [ "$MCP_HOST" != "::1" ] && [ "$MCP_HOST" != "localhost" ]; then
  printf 'WARNING: MCP will bind to %s without TLS or authentication. Restrict network exposure explicitly.\n' "$MCP_HOST" >&2
fi

STAGING=$(mktemp -d "${TMPDIR:-/tmp}/bw-forge-systemd.XXXXXX")
trap 'rm -rf -- "$STAGING"' EXIT
"$NODE_PATH" "$SCRIPT_DIR/render.mjs" --output-dir "$STAGING" --user "$SERVICE_USER" \
  --app-root "$APP_ROOT" --corpus-root "$CORPUS_ROOT" --inbox "$INBOX" --db "$DB_PATH" \
  --bun "$BUN_PATH" --node "$NODE_PATH" --python "$PYTHON_PATH" \
  --mcp-host "$MCP_HOST" --mcp-port "$MCP_PORT" --mcp-path "$MCP_PATH" \
  --stability-ms "$STABILITY_MS" --reconcile-seconds "$RECONCILE_SECONDS" >/dev/null

CONFIG_DIR="$DESTDIR/etc/bw-forge"
UNIT_DIR="$DESTDIR/etc/systemd/system"
install -d -m 0755 -- "$CONFIG_DIR" "$UNIT_DIR"
install -m 0640 -- "$STAGING/bw-forge.env" "$CONFIG_DIR/bw-forge.env"
for unit in bw-forge-watch.service bw-forge-worker.service bw-forge-mcp.service bw-forge.target; do
  install -m 0644 -- "$STAGING/$unit" "$UNIT_DIR/$unit"
done

if [ -z "$DESTDIR" ]; then
  systemctl daemon-reload
  systemctl enable bw-forge.target
  if [ "$START" = 1 ]; then systemctl restart bw-forge.target; fi
else
  [ "$START" = 0 ] || die "--start cannot be combined with --destdir"
fi

printf 'Installed configuration: %s\n' "$CONFIG_DIR/bw-forge.env"
printf 'Installed units: %s/{bw-forge-watch.service,bw-forge-worker.service,bw-forge-mcp.service,bw-forge.target}\n' "$UNIT_DIR"
if [ -z "$DESTDIR" ] && [ "$START" = 0 ]; then printf 'Enabled for boot; start with: systemctl start bw-forge.target\n'; fi
