# Etymos

Plagiarism and AI-generated-content detection for students and researchers. It's built for Vietnamese first, and gives plain-language explanations instead of just a percentage.

Upload a PDF or paste text. Etymos finds the published sources it overlaps with and shows each match with the matching sentences highlighted. It also estimates how much of the text was AI-generated, and helps you rewrite flagged passages, re-checking them as you go.

## Features

- **Plagiarism check.** Searches OpenAlex, Semantic Scholar, arXiv and the web for candidate papers. Then it matches your document against them chunk by chunk and sentence by sentence, using multilingual embeddings (`intfloat/multilingual-e5-small`).
- **AI-content detection.** English uses a fine-tuned AI-text classifier. Vietnamese uses VietBinoculars (PhoGPT-4B pair). Text that's too short or in an unsupported language is marked "inconclusive" instead of getting a misleading low score.
- **Explainable report.** Each match comes with a plain-language reason, the source, and a side-by-side view of the original PDF.
- **Rewrite and quick check.** You can get AI rewrites of flagged passages. Each rewrite or hand edit is quickly re-checked against the report's sources, and the similarity score updates as you fix passages.
- **Citations.** Generates citations for matched sources.
- **Accounts and plans.** Free, Standard and Premium plans, plus credit packs. Payment is by bank transfer, confirmed by a SePay webhook. Student verification is supported.
- **Support.** A support ticket system with email in and out.
- **Admin portal.** Users, revenue, pricing, moderation, student verification, waitlist, announcements (with audience targeting and maintenance mode), feature flags and the activity log.
- **Bilingual UI.** English and Vietnamese.

## Repository layout

```
apps/
  web/        User-facing site (React 19 + Vite + Tailwind 4)
  admin/      Admin portal (React 19 + Vite + Tailwind 4)
packages/
  shared/     Code shared by both apps (Supabase client, types, formatting)
backend/      FastAPI API and the detection pipeline (Python 3.10)
  api/        HTTP layer: jobs, reports, auth, payments, support, rate limits
  search_paper/  Source search (OpenAlex, Semantic Scholar, arXiv, DuckDuckGo)
  tests/      pytest suite (including SQL tests against the migrations)
supabase/     Database migrations, seed data and email templates
docs/         Setup, deploy and operations runbooks
cloudflared/  Cloudflare Tunnel config for the backend server
```

## How it fits together

```
 apps/web ──┐                         ┌── Supabase (Auth, Postgres + RLS, Storage)
            ├── Supabase client ──────┤
 apps/admin ┘                         │
                                      │
 apps/web ── REST ──> backend (FastAPI on a GPU server, behind a Cloudflare Tunnel)
                        ├── PDF/text extraction (PyMuPDF, Marker)
                        ├── source search + embedding match
                        ├── AI detection, explanations, rewrites (local models / Gemini)
                        └── SePay webhook, support email, notifications
```

Both apps talk to Supabase directly for auth and most data. Row-level security decides what each user can read and write. The web app calls the backend for anything heavy: running checks, loading reports, rewrites, quick checks and payments. A check runs as a background job that the web app polls (`POST /api/check/pdf` or `/api/check/text`, then `GET /api/jobs/{id}`). Jobs live in memory, so restarting the API drops any check that's still running.

## Getting started

### Prerequisites

- Node.js 20.19+ (required by Vite 8) and npm
- Python 3.10
- A Supabase project with the migrations applied (see [docs/SETUP_SUPABASE.md](docs/SETUP_SUPABASE.md))
- An NVIDIA GPU is recommended for the backend. It runs on CPU, but slowly, and some detectors are skipped.

### Frontend

```bash
npm install
```

Both apps read their env from the **repo-root** `.env` / `.env.local`:

```bash
VITE_SUPABASE_URL=https://<project-ref>.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=<publishable key>
VITE_API_BASE_URL=http://127.0.0.1:8000   # default if unset
```

```bash
npm run dev:web     # user site
npm run dev:admin   # admin portal
```

### Backend

```bash
cd backend
python3.10 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn api.app:app --host 0.0.0.0 --port 8000
```

