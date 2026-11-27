"""
Subprocess integration tests for host auto-start scripts:
  - backend/scripts/check_autostart_host.sh
  - backend/scripts/ensure_supervisord.sh
  - backend/scripts/install_autostart.sh

Runs strictly in temporary directories using fake supervisord/supervisorctl/
crontab/systemctl shims so the local host is never modified.
"""
from __future__ import annotations

import json
import os
import stat
import subprocess
import textwrap
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parent.parent / "scripts"
CHECK_SCRIPT = SCRIPTS_DIR / "check_autostart_host.sh"
ENSURE_SCRIPT = SCRIPTS_DIR / "ensure_supervisord.sh"
INSTALL_SCRIPT = SCRIPTS_DIR / "install_autostart.sh"


def _write_exe(path: Path, body: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(textwrap.dedent(body).lstrip(), encoding="utf-8")
    path.chmod(path.stat().st_mode | stat.S_IXUSR)
    return path


def _setup_fake_supervisor(tmp_path: Path) -> dict[str, Path]:
    backend = tmp_path / "backend"
    log_dir = backend / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    conf = backend / "supervisord.conf"
    conf.write_text("[supervisord]\nnodaemon=false\n", encoding="utf-8")

    launch_counter = tmp_path / "launch_count.txt"
    pid_file = log_dir / "supervisord.pid"
    sock_file = log_dir / "supervisor.sock"
    state_file = tmp_path / "supervisor_running.txt"

    supervisord_bin = _write_exe(
        backend / ".venv" / "bin" / "supervisord",
        f"""
        #!/usr/bin/env bash
        set -euo pipefail
        count=0
        if [ -f "{launch_counter}" ]; then
          count="$(cat "{launch_counter}")"
        fi
        count=$((count + 1))
        echo "$count" > "{launch_counter}"
        python3 -c 'import os, socket, time, sys
sock_dir, sock_name = os.path.split(sys.argv[1])
os.chdir(sock_dir)
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
if os.path.exists(sock_name): os.unlink(sock_name)
s.bind(sock_name)
s.listen(1)
open(sys.argv[2], "w").write(str(os.getpid()))
open(sys.argv[3], "w").write("running")
time.sleep(8)
' "{sock_file}" "{pid_file}" "{state_file}" >/dev/null 2>&1 &
        sleep 0.3
        """,
    )

    supervisorctl_bin = _write_exe(
        backend / ".venv" / "bin" / "supervisorctl",
        f"""
        #!/usr/bin/env bash
        cmd="${{3:-status}}"
        if [ "$cmd" = "pid" ]; then
          if [ -f "{pid_file}" ] && [ -S "{sock_file}" ]; then
            pid="$(cat "{pid_file}")"
            if kill -0 "$pid" 2>/dev/null; then
              echo "$pid"
              exit 0
            fi
          fi
          echo "unix://{sock_file} no such file" >&2
          exit 1
        elif [ "$cmd" = "status" ]; then
          if [ -f "{pid_file}" ] && kill -0 "$(cat "{pid_file}")" 2>/dev/null; then
            echo "etymos-api RUNNING pid 101"
            echo "cloudflared RUNNING pid 102"
            exit 0
          fi
          exit 1
        fi
        exit 0
        """,
    )

    return {
        "backend": backend,
        "log_dir": log_dir,
        "conf": conf,
        "supervisord": supervisord_bin,
        "supervisorctl": supervisorctl_bin,
        "launch_counter": launch_counter,
        "pid_file": pid_file,
        "sock_file": sock_file,
    }


def _kill_fake_supervisor(pid_file: Path) -> None:
    if pid_file.exists():
        try:
            pid = int(pid_file.read_text().strip())
            os.kill(pid, 9)
        except Exception:
            pass


def test_ensure_cleans_stale_files_and_boots_without_smtp_or_db(tmp_path: Path):
    env_paths = _setup_fake_supervisor(tmp_path)
    cloudflared = _write_exe(tmp_path / "usr_local_bin" / "cloudflared", "#!/usr/bin/env bash\nexit 0\n")
    persistent_cf = tmp_path / "workspace" / "bin" / "cloudflared"

    # Simulate abrupt crash leftovers (plain stale socket file + dead PID)
    env_paths["sock_file"].write_text("stale", encoding="utf-8")
    env_paths["pid_file"].write_text("999999", encoding="utf-8")

    # Strip SMTP and Supabase variables to guarantee boot independence (SC-006).
    clean_env = {
        "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
        "BACKEND_DIR": str(env_paths["backend"]),
        "SUPERVISOR_CONF": str(env_paths["conf"]),
        "SUPERVISORD_BIN": str(env_paths["supervisord"]),
        "SUPERVISORCTL_BIN": str(env_paths["supervisorctl"]),
        "LOG_DIR": str(env_paths["log_dir"]),
        "CLOUDFLARED_BIN": str(cloudflared),
        "PERSISTENT_CLOUDFLARED": str(persistent_cf),
        "AUTO_DOWNLOAD_CLOUDFLARED": "false",
    }
    try:
        res = subprocess.run(
            ["bash", str(ENSURE_SCRIPT)],
            env=clean_env,
            capture_output=True,
            text=True,
            timeout=15,
        )
        assert res.returncode == 0, res.stderr + res.stdout
        assert env_paths["launch_counter"].read_text().strip() == "1"
        assert persistent_cf.is_file()
        log_text = (env_paths["log_dir"] / "autostart.log").read_text(encoding="utf-8")
        assert "Removed stale runtime file(s) before startup: supervisor.sock supervisord.pid" in log_text
        assert "Started supervisord" in log_text
        assert "Backed up cloudflared" in log_text

        # Second invocation while already running must be strictly idempotent (SC-002).
        res2 = subprocess.run(
            ["bash", str(ENSURE_SCRIPT), "--quiet"],
            env=clean_env,
            capture_output=True,
            text=True,
            timeout=15,
        )
        assert res2.returncode == 0
        assert res2.stdout == ""
        assert env_paths["launch_counter"].read_text().strip() == "1"
    finally:
        _kill_fake_supervisor(env_paths["pid_file"])


def test_ensure_restores_cloudflared_after_rootfs_reset_and_handles_concurrent_runs(tmp_path: Path):
    env_paths = _setup_fake_supervisor(tmp_path)
    missing_cf = tmp_path / "usr_local_bin" / "cloudflared"
    persistent_cf = _write_exe(tmp_path / "workspace" / "bin" / "cloudflared", "#!/usr/bin/env bash\nexit 0\n")

    env = {
        "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
        "BACKEND_DIR": str(env_paths["backend"]),
        "SUPERVISOR_CONF": str(env_paths["conf"]),
        "SUPERVISORD_BIN": str(env_paths["supervisord"]),
        "SUPERVISORCTL_BIN": str(env_paths["supervisorctl"]),
        "LOG_DIR": str(env_paths["log_dir"]),
        "CLOUDFLARED_BIN": str(missing_cf),
        "PERSISTENT_CLOUDFLARED": str(persistent_cf),
        "AUTO_DOWNLOAD_CLOUDFLARED": "false",
    }

    try:
        with ThreadPoolExecutor(max_workers=2) as pool:
            futures = [
                pool.submit(
                    subprocess.run,
                    ["bash", str(ENSURE_SCRIPT)],
                    env=env,
                    capture_output=True,
                    text=True,
                    timeout=15,
                )
                for _ in range(2)
            ]
            results = [f.result() for f in futures]

        assert all(r.returncode == 0 for r in results), results
        assert env_paths["launch_counter"].read_text().strip() == "1"
        assert missing_cf.is_file() and os.access(missing_cf, os.X_OK)
        log_text = (env_paths["log_dir"] / "autostart.log").read_text(encoding="utf-8")
        assert "Restored cloudflared from persistent cache" in log_text
    finally:
        _kill_fake_supervisor(env_paths["pid_file"])


def test_ensure_logs_clear_error_when_config_missing(tmp_path: Path):
    log_dir = tmp_path / "logs"
    res = subprocess.run(
        ["bash", str(ENSURE_SCRIPT)],
        env={
            "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
            "BACKEND_DIR": str(tmp_path),
            "SUPERVISOR_CONF": str(tmp_path / "missing.conf"),
            "LOG_DIR": str(log_dir),
            "AUTO_DOWNLOAD_CLOUDFLARED": "false",
        },
        capture_output=True,
        text=True,
        timeout=10,
    )
    assert res.returncode == 1
    assert "Missing supervisord config" in res.stderr
    assert "Missing supervisord config" in (log_dir / "autostart.log").read_text(encoding="utf-8")


def test_check_autostart_host_json_and_text(tmp_path: Path):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    backend = workspace / "Etymos" / "backend"
    backend.mkdir(parents=True)
    (backend / "supervisord.conf").write_text("[supervisord]\n", encoding="utf-8")
    fake_crontab = _write_exe(tmp_path / "bin" / "crontab", "#!/usr/bin/env bash\nexit 0\n")

    env = {
        "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
        "BACKEND_DIR": str(backend),
        "WORKSPACE_DIR": str(workspace),
        "SUPERVISOR_CONF": str(backend / "supervisord.conf"),
        "SUPERVISORCTL_BIN": str(backend / ".venv" / "bin" / "supervisorctl"),
        "CLOUDFLARED_BIN": str(tmp_path / "cloudflared"),
        "PERSISTENT_CLOUDFLARED": str(workspace / "bin" / "cloudflared"),
        "ONSTART_PATH": str(workspace / "onstart.sh"),
        "CRONTAB_BIN": str(fake_crontab),
        "PID1_COMM_OVERRIDE": "bash",
        "SYSTEMD_CHECK_OVERRIDE": "false",
        "CRON_RUNNING_OVERRIDE": "true",
    }

    res_json = subprocess.run(
        ["bash", str(CHECK_SCRIPT), "--json"],
        env=env,
        capture_output=True,
        text=True,
        timeout=10,
    )
    assert res_json.returncode == 0, res_json.stderr
    data = json.loads(res_json.stdout)
    assert data["pid1"] == "bash"
    assert data["systemd_active"] is False
    assert data["cron_available"] is True
    assert data["cron_running"] is True
    assert data["workspace_writable"] is True
    assert data["recommended_mode"] == "auto"

    res_text = subprocess.run(
        ["bash", str(CHECK_SCRIPT)],
        env=env,
        capture_output=True,
        text=True,
        timeout=10,
    )
    assert res_text.returncode == 0
    assert "install_autostart.sh --mode auto" in res_text.stdout


def test_install_autostart_modes_are_idempotent(tmp_path: Path):
    backend = tmp_path / "backend"
    scripts = backend / "scripts"
    scripts.mkdir(parents=True)
    # Copy real ensure_supervisord marker path cleanly
    target_ensure = scripts / "ensure_supervisord.sh"
    target_ensure.write_text("#!/usr/bin/env bash\nexit 0\n", encoding="utf-8")
    target_ensure.chmod(0o755)

    cron_store = tmp_path / "crontab_store.txt"
    cron_store.write_text("0 4 * * * /usr/bin/true\n", encoding="utf-8")
    fake_crontab = _write_exe(
        tmp_path / "bin" / "crontab",
        f"""
        #!/usr/bin/env bash
        if [ "${{1:-}}" = "-l" ]; then
          cat "{cron_store}"
          exit 0
        fi
        if [ "${{1:-}}" = "-" ]; then
          cat > "{cron_store}"
          exit 0
        fi
        exit 1
        """,
    )
    onstart_path = tmp_path / "workspace" / "onstart.sh"
    systemd_unit = tmp_path / "etc" / "systemd" / "system" / "etymos-supervisor.service"

    env = {
        "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
        "BACKEND_DIR": str(backend),
        "PROVIDER_ONSTART_PATH": str(onstart_path),
        "SYSTEMD_UNIT_PATH": str(systemd_unit),
        "CRONTAB_BIN": str(fake_crontab),
        "PID1_COMM_OVERRIDE": "bash",
        "SKIP_SYSTEMCTL_EXEC": "true",
    }

    # 1. --dry-run must write nothing
    dry = subprocess.run(
        ["bash", str(INSTALL_SCRIPT), "--mode", "auto", "--dry-run"],
        env=env,
        capture_output=True,
        text=True,
        timeout=10,
    )
    assert dry.returncode == 0
    assert not onstart_path.exists()
    assert "# BEGIN ETYMOS AUTOSTART" not in cron_store.read_text(encoding="utf-8")

    # 2. Install auto twice -> idempotent single managed block + preserved existing cron job
    for _ in range(2):
        run = subprocess.run(
            ["bash", str(INSTALL_SCRIPT), "--mode", "auto"],
            env=env,
            capture_output=True,
            text=True,
            timeout=10,
        )
        assert run.returncode == 0, run.stderr

    assert onstart_path.is_file() and os.access(onstart_path, os.X_OK)
    onstart_text = onstart_path.read_text(encoding="utf-8")
    assert "ensure_supervisord.sh" in onstart_text and "--quiet" in onstart_text
    cron_text = cron_store.read_text(encoding="utf-8")
    assert "0 4 * * * /usr/bin/true" in cron_text
    assert cron_text.count("# BEGIN ETYMOS AUTOSTART") == 1
    assert "@reboot " in cron_text
    assert "*/2 * * * * " in cron_text

    # 3. systemd mode generates valid unit file
    sysd = subprocess.run(
        ["bash", str(INSTALL_SCRIPT), "--mode", "systemd"],
        env=env,
        capture_output=True,
        text=True,
        timeout=10,
    )
    assert sysd.returncode == 0, sysd.stderr
    unit_text = systemd_unit.read_text(encoding="utf-8")
    assert "ExecStart=" in unit_text and "ensure_supervisord.sh" in unit_text
