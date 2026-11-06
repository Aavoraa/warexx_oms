"""The lead API as ONE app — the `api` service in vercel.json (Vercel Services).

Vercel Services runs a Python service from a single entrypoint (`vercel_app:app`)
rather than one function per file, so this is that entrypoint: a WSGI app that
hands each request to the same handlers the local server (server.py) and the
per-file functions (../api/*.py) use. Nothing about what a request does changes —
only how it arrives.

    /api/leads  /api/trial  /api/admin  /api/subscribe  /api/oms/*  /api/auth/*  /api/users*
    /api/payment/return  /api/payment/webhook      -> http_handler.LeadHandler
    /api/geo                                        -> the visitor's country

The service receives the original public path (vercel.json routes /api/... here
unchanged), which is exactly what LeadHandler routes on.
"""
import io
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from http_handler import LeadHandler  # noqa: E402


class _Handler(LeadHandler):
    # Serverless: send before answering, the process may be frozen once the answer is out.
    send_in_background = False

    def __init__(self, raw, client):          # noqa: D401 — no socket: the request is already read
        self.rfile = io.BytesIO(raw)
        self.wfile = io.BytesIO()
        self.client_address = (client, 0)
        self.server = None
        self.request = None
        self.close_connection = True
        self.handle_one_request()


def _geo(environ):
    """The two-letter country Vercel located the visitor in (x-vercel-ip-country);
    the same answer as ../api/geo.py. Nothing is stored or logged."""
    country = (environ.get("HTTP_X_VERCEL_IP_COUNTRY") or "").strip().upper()
    if len(country) != 2 or not country.isalpha():
        country = ""
    body = json.dumps({"country": country}).encode()
    return "200 OK", [("Content-Type", "application/json"), ("Cache-Control", "private, no-store"),
                      ("Content-Length", str(len(body)))], body


def _raw_request(environ):
    """The request as the bytes an HTTP server would have read off the socket."""
    method = environ.get("REQUEST_METHOD", "GET")
    path = environ.get("PATH_INFO") or "/"
    if environ.get("QUERY_STRING"):
        path += "?" + environ["QUERY_STRING"]
    try:
        length = int(environ.get("CONTENT_LENGTH") or 0)
    except ValueError:
        length = 0
    body = environ["wsgi.input"].read(length) if length else b""
    lines = [f"{method} {path} HTTP/1.1"]
    for k, v in environ.items():
        if k.startswith("HTTP_"):
            lines.append(k[5:].replace("_", "-").title() + ": " + v)
    if environ.get("CONTENT_TYPE"):
        lines.append("Content-Type: " + environ["CONTENT_TYPE"])
    lines.append(f"Content-Length: {len(body)}")
    return ("\r\n".join(lines) + "\r\n\r\n").encode("latin-1") + body


def _parse_response(data):
    head, _, body = data.partition(b"\r\n\r\n")
    first, *rest = head.decode("latin-1").split("\r\n")
    status = first.split(" ", 1)[1] if " " in first else "500 Internal Server Error"
    headers = []
    for line in rest:
        if ":" in line:
            k, v = line.split(":", 1)
            if k.strip().lower() not in ("server", "date", "connection"):
                headers.append((k.strip(), v.strip()))
    return status, headers, body


def app(environ, start_response):
    path = (environ.get("PATH_INFO") or "/").rstrip("/")
    if path == "/api/geo":
        status, headers, body = _geo(environ)
    else:
        client = (environ.get("HTTP_X_FORWARDED_FOR") or environ.get("REMOTE_ADDR") or "").split(",")[0].strip()
        h = _Handler(_raw_request(environ), client or "0.0.0.0")
        status, headers, body = _parse_response(h.wfile.getvalue())
    start_response(status, headers)
    return [body]
