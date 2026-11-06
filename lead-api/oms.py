"""/api/oms/* — Order Management: customer orders, stock allocation, fulfilment,
returns and their reports. The server behind frontend/vendor/warexx-app/src/OMS.jsx.

Switched on with staff accounts (accounts.py, ACCOUNTS_SECRET), which say who a request
is and how far they may reach. Off, the demo's worker (sw.js) answers the same screens
from sample data instead.

Its own database, apart from the leads and the billing data:
    OMS_DATABASE_URL — a postgres:// address (pg8000). Required on a hosted
    deployment. Not set on a developer's machine: a SQLite file,
    lead-api/data/oms.db (OMS_SQLITE_PATH to move it).

The rules live here and nowhere else. An order only moves through the stages
below, each write is one transaction, and writes are serialised (BEGIN IMMEDIATE
on SQLite, an advisory lock on PostgreSQL), so two people allocating the last unit
cannot both get it. Money is decimal, never a float, until it is sent as JSON.

Refunds are records: nothing here talks to a payment gateway.

    new -> confirmed -> allocated -> picking -> packed -> shipped -> delivered
                 \\-> backorder -> allocated
    on_hold and cancelled from any stage before shipped.
"""
import base64
import contextlib
import datetime as dt
import json
import os
import sqlite3
import threading
from collections import defaultdict
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from urllib.parse import parse_qsl, urlsplit

import billing
import store

HERE = os.path.dirname(os.path.abspath(__file__))
MAX_ROWS = 500
FREE_SHIPPING_FROM = Decimal("2000")
SHIPPING = Decimal("99")

CHANNELS = ["Website", "Mobile App", "Marketplace", "Store Pickup", "Phone Order"]
COURIERS = ["Sample Express", "Demo Logistics", "Example Couriers", "Own Delivery Van"]
CANCEL_REASONS = ["Customer changed their mind", "Payment not received", "Duplicate order"]
HOLD_REASONS = ["Address needs confirming", "Waiting for the customer to call back"]
RETURN_REASONS = ["Wrong size", "Damaged in transit", "Different from photo", "Ordered by mistake", "Quality not as expected"]

OPEN = {"new", "confirmed", "allocated", "picking", "packed", "backorder", "on_hold"}
RESERVING = {"allocated", "picking", "packed"}
ACTOR = "Staff"

_lock = threading.Lock()
_ready = set()


class OmsError(Exception):
    def __init__(self, status, detail):
        super().__init__(detail)
        self.status, self.detail = status, detail


# ---- the database ---------------------------------------------------------------

_V1 = [
    """CREATE TABLE oms_warehouses (
        id BIGSERIAL PRIMARY KEY, name TEXT NOT NULL, code TEXT NOT NULL UNIQUE)""",
    """CREATE TABLE oms_products (
        wh_id BIGINT NOT NULL REFERENCES oms_warehouses(id), product_id BIGINT NOT NULL,
        sku TEXT NOT NULL, name TEXT NOT NULL, descr TEXT NOT NULL DEFAULT '',
        mrp NUMERIC(12,2) NOT NULL, price NUMERIC(12,2) NOT NULL, stock BIGINT NOT NULL,
        PRIMARY KEY (wh_id, product_id), UNIQUE (wh_id, sku))""",
    """CREATE TABLE oms_orders (
        id BIGSERIAL PRIMARY KEY, no TEXT NOT NULL UNIQUE, wh_id BIGINT NOT NULL REFERENCES oms_warehouses(id),
        channel TEXT NOT NULL, status TEXT NOT NULL, payment TEXT NOT NULL, customer JSONB NOT NULL, lines JSONB NOT NULL,
        subtotal NUMERIC(12,2) NOT NULL, shipping NUMERIC(12,2) NOT NULL, total NUMERIC(12,2) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL, promised_at TIMESTAMPTZ NOT NULL, shipped_at TIMESTAMPTZ, delivered_at TIMESTAMPTZ,
        courier TEXT, awb TEXT, hold_reason TEXT, held_from TEXT, cancel_reason TEXT, replacement_for TEXT,
        events JSONB NOT NULL)""",
    "CREATE INDEX oms_orders_wh_status ON oms_orders (wh_id, status)",
    """CREATE TABLE oms_returns (
        id BIGSERIAL PRIMARY KEY, no TEXT NOT NULL UNIQUE, order_id BIGINT NOT NULL REFERENCES oms_orders(id),
        wh_id BIGINT NOT NULL REFERENCES oms_warehouses(id), status TEXT NOT NULL, reason TEXT NOT NULL, lines JSONB NOT NULL,
        value NUMERIC(12,2) NOT NULL, item_condition TEXT, refund_amount NUMERIC(12,2), replacement_no TEXT,
        created_at TIMESTAMPTZ NOT NULL, events JSONB NOT NULL)""",
    "CREATE INDEX oms_returns_order ON oms_returns (order_id)",
]
#: (version, statements). Append only; never edit one that has shipped.
_V2 = [
    """CREATE TABLE staff_accounts (
        id BIGSERIAL PRIMARY KEY, username TEXT NOT NULL UNIQUE, full_name TEXT, job_title TEXT, email TEXT, phone TEXT,
        role TEXT NOT NULL, active BOOLEAN NOT NULL, pw_hash TEXT NOT NULL, token_version BIGINT NOT NULL,
        must_change BOOLEAN NOT NULL, failed_count BIGINT NOT NULL, locked_until TIMESTAMPTZ, permissions JSONB NOT NULL,
        created_by TEXT, created_at TIMESTAMPTZ NOT NULL, last_login_at TIMESTAMPTZ)""",
    """CREATE TABLE staff_audit (
        id BIGSERIAL PRIMARY KEY, at TIMESTAMPTZ NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL,
        target TEXT NOT NULL, detail TEXT)""",
]
MIGRATIONS = [(1, _V1), (2, _V2)]


