"""Staff accounts end to end through the real handler, on a scratch database.

    python lead-api/accounts_test.py

Covers: off without a secret; sign-in, wrong passwords and lockout; forced password
change; sessions ended by deactivation and password change; roles and what each may
do; warehouse and screen limits enforced by the server; the last Super Admin; the
demo token and forged tokens getting nothing.
"""
import base64
import json
import os
import sys
import tempfile
import threading
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

tmp = tempfile.mkdtemp(prefix="accounts-test-")
os.environ["OMS_SQLITE_PATH"] = os.path.join(tmp, "oms.db")
os.environ["LEADS_SQLITE_PATH"] = os.path.join(tmp, "leads.db")
os.environ["BILLING_SQLITE_PATH"] = os.path.join(tmp, "billing.db")
for k in ("ACCOUNTS_SECRET", "OMS_OPEN_LOCAL", "POSTGRES_URL", "DATABASE_URL", "VERCEL", "LEAD_TRUST_CF"):
    os.environ.pop(k, None)

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import accounts  # noqa: E402
from http_handler import LeadHandler  # noqa: E402
import oms  # noqa: E402
import oms_load  # noqa: E402

bad = 0


def ok(cond, what):
    global bad
    print(("  ok    " if cond else "  FAIL  ") + what)
    bad += 0 if cond else 1


srv = ThreadingHTTPServer(("127.0.0.1", 0), LeadHandler)
threading.Thread(target=srv.serve_forever, daemon=True).start()
BASE = f"http://127.0.0.1:{srv.server_address[1]}"


def call(path, body=None, tok="", wh=None, method=None):
    headers = {"Content-Type": "application/json"}
    if tok:
        headers["X-Essa-Token"] = tok
    if wh:
        headers["X-Essa-Warehouse"] = str(wh)
    req = urllib.request.Request(BASE + path, data=None if body is None else json.dumps(body).encode(), headers=headers,
                                 method=method or ("GET" if body is None else "POST"))
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


def login(name, password):
    return call("/api/auth/login", {"username": name, "password": password})


print("off without a secret")
ok(call("/api/oms/health") == (200, {"live": False, "open_local": False}), "health says off")
ok(call("/api/auth/login", {"username": "a", "password": "b"})[0] == 503, "no sign-in")
os.environ["ACCOUNTS_SECRET"] = "short"
ok(call("/api/oms/health")[1]["live"] is False, "a short secret does not switch it on")
os.environ["ACCOUNTS_SECRET"] = "x" * 48
ok(call("/api/oms/health")[1]["live"] is True, "a long one does")

print("the first Super Admin")
print("  " + oms_load.load_sample())
try:
    with oms.tx() as t:
        accounts.create(t, "owner", "short", "superadmin")
    ok(False, "a short password is refused")
except accounts.AccountError:
    ok(True, "a short password is refused")
for weak in ("password123", "owner-owner-owner"):
    try:
        with oms.tx() as t:
            accounts.create(t, "owner", weak, "superadmin")
        ok(False, f"'{weak}' is refused")
    except accounts.AccountError:
        ok(True, f"a guessable password is refused ({weak})")
TEMP = "first-temporary-pass"
with oms.tx() as t:
    accounts.create(t, "owner", TEMP, "superadmin", "The Owner", "setup")
with oms.tx() as t:
    stored = t.one("SELECT pw_hash FROM staff_accounts WHERE username = 'owner'")["pw_hash"]
ok(stored.startswith("scrypt$") and TEMP not in stored, "the password is stored hashed")
ok(accounts.has_any(), "has_any")

print("signing in")
code, j = login("nobody", "whatever-it-is")
ok(code == 401 and j["detail"] == "Wrong username or password.", "an unknown name")
code, j2 = login("owner", "not-the-password")
ok(code == 401 and j2["detail"] == j["detail"], "a wrong password: the same words, saying nothing")
code, j = login("OWNER ", TEMP)
ok(code == 200 and j["role"] == "superadmin" and j["must_change"] is True and j["token"], "the right one, whatever the case of the name")
ok("pw_hash" not in json.dumps(j), "no hash in the answer")
tok = j["token"]

