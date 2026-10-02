# Email: password reset, recovery email, 30-minute links, HTML templates

Everything that sends email to users, and the settings outside the repo it
depends on. Mail goes out through the iNET OneMail mailbox
`noreply@etymos.site` (DNS: MX/SPF/DKIM on Cloudflare, see the iNET panel).

## How the flows fit together

| Flow | Who sends | Lands on |
|---|---|---|
| Confirm signup | Supabase (template `confirm_signup`) | `/email-verified` |
| Forgot password, login email | Supabase (template `recovery`) | `/reset-password` |
| Forgot password, recovery email | Backend `POST /api/auth/forgot-password` | `/reset-password` |
| Confirm a recovery email | Backend `PUT /api/account/recovery-email` | `/recovery-email/verify` |

"Forgot password" (`/forgot-password`) fires both forgot-password requests for
whatever address is typed, and always shows the same "check your email"
message, so the page never reveals whether an address has an account.

A recovery email only works for resets after its owner clicks the
confirmation link (stored in `public.recovery_emails`, backend-only).

## One-time setup

### 1. Database
Run `supabase/migrations/20261002000000_recovery_emails.sql` in the Supabase
SQL editor (or `supabase db push`).

### 2. Supabase dashboard
- **Authentication → Sign In / Providers → Email → Email OTP Expiration**:
  `1800` seconds (30 minutes). This is the expiry of every Supabase email
  link and code: signup confirmation, password reset (both kinds — the
  backend's reset links are minted by Supabase too), email change, magic
  link. An expired link redirects with `error_code=otp_expired`, which the
  pages show as "this link has expired".
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

### 3. Backend server (`~/Etymos/backend/.env`)
```
SMTP_HOST=mail.etymos.site
SMTP_PORT=465
SMTP_USER=noreply@etymos.site
SMTP_PASSWORD='<noreply mailbox password>'
SMTP_FROM='Etymos <noreply@etymos.site>'
PUBLIC_APP_URL=https://www.etymos.site
```
Keep the single quotes: `scripts/run_api.sh` loads this file with bash
`source`, where an unquoted `<` is a redirect and `$` in a password expands —
either one stops the API from starting.
Then `supervisorctl -c /root/Etymos/backend/supervisord.conf restart etymos-api`.

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
Templates pick Vietnamese or English from `user_metadata.locale`, which the
web app keeps equal to the language the user last chose; Vietnamese is the
fallback.
