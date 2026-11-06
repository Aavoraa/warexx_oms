"""The OMS API end to end through the real handler, on a scratch database.

    python lead-api/oms_test.py                          (SQLite, nothing needed)
    OMS_DATABASE_URL=postgresql://… python lead-api/oms_test.py   (a SCRATCH PostgreSQL; needs pg8000)

Covers: off without a password; sign-in; warehouse scoping; every order stage and
its refusals; stock reserved, freed, taken and returned; two people allocating the
last unit at once; returns and their limits; the CSV loader; surviving a restart;
the Vercel entrypoint.
"""
import csv
import io
import json
import os
import sys
import tempfile
import threading
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

tmp = tempfile.mkdtemp(prefix="oms-test-")
os.environ["OMS_SQLITE_PATH"] = os.path.join(tmp, "oms.db")
os.environ["LEADS_SQLITE_PATH"] = os.path.join(tmp, "leads.db")
os.environ["BILLING_SQLITE_PATH"] = os.path.join(tmp, "billing.db")
for k in ("ACCOUNTS_SECRET", "POSTGRES_URL", "DATABASE_URL", "VERCEL", "OMS_PROMISE_HOURS"):
    os.environ.pop(k, None)

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import accounts  # noqa: E402
from http_handler import LeadHandler  # noqa: E402
import oms  # noqa: E402
import oms_load  # noqa: E402
import vercel_app  # noqa: E402

bad = 0


def ok(cond, what):
    global bad
    print(("  ok    " if cond else "  FAIL  ") + what)
    bad += 0 if cond else 1


srv = ThreadingHTTPServer(("127.0.0.1", 0), LeadHandler)
threading.Thread(target=srv.serve_forever, daemon=True).start()
BASE = f"http://127.0.0.1:{srv.server_address[1]}/api/oms/"
token = ""


def call(path, body=None, wh=None, tok=None):
    headers = {"Content-Type": "application/json", "X-Essa-Token": token if tok is None else tok}
    if wh:
        headers["X-Essa-Warehouse"] = str(wh)
    req = urllib.request.Request(BASE + path, data=None if body is None else json.dumps(body).encode(), headers=headers,
                                 method="GET" if body is None else "POST")
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


print("switched off without a secret")
ok(call("health") == (200, {"live": False, "open_local": False}), "health says it is off, so the demo's sample data answers")
ok(call("orders")[0] == 503, "nothing else answers")

print("signed in (accounts_test.py covers accounts)")
os.environ["ACCOUNTS_SECRET"] = "x" * 48
ok(call("health")[1]["live"] is True, "ACCOUNTS_SECRET switches it on")
ok(call("session") == (200, {"live": True, "signed_in": False}), "a session starts signed out")
code, j = call("orders")
ok(code == 401, "no token, no orders")
with oms.tx() as t:
    row = accounts.create(t, "owner", "a-long-test-password", "superadmin", "Owner", must_change=False)
token = accounts._token(row)
ok(call("session")[1]["signed_in"] is True, "the token signs you in")
ok(call("orders", tok=token[:-2] + "xx")[0] == 401, "an altered token is refused")
ok(call("orders", tok="")[0] == 401, "an empty token is refused")

print("the sample data")
print("  " + oms_load.load_sample())
ok("left as it is" in oms_load.load_sample(if_empty=True), "--if-empty leaves existing data alone")
try:
    oms_load.load_sample()
    ok(False, "--sample refuses a database with data in it")
except SystemExit:
    ok(True, "--sample refuses a database with data in it")
code, j = call("orders")
ok(code == 200 and len(j["rows"]) == 57 and j["counts"]["all"] == 57, f"all sample orders ({len(j['rows'])})")
ok(j["rows"][0]["created_at"] >= j["rows"][-1]["created_at"], "newest first")
ok(j["counts"]["late"] >= 3, f"late orders counted ({j['counts']['late']})")
first = next((o for o in j["rows"] if o["no"] == "SO-10001"), None)
ok(first and first["units"] > 0 and first["wh_name"], "numbered, with units and warehouse name")
ok(call("orders?status=late")[1]["rows"] and all(o["late"] for o in call("orders?status=late")[1]["rows"]), "filter: late")
ok(all(o["channel"] == "Website" for o in call("orders?channel=Website")[1]["rows"]), "filter: channel")
ok(len(call("orders?q=Sample+Customer+01")[1]["rows"]) >= 1, "search")

