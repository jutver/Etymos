# Deploying the Etymos backend to n1.ckey.vn

Reproducible runbook for running the FastAPI backend on the VPS at
**n1.ckey.vn**, exposed to the internet via a **Cloudflare Tunnel** — no open
inbound ports, no nginx, no certbot. This doc contains **no real credentials
or IPs**; every secret and hostname below is a placeholder you fill in on the
actual VPS.

Related files:
- `docker-compose.yml` (repo root) — the API service definition.
- `backend/Dockerfile` — image build for the API (CUDA-capable, since the VPS
  has a GPU used by the local Qwen2.5-1.5B metadata-extraction path).
- `cloudflared/config.yml` — tunnel ingress template.

This is a manual runbook. No agent has SSH access to n1.ckey.vn or any real
credentials for it — every command below is meant to be run **by you**, on
the VPS, over your own SSH session.

---

## 0. Prerequisites

- SSH access to the VPS (n1.ckey.vn) with a sudo-capable user.
- A Cloudflare account with the DNS zone you want the API hostname on (e.g.
  `api.<your-domain>`) already added to Cloudflare.
- Phase 0 (Supabase schema) applied to the live project — see
  `docs/SETUP_SUPABASE.md` if present — so you have real values for the
  Supabase env vars below.
- A rotated Gemini API key (the one previously hardcoded in
  `backend/api/app.py` is leaked and must not be reused).

---

## 1. Install Docker on the VPS

```bash
# On the VPS, as a sudo-capable user:
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER"
# log out/in (or `newgrp docker`) for the group change to take effect

# Ensure Docker starts on every boot (needed for the API container to
# survive a reboot, alongside the `restart: unless-stopped` policy in
# docker-compose.yml):
sudo systemctl enable --now docker
```

If the VPS's GPU should be used by the container (local Qwen path), also
install the NVIDIA Container Toolkit and confirm `docker run --rm --gpus all
nvidia/cuda:12.2.0-base-ubuntu22.04 nvidia-smi` works before proceeding:

```bash
distribution=$(. /etc/os-release; echo "$ID$VERSION_ID")
curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
curl -s -L https://nvidia.github.io/libnvidia-container/$distribution/libnvidia-container.list | \
  sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' | \
  sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list
sudo apt-get update && sudo apt-get install -y nvidia-container-toolkit
sudo nvidia-ctk runtime configure --runtime=docker
sudo systemctl restart docker
```

(If you'd rather run CPU-only, delete the `deploy.resources.reservations`
block from `docker-compose.yml` before building.)

---

## 2. Clone the repo and configure `.env`

```bash
git clone <YOUR_REPO_URL> etymos
cd etymos
```

