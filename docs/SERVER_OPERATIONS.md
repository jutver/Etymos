# Backend server operations (supervisor)

Day-to-day running of the Etymos backend on the GPU cloud machine: deploying
backend changes, restarting, reading logs, and recovering after the machine
restarts. For first-time provisioning history see `DEPLOY_BACKEND.md` (its
paths are from the older n1/n2 machines; the paths below are current).

## What runs where

The machine is a container with no init system (PID 1 is a shell), so
**supervisord** keeps two processes alive and restarts them if they crash:

| Program | What it does | Logs |
|---|---|---|
| `etymos-api` | FastAPI backend (uvicorn) on port 8000, started by `scripts/run_api.sh`, which loads `.env` | `logs/api.err.log` (app output), `logs/api.out.log` |
| `cloudflared` | Cloudflare Tunnel publishing `https://api.etymos.site` → `localhost:8000` | `logs/cloudflared.err.log` |

| Path | Contents |
|---|---|
| `/workspace/Etymos` | Git checkout of `github.com/jutver/Etymos` (branch `main`) |
| `/workspace/Etymos/backend/.venv` | Python environment (uvicorn, supervisor, all requirements) |
| `/workspace/Etymos/backend/.env` | Backend secrets and settings — never committed |
| `/workspace/Etymos/backend/supervisord.conf` | Supervisor config — server-only, not in git (copy below) |
| `/workspace/Etymos/backend/scripts/run_api.sh` | API start script — server-only, not in git (copy below) |
| `/workspace/Etymos/backend/logs/` | All logs, plus supervisor's socket and pid file |
| `/workspace/.cloudflared/` | Tunnel config, credentials and `cert.pem` — never committed |

Everything lives under `/workspace` because it survives a machine restart;
`/root` may not.

## The one shortcut to set first

Every command below uses `$SV`. Set it in each new shell (or add the line to
`~/.bashrc`):

```bash
SV="/workspace/Etymos/backend/.venv/bin/supervisorctl -c /workspace/Etymos/backend/supervisord.conf"
```

## Everyday commands

```bash
$SV status                      # both should say RUNNING
$SV restart etymos-api          # restart the API only (tunnel keeps running)
$SV restart all                 # restart API and tunnel
$SV stop etymos-api             # stop without restarting
$SV start etymos-api
$SV tail -f etymos-api stderr   # live API log (Ctrl+C to stop following)
curl -s localhost:8000/api/health; echo     # {"status":"ok",...} when the API is up
```

The API takes ~20–40 s to load its models after a (re)start; `status` shows
`STARTING` until then and `/api/health` doesn't answer yet.

## Deploying a backend change

After pushing to `main`:

```bash
cd /workspace/Etymos
git pull
# Only if backend/requirements.txt changed:
backend/.venv/bin/pip install -r backend/requirements.txt
$SV restart etymos-api
sleep 30; $SV status
curl -s localhost:8000/api/health; echo
```

Then confirm from anywhere: `curl https://api.etymos.site/api/health`.

The frontend (`apps/web`, `apps/admin`) deploys separately through Vercel on
push — nothing to do on this machine. Database migrations go through
`supabase db push` from a dev machine, not here.

**If `git pull` refuses** with "Your local changes … would be overwritten":
the server writes runtime data into some tracked files (`backend/paper_cache/*`,
`backend/__pycache__/*.pyc`). Discard the server's copies of just the files
it names, then pull again:

```bash
git checkout -- <the files git listed>
git pull
```

Never `git reset --hard` or `git clean` here: `api_reports/`, `paper_cache/`,
`.env`, `supervisord.conf` and `scripts/run_api.sh` are untracked or local
state and would be lost.

## Changing `.env`

Edit `backend/.env`, then `$SV restart etymos-api` — the file is only read at
start-up.

`run_api.sh` loads `.env` with bash `source`, so it must be valid shell:
quote any value containing spaces, `<`, `>`, `$`, `&`, `;` or quotes, with
single quotes:

```bash
SMTP_PASSWORD='p@ss$word'
SMTP_FROM='Etymos <noreply@etymos.site>'
```

A bad line makes the API exit at start-up; `logs/api.err.log` then shows a
bash error instead of uvicorn output. Check a file without restarting with
`bash -n backend/.env`.

## After the machine restarts

Supervisord does not come back by itself (no init system). Symptom:
`$SV status` says `unix:///…/supervisor.sock no such file`, and
`api.etymos.site` returns Cloudflare error 1033. Start it:

```bash
cd /workspace/Etymos/backend
rm -f logs/supervisor.sock logs/supervisord.pid
.venv/bin/supervisord -c supervisord.conf
sleep 40; $SV status
```

