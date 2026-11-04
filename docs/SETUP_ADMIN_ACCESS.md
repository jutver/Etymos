# Admin dashboard access: Cloudflare Access gate

How to put `admin.etymos.site` behind Cloudflare Access, so only listed admin
emails can even load the admin dashboard. This is "Part A" of the admin
lockdown in `PLAN.md`; it's all dashboard work, no code.

It sits in front of the second layer built into the code ("Part B"): admins
must also enter an authenticator code before the database and backend give
them admin powers (`supabase/migrations/20261105000000_admin_requires_mfa.sql`).
The two layers don't depend on each other.

Cloudflare's menus get renamed from time to time. The labels below match the
dashboard as of November 2026; where an older layout differs, it's noted.

**What you need:** access to the Cloudflare account that holds `etymos.site`,
the Vercel admin project, the Supabase project, and the backend server's
`.env`. About 30–45 minutes.

---

## Step 0 — Give the admin app its own domain

Cloudflare can only guard a hostname whose DNS it serves, so the admin app
needs `admin.etymos.site` instead of only its `…vercel.app` address. Skip this
step if `admin` already appears in Cloudflare DNS and loads the admin app.

### 0a. Add the domain in Vercel
1. Go to **vercel.com** and open the **admin** project (not the main site).
2. Go to **Settings** → **Domains** → **Add**.
3. Enter `admin.etymos.site` → **Add**. If asked, connect it to **Production**.
4. Vercel shows the record to create, a **CNAME** with a value like
   `xxxxxxxx.vercel-dns-017.com`. Copy that value.

### 0b. Create the DNS record in Cloudflare
1. **dash.cloudflare.com** → **etymos.site** → **DNS** → **Records** → **Add record**.
2. Fill in:
   | Field | Value |
   |---|---|
   | Type | `CNAME` |
   | Name | `admin` |
   | Target | the value copied from Vercel |
   | Proxy status | **DNS only** (grey cloud) for now |
   | TTL | Auto |
3. **Save**.

The record must stay grey until Vercel has verified the domain and issued
its certificate. Step 1 turns the proxy on.

### 0c. Wait for Vercel
Back in **Settings** → **Domains**, wait until `admin.etymos.site` shows
**Valid Configuration** and the certificate is issued (usually a few minutes).

### 0d. Allow the new domain in Supabase
1. Supabase dashboard → **Authentication** → **URL Configuration**.
2. Under **Redirect URLs** → **Add URL**: `https://admin.etymos.site/**`.
3. **Save**.

Without this, Google sign-in on the new domain fails to return to the app.

### 0e. Allow the new domain on the backend
On the backend server, edit the backend `.env`:

```
# Keep the existing origins; add the admin one, comma-separated, no spaces.
ALLOWED_ORIGINS=https://etymos.site,https://www.etymos.site,https://admin.etymos.site
ADMIN_APP_URL=https://admin.etymos.site
```

Then restart the backend (see `docs/SERVER_OPERATIONS.md`, e.g.
`supervisorctl restart <backend program>`).
- `ALLOWED_ORIGINS` (CORS): without it, the admin Support pages can't call the API.
- `ADMIN_APP_URL`: makes "Open in admin" links in support alerts point to the new domain.

### 0f. Check
Open https://admin.etymos.site, log in, and open **Support** to check the
API works. Tell the other admins about the new address; the `vercel.app`
one stops working for them after Step 5.

---

## Step 1 — Send admin.etymos.site through Cloudflare

### 1a. Turn the proxy on
1. **DNS** → **Records** → the `admin` CNAME → **Edit**.
2. Switch **Proxy status** to **Proxied** (orange cloud) → **Save**.

Vercel will then show a **"Proxy Detected"** warning on this domain. That's
expected and safe to ignore for the admin site:
- Its "DDoS and bot-mitigation" point: Cloudflare does that job instead, and
  Access stops everyone not on the list before they reach Vercel.
- Its "performance" point: one extra hop, which a few admins won't notice.

Keep `etymos.site` and `www` on **DNS only**. The public site should keep
Vercel's own protection and speed.

### 1b. Use Full (strict) SSL for the admin hostname
Vercel needs HTTPS all the way to it. With Cloudflare's "Flexible" mode it
loops forever ("too many redirects"). Pick **one** of these:

**Option A: the whole domain (simplest).**
**SSL/TLS** → **Overview** → **Configure** → **Full (strict)**. This only
affects proxied records: `admin`, plus `api`, which goes through the tunnel
and doesn't use this setting. The root and `www` are DNS only and unaffected.