On Windows, `.\backend\run_api.ps1` loads the env file and starts uvicorn. Swagger docs are at `http://127.0.0.1:8000/docs`, and a health check is at `/api/health`.

The backend reads `backend/.env` or the repo-root `.env.backend` (the same file `docker-compose.yml` uses). The main settings:

| Variable | Purpose |
|---|---|
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Server-side Supabase access |
| `SUPABASE_JWT_SECRET` | Only for legacy HS256 tokens; newer projects are verified via JWKS |
| `SUPABASE_STORAGE_BUCKET` | Bucket for uploaded documents and report images (default `documents`) |
| `ALLOWED_ORIGINS` | CORS origins (defaults to the local Vite ports) |
| `WEB_APP_URL`, `ADMIN_APP_URL` | Links used in emails |
| `GEMINI_API_KEY` | Gemini for metadata extraction, explanations and rewrites |
| `AI_DETECTION_MODE` | `1` predictability, `2` Binoculars, `3` classifier + VietBinoculars (default) |
| `SEPAY_*`, `PAYMENT_*` | Bank-transfer payments |
| `SMTP_*`, `SUPPORT_*` | Outgoing email and the support inbox |
| `GPU_*`, `MARKER_*` | GPU memory budget and the Marker PDF preview |
| `RATE_LIMIT_*` | Per-endpoint rate limits |

To run it in Docker instead, use `docker compose up` (GPU) or `docker compose -f docker-compose.cpu.yml up`.

### Database

```bash
supabase link --project-ref <project-ref>
supabase db push
psql "$(supabase db url)" -f supabase/seed.sql
```

## Testing

```bash
npm test               # everything below
npm run test:web       # build + lint + vitest for apps/web
npm run test:admin     # build + lint + vitest for apps/admin
npm run test:backend   # pytest in backend/
```

GitHub Actions runs the backend tests on every push to `main` or `dev` that touches `backend/`.

> The test run rewrites the `__pycache__/*.pyc` files that are tracked in git. Revert them before committing.

## Deployment

- **Web and admin**: Vercel, one project per app (`apps/web`, `apps/admin`). Each has a `vercel.json` that sends all routes to the SPA.
- **Backend**: a GPU server running uvicorn under supervisord and exposed through a Cloudflare Tunnel. A watcher script deploys new `main` commits automatically once CI passes, and rolls back if the health check fails. See [docs/DEPLOY_BACKEND.md](docs/DEPLOY_BACKEND.md) and [docs/AUTO_DEPLOY.md](docs/AUTO_DEPLOY.md).
- **Database**: apply new migrations with `supabase db push` *before* deploying code that depends on them.

## Branches

Work happens on `dev`, which reaches `main` through pull requests. Pushing to `main` deploys the backend.

## Docs

| Doc | Covers |
|---|---|
| [SETUP_SUPABASE](docs/SETUP_SUPABASE.md) | Schema, auth settings, storage |
| [SETUP_GOOGLE_AUTH](docs/SETUP_GOOGLE_AUTH.md) | Google sign-in |
| [SETUP_EMAIL](docs/SETUP_EMAIL.md) | Transactional email and templates |
| [SETUP_PAYMENTS](docs/SETUP_PAYMENTS.md) | SePay bank-transfer payments |
| [SETUP_SUPPORT](docs/SETUP_SUPPORT.md) | Support inbox |
| [SETUP_MARKER](docs/SETUP_MARKER.md) | Marker PDF preview |
| [DEPLOY_BACKEND](docs/DEPLOY_BACKEND.md) | GPU server deploy |
| [AUTO_DEPLOY](docs/AUTO_DEPLOY.md) | Automatic backend deploys |
| [SERVER_OPERATIONS](docs/SERVER_OPERATIONS.md) | Day-to-day server ops |
| [GPU_MEMORY](docs/GPU_MEMORY.md) | GPU memory budgeting |
| [ANNOUNCEMENTS](docs/ANNOUNCEMENTS.md) | Announcements and maintenance mode |
| [GO_LIVE_CHECKLIST](docs/GO_LIVE_CHECKLIST.md) | Launch checklist |