print("a password someone else set must be changed")
code, j = call("/api/oms/orders", tok=tok)
ok(code == 403 and "Change your password" in j["detail"], "orders refused until it is")
ok(call("/api/users", tok=tok)[0] == 403, "accounts too")
ok(call("/api/auth/verify", tok=tok)[1]["must_change"] is True, "verify says so, for the app to ask")
ok(call("/api/auth/change-password", {"current_password": "wrong", "new_password": "a-brand-new-password"}, tok)[0] == 403, "the current password is needed")
ok(call("/api/auth/change-password", {"current_password": TEMP, "new_password": "short"}, tok)[0] == 422, "the new one must be good enough")
ok(call("/api/auth/change-password", {"current_password": TEMP, "new_password": TEMP}, tok)[0] == 422, "and different")
OWNER_PW = "a-brand-new-password"
code, j = call("/api/auth/change-password", {"current_password": TEMP, "new_password": OWNER_PW}, tok)
ok(code == 200 and j["token"], "changed, with a fresh token")
ok(call("/api/oms/orders", tok=tok)[0] == 401, "the old token is dead")
tok = j["token"]
ok(call("/api/auth/verify", tok=tok)[1]["must_change"] is False, "no longer asked")
code, j = call("/api/oms/orders", tok=tok)
ok(code == 200 and len(j["rows"]) == 57, "the Super Admin sees every order")

print("tokens")
ok(call("/api/oms/orders")[0] == 401, "no token: 401, which returns the app to its login")
ok(call("/api/oms/orders", tok="demo")[0] == 401, "the demo's token means nothing here")
ok(call("/api/users", tok="demo")[0] == 401, "not for accounts either")
ok(call("/api/auth/verify", tok="demo")[1] == {"ok": False}, "verify says so")
ok(call("/api/oms/orders", tok=tok[:-2] + "xx")[0] == 401, "an altered token")
body = base64.urlsafe_b64encode(json.dumps({"k": "staff", "u": 1, "v": 2, "x": 9999999999}).encode()).rstrip(b"=").decode()
ok(call("/api/oms/orders", tok=body + ".forged")[0] == 401, "a forged one")
os.environ["ACCOUNTS_SECRET"] = "y" * 48
ok(call("/api/oms/orders", tok=tok)[0] == 401, "changing the secret ends every session")
os.environ["ACCOUNTS_SECRET"] = "x" * 48
expired = accounts._b64(json.dumps({"k": "staff", "u": 1, "v": 2, "x": 1000}).encode())
ok(call("/api/oms/orders", tok=expired + "." + accounts._mac(expired))[0] == 401, "an expired one")

print("managing accounts")
code, j = call("/api/users", tok=tok)
ok(code == 200 and j["users"][0]["username"] == "owner" and j["catalog"]["screens"] and j["catalog"]["warehouses"], "the list, with its access grid")
ok(any(s["key"] == "oms_orders" for s in j["catalog"]["screens"]), "the order screens can be granted")
ok("pw_hash" not in json.dumps(j), "no hashes in it")
ok(call("/api/users", {"username": "x", "password": "long-enough-password"}, tok)[0] == 422, "a bad username")
ok(call("/api/users", {"username": "sam", "password": "short"}, tok)[0] == 422, "a short password")
ok(call("/api/users", {"username": "sam", "password": "long-enough-password", "role": "god"}, tok)[0] == 422, "a made-up role")


def add(name, role):
    code, u = call("/api/users", {"username": name, "password": "first-step-secret-1", "role": role, "full_name": name.title()}, tok)
    assert code == 200, u
    code, s = login(name, "first-step-secret-1")
    pw = f"my-chosen-secret-{ord(name[0])}"
    code, r = call("/api/auth/change-password", {"current_password": "first-step-secret-1", "new_password": pw}, s["token"])
    assert code == 200, r
    return u, r["token"], pw


