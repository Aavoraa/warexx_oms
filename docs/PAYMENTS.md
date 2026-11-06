# Subscriptions and payments: HDFC Bank SmartGateway

The pricing cards' **Subscribe** opens `/pay`. The customer enters billing
details, accepts the terms and pays on **HDFC Bank SmartGateway's** own page.
The server confirms the payment with HDFC before the subscription opens.

```
/pay ──checkout──► lead API ──Session API──► HDFC ──► HDFC's payment page (card / UPI / net banking)
                       │                                         │
                       │◄── POST /api/payment/return ────────────┘  (the customer's browser)
                       │◄── POST /api/payment/webhook ───────────── (HDFC's servers)
                       │──► Order Status API (server to server): the ONLY source of truth
                       ▼
                billing database: order paid → subscription active → receipt
```

Integration used: **SmartGateway API Reference (Basic Authentication)**. It does
not use the Integration Kit, JWT, HyperCheckout SDK or mandates.

| Step | Official page |
|---|---|
| Architecture, prerequisites | [integration-architecture](https://smartgateway.hdfc.bank.in/docs/smartgateway-api-ref-basicauth/docs/overview/integration-architecture), [pre-requisites](https://smartgateway.hdfc.bank.in/docs/docs/smartgateway-api-ref-basicauth/docs/overview/pre-requisites) |
| API key | [generate-the-api-key](https://smartgateway.hdfc.bank.in/docs/docs/smartgateway-api-ref-basicauth/docs/backend-setup/generate-the-api-key) |
| `POST /session` | [Session API](https://smartgateway.hdfc.bank.in/docs/docs/smartgateway-api-ref-basicauth/docs/apis/session) |
| `GET /orders/{order_id}` | [Order Status API](https://smartgateway.hdfc.bank.in/docs/docs/smartgateway-api-ref-basicauth/docs/apis/order-status-api) |
| `POST /orders/{order_id}/refunds` | [Refund Order API](https://smartgateway.hdfc.bank.in/docs/docs/smartgateway-api-ref-basicauth/docs/apis/refund-order-api) |
| Return URL handling | [Handling Payment Response](https://smartgateway.hdfc.bank.in/docs/docs/smartgateway-api-ref-basicauth/docs/handling-payment-response/handling-payment-response), [HMAC signature](https://smartgateway.hdfc.bank.in/docs/docs/smartgateway-api-ref-basicauth/docs/resources/hmac-signature-verification-for-return-url) |
| Webhooks | [Webhooks](https://smartgateway.hdfc.bank.in/docs/docs/smartgateway-api-ref-basicauth/docs/handling-payment-response/webhooks), [events](https://smartgateway.hdfc.bank.in/docs/docs/smartgateway-api-ref-basicauth/docs/resources/webhook-events-and-sample-payloads) |
| Statuses | [Transaction Status](https://smartgateway.hdfc.bank.in/docs/docs/smartgateway-api-ref-basicauth/docs/resources/transaction-status) |
| Sandbox | [Test Resources](https://smartgateway.hdfc.bank.in/docs/docs/smartgateway-api-ref-basicauth/docs/resources/test-resources), [Production prerequisites](https://smartgateway.hdfc.bank.in/docs/docs/smartgateway-api-ref-basicauth/docs/resources/prerequisites-for-production) |

## The flow, exactly

1. **Checkout** (`POST /api/subscribe {action:"checkout"}`): the details and terms are checked. The
   price comes from the server: `payments.PLANS` (the landing page's ₹29,999 / month and
   ₹3,29,000 / year) plus GST at `BILLING_GST_PERCENT`. The browser's amount, plan price, tenant and
   currency are ignored. The server creates a customer (mapped to a workspace slug), a subscription
   (`payment_pending`) and an order (`created`, 18-character non-sequential alphanumeric id).
2. **Session API**: `Authorization: Basic base64(API key)`, `x-merchantid`, `x-customerid`,
   `x-resellerid: hdfc_reseller`, JSON body with `order_id, amount, customer_id, customer_email,
   customer_phone (10 digits), payment_page_client_id, action: "paymentPage", currency: "INR",
   return_url, description, first_name, last_name, udf1 (plan)`. The answer must carry our
   `order_id` and a `payment_links.web` on the configured SmartGateway host. The order becomes
   `pending`, and the browser gets only the link and a signed **order pass** (7 days).
   - A timeout is not treated as a failure until the Order Status API confirms the order isn't
     at HDFC. If the order is there, its link is used.
   - The same customer and plan within 10 minutes (a double click) reuse the same order.
3. **Return URL** (`/api/payment/return`, GET or POST): its parameters only identify the order.
   The HMAC-SHA256 signature is checked with the Response Key and recorded; an invalid one goes
   to the audit trail. Then the **Order Status API** decides. The answer is a 200 page that opens
   `/pay/?order=…` (the docs ask for no redirect).
4. **Webhook** (`/api/payment/webhook`): `Authorization: Basic` must equal the dashboard's
   username:password (constant-time compare). The event is de-duplicated by its `id`, and the
   order is then verified with the Order Status API. The body is never trusted.
5. **Reconcile**, the only place an order changes status:
   - The answer's `order_id`, `amount` and `currency` must equal the stored order. Otherwise the
     order is set to `unknown`, nothing is activated, and the mismatch is audited.
   - Status mapping: `CHARGED` → paid. `AUTHENTICATION_FAILED`, `AUTHORIZATION_FAILED`,
     `JUSPAY_DECLINED` → failed. `PENDING_VBV`, `AUTHORIZING`, `STARTED` → pending. `NEW` → cancelled
     once the customer is back, or expired after the link's expiry. `AUTO_REFUNDED` → refunded.
     Anything else → unknown.
   - The order row is locked. A **paid order never goes back**, whatever arrives late or out of
     order. The subscription period is added **once** per order (`activated_at`) and an invoice is
     issued. The receipt is emailed after the database commit.
6. **Result page** (`/pay/?order=…`): polls `{action:"status", order:<pass>}` on HDFC's recommended
   schedule (every 15 s for 90 s, then 2, 5, 10, 20 and 60 minutes). It shows paid, failed (with
   the bank's reason and **Try again**), pending, cancelled, expired or refunded. Retry makes a
   **new** order; an order id is never paid twice.
7. **Account**: once paid, the customer chooses a password. It signs them in to WAREXX for the
   paid period. Every session check (`/api/trial verify`) asks the billing database on the
   server, so an expired, cancelled or refunded subscription is refused there, not just behind an
   overlay.

Payments are **one-time**. Each period is paid explicitly: a renewal starts when the running
period ends, or from today if it has already ended. HDFC's recurring mandates are a separate
product that the bank must enable; they are not used.

## Routes

| Route | Who | Purpose |
|---|---|---|
| `POST /api/subscribe` `config` | anyone | plans with GST and total, whether paying works, sandbox or production (no setting values) |
| `POST /api/subscribe` `checkout` | anyone (an existing account needs its signed-in session) | order + HDFC session → payment link + order pass |
| `POST /api/subscribe` `status` | the order pass's holder | the order's status (verified with HDFC while pending) |
| `POST /api/subscribe` `retry` | the order pass's holder | a new order after failed / cancelled / expired |
| `POST /api/subscribe` `account` | the order pass's holder, once paid | the customer's password → signed in |
| `POST /api/subscribe` `billing` | the customer's own session | their subscription and payments |
| `POST /api/subscribe` `account_info`, `update_details`, `change_password`, `cancel_subscription`, `resume_subscription`, `receipt` | the customer's own session | WAREXX → My profile → **Subscription & billing** (below) |
| `GET/POST /api/payment/return` | HDFC (customer's browser) | the return URL |
| `POST /api/payment/webhook` | HDFC servers (Basic auth) | webhooks |
| `POST /api/admin` `payments`, `payment_check`, `payment_refund` | the admin password | the team's list, "Check with HDFC", refunds |

There is no customer refund endpoint. `/api/subscribe` accepts JSON only (a cross-site form
cannot post it). Checkout is limited to 20 an hour per address and 10 per email; status lookups
to 600 an hour per address.

## In WAREXX: My profile → Subscription & billing

A signed-in customer opens it from the user menu (**Subscription & billing**) or from **My profile**.
The panel is `frontend/demo/account.jsx`. The WAREXX app renders it through `window.WAREXX_ACCOUNT_PANEL`;
without that, nothing changes in the production app. Re-apply this hook after `npm run sync:app`.

- **Subscription:** plan, status, paid-until, current period, workspace, account email.
  - **Renew early** and **Switch to Annual/Monthly** go to `/pay`; the new period starts when the current one ends.
- **Cancel subscription:** asks for confirmation and an optional reason.
  - Access continues to the end of the paid period, then the subscription ends (`cancelled`, no grace period).
  - Nothing is refunded automatically (Refund & Cancellation Policy), and an email confirms it to the customer and the team.
  - **Keep my subscription** undoes it before the period ends; paying for another period also undoes it.
- **Billing details:** used on the next payment and receipt; past receipts don't change.
- **Payments & receipts:** every order, with a printable receipt (Print / save as PDF).
- **Sign-in password:** change it, with the current one.
- **Sign out of WAREXX.**
- **Free-trial users and the plain demo** see their trial's end and a Subscribe button instead.

Each action is answered for the session's own customer only, and cancel, resume, details and
password changes go into the audit trail.

## The billing database

A database of its own: `BILLING_DATABASE_URL` (PostgreSQL), separate from the leads database and
from the WAREXX software's data. Without it, on a developer's machine only, the fallback is a
SQLite file `lead-api/data/billing.db`. A Vercel deployment refuses to take payments without
`BILLING_DATABASE_URL`.

| Table | Holds |
|---|---|
| `billing_plans` | monthly / annual: interval, price (NUMERIC 12,2), currency; synced from `payments.PLANS` |
| `billing_customers` | email (unique), HDFC customer id (unique), **workspace slug (unique)**, billing details, password hash |
| `billing_subscriptions` | one per customer: status (`trial, active, payment_pending, payment_failed, grace, restricted, suspended, cancelled, expired`), period, grace |
| `billing_orders` | every attempt: server amounts (list price, GST %, GST, total, amount charged), status, HDFC's references (order id, status, txn id, method), refunded amount, period added |
| `billing_invoices` | one per paid order: `WX-YYYYMM-<order id>`, amounts, GSTIN, bill-to |
| `billing_refunds` | `unique_request_id` (unique, kept **before** HDFC is asked), amount, status |
| `billing_gateway_events` | session / return / webhook / status / refund records, redacted (no card block, payer VPA, client token or contact details); webhooks unique by event id |
| `billing_audit` | who did what: order created, activated, mismatches, refunds, invalid signatures |

**Migrations** are versioned in `billing_schema_migrations` and run automatically on first use,
once, under a PostgreSQL advisory lock. They only add; nothing is ever dropped or rewritten. To
create the tables ahead of time:

```bash
python -c "import sys; sys.path.insert(0, 'lead-api'); import billing; billing.read('SELECT 1')"
```

## Settings (server-side only; never `VITE_*`)

| Name | Required | Notes |
|---|---|---|
| `HDFC_ENV` | yes | `sandbox` or `production` |
| `HDFC_MERCHANT_ID` | yes | from the bank |
| `HDFC_API_KEY` | yes | dashboard → Settings → Security → API Keys |
| `HDFC_RESPONSE_KEY` | yes | the Response Key (return-URL signatures; also switch on "Use signed response") |
| `HDFC_PAYMENT_PAGE_CLIENT_ID` | yes | sandbox `hdfcmaster`; production: the Merchant ID |
| `HDFC_RETURN_URL` | yes | `https://<site>/api/payment/return` (https, no query, no IP) |
| `HDFC_WEBHOOK_USERNAME`, `HDFC_WEBHOOK_PASSWORD` | production | as set on the dashboard's webhook tab |
| `HDFC_BASE_URL` | no | if set, must be the documented URL for `HDFC_ENV` |
| `HDFC_RESELLER_ID` | no | default `hdfc_reseller` (the documented value) |
| `HDFC_TIMEOUT_SECONDS` | no | default 20 |
| `BILLING_DATABASE_URL` | yes (hosted) | PostgreSQL for billing |
| `BILLING_GST_PERCENT` | yes | `18` (decided 2026-10-14) |
| `BILLING_SANDBOX_AMOUNT` | no | what a **sandbox** order charges, ₹1.00–₹499.99 (default 1.00); production always charges the real total |
| `BILLING_GRACE_DAYS` | no | access after a period ends, default 0 |
| `DEMO_TRIAL_SECRET` | yes | signs order passes and sessions |

The server checks these at start-up and prints the missing **names** (`[lead api] payments: OFF —
missing …`). Checkout then answers 503 `payments_not_configured`, and `/pay` shows "Online payment
isn't available right now". Nothing is faked.

## Local setup and tests

```bash
run_local.bat --no-tunnel
```

Put the sandbox values from the bank's `config.json` into `.env` (git-ignored), along with
`HDFC_RETURN_URL=http://localhost:8030/api/payment/return` (allowed in the sandbox only) and
`BILLING_DATABASE_URL`.

```bash
python lead-api/payments_test.py
```

The automated suite covers every case listed at the top of the file, against a fake gateway, on SQLite, or on
PostgreSQL with `BILLING_DATABASE_URL=…/warexx_billing_test`. The other suites
(`store_test`, `credentials_test`, `trial_flow_test`, `trial_test`) still pass.

**Sandbox test (2026-10-14), real HDFC UAT, merchant SG6386.** Subscribe → `/pay` → HDFC's page →
published test card VISA 4012 0000 0000 1097 → simulator → back to `/api/payment/return`:

- **Signature:** the return's HMAC signature verified with the Response Key.
- **Order Status API:** reported `CHARGED`, ₹1.00, card, VISA.
- **Billing:** order paid, Monthly subscription active for one month, receipt issued and emailed;
  the result page showed the confirmation and the account form.
- **Outcome rule:** the sandbox decides outcomes by amount (under ₹500 succeeds, ₹500–699 fails,
  ₹700+ pending), so a ₹1 order always succeeds. The failure, pending and cancel paths were
  verified with the automated suite.
- **Refunds:** the Refund Order API answered `401 access_denied` for this merchant's key, so
  refunds need enabling by HDFC (see below). The refund was recorded as an error and nothing was
  marked refunded.

## Going to production

1. **HDFC (bank / dashboard):**
   - production Merchant ID and API key (new key for production)
   - Response Key, and **Use signed response = Yes** (Settings → General)
   - **Return URL** `https://<domain>/api/payment/return`, on the dashboard as well as in the
     session (no query parameters)
   - **Webhook URL** `https://<domain>/api/payment/webhook`, with username and password; enable
     the order and refund events
   - **refunds enabled** for the API key (the sandbox key answers `access_denied` today)
   - supported currencies (INR only is used)
   - recurring mandates only if renewals should be automatic later
2. **Vercel environment (Production):**
   - all settings above, with `HDFC_ENV=production`
   - `BILLING_DATABASE_URL`: a managed PostgreSQL (Neon / Vercel Postgres), **separate** from the
     leads database
   - keep the sandbox values in the Preview environment only, never both in one environment
3. **HTTPS and domain:** the production domain must serve HTTPS (Vercel does). HDFC's webhooks
   come from the IP addresses listed on the webhooks page, and nothing here filters by IP.
4. **Deploy:** push → Vercel builds. The billing migrations run on the first request.
5. **First live payment:** make one small real purchase, check it with `POST /api/admin` (`payments`) and the HDFC
   dashboard, then refund it with `payment_refund`.

## Switching it on for the live site (Vercel, this repo)

The Vercel project that runs the API is `pragi1/warexx-demo-frontend` (https://warexx-demo-frontend.vercel.app).
The other two projects (`warexxdemo`, `warexx-demo`) serve the pages only, so `/api/*` answers 404 there.

1. **Databases:** in the Vercel dashboard, open the project, then **Storage → Create Database → Neon (Postgres)**.
   - Create `warexx-leads` and connect it to Production with the default prefix. This gives `POSTGRES_URL`, used by the leads.
   - Create `warexx-billing` and connect it with the custom prefix **`BILLING`**. This gives `BILLING_DATABASE_URL`, used by billing.
   - The tables create themselves on first use.
2. **Settings:** from the repo root, run these once, as you:

   ```bash
   npx vercel login
   npx vercel link
   node frontend/tools/vercel-env.mjs --domain warexx-demo-frontend.vercel.app
   ```

   The script copies the HDFC values and the GST rate from `.env`. It also makes new
   `DEMO_TRIAL_SECRET`, `ADMIN_PASSWORD` and webhook credentials, and sets
   `HDFC_RETURN_URL` for that domain. No value is printed. The admin and webhook values are
   written to `lead-api/data/live-settings.local.txt` (git-ignored).
3. **Redeploy:** run `npx vercel --prod`, or use Redeploy in the dashboard. Settings only apply to new deployments.
4. **HDFC dashboard** (UAT while `HDFC_ENV=sandbox`): Settings → Webhooks.
   - Set the URL, username and password from `live-settings.local.txt`, and enable the order and refund events.
   - The return URL is sent with every session, so it needs no dashboard change.
5. **Check:** `POST https://<domain>/api/subscribe {"action":"config"}` should answer `"enabled": true`.
   Then make one ₹1 sandbox payment from the pricing page.
6. **Real money:** get production credentials from HDFC, set `HDFC_ENV=production`, the production
   Merchant ID / API key / Response Key and `HDFC_PAYMENT_PAGE_CLIENT_ID=<Merchant ID>` in `.env`,
   run the script again and redeploy.
   - Emails are only sent live once `.env` has `LEAD_MAIL_BACKEND=smtp` and a real mailbox; the
     script copies those too.

## Operations

- **Reconciliation:**
  - Daily: compare `POST /api/admin` `payments` (or `billing_orders`) with HDFC's settlement report.
  - Orders in `pending` or `unknown`: use `POST /api/admin` `payment_check`.
  - `unknown` with reason `mismatch`: investigate before activating anything by hand.
- **Logs** carry order references and statuses only. They never contain keys, passwords, card
  data or customer contact details.
- **Rotating credentials:**
  - API key: create a new one on the dashboard, set it in Vercel, redeploy, check one status
    call, then delete the old key.
  - Response Key: change it on the dashboard and in Vercel together; returns in between fail
    the signature but are still verified by the status API.
  - Webhook password: change both, then watch the dashboard's "Webhook Notified" column.
  - `DEMO_TRIAL_SECRET`: rotating it signs every customer out and voids order passes; paid orders
    are unaffected.
- **Rollback:**
  - Revert the deployment in Vercel, or remove the `HDFC_*` variables; checkout then answers
    `payments_not_configured`.
  - The billing database is never touched by a rollback. Migrations only add, so an older
    release keeps working with a newer schema.
  - Orders paid meanwhile stay in `billing_orders`, and HDFC still holds them.

## Known gaps (for the team)

- **Workspace provisioning:** a paid customer gets the WAREXX app with a sample business plus a
  "your workspace is being set up" note. Their own tenant (`billing_customers.tenant_slug`) is
  set up by the team, as the "subscription paid" email says. Connecting this to the production
  app's tenants is a separate piece of work.
- **Invoice numbers** (`WX-YYYYMM-<id>`) are payment receipts. Whether they serve as GST tax
  invoices is a decision for your accountant.
- **Statuses `restricted` / `suspended`** exist in the model but nothing sets them yet. They are
  meant for a person or a later policy.
- **No automatic renewal reminders.** Customers renew from `/pay` while signed in.
