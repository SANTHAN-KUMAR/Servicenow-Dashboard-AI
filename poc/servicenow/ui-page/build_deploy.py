#!/usr/bin/env python3
"""Assemble the dashboard UI Page, validate it, deploy it, and verify it landed.

The verify step exists because a Table API PATCH answers 200 whether or not the
value it stored is the value you sent. The only trustworthy check is to read the
record back and compare it byte for byte with what was built.

Usage:  build_deploy.py <netrc-file> [--dry-run]
"""

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
    for name, body in (("app.css", css), ("app.js", app)):
        if "]]>" in body:
            sys.exit(f"{name} contains ']]>' and cannot be inlined in CDATA")

    return shell.replace("@@CSS@@", css).replace("@@APP@@", app)


def validate(html: str) -> None:
    """UI Pages are parsed as XML. An undefined entity serves a blank page."""
    try:
        ET.fromstring(html)
    except ET.ParseError as e:
        sys.exit(f"XML parse failed - this would deploy as a blank page: {e}")
    print(f"  XML parses clean ({len(html):,} bytes)")


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

    print("Deploying...")
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