Create an **uncommitted** `.env` file next to `docker-compose.yml` (it is
already covered by `.gitignore`'s `.env*` pattern — never commit it). Required
keys:

| Key | Description |
| --- | --- |
| `SUPABASE_URL` | Live Supabase project URL (e.g. `https://xxxx.supabase.co`). |
| `SUPABASE_SERVICE_ROLE_KEY` | Service-role key from Supabase project settings — server-only, never ship to any frontend. |
| `SUPABASE_JWT_SECRET` | Supabase project's JWT secret, used by `backend/api/auth.py` to verify caller tokens locally without a network round-trip. |
| `GEMINI_API_KEY` | A freshly rotated Gemini API key (Google AI Studio). Do not reuse the key formerly hardcoded in `backend/api/app.py`. |
| `ALLOWED_ORIGINS` | Comma-separated list of allowed CORS origins for the production frontend(s), e.g. `https://app.yourdomain.com`. No `*` in production. |

Example `.env` (values are placeholders — replace with the real ones from
your Supabase dashboard and Google AI Studio):

```bash
SUPABASE_URL=https://your-project-ref.supabase.co
SUPABASE_SERVICE_ROLE_KEY=replace-with-real-service-role-key
SUPABASE_JWT_SECRET=replace-with-real-jwt-secret
GEMINI_API_KEY=replace-with-real-rotated-key
ALLOWED_ORIGINS=https://app.yourdomain.com
```

---

## 3. Build and run the API container

```bash
docker compose up -d --build
docker compose logs -f api   # watch startup, Ctrl-C to stop tailing
```

Smoke test locally on the VPS (before wiring the tunnel):

```bash
curl -f http://localhost:8000/api/health
```

The `restart: unless-stopped` policy in `docker-compose.yml`, combined with
`docker` itself being enabled at boot (step 1), means the API container comes
back up automatically after a VPS reboot — no separate systemd unit is
required for the container itself. If you'd prefer an explicit systemd unit
instead of relying on Docker's restart policy, see the appendix at the bottom
of this doc.

---

## 4. Install cloudflared and create the tunnel

```bash
# Debian/Ubuntu example — see https://pkg.cloudflare.com for other distros
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo gpg --yes --dearmor -o /usr/share/keyrings/cloudflare-main.gpg
echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared $(lsb_release -cs) main" | \
  sudo tee /etc/apt/sources.list.d/cloudflared.list
sudo apt-get update && sudo apt-get install -y cloudflared

# Authenticate this VPS against your Cloudflare account (opens a URL you
# open in your own browser to authorize):
cloudflared tunnel login

# Create the named tunnel:
cloudflared tunnel create etymos-api
# -> prints a Tunnel ID (UUID) and writes credentials to
#    ~/.cloudflared/<TUNNEL_ID>.json — this file is a secret, never commit it.

# Route a hostname in your Cloudflare zone to this tunnel, e.g.:
cloudflared tunnel route dns etymos-api api.yourdomain.com
```

Copy `cloudflared/config.yml` from this repo to `/etc/cloudflared/config.yml`
on the VPS and fill in the placeholders with the real tunnel ID, credentials
path, and hostname from the commands above:

```bash
sudo mkdir -p /etc/cloudflared
sudo cp cloudflared/config.yml /etc/cloudflared/config.yml
sudo cp ~/.cloudflared/<TUNNEL_ID>.json /etc/cloudflared/<TUNNEL_ID>.json
sudo "$EDITOR" /etc/cloudflared/config.yml   # replace <TUNNEL_ID> and <API_HOSTNAME>
```

Test the tunnel runs correctly in the foreground first:

```bash
sudo cloudflared tunnel --config /etc/cloudflared/config.yml run etymos-api
# in another terminal / from your own machine:
curl -f https://api.yourdomain.com/api/health
```

Ctrl-C to stop the foreground run once confirmed, then install it as a
service so it survives reboot:

```bash
sudo cloudflared service install
sudo systemctl enable --now cloudflared
sudo systemctl status cloudflared
```

`cloudflared service install` reads `/etc/cloudflared/config.yml` by default
and creates/enables the `cloudflared` systemd unit for you. If you'd rather
hand-write the unit instead of using `service install`, see the appendix.

---

## 5. Verify end-to-end

- `sudo systemctl status docker cloudflared` — both `active (running)`.
- `docker compose ps` — `api` service `healthy`.
- From outside the VPS: `curl -f https://<API_HOSTNAME>/api/health` returns
  `200`.
- No inbound ports beyond SSH should be open on the VPS firewall — the tunnel
  is fully outbound, so `ufw status` (or equivalent) should show nothing
  opened for port 8000.
- Reboot the VPS (`sudo reboot`) and re-run the health check after it comes
  back — confirms both `docker` (API container) and `cloudflared` (tunnel)
  survive a restart unattended.

---

## Appendix: hand-written systemd units (alternative to the defaults above)

Only needed if you opted out of `docker compose`'s restart policy or
`cloudflared service install` above.

**`/etc/systemd/system/cloudflared.service`** (references `cloudflared/config.yml`'s
installed location):

```ini
[Unit]
Description=cloudflared tunnel for Etymos API
After=network-online.target
Wants=network-online.target

[Service]
Type=notify
ExecStart=/usr/bin/cloudflared tunnel --config /etc/cloudflared/config.yml run etymos-api
Restart=on-failure
RestartSec=5s
User=cloudflared

[Install]
WantedBy=multi-user.target
```

**`/etc/systemd/system/etymos-api.service`** (alternative to Docker's own
restart policy — drives `docker compose` from systemd instead):

```ini
[Unit]
Description=Etymos API (docker compose)
Requires=docker.service
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=true
WorkingDirectory=/path/to/etymos
ExecStart=/usr/bin/docker compose up -d
ExecStop=/usr/bin/docker compose down
TimeoutStartSec=0

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now etymos-api.service cloudflared.service
```
