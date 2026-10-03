# Payments: SePay bank transfers

Customers pay for plans and credit packs by bank transfer (VietQR). SePay
watches the shop's bank account and calls our backend for every transfer, so
the plan or credits are granted automatically, usually within a minute.

## How it works

1. **Checkout** (`/checkout`) asks the backend for a price
   (`POST /api/payments/quote`). Prices always come from the database
   (`plan_definitions`, `credit_packs`, `plan_discounts`, `discount_codes`),
   never from the browser.
2. **Pay** creates an order (`POST /api/payments/orders`): a `checkout_events`
   row with `payment_method = 'sepay'` and a unique **payment code**, e.g.
   `ETM7K2QF9XA`. The page shows a VietQR from `qr.sepay.vn` with the amount
   and the code as the transfer content, plus the details for typing them in.
   The QR is shown for 30 minutes. Starting a new order cancels the old one.
3. The customer transfers from any banking app (MoMo and ZaloPay can pay
   VietQR too).
4. **SePay** POSTs the transfer to `POST /api/payments/sepay/webhook`.
   The backend checks the API key, finds the payment code in the transfer
   content, and calls the database function `record_sepay_transaction`.
   In one transaction, that function:
   - logs the transfer in `payment_transactions`, once per SePay id, so a
     retried webhook never grants twice;
   - finds the order by its code and checks the amount;
   - grants the plan or credits;
   - marks the order paid.
5. The checkout page polls the order every 4 seconds and moves to the receipt
   (`/payment-success?order=…`) as soon as the order is paid.

A transfer that arrives after the QR expired, or for an order the customer
cancelled, is still honoured. The order records exactly what was bought at
what price.

A discount code is only used up when its order is paid, not when it is typed
in.

Transfers that can't be settled automatically are kept in the ledger for an
admin. They appear under **Admin → Revenue → Transactions → Needs attention**.

| Status | Meaning | What to do |
|---|---|---|
| `unmatched` | No payment code in the content, or no order has it | Ask the customer which order it was, then **Link** the transfer to that order |
| `underpaid` | Less than the order's price; nothing granted | **Link** it (accepts the smaller amount), or refund and **Mark resolved** |
| `duplicate` (Paid twice) | The order was already paid | Refund and **Mark resolved**, or **Link** it to another unpaid order |
| `review` | Paid for an order an admin had declined | Decide, then **Link** or **Mark resolved** |
| `ignored` (Outgoing) | Money going out of the account | Nothing to do |

Refunds are made by hand from the bank account; then mark the transfer
resolved with a note saying so.

## Admin portal

**Revenue** (sidebar) has three tabs:

- **Overview** shows these figures for a date range in Vietnam time:
  - revenue (paid orders, counted on the day paid);
  - paid orders and average order;
  - money received through SePay;
  - transfers needing attention and orders awaiting payment;
  - revenue by day and by product;
  - the latest transfers.

  **Export CSV** downloads every transfer in the range for bookkeeping.
- **Transactions** is the SePay ledger. Link or resolve transfers that need
  attention.
- **Orders** lists every order with its payment code and status.

There is no manual approval any more. The old Waitlist → Purchases queue and
the `approve_purchase_request` database function are gone, so nothing is
granted without a recorded transfer. The only manual action left is
**Link**: it attaches a real, already-received transfer to an order.
Requests from the old manual system that were still pending show under
Orders → Awaiting payment (method MoMo/VNPay/ZaloPay). If one of those
customers really paid, adjust their plan or credits from their page under
Users.

## One-time setup

### 1. Database

Apply the migration `supabase/migrations/20261004000000_sepay_payments.sql`:

```bash
supabase db push
```

It adds:

- the order columns on `checkout_events`;
- the `payment_transactions` ledger, readable by admins only;
- the settlement functions.

It also drops manual approval (`approve_purchase_request`) and the policy
that let users insert their own `checkout_events` rows. Orders are now
created only by the backend.

### 2. SePay dashboard (my.sepay.vn)

1. **Link the bank account** that receives payments.
2. *(Optional)* Go to **Company → General settings → Payment code structure**
   and set prefix `ETM` followed by 8 letters/digits. SePay then fills the
   `code` field itself. The backend also finds the code in the transfer
   content, so this isn't required.
3. **WebHooks → Add webhook**:
   - Event: **Money in** (outgoing transfers are ignored anyway).
   - Bank account: the account from step 1.
   - Skip if there's no payment code: **No**. This way stray transfers still
     reach the ledger for an admin.
   - URL: `https://api.etymos.site/api/payments/sepay/webhook`
   - Authentication: **API Key**. Generate a long random key, for example
     with `openssl rand -hex 32`, and paste it in. SePay then sends
     `Authorization: Apikey <key>`.
   - Request content type: `application/json`.