If `/usr/local/bin/cloudflared` is gone (fresh machine image), reinstall it
first — see "Setting up a new machine" step 2.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `supervisor.sock no such file` | supervisord isn't running | "After the machine restarts" above |
| `api.etymos.site` → error **1033** | Tunnel not connected | `$SV status`; if `cloudflared` is FATAL, read `tail -20 logs/cloudflared.err.log`, fix, then `$SV start cloudflared` |
| `api.etymos.site` → error **502** | Tunnel up, API down or still starting | Wait 40 s; then `tail -40 logs/api.err.log` |
| `etymos-api` uptime keeps resetting; log says `address already in use` | A second API copy (e.g. a uvicorn started by hand) holds port 8000 | `$SV stop etymos-api; pkill -f "uvicorn api.app:app"; sleep 2; $SV start etymos-api` |
| `cloudflared  FATAL  can't find command` | cloudflared not installed | New machine step 2, then `$SV start cloudflared` |
| `cloudflared` log: `open …/config.yml: no such file` | Tunnel files missing from `/workspace/.cloudflared` | New machine step 3 |
| `ERROR (spawn error)` on start | The command can't be launched | Run the `command=` line from `supervisord.conf` by hand to see the real error |
| A program stuck in FATAL after you fixed the cause | Supervisord stopped retrying | `$SV start <name>`; if it still refuses, `$SV shutdown`, wait 3 s, start supervisord again |
| API log: `ModuleNotFoundError` after a pull | New Python dependency | `backend/.venv/bin/pip install -r backend/requirements.txt`, restart |

Cloudflared's `failed to sufficiently increase receive buffer size` line is
a harmless performance warning.

## Setting up a new machine

1. **Code and Python env**
   ```bash
   cd /workspace && git clone https://github.com/jutver/Etymos.git && cd Etymos/backend
   python3 -m venv .venv
   .venv/bin/pip install -r requirements.txt supervisor
   ```
   Copy `backend/.env` over from the old machine (or rebuild it from the
   password manager), and create `scripts/run_api.sh` and `supervisord.conf`
   from the copies below. `chmod +x scripts/run_api.sh`; `mkdir -p logs`.

2. **cloudflared**
   ```bash
   curl -L -o /usr/local/bin/cloudflared https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64
   chmod +x /usr/local/bin/cloudflared
   ```

3. **Tunnel files** — reuses the existing `etymos-api` tunnel, so DNS needs no
   change. `tunnel login` prints a URL: open it and pick `etymos.site`.
   ```bash
   mkdir -p /workspace/.cloudflared && chmod 700 /workspace/.cloudflared
   cloudflared tunnel login            # writes ~/.cloudflared/cert.pem
   cp ~/.cloudflared/cert.pem /workspace/.cloudflared/
   TID=5a60d1b1-8ef0-47eb-ba47-24fce8221ebc
   cloudflared tunnel token --cred-file /workspace/.cloudflared/$TID.json etymos-api >/dev/null
   chmod 600 /workspace/.cloudflared/*
   cat > /workspace/.cloudflared/config.yml <<EOF
   tunnel: $TID
   credentials-file: /workspace/.cloudflared/$TID.json
   ingress:
     - hostname: api.etymos.site
       service: http://localhost:8000
     - service: http_status:404
   EOF
   cloudflared tunnel --config /workspace/.cloudflared/config.yml ingress validate   # → OK
   ```

4. **Start** — as in "After the machine restarts".

### `backend/scripts/run_api.sh`

```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
set -a
source .env
set +a
exec .venv/bin/uvicorn api.app:app --host 0.0.0.0 --port 8000
```

### `backend/supervisord.conf`

```ini
[supervisord]
logfile=/workspace/Etymos/backend/logs/supervisord.log
pidfile=/workspace/Etymos/backend/logs/supervisord.pid
childlogdir=/workspace/Etymos/backend/logs
nodaemon=false

[unix_http_server]
file=/workspace/Etymos/backend/logs/supervisor.sock
chmod=0700

[rpcinterface:supervisor]
supervisor.rpcinterface_factory = supervisor.rpcinterface:make_main_rpcinterface

[supervisorctl]
serverurl=unix:///workspace/Etymos/backend/logs/supervisor.sock

[program:etymos-api]
command=/workspace/Etymos/backend/scripts/run_api.sh
directory=/workspace/Etymos/backend
autostart=true
autorestart=true
startsecs=10
stopsignal=TERM
stopasgroup=true
killasgroup=true
stdout_logfile=/workspace/Etymos/backend/logs/api.out.log
stderr_logfile=/workspace/Etymos/backend/logs/api.err.log
stdout_logfile_maxbytes=20MB
stderr_logfile_maxbytes=20MB

; Named tunnel: api.etymos.site -> localhost:8000 (see /workspace/.cloudflared/config.yml)
[program:cloudflared]
command=/usr/local/bin/cloudflared --no-autoupdate tunnel --config /workspace/.cloudflared/config.yml run etymos-api
autostart=true
autorestart=true
stopsignal=TERM
stdout_logfile=/workspace/Etymos/backend/logs/cloudflared.out.log
stderr_logfile=/workspace/Etymos/backend/logs/cloudflared.err.log
stdout_logfile_maxbytes=10MB
stderr_logfile_maxbytes=10MB
```

### `backend/.env` keys

`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_JWT_SECRET`,
`GEMINI_API_KEY`, `ALLOWED_ORIGINS` (e.g.
`https://www.etymos.site,https://etymos.site`), `SMTP_HOST`, `SMTP_PORT`,
`SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM` — see
`SETUP_EMAIL.md` for the SMTP ones.
