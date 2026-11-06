# WAREXX: public website + interactive demo

Two static sites built from one project. Neither one needs the production
software (`../app`) to be running or deployed, and neither one can reach it.

| | Landing page | Interactive demo |
|---|---|---|
| Address | `https://warexx.aavoraa.com` | `https://demo.warexx.aavoraa.com` |
| Source | `frontend/landing/index.html` | `frontend/demo/`, running `frontend/vendor/warexx-app` |
| Data | none | `demo-data/recorded/` (one fictional business) |
| Server | `api/leads.py` (lead form emails), nothing else | none |
| Auth | none | none: every visitor is the demo's "Sample Admin" |

```
landing-demo/
├── frontend/
│   ├── landing/index.html     the marketing page (hero, product story, features,
│   │                          industries, film, live demo, pricing, testimonials,
│   │                          FAQ, brochure, contact / book a demo)
│   ├── demo/                  index.html + main.jsx (start-up), demo.css,
│   │   └── public/            sw.js (the demo's stand-in server), m/demo-boot.js,
│   │                          _headers / _redirects (Netlify, Cloudflare Pages)
│   ├── vendor/warexx-app/     snapshot of app/frontend/src + app/backend/app/mobile
│   ├── tools/
│   │   ├── landing.mjs        landing build + dev server
│   │   ├── mobile-page.mjs    the phone app (/m) for the demo
│   │   ├── sync-app.mjs       refresh vendor/warexx-app from ../app
│   │   ├── isolation_test.mjs npm test
│   │   └── demo_browser_test.mjs  headless-browser test of a running demo
│   ├── vite.demo.config.js
│   ├── vercel.json            ← the DEMO site's Vercel config (project root: landing-demo/frontend)
│   └── package.json
├── demo-data/
│   ├── recorded/              manifest.json + bodies/ (what the demo shows)
│   └── tools/                 seeders + recorder (need ../app/backend; authoring only)
├── lead-api/                  lead_mail.py, http_handler.py, server.py (stdlib Python)
├── api/leads.py               the lead API as a Vercel function
├── vercel.json                ← the LANDING site's Vercel config (project root: landing-demo)
├── run_landing.bat / run_demo_static.bat
├── .env.example
└── package.json               shortcuts (npm run dev, build, test…)
```

## Develop

```bash
cd landing-demo/frontend && npm ci
```

| Command (in `frontend/`) | What |
|---|---|
| `npm run dev:landing` | landing page on http://localhost:5174; forms go to the lead API on :8003 |
| `python ../lead-api/server.py` | the lead API on http://127.0.0.1:8003 (emails saved to `lead-api/outbox/*.eml` unless `LEAD_MAIL_BACKEND=smtp`) |
| `npm run dev:demo` | demo on http://localhost:8002 |
| `npm run build` | `dist/landing/` and `dist/demo/` |
| `npm run build:landing` / `npm run build:demo` | one of them |
| `npm run preview:demo` | serve `dist/demo` on :8002 |
| `npm run build:site` / `npm run preview:site` | landing page + demo as one site (`/` and `/demo/`) → `dist/site`, served on :8030 |
| `npm test` | isolation + data + secrets checks on the builds |
| `node tools/demo_browser_test.mjs http://localhost:8002/` | the demo in headless Edge/Chrome (`PROD_URL=…` also proves production is unreachable) |

On Windows, `run_landing.bat` starts the landing page and its lead API, and
`run_demo_static.bat` builds and serves the demo.

The landing page is shipped exactly as written. `tools/landing.mjs` only fills
in three addresses and adds a Content-Security-Policy; it is not run through
Vite. The demo build is Vite.

## Environment variables

See [.env.example](.env.example). Two kinds, kept apart:

- **`VITE_*` are public**: written into the pages at build time, readable by anyone.
  Addresses only: `VITE_LEAD_ENDPOINT`, `VITE_DEMO_URL`, `VITE_APP_URL`,
  `VITE_LANDING_URL`. Unset, they default to localhost in development and the
  `*.warexx.aavoraa.com` addresses in a build. **Never put a secret in a `VITE_*` variable.**
- **`LEAD_*` are server-side**: the lead API's mail settings (SMTP host, user,
  password, from/to). Set them on the host running `api/leads.py` /
  `lead-api/server.py`. They are never part of a build.

- **`POSTGRES_URL` / `ADMIN_PASSWORD` are server-side**: the leads database and
  the admin API's password (see [Leads database and admin](#leads-database-and-admin)).

The demo has no database. Nothing here knows the production database URL,
auth secret, or any API key, and nothing should.