ok(call("/api/users", {"username": "owner", "password": "long-enough-password"}, tok)[0] == 409, "a name already taken")
admin_u, admin, admin_pw = add("ana", "admin")
staff_u, staff, staff_pw = add("sam", "user")
limited_u, limited, limited_pw = add("wes", "user")

print("what each role may do")
for who_, t_ in (("an Admin", admin), ("a User", staff)):
    ok(call("/api/users", tok=t_)[0] == 403, f"{who_} cannot list accounts")
    ok(call("/api/users", {"username": "new1", "password": "long-enough-password"}, t_)[0] == 403, f"{who_} cannot add one")
    ok(call(f"/api/users/{staff_u['id']}", {"role": "superadmin"}, t_, method="PATCH")[0] == 403, f"{who_} cannot promote anyone")
    ok(call(f"/api/users/{staff_u['id']}/password", {"new_password": "long-enough-password"}, t_)[0] == 403, f"{who_} cannot reset a password")
ok(call("/api/oms/orders", tok=staff)[0] == 200, "a User can work with orders")
ok(call("/api/auth/profile", tok=staff)[1]["username"] == "sam", "and read their own profile")
ok(call("/api/auth/profile", {"full_name": "Sam B", "role": "superadmin"}, staff, method="PUT")[1]["role"] == "user", "a profile cannot change a role")

orders = call("/api/oms/orders", tok=tok)[1]["rows"]
delivered = next(o for o in orders if o["status"] == "delivered")
line = delivered["lines"][0]
new_one = next(o for o in orders if o["status"] == "new" and o["wh"] == 1)


def rma(t_):
    d = call(f"/api/oms/orders/{delivered['id']}", tok=tok)[1]
    left = next(l for l in d["lines"] if l["product_id"] == line["product_id"])
    assert left["qty"] > left["returned"], "the test order has run out"
    return call("/api/oms/returns", {"order_id": delivered["id"], "reason": "Wrong size", "lines": [{"product_id": line["product_id"], "qty": 1}]}, t_)[1]


recs = call("/api/oms/returns", tok=tok)[1]["rows"]
got = next(r for r in recs if r["status"] == "received")
ok(call(f"/api/oms/returns/{got['id']}/action", {"action": "refund"}, staff)[0] == 403, "a User cannot refund")
ok(call(f"/api/oms/returns/{got['id']}/action", {"action": "exchange"}, staff)[0] == 403, "or exchange")
ok(call(f"/api/oms/returns/{got['id']}/action", {"action": "refund"}, admin)[1]["status"] == "refunded", "an Admin can")
code, j = call(f"/api/oms/orders/{new_one['id']}/action", {"action": "confirm"}, staff)
ok(code == 200 and j["events"][-1]["by"] == "Sam B", "the timeline names who did it")

print("warehouse limits, enforced here")
ok(call(f"/api/users/{limited_u['id']}/permissions", {"warehouses": "all"}, tok, method="PUT")[0] == 422, "a bad shape is refused")
code, j = call(f"/api/users/{limited_u['id']}/permissions", {"screens": {}, "data": {}, "warehouses": [1], "store": "admin"}, tok, method="PUT")
ok(code == 200 and j["permissions"] == {"warehouses": [1]}, "narrowed to one warehouse; empty grants are not stored")
rows = call("/api/oms/orders", tok=limited)[1]["rows"]
ok(rows and all(o["wh"] == 1 for o in rows), "at Central: only that warehouse's orders")
ok(call("/api/oms/orders", tok=limited, wh=2)[0] == 403, "asking for another warehouse: refused")
ok(call("/api/oms/orders", tok=limited, wh=1)[0] == 200, "its own: fine")
other = next(o for o in orders if o["wh"] == 2)
ok(call(f"/api/oms/orders/{other['id']}", tok=limited)[0] == 404, "another warehouse's order, by id: not found")
ok(call(f"/api/oms/orders/{other['id']}/action", {"action": "confirm"}, limited)[0] == 404, "nor can it be changed")
ok(all(r["wh"] == 1 for r in call("/api/oms/returns", tok=limited)[1]["rows"]), "returns too")
s = call("/api/oms/summary", tok=limited)[1]
ok(s["total"] == len(rows) and all(x["wh"] == 1 for x in s["late"]), "and the summary")
ok([w["id"] for w in call("/api/oms/options", tok=limited)[1]["warehouses"]] == [1], "the warehouse list")
ok(call("/api/oms/products?wh=2", tok=limited)[0] == 403, "another warehouse's stock")
ok(call("/api/oms/orders", {"wh": 2, "customer": {"name": "X"}, "lines": [{"product_id": 1, "qty": 1}]}, limited)[0] == 403, "an order for another warehouse")
ok(len(call("/api/oms/orders", tok=admin)[1]["rows"]) >= 57, "an Admin with no limit sees them all")

