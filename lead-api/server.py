"""The landing site's lead API as a small stand-alone server — for local
development, and for any host that can run a Python process (a VM, a container,
Render, Railway...). On Vercel the same code runs as ../api/leads.py instead.

    python lead-api/server.py                 (http://127.0.0.1:8003/api/leads)
    LEAD_API_PORT=9000 LEAD_API_HOST=0.0.0.0 python lead-api/server.py

Standard library only — nothing to install. Settings: see lead_mail.py, read
from the environment and, for anything not set there, from ../.env.
"""
import os
import secrets
import sys
from http.server import ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))


def load_env(path=os.path.join(HERE, "..", ".env")):
    """KEY=VALUE lines from the local .env (never committed); the environment wins."""
    if not os.path.exists(path):
        return
    with open(path, encoding="utf-8-sig") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            k, v = k.strip(), v.strip()
            if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
                v = v[1:-1]
            if k and v and k not in os.environ:
                os.environ[k] = v


def trial_secret():
    """Demo sign-up passes need a signing secret. Locally one is made once and
    kept in lead-api/data/ (git-ignored), so the links in emails already sent keep
    working after a restart; a deployment sets DEMO_TRIAL_SECRET itself."""
    if os.environ.get("DEMO_TRIAL_SECRET"):
        return
    path = os.path.join(HERE, "data", "trial-secret.local")
    try:
        with open(path, encoding="utf-8") as f:
            s = f.read().strip()
    except OSError:
        s = ""
    if len(s) < 32:
        s = secrets.token_urlsafe(48)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            f.write(s)
        print("[lead api] made a local DEMO_TRIAL_SECRET (lead-api/data/trial-secret.local)", flush=True)
    os.environ["DEMO_TRIAL_SECRET"] = s


load_env()
trial_secret()
sys.path.insert(0, HERE)
from http_handler import LeadHandler  # noqa: E402  (after the settings: modules read them on import)
import accounts  # noqa: E402
import lead_mail  # noqa: E402
import oms  # noqa: E402
import payments  # noqa: E402
import store  # noqa: E402
import trial  # noqa: E402


def main():
    host = os.environ.get("LEAD_API_HOST", "127.0.0.1")
    port = int(os.environ.get("LEAD_API_PORT", "8003"))
    srv = ThreadingHTTPServer((host, port), LeadHandler)
    where = "SMTP " + lead_mail.SMTP_HOST if lead_mail.MAIL_BACKEND == "smtp" else "saved to " + lead_mail.MAIL_DIR
    print(f"[lead api] http://{host}:{port}/api/leads  (mail: {where})", flush=True)
    print("[lead api] orders (OMS): " + (("PostgreSQL" if oms.database_url() else oms._sqlite_path()) if accounts.live()
                                         else "OFF, the demo answers from sample data (set ACCOUNTS_SECRET)"), flush=True)
    print(f"[lead api] database: {store.kind()}"
          + ("" if store.database_url() else f" ({store._sqlite_path()})")
          + ("; trial emails carry a login password" if trial.credentials_on() else ""), flush=True)
    # payments (HDFC SmartGateway): checked at start-up; names only, never values
    gaps = payments.missing()
    print("[lead api] payments: " + (f"HDFC SmartGateway {payments.hdfc._env('HDFC_ENV')}, billing database "
                                    + payments.billing.kind() if not gaps else "OFF — missing " + ", ".join(gaps)), flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
