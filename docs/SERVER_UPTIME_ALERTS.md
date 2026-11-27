# Server Auto-Start & Downtime Email Alerts

How the GPU backend recovers automatically after a machine restart (power outage
or provider shutdown) and how administrators receive **Server Down** / **Server Back Online**
emails even while the GPU host itself is powered off.

---

## Part 1 — Automatic `supervisord` Startup After Host Restart

Because the GPU host is a container without `systemd` as PID 1, persistent startup
helpers live under `backend/scripts/` on `/workspace` (which survives reboots):

| Script | Purpose |
|---|---|
| `backend/scripts/check_autostart_host.sh` | Read-only check reporting PID 1, `cron`/`systemd` status, `/workspace` writability, `cloudflared`, and recommended install mode (`--json` supported) |
| `backend/scripts/ensure_supervisord.sh` | Lock-protected, idempotent launcher: detects if `supervisord` is already running, restores `/usr/local/bin/cloudflared` from `/workspace/bin/cloudflared` if a fresh container image wiped it, removes dead stale `supervisor.sock` / `supervisord.pid`, boots `supervisord`, and logs to `backend/logs/autostart.log` |
| `backend/scripts/install_autostart.sh` | Registers `/workspace/onstart.sh` (`--mode provider-hook`), idempotent `cron` `@reboot` + `*/2` watchdog (`--mode cron`), and/or `systemd` (`--mode systemd`); `--mode auto` installs every supported hook |

Auto-start never depends on SMTP, Supabase, or internet access to start `etymos-api`.

### One-time setup on the live GPU host

```bash
cd /workspace/Etymos
bash backend/scripts/check_autostart_host.sh
bash backend/scripts/install_autostart.sh --mode auto
```

- If your GPU provider dashboard exposes a **Container Start Command / Entrypoint / On-Start Script**
  setting, point it to:
  ```bash
  /workspace/onstart.sh
  ```
- Inspect boot recovery logs anytime on disk at `backend/logs/autostart.log`, or
  from the Admin Portal under **Logs → Server logs → Log files → `autostart`**.

---

## Part 2 — External Availability Monitor & Email Alerts

Because a host that lost power or was stopped by a provider cannot execute code or
send email while offline, monitoring runs externally outside the GPU server:

1. **Email & state engine (`backend/api/uptime_monitor.py`)**: Uses Python standard
   library + `backend/api/mailer.py` and `backend/api/email_templates.py` (no `pip install` needed).
2. **State & deduplication**:
   - `public.server_availability_state` tracks consecutive failures, sustained confirmation (`>= 3` failures AND `>= 120s`, so routine ~20–40s `etymos-deploy` restarts send **zero** alert emails), pending recovery retries, and flapping cooldowns (`> 4` alerts within `30 minutes` enters a `15-minute` cooldown with an instability note).
   - `public.notification_log` claims `('server_down', '<incident>:<email>')` and `('server_recovered', '<incident>:<email>')` atomically so every uninterrupted incident produces **1 Server Down** email and **1 Server Back Online** email per admin recipient.
3. **Recipients**: Uses `ADMIN_ALERT_EMAILS` (if configured) or falls back to every account in `public.profiles` with `role = 'admin'` — identical to billing/support admin alerts.
4. **Intentional admin shutdowns**: If an admin stops the API from the Admin Portal and the tunnel stays up (`HTTP 502`/`503`/`504`), `uptime_monitor.py` notes that an administrator triggered `server.shutdown` recently when composing the alert.

### Step 1 — Apply the Supabase migration

```bash
supabase db push
```

This creates `public.server_availability_state` (seeded for `etymos-api` at
`https://api.etymos.site/api/health`) and `public.check_backend_availability_tick()`.

### Step 2 — Configure GitHub Actions Repository Secrets

In GitHub → **Settings → Secrets and variables → Actions**, add:

| Secret | Value |
|---|---|
| `SUPABASE_URL` | Your Supabase project URL (`https://xxxx.supabase.co`) |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service-role key |
| `SMTP_HOST` | `mail.etymos.site` |
| `SMTP_PORT` | `465` |
| `SMTP_USER` | `noreply@etymos.site` |
| `SMTP_PASSWORD` | Mailbox password |
| `SMTP_FROM` | `Etymos <noreply@etymos.site>` |
| `ADMIN_ALERT_EMAILS` | Optional comma-separated list (leave empty to email all admins in `profiles`) |
| `ADMIN_APP_URL` | Optional admin portal base URL (adds button linking to `/logs/server/status`) |
| `HEALTH_CHECK_URL` | Optional override (defaults to `https://api.etymos.site/api/health`) |

Without Supabase `pg_cron` setup below, `.github/workflows/uptime-monitor.yml`
runs on a built-in fallback schedule (`3,18,33,48 * * * *`).

### Step 3 — Enable the 30-second Supabase `pg_cron` + `pg_net` fast-path (Recommended)

With the fast-path enabled, Supabase probes `/api/health` every 30 seconds (no Actions
tab clutter when healthy) and triggers GitHub Actions `workflow_dispatch` within seconds
whenever an outage or recovery is confirmed.

1. Create a fine-grained GitHub Personal Access Token scoped **only** to this repository
   with **Repository permissions → Actions: Read and write**.
2. In the Supabase Dashboard **SQL Editor**, verify `pg_cron` + `pg_net` are enabled,
   store the two Vault secrets, and schedule the tick:

```sql
create extension if not exists pg_cron;
create extension if not exists pg_net;

select vault.create_secret('jutver/Etymos', 'github_monitor_repo');
select vault.create_secret('REPLACE_WITH_FINE_GRAINED_PAT', 'github_monitor_token');

-- Use '30 seconds' on Supabase Postgres 15+, or '* * * * *' for 1-minute cadence:
select cron.schedule(
  'etymos-backend-uptime-tick',
  '30 seconds',
  $$select public.check_backend_availability_tick('etymos-api');$$
);
```

Verify immediately:

```sql
select public.check_backend_availability_tick('etymos-api');
```

### Step 4 — End-to-End Verification

1. Trigger **Actions → Uptime Monitor → Run workflow** with `dry_run = true`. Confirm HTTP `200` and `status = "up"`.
2. Stop the backend temporarily (`$SV shutdown` on the host) for ~3–4 minutes and verify **1** `[ALERT] Etymos backend server is DOWN (etymos-api)` email arrives.
3. Run `/workspace/onstart.sh` (or `bash backend/scripts/ensure_supervisord.sh`) and verify **1** `[RECOVERED] Etymos backend server is back online (etymos-api)` email arrives with accurate downtime duration.
