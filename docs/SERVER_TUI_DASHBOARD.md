# Server TUI Dashboard (`backend/tui`)

A reactive terminal dashboard for monitoring Etymos live server stats, verification checks, live API logs, and operational server logs directly on the GPU machine or streamed live from a local workstation.

---

## 1. Quick Start

### On the GPU Server (Default Local Server Mode)

```bash
cd /workspace/Etymos
bash backend/scripts/tui.sh
```

What works in **Local Server Mode**:
- **Always-on host visibility**: Machine CPU load, memory, disk, GPU memory/model stats, Supervisor services (`etymos-api`, `cloudflared`, `etymos-deploy`), and all server log files keep updating every `1.5s` even when `etymos-api` is stopped, crashed, or warming up (`API OFFLINE · HOST LIVE`).
- **Automatic loopback live attachment**: Whenever the API is healthy on `127.0.0.1:8000`, the TUI attaches automatically using the ephemeral `0600` token (`backend/logs/.local_ops_token`) managed by the API lifespan—requiring no manual login on SSH while rejecting any external/tunnel proxy headers (`CF-Connecting-IP`, `X-Forwarded-For`, etc.).

### On Your Local Dev Workstation (Remote Streaming Mode)

First-time setup with admin email, password, and authenticator TOTP code (`aal2` MFA):

```bash
bash backend/scripts/tui.sh --remote https://api.etymos.site --login
```

Subsequent launches reuse the cached `0600` session (and refresh automatically before expiry):

```bash
bash backend/scripts/tui.sh --remote https://api.etymos.site
```

Or provide a direct `aal2` bearer JWT (e.g. for Google OAuth admins):

```bash
ETYMOS_ADMIN_TOKEN='<jwt>' bash backend/scripts/tui.sh --remote https://api.etymos.site
```

Clear saved remote credentials:

```bash
bash backend/scripts/tui.sh --logout
```

---

## 2. Dashboard Panels & Responsive Layout

The dashboard adapts dynamically across four viewport sizes:
- **Wide (`>= 148 cols`)**: 4-column telemetry grid (`API process` · `Machine` · `GPU` · `Background work`), Services strip, Verification checks table, and expansive Log viewer.
- **Medium (`100–147 cols`)**: 2×2 telemetry grid + Services strip + Checks + Logs.
- **Narrow (`56–99 cols`)**: Stacked single-column summary + Checks + Logs.
- **Too small (`< 56×14`)**: Centered minimum-size prompt until resized.

Threshold progress bars highlight usage at `> 75%` (warning) and `> 90%` (critical), with `[WARN]` / `[CRIT]` text badges under `--no-color` or `NO_COLOR=1`.

---

## 3. Keyboard Shortcuts

| Keys | Action |
|---|---|
| `Tab` / `Shift+Tab` | Move focus between `Stats`, `Checks`, and `Logs` |
| `z` / `Esc` | Toggle full-screen zoom on focused pane / close modal or search |
| `1`..`8` or `[` / `]` | Switch log source (`1=Live`, `2=api`, `3=api-out`, `4=deploy`, `5=tests`, `6=tunnel`, `7=supervisor`, `8=autostart`) |
| `/` | Open inline search (`text` or `job:<id> req:<id> user:<id>`) |
| `l` | Cycle minimum severity filter (`DEBUG` → `INFO` → `WARNING` → `ERROR`) |
| `f` | In Logs: quick-filter by the highlighted row's `job`, `request`, or `user` tag |
| `c` | Clear all active log filters |
| `p` / `Space` | Pause or resume live auto-follow |
| `Up`/`Down`, `j`/`k`, `PgUp`/`PgDn` | Scroll or move selection (scrolling up pauses auto-follow) |
| `g` / `G` | Jump to oldest buffered entry / jump to live tail and resume |
| `Enter` / `e` | In Logs: expand or collapse inline error traceback |
| `Enter` | In Checks: jump directly to live logs filtered for that check |
| `a` / `Ctrl+P` | Open allowlisted Operational Actions Menu |
| `r` | Force immediate telemetry refresh |
| `?` / `F1` | Open keyboard help overlay |
| `q` / `Ctrl+C` | Quit cleanly and restore terminal state |

---

## 4. Guarded Operational Controls

Only the fixed allowlisted server actions in `backend/api/admin_ops.py` are exposed (no arbitrary shell execution):
- **Safe runtime actions**: Set API log level (`DEBUG`/`INFO`/`WARNING`/`ERROR`), dump thread stacks, unload idle GPU models, send due notifications, poll support inbox.
- **Managed services (`etymos-api`, `cloudflared`, `etymos-deploy`)**: Start, restart, or stop via confirmation dialog. Restarting or stopping `etymos-api` while checks are running requires explicit **Force Interrupt** confirmation; stopping `cloudflared` in Remote Mode displays an immediate disconnect warning.
- When `etymos-api` is down in Local Server Mode, `start`/`restart`/`stop` still run via `supervisorctl`.

---

## 5. Installing Dependencies After Updating

If `backend/requirements.txt` was updated manually outside `etymos-deploy`:

```bash
cd /workspace/Etymos
backend/.venv/bin/pip install -r backend/requirements.txt
# or if managed with uv:
uv pip install --python backend/.venv/bin/python -r backend/requirements.txt
```
