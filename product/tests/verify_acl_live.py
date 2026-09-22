#!/usr/bin/env python3
"""The ACL-correctness claim, proven with a real interactive login, not a trick.

    python3 product/tests/verify_acl_live.py

Every earlier version of this proof used `GlideImpersonate` inside a background
script. That is not an interactive session (`gs.isInteractive()` is false there),
and at least one table's real security config -- `incident`'s OOB "incident query"
before-query business rule -- only fires when it is. Measured 2026-09-14/22: a
role-less persona's `GlideAggregate` on `incident` is ALREADY restricted by that
rule in a real browser session, so the old "4,266 vs 815" style claim does not
reproduce there. It still holds cleanly on tables with no such rule.

This script logs in for real (POST to login.do, cookie session, exactly what a
browser does), fetches each table's dashboard payload, and reports the same
{aggregate, secure, mode} triple CmdData.aclVerdict computed live for that login.
No admin, no impersonation, no background script.

    python3 product/tests/verify_acl_live.py                    the two demo personas
    python3 product/tests/verify_acl_live.py --user someone      one login
"""
import argparse
import http.cookiejar
import json
import re
import sys
import urllib.parse
import urllib.request
import base64
from pathlib import Path

TABLES = ("incident", "problem", "change_request", "task", "kb_knowledge", "sys_user")
SCOPE_PREFIX = "x_2185255_command_"


def login_and_get(base, user, password, table):
    """A real interactive session: form login, then a GET, both cookie-based."""
    jar = http.cookiejar.CookieJar()
    op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    op.addheaders = [("User-Agent", "Mozilla/5.0")]
    op.open(f"{base}/login.do", timeout=30).read()
    body = urllib.parse.urlencode({"user_name": user, "user_password": password,
                                    "sys_action": "sysverb_login"}).encode()
    html = op.open(f"{base}/login.do", body, timeout=30).read().decode("utf-8", "replace")
    if "user_password" in html and len(html) < 20000:
        return {"error": "login rejected"}
    m = (re.search(r'name="sysparm_ck"[^>]*value="([^"]+)"', html) or
         re.search(r"var g_ck\s*=\s*'([^']+)'", html))
    token = m.group(1) if m else ""
    req = urllib.request.Request(
        f"{base}/{SCOPE_PREFIX}cmd_dashboard.do?table={table}",
        headers={"X-UserToken": token, "Accept": "text/html"})
    html2 = op.open(req, timeout=60).read().decode("utf-8", "replace")
    mm = re.search(r'data-b64="([^"]*)"', html2)
    if not mm or mm.group(1) == "null":
        return {"error": "no payload in response"}
    return json.loads(base64.b64decode(mm.group(1)).decode())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--user")
    args = ap.parse_args()

    cred_path = Path(__file__).resolve().parents[1] / "deploy" / "credentials.json"
    cred = json.loads(cred_path.read_text())
    pw = cred.get("demo_password")
    if not pw:
        sys.exit("No demo_password in product/deploy/credentials.json. "
                 "Run product/deploy/setup_app.py first.")
    base = f"https://{cred['instance']}"

    users = [args.user] if args.user else ["ceo.leader", "ceo.restricted"]
    for user in users:
        print(f"\n  {user}")
        for table in TABLES:
            p = login_and_get(base, user, pw, table)
            if p.get("error"):
                print(f"    {table:16s} ERROR  {p['error']}")
                continue
            acl = p.get("acl", {})
            gap = ""
            if acl.get("mode") == "DENIED" and acl.get("aggregate"):
                gap = f"  <-- native says {acl['aggregate']:,}, this viewer opens 0"
            print(f"    {table:16s} {acl.get('mode', '?'):9s} "
                  f"native={acl.get('aggregate')!s:>6}  readable={acl.get('secure')!s:>6}{gap}")
    print()


if __name__ == "__main__":
    main()
