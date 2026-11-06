"""The lead API's HTTP handling, shared by the local server (server.py) and the
Vercel functions (../api/leads.py, ../api/trial.py). Two endpoints:

    POST /api/leads   a landing page form. With a demo slot it also answers a
                      sign-up pass for the demo (trial.py).
    POST /api/trial   the demo's sign-up / sign-in / session check (trial.py).
    POST /api/subscribe          the /pay page: plans, checkout, order status, retry,
                                 account, billing history (payments.py)
    GET|POST /api/payment/return HDFC SmartGateway sends the customer back here
    POST /api/payment/webhook    HDFC SmartGateway's webhooks (server to server)

Nothing here can reach WAREXX: no database driver is imported, no WAREXX URL or
credential is read. GET (except the payment return), PUT, PATCH and DELETE are refused.
"""
import html
import json
import os
import threading
import time
from collections import defaultdict, deque
from http.server import BaseHTTPRequestHandler
from urllib.parse import parse_qsl

import accounts
import admin
import lead_mail
import oms
import payments
import store
import trial

#: Sign-up / sign-in attempts per address per hour (a password guess costs one).
TRIAL_PER_HOUR = 30
_trial_recent = defaultdict(deque)
_trial_lock = threading.Lock()


#: A free-trial request answered in the last few minutes, by (email, slot): a
#: double-click or a retry gets the same trial back instead of a second pass
#: and a second email — and the email again only if the first one failed.
BOOKING_TTL = 10 * 60
_bookings = {}
_bookings_lock = threading.Lock()


def _booking(key, value=None):
    now = time.time()
    with _bookings_lock:
        for k in [k for k, (t, _) in _bookings.items() if now - t > BOOKING_TTL]:
            del _bookings[k]
        if value is not None:
            _bookings[key] = (now, value)
            return value
        hit = _bookings.get(key)
        return hit[1] if hit else None


def _trial_allowed(ip):
    now = time.time()
    with _trial_lock:
        q = _trial_recent[ip]
        while q and now - q[0] > 3600:
            q.popleft()
        if len(q) >= TRIAL_PER_HOUR:
            return False
        q.append(now)
        return True


