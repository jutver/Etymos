#!/usr/bin/env bash
# Idempotent installer that wires backend/scripts/ensure_supervisord.sh into
# the host's boot hook (provider on-start script, cron @reboot + watchdog,
# and/or systemd service).
#
# Usage: bash backend/scripts/install_autostart.sh [--mode auto|provider-hook|cron|systemd] [--dry-run]

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="${BACKEND_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
ENSURE_SCRIPT="$BACKEND_DIR/scripts/ensure_supervisord.sh"
PROVIDER_ONSTART_PATH="${PROVIDER_ONSTART_PATH:-/workspace/onstart.sh}"
SYSTEMD_UNIT_PATH="${SYSTEMD_UNIT_PATH:-/etc/systemd/system/etymos-supervisor.service}"
CRONTAB_BIN="${CRONTAB_BIN:-$(command -v crontab 2>/dev/null || true)}"
SYSTEMCTL_BIN="${SYSTEMCTL_BIN:-$(command -v systemctl 2>/dev/null || true)}"
SKIP_SYSTEMCTL_EXEC="${SKIP_SYSTEMCTL_EXEC:-false}"

MODE="auto"
DRY_RUN=false

while [ "$#" -gt 0 ]; do
  case "$1" in
    --mode)
      shift
      [ "$#" -gt 0 ] || { echo "ERROR: --mode requires an argument" >&2; exit 1; }
      MODE="$1"
      ;;
    --mode=*)
      MODE="${1#--mode=}"
      ;;
    --dry-run)
      DRY_RUN=true
      ;;
    --help|-h)
      echo "Usage: $0 [--mode auto|provider-hook|cron|systemd] [--dry-run]"
      exit 0
      ;;
    *)
      echo "ERROR: Unknown option '$1'" >&2
      exit 1
      ;;
  esac
  shift
done

case "$MODE" in
  auto|provider-hook|cron|systemd) ;;
  *)
    echo "ERROR: Invalid mode '$MODE' (expected auto, provider-hook, cron, or systemd)" >&2
    exit 1
    ;;
esac

if [ ! -f "$ENSURE_SCRIPT" ]; then
  echo "ERROR: Missing $ENSURE_SCRIPT" >&2
  exit 1
fi

pid1_comm="${PID1_COMM_OVERRIDE:-$(ps -p 1 -o comm= 2>/dev/null | tr -d '[:space:]' || echo unknown)}"
BEGIN_MARKER="# BEGIN ETYMOS AUTOSTART"
END_MARKER="# END ETYMOS AUTOSTART"

install_provider_hook() {
  local target_dir
  target_dir="$(dirname "$PROVIDER_ONSTART_PATH")"
  local content
  content="$(cat <<EOF
#!/usr/bin/env bash
set -euo pipefail
exec "$ENSURE_SCRIPT" --quiet
EOF
)"
  if $DRY_RUN; then
    echo "[DRY-RUN] Would write executable provider hook: $PROVIDER_ONSTART_PATH"
    echo "$content"
  else
    mkdir -p "$target_dir"
    printf '%s\n' "$content" >"$PROVIDER_ONSTART_PATH"
    chmod +x "$PROVIDER_ONSTART_PATH" "$ENSURE_SCRIPT"
    echo "Installed provider on-start hook: $PROVIDER_ONSTART_PATH"
  fi
  echo "Provider dashboard command (if supported): $PROVIDER_ONSTART_PATH"
}

install_cron() {
  if [ -z "$CRONTAB_BIN" ] || [ ! -x "$CRONTAB_BIN" ]; then
    echo "WARN: crontab binary not found; skipping cron installation" >&2
    return 1
  fi

  local existing stripped new_block updated
  existing="$("$CRONTAB_BIN" -l 2>/dev/null || true)"
  stripped="$(printf '%s\n' "$existing" | awk -v b="$BEGIN_MARKER" -v e="$END_MARKER" '
    $0 == b { skip=1; next }
    $0 == e { skip=0; next }
    !skip { print }
  ')"
  new_block="$BEGIN_MARKER
@reboot $ENSURE_SCRIPT --quiet
*/2 * * * * $ENSURE_SCRIPT --quiet
$END_MARKER"

  if [ -n "$(printf '%s' "$stripped" | tr -d '[:space:]')" ]; then
    updated="$stripped
$new_block"
  else
    updated="$new_block"
  fi

  if $DRY_RUN; then
    echo "[DRY-RUN] Would install crontab entries via $CRONTAB_BIN:"
    echo "$new_block"
  else
    printf '%s\n' "$updated" | "$CRONTAB_BIN" -
    echo "Installed idempotent cron @reboot and */2 watchdog entries."
  fi

  if command -v pgrep >/dev/null 2>&1; then
    if ! pgrep -x cron >/dev/null 2>&1 && ! pgrep -x crond >/dev/null 2>&1; then
      echo "NOTE: cron daemon is not currently running; start 'cron' or use provider hook $PROVIDER_ONSTART_PATH if this container has no init daemon."
    fi
  fi
  return 0
}

install_systemd() {
  if [ "$pid1_comm" != "systemd" ] && [ "$SKIP_SYSTEMCTL_EXEC" != "true" ]; then
    echo "ERROR: Host PID 1 is '$pid1_comm', not systemd. Use --mode auto or --mode provider-hook." >&2
    return 1
  fi

  local unit_dir user_name
  unit_dir="$(dirname "$SYSTEMD_UNIT_PATH")"
  user_name="${SUDO_USER:-$(id -un)}"
  local unit_content
  unit_content="[Unit]
Description=Etymos Supervisord Auto-Start
After=network-online.target
Wants=network-online.target

[Service]
Type=forking
User=$user_name
WorkingDirectory=$BACKEND_DIR
ExecStart=/usr/bin/env bash $ENSURE_SCRIPT
ExecStop=$BACKEND_DIR/.venv/bin/supervisorctl -c $BACKEND_DIR/supervisord.conf shutdown
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target"

  if $DRY_RUN; then
    echo "[DRY-RUN] Would write systemd unit: $SYSTEMD_UNIT_PATH"
    echo "$unit_content"
    return 0
  fi

  mkdir -p "$unit_dir"
  printf '%s\n' "$unit_content" >"$SYSTEMD_UNIT_PATH"
  if [ "$SKIP_SYSTEMCTL_EXEC" != "true" ] && [ -n "$SYSTEMCTL_BIN" ] && [ -x "$SYSTEMCTL_BIN" ]; then
    "$SYSTEMCTL_BIN" daemon-reload
    "$SYSTEMCTL_BIN" enable etymos-supervisor.service
  fi
  echo "Installed systemd unit: $SYSTEMD_UNIT_PATH"
  return 0
}

case "$MODE" in
  provider-hook)
    install_provider_hook
    ;;
  cron)
    install_cron
    ;;
  systemd)
    install_systemd
    ;;
  auto)
    install_provider_hook
    if [ -n "$CRONTAB_BIN" ] && [ -x "$CRONTAB_BIN" ]; then
      install_cron || true
    else
      echo "Skipping cron (crontab not installed)."
    fi
    if [ "$pid1_comm" = "systemd" ]; then
      install_systemd || true
    fi
    ;;
esac

echo ""
echo "Verify anytime with:"
echo "  bash $ENSURE_SCRIPT"
exit 0