## Run it on this computer (emails with login details)

`run_local.bat` (or `node frontend/tools/run-local.mjs`) runs the whole
website here, online through a free Cloudflare Tunnel:

- the landing page and the demo, with the **leads database on this
  computer** (`lead-api/data/leads.db`);
- every free trial is **emailed the demo link, the login email and a temporary
  password** (`DEMO_EMAIL_PASSWORD=1`): only the password's hash is kept, it
  works only during the trial, and "Send a new password" replaces it. The
  visitor signs in with them on any device;
- emails go out through the mailbox in `.env` (Gmail: an App Password, see
  `.env.example`); without it they are saved in `lead-api/outbox`.

Once: `winget install --id Cloudflare.cloudflared`, then copy `.env.example`
to `.env` and fill in the Gmail lines. The window prints the public address
(`https://<random>.trycloudflare.com`); it changes on every start, so use a
named tunnel (`CLOUDFLARE_TUNNEL_TOKEN` + `DEMO_PUBLIC_URL`) for a fixed one.
Visitors can only reach the site while this computer and the window are on.
`--no-tunnel` runs it for this computer only. Test:
`python lead-api/credentials_test.py`.

## Subscriptions (HDFC SmartGateway)

**Subscribe** on the pricing cards opens `/pay`. The customer enters billing details, accepts
the terms and pays on HDFC Bank SmartGateway's own page. The server confirms the payment with
HDFC's Order Status API, then activates the subscription and emails a receipt. The team sees
orders and issues refunds through `POST /api/admin`. Settings, the flow, the billing
database, tests and go-live steps: [docs/PAYMENTS.md](docs/PAYMENTS.md).
Test: `python lead-api/payments_test.py`.

## Order Management (OMS)

Under **Orders → Order Management** in the app: a dashboard, an order inbox, fulfilment
(allocate, pick, pack, ship), customer returns and reports. Screens:
`frontend/vendor/warexx-app/src/OMS.jsx`. Who gets which:

| | Sample orders | Real API |
|---|---|---|
| Who | a demo visitor; or `ACCOUNTS_SECRET` not set | staff signed in at `?staff=1` |
| Answered by | the demo's worker, `sw.js` | `lead-api/oms.py` |
| Data | `demo-data/recorded/bodies/oms-seed.json` (`demo-data/tools/seed_oms.mjs`) | its own database: `OMS_DATABASE_URL` (PostgreSQL), or `lead-api/data/oms.db` locally |
| Changes | gone on reload | kept |
| Sign-in | none | a staff account |

`run_local.bat` starts with the sample business in an empty database and one Super Admin, `owner`,
whose one-time password is in `lead-api/data/superadmin-password.local.txt`. With `--no-tunnel` the site
listens on this computer only and the demo's own Sample Admin also reaches the real orders with no
sign-in (`OMS_OPEN_LOCAL=1`); that never applies online.

### Staff accounts

`lead-api/accounts.py`, in the OMS database, behind the app's own login page and **Users & Access**
screen. Staff open `/demo/?staff=1` (`?staff=0` goes back to the demo); public visitors never see a
sign-in and never reach real data.

| Role | Orders and fulfilment | Refunds, exchanges | All warehouses | Accounts |
|---|---|---|---|---|
| Super Admin | yes | yes | always | yes |
| Admin | yes | yes | unless narrowed | no |
| User | yes | no | unless narrowed | no |

**Access** on Users & Access narrows an account to some warehouses and screens; for orders the server
enforces this, for other screens (still sample data) it only hides them. Sign-ins last 12 hours. Five
wrong passwords lock an account for 15 minutes. A password set by someone else must be changed at the
next sign-in; deactivating or resetting an account ends its sessions at once. Changes are recorded in
the `staff_audit` table.

Setting up a deployment: set `ACCOUNTS_SECRET` and `OMS_DATABASE_URL`, redeploy, then make the first
Super Admin from your computer against that database (it prints a one-time password):

```bash
python lead-api/accounts_admin.py --username owner --full-name "Your Name"
```

Filling the database (`OMS_DATABASE_URL` set, or the local file):

```bash
python lead-api/oms_load.py --sample             # the sample business; only into an empty database
python lead-api/oms_load.py --products file.csv  # warehouse_code,warehouse_name,sku,name,description,mrp,price,stock
```

On Vercel: create a database for it, set `OMS_DATABASE_URL` and `ACCOUNTS_SECRET`, redeploy, then
run the loader from your computer against that address. The tables are created on first use.