print("screen limits, enforced here")
call(f"/api/users/{limited_u['id']}/permissions", {"screens": {"oms_orders": ["view"]}, "warehouses": [1]}, tok, method="PUT")
ok(call("/api/oms/orders", tok=limited)[0] == 200, "granted: view")
ok(call(f"/api/oms/orders/{new_one['id']}/action", {"action": "pick"}, limited)[0] == 403, "not granted: modify")
ok(call("/api/oms/orders", {"customer": {"name": "X"}, "lines": []}, limited, 1)[0] == 403, "not granted: create")
ok(call("/api/oms/returns", tok=limited)[0] == 403, "not granted: returns")
ok(call("/api/oms/summary", tok=limited)[0] == 403, "not granted: reports")
call(f"/api/users/{limited_u['id']}/permissions", {"warehouses": [1]}, tok, method="PUT")
ok(call("/api/oms/summary", tok=limited)[0] == 200, "cleared: the role decides again")

print("a Super Admin cannot be narrowed")
call(f"/api/users/{admin_u['id']}", {"role": "superadmin"}, tok, method="PATCH")
_, s2 = 0, login("ana", admin_pw)[1]
ok(call("/api/auth/verify", tok=admin)[1] == {"ok": False}, "changing a role ends their old session")
admin = s2["token"]
call(f"/api/users/{admin_u['id']}/permissions", {"warehouses": [1], "screens": {"oms_orders": ["view"]}}, tok, method="PUT")
ok(len(call("/api/oms/orders", tok=admin, wh=2)[1]["rows"]) > 0 and call("/api/oms/summary", tok=admin)[0] == 200, "limits do not apply to one")
call(f"/api/users/{admin_u['id']}", {"role": "admin"}, tok, method="PATCH")
call(f"/api/users/{admin_u['id']}/permissions", {}, tok, method="PUT")
admin = login("ana", admin_pw)[1]["token"]

print("the last Super Admin, and yourself")
owner_id = call("/api/auth/me", tok=tok)[1]["id"]
ok(call(f"/api/users/{owner_id}", {"role": "admin"}, tok, method="PATCH")[0] == 409, "cannot change your own role")
ok(call(f"/api/users/{owner_id}", {"active": False}, tok, method="PATCH")[0] == 409, "or deactivate yourself")
ok(call(f"/api/users/{owner_id}", tok=tok, method="DELETE")[0] == 409, "or delete yourself")
with oms.tx() as t:
    row = t.one("SELECT * FROM staff_accounts WHERE id = %s", (owner_id,))
    try:
        accounts._guard_last_superadmin(t, row, True)
        ok(False, "the last Super Admin is guarded")
    except accounts.AccountError:
        ok(True, "the last Super Admin is guarded")

