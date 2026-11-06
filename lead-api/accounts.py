"""Staff accounts: /api/auth/* and /api/users*, the server behind the app's own login
page and its Users & Access screen. Who a request is, for this API and for oms.py.

Switched on by ACCOUNTS_SECRET (at least 32 characters; server-side only, never
VITE_*), which signs the session tokens. The accounts live in the OMS database.
Without it `status` says {"live": false} and the demo's worker (sw.js) answers the
same screens as it always has: every visitor is the demo's Sample Admin.

    superadmin   everything, and the only role that manages accounts
    admin        every warehouse (unless narrowed), refunds and exchanges
    user         orders and fulfilment; no refunds or exchanges

An account can be narrowed further from Users & Access: permissions.warehouses and
permissions.screens ({screen: [view, create, modify, delete, print]}); empty means
the role decides. A super admin is never narrowed.

Passwords are salted scrypt. A token names an account and its token_version and is
checked against the database on every request, so deactivating someone or changing a
password ends their sessions at once. A password someone else set (a new account, a
reset) must be changed at the next sign-in. Five wrong passwords lock an account for
15 minutes. The last active super admin cannot be removed, demoted or deactivated.

OMS_OPEN_LOCAL=1 treats a request from a person at this computer as a super admin,
for run-local.mjs --no-tunnel; see _local_request.
"""
import base64
import hashlib
import hmac
import json
import os
import re
import threading
import time
from collections import defaultdict, deque
from urllib.parse import urlsplit

import billing
import oms

HERE = os.path.dirname(os.path.abspath(__file__))
TOKEN_HOURS = 12
MIN_PASSWORD = 10
MAX_PASSWORD = 200
MAX_FAILS = 5
LOCK_MINUTES = 15
IP_LOGINS_PER_15_MIN = 30
SCRYPT = {"n": 2 ** 14, "r": 8, "p": 1, "maxmem": 64 * 1024 * 1024, "dklen": 32}
RANK = {"user": 1, "admin": 2, "superadmin": 3}
ROLE_LABEL = {"user": "User", "admin": "Admin", "superadmin": "Super Admin"}
_USERNAME = re.compile(r"^[a-z0-9][a-z0-9._@-]{2,63}$")
_COMMON = {"password12", "password123", "1234567890", "123456789012", "qwertyuiop", "administrator", "letmein1234", "warexx1234"}
PERMISSION_KEYS = ("screens", "data", "warehouses", "store")

_ips = defaultdict(deque)
_ip_lock = threading.Lock()


class AccountError(Exception):
    def __init__(self, status, detail):
        super().__init__(detail)
        self.status, self.detail = status, detail


# ---- on or off, and this computer ------------------------------------------------

def _secret():
    return (os.environ.get("ACCOUNTS_SECRET") or "").strip()


def live():
    return len(_secret()) >= 32


_LOOPBACK = {"127.0.0.1", "::1", "::ffff:127.0.0.1"}
_LOCAL_NAMES = {"localhost", "127.0.0.1", "[::1]"}


def _local_name(value):
    """A Host or Origin value naming this computer. An empty one names nothing."""
    host = str(value or "").split("://")[-1].split("/")[0].strip().lower()
    host = host.split("]")[0] + "]" if host.startswith("[") else host.split(":")[0]
    return host in _LOCAL_NAMES


def _local_request(peer, hosts, origin):
    """OMS_OPEN_LOCAL, and this request can only be from a person at this computer:
    not a deployment, not through a tunnel, on a server that listens only here, from
    a loopback socket, addressed to localhost (a page on another site, or a rebound
    DNS name, gives itself away in Host or Origin)."""
    if os.environ.get("OMS_OPEN_LOCAL") != "1" or billing.hosted() or os.environ.get("LEAD_TRUST_CF") == "1":
        return False
    if os.environ.get("LEAD_API_HOST", "127.0.0.1") not in _LOOPBACK or peer not in _LOOPBACK:
        return False
    given = [h for h in hosts if h]
    return bool(given) and all(_local_name(h) for h in given) and (not origin or _local_name(origin))


def status(peer="", hosts=(), origin=""):
    return {"live": live(), "open_local": live() and _local_request(peer, hosts, origin)}


# ---- passwords and tokens ----------------------------------------------------------

