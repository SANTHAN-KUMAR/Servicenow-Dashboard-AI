#!/usr/bin/env python3
"""Assemble the dashboard UI Page, validate it, deploy it, and verify it landed.

The verify step exists because a Table API PATCH answers 200 whether or not the
value it stored is the value you sent. The only trustworthy check is to read the
record back and compare it byte for byte with what was built.

Usage:  build_deploy.py <netrc-file> [--dry-run]
"""

import hashlib
import json
import subprocess
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

HERE = Path(__file__).parent
INSTANCE = "eypocinst.service-now.com"
PAGE_SYS_ID = "27cc1e7333928390c63690834d5c7bd8"


def build() -> str:
    shell = (HERE / "page.html").read_text()
    css = (HERE / "app.css").read_text()
    app = (HERE / "app.js").read_text()

    # CDATA has exactly one escape hazard: the terminator itself.
    if "]]>" in css:
        sys.exit("app.css contains ']]>' and cannot be inlined in CDATA")

    version = hashlib.sha256(app.encode()).hexdigest()[:12]
    return shell.replace("@@CSS@@", css).replace("@@APPV@@", version)


def validate(html: str) -> None:
    """Two ways this page can serve as zero bytes, both silent and both HTTP 200."""
    try:
        ET.fromstring(html)
    except ET.ParseError as e:
        sys.exit(f"XML parse failed - this would deploy as a blank page: {e}")

    # Jelly evaluates script bodies; a CDATA-wrapped one blanks the whole page.
    for el in ET.fromstring(html).iter():
        if el.tag.endswith("script") and (el.text or "").strip():
            sys.exit("A <script> element has an inline body. Jelly evaluates script "
                     "bodies and serves the whole page as 0 bytes when one is wrapped "
                     "in CDATA. Move the code to a UI Script and load it by src.")
    print(f"  XML parses clean, no inline script bodies ({len(html):,} bytes)")


def curl(netrc: str, method: str, url: str, body: dict | None = None) -> dict:
    payload = HERE / ".payload.json"
    cmd = ["curl", "-s", "--netrc-file", netrc, "-X", method, url,
           "-H", "Accept: application/json"]
    if body is not None:
        payload.write_text(json.dumps(body))
        cmd += ["-H", "Content-Type: application/json", "-d", f"@{payload}"]
    out = subprocess.run(cmd, capture_output=True, text=True).stdout
    payload.unlink(missing_ok=True)
    try:
        return json.loads(out)
    except json.JSONDecodeError:
        sys.exit(f"Non-JSON response from {url}:\n{out[:500]}")


def main() -> None:
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    netrc = sys.argv[1]

    print("Building...")
    html = build()
    validate(html)

    if "--dry-run" in sys.argv:
        (HERE / "built.html").write_text(html)
        print("  dry run - wrote built.html, nothing deployed")
        return

    print("Deploying app.js as UI Script eyd_app...")
    app = (HERE / "app.js").read_text()
    found = curl(netrc, "GET", f"https://{INSTANCE}/api/now/table/sys_ui_script"
                               "?sysparm_query=name=eyd_app&sysparm_fields=sys_id")["result"]
    rec = {"name": "eyd_app", "script": app, "active": "true", "ui_type": "0",
           "description": "EY analytics dashboard client code. Served by src because a "
                          "UI Page cannot carry it inline - see page.html."}
    if found:
        curl(netrc, "PATCH",
             f"https://{INSTANCE}/api/now/table/sys_ui_script/{found[0]['sys_id']}"
             "?sysparm_fields=sys_id", rec)
        uis = found[0]["sys_id"]
    else:
        uis = curl(netrc, "POST", f"https://{INSTANCE}/api/now/table/sys_ui_script"
                                  "?sysparm_fields=sys_id", rec)["result"]["sys_id"]
    back = curl(netrc, "GET", f"https://{INSTANCE}/api/now/table/sys_ui_script/{uis}"
                              "?sysparm_fields=script")["result"]["script"]
    if back != app:
        sys.exit(f"MISMATCH on eyd_app - sent {len(app):,}, instance holds {len(back):,}")
    print(f"  eyd_app holds exactly what was built ({len(back):,} bytes)")

    print("Deploying page...")
    base = f"https://{INSTANCE}/api/now/table/sys_ui_page/{PAGE_SYS_ID}"
    curl(netrc, "PATCH", base + "?sysparm_fields=sys_id", {"html": html})

    print("Verifying...")
    stored = curl(netrc, "GET", base + "?sysparm_fields=html")["result"]["html"]
    if stored != html:
        sys.exit(f"MISMATCH - sent {len(html):,} bytes, instance holds "
                 f"{len(stored):,}. The page was NOT updated.")
    print(f"  instance holds exactly what was built ({len(stored):,} bytes)")
    print(f"\nLive at https://{INSTANCE}/ey_ai_dashboard.do")


if __name__ == "__main__":
    main()