print("warehouses")
a = call("orders", wh=1)[1]
ok(a["rows"] and all(o["wh"] == 1 for o in a["rows"]), f"a warehouse sees only its own ({len(a['rows'])})")
other = next(o for o in call("orders")[1]["rows"] if o["wh"] == 2)
ok(call(f"orders/{other['id']}", wh=1)[0] == 404, "another warehouse's order is not found from here")
ok(call(f"orders/{other['id']}/action", {"action": "confirm"}, wh=1)[0] == 404, "…and cannot be changed from here")
ok(call("orders", {"wh": 2, "customer": {"name": "X"}, "lines": [{"product_id": 1, "qty": 1}]}, wh=1)[0] == 403, "no order for another warehouse from inside one")

print("the stages")
new = next(o for o in call("orders")[1]["rows"] if o["status"] == "new")
ok(call(f"orders/{new['id']}/action", {"action": "ship", "courier": "Sample Express"})[0] == 409, "a new order cannot jump to shipped")
ok(call(f"orders/{new['id']}/action", {"action": "cancel"})[0] == 422, "a cancellation needs a reason")
ok(call(f"orders/{new['id']}/action", {"action": "nonsense"})[0] == 400, "an unknown action is refused")
products = call("products?wh=1")[1]
roomy = next(p for p in products if p["available"] >= 5)


def stock():
    return next(p for p in call("products?wh=1")[1] if p["id"] == roomy["id"])


def order(qty, **kw):
    return call("orders", {"wh": 1, "customer": {"name": "Test"}, "lines": [{"product_id": roomy["id"], "qty": qty}], **kw})[1]


def act(o, action, **kw):
    return call(f"orders/{o['id']}/action", {"action": action, **kw})


start = stock()
ok(call("orders", {"wh": 1, "customer": {"name": ""}, "lines": [{"product_id": roomy["id"], "qty": 1}]})[0] == 422, "an order needs a customer")
ok(call("orders", {"wh": 1, "customer": {"name": "T"}, "lines": []})[0] == 422, "an order needs a product")
ok(call("orders", {"wh": 1, "customer": {"name": "T"}, "lines": [{"product_id": 999999, "qty": 1}]})[0] == 422, "a product not at this warehouse is refused")
ok(call("orders", {"wh": 1, "customer": {"name": "T"}, "lines": [{"product_id": roomy["id"], "qty": "many"}]})[0] == 422, "a quantity must be a number")
huge = order(start["available"] + 1)
act(huge, "confirm")
code, j = act(huge, "allocate")
ok(j["status"] == "backorder" and "Not enough stock" in j["message"], "more than is free: backorder, and it says why")
fits = order(2)
ok(fits["status"] == "new" and fits["total"] == roomy["price"] * 2 + (0 if roomy["price"] * 2 >= 2000 else 99), "the total is worked out by the server")
act(fits, "confirm")
ok(act(fits, "allocate")[1]["status"] == "allocated", "an order that fits: allocated")
ok(stock()["available"] == start["available"] - 2 and stock()["stock"] == start["stock"], "allocating reserves without taking it off the shelf")
act(fits, "hold", reason="checking")
ok(stock()["available"] == start["available"] - 2, "on hold from allocated: still reserved")
ok(act(fits, "release")[1]["status"] == "allocated", "released: back where it was")
act(fits, "cancel", reason="test")
ok(stock()["available"] == start["available"], "cancelling frees what it reserved")
ok(act(fits, "confirm")[0] == 409, "a cancelled order stays cancelled")

w = order(2, payment="COD")
for step in ("confirm", "allocate", "pick", "pack"):
    act(w, step)
ok(act(w, "ship")[0] == 422, "shipping needs a courier")
j = act(w, "ship", courier="Sample Express")[1]
ok(j["status"] == "shipped" and j["awb"].startswith("AWB"), "shipped, with a tracking number")
ok(stock()["stock"] == start["stock"] - 2 and stock()["available"] == start["available"] - 2, "shipping takes it off the shelf")
ok(act(w, "cancel", reason="too late")[0] == 409, "a shipped order cannot be cancelled")
ok(call("returns", {"order_id": w["id"], "reason": "Wrong size", "lines": [{"product_id": roomy["id"], "qty": 1}]})[0] == 409, "an undelivered order cannot be returned")
ok(act(w, "deliver")[1]["delivered_at"], "delivered")
events = call(f"orders/{w['id']}")[1]["events"]
ok([e["status"] for e in events] == ["new", "confirmed", "allocated", "picking", "packed", "shipped", "delivered"], "the timeline records every step")

