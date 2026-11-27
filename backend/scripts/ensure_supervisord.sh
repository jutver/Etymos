#!/usr/bin/env bash
# Idempotent, lock-protected bootstrapper that starts supervisord cleanly after
# a host reboot, clears dead stale socket/pid files, persists/restores
# cloudflared across container rootfs resets, and logs to autostart.log.
#
# Has ZERO dependency on SMTP, database, or outbound network to boot supervisord.
#
# Usage: bash backend/scripts/ensure_supervisord.sh [--quiet]

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="${BACKEND_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
SUPERVISOR_CONF="${SUPERVISOR_CONF:-$BACKEND_DIR/supervisord.conf}"
SUPERVISORD_BIN="${SUPERVISORD_BIN:-$BACKEND_DIR/.venv/bin/supervisord}"
SUPERVISORCTL_BIN="${SUPERVISORCTL_BIN:-$BACKEND_DIR/.venv/bin/supervisorctl}"
LOG_DIR="${LOG_DIR:-$BACKEND_DIR/logs}"
CLOUDFLARED_BIN="${CLOUDFLARED_BIN:-/usr/local/bin/cloudflared}"
if [ -n "${PERSISTENT_CLOUDFLARED:-}" ]; then
  PERSISTENT_CLOUDFLARED="$PERSISTENT_CLOUDFLARED"
elif [ -d /workspace ] && [ -w /workspace ]; then
  PERSISTENT_CLOUDFLARED="/workspace/bin/cloudflared"
else
  PERSISTENT_CLOUDFLARED="$LOG_DIR/cloudflared"
fi
AUTO_DOWNLOAD_CLOUDFLARED="${AUTO_DOWNLOAD_CLOUDFLARED:-true}"
CLOUDFLARED_DOWNLOAD_URL="${CLOUDFLARED_DOWNLOAD_URL:-https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64}"
SUPERVISOR_START_WAIT_SECONDS="${SUPERVISOR_START_WAIT_SECONDS:-5}"
AUTOSTART_LOG="$LOG_DIR/autostart.log"
LOCK_FILE="$LOG_DIR/autostart.lock"
LOCK_DIR="$LOG_DIR/autostart.lock.d"

QUIET=false
for arg in "$@"; do
  case "$arg" in
    --quiet) QUIET=true ;;
    --help|-h)
      echo "Usage: $0 [--quiet]"
      exit 0
      ;;
    *)
      echo "ERROR: Unknown option '$arg'" >&2
      exit 1
      ;;
  esac
done

mkdir -p "$LOG_DIR"

# Fallback resolution if .venv binaries are not present (e.g., global PATH)
if [ ! -x "$SUPERVISORD_BIN" ] && command -v supervisord >/dev/null 2>&1; then
  SUPERVISORD_BIN="$(command -v supervisord)"
fi
if [ ! -x "$SUPERVISORCTL_BIN" ] && command -v supervisorctl >/dev/null 2>&1; then
  SUPERVISORCTL_BIN="$(command -v supervisorctl)"
fi

log_line() {
  local level="$1"
  shift
  local ts line
  ts="$(date '+%Y-%m-%d %H:%M:%S %z')"
  line="$ts [$level] $*"
  printf '%s\n' "$line" >>"$AUTOSTART_LOG"
  if [ "$level" = "ERROR" ]; then
    printf '%s\n' "$line" >&2
  elif ! $QUIET; then
    printf '%s\n' "$line"
  fi
}

# Portable exclusive lock (flock on Linux; atomic mkdir fallback on macOS/minimal images)
LOCK_HELD_MODE=""
release_lock() {
  if [ "$LOCK_HELD_MODE" = "mkdir" ] && [ -d "$LOCK_DIR" ]; then
    if [ -f "$LOCK_DIR/pid" ] && [ "$(cat "$LOCK_DIR/pid" 2>/dev/null)" = "$$" ]; then
      rm -rf "$LOCK_DIR"
    fi
  elif [ "$LOCK_HELD_MODE" = "flock" ]; then
    exec 9>&- 2>/dev/null || true
  fi
}