def _hash(password, salt):
    return hashlib.scrypt(password.encode(), salt=salt, **SCRYPT)


def hash_password(password):
    salt = os.urandom(16)
    return f"scrypt${salt.hex()}${_hash(password, salt).hex()}"


def check_password(password, stored):
    try:
        _, salt, digest = str(stored).split("$")
        return hmac.compare_digest(_hash(password, bytes.fromhex(salt)), bytes.fromhex(digest))
    except ValueError:
        return False


#: checked when the username does not exist, so a wrong name takes as long as a wrong password
_DUMMY = "scrypt$" + "00" * 16 + "$" + "00" * 32


def _check_policy(password, username=""):
    if not isinstance(password, str) or len(password) < MIN_PASSWORD:
        raise AccountError(422, f"A password needs at least {MIN_PASSWORD} characters.")
    if len(password) > MAX_PASSWORD:
        raise AccountError(422, f"A password can have at most {MAX_PASSWORD} characters.")
    low = password.lower()
    if low in _COMMON or (username and username.lower() in low):
        raise AccountError(422, "That password is too easy to guess.")


def _b64(b):
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def _mac(body):
    return _b64(hmac.new(hashlib.sha256(("warexx-accounts:" + _secret()).encode()).digest(), body.encode(), hashlib.sha256).digest())


def _token(row):
    body = _b64(json.dumps({"k": "staff", "u": row["id"], "v": row["token_version"], "x": int(time.time()) + TOKEN_HOURS * 3600}).encode())
    return body + "." + _mac(body)


def _read_token(token):
    """{u, v} from a token this server signed that has not expired; None otherwise."""
    try:
        body, mac = str(token or "").split(".", 1)
        if not hmac.compare_digest(mac, _mac(body)):
            return None
        p = json.loads(base64.urlsafe_b64decode(body + "=" * (-len(body) % 4)))
    except (ValueError, TypeError):
        return None
    return p if p.get("k") == "staff" and time.time() < p.get("x", 0) else None


# ---- who is asking ------------------------------------------------------------------

def _perms(row):
    v = oms._j(row["permissions"])
    return v if isinstance(v, dict) else {}


def _principal(row):
    return {"id": row["id"], "username": row["username"], "full_name": row["full_name"] or row["username"], "role": row["role"],
            "permissions": _perms(row), "must_change": bool(row["must_change"]), "local": False}


LOCAL = {"id": 0, "username": "local", "full_name": "Local Super Admin", "role": "superadmin", "permissions": {},
         "must_change": False, "local": True}


def _account(token):
    p = _read_token(token)
    if not p:
        return None
    with oms.tx() as t:
        row = t.one("SELECT * FROM staff_accounts WHERE id = %s", (p["u"],))
    return row if row and row["active"] and row["token_version"] == p["v"] else None


def who(token="", peer="", hosts=(), origin=""):
    """The person behind a request, or None. A valid sign-in is always its own person."""
    if not live():
        return None
    row = _account(token)
    if row:
        return _principal(row)
    return dict(LOCAL) if _local_request(peer, hosts, origin) else None


# ---- the records -------------------------------------------------------------------

def _audit(t, actor, action, target, detail=""):
    t.run("INSERT INTO staff_audit (at, actor, action, target, detail) VALUES (%s, %s, %s, %s, %s)",
          (oms._now(), actor, action, target, detail[:300]))


def _public(row, me=None):
    return {"id": row["id"], "username": row["username"], "role": row["role"], "role_label": ROLE_LABEL.get(row["role"], row["role"]),
            "full_name": row["full_name"] or "", "job_title": row["job_title"] or "", "email": row["email"] or "", "phone": row["phone"] or "",
            "active": bool(row["active"]), "last_login_at": row["last_login_at"], "created_at": row["created_at"],
            "created_by": row["created_by"] or "", "permissions": _perms(row), "must_change": bool(row["must_change"]),
            "manageable": me is None or me["role"] == "superadmin"}


def _session(row, token):
    return {"ok": True, "token": token, "user": row["username"], "role": row["role"], "role_label": ROLE_LABEL.get(row["role"], row["role"]),
            "full_name": row["full_name"] or row["username"], "permissions": _perms(row), "must_change": bool(row["must_change"]),
            "can": {"manage_users": row["role"] == "superadmin", "admin": RANK.get(row["role"], 0) >= RANK["admin"],
                    "command": row["role"] == "superadmin", "boss": False}}