What the real API does not do yet: the rest of the app (the warehouse switcher, Inventory, and so
on) is still the recorded demo, so inside a warehouse the order screens match on its id. Sample ids
line up; warehouses loaded from your CSV show their orders at Central. OMS stock is its own and does
not move Inventory. Forgotten passwords need a Super Admin to reset them (no email reset). Refunds
are records (no gateway), and channels (website, marketplace) do not feed orders in automatically.

Tests: `python lead-api/oms_test.py`, `python lead-api/accounts_test.py`; `node tools/oms_browser_test.mjs`
against `npm run preview:demo`. A staff session in a browser, on a scratch database: run the API with
`ACCOUNTS_SECRET`, preview with `OMS_API_URL=http://127.0.0.1:8003`, make a Super Admin, then
`OMS_STAFF_USER=<name> OMS_STAFF_PASSWORD=<one-time> node tools/oms_browser_test.mjs`.

Note `npm run sync:app` replaces `vendor/warexx-app` wholesale, which would remove these screens
along with HR's and Finance's unless they are in the source it copies from.

## Who gets which email

| Event | To |
|---|---|
| Demo booked (a time slot) | the visitor: demo link, login email and **password**; **marketing@aavoraa.com, tech@aavoraa.com**: the request (never the password) |
| Payment confirmed | the customer: receipt; **accounts@aavoraa.com**: the payment details |
| Subscription cancelled | the customer: confirmation; **accounts@aavoraa.com** |
| Other landing forms | the visitor: thank-you; `LEAD_NOTIFY_TO` |

Change the team addresses with `LEAD_DEMO_NOTIFY_TO` / `LEAD_ACCOUNTS_TO` (comma-separated).

## The demo video

After signing in with the emailed password, the visitor chooses **Watch demo video** or
**Access demo trial**. To add the video, either:

- set `VITE_DEMO_VIDEO_URL` (a YouTube or Vimeo link, or a video file's address) on Vercel and redeploy, or
- put the file at `frontend/demo/public/demo-video.mp4` and push.

Until then, the video panel says "coming soon" and offers the trial.

## Leads database and admin

Every form sent from the landing page (contact, demo, brochure, plan enquiry…)
and every free-trial user is kept in a database: who they are, which form,
whether the access email went out, when they signed up and last signed in, and
whether they finished or skipped the product tour. Read it through **`POST /api/admin`**:
sign in with `ADMIN_PASSWORD`, then search, filter, page through and export CSV.
There is no admin web page.

- **On Vercel**: Project → **Storage** → **Create Database** → **Neon**
  (Postgres), connect it to this project (it sets `POSTGRES_URL`), add
  **`ADMIN_PASSWORD`** under Environment Variables, and redeploy. The tables
  are created on first use.
- **Locally** with no database address set: a SQLite file,
  `lead-api/data/leads.db` (git-ignored). Start the lead API with
  `ADMIN_PASSWORD` set to use `/api/admin` locally.

A database that is down or misconfigured never breaks a form, an email or the
demo: the write is skipped and logged. This is the website's own database, not
the WAREXX software's. `/api/admin` is rate-limited at sign-in, and its CSV defuses
spreadsheet formulas.

Code: `lead-api/store.py` (the database), `lead-api/admin.py` (`/api/admin`). Test: `python lead-api/store_test.py`
(SQLite; set `LEADS_DATABASE_URL` and install `requirements.txt` to run it on
Postgres).

## The demo

The demo is the WAREXX software's own UI (a snapshot in `vendor/warexx-app`)
with a service worker, `demo/public/sw.js`, standing in for the server. Every
request the UI makes to `/api` or `/pos` is answered by the worker from
`demo-data/recorded`:

- **Reads** come from the recording, made off the real backend running the
  sample business, so every screen agrees with every other.
- **Writes** (create PO, GRN, stock inward/outward, transfers…) are acknowledged
  so the screen behaves as if it saved, and discarded. Nothing leaves the browser.
  **Start over** in the banner, or a reload, resets the demo.
- **Ask WAREXX** answers from the recorded answers the real assistant gave over
  the same data, including differently worded questions ("Which products are
  low in stock?" matches the recorded "show low stock items"). Unrelated questions
  are told they are not part of the demo, with suggestions.
- **Sign-in** is answered by the worker: whatever is typed, the visitor is the
  demo's Sample Admin with the token `"demo"`.

Every demo page carries `Content-Security-Policy: connect-src 'self'`, so the
browser itself refuses a request to any other host, including the production API.

### Booked slots: sign-up and a two-hour window

On the one-domain site (`npm run build:site`) the demo is behind a sign-up:

1. The landing page's **contact** and **Book a demo** forms ask for a demo
   time slot: "Start now", or 10:00 / 12:00 / 15:00 / 17:00 IST over the next
   week.
2. Sending the form opens **/demo/** on its sign-up step. The email address
   from the form is already filled in, and the visitor chooses a password.
3. The demo opens for **two hours from the start of the slot**. A booking for
   later waits on a countdown and opens by itself.
4. When the two hours are over, a **subscribe** card covers the demo and the
   password no longer works.

The server (`lead-api/trial.py`, `api/trial.py` on Vercel) issues and checks
every pass against its own clock. The passes are signed with
`DEMO_TRIAL_SECRET`, so a visitor cannot extend their window. A visitor's
account lives in their browser (on another device they book again); the leads
database only records what happened, for the admin API. Set **`DEMO_TRIAL_SECRET`** in the Vercel project (see
`.env.example`). Until it is set, the forms send as before and the demo opens
without a sign-up.

Tests: `python lead-api/trial_test.py` and, against a running site with a
one-minute window (`DEMO_TRIAL_MINUTES=1`), `node tools/trial_browser_test.mjs`.

### Refreshing the app snapshot

`vendor/warexx-app` is a copy, so the demo cannot be broken by a change in
`app/`, and the snapshot always matches the recording. To bring in a newer UI:

```bash
npm run sync:app      # copies app/frontend/src and app/backend/app/mobile
```

Then re-record the data (below) if the new UI calls endpoints the recording
lacks, and `npm run build && npm test`.

### Rebuilding the demo data

See [demo-data/README.md](demo-data/README.md). In short:
`node demo-data/tools/build-data.mjs` seeds a scratch database with the
fictional business, serves it with the real backend from `../app/backend` on a
spare port (no vision key, nothing billed), records every screen into
`demo-data/recorded`, and scrubs it. It never touches a real database: each
seeder refuses to run unless its database is a SQLite file in a folder named
`demo-build`.

## Deploy

**One domain, landing page + demo (the default, no custom domain needed)**:
on Vercel, create one project with **Root Directory `landing-demo`** (or the
repository root, if `landing-demo` is its own repository). `vercel.json` runs
`npm run build:site` and serves:

| Address | What |
|---|---|
| `https://<project>.vercel.app/` | the landing page |
| `https://<project>.vercel.app/demo/` | the interactive demo ("Book a demo" opens it) |
| `https://<project>.vercel.app/api/leads` | the lead form's email function (`api/leads.py`) |

Set the `LEAD_*` variables in the project's environment settings. The demo's
service worker, dataset and phone app sit at `/sw.js`, `/data/` and `/m/`,
because the app calls `/api/...` from the root of the domain. The worker
leaves `/api/leads`, `/api/trial`, `/api/geo` and `/api/admin` alone, so they reach the real functions. Try it
locally with `npm run build:site && npm run preview:site` (http://localhost:8030,
with `python ../lead-api/server.py` running for the forms).

**Later, the demo on its own domain** (`demo.warexx.aavoraa.com`): add a
second Vercel project with **Root Directory `landing-demo/frontend`** (keep
"Include files outside the root directory" on, because the build reads
`../demo-data`). `frontend/vercel.json` builds `dist/demo` with the CSP and
service-worker headers. Then set `VITE_DEMO_URL=https://demo.warexx.aavoraa.com/`
on the landing project and redeploy it.

**Any other static host** (Netlify, Cloudflare Pages, S3 + CloudFront, nginx):
`npm ci && npm run build`, then publish `frontend/dist/landing` and
`frontend/dist/demo` as two sites. Both include `_headers` / `_redirects` for
Netlify and Cloudflare Pages. Rules for the demo:

1. Serve it at the **root of its own origin**: its service worker must answer `/api/…` and `/pos/…`.
2. Use **HTTPS** (or localhost): browsers only run service workers there.
3. Send the CSP header `connect-src 'self'; form-action 'self'; base-uri 'self'` (the pages also carry it as a meta tag).

Without Vercel, the lead form needs `lead-api/server.py` running somewhere
(stdlib only). Point `VITE_LEAD_ENDPOINT` at it and list the landing origin in
`LEAD_ALLOWED_ORIGINS`. Or leave `VITE_LEAD_ENDPOINT` empty to run with no
backend (forms show success and emit a `warexx:lead` browser event).

The Android and iOS **Demo** apps (in `../app`) bundle `frontend/dist/demo`: build
it first (`npm run build:demo`). The production (Live) apps do not use it.