acquire_lock() {
  if command -v flock >/dev/null 2>&1; then
    exec 9>"$LOCK_FILE"
    if flock -w 30 9; then
      LOCK_HELD_MODE="flock"
      trap release_lock EXIT
      return 0
    fi
    return 1
  fi

  local waited=0 stale_pid
  while [ "$waited" -lt 30 ]; do
    if mkdir "$LOCK_DIR" 2>/dev/null; then
      echo "$$" >"$LOCK_DIR/pid"
      LOCK_HELD_MODE="mkdir"
      trap release_lock EXIT
      return 0
    fi
    stale_pid="$(cat "$LOCK_DIR/pid" 2>/dev/null || true)"
    if [ -n "$stale_pid" ] && ! kill -0 "$stale_pid" 2>/dev/null; then
      rm -rf "$LOCK_DIR"
      continue
    fi
    sleep 0.2 2>/dev/null || sleep 1
    waited=$((waited + 1))
  done
  return 1
}

read_live_supervisor_pid() {
  local ctl_pid file_pid cmdline
  if [ -x "$SUPERVISORCTL_BIN" ] && [ -f "$SUPERVISOR_CONF" ]; then
    ctl_pid="$("$SUPERVISORCTL_BIN" -c "$SUPERVISOR_CONF" pid 2>/dev/null || true)"
    if [[ "$ctl_pid" =~ ^[0-9]+$ ]] && kill -0 "$ctl_pid" 2>/dev/null; then
      echo "$ctl_pid"
      return 0
    fi
  fi

  local pid_file="$LOG_DIR/supervisord.pid"
  if [ -f "$pid_file" ]; then
    file_pid="$(tr -d '[:space:]' <"$pid_file" 2>/dev/null || true)"
    if [[ "$file_pid" =~ ^[0-9]+$ ]] && kill -0 "$file_pid" 2>/dev/null; then
      cmdline="$(ps -p "$file_pid" -o args= 2>/dev/null || true)"
      if echo "$cmdline" | grep -qiE 'supervisord|supervisor'; then
        if [ -S "$LOG_DIR/supervisor.sock" ]; then
          echo "$file_pid"
          return 0
        fi
      fi
    fi
  fi
  return 1
}

sync_cloudflared() {
  local cf_dir persist_dir
  cf_dir="$(dirname "$CLOUDFLARED_BIN")"
  persist_dir="$(dirname "$PERSISTENT_CLOUDFLARED")"

  if [ -x "$CLOUDFLARED_BIN" ]; then
    if [ ! -x "$PERSISTENT_CLOUDFLARED" ] && mkdir -p "$persist_dir" 2>/dev/null && [ -w "$persist_dir" ]; then
      if cp "$CLOUDFLARED_BIN" "$PERSISTENT_CLOUDFLARED" 2>/dev/null; then
        chmod +x "$PERSISTENT_CLOUDFLARED" 2>/dev/null || true
        log_line INFO "Backed up cloudflared to persistent cache ($PERSISTENT_CLOUDFLARED)"
      fi
    fi
    return 0
  fi

  if [ -x "$PERSISTENT_CLOUDFLARED" ]; then
    if mkdir -p "$cf_dir" 2>/dev/null && cp "$PERSISTENT_CLOUDFLARED" "$CLOUDFLARED_BIN" 2>/dev/null; then
      chmod +x "$CLOUDFLARED_BIN" 2>/dev/null || true
      log_line INFO "Restored cloudflared from persistent cache ($PERSISTENT_CLOUDFLARED -> $CLOUDFLARED_BIN)"
      return 0
    fi
    log_line WARN "Found persistent cloudflared ($PERSISTENT_CLOUDFLARED) but could not copy to $CLOUDFLARED_BIN"
    return 0
  fi

  if [ "$AUTO_DOWNLOAD_CLOUDFLARED" = "true" ] && command -v curl >/dev/null 2>&1; then
    local tmp_cf
    tmp_cf="$(mktemp "$LOG_DIR/cloudflared.XXXXXX" 2>/dev/null || true)"
    if [ -n "$tmp_cf" ] && curl -fsSL --max-time 30 -o "$tmp_cf" "$CLOUDFLARED_DOWNLOAD_URL" 2>/dev/null; then
      chmod +x "$tmp_cf"
      if mkdir -p "$persist_dir" 2>/dev/null && cp "$tmp_cf" "$PERSISTENT_CLOUDFLARED" 2>/dev/null; then
        chmod +x "$PERSISTENT_CLOUDFLARED" 2>/dev/null || true
      fi
      if mkdir -p "$cf_dir" 2>/dev/null && cp "$tmp_cf" "$CLOUDFLARED_BIN" 2>/dev/null; then
        chmod +x "$CLOUDFLARED_BIN" 2>/dev/null || true
        log_line INFO "Downloaded cloudflared and installed to $CLOUDFLARED_BIN"
      else
        log_line WARN "Downloaded cloudflared to cache but could not write $CLOUDFLARED_BIN"
      fi
      rm -f "$tmp_cf"
      return 0
    fi
    rm -f "${tmp_cf:-}"
    log_line WARN "cloudflared missing at $CLOUDFLARED_BIN and download failed; continuing to boot supervisord anyway"
  else
    log_line WARN "cloudflared missing at $CLOUDFLARED_BIN (persistent cache absent); continuing to boot supervisord"
  fi
}

