# Deploying the Etymos backend to n1.ckey.vn

Reproducible runbook for running the FastAPI backend on the GPU container at
**n1.ckey.vn**, exposed to the internet via a **Cloudflare Tunnel** — no open
inbound ports, no nginx, no certbot. This doc contains **no real credentials
or IPs**; every secret and hostname below is a placeholder you fill in on the
actual host. (First real deploy went to `n2.ckey.vn`, not `n1.ckey.vn` —
check whatever hostname your provider actually gives you rather than
assuming it matches this doc's title.)

**No Docker here on purpose.** n1.ckey.vn hands you shell access *inside* an
already-running GPU container (the NVIDIA driver is passed through by the
provider) — there is no `dockerd` of your own to build/run against. Installing
Docker and running `docker compose up` in that situation would mean nesting a
container inside a container (Docker-in-Docker), which adds complexity for no
benefit and often doesn't work without privileged mode. Instead, the API runs
directly in a Python venv, kept alive and auto-restarted by `supervisord`
(works without systemd, which single-container environments generally don't
run as PID 1).

Related files:
- `backend/Dockerfile`, `docker-compose.yml` (repo root) — kept for local dev
  parity and for a possible future deploy onto a real VM. **Not used** by the
  steps below.
- `cloudflared/config.yml` — tunnel ingress template, still used as-is.

This is a manual runbook. No agent has shell access to n1.ckey.vn or any real
credentials for it — every command below is meant to be run **by you**.

**On working directories.** Except where a step says otherwise, every command
below runs from `etymos/backend` — the directory you land in at the end of
step 1. Steps 2 through 6 do *not* move you anywhere else; you stay in that
one shell, in that one directory, for the whole runbook. Each step restates
its working directory at the top so you can pick the doc back up mid-deploy
without guessing. Where an absolute `/path/to/etymos/...` appears it's because
the file being written (supervisord's config, cloudflared's config) is read
later by a daemon that may not share your shell's working directory — it is
*not* a hint that you should `cd` somewhere else to run the command.

---

## 0. Prerequisites

- Shell access to the n1.ckey.vn container, with enough privilege to install
  packages (root, or sudo — whatever the provider gives you).
- `nvidia-smi` already works inside the container — GPU passthrough is the
  provider's responsibility, not something this runbook sets up. Confirm it
  before proceeding; if it fails, that's a provider-side ticket, not a step
  you're missing here.
- Python 3.10+ with the `venv` module available (`python3 -m venv --help`) —
  standard on most GPU-rental base images.
- A Cloudflare account with the DNS zone you want the API hostname on (e.g.
  `api.<your-domain>`) already added to Cloudflare.
- Phase 0 (Supabase schema) applied to the live project — see
  `docs/SETUP_SUPABASE.md` — so you have real values for the Supabase env
  vars below.
- A rotated Gemini API key (the one previously hardcoded in
  `backend/api/app.py` is leaked and must not be reused).

---

## 1. Clone the repo and set up the Python environment

**Working directory:** anywhere you want the clone to live (your home
directory is fine) — the `cd` below then puts you in `etymos/backend`, where
every later step expects you to be.

```bash
git clone <YOUR_REPO_URL> etymos
cd etymos/backend

python3 -m venv .venv
source .venv/bin/activate
pip install --upgrade pip
pip install -r requirements.txt
```

Confirm torch sees the GPU — this is the same GPU the local Qwen2.5-1.5B
metadata-extraction path uses:

```bash
python3 -c "import torch; print(torch.cuda.is_available(), torch.cuda.get_device_name(0))"
```

You can `deactivate` afterward — the supervisord config in step 3 invokes
`.venv/bin/...` by absolute path, so it doesn't depend on the venv being
active in whatever shell starts it.

---

## 2. Configure environment variables

**Working directory:** `etymos/backend` — where step 1 left you.

Create an **uncommitted** `.env` file at `etymos/backend/.env` (already
covered by `.gitignore`'s `.env*` pattern — never commit it). Required keys:

| Key | Description |
| --- | --- |
| `SUPABASE_URL` | Live Supabase project URL (e.g. `https://xxxx.supabase.co`). |
| `SUPABASE_SERVICE_ROLE_KEY` | Service-role key from Supabase project settings — server-only, never ship to any frontend. |
| `SUPABASE_JWT_SECRET` | Supabase project's JWT secret, used by `backend/api/auth.py` to verify caller tokens locally without a network round-trip. |
| `GEMINI_API_KEY` | A freshly rotated Gemini API key (Google AI Studio). Do not reuse the key formerly hardcoded in `backend/api/app.py`. |
| `ALLOWED_ORIGINS` | Comma-separated list of allowed CORS origins for the production frontend(s), e.g. `https://app.yourdomain.com`. No `*` in production. |

```bash
SUPABASE_URL=https://your-project-ref.supabase.co
SUPABASE_SERVICE_ROLE_KEY=replace-with-real-service-role-key
SUPABASE_JWT_SECRET=replace-with-real-jwt-secret
GEMINI_API_KEY=replace-with-real-rotated-key
ALLOWED_ORIGINS=https://app.yourdomain.com
```

`backend/api/app.py` reads these via plain `os.getenv(...)` — there's no
`python-dotenv` wired in, so a launcher script sources `.env` into the shell
environment before exec-ing uvicorn:

```bash
mkdir -p scripts
cat > scripts/run_api.sh <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
set -a
source .env
set +a
exec .venv/bin/uvicorn api.app:app --host 0.0.0.0 --port 8000
EOF
chmod +x scripts/run_api.sh
```

Smoke test it directly before wiring up supervisord:

```bash
./scripts/run_api.sh &
sleep 2 && curl -f http://localhost:8000/api/health
kill %1
```

**That `kill %1` is not optional, and this is the one thing people get wrong
here.** This foreground run is a throwaway check that `.env` is readable, the
venv resolves, and the app imports — nothing more. From step 3 onward
`supervisord` is what runs `scripts/run_api.sh`; you never run it by hand
again. The two are alternatives, not companions. Leave this one alive and
supervisord will start a *second* uvicorn against port 8000, which loses the
bind and dies with `[Errno 98] address already in use` — and because
`autorestart=true` it will keep retrying and failing until supervisord marks
it `FATAL`, which reads like a broken deploy when really it's just the smoke
test still holding the port.

---

## 3. Install and configure supervisord

**Working directory:** `etymos/backend` — the same directory as step 2, in
the same shell. Nothing moves between steps 2 and 3.

No systemd here, so `supervisord` takes over the "keep it running, restart on
crash" job for both the API and the tunnel. Concretely: `supervisord` becomes
the thing that runs `scripts/run_api.sh` — look at `command=` under
`[program:etymos-api]` below, it's the exact script you smoke-tested by hand
in step 2. So you do **not** run `./scripts/run_api.sh` alongside this; that
script has exactly one owner from here on, and it's supervisord.

First confirm the step 2 smoke test really is gone — nothing should be
holding port 8000 before supervisord starts:

```bash
curl -f http://localhost:8000/api/health   # want: connection refused
```

If that *succeeds*, something is still listening and you have a stray uvicorn
to clean up (the `kill %1` didn't take, or you're in a different shell than
the one that launched it):

```bash
pkill -f 'uvicorn api.app:app'   # or: fuser -k 8000/tcp
```

Then install supervisor into the venv:

```bash
source .venv/bin/activate
pip install supervisor
```

Create `supervisord.conf` in this same directory — i.e. at
`etymos/backend/supervisord.conf`. Replace every `/path/to/etymos` with the
real absolute path from your clone (`cd ../ && pwd` prints it, or just read
`pwd` and drop the trailing `/backend`). The paths are absolute because
supervisord daemonizes and its children inherit *its* working directory, not
your shell's — that's a property of the config file, not an instruction to
run these commands from elsewhere.

```ini
[supervisord]
logfile=/path/to/etymos/backend/logs/supervisord.log
pidfile=/path/to/etymos/backend/logs/supervisord.pid
nodaemon=false

# Without this block `supervisorctl` has nothing to connect to — it talks to
# supervisord over this socket, not by inspecting the process directly.
[unix_http_server]
file=/path/to/etymos/backend/logs/supervisor.sock

[rpcinterface:supervisor]
supervisor.rpcinterface_factory = supervisor.rpcinterface:make_main_rpcinterface

[supervisorctl]
serverurl=unix:///path/to/etymos/backend/logs/supervisor.sock

[program:etymos-api]
command=/path/to/etymos/backend/scripts/run_api.sh
directory=/path/to/etymos/backend
autostart=true
autorestart=true
stopsignal=TERM
stderr_logfile=/path/to/etymos/backend/logs/api.err.log
stdout_logfile=/path/to/etymos/backend/logs/api.out.log

# `command=` here depends on which path you took in step 4 below — see that
# section for the two alternatives (quick tunnel vs. named tunnel + domain).
[program:cloudflared]
command=/usr/local/bin/cloudflared tunnel --url http://localhost:8000
autostart=true
autorestart=true
stopsignal=TERM
stderr_logfile=/path/to/etymos/backend/logs/cloudflared.err.log
stdout_logfile=/path/to/etymos/backend/logs/cloudflared.out.log
```

```bash
mkdir -p logs
.venv/bin/supervisord -c supervisord.conf
.venv/bin/supervisorctl -c supervisord.conf status
```

`etymos-api` should report `RUNNING`. `cloudflared` will report `FATAL` or
`BACKOFF` at this point and that's expected — the binary doesn't exist until
step 4 installs it. Ignore it for now; step 4 ends with the `supervisorctl
update` / `restart cloudflared` that brings it up.

**Restarting the API from here on.** Once supervisord owns the process, ask
supervisord — don't re-run the script:

```bash
.venv/bin/supervisorctl -c supervisord.conf restart etymos-api
```

Use this after any change to `.env` or to backend code (uvicorn is not running
with `--reload` in production, so a code change needs a restart to take
effect). Running `./scripts/run_api.sh` again instead is the port-8000
collision described at the end of step 2 — supervisord's copy already holds
the port, so your manual one dies immediately and the API you're actually
serving is unchanged, which is a confusing way to spend twenty minutes.
Likewise `stop etymos-api` / `start etymos-api` rather than hunting the pid
with `kill`, so supervisord's state matches reality.

---

## 4. Install cloudflared and create the tunnel

**Working directory:** still `etymos/backend`. The install target
(`/usr/local/bin`) is absolute, so it doesn't matter where you are for that
command specifically — but the `supervisorctl` calls at the end of this step
do need to find `supervisord.conf`, which lives here.

Direct binary download — no apt/systemd dependency, works inside any
container regardless of base image:

```bash
curl -L -o /usr/local/bin/cloudflared \
  https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64
chmod +x /usr/local/bin/cloudflared
```

There are two paths from here depending on whether you own a domain you can
add to Cloudflare as a DNS zone. **Pick one.**

### 4a. No domain — Quick Tunnel

No Cloudflare account, login, or DNS zone needed at all. Cloudflare assigns a
random `https://<random-words>.trycloudflare.com` hostname the moment the
tunnel starts. This is what's actually running as of the last deploy to
n2.ckey.vn.

```bash
cloudflared tunnel --url http://localhost:8000
```

You don't need to run that by hand — it's the command shape, and it's already
what `[program:cloudflared]` in step 3 has. Let supervisord start it via the
`update` / `restart` at the end of this step, the same way it owns the API. A
manual foreground run wouldn't collide on a port (the tunnel is outbound), but
it would open a *second* tunnel with its own separate random hostname, and
then you'd have two candidate URLs and no way to tell which one the frontend
should point at.

The assigned URL is printed to stderr, which supervisord captures into
`cloudflared.err.log` — so this grep only returns anything after supervisord
has actually started the tunnel:

```bash
grep -o 'https://[a-zA-Z0-9.-]*trycloudflare.com' /path/to/etymos/backend/logs/cloudflared.err.log | tail -1
```

**Trade-off, and it's a real one:** every time this `cloudflared` process
restarts (crash, VPS/container restart, manual restart) it gets a **brand
new** random hostname. `supervisord`'s `autorestart=true` means it *will*
restart on its own after a crash — so after any such restart, re-run the
`grep` above and update whichever frontend env var points at the old URL
(`VITE_API_BASE_URL` on Vercel), then redeploy. The log file accumulates
every URL ever assigned across restarts — always take the **last** line, not
the first.

`cloudflared/config.yml` (the named-tunnel ingress template) is **not used**
by this path — leave it as-is for when you get a domain.

Set supervisord's `[program:cloudflared]` `command=` to exactly the line
above (`cloudflared tunnel --url http://localhost:8000`) — this is what the
template in step 3 already has by default.

### 4b. You own a domain — named tunnel (stable hostname)

```bash
# Authenticate this host against your Cloudflare account (opens a URL you
# open in your own browser to authorize):
cloudflared tunnel login

# Create the named tunnel:
cloudflared tunnel create etymos-api
# -> prints a Tunnel ID (UUID) and writes credentials to
#    ~/.cloudflared/<TUNNEL_ID>.json — this file is a secret, never commit it.

# Route a hostname in your Cloudflare zone to this tunnel:
cloudflared tunnel route dns etymos-api api.yourdomain.com
```

Copy `cloudflared/config.yml` from this repo next to the tunnel credentials
and fill in the placeholders with the real tunnel ID, credentials path, and
hostname from the commands above:

Note the source path: `cloudflared/config.yml` lives at the **repo root**, one
level up from where you're standing, so reference it as `../cloudflared/...`
from `etymos/backend`. The destination is that same repo-root directory, which
is why the copy below looks like a no-op — it isn't quite one; you're
replacing the committed template with a filled-in copy that stays uncommitted.

```bash
mkdir -p /path/to/etymos/cloudflared
cp ../cloudflared/config.yml /path/to/etymos/cloudflared/config.yml
"$EDITOR" /path/to/etymos/cloudflared/config.yml   # replace <TUNNEL_ID> and <API_HOSTNAME>
```

Test it in the foreground first, before letting supervisord own it. Unlike the
quick-tunnel case there's a real reason to do this: a named tunnel can fail on
config or credentials in ways that are much easier to read in the foreground
than out of a log file. Make sure supervisord isn't already running its own
copy against the same tunnel name first:

```bash
.venv/bin/supervisorctl -c supervisord.conf stop cloudflared
cloudflared tunnel --config /path/to/etymos/cloudflared/config.yml run etymos-api
# in another terminal / from your own machine:
curl -f https://api.yourdomain.com/api/health
```

Ctrl-C once confirmed — and as with `run_api.sh`, don't leave it running;
supervisord takes ownership from here. Then update supervisord's
`[program:cloudflared]` `command=` to:

```
command=/usr/local/bin/cloudflared tunnel --config /path/to/etymos/cloudflared/config.yml run etymos-api
```

### Either way, once `command=` is set correctly

Back in `etymos/backend`, so `supervisorctl` finds `supervisord.conf`.
`update` re-reads the config file and picks up your edited `command=`;
`restart` then swaps the running tunnel for one started with it:

```bash
.venv/bin/supervisorctl -c supervisord.conf update
.venv/bin/supervisorctl -c supervisord.conf restart cloudflared
```

---

## 5. Surviving a container restart

**Working directory:** `etymos/backend` for anything you run by hand here —
but note the startup-hook command below `cd`s there explicitly, because a
container entrypoint starts wherever the image says, not where you left off.

There's no systemd, so "starts on boot" means "starts when the container's
entrypoint runs again" — and that's entirely up to how n1.ckey.vn lets you
configure a startup command for the container (check the provider's
dashboard/docs for an "on start" / "entrypoint" hook). Point that hook at:

```bash
cd /path/to/etymos/backend && .venv/bin/supervisord -c supervisord.conf
```

If the provider doesn't expose a startup hook at all, you'll need to manually
re-run that command any time the *container itself* restarts. Process-level
crashes (the API or cloudflared dying without the container restarting) are
already handled automatically by `autorestart=true` above — you don't need to
intervene for those.

---

## 6. Verify end-to-end

**Working directory:** `etymos/backend`, for the `supervisorctl` and
`curl` commands below.

- `.venv/bin/supervisorctl -c supervisord.conf status` — both `etymos-api`
  and `cloudflared` show `RUNNING`.
- `curl -f http://localhost:8000/api/health` from inside the container.
- `curl -f https://<API_HOSTNAME>/api/health` from outside — for a quick
  tunnel (4a), get `<API_HOSTNAME>` via the `grep ... | tail -1` command in
  that section first; it changes across restarts.
- No inbound ports beyond whatever the provider requires for shell access —
  the tunnel is fully outbound.
- Kill the uvicorn pid directly (`pkill -f 'uvicorn api.app:app'`) and confirm
  supervisord brings it back on its own within a few seconds — this confirms
  `autorestart=true` actually works before you rely on it. Use a raw `kill`
  here rather than `supervisorctl stop`: a `stop` is a deliberate shutdown and
  supervisord will correctly *not* restart it, which would look like the
  restart policy is broken when it isn't. `supervisorctl stop` / `start` are
  the right tools for intentional restarts (see step 3), just not for testing
  crash recovery.