print("ending sessions")
code, j = call(f"/api/users/{staff_u['id']}", {"active": False}, tok, method="PATCH")
ok(code == 200 and j["active"] is False, "deactivated")
ok(call("/api/oms/orders", tok=staff)[0] == 401, "their session ends at once")
ok(login("sam", staff_pw)[0] == 401, "and they cannot sign in")
call(f"/api/users/{staff_u['id']}", {"active": True}, tok, method="PATCH")
staff = login("sam", staff_pw)[1]["token"]
ok(call("/api/oms/orders", tok=staff)[0] == 200, "reactivated: back in")
code, _ = call(f"/api/users/{staff_u['id']}/password", {"new_password": "reset-by-the-owner-1"}, tok)
ok(code == 200 and call("/api/oms/orders", tok=staff)[0] == 401, "a reset ends their sessions too")
ok(login("sam", staff_pw)[0] == 401, "the old password is gone")
code, j = login("sam", "reset-by-the-owner-1")
ok(code == 200 and j["must_change"] is True, "and the new one must be changed")
sam_tok = j["token"]
ok(call("/api/auth/logout", {}, sam_tok)[0] == 200 and call("/api/auth/verify", tok=sam_tok)[1] == {"ok": False}, "signing out ends the session")
ok(call(f"/api/users/{limited_u['id']}", tok=tok, method="DELETE")[0] == 200, "an account can be deleted")
ok(login("wes", limited_pw)[0] == 401 and call("/api/oms/orders", tok=limited)[0] == 401, "and is gone")
ok(call("/api/users/99999", {"role": "user"}, tok, method="PATCH")[0] == 404, "an unknown account")
with oms.tx() as t:
    actions = {r["action"] for r in t.all("SELECT DISTINCT action FROM staff_audit")}
ok({"create", "signin", "signin_failed", "password", "password_reset", "update", "permissions", "delete"} <= actions, "every change is in the audit trail")

print("wrong passwords lock an account")
for _ in range(accounts.MAX_FAILS):
    login("ana", "not-the-password")
code, j = login("ana", admin_pw)
ok(code == 401 and j["detail"] == "Wrong username or password.", "the right password no longer works, and it does not say why")
with oms.tx() as t:
    t.run("UPDATE staff_accounts SET locked_until = %s WHERE username = 'ana'", (oms.billing.iso(oms.billing.now() - oms.dt.timedelta(minutes=1)),))
ok(login("ana", admin_pw)[0] == 200, "after the wait it does")
for _ in range(2):
    login("ana", "not-the-password")
login("ana", admin_pw)
with oms.tx() as t:
    ok(t.one("SELECT failed_count FROM staff_accounts WHERE username = 'ana'")["failed_count"] == 0, "a good sign-in clears the count")

print("this computer (OMS_OPEN_LOCAL)")
os.environ["OMS_OPEN_LOCAL"] = "1"
ok(call("/api/oms/health")[1] == {"live": True, "open_local": True}, "health says so")
code, j = call(f"/api/oms/orders/{new_one['id']}", tok="demo")
ok(code == 200, "the demo's token, from this computer: straight into the orders")
ok(call("/api/users", tok="demo")[0] == 403, "but accounts need a real sign-in")
ok(call("/api/auth/verify", tok="demo")[1] == {"ok": False}, "and verify is not fooled")
staff_row = call("/api/auth/me", tok=login("ana", admin_pw)[1]["token"])[1]
ok(staff_row["username"] == "ana", "a real sign-in is still its own person here")
os.environ["LEAD_TRUST_CF"] = "1"
ok(call("/api/oms/orders", tok="demo")[0] == 401, "through a tunnel: no")
del os.environ["LEAD_TRUST_CF"]
del os.environ["OMS_OPEN_LOCAL"]

print("too many sign-ins from one address")
codes = [login("nobody", "whatever-it-is")[0] for _ in range(accounts.IP_LOGINS_PER_15_MIN + 1)]
ok(codes[-1] == 429, "slowed down")

srv.shutdown()
print(f"\n{bad} FAILED" if bad else "\nall passing")
sys.exit(1 if bad else 0)
