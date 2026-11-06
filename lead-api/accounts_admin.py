"""Make the first Super Admin, the one account the Users & Access screen cannot make.

    python lead-api/accounts_admin.py --username owner [--full-name "Your Name"]
        prints a one-time password, which must be changed at the first sign-in

    --if-none              do nothing if there are already accounts
    --password-file PATH   write the one-time password there instead of printing it

The database is OMS_DATABASE_URL, or the local SQLite file (see oms.py).
"""
import argparse
import os
import secrets
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import accounts  # noqa: E402
import oms  # noqa: E402


def main():
    ap = argparse.ArgumentParser(description="Make the first Super Admin.")
    ap.add_argument("--username", required=True)
    ap.add_argument("--full-name", default="")
    ap.add_argument("--if-none", action="store_true", help="do nothing if there are already accounts")
    ap.add_argument("--password-file", help="write the one-time password here instead of printing it")
    a = ap.parse_args()
    if a.if_none and accounts.has_any():
        print("[accounts] accounts already exist: left as they are")
        return
    password = secrets.token_urlsafe(15)
    try:
        with oms.tx() as t:
            row = accounts.create(t, a.username, password, "superadmin", a.full_name, "setup")
    except accounts.AccountError as e:
        raise SystemExit(e.detail) from None
    if a.password_file:
        os.makedirs(os.path.dirname(os.path.abspath(a.password_file)), exist_ok=True)
        fd = os.open(a.password_file, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(f"username: {row['username']}\none-time password: {password}\n")
        print(f"[accounts] made Super Admin '{row['username']}'; one-time password in {a.password_file}")
    else:
        print(f"[accounts] made Super Admin '{row['username']}'. One-time password, shown once:\n\n    {password}\n")


if __name__ == "__main__":
    main()
