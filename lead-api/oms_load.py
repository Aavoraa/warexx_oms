"""Put products into the OMS database (oms.py). Run by hand, or by run-local.mjs.

    python lead-api/oms_load.py --sample [--if-empty]    the demo's sample warehouses,
                                                         products, orders and returns
    python lead-api/oms_load.py --products file.csv      your own products

The CSV has a header row:
    warehouse_code,warehouse_name,sku,name,description,mrp,price,stock
A SKU already at that warehouse has its details and stock replaced; orders are left alone.

The database is OMS_DATABASE_URL, or the local SQLite file. --sample refuses a
database that already has warehouses, so it can never mix into real data.
"""
import argparse
import csv
import datetime as dt
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import billing  # noqa: E402
import oms  # noqa: E402

SEED = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "demo-data", "recorded", "bodies", "oms-seed.json")


def load_sample(if_empty=False, path=SEED):
    with open(path, encoding="utf-8") as f:
        seed = json.load(f)

    def ago(h):
        return None if h is None else billing.iso(billing.now() - dt.timedelta(hours=h))

    def dated(events):
        return [{"at": ago(e["at_h"]), "status": e["status"], "note": e["note"], "by": e["by"]} for e in events]

    with oms.tx() as t:
        if t.one("SELECT id FROM oms_warehouses LIMIT 1"):
            if if_empty:
                return "the OMS database already has data: left as it is"
            raise SystemExit("The OMS database already has warehouses. --sample only loads into an empty one.")
        for w in seed["warehouses"]:
            t.run("INSERT INTO oms_warehouses (id, name, code) VALUES (%s, %s, %s)", (w["id"], w["name"], w["code"]))
        for wh, products in seed["products"].items():
            for p in products:
                t.run("INSERT INTO oms_products (wh_id, product_id, sku, name, descr, mrp, price, stock) VALUES (%s,%s,%s,%s,%s,%s,%s,%s)",
                      (int(wh), p["id"], p["sku"], p["name"], p["desc"], str(p["mrp"]), str(p["price"]), p["stock"]))
        ids = {}
        for o in seed["orders"]:
            ids[o["id"]] = oms.insert_order(
                t, o["wh"], o["channel"], o["status"], o["payment"], o["customer"], o["lines"], ago(o["age_h"]), ago(o["promised_h"]),
                dated(o["events"]), shipped_at=ago(o.get("shipped_h")), delivered_at=ago(o.get("delivered_h")),
                courier=o.get("courier"), awb=o.get("awb"), hold_reason=o.get("hold_reason"), held_from=o.get("held_from"),
                cancel_reason=o.get("cancel_reason"))
        for r in seed["returns"]:
            oms.insert_return(t, ids[r["order_id"]], r["wh"], r["status"], r["reason"], r["lines"], str(r["value"]), ago(r["age_h"]),
                              dated(r["events"]), condition=r.get("condition"),
                              refund_amount=None if r.get("refund_amount") is None else str(r["refund_amount"]))
    return f"loaded {len(seed['warehouses'])} warehouses, {len(seed['orders'])} orders and {len(seed['returns'])} returns of sample data"


def load_products(path):
    need = {"warehouse_code", "warehouse_name", "sku", "name", "mrp", "price", "stock"}
    with open(path, encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        missing = need - set(reader.fieldnames or [])
        if missing:
            raise SystemExit(f"{path}: missing columns: {', '.join(sorted(missing))}")
        rows = list(reader)
    count = 0
    with oms.tx() as t:
        for n, r in enumerate(rows, 2):
            code, sku = r["warehouse_code"].strip(), r["sku"].strip()
            try:
                mrp, price, stock = oms._d(r["mrp"]), oms._d(r["price"]), int(r["stock"])
            except (ArithmeticError, ValueError):
                raise SystemExit(f"{path}, line {n}: mrp, price and stock must be numbers. Nothing was loaded.") from None
            if not code or not sku or stock < 0:
                raise SystemExit(f"{path}, line {n}: needs a warehouse_code, a sku and stock of 0 or more. Nothing was loaded.")
            w = t.one("SELECT id FROM oms_warehouses WHERE code = %s", (code,))
            wh = w["id"] if w else t.insert("INSERT INTO oms_warehouses (name, code) VALUES (%s, %s)", (r["warehouse_name"].strip() or code, code))
            old = t.one("SELECT product_id FROM oms_products WHERE wh_id = %s AND sku = %s", (wh, sku))
            desc = (r.get("description") or "").strip()
            if old:
                t.run("UPDATE oms_products SET name=%s, descr=%s, mrp=%s, price=%s, stock=%s WHERE wh_id=%s AND product_id=%s",
                      (r["name"].strip(), desc, mrp, price, stock, wh, old["product_id"]))
            else:
                last = t.one("SELECT COALESCE(MAX(product_id), 0) AS m FROM oms_products WHERE wh_id = %s", (wh,))["m"]
                t.run("INSERT INTO oms_products (wh_id, product_id, sku, name, descr, mrp, price, stock) VALUES (%s,%s,%s,%s,%s,%s,%s,%s)",
                      (wh, int(last) + 1, sku, r["name"].strip(), desc, mrp, price, stock))
            count += 1
    return f"loaded {count} products"


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="Put products into the OMS database.")
    ap.add_argument("--sample", action="store_true", help="the demo's sample warehouses, products, orders and returns")
    ap.add_argument("--if-empty", action="store_true", help="with --sample: do nothing if there is already data")
    ap.add_argument("--products", metavar="FILE.csv", help="your own products")
    a = ap.parse_args()
    if bool(a.sample) == bool(a.products):
        ap.error("choose one of --sample or --products")
    print("[oms] " + (load_sample(a.if_empty) if a.sample else load_products(a.products)))