def database_url():
    v = (os.environ.get("OMS_DATABASE_URL") or "").strip()
    return v if v.startswith(("postgres://", "postgresql://")) else ""


def _sqlite_path():
    return os.environ.get("OMS_SQLITE_PATH") or os.path.join(HERE, "data", "oms.db")


def _connect():
    url = database_url()
    if url:
        return store._pg_connect(url), "postgres"
    if billing.hosted():
        raise RuntimeError("OMS_DATABASE_URL is not set")
    path = _sqlite_path()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    c = sqlite3.connect(path, timeout=15, isolation_level=None)
    c.execute("PRAGMA foreign_keys = ON")
    return c, "sqlite"


def _migrate(conn, dialect):
    cur = conn.cursor()
    if dialect == "postgres":
        cur.execute("SELECT pg_advisory_lock(727303)")
    try:
        cur.execute("CREATE TABLE IF NOT EXISTS oms_schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)")
        if dialect == "postgres":
            conn.commit()
        cur.execute("SELECT version FROM oms_schema_migrations")
        done = {r[0] for r in cur.fetchall()}
        for version, stmts in MIGRATIONS:
            if version in done:
                continue
            if dialect == "sqlite":
                cur.execute("BEGIN IMMEDIATE")
            for s in stmts:
                cur.execute(s if dialect == "postgres" else billing._lite(s))
            cur.execute(billing._q("INSERT INTO oms_schema_migrations (version, applied_at) VALUES (%s, %s)", dialect),
                        (version, billing.iso(billing.now())))
            conn.commit() if dialect == "postgres" else cur.execute("COMMIT")
    except Exception:
        if dialect == "postgres":
            conn.rollback()
        else:
            with contextlib.suppress(sqlite3.Error):
                cur.execute("ROLLBACK")
        raise
    finally:
        if dialect == "postgres":
            cur.execute("SELECT pg_advisory_unlock(727303)")
            conn.commit()


@contextlib.contextmanager
def tx():
    """One serialised transaction, in billing.Tx's shape: t.all, t.one, t.run, t.insert."""
    conn, dialect = _connect()
    try:
        key = database_url() or _sqlite_path()
        if key not in _ready:
            with _lock:
                if key not in _ready:
                    _migrate(conn, dialect)
                    _ready.add(key)
        t = billing.Tx(conn, dialect)
        if dialect == "sqlite":
            t.cur.execute("BEGIN IMMEDIATE")
        else:
            t.cur.execute("SELECT pg_advisory_xact_lock(727304)")
        try:
            yield t
        except BaseException:
            conn.rollback() if dialect == "postgres" else t.cur.execute("ROLLBACK")
            raise
        conn.commit() if dialect == "postgres" else t.cur.execute("COMMIT")
    finally:
        conn.close()