print("two people, the last units")
lowest = order(1)
act(lowest, "cancel", reason="clean up")
free = stock()["available"]
racers = [order(free) for _ in range(2)]
for r in racers:
    act(r, "confirm")
results = []
threads = [threading.Thread(target=lambda r=r: results.append(act(r, "allocate")[1]["status"])) for r in racers]
for th in threads:
    th.start()
for th in threads:
    th.join()
ok(sorted(results) == ["allocated", "backorder"], f"only one gets them ({sorted(results)})")
ok(stock()["available"] == 0, "nothing is over-allocated")
for r in racers:
    act(r, "cancel", reason="clean up")

print("returns")
ok(call("returns", {"order_id": w["id"], "reason": "Wrong size", "lines": [{"product_id": roomy["id"], "qty": 3}]})[0] == 422, "cannot return more than was delivered")
ok(call("returns", {"order_id": w["id"], "lines": [{"product_id": roomy["id"], "qty": 1}]})[0] == 422, "a return needs a reason")
code, rma = call("returns", {"order_id": w["id"], "reason": "Wrong size", "lines": [{"product_id": roomy["id"], "qty": 2}]})
ok(code == 200 and rma["status"] == "requested" and rma["value"] == roomy["price"] * 2 and rma["no"].startswith("RMA-"), "raised, valued at what was paid")
ok(call("returns", {"order_id": w["id"], "reason": "Wrong size", "lines": [{"product_id": roomy["id"], "qty": 1}]})[0] == 422, "the same goods cannot come back twice")
ra = lambda r, action, **kw: call(f"returns/{r['id']}/action", {"action": action, **kw})   # noqa: E731
ok(ra(rma, "refund")[0] == 409, "no refund before the goods are back")
ra(rma, "approve")
ok(ra(rma, "receive", condition="maybe")[0] == 422, "the condition must be good or damaged")
before = stock()["stock"]
ok(ra(rma, "receive", condition="good")[1]["status"] == "received", "received")
ok(stock()["stock"] == before + 2, "good goods go back on the shelf")
code, j = ra(rma, "refund")
ok(j["status"] == "refunded" and j["refund_amount"] == roomy["price"] * 2, "the refund is recorded in full")
ok(ra(rma, "refund")[0] == 409, "and cannot be recorded twice")

w2 = order(1)
for step in ("confirm", "allocate", "pick", "pack"):
    act(w2, step)
act(w2, "ship", courier="Sample Express")
act(w2, "deliver")
_, rma2 = call("returns", {"order_id": w2["id"], "reason": "Damaged in transit", "lines": [{"product_id": roomy["id"], "qty": 1}]})
ra(rma2, "approve")
before = stock()["stock"]
ra(rma2, "receive", condition="damaged")
ok(stock()["stock"] == before, "damaged goods stay out of stock")
j = ra(rma2, "exchange")[1]
ok(j["status"] == "exchanged" and j["replacement_no"].startswith("SO-"), "an exchange raises a replacement order")
rep = next(o for o in call("orders")[1]["rows"] if o["no"] == j["replacement_no"])
ok(rep["total"] == 0 and rep["status"] == "confirmed" and rep["replacement_for"] == rma2["no"], "free of charge, linked to the return")
ok(ra({"id": 999999}, "approve")[0] == 404, "an unknown return is not found")

print("reports")
s = call("summary?days=30")[1]
ok(s["total"] >= 57 and s["value"] > 0 and s["by_channel"] and s["by_warehouse"] and s["top_products"] and s["return_reasons"], "the summary has every section")
ok(s["on_time_pct"] is not None and s["avg_ship_hours"] is not None, "fulfilment rates")
ok(sum(s["counts"].values()) == s["total"], "the counts add up")
ok(call("summary?days=soon")[0] == 422, "a bad period is refused")
one = call("summary?days=30", wh=1)[1]
ok(one["total"] < s["total"], "a warehouse's summary is its own")

print("your own products")
path = os.path.join(tmp, "products.csv")
with open(path, "w", newline="", encoding="utf-8") as f:
    w_ = csv.writer(f)
    w_.writerow(["warehouse_code", "warehouse_name", "sku", "name", "description", "mrp", "price", "stock"])
    w_.writerow(["WH-NEW", "New Warehouse", "NEW-1", "New shirt", "Blue", "999", "899.50", "12"])
    w_.writerow(["WH-NEW", "New Warehouse", "NEW-2", "New kurta", "", "1500", "1499", "3"])
