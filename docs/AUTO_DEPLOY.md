# Automatic backend deploys

Push to `main`, and the GPU server deploys the backend by itself within a few
minutes. No SSH needed.

## How it works

The server has no inbound access (only the Cloudflare tunnel), so GitHub
can't push to it. Instead the server polls GitHub:

1. **GitHub Actions** (`.github/workflows/backend-ci.yml`) runs the backend
   tests on every push to `main` or `dev` that touches `backend/`. The job is
   called `backend-tests`.
2. **`backend/scripts/deploy_watch.sh`** runs on the server under supervisord
   as `etymos-deploy`. Every 60 s it runs `git fetch`. When `main` has moved:

| The new commits... | What it does |
|---|---|
| don't touch `backend/` (frontend, docs) | `git merge --ff-only`. No restart |
| touch `backend/` | Waits for `backend-tests` to pass on GitHub, then waits for running checks to finish (`active_jobs` in `/api/health`, up to 30 min). Then it fast-forwards, runs `pip install` if `requirements.txt` changed, restarts `etymos-api` and waits for `/api/health` |
| failed `backend-tests` | Skipped. The server stays on the current version until a newer commit arrives |
| deployed, but the API doesn't answer `/api/health` within 3 min | Goes back to the previous commit, restarts, and skips the bad commit until a newer one arrives |

It never runs `git reset --hard` or `git clean`. The server writes runtime data
into a few tracked files (`backend/paper_cache/*`, `__pycache__/*.pyc`), and
the script puts those back before pulling. If any other tracked file was
edited by hand on the server, it stops and logs the file name instead of
throwing the edit away.

A restart drops any check that's still running (jobs live in memory), which
is why the script waits for `active_jobs` to reach 0 first. A check uploaded
in the second before the restart can still be lost; the user sees it fail
and uploads again.

## Setting it up on the server (once)

The script is in git, so pull it first:

```bash
cd /workspace/Etymos && git pull
```

Add this program to `backend/supervisord.conf` (also shown in
`SERVER_OPERATIONS.md`):

```ini
[program:etymos-deploy]
command=/workspace/Etymos/backend/scripts/deploy_watch.sh
directory=/workspace/Etymos
autostart=true
autorestart=true
stopsignal=TERM
stopasgroup=true
stdout_logfile=/workspace/Etymos/backend/logs/deploy.log
redirect_stderr=true
stdout_logfile_maxbytes=10MB
```

Load it:

```bash
$SV reread && $SV update     # starts etymos-deploy, leaves the others running
$SV status                   # etymos-api, cloudflared, etymos-deploy: RUNNING
tail -f backend/logs/deploy.log
```

The first log line should be `Watching origin/main every 60s (CI required: true)`.

The checkout must be on `main` with `origin` set to
`https://github.com/jutver/Etymos.git`. The repo is public, so it needs no
credentials.

## Daily use

Merge or push to `main` as usual, then watch it arrive:

```bash
tail -f /workspace/Etymos/backend/logs/deploy.log
```

```
2026-10-17 17:44:14 Updated to 200ebf4 (no backend changes, no restart)
2026-10-17 17:52:40 Waiting for the backend-tests check on 31d8a68
2026-10-17 17:56:02 Deploying 200ebf4 -> 31d8a68: Faster citation matching
2026-10-17 17:56:31 Deployed 31d8a68
```

GitHub's Actions tab shows the test run. A backend change usually lands about
5 minutes after the push: about 4 minutes of CI, up to 1 minute until the
next poll, and the restart.

- **Pause deploys:** `$SV stop etymos-deploy`. Start it again with `$SV start etymos-deploy`.
- **Deploy by hand:** the steps in `SERVER_OPERATIONS.md` still work. Stop
  `etymos-deploy` first so it doesn't restart the API while you're working.
- **Retry a skipped commit** (for example after re-running a flaky CI job):
  `rm backend/logs/deploy_skip`.

## Settings

Set these as `environment=` on the `[program:etymos-deploy]` section (they
are not read from `backend/.env`). For example:
`environment=DEPLOY_POLL_SECONDS="30"`. Then run `$SV reread && $SV update`.

| Key | Default | |
|---|---|---|
| `DEPLOY_BRANCH` | `main` | Branch to follow. The checkout must be on it |
| `DEPLOY_POLL_SECONDS` | `60` | How often to `git fetch` |
| `DEPLOY_DRAIN_SECONDS` | `1800` | Longest wait for running checks before restarting anyway |
| `DEPLOY_HEALTH_SECONDS` | `180` | How long the restarted API gets to answer `/api/health` |
| `DEPLOY_REQUIRE_CI` | `true` | `false` deploys backend changes without waiting for GitHub Actions |
| `GITHUB_TOKEN` | none | Only needed if GitHub's limit of 60 unauthenticated API calls per hour is ever hit |

## Troubleshooting

| Log line | Meaning / fix |
|---|---|
| `Waiting for the backend-tests check on …` for a long time | CI is still running, queued, or didn't start. Check the Actions tab on GitHub |
| `Skipping …: the backend-tests check failed` | Fix the tests and push again. To deploy anyway, re-run the job until it passes, then `rm backend/logs/deploy_skip` |
| `Not deploying: files changed by hand on this server` | Someone edited tracked files on the server. Commit the change from a dev machine, or `git checkout -- <file>` |
| `HEAD … isn't behind origin/main` | `main` was force-pushed, or there are local commits on the server. Sort it out by hand, then `rm backend/logs/deploy_skip` |
| `Rolled back to …` | The new code didn't start. The reason is in `logs/api.err.log` |
| `The checkout isn't on main` | `git checkout main` |