if ! acquire_lock; then
  log_line ERROR "Timed out waiting for autostart lock ($LOCK_FILE)"
  exit 1
fi

if live_pid="$(read_live_supervisor_pid)"; then
  sync_cloudflared
  if ! $QUIET; then
    log_line INFO "supervisord already running (pid=$live_pid); no action taken"
  fi
  exit 0
fi

if [ ! -f "$SUPERVISOR_CONF" ]; then
  log_line ERROR "Missing supervisord config at $SUPERVISOR_CONF"
  exit 1
fi

if [ ! -x "$SUPERVISORD_BIN" ]; then
  log_line ERROR "Missing executable supervisord binary at $SUPERVISORD_BIN"
  exit 1
fi

sync_cloudflared

# Clean stale runtime files left behind by an abrupt power loss or container kill.
cleaned=()
if [ -e "$LOG_DIR/supervisor.sock" ] || [ -S "$LOG_DIR/supervisor.sock" ]; then
  rm -f "$LOG_DIR/supervisor.sock"
  cleaned+=("supervisor.sock")
fi
if [ -e "$LOG_DIR/supervisord.pid" ]; then
  rm -f "$LOG_DIR/supervisord.pid"
  cleaned+=("supervisord.pid")
fi
if [ "${#cleaned[@]}" -gt 0 ]; then
  log_line INFO "Removed stale runtime file(s) before startup: ${cleaned[*]}"
fi

if ! "$SUPERVISORD_BIN" -c "$SUPERVISOR_CONF"; then
  log_line ERROR "supervisord failed to start with config $SUPERVISOR_CONF"
  exit 1
fi

new_pid=""
waited=0
max_ticks=$((SUPERVISOR_START_WAIT_SECONDS * 5))
[ "$max_ticks" -lt 1 ] && max_ticks=1
while [ "$waited" -lt "$max_ticks" ]; do
  if new_pid="$(read_live_supervisor_pid)"; then
    break
  fi
  sleep 0.2 2>/dev/null || sleep 1
  waited=$((waited + 1))
done

if [ -n "$new_pid" ]; then
  summary="$("$SUPERVISORCTL_BIN" -c "$SUPERVISOR_CONF" status 2>/dev/null | tr '\n' ';' | sed 's/;*$//' || true)"
  log_line INFO "Started supervisord (pid=$new_pid)${summary:+ | status: $summary}"
  exit 0
fi

log_line ERROR "supervisord launched but did not respond on $SUPERVISOR_CONF within ${SUPERVISOR_START_WAIT_SECONDS}s"
exit 1