**Option B: a rule for `admin.etymos.site` only.**
1. **etymos.site** → **Rules** → **Configuration Rules** → **Create rule**.
   (Newer layout: **Rules** → **Overview** → **Create rule** → **Configuration Rule**.)
2. **Rule name:** `Admin – Full (strict) SSL`.
3. **If incoming requests match…**: select **Custom filter expression**. A
   row of three boxes appears.
   | Box | Value |
   |---|---|
   | Field | `Hostname` (type `host` to filter the list) |
   | Operator | `equals` |
   | Value | `admin.etymos.site`, with no `https://`, no `/` and no spaces |
4. Don't click **And** / **Or**. The **Expression Preview** must read:
   ```
   (http.host eq "admin.etymos.site")
   ```
   (Or click **Edit expression** and paste that line.)
5. **Then the settings are…** → **SSL** → **+ Add** → **Full (strict)**.
6. **Deploy**.

### 1c. Check
Open https://admin.etymos.site. It should load as before, with no redirect error.

---

## Step 2 — Set up Cloudflare Zero Trust (first time only)

### 2a. Open Zero Trust
1. **dash.cloudflare.com**, on the account home (not inside etymos.site).
2. Left sidebar → **Zero Trust**. This opens `one.dash.cloudflare.com`.

### 2b. Choose a team name
1. Enter a short name, e.g. `etymos`. It becomes
   `etymos.cloudflareaccess.com`, where the sign-in screen is served. Admins
   see it briefly, and it's awkward to change later.
2. **Next**.

### 2c. Choose the Free plan
1. Pick **Zero Trust Free** ($0, up to 50 users).
2. Cloudflare usually asks for a payment method even on Free. Nothing is
   charged on this plan.
3. **Purchase** / **Complete**. The label says Purchase even for $0.

### 2d. Check the One-time PIN login method
1. Zero Trust sidebar → **Settings** → **Authentication**.
   (Newer layout: **Integrations** → **Identity providers**.)
2. Under **Login methods**:
   - **One-time PIN** listed → nothing to do.
   - Not listed → **Add new** → **One-time PIN** → **Save**.

With One-time PIN, the admin types their email on the Cloudflare screen and
gets a 6-digit code by email. Only addresses allowed in Step 3 get a code.

### 2e. (Optional) Google sign-in
Only needed if admins should click "Sign in with Google" instead of waiting
for an email code.
1. **Login methods** → **Add new** → **Google**.
2. In **Google Cloud Console** → **APIs & Services** → **Credentials** →
   **Create credentials** → **OAuth client ID** → **Web application**:
   - **Authorized redirect URIs:**
     `https://etymos.cloudflareaccess.com/cdn-cgi/access/callback`
     (your own team name in place of `etymos`).
3. Paste the **Client ID** into **App ID** and the **Client secret** into
   **Client secret** → **Save** → **Test**.

---

## Step 3 — Protect the admin site

### 3a. Start the application
1. Zero Trust sidebar → **Access** → **Applications**
   (newest layout: **Access controls** → **Applications**).
2. **Add an application** → **Self-hosted** → **Select**.

The form has two tabs: **Application details** and **Additional settings**.
(Older layout: three tabs, **Configure app** → **Add policies** → **Setup**.)

### 3b. Application details → Destinations → Public hostnames
| Field | Value |
|---|---|
| Subdomain | `admin` |
| Domain | **Select Domain** → `etymos.site` |
| Path | *(empty: the whole site)* |

Don't click **+ Add public hostname**, **Add private hostname**, **Add
private IP** or **Add Workers**.

### 3c. Browser-based RDP, SSH, or VNC sessions
Leave **Off**.

### 3d. Access policies
Under "No policy associated", click **Create new policy**. It may open in a
side panel or a new tab.

| Field | Value |
|---|---|
| Policy name | `Admins` |
| Action | **Allow** |
| Session duration | Same as application timeout |

Under **Add rules** → **Include**:
- **Selector:** **Emails**
- **Value:** the first admin's email, then **Enter**. Repeat for each admin;
  each email becomes its own tag.

Leave **Require** and **Exclude** empty → **Save**.

If the policy opened in a new tab: back on the application, click **Select
existing policies** → tick **Admins** → **Confirm**. **Admins** should now
be listed under Access policies.

Use exact addresses. Don't use "Emails ending in", which would let in anyone
at that domain.

### 3e. Name and login methods
Further down **Application details** (or on **Additional settings**):
- **Application name:** `Etymos Admin`
- **Login methods:**
  - Turn **off** "Accept all available identity providers".
  - Tick **One-time PIN** (and **Google** if set up in 2e).
  - Optional: **Instant Auth** on, if only one method is ticked, to skip
    the method-picker screen.

