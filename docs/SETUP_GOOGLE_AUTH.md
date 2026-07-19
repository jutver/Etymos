# Google OAuth setup

Step-by-step runbook for wiring up "Continue with Google" so it lands users
back in the right app instead of somewhere unexpected. Written after a bug
report where clicking "Continue with Google" on the admin login page landed
on `localhost:3000/#access_token=...` — a raw directory listing of this
repo — instead of the admin app's `/auth/callback` route. See
[Troubleshooting](#troubleshooting) for the fix if you hit that exact
symptom; the short version is it's almost never a code bug (see
[How the code already works](#how-the-code-already-works) below).

This doc assumes you've already done the base Supabase project setup in
[`SETUP_SUPABASE.md`](./SETUP_SUPABASE.md). Nothing here duplicates that —
this is specifically the Google-provider + redirect-URL piece.

## How the code already works (read this first)

All three "Continue with Google" buttons — `apps/web/src/screens/Login`,
`apps/web/src/screens/Signup`, and `apps/admin/src/screens/Login` — call:

```ts
await supabase.auth.signInWithOAuth({
  provider: "google",
  options: {
    redirectTo: `${window.location.origin}/auth/callback`,
  },
});
```

`window.location.origin` is computed live from whatever origin the browser
is actually on — it is **not** hardcoded to any port or domain. Both apps
have a matching `/auth/callback` route (`apps/web/src/screens/AuthCallback`,
`apps/admin/src/screens/AuthCallback`) mounted **outside** their respective
auth guards (`RequireAuth` / `RequireAdmin`) in `App.tsx`, so the callback
page is reachable pre-login. Each `AuthCallbackPage` just waits for the
shared `useAuth()`/`useAdminAuth()` hook to resolve a session, then
navigates into the app.

The shared Supabase client (`packages/shared/src/supabase.ts`) sets no
global redirect option — `createClient(url, key, { auth: { persistSession:
true, autoRefreshToken: true } })` — so there's nothing there that could
override or interfere with the per-call `redirectTo`.

**Conclusion: the frontend code correctly asks Supabase to send the user
back to its own origin's `/auth/callback`.** If the browser ends up
somewhere else, the cause lives in Supabase project configuration, not in
this codebase — specifically the Redirect URLs allowlist described below.

### Local dev ports are now pinned

`apps/web/vite.config.ts` and `apps/admin/vite.config.ts` now pin fixed dev
ports (`server.port` + `strictPort: true`):

| App | Dev port | Dev origin |
|---|---|---|
| `@etymos/web` | `5173` | `http://localhost:5173` |
| `@etymos/admin` | `5174` | `http://localhost:5174` |

Previously neither config set a port, so both apps defaulted to Vite's
standard `5173` — if you ran `npm run dev` in both at once, whichever
started second would silently bump to `5174` (or higher), making it
ambiguous which port belonged to which app across dev sessions. With
`strictPort: true`, if a port is already taken the dev server now **fails
to start** instead of silently picking a different one, so the port-to-app
mapping is always deterministic and safe to hardcode into the Redirect URLs
allowlist below.

If you need to run `web`'s dev server standalone, it still works on
`http://localhost:5173`; same for `admin` on `5174`. Run both together with
whatever workspace script your `package.json` root defines, or in two
terminals.

## 1. Google Cloud Console — OAuth 2.0 Client ID

1. Go to [Google Cloud Console](https://console.cloud.google.com/) → select
   (or create) a project → **APIs & Services > Credentials**.
2. Click **Create Credentials > OAuth client ID**.
   - If prompted, configure the **OAuth consent screen** first (External
     user type is fine for a public-facing app; fill in app name, support
     email, and the scopes `email`, `profile`, `openid`).
3. Application type: **Web application**.
4. **Authorized JavaScript origins** — the origins your app's frontend is
   actually served from (no path, no trailing slash):
   - `https://<your-prod-web-domain>` (e.g. `https://app.etymos.io`)
   - `https://<your-prod-admin-domain>` (once the admin app is deployed,
     e.g. `https://admin.etymos.io`)
   - `http://localhost:5173` (web, local dev)
   - `http://localhost:5174` (admin, local dev)
5. **Authorized redirect URIs** — **this is the #1 point of confusion, read
   carefully**: this field is **not** your app's `/auth/callback` route. It
   is Supabase's own OAuth callback endpoint, the URL Google redirects to
   *after* the user approves consent, before Supabase hands control back to
   your app:

   ```
   https://<your-project-ref>.supabase.co/auth/v1/callback
   ```

   Find `<your-project-ref>` in the subdomain of `VITE_SUPABASE_URL` (same
   value referenced in `SETUP_SUPABASE.md` step 1). Add **only** this one
   URL here — do not add `localhost:5173/auth/callback`,
   `localhost:5174/auth/callback`, or any prod app URL to this field; those
   go in Supabase's Redirect URLs allowlist instead (step 3 below), not
   here.
6. Save. Copy the generated **Client ID** and **Client Secret** — you'll
   paste both into Supabase next.

Why the distinction matters: the OAuth handshake is
`browser → Google → Supabase → your app`. Google only ever redirects back
to Supabase (the "Authorized redirect URIs" you just set), never directly
to your app. Supabase then performs its *own* second redirect to whatever
`redirectTo` the app requested — and that second hop is governed entirely
by Supabase's Redirect URLs allowlist, covered next. If you put your app's
`/auth/callback` URLs in the Google Cloud "Authorized redirect URIs" field
instead of Supabase's, Google will reject the request outright with a
`redirect_uri_mismatch` error, since Supabase's callback is the only URI it
was actually configured to trust.

## 2. Supabase Dashboard — enable the Google provider

1. Open your project in the [Supabase Dashboard](https://supabase.com/dashboard).
2. Go to **Authentication > Providers** (previously "Auth Providers" in
   older dashboard versions — search for "Providers" if the label has
   moved).
3. Find **Google** in the provider list, toggle it **on**.
4. Paste the **Client ID** and **Client Secret** from step 1.
5. Save.

## 3. Supabase Dashboard — Site URL and Redirect URLs

This is the step that actually fixes the bug described at the top.

1. Go to **Authentication > URL Configuration** (this section has moved
   around dashboard versions — if you don't see "URL Configuration", search
   Auth settings for "Site URL" or "Redirect URLs"; it's sometimes
   surfaced directly under **Authentication > Settings**).
2. **Site URL** — set this to your canonical production **web** app URL,
   e.g. `https://app.etymos.io`. This is Supabase's fallback destination
   whenever a requested `redirectTo` isn't found in the Redirect URLs
   allowlist below — get this wrong (or leave a stale framework-template
   default like `http://localhost:3000`) and *every* OAuth sign-in that
   doesn't exactly match an allowlisted URL silently falls back here,
   regardless of which app or port actually initiated the flow.
3. **Redirect URLs** — add every exact origin + `/auth/callback` combo any
   app will ever request, one per line/entry:

   ```
   https://<your-prod-web-domain>/auth/callback
   https://<your-prod-admin-domain>/auth/callback
   http://localhost:5173/auth/callback
   http://localhost:5174/auth/callback
   ```

   Some Supabase dashboard versions support wildcards (e.g.
   `http://localhost:5173/**`) — if available, that's a convenience, but
   prefer listing exact `/auth/callback` URLs since that's the only path
   this app ever requests.

4. Save.

**Every** URL passed as `redirectTo` in code must appear here character-for
-character (scheme, host, port, path) or Supabase silently falls back to
Site URL instead of erroring — that silent fallback is what produces the
"landed somewhere unexpected" symptom.

## Troubleshooting

**Symptom: after Google consent, the browser lands somewhere unexpected**
(a stale `localhost:3000`, the wrong app, a blank page, etc.), often with an
`#access_token=...` fragment in the URL.

This is almost always the Redirect URLs allowlist (step 3 above), not a
code bug:

1. Note the exact origin + port you started the OAuth flow from (check the
   address bar before clicking "Continue with Google").
2. Confirm `<that origin>/auth/callback` is listed **exactly** in
   Supabase's Redirect URLs (Authentication > URL Configuration).
3. If it's missing, add it and retry — Supabase's fallback-to-Site-URL
   behavior is silent and produces no error message, so a missing entry
   looks identical to a broken app.
4. If you just changed dev ports (see the pinned-ports table above), make
   sure the allowlist reflects the *current* ports, not old ones.

**If none of the above resolves it**, re-check step 1's "Authorized
redirect URIs" in Google Cloud Console — it should contain *only*
`https://<project-ref>.supabase.co/auth/v1/callback`, never an app URL. A
mismatch here surfaces as a Google-side `redirect_uri_mismatch` error
*before* the user ever reaches Supabase, which is a different failure mode
than the Site-URL fallback above (that one still completes the sign-in,
just to the wrong page).

### About the `localhost:3000` directory listing specifically

If what you're seeing at `localhost:3000` is not just "the wrong app" but a
**raw directory listing of this entire repo** (showing `.git/`,
`.env.local`, `backend/`, `apps/`, etc.), that page is not part of this
project — neither Vite dev server (`web` on `5173`, `admin` on `5174`, per
the pinned ports above) defaults to port `3000` or serves a directory
index. Something else is bound to port `3000` on your machine (a stray
static file server, a different project's dev server, `python -m
http.server`, etc. started from the repo root). Find and stop it:

```bash
lsof -nP -iTCP:3000 -sTCP:LISTEN   # macOS/Linux — shows the PID holding port 3000
kill <pid>                          # once you've confirmed what it is
```

Then fix the actual redirect misconfiguration per the Troubleshooting
section above so OAuth never tries to land on port 3000 in the first
place.

**Also:** the URL in that screenshot contained a live `access_token` JWT in
the fragment. This is low-risk — it's a short-lived Supabase session token,
`localhost`-only, and never left the local machine's browser history/dev
server logs — but as a precaution, sign out and back in on both apps (and
anywhere else the same account is signed in) after resolving this, so any
token that was exposed in that URL/history is invalidated.