print("  " + oms_load.load_products(path))
wid = next(x["id"] for x in call("options")[1]["warehouses"] if x["code"] == "WH-NEW")
listed = call(f"products?wh={wid}")[1]
ok(len(listed) == 2 and listed[0]["price"] == 899.5 and listed[0]["stock"] == 12, "a new warehouse and its products")
with open(path, "w", newline="", encoding="utf-8") as f:
    w_ = csv.writer(f)
    w_.writerow(["warehouse_code", "warehouse_name", "sku", "name", "description", "mrp", "price", "stock"])
    w_.writerow(["WH-NEW", "New Warehouse", "NEW-1", "New shirt", "Blue", "999", "899.50", "40"])
oms_load.load_products(path)
ok(next(p for p in call(f"products?wh={wid}")[1] if p["sku"] == "NEW-1")["stock"] == 40, "loading a SKU again updates it")
with open(path, "w", newline="", encoding="utf-8") as f:
    f.write("sku,name\nX,Y\n")
try:
    oms_load.load_products(path)
    ok(False, "a CSV missing columns is refused")
except SystemExit:
    ok(True, "a CSV missing columns is refused")

print("it is really stored")
keep = order(1)
oms._ready.clear()
ok(call(f"orders/{keep['id']}")[1].get("no") == keep["no"], "an order is read back from the database, not from memory")

print("the Vercel entrypoint")


def wsgi(path, body=None, token_override=None):
    raw = b"" if body is None else json.dumps(body).encode()
    env = {"REQUEST_METHOD": "GET" if body is None else "POST", "PATH_INFO": path, "QUERY_STRING": "", "CONTENT_LENGTH": str(len(raw)),
           "CONTENT_TYPE": "application/json", "wsgi.input": io.BytesIO(raw), "HTTP_X_ESSA_TOKEN": token if token_override is None else token_override,
           "HTTP_HOST": "localhost", "REMOTE_ADDR": "10.0.0.1"}
    seen = {}
    out = b"".join(vercel_app.app(env, lambda s, h: seen.update(status=s)))
    return seen["status"], json.loads(out)


ok(wsgi("/api/oms/health")[1]["live"] is True, "health")
ok(wsgi("/api/oms/orders")[0].startswith("200") and wsgi("/api/oms/orders")[1]["rows"], "a signed-in read")

print("this computer, without the password (OMS_OPEN_LOCAL)")


def bare(path="orders", body=None, headers=None):
    req = urllib.request.Request(BASE + path, data=None if body is None else json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json", **(headers or {})}, method="GET" if body is None else "POST")
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


ok(bare()[0] == 401, "off by default: no token, no orders")
os.environ["OMS_OPEN_LOCAL"] = "1"
ok(bare()[0] == 200 and bare("session")[1]["signed_in"] is True, "on: this computer goes straight in")
ok(bare(headers={"Origin": "http://localhost:8012", "X-Forwarded-Host": "localhost:8012"})[0] == 200, "through the local site")
ok(bare("orders/1/action", {"action": "nonsense"})[0] == 400, "writes too")
ok(bare(headers={"Host": "warexx.example.com"})[0] == 401, "addressed to another name: refused")
ok(bare(headers={"X-Forwarded-Host": "warexx.example.com"})[0] == 401, "forwarded from another name: refused")
ok(bare("orders/1/action", {"action": "confirm"}, {"Origin": "https://evil.example"})[0] == 401, "a page on another site: refused")
ok(bare(headers={"Origin": "http://localhost.evil.example"})[0] == 401, "a look-alike name: refused")
ok(bare("session", headers={"Origin": "https://evil.example"})[1]["signed_in"] is False, "and it is not told it is signed in")
ok(wsgi("/api/oms/orders", token_override="")[0].startswith("401"), "a socket from another machine: refused")
os.environ["LEAD_TRUST_CF"] = "1"
ok(bare()[0] == 401, "through a tunnel: refused")
del os.environ["LEAD_TRUST_CF"]
os.environ["VERCEL"] = "1"
ok(bare()[0] == 401, "on a deployment: refused")
del os.environ["VERCEL"]
os.environ["LEAD_API_HOST"] = "0.0.0.0"
ok(bare()[0] == 401, "a server listening beyond this computer: refused")
del os.environ["LEAD_API_HOST"]
del os.environ["OMS_OPEN_LOCAL"]

srv.shutdown()
print(f"\n{bad} FAILED" if bad else "\nall passing")
sys.exit(1 if bad else 0)