SePay retries a failed delivery up to 7 times over about 5 hours. The
backend only answers `{"success": true}` once the transfer is safely
recorded.

### 3. Backend `.env`

```bash
# The same key as in the SePay webhook settings. Without it the webhook
# refuses every call (503) — payments are never accepted unauthenticated.
SEPAY_WEBHOOK_API_KEY='<random key>'
# Bank short name as qr.sepay.vn knows it (list: https://qr.sepay.vn/banks.json),
# e.g. TPBank, Vietcombank, MBBank.
SEPAY_BANK='TPBank'
SEPAY_ACCOUNT_NUMBER='<account number>'
# Shown to the customer next to the QR, as the bank prints it (no accents).
SEPAY_ACCOUNT_NAME='<ACCOUNT HOLDER NAME>'

# Optional
# PAYMENT_CODE_PREFIX='ETM'          # letters only
# PAYMENT_ORDER_TTL_MINUTES='30'     # how long the QR is shown
# RATE_LIMIT_PAYMENT_QUOTE='120/hour'
# RATE_LIMIT_PAYMENT_ORDER='30/hour'
```

Keep the values in single quotes (see `SERVER_OPERATIONS.md`), then restart
`etymos-api`. Until `SEPAY_BANK` and `SEPAY_ACCOUNT_NUMBER` are set, checkout
answers "Payments aren't available right now".

### 4. Deploy order

Deploy in this order: migration, then backend, then web. The new checkout
page calls endpoints the old backend doesn't have.

## Checking it works

Unit and database tests:

```bash
# API: pricing, orders, webhook auth/payload handling
cd backend && .venv/bin/python -m pytest tests/test_payments.py

# Database: settlement, idempotency, admin link/resolve, permissions.
# Runs every migration against a throwaway local Postgres; skipped if
# pgserver isn't installed:
python3 -m venv /tmp/pgenv && /tmp/pgenv/bin/pip install pgserver "psycopg[binary]" pytest
/tmp/pgenv/bin/python -m pytest backend/tests/test_payments_sql.py

# Web / admin helpers
npm --workspace apps/web test && npm --workspace apps/admin test
```

After deploying, run these checks:

- **The webhook rejects a wrong key** (nothing is recorded):

  ```bash
  curl -s -o /dev/null -w '%{http_code}\n' -X POST https://api.etymos.site/api/payments/sepay/webhook \
    -H 'Authorization: Apikey wrong' -H 'Content-Type: application/json' \
    -d '{"id":1,"transferType":"in","transferAmount":0}'      # → 401
  ```

- **A real end-to-end payment.** Sign in to the web app with your own
  account and buy one Standard pack (19.000 đ). Transfer with the QR. The
  page should switch to "Payment received" within about a minute, and
  Admin → Revenue should show the paid order and a matched transfer.
- **The SePay log.** In the SePay dashboard (WebHooks → log), every delivery
  should show HTTP 200 with `{"success": true}`.

## Subscriptions

Plans are prepaid terms (`supabase/migrations/20261005000000_plan_expiry.sql`):

- Buying a plan starts a term of 1 month or 1 year (`profiles.plan_expires_at`).
- Buying the **same** plan while it's active renews it: the new term is added
  to the end of the current one and usage carries on. My Plan and the plan
  card show a **Renew** button for this.
- Buying a **different** plan replaces the current one from today; checkout
  warns that time left on the old plan isn't carried over.
- When a term ends, the account drops to Free: pg_cron runs
  `expire_lapsed_plans()` every 10 minutes, and the backend and web app treat
  a lapsed plan as Free immediately.
- Admins can change the end date (or clear it for "no end date") on the
  user's page in the admin portal.

When the migration shipped, existing paid plans got an end date from their
latest paid order (or 30 days for plans granted by hand), never less than 7
days away.

**No automatic charging.** Bank transfers are pushed by the customer, so
nothing can be charged on renewal. Auto-charge would need a gateway that
stores a card or wallet token (e.g. MoMo/ZaloPay recurring payments or a card
gateway), which requires a merchant contract.

Customers get an email 3 days and 1 day before a term ends, and when it
ends (see `SETUP_EMAIL.md` → Notification emails). They see every order
under **My Plan → Payment history**
(`/account/payments`, also in the account menu).

## Known limits

- Bank transfers can't be refunded automatically. Refund from the bank, then
  resolve the transfer in the admin portal.
- Matching relies on the payment code in the transfer content. Customers who
  edit it end up under "Needs attention".