class LeadHandler(BaseHTTPRequestHandler):
    #: Send the emails before answering (serverless: the process may be frozen
    #: the moment the answer is out) or after it, on a thread (a long-lived server).
    send_in_background = True
    #: The one path this handler answers; None = both (the local server).
    only = None

    def _answer(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        for k, v in lead_mail.cors_headers(self.headers.get("Origin")).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(data)

    def _route(self):
        p = self.path.split("?")[0].rstrip("/")
        if self.only:                      # a Vercel function: its file decides the path
            return self.only
        if p.startswith("/api/oms/"):
            return "oms"
        if p.startswith("/api/auth/") or p == "/api/users" or p.startswith("/api/users/"):
            return "accounts"
        return {"/api/leads": "leads", "/api/trial": "trial", "/api/admin": "admin", "/api/subscribe": "subscribe",
                "/api/payment/return": "payment_return", "/api/payment/webhook": "payment_webhook"}.get(p)

    def do_OPTIONS(self):
        self.send_response(204)
        for k, v in lead_mail.cors_headers(self.headers.get("Origin")).items():
            self.send_header(k, v)
        self.end_headers()

    def _body(self):
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length > lead_mail.MAX_BODY:
            return None
        return self.rfile.read(length) if length else b""

    def _hosts(self):
        """The host the visitor's request came to (a local preview passes it on
        as X-Forwarded-Host); used for the email's link in development only."""
        return [self.headers.get("X-Forwarded-Host") or "", self.headers.get("Host") or ""]

    def _ip(self):
        # behind a Cloudflare Tunnel (the local server put online, LEAD_TRUST_CF=1)
        # Cloudflare itself sets CF-Connecting-IP; anywhere else it is not trusted
        if os.environ.get("LEAD_TRUST_CF") == "1" and self.headers.get("CF-Connecting-IP"):
            return self.headers["CF-Connecting-IP"].strip()
        return (self.headers.get("X-Forwarded-For") or "").split(",")[0].strip() or self.client_address[0]

    def do_POST(self):
        route = self._route()
        if route is None:
            return self._answer(404, {"detail": "Not found"})
        raw = self._body()
        if raw is None:
            return self._answer(413, {"detail": "Too large"})
        if route == "oms":
            return self._oms(raw)
        if route == "accounts":
            return self._accounts(raw)
        if route == "trial":
            return self._trial(raw)
        if route == "admin":
            return self._admin(raw)
        if route == "subscribe":
            return self._subscribe(raw)
        if route == "payment_return":
            return self._payment_return(raw)
        if route == "payment_webhook":
            status, body = payments.webhook(self.headers.get("Authorization"), raw)
            return self._answer(status, body)
        try:
            lead = lead_mail.accept(raw, self._ip())
        except lead_mail.LeadError as e:
            body = {"detail": e.detail}
            if e.fields:
                body["fields"] = e.fields
            return self._answer(e.status, body)
        out = {"ok": True}
        # a demo slot booked with the form: the free trial — its sign-up pass,
        # then (only once the pass exists) the email with the access link
        if lead.get("slot") and lead["type"] in ("contact", "demo") and trial.configured():
            return self._answer(200, self._book_trial(lead))
        if lead.get("slot") and lead["type"] in ("contact", "demo"):
            out["trial_error"] = "trial_not_configured"
        store.record_lead(lead)                       # every form, kept (store.py)
        if self.send_in_background:
            threading.Thread(target=lead_mail.send_all, args=(lead,), daemon=True).start()
        else:
            lead_mail.send_all(lead)
        return self._answer(200, out)

    def _book_trial(self, lead):
        key = (lead["email"].lower(), lead["slot"])
        done = _booking(key)
        if done:
            out = dict(done["out"])
            if not out.get("email_sent") and done.get("access"):     # the first email failed: try again
                out["email_sent"] = lead_mail.send_trial(done["lead"], done["access"], done.get("password"))
                _booking(key, {**done, "out": out})
                store.trial_email(out["trial"]["ref"], out["email_sent"])
                store.log_email("trial", lead["email"], out["trial"]["ref"], out["email_sent"],
                                bool(done.get("password")), lead_mail.MAIL_BACKEND)
            return out
        try:
            t = trial.ticket(lead["email"], lead["slot"], name=lead["name"])
        except trial.TrialError as e:
            store.record_lead(lead)
            return {"ok": True, "trial_error": e.detail}
        lead["trial_window"], lead["trial_minutes"] = t["window"], t["minutes"]
        access = trial.access_url(t["ticket"], self._hosts())
        if not access:
            print("[lead api] no demo address for the trial email's link: set DEMO_PUBLIC_URL", flush=True)
        # emailed login details (DEMO_EMAIL_PASSWORD): the password's hash must be
        # in the database before the email goes — if it cannot be kept, the email
        # carries the sign-up link only (choose a password), which always works
        password = None
        if trial.credentials_on():
            pw = trial.new_password()
            if store.record_trial(t["ref"], lead, t["start"], t["end"], t["window"], False, pw=trial.password_record(pw)):
                password = pw
            else:
                print("[lead api] the database is unavailable: this trial email has no password", flush=True)
        sent = lead_mail.send_trial(lead, access, password) if access else False
        out = {"ok": True, "trial": {**t, "credentials": bool(password)}, "email_sent": sent}
        _booking(key, {"out": out, "lead": lead, "access": access, "password": password})
        # the trial and the form that asked for it, kept (store.py) — after the
        # email, and never in its way
        if password:
            store.trial_email(t["ref"], sent)
        else:
            store.record_trial(t["ref"], lead, t["start"], t["end"], t["window"], sent)
        store.record_lead(lead, trial_ref=t["ref"], email_sent=sent)
        store.log_email("trial", lead["email"], t["ref"], sent, bool(password), lead_mail.MAIL_BACKEND)
        if self.send_in_background:
            threading.Thread(target=lead_mail.send_notify, args=(lead,), daemon=True).start()
        else:
            lead_mail.send_notify(lead)
        return out

    def _resend(self, ticket_token):
        """The free-trial email again, for whoever holds the trial's pass."""
        try:
            d = trial.resend_details(ticket_token)
        except trial.TrialError as e:
            return self._answer(e.status, {"detail": e.detail})
        if not lead_mail._allowed("email:" + d["email"]):
            return self._answer(429, {"detail": "too_many_attempts"})
        access = trial.access_url(ticket_token, self._hosts())
        lead = {"name": d["name"], "email": d["email"], "trial_window": d["window"], "trial_minutes": d["minutes"]}
        # emailed login details: a new password (only its hash is kept, so the old
        # one cannot be sent again); it replaces the old one
        password = None
        if trial.credentials_on() and access:
            pw = trial.new_password()
            if store.trial_password(d.get("ref"), trial.password_record(pw)):
                password = pw
        sent = lead_mail.send_trial(lead, access, password) if access else False
        store.trial_email(d.get("ref"), sent)
        store.log_email("resend", d["email"], d.get("ref"), sent, bool(password), lead_mail.MAIL_BACKEND)
        return self._answer(200, {"ok": True, "email_sent": sent})

    def _trial(self, raw):
        if not _trial_allowed(self._ip()):
            return self._answer(429, {"detail": "too_many_attempts"})
        try:
            data = json.loads(raw.decode("utf-8") or "{}")
        except (ValueError, UnicodeDecodeError):
            data = None
        if isinstance(data, dict) and data.get("action") == "resend":
            return self._resend(data.get("ticket"))
        try:
            if isinstance(data, dict) and data.get("action") == "signin":
                result = self._signin(data)
            else:
                result = trial.handle(raw)
        except trial.TrialError as e:
            return self._answer(e.status, {"detail": e.detail, **e.extra})
        # what happened to the trial, kept against it (store.py)
        action, ref = (data or {}).get("action"), result.get("ref")
        if ref and ref.startswith("cust:"):                  # a subscriber (payments.py), not a trial
            pass
        elif ref and action == "signin":                      # the emailed password: the first one signs up
            store.trial_signed_up(ref)
            store.trial_logged_in(ref)
        elif ref and action == "signup":
            store.trial_signed_up(ref)
        elif ref and action == "login":
            store.trial_logged_in(ref)
        elif ref and action == "tour":
            store.trial_tour(ref, result["state"])
        elif ref and action == "verify":
            result["tour_state"] = store.tour_state(ref)      # the tour, remembered for this user
        if result.get("subscriber") and action == "verify" and not payments.subscriber_access(result.get("email")):
            # a paying customer's session opens WAREXX only while the subscription is
            # active (or in grace) — checked here, on the server, every time
            return self._answer(403, {"detail": "expired"})
        if ref and ref.startswith("cust:") and action in ("signin", "login"):
            payments.subscriber_logged_in(ref)
        result.pop("ref", None)                               # internal; the browser does not need it
        return self._answer(200, result)

    def _signin(self, data):
        """Email + the emailed password (DEMO_EMAIL_PASSWORD), against the database."""
        if not trial.credentials_on():
            raise trial.TrialError(400, "bad_request")
        trial._secret()                                       # 503 when the trial is not set up
        try:
            rows = store.trial_logins(data.get("email"))
        except Exception as exc:                              # noqa: BLE001
            print(f"[lead api] sign-in: database unavailable: {type(exc).__name__}", flush=True)
            raise trial.TrialError(503, "database_unavailable")
        try:   # a paying customer's account (payments.py)
            rows = rows + payments.subscriber_logins(data.get("email"))
        except Exception as exc:                              # noqa: BLE001 — trials still sign in
            print(f"[lead api] sign-in: billing database unavailable: {type(exc).__name__}", flush=True)
        try:
            result = trial.signin(rows, data.get("email"), data.get("password"))
        except trial.TrialError as e:                         # kept: who tried, and why it failed
            store.log_signin(data.get("email"), None, False, e.detail)
            raise
        store.log_signin(data.get("email"), result.get("ref"), True)
        return result

    def _subscribe(self, raw):
        """The /pay page. JSON only (a cross-site form cannot send it)."""
        if "application/json" not in (self.headers.get("Content-Type") or ""):
            return self._answer(415, {"detail": "bad_request"})
        try:
            data = json.loads(raw.decode("utf-8") or "{}")
        except (ValueError, UnicodeDecodeError):
            data = None
        if not isinstance(data, dict):
            return self._answer(400, {"detail": "bad_request"})
        action = data.get("action")
        try:
            if action == "config":
                return self._answer(200, payments.public_config())
            if action == "checkout":
                return self._answer(200, payments.checkout(data, self._ip(), data.get("session")))
            if action == "status":
                return self._answer(200, payments.status(data.get("order"), self._ip()))
            if action == "retry":
                return self._answer(200, payments.retry(data.get("order"), self._ip()))
            if action == "account":
                if not _trial_allowed(self._ip()):
                    return self._answer(429, {"detail": "too_many_attempts"})
                result = payments.account(data.get("order"), data.get("password"))
                result.pop("ref", None)
                return self._answer(200, result)
            if action == "billing":
                return self._answer(200, payments.billing_history(data.get("session")))
            # the WAREXX app's profile section (demo/account.jsx)
            if action == "account_info":
                return self._answer(200, payments.account_info(data.get("session")))
            if action == "update_details":
                return self._answer(200, payments.update_details(data.get("session"), data))
            if action == "change_password":
                if not _trial_allowed(self._ip()):
                    return self._answer(429, {"detail": "too_many_attempts"})
                return self._answer(200, payments.change_password(data.get("session"), data.get("current"), data.get("password")))
            if action == "cancel_subscription":
                return self._answer(200, payments.cancel(data.get("session"), data.get("reason")))
            if action == "resume_subscription":
                return self._answer(200, payments.resume(data.get("session")))
            if action == "receipt":
                return self._answer(200, payments.receipt(data.get("session"), data.get("order_ref")))
            return self._answer(400, {"detail": "bad_request"})
        except payments.PaymentError as e:
            return self._answer(e.status, {"detail": e.detail, **e.extra})
        except trial.TrialError as e:
            return self._answer(e.status, {"detail": e.detail, **e.extra})
        except Exception as exc:                              # noqa: BLE001 — the database, most likely
            print(f"[payments] {action} failed: {type(exc).__name__}: {str(exc)[:160]}", flush=True)
            return self._answer(503, {"detail": "billing_unavailable"})

    def _payment_return(self, raw):
        """The customer back from HDFC's payment page. The order is checked with
        HDFC (payments.handle_return), then this page — a 200, not a redirect —
        opens the /pay result for it in the same tab."""
        query = self.path.split("?", 1)[1] if "?" in self.path else ""
        params = dict(parse_qsl(query, keep_blank_values=True))
        if raw:
            try:
                params.update(parse_qsl(raw.decode("utf-8"), keep_blank_values=True))
            except UnicodeDecodeError:
                pass
        try:
            ref = payments.handle_return(params)
        except Exception as exc:                              # noqa: BLE001 — the result page asks again
            print(f"[payments] return handling failed: {type(exc).__name__}: {str(exc)[:160]}", flush=True)
            ref = str(params.get("order_id") or "")
            ref = ref if payments._REF.match(ref) else None
        target = "/pay/?order=" + ref if ref else "/pay/"
        page = ("<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"robots\" content=\"noindex\">"
                "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>Confirming your payment — WAREXX</title>"
                "<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0E0F12;color:#F4F1EA;"
                "font:16px/1.5 system-ui,sans-serif}a{color:#EE7A1E}</style></head><body><main><p>Confirming your payment…</p>"
                f"<p><a href=\"{html.escape(target)}\">Continue</a></p></main>"
                f"<script>location.replace({json.dumps(target)})</script></body></html>").encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(page)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.end_headers()
        self.wfile.write(page)

    def _caller(self):
        return {"peer": self.client_address[0], "hosts": self._hosts(), "origin": self.headers.get("Origin") or ""}

    def _accounts(self, raw):
        try:
            return self._answer(200, accounts.handle(self.command, self.path, raw, token=self.headers.get("X-Essa-Token") or "",
                                                     ip=self._ip(), **self._caller()))
        except accounts.AccountError as e:
            return self._answer(e.status, {"detail": e.detail})
        except Exception as exc:                              # noqa: BLE001 — the database, most likely
            print(f"[accounts] failed: {type(exc).__name__}: {str(exc)[:160]}", flush=True)
            return self._answer(503, {"detail": "The account database is not available."})

    def _other_methods(self):
        if self._route() != "accounts":
            return self._refuse()
        raw = self._body()
        return self._answer(413, {"detail": "Too large"}) if raw is None else self._accounts(raw)

    def _oms(self, raw):
        try:
            path = self.path.split("?")[0].rstrip("/")
            if path == "/api/oms/health":
                return self._answer(200, accounts.status(**self._caller()))
            if not accounts.live():
                return self._answer(503, {"detail": "oms_off"})
            me = accounts.who(self.headers.get("X-Essa-Token") or "", **self._caller())
            if path == "/api/oms/session":
                return self._answer(200, {"live": True, "signed_in": bool(me)})
            return self._answer(200, oms.handle(self.command, self.path, raw, me, self.headers.get("X-Essa-Warehouse") or ""))
        except oms.OmsError as e:
            return self._answer(e.status, {"detail": e.detail})
        except Exception as exc:                              # noqa: BLE001 — the database, most likely
            print(f"[oms] failed: {type(exc).__name__}: {str(exc)[:160]}", flush=True)
            return self._answer(503, {"detail": "The order database is not available."})

    def do_GET(self):
        if self._route() == "oms":
            return self._oms(b"")
        if self._route() == "accounts":
            return self._accounts(b"")
        if self._route() == "payment_return":
            return self._payment_return(b"")
        return self._refuse()

    def _admin(self, raw):
        try:
            return self._answer(200, admin.handle(raw, ip=self._ip(),
                                                  token=(self.headers.get("Authorization") or "").replace("Bearer ", "")))
        except admin.AdminError as e:
            return self._answer(e.status, {"detail": e.detail})
        except Exception as exc:                              # noqa: BLE001 — the database, most likely
            print(f"[admin] failed: {type(exc).__name__}: {str(exc)[:160]}", flush=True)
            return self._answer(503, {"detail": "database_unavailable"})

    def _refuse(self):
        self._answer(405, {"detail": "Only POST"})

    do_PUT = do_PATCH = do_DELETE = _other_methods

    def log_message(self, fmt, *args):
        print("[lead api] " + (fmt % args), flush=True)
