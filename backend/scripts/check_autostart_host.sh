#!/usr/bin/env bash
# Read-only diagnostic inspecting how the current host/container supports
# automatic startup of supervisord after a reboot or provider restart.
#
# Usage: bash backend/scripts/check_autostart_host.sh [--json]

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="${BACKEND_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
SUPERVISOR_CONF="${SUPERVISOR_CONF:-$BACKEND_DIR/supervisord.conf}"
SUPERVISORCTL_BIN="${SUPERVISORCTL_BIN:-$BACKEND_DIR/.venv/bin/supervisorctl}"
CLOUDFLARED_BIN="${CLOUDFLARED_BIN:-/usr/local/bin/cloudflared}"
WORKSPACE_DIR="${WORKSPACE_DIR:-/workspace}"
PERSISTENT_CLOUDFLARED="${PERSISTENT_CLOUDFLARED:-$WORKSPACE_DIR/bin/cloudflared}"
ONSTART_PATH="${ONSTART_PATH:-$WORKSPACE_DIR/onstart.sh}"
CRONTAB_BIN="${CRONTAB_BIN:-$(command -v crontab 2>/dev/null || true)}"

JSON_MODE=false
for arg in "$@"; do
  case "$arg" in
    --json) JSON_MODE=true ;;
    --help|-h)
      echo "Usage: $0 [--json]"
      exit 0
      ;;
    *)
      echo "ERROR: Unknown option '$arg'" >&2
      exit 1
      ;;
  esac
done

pid1_comm="${PID1_COMM_OVERRIDE:-$(ps -p 1 -o comm= 2>/dev/null | tr -d '[:space:]' || echo unknown)}"
systemd_active="false"
if [ -n "${SYSTEMD_CHECK_OVERRIDE:-}" ]; then
  systemd_active="$SYSTEMD_CHECK_OVERRIDE"
elif [ "$pid1_comm" = "systemd" ] || [ -d /run/systemd/system ]; then
  systemd_active="true"
fi

cron_available="false"
cron_running="false"
if [ -n "$CRONTAB_BIN" ] && [ -x "$CRONTAB_BIN" ]; then
  cron_available="true"
fi
if [ -n "${CRON_RUNNING_OVERRIDE:-}" ]; then
  cron_running="$CRON_RUNNING_OVERRIDE"
elif command -v pgrep >/dev/null 2>&1 && (pgrep -x cron >/dev/null 2>&1 || pgrep -x crond >/dev/null 2>&1); then
  cron_running="true"
fi

in_container="false"
if [ -f /.dockerenv ] || [ -f /run/.containerenv ]; then
  in_container="true"
fi

workspace_writable="false"
if [ -d "$WORKSPACE_DIR" ] && [ -w "$WORKSPACE_DIR" ]; then
  workspace_writable="true"
fi

conf_exists="false"
[ -f "$SUPERVISOR_CONF" ] && conf_exists="true"

cloudflared_present="false"
[ -x "$CLOUDFLARED_BIN" ] && cloudflared_present="true"

persistent_cloudflared_present="false"
[ -x "$PERSISTENT_CLOUDFLARED" ] && persistent_cloudflared_present="true"

onstart_exists="false"
[ -x "$ONSTART_PATH" ] && onstart_exists="true"

rc_local_writable="false"
[ -e /etc/rc.local ] && [ -w /etc/rc.local ] && rc_local_writable="true"

supervisor_running="false"
supervisor_pid=""
if [ -x "$SUPERVISORCTL_BIN" ] && [ -f "$SUPERVISOR_CONF" ]; then
  if pid_out="$("$SUPERVISORCTL_BIN" -c "$SUPERVISOR_CONF" pid 2>/dev/null)" && [[ "$pid_out" =~ ^[0-9]+$ ]] && kill -0 "$pid_out" 2>/dev/null; then
    supervisor_running="true"
    supervisor_pid="$pid_out"
  fi
fi

if [ "$systemd_active" = "true" ] && [ "$pid1_comm" = "systemd" ]; then
  recommended_mode="systemd"
elif [ "$cron_available" = "true" ] && [ "$cron_running" = "true" ]; then
  recommended_mode="auto"
else
  recommended_mode="provider-hook"
fi

if $JSON_MODE; then
  PY_BIN="${PYTHON_BIN:-$(command -v python3 2>/dev/null || echo python3)}"
  "$PY_BIN" - "$pid1_comm" "$systemd_active" "$cron_available" "$cron_running" \
    "$in_container" "$workspace_writable" "$conf_exists" "$cloudflared_present" \
    "$persistent_cloudflared_present" "$onstart_exists" "$rc_local_writable" \
    "$supervisor_running" "$supervisor_pid" "$recommended_mode" "$BACKEND_DIR" <<'PY'
import json, sys
(
    pid1_comm, systemd_active, cron_available, cron_running,
    in_container, workspace_writable, conf_exists, cloudflared_present,
    persistent_cloudflared_present, onstart_exists, rc_local_writable,
    supervisor_running, supervisor_pid, recommended_mode, backend_dir
) = sys.argv[1:]
to_bool = lambda v: v == "true"
print(json.dumps({
    "pid1": pid1_comm,
    "systemd_active": to_bool(systemd_active),
    "cron_available": to_bool(cron_available),
    "cron_running": to_bool(cron_running),
    "in_container": to_bool(in_container),
    "workspace_writable": to_bool(workspace_writable),
    "supervisord_conf_exists": to_bool(conf_exists),
    "cloudflared_present": to_bool(cloudflared_present),
    "persistent_cloudflared_present": to_bool(persistent_cloudflared_present),
    "onstart_exists": to_bool(onstart_exists),
    "rc_local_writable": to_bool(rc_local_writable),
    "supervisor_running": to_bool(supervisor_running),
    "supervisor_pid": int(supervisor_pid) if supervisor_pid.isdigit() else None,
    "recommended_mode": recommended_mode,
    "recommended_command": f"bash {backend_dir}/scripts/install_autostart.sh --mode {recommended_mode}",
}))
PY
  exit 0
fi

echo "Etymos Host Auto-Start Diagnostic"
echo "================================="
printf "PID 1 process              : %s\n" "$pid1_comm"
printf "systemd active             : %s\n" "$systemd_active"
printf "crontab installed / daemon : %s / %s\n" "$cron_available" "$cron_running"
printf "Container environment      : %s\n" "$in_container"
printf "/workspace writable        : %s (%s)\n" "$workspace_writable" "$WORKSPACE_DIR"
printf "supervisord.conf present   : %s (%s)\n" "$conf_exists" "$SUPERVISOR_CONF"
printf "supervisord running        : %s%s\n" "$supervisor_running" "${supervisor_pid:+ (pid=$supervisor_pid)}"
printf "cloudflared installed      : %s (%s)\n" "$cloudflared_present" "$CLOUDFLARED_BIN"
printf "Persistent cloudflared     : %s (%s)\n" "$persistent_cloudflared_present" "$PERSISTENT_CLOUDFLARED"
printf "Provider hook script       : %s (%s)\n" "$onstart_exists" "$ONSTART_PATH"
printf "Writable /etc/rc.local     : %s\n" "$rc_local_writable"
echo ""
echo "Recommended setup:"
echo "  bash $BACKEND_DIR/scripts/install_autostart.sh --mode $recommended_mode"
exit 0