def _b64(b):
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


# ---- who is asking, for this thread's request ---------------------------------------
# accounts.who() decided who; these are what that means here. Set by handle().

_ctx = threading.local()
RANK = {"user": 1, "admin": 2, "superadmin": 3}


def _me():
    return getattr(_ctx, "me", None)


def _reach():
    """The warehouses this person is limited to; None means every one."""
    me = _me()
    if not me or me["role"] == "superadmin":
        return None
    return set(me["permissions"].get("warehouses") or []) or None


def _within(wh):
    reach = _reach()
    return reach is None or wh in reach


def _may(screens, action):
    """permissions.screens narrows an account to what is ticked; empty means the role decides."""
    me = _me()
    granted = (me or {}).get("permissions", {}).get("screens")
    if not me or me["role"] == "superadmin" or not granted:
        return
    if not any(action in (granted.get(k) or []) for k in screens):
        raise OmsError(403, "Your account does not have access to that.")


ALL_SCREENS = ("oms_dashboard", "oms_orders", "oms_fulfilment", "oms_returns", "oms_reports")


# ---- reading rows -----------------------------------------------------------------

def _d(v):
    return Decimal(str(v)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


def _n(v):
    return None if v is None else float(_d(v))


def _j(v):
    return json.loads(v) if isinstance(v, str) else v


def _text(v, limit=300):
    return str(v or "").strip()[:limit]


def _now():
    return billing.iso(billing.now())


def _when(v):
    return billing.parse(v)


def _event(rec, status, note, by=None):
    by = by or (_me() or {}).get("full_name") or ACTOR
    rec["events"].append({"at": _now(), "status": status, "note": note, "by": by})


def _order(row):
    o = dict(row)
    o["wh"] = o.pop("wh_id")
    o["customer"], o["events"] = _j(o["customer"]), _j(o["events"])
    o["lines"] = [{**l, "price": float(l["price"])} for l in _j(o["lines"])]
    for k in ("subtotal", "shipping", "total"):
        o[k] = _n(o[k])
    return o


def _return(row, order_no=None, channel=None, customer=None):
    r = dict(row)
    r["wh"] = r.pop("wh_id")
    r["condition"] = r.pop("item_condition")
    r["lines"] = [{**l, "price": float(l["price"])} for l in _j(r["lines"])]
    r["events"] = _j(r["events"])
    r["value"], r["refund_amount"] = _n(r["value"]), _n(r["refund_amount"])
    r["order_no"], r["channel"], r["customer"] = order_no, channel, customer
    return r


def _late(o):
    return o["status"] in OPEN and _when(o["promised_at"]) < billing.now()


def _warehouses(t):
    return [w for w in t.all("SELECT id, name, code FROM oms_warehouses ORDER BY id") if _within(w["id"])]


def _view(o, names):
    return {**o, "wh_name": names.get(o["wh"], ""), "late": _late(o), "units": sum(l["qty"] for l in o["lines"])}


def _names(t):
    return {w["id"]: w["name"] for w in _warehouses(t)}


def _orders(t, wh=None):
    rows = t.all("SELECT * FROM oms_orders" + (" WHERE wh_id = %s" if wh else ""), (wh,) if wh else ())
    return [_order(r) for r in rows if _within(r["wh_id"])]


def _returns(t, wh=None):
    rows = t.all("""SELECT r.*, o.no AS o_no, o.channel AS o_channel, o.customer AS o_customer FROM oms_returns r
                    JOIN oms_orders o ON o.id = r.order_id""" + (" WHERE r.wh_id = %s" if wh else ""), (wh,) if wh else ())
    out = []
    for row in rows:
        if not _within(row["wh_id"]):
            continue
        row = dict(row)
        no, channel, customer = row.pop("o_no"), row.pop("o_channel"), row.pop("o_customer")
        out.append(_return(row, no, channel, _j(customer)["name"]))
    return out


def _reserved(t, wh):
    """What open orders have reserved at a warehouse: {product_id: units}."""
    held = defaultdict(int)
    for r in t.all("SELECT status, held_from, lines FROM oms_orders WHERE wh_id = %s AND status IN ('allocated','picking','packed','on_hold')", (wh,)):
        if r["status"] in RESERVING or r["held_from"] == "allocated":
            for l in _j(r["lines"]):
                held[l["product_id"]] += l["qty"]
    return held


def _returned(t, order_id):
    """Units already coming back on an order, rejected returns aside: {product_id: units}."""
    out = defaultdict(int)
    for r in t.all("SELECT lines FROM oms_returns WHERE order_id = %s AND status <> 'rejected'", (order_id,)):
        for l in _j(r["lines"]):
            out[l["product_id"]] += l["qty"]
    return out


def _stock_of(t, wh, product_id):
    r = t.one("SELECT stock FROM oms_products WHERE wh_id = %s AND product_id = %s", (wh, product_id))
    return int(r["stock"]) if r else 0


def _detail(t, o):
    held, back = _reserved(t, o["wh"]), _returned(t, o["id"])
    returns = [r for r in _returns(t) if r["order_id"] == o["id"]]
    lines = [{**l, "available": _stock_of(t, o["wh"], l["product_id"]) - held[l["product_id"]],
              "returned": back[l["product_id"]]} for l in o["lines"]]
    return {**_view(o, _names(t)), "lines": lines, "returns": returns}


def _save_order(t, o):
    t.run("""UPDATE oms_orders SET status=%s, courier=%s, awb=%s, shipped_at=%s, delivered_at=%s, hold_reason=%s,
             held_from=%s, cancel_reason=%s, events=%s WHERE id=%s""",
          (o["status"], o.get("courier"), o.get("awb"), o.get("shipped_at"), o.get("delivered_at"), o.get("hold_reason"),
           o.get("held_from"), o.get("cancel_reason"), o["events"], o["id"]))


def _adjust_stock(t, wh, line, by):
    t.run("UPDATE oms_products SET stock = stock + %s WHERE wh_id = %s AND product_id = %s", (by, wh, line["product_id"]))


def _money_lines(lines):
    return [{**l, "price": str(l["price"])} for l in lines]


def insert_order(t, wh, channel, status, payment, customer, lines, created_at, promised_at, events, **extra):
    """One order row, its number made from its id. Prices are Decimals or decimal text."""
    subtotal = sum((_d(l["price"]) * l["qty"] for l in lines), Decimal("0"))
    shipping = extra.pop("shipping", Decimal("0") if subtotal >= FREE_SHIPPING_FROM or subtotal == 0 else SHIPPING)
    cols = {"courier": None, "awb": None, "shipped_at": None, "delivered_at": None, "hold_reason": None,
            "held_from": None, "cancel_reason": None, "replacement_for": None, **extra}
    new_id = t.insert(
        """INSERT INTO oms_orders (no, wh_id, channel, status, payment, customer, lines, subtotal, shipping, total,
           created_at, promised_at, shipped_at, delivered_at, courier, awb, hold_reason, held_from, cancel_reason,
           replacement_for, events) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
        ("pending-" + _b64(os.urandom(9)), wh, channel, status, payment, customer, _money_lines(lines), subtotal, shipping,
         subtotal + shipping, created_at, promised_at, cols["shipped_at"], cols["delivered_at"], cols["courier"], cols["awb"],
         cols["hold_reason"], cols["held_from"], cols["cancel_reason"], cols["replacement_for"], events))
    t.run("UPDATE oms_orders SET no = %s WHERE id = %s", (f"SO-{10000 + new_id}", new_id))
    return new_id


def insert_return(t, order_id, wh, status, reason, lines, value, created_at, events, **extra):
    new_id = t.insert(
        """INSERT INTO oms_returns (no, order_id, wh_id, status, reason, lines, value, item_condition, refund_amount,
           replacement_no, created_at, events) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
        ("pending-" + _b64(os.urandom(9)), order_id, wh, status, reason, _money_lines(lines), value, extra.get("condition"),
         extra.get("refund_amount"), extra.get("replacement_no"), created_at, events))
    t.run("UPDATE oms_returns SET no = %s WHERE id = %s", (f"RMA-{2000 + new_id}", new_id))
    return new_id


def _promise():
    try:
        hours = int(os.environ.get("OMS_PROMISE_HOURS") or 72)
    except ValueError:
        hours = 72
    return billing.iso(billing.now() + dt.timedelta(hours=hours))


# ---- what can happen to an order, and to a return ----------------------------------

def _order_action(t, o, body):
    action, status = body.get("action"), o["status"]

    def needs(*stages):
        if status not in stages:
            raise OmsError(409, f"{o['no']} is {status.replace('_', ' ')}: it cannot do that now.")

    message = None
    if action == "confirm":
        needs("new")
        o["status"] = "confirmed"
        _event(o, "confirmed", "Order confirmed")
    elif action == "allocate":
        needs("confirmed", "backorder")
        held = _reserved(t, o["wh"])
        short = []
        for l in o["lines"]:
            free = _stock_of(t, o["wh"], l["product_id"]) - held[l["product_id"]]
            if free < l["qty"]:
                short.append(f"{l['sku']} (need {l['qty']}, {max(0, free)} free)")
        if short:
            what = ", ".join(short)
            if status != "backorder":
                o["status"] = "backorder"
                _event(o, "backorder", f"Not enough stock: {what}")
            message = f"Not enough stock, so {o['no']} is on backorder: {what}"
        else:
            o["status"] = "allocated"
            _event(o, "allocated", "Stock reserved at " + _names(t).get(o["wh"], ""))
    elif action == "pick":
        needs("allocated")
        o["status"] = "picking"
        _event(o, "picking", "Picking started")
    elif action == "pack":
        needs("picking")
        o["status"] = "packed"
        _event(o, "packed", "Packed and labelled")
    elif action == "ship":
        needs("packed")
        courier = _text(body.get("courier"), 100)
        if not courier:
            raise OmsError(422, "Choose a courier.")
        for l in o["lines"]:
            _adjust_stock(t, o["wh"], l, -l["qty"])
        o.update(status="shipped", courier=courier, awb=f"AWB{5000000 + o['id'] * 37}", shipped_at=_now())
        _event(o, "shipped", f"Handed to {courier}, {o['awb']}")
    elif action == "deliver":
        needs("shipped")
        o.update(status="delivered", delivered_at=_now())
        _event(o, "delivered", "Delivered to the customer")
    elif action == "hold":
        needs("new", "confirmed", "allocated", "backorder")
        reason = _text(body.get("reason"))
        if not reason:
            raise OmsError(422, "Say why it is on hold.")
        o.update(held_from=status, status="on_hold", hold_reason=reason)
        _event(o, "on_hold", reason)
    elif action == "release":
        needs("on_hold")
        o.update(status=o.get("held_from") or "confirmed", held_from=None, hold_reason=None)
        _event(o, o["status"], "Released from hold")
    elif action == "cancel":
        needs(*(OPEN - {"cancelled"}))
        reason = _text(body.get("reason"))
        if not reason:
            raise OmsError(422, "Say why it is being cancelled.")
        o.update(status="cancelled", held_from=None, cancel_reason=reason)
        _event(o, "cancelled", f"{reason}. Prepaid, so a refund is due." if o["payment"] == "Prepaid" else reason)
    else:
        raise OmsError(400, "Unknown action.")
    _save_order(t, o)
    return message


def _return_action(t, r, body):
    action, status = body.get("action"), r["status"]

    def needs(stage):
        if status != stage:
            raise OmsError(409, f"{r['no']} is {status}: it cannot do that now.")

    if action in ("refund", "exchange") and RANK.get((_me() or {}).get("role"), 0) < RANK["admin"]:
        raise OmsError(403, "Only an Admin can refund or exchange.")
    if action == "approve":
        needs("requested")
        r["status"] = "approved"
        _event(r, "approved", "Return approved")
    elif action == "reject":
        needs("requested")
        reason = _text(body.get("reason"))
        if not reason:
            raise OmsError(422, "Say why it is rejected.")
        r["status"] = "rejected"
        _event(r, "rejected", reason)
    elif action == "receive":
        needs("approved")
        condition = body.get("condition")
        if condition not in ("good", "damaged"):
            raise OmsError(422, "Choose the condition of the goods.")
        r.update(status="received", condition=condition)
        if condition == "good":
            for l in r["lines"]:
                _adjust_stock(t, r["wh"], l, l["qty"])
        _event(r, "received", "Goods received in good condition, back in stock" if condition == "good"
               else "Goods received damaged, not returned to stock")
    elif action == "refund":
        needs("received")
        r.update(status="refunded", refund_amount=r["value"])
        _event(r, "refunded", f"Refund of ₹{r['value']:.2f} recorded (no money moves here)")
    elif action == "exchange":
        needs("received")
        source = _order(t.one("SELECT * FROM oms_orders WHERE id = %s", (r["order_id"],)))
        rec = {"events": []}
        _event(rec, "confirmed", f"Replacement for {r['no']}")
        new_id = insert_order(t, r["wh"], source["channel"], "confirmed", "Prepaid", source["customer"],
                              [{**l, "price": "0"} for l in r["lines"]], _now(), _promise(), rec["events"],
                              replacement_for=r["no"], shipping=Decimal("0"))
        no = t.one("SELECT no FROM oms_orders WHERE id = %s", (new_id,))["no"]
        r.update(status="exchanged", replacement_no=no)
        _event(r, "exchanged", f"Replacement order {no} raised")
    else:
        raise OmsError(400, "Unknown action.")
    t.run("UPDATE oms_returns SET status=%s, item_condition=%s, refund_amount=%s, replacement_no=%s, events=%s WHERE id=%s",
          (r["status"], r.get("condition"), r.get("refund_amount"), r.get("replacement_no"), r["events"], r["id"]))


def _summary(t, wh, days):
    since = billing.now() - dt.timedelta(days=days)
    names = _names(t)
    orders = [o for o in _orders(t, wh) if _when(o["created_at"]) >= since]
    returns = [r for r in _returns(t, wh) if _when(r["created_at"]) >= since]
    keep = [o for o in orders if o["status"] != "cancelled"]

    def group(key):
        g = {}
        for o in keep:
            e = g.setdefault(key(o), {"name": key(o), "orders": 0, "value": 0.0})
            e["orders"] += 1
            e["value"] = round(e["value"] + o["total"], 2)
        return sorted(g.values(), key=lambda e: -e["value"])

    counts = defaultdict(int)
    for o in orders:
        counts[o["status"]] += 1
    shipped = [o for o in orders if o.get("shipped_at")]
    on_time = sum(1 for o in shipped if _when(o["shipped_at"]) <= _when(o["promised_at"]))
    hours = [(_when(o["shipped_at"]) - _when(o["created_at"])).total_seconds() / 3600 for o in shipped]
    units = {}
    for o in keep:
        for l in o["lines"]:
            e = units.setdefault(l["sku"], {"sku": l["sku"], "name": l["name"], "desc": l.get("desc", ""), "units": 0, "value": 0.0})
            e["units"] += l["qty"]
            e["value"] = round(e["value"] + l["qty"] * l["price"], 2)
    reasons = defaultdict(int)
    for r in returns:
        reasons[r["reason"]] += 1
    delivered = counts["delivered"]
    return {"days": days, "total": len(orders), "value": round(sum(o["total"] for o in keep), 2), "counts": dict(counts),
            "open": sum(1 for o in orders if o["status"] in OPEN),
            "late": [_view(o, names) for o in sorted((o for o in orders if _late(o)), key=lambda o: _when(o["promised_at"]))],
            "backorders": [_view(o, names) for o in orders if o["status"] == "backorder"],
            "on_time_pct": round(on_time / len(shipped) * 100) if shipped else None,
            "avg_ship_hours": round(sum(hours) / len(hours)) if hours else None,
            "returns_open": sum(1 for r in returns if r["status"] in ("requested", "approved", "received")),
            "return_rate_pct": round(sum(1 for r in returns if r["status"] != "rejected") / delivered * 100) if delivered else None,
            "refunded": round(sum(r["refund_amount"] or 0 for r in returns), 2),
            "by_channel": group(lambda o: o["channel"]), "by_warehouse": group(lambda o: names.get(o["wh"], "")),
            "top_products": sorted(units.values(), key=lambda e: -e["units"])[:10],
            "return_reasons": sorted(({"name": k, "count": v} for k, v in reasons.items()), key=lambda e: -e["count"])}


# ---- the requests -------------------------------------------------------------------

def _int(v, name="value"):
    try:
        return int(str(v))
    except (TypeError, ValueError):
        raise OmsError(422, f"That {name} is not a whole number.") from None


def _create_order(t, wh, body):
    at = int(body["wh"]) if str(body.get("wh") or "").isdigit() else wh
    if not at or not t.one("SELECT id FROM oms_warehouses WHERE id = %s", (at,)):
        raise OmsError(422, "Choose a warehouse.")
    if (wh and at != wh) or not _within(at):
        raise OmsError(403, "That warehouse is not the one you are working in.")
    raw = body.get("customer") if isinstance(body.get("customer"), dict) else {}
    customer = {k: _text(raw.get(k), 200) for k in ("name", "phone", "email", "city", "address")}
    if not customer["name"]:
        raise OmsError(422, "Enter the customer's name.")
    asked = [l for l in (body.get("lines") or []) if isinstance(l, dict) and _int(l.get("qty"), "quantity") > 0]
    if not asked:
        raise OmsError(422, "Add at least one product.")
    lines = []
    for a in asked:
        p = t.one("SELECT * FROM oms_products WHERE wh_id = %s AND product_id = %s", (at, _int(a.get("product_id"), "product")))
        if not p:
            raise OmsError(422, "That product is not at this warehouse.")
        lines.append({"product_id": p["product_id"], "sku": p["sku"], "name": p["name"], "desc": p["descr"],
                      "qty": _int(a["qty"], "quantity"), "price": _d(p["price"])})
    channel = body.get("channel") if body.get("channel") in CHANNELS else "Phone Order"
    rec = {"events": []}
    _event(rec, "new", f"Entered by hand ({channel})")
    new_id = insert_order(t, at, channel, "new", "COD" if body.get("payment") == "COD" else "Prepaid", customer, lines,
                          _now(), _promise(), rec["events"])
    return _detail(t, _order(t.one("SELECT * FROM oms_orders WHERE id = %s", (new_id,))))


def _create_return(t, wh, body):
    row = t.one("SELECT * FROM oms_orders WHERE id = %s", (_int(body.get("order_id"), "order"),))
    if not row or (wh and row["wh_id"] != wh) or not _within(row["wh_id"]):
        raise OmsError(404, "No such order here.")
    o = _order(row)
    if o["status"] != "delivered":
        raise OmsError(409, "Only a delivered order can be returned.")
    reason = _text(body.get("reason"))
    if not reason:
        raise OmsError(422, "Choose a reason.")
    asked = [l for l in (body.get("lines") or []) if isinstance(l, dict) and _int(l.get("qty"), "quantity") > 0]
    if not asked:
        raise OmsError(422, "Choose what is coming back.")
    back = _returned(t, o["id"])
    lines, value = [], Decimal("0")
    for a in asked:
        l = next((x for x in o["lines"] if x["product_id"] == _int(a.get("product_id"), "product")), None)
        if not l:
            raise OmsError(422, "That product is not on this order.")
        qty = _int(a["qty"], "quantity")
        left = l["qty"] - back[l["product_id"]]
        if qty > left:
            raise OmsError(422, f"Only {left} of {l['sku']} can still be returned.")
        lines.append({**l, "qty": qty, "price": _d(l["price"])})
        value += _d(l["price"]) * qty
    rec = {"events": []}
    _event(rec, "requested", reason)
    new_id = insert_return(t, o["id"], o["wh"], "requested", reason, lines, value, _now(), rec["events"])
    return next(r for r in _returns(t) if r["id"] == new_id)


def _route(t, method, path, query, wh, body):
    q = (query.get("q") or "").strip().lower()
    scoped = (lambda rec: (not wh or rec["wh"] == wh) and _within(rec["wh"]))
    if path == "summary":
        _may(("oms_dashboard", "oms_reports"), "view")
    elif path == "orders" and method == "POST":
        _may(("oms_orders",), "create")
    elif path.startswith("orders"):
        _may(("oms_orders", "oms_fulfilment", "oms_dashboard"), "modify" if method == "POST" else "view")
    elif path == "returns" and method == "POST":
        _may(("oms_orders", "oms_returns"), "create")
    elif path.startswith("returns"):
        _may(("oms_returns",), "modify" if method == "POST" else "view")
    else:
        _may(ALL_SCREENS, "view")
    if method == "GET" and path == "options":
        return {"warehouses": _warehouses(t), "couriers": COURIERS, "channels": CHANNELS, "cancel_reasons": CANCEL_REASONS,
                "hold_reasons": HOLD_REASONS, "return_reasons": RETURN_REASONS}
    if method == "GET" and path == "summary":
        days = query.get("days") or "30"
        return _summary(t, wh, max(1, min(3650, _int(days, "period"))))
    if method == "GET" and path == "products":
        at = int(query["wh"]) if (query.get("wh") or "").isdigit() else wh
        if at and not _within(at):
            raise OmsError(403, "That warehouse is not one you can work in.")
        if not at or (wh and at != wh):
            return []
        held = _reserved(t, at)
        rows = t.all("SELECT * FROM oms_products WHERE wh_id = %s ORDER BY product_id", (at,))
        out = [{"id": r["product_id"], "sku": r["sku"], "name": r["name"], "desc": r["descr"], "mrp": _n(r["mrp"]), "price": _n(r["price"]),
                "stock": int(r["stock"]), "available": int(r["stock"]) - held[r["product_id"]]} for r in rows]
        return [p for p in out if not q or q in f"{p['sku']} {p['name']} {p['desc']}".lower()]
    if path == "orders" and method == "GET":
        orders = _orders(t, wh)
        counts = defaultdict(int)
        counts["all"], counts["late"] = len(orders), sum(1 for o in orders if _late(o))
        for o in orders:
            counts[o["status"]] += 1
        status, channel = query.get("status") or "", query.get("channel") or ""
        rows = [o for o in orders
                if (not channel or o["channel"] == channel)
                and (not status or (_late(o) if status == "late" else o["status"] == status))
                and (not q or q in " ".join([o["no"], o["customer"]["name"], o["customer"].get("phone", ""), o["customer"].get("city", ""),
                                             *(l["sku"] for l in o["lines"])]).lower())]
        rows.sort(key=lambda o: _when(o["created_at"]), reverse=True)
        names = _names(t)
        return {"rows": [_view(o, names) for o in rows[:MAX_ROWS]], "counts": dict(counts), "more": len(rows) > MAX_ROWS}
    if path == "orders" and method == "POST":
        return _create_order(t, wh, body)
    parts = path.split("/")
    if parts[0] == "orders" and len(parts) in (2, 3) and parts[1].isdigit():
        row = t.one("SELECT * FROM oms_orders WHERE id = %s", (int(parts[1]),))
        o = _order(row) if row else None
        if not o or not scoped(o):
            raise OmsError(404, "No such order here.")
        if method == "GET" and len(parts) == 2:
            return _detail(t, o)
        if method == "POST" and parts[2:] == ["action"]:
            message = _order_action(t, o, body)
            return {**_detail(t, o), "message": message}
    if path == "returns" and method == "GET":
        returns = _returns(t, wh)
        counts = defaultdict(int)
        counts["all"] = len(returns)
        for r in returns:
            counts[r["status"]] += 1
        status = query.get("status") or ""
        rows = [r for r in returns if (not status or r["status"] == status)
                and (not q or q in f"{r['no']} {r['order_no']} {r['customer']}".lower())]
        rows.sort(key=lambda r: _when(r["created_at"]), reverse=True)
        return {"rows": rows[:MAX_ROWS], "counts": dict(counts), "more": len(rows) > MAX_ROWS}
    if path == "returns" and method == "POST":
        return _create_return(t, wh, body)
    if parts[0] == "returns" and len(parts) == 3 and parts[1].isdigit() and parts[2] == "action" and method == "POST":
        r = next((x for x in _returns(t) if x["id"] == int(parts[1])), None)
        if not r or not scoped(r):
            raise OmsError(404, "No such return here.")
        _return_action(t, r, body)
        return r
    raise OmsError(404, "Not found")


def handle(method, url_path, raw, me, warehouse=""):
    """One request from `me` (accounts.who); the answer, or OmsError. Asking who it is
    and switched on or off is http_handler.py's, which turns these into HTTP."""
    if not me:
        raise OmsError(401, "Please sign in.")          # returns the app to its login page
    if me.get("must_change"):
        raise OmsError(403, "Change your password first.")
    parts = urlsplit(url_path)
    path = parts.path.rstrip("/")[len("/api/oms/"):]
    query = dict(parse_qsl(parts.query))
    try:
        body = json.loads(raw or b"{}")
    except (ValueError, UnicodeDecodeError):
        raise OmsError(400, "That was not valid JSON.") from None
    if not isinstance(body, dict):
        raise OmsError(400, "That was not valid JSON.")
    wh = int(warehouse) if str(warehouse or "").isdigit() else None
    _ctx.me = me
    try:
        if wh and not _within(wh):
            raise OmsError(403, "That warehouse is not one you can work in.")
        with tx() as t:
            return _route(t, method, path, query, wh, body)
    except InvalidOperation:
        raise OmsError(422, "That amount is not a number.") from None
    finally:
        _ctx.me = None
