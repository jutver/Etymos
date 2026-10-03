# Email: password reset, recovery email, 30-minute links, HTML templates

Everything that sends email to users, and the settings outside the repo it
depends on. Mail goes out through the iNET OneMail mailbox
`noreply@etymos.site` (DNS: MX/SPF/DKIM on Cloudflare, see the iNET panel).

## How the flows fit together

| Flow | Page | Who sends | Proof |
|---|---|---|---|
| Confirm signup | `/signup` → `/verify-email` ("check your email") → link → `/email-verified` | Supabase (template `confirm_signup`) | Link |
| Forgot password, login email | `/forgot-password` → `/reset-password` | Supabase (template `recovery`) | Link |
| Confirm a recovery email | Profile → pop-up | Backend `PUT /api/account/recovery-email` | 6-digit code |
| Recover account via recovery email | `/recover-account` | Backend `POST /api/auth/recovery/request` | 6-digit code |

`/forgot-password` handles the login email only, and always shows the same
"check your email" message, so it never reveals whether an address has an
account. Its "Can't access this email?" link leads to `/recover-account`.

Recovery-email codes (`backend/api/recovery_email.py`) are valid 30 minutes,
allow 5 wrong tries before being discarded, are stored hashed, and are scoped
to one purpose — a confirmation code can't reset a password. A correct
recovery code is exchanged for a Supabase recovery token, which signs the
browser into a recovery session; the user then sets a new password, and every
session is signed out. A recovery email only works once its owner confirmed
it with a code (stored in `public.recovery_emails`, backend-only).

Several accounts may share one recovery email. A recovery request then sends
one code for the address; after it's entered, `/recover-account` lists those
accounts (login email and name) to choose from. The list appears only after
a correct code, so typing someone's address reveals nothing.

## Notification emails

The backend also sends account and billing notices
(`backend/api/notifications.py`, templates in `email_templates.py`). They all
use the same layout as the auth emails.

| Email | To | When |
|---|---|---|
| Password changed | Login email | Right after a password change (profile page or reset link) |
| Recovery email added | Login email | A recovery email is confirmed with its code |
| Recovery email changed | Login email | A confirmed recovery email is removed or replaced |
| Account deleted | Login email | After self-service deletion or an admin force-delete |
| Payment received | Login email | An order is paid (SePay webhook, admin link, or a 100% discount) |
| Plan ends in 3 days / tomorrow | Login email | 3 days and 1 day before a paid term ends; not sent again after renewing |
| Plan ended | Login email | When a term ends and the account drops to Free |
| Student verification approved / rejected | Login email | An admin reviews the request |
| Transfer needs attention | Admins | A SePay transfer is unmatched, underpaid, paid twice, or for a declined order |

The time-based ones (expiry reminders, plan ended, verification results) and
anything the immediate path missed are picked up by a scheduler thread inside
the API process, every 5 minutes. Each email is recorded in
`public.notification_log` by `(kind, ref)` before it is sent, so nothing goes
out twice, even with several backend processes. The scheduler only looks back
a day or two, so turning it on never emails old history.

Optional `backend/.env` settings:

```bash
ADMIN_ALERT_EMAILS='you@example.com, partner@example.com'  # default: every profile with role admin
ADMIN_APP_URL='https://<admin portal URL>'                  # adds an "Open Revenue → Transactions" button
NOTIFY_INTERVAL_SECONDS='300'                                # scheduler interval (min 60)
NOTIFICATIONS_SCHEDULER='off'                                # disable the scheduler (e.g. a second API process)
```

## One-time setup

### 1. Database
`supabase db push` (applies `20261002000000_recovery_emails.sql` and
`20261003000000_recovery_email_otp.sql`). Prefer this over pasting into the
SQL editor, which leaves Supabase's migration history out of date.

### 2. Supabase dashboard
- **Authentication → Sign In / Providers → Email → Email OTP Expiration**:
  `1800` seconds (30 minutes). This is the expiry of every Supabase email
  link and code: signup confirmation and password reset. An expired link redirects with `error_code=otp_expired`, which the
  pages show as "this link has expired". (Recovery-email codes have their
  own 30-minute limit in the backend.)
- **Authentication → URL Configuration → Redirect URLs**, add:
  ```
  https://www.etymos.site/email-verified
  https://www.etymos.site/reset-password
  http://localhost:5173/email-verified
  http://localhost:5173/reset-password
  ```
  A redirect that isn't listed silently falls back to the Site URL (`/`),
  and a reset link would then just log the user in without asking for a
  new password.
- **Authentication → Emails → SMTP Settings**: host `mail.etymos.site`, port
  `465`, user `noreply@etymos.site`, sender name `Etymos`.
- **Authentication → Emails → Templates**: for **Confirm signup** and
  **Reset password**, paste `supabase/templates/confirm_signup.html` and
  `recovery.html` into the body (Source view), and the subject from
  `supabase/templates/subjects.txt`. The other templates (change email,
  invite, magic link, reauthentication) belong to flows the app doesn't
  offer, so they stay on Supabase's defaults.

### 3. Backend server (`/workspace/Etymos/backend/.env`)
```
SMTP_HOST=mail.etymos.site
SMTP_PORT=465
SMTP_USER=noreply@etymos.site
SMTP_PASSWORD='<noreply mailbox password>'
SMTP_FROM='Etymos <noreply@etymos.site>'
```
Keep the single quotes: `scripts/run_api.sh` loads this file with bash
`source`, where an unquoted `<` is a redirect and `$` in a password expands —
either one stops the API from starting.
Then restart the API — see `SERVER_OPERATIONS.md`.

### 4. Web app
Deploy as usual. The emails load the logo from
`https://www.etymos.site/assets/logo/etymos-mark-email.png`, so it shows
only once that file is deployed.

## Editing the email design
All emails come from one layout in `backend/api/email_templates.py`. After
changing it, regenerate the Supabase templates and paste them again:
```
python3 backend/scripts/build_email_templates.py            # supabase/templates/*.html
python3 backend/scripts/build_email_templates.py --preview /tmp/mail   # filled-in previews to open in a browser
```
All emails are in English, whatever language the user picked in the app.