def _active_superadmins(t):
    return t.one("SELECT COUNT(*) AS n FROM staff_accounts WHERE role = 'superadmin' AND active = %s", (True,))["n"]


def _clean_username(value):
    name = str(value or "").strip().lower()
    if not _USERNAME.match(name):
        raise AccountError(422, "A username needs 3 to 64 letters, digits or . _ @ - and must start with a letter or digit.")
    return name


def create(t, username, password, role="user", full_name="", created_by="system", must_change=True):
    """One account. The caller holds the transaction; the password is hashed here."""
    name = _clean_username(username)
    if role not in RANK:
        raise AccountError(422, "That is not a role.")
    _check_policy(password, name)
    if t.one("SELECT id FROM staff_accounts WHERE username = %s", (name,)):
        raise AccountError(409, f"There is already an account called {name}.")
    new_id = t.insert(
        """INSERT INTO staff_accounts (username, full_name, role, active, pw_hash, token_version, must_change, failed_count,
           permissions, created_by, created_at) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
        (name, oms._text(full_name, 200), role, True, hash_password(password), 1, must_change, 0, {}, created_by, oms._now()))
    _audit(t, created_by, "create", name, role)
    return t.one("SELECT * FROM staff_accounts WHERE id = %s", (new_id,))


def has_any():
    with oms.tx() as t:
        return bool(t.one("SELECT id FROM staff_accounts LIMIT 1"))


# ---- signing in ---------------------------------------------------------------------

def _ip_allowed(ip):
    now = time.time()
    with _ip_lock:
        q = _ips[ip]
        while q and now - q[0] > 900:
            q.popleft()
        if len(q) >= IP_LOGINS_PER_15_MIN:
            return False
        q.append(now)
        return True


def _login(body, ip):
    if not _ip_allowed(ip):
        raise AccountError(429, "Too many sign-in attempts. Wait a few minutes and try again.")
    name = str(body.get("username") or "").strip().lower()
    password = body.get("password")
    password = password[:MAX_PASSWORD + 1] if isinstance(password, str) else ""
    with oms.tx() as t:
        row = t.one("SELECT * FROM staff_accounts WHERE username = %s", (name,))
    # hashing stays outside the transaction, which would otherwise hold up every order
    right = check_password(password, row["pw_hash"] if row else _DUMMY)
    wrong = AccountError(401, "Wrong username or password.")
    if not row:
        raise wrong
    with oms.tx() as t:
        row = t.one("SELECT * FROM staff_accounts WHERE id = %s", (row["id"],))
        locked = row["locked_until"] and oms._when(row["locked_until"]) > billing.now()
        if not locked and not right:
            fails = int(row["failed_count"] or 0) + 1
            until = billing.iso(billing.now() + oms.dt.timedelta(minutes=LOCK_MINUTES)) if fails >= MAX_FAILS else None
            t.run("UPDATE staff_accounts SET failed_count = %s, locked_until = %s WHERE id = %s", (0 if until else fails, until, row["id"]))
            _audit(t, name, "signin_failed", name, "locked" if until else "")
        elif not locked and row["active"]:
            t.run("UPDATE staff_accounts SET failed_count = 0, locked_until = NULL, last_login_at = %s WHERE id = %s", (oms._now(), row["id"]))
            _audit(t, name, "signin", name)
            row = t.one("SELECT * FROM staff_accounts WHERE id = %s", (row["id"],))
            return _session(row, _token(row))
    # the same words for a locked or deactivated account: they say nothing to someone guessing
    raise wrong


def _change_own_password(me, body):
    if me["local"]:
        raise AccountError(403, "This computer's Super Admin has no password. Sign in with an account to change one.")
    new = body.get("new_password")
    with oms.tx() as t:
        row = t.one("SELECT * FROM staff_accounts WHERE id = %s", (me["id"],))
    _check_policy(new, row["username"])
    if not check_password(str(body.get("current_password") or "")[:MAX_PASSWORD + 1], row["pw_hash"]):
        raise AccountError(403, "That is not your current password.")
    if check_password(new, row["pw_hash"]):
        raise AccountError(422, "Choose a password different from the current one.")
    pw_hash = hash_password(new)
    with oms.tx() as t:
        t.run("UPDATE staff_accounts SET pw_hash = %s, must_change = %s, token_version = token_version + 1 WHERE id = %s", (pw_hash, False, me["id"]))
        _audit(t, me["username"], "password", me["username"])
        row = t.one("SELECT * FROM staff_accounts WHERE id = %s", (me["id"],))
    return {"ok": True, "token": _token(row)}


# ---- managing accounts --------------------------------------------------------------

def _catalog(t):
    with open(os.path.join(HERE, "access_catalog.json"), encoding="utf-8") as f:
        cat = json.load(f)
    cat["warehouses"] = t.all("SELECT id, name, code FROM oms_warehouses ORDER BY id")
    return cat


def _roles():
    return [{"value": k, "label": ROLE_LABEL[k]} for k in ("user", "admin", "superadmin")]


def _guard_last_superadmin(t, row, losing):
    if losing and row["role"] == "superadmin" and row["active"] and _active_superadmins(t) <= 1:
        raise AccountError(409, "This is the last Super Admin. Make another one first.")


def _users(method, parts, me, body):
    if me["role"] != "superadmin":
        raise AccountError(403, "Only a Super Admin can manage accounts.")
    if not parts:
        if method == "GET":
            with oms.tx() as t:
                rows = t.all("SELECT * FROM staff_accounts ORDER BY id")
                return {"users": [_public(r, me) for r in rows], "roles": _roles(), "all_roles": _roles(), "catalog": _catalog(t)}
        if method == "POST":
            password = body.get("password")
            _check_policy(password, str(body.get("username") or ""))
            with oms.tx() as t:
                row = create(t, body.get("username"), password, body.get("role") or "user", body.get("full_name") or "", me["username"])
                return _public(row, me)
    if parts == ["catalog"] and method == "GET":
        with oms.tx() as t:
            return _catalog(t)
    if not parts or not parts[0].isdigit():
        raise AccountError(404, "Not found")
    uid = int(parts[0])
    new_hash = None
    if parts[1:] == ["password"] and method == "POST":
        with oms.tx() as t:
            row = t.one("SELECT username FROM staff_accounts WHERE id = %s", (uid,))
        if not row:
            raise AccountError(404, "No such account.")
        _check_policy(body.get("new_password"), row["username"])
        new_hash = hash_password(body["new_password"])
    with oms.tx() as t:
        row = t.one("SELECT * FROM staff_accounts WHERE id = %s", (uid,))
        if not row:
            raise AccountError(404, "No such account.")
        mine = uid == me["id"]
        if len(parts) == 1 and method == "PATCH":
            fields = {}
            if "full_name" in body:
                fields["full_name"] = oms._text(body["full_name"], 200)
            if "role" in body:
                if body["role"] not in RANK:
                    raise AccountError(422, "That is not a role.")
                if mine and body["role"] != row["role"]:
                    raise AccountError(409, "You cannot change your own role.")
                _guard_last_superadmin(t, row, body["role"] != "superadmin")
                fields["role"] = body["role"]
            if "active" in body:
                active = body["active"] is True
                if mine and not active:
                    raise AccountError(409, "You cannot deactivate your own account.")
                _guard_last_superadmin(t, row, not active)
                fields["active"] = active
            for k, v in fields.items():
                # the names come from the fixed set above, never from the request
                t.run(f"UPDATE staff_accounts SET {k} = %s WHERE id = %s", (v, uid))
            if "role" in fields or fields.get("active") is False:
                t.run("UPDATE staff_accounts SET token_version = token_version + 1 WHERE id = %s", (uid,))
            _audit(t, me["username"], "update", row["username"], ", ".join(fields))
            return _public(t.one("SELECT * FROM staff_accounts WHERE id = %s", (uid,)), me)
        if parts[1:] == ["password"] and method == "POST":
            # theirs to replace at the next sign-in; if it is your own, this session ends too
            t.run("""UPDATE staff_accounts SET pw_hash = %s, must_change = %s, failed_count = 0, locked_until = NULL,
                     token_version = token_version + 1 WHERE id = %s""", (new_hash, True, uid))
            _audit(t, me["username"], "password_reset", row["username"])
            return {"ok": True}
        if parts[1:] == ["permissions"] and method == "PUT":
            clean = {k: body[k] for k in PERMISSION_KEYS if body.get(k)}
            if not isinstance(clean.get("screens", {}), dict) or not isinstance(clean.get("data", {}), (dict, list)):
                raise AccountError(422, "Those permissions are not in the right shape.")
            if "warehouses" in clean:
                if not isinstance(clean["warehouses"], list) or not all(str(w).isdigit() for w in clean["warehouses"]):
                    raise AccountError(422, "Those warehouses are not in the right shape.")
                clean["warehouses"] = [int(w) for w in clean["warehouses"]]
            if clean.get("store") == "admin":
                del clean["store"]
            t.run("UPDATE staff_accounts SET permissions = %s WHERE id = %s", (clean, uid))
            _audit(t, me["username"], "permissions", row["username"], json.dumps(clean)[:280])
            return _public(t.one("SELECT * FROM staff_accounts WHERE id = %s", (uid,)), me)
        if len(parts) == 1 and method == "DELETE":
            if mine:
                raise AccountError(409, "You cannot delete your own account.")
            _guard_last_superadmin(t, row, True)
            t.run("DELETE FROM staff_accounts WHERE id = %s", (uid,))
            _audit(t, me["username"], "delete", row["username"])
            return {"ok": True}
    raise AccountError(404, "Not found")


# ---- the requests -------------------------------------------------------------------

def handle(method, url_path, raw, token="", ip="", peer="", hosts=(), origin=""):
    if not live():
        raise AccountError(503, "Staff accounts are not switched on (ACCOUNTS_SECRET).")
    path = urlsplit(url_path).path.rstrip("/")
    try:
        body = json.loads(raw or b"{}")
    except (ValueError, UnicodeDecodeError):
        raise AccountError(400, "That was not valid JSON.") from None
    if not isinstance(body, dict):
        raise AccountError(400, "That was not valid JSON.")
    if path == "/api/auth/login" and method == "POST":
        return _login(body, ip)
    if path == "/api/auth/verify" and method == "GET":
        # the header, never the address: an address ends up in logs
        row = _account(token)
        return _session(row, token) if row else {"ok": False}
    if path == "/api/auth/logout" and method == "POST":
        # signs out everywhere: there is no list of sessions to remove just this one from
        row = _account(token)
        if row:
            with oms.tx() as t:
                t.run("UPDATE staff_accounts SET token_version = token_version + 1 WHERE id = %s", (row["id"],))
        return {"ok": True}
    me = who(token, peer, hosts, origin)
    if not me:
        raise AccountError(401, "Please sign in.")
    if path == "/api/auth/change-password" and method == "POST":
        return _change_own_password(me, body)
    if me["must_change"]:
        raise AccountError(403, "Change your password first.")
    if path in ("/api/auth/me", "/api/auth/profile") and method == "GET":
        if me["local"]:
            return {**{k: me[k] for k in ("id", "username", "full_name", "role", "permissions")}, "role_label": ROLE_LABEL["superadmin"], "active": True, "recent": []}
        with oms.tx() as t:
            row = t.one("SELECT * FROM staff_accounts WHERE id = %s", (me["id"],))
            recent = t.all("SELECT at, action, detail AS summary FROM staff_audit WHERE actor = %s ORDER BY id DESC LIMIT 8", (me["username"],))
        return {**_public(row), "recent": [{**r, "screen": "session", "outcome": "ok", "warehouse": "", "summary": r["summary"] or r["action"]} for r in recent]}
    if path == "/api/auth/profile" and method == "PUT":
        if me["local"]:
            raise AccountError(403, "This computer's Super Admin has no profile. Sign in with an account.")
        with oms.tx() as t:
            for k in ("full_name", "job_title", "email", "phone"):
                if k in body:
                    # the names come from the fixed tuple above, never from the request
                    t.run(f"UPDATE staff_accounts SET {k} = %s WHERE id = %s", (oms._text(body[k], 200), me["id"]))
            return _public(t.one("SELECT * FROM staff_accounts WHERE id = %s", (me["id"],)))
    if path == "/api/users" or path.startswith("/api/users/"):
        if me["local"]:
            # not an identity: nothing to attribute changes to, and accounts outlive this mode
            raise AccountError(403, "Sign in with a Super Admin account to manage accounts.")
        return _users(method, [p for p in path.split("/")[3:] if p], me, body)
    raise AccountError(404, "Not found")
