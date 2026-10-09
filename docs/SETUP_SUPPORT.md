# Support: contact form, ticket inbox, email replies

Built in, no third-party helpdesk. People contact support from `/contact`
(signed in or not) or by emailing `support@etymos.site`. Agents answer from
the admin app (**Support**). Requesters reply by email or on the site.

## How it fits together

```
/contact form ──┐                                  ┌─► acknowledgement email to the requester
email to        ├─► backend opens ticket #1042 ────┤   (from support@, subject "[#1042] ...")
support@ ───────┘   (support_tickets/messages)     └─► alert to SUPPORT_ALERT_EMAILS
                                ▲
agent reply in admin app ───────┘──► emailed to the requester, threaded (In-Reply-To/References)
                                ▲
requester hits Reply ─► support@ mailbox ─► IMAP poller (every 60 s) ─► matched to #1042
requester replies on the site (/account/support/1042, or /support/t/<token> for guests) ─┘
```

| Piece | Where |
|---|---|
| Tables, bucket | `supabase/migrations/20261009000000_support.sql` |
| API (requester + admin) | `backend/api/support.py` |
| Outgoing support email | `backend/api/support_mail.py` |
| Email replies (IMAP poller) | `backend/api/support_inbound.py` |
| Email copy | `backend/api/email_templates.py` (`support_*_email`) |
| Web: contact, My requests, guest view | `apps/web/src/screens/{Contact,SupportRequests,SupportTicket,GuestSupportTicket}` |
| Admin inbox + ticket view | `apps/admin/src/screens/Support` |

### Matching email replies to tickets

OneMail has **no plus-addressing** (`support+anything@` is silently dropped,
tested 2026-10-08), so reply addresses can't carry a per-ticket token.
Instead, in order:

1. `In-Reply-To` / `References` against the Message-IDs we stored for the ticket.
2. Our own Message-ID format, `<support.{number}.{uuid}@etymos.site>`.
3. A `[#1042]` subject tag, **only** from the requester's own address (the
   ticket's address, or the account's login or confirmed recovery address).

A header match from some other address is kept but flagged ("sent from X,
which isn't the requester's address") and doesn't reopen the ticket. Email
that matches nothing opens a new ticket. A reply to a closed ticket opens a
new ticket that links back to the old one.

Every support email carries a reply marker line
(`##- Please type your reply above this line -##`); the poller keeps what
is above it and also recognises the usual "On … wrote:" / "Vào … đã viết:"
/ Outlook header blocks. The raw `.eml` is stored, and the admin view links
to it ("Original email") in case the cut went wrong.

Robots are ignored: `Auto-Submitted`, bounces (`MAILER-DAEMON`, delivery
reports), mailing lists, "Out of office"/"Trả lời tự động" subjects, and our
own outgoing mail. Every email the poller looks at is logged in
`support_inbound_log`. Processed mail is moved to the `Processed` folder;
mail that failed goes to `Support-Failed` for a person to look at.

### Identity

A ticket is `identity_verified` only when a signed-in user opened it. Guest
tickets and email tickets are not, even when the address matches an
account: a guest can type anyone's address and a From header can be forged.
The admin view says so, and agents must not change an account (email,
password, plan, refunds) on the strength of one.

### Guest links

Tickets without an account are opened from emails at `/support/t/<token>`.
The token is an HMAC of the ticket id under `SUPPORT_LINK_SECRET`, so
nothing about it is stored. Changing the secret revokes every guest link
(the emails then still work for replying; only the view link stops working).

## One-time setup

### 1. Database

Apply `supabase/migrations/20261009000000_support.sql` (SQL editor, or
`supabase db push`). It creates the four `support_*` tables and the private
`support-attachments` bucket.

### 2. Mailbox

`support@etymos.site` must be a real OneMail mailbox (not an alias) with IMAP
on. Check by logging in with a mail app: IMAP `mail.etymos.site:993` SSL/TLS,
username = the full address.

Don't publish other `@etymos.site` addresses that aren't real mailboxes —
OneMail accepts and silently drops mail to unknown addresses.

### 3. Backend server (`/workspace/Etymos/backend/.env`)

```
SUPPORT_EMAIL=support@etymos.site
SUPPORT_SMTP_USER=support@etymos.site
SUPPORT_SMTP_PASSWORD='...'
# IMAP defaults: host = SMTP_HOST, user/password = SUPPORT_SMTP_*
# SUPPORT_IMAP_HOST=mail.etymos.site
# SUPPORT_IMAP_USER=support@etymos.site
# SUPPORT_IMAP_PASSWORD='...'
SUPPORT_LINK_SECRET='<at least 32 random characters>'   # python3 -c "import secrets; print(secrets.token_hex(32))"
SUPPORT_ALERT_EMAILS=you@example.com                     # who hears about new tickets; NEVER support@ itself
WEB_APP_URL=https://www.etymos.site
ADMIN_APP_URL=https://admin.etymos.site                  # optional, for "Open in admin" links in alerts
```

Optional:

| Key | Default | |
|---|---|---|
| `SUPPORT_POLLER` | `on` | `off` stops reading the mailbox (the form and admin still work) |
| `SUPPORT_POLL_SECONDS` | `60` | minimum 30 |
| `SUPPORT_INBOUND_LOOKBACK_DAYS` | `2` | only mail this recent is read, so turning the poller on doesn't import an old mailbox |
| `SUPPORT_APPEND_SENT` | `on` | copy sent support mail into the mailbox's Sent folder |
| `RATE_LIMIT_SUPPORT_CREATE` | `5/hour` | per IP; also max 3 tickets per hour per requester address |
| `RATE_LIMIT_SUPPORT_REPLY` | `30/hour` | |

Without `SUPPORT_SMTP_*`, support mail goes out through the `SMTP_USER`
login (noreply@) with `Reply-To: support@etymos.site`, and the poller is off
unless `SUPPORT_IMAP_*` is set. `SUPPORT_ALERT_EMAILS` falls back to
`ADMIN_ALERT_EMAILS`, then to every admin's address.

Restart the API afterwards. The log shows
`Support loop started (every 60s, inbox polling on)`.

### 4. Try it

1. Signed out, open `/contact`, send a request with a screenshot. You get
   "We got your request #1001" from support@; the alert address gets
   "[Etymos support] New support request #1001".
2. In the admin app, **Support** → #1001 → reply. The reply arrives in the
   requester's inbox in the same thread.
3. Reply to that email from the requester's inbox. Within a minute it shows
   on #1001 and the ticket is back to **Open**.
4. Email `support@etymos.site` directly from another address: a new ticket.