### 3f. Additional settings tab
- **Session duration:** `24 hours`. That's how long an admin stays past the
  gate before entering a new email code.
- **App Launcher visibility:** off.
- CORS, cookie and the remaining settings: leave the defaults. The admin app
  only loads its own files from `admin.etymos.site`; its Supabase and API
  calls go to other domains that Access doesn't touch.

**Save**.

### 3g. Quick check
- **Applications** lists **Etymos Admin** → `admin.etymos.site`.
- https://admin.etymos.site in a private window shows the Cloudflare email
  screen instead of the admin login.

---

## Step 4 — Keep Vercel's certificate renewals working

Vercel renews the HTTPS certificate by fetching
`admin.etymos.site/.well-known/acme-challenge/…`. Access would block that
too, and the certificate would expire about three months later. A second
application with a **Bypass** policy leaves just that path open. The more
specific path wins over Step 3's application.

1. **Access** → **Applications** → **Add an application** → **Self-hosted**.
2. **Destinations → Public hostnames:**
   | Field | Value |
   |---|---|
   | Subdomain | `admin` |
   | Domain | `etymos.site` |
   | Path | `.well-known/acme-challenge/*` |
3. **Access policies** → **Create new policy**:
   | Field | Value |
   |---|---|
   | Policy name | `ACME bypass` |
   | Action | **Bypass** |
   | Include → Selector | **Everyone** |
   **Save**, then attach it to this application if it opened in a new tab.
4. **Application name:** `Etymos Admin – cert renewal`. Login methods: leave as is.
5. **Save**.

Check: https://admin.etymos.site/.well-known/acme-challenge/test in a private
window should show a plain Vercel 404, **not** the Cloudflare email screen.

---

## Step 5 — Close the vercel.app back door

The project's `*.vercel.app` URLs don't pass through Cloudflare, so they
would skip the gate.

1. **vercel.com** → the **admin** project → **Settings** → **Deployment Protection**.
2. **Vercel Authentication** → **Enabled**, scope **Standard Protection**.
   That protects every deployment URL except production custom domains
   (`admin.etymos.site`, which Cloudflare now guards).
3. **Save**.

Only members of your Vercel team can open `vercel.app` URLs from now on.

---

## Step 6 — Test

Use a private/incognito window for each check.

| # | Do | Expect |
|---|---|---|
| 1 | Open https://admin.etymos.site | Cloudflare screen asking for an email |
| 2 | Enter an email **not** on the list | No code arrives / "not authorized" |
| 3 | Enter an admin email, type the emailed code | The normal Etymos Admin login |
| 4 | Log in with email + password | Admin authenticator step (once MFA is on), then the dashboard |
| 5 | Log in with Google instead | Same; the callback returns to `admin.etymos.site` |
| 6 | Open **Support** in the dashboard | Tickets load (CORS from step 0e works) |
| 7 | Open `https://<project>.vercel.app` | Vercel's login wall, not the admin app |
| 8 | Open `…/.well-known/acme-challenge/test` | Plain 404, no Cloudflare screen |

If check 1 shows the admin login straight away, the `admin` record is
probably still DNS only (Step 1a), or the hostname in Step 3b doesn't match.

---

## Day to day

- **Add an admin:** Zero Trust → **Access** → **Policies** (or the application
  → **Policies**) → **Admins** → add their email under **Include** → **Save**.
  Also set `role = 'admin'` on their profile as usual. On their first admin
  login, they set up an authenticator.
- **Remove an admin:** remove their email from **Admins** and set their
  profile role back to `user`. For an immediate cut-off, also revoke their
  sessions: Zero Trust → **My Team** → **Users** → the user → **Revoke session**.
- **An admin lost their authenticator phone:** in the Supabase SQL editor,
  `delete from auth.mfa_factors where user_id = '<their user id>';`. They get
  a new QR code on their next login. This is separate from the Cloudflare gate.
- **"Session expired" mid-work:** after the 24-hour gate session ends, a
  button in an open dashboard can fail. Reload the page to get the Cloudflare
  email screen again.

## Rollout order with the authenticator requirement (Part B)

1. Supabase → **Authentication** → **Multi-Factor** → enable **TOTP**.
2. Deploy the admin app. Every admin logs in once and sets up their authenticator.
3. Apply `20261105000000_admin_requires_mfa.sql`, then deploy the backend.

Applying step 3 before every admin has done step 2 locks those admins out of
admin powers until they enrol. The Cloudflare steps in this document can be
done at any point.
