#!/usr/bin/env python3
"""Back up COMMAND Analytics off the PDI, in two independent formats, verified.

    python3 product/deploy/backup.py                     XML snapshot (read-only on the PDI)
    python3 product/deploy/backup.py --release 0.3.0     also publish + export the update set

Why two formats. A PDI can be reclaimed and reset with nothing recoverable, so
the application has to exist somewhere that is not the PDI, in a form a fresh
instance accepts. Three things are kept, and any one of them is enough to rebuild:

  1. Source in git. product/ is the application: deploy.py, setup_app.py and
     workspace.py rebuild every record from it onto an empty instance. This is
     the primary copy and it is what code review and history run on.
  2. The update set (--release). The platform's own transfer format, produced by
     "Publish to Update Set" and "Export to XML" (package.py). What the client
     imports: Retrieved Update Sets -> Import Update Set from XML -> Preview ->
     Commit. Written to product/dist/ and committed.
  3. An XML unload of every record in the application scope, one file per
     record type (this script, always). Independent of the update-set machinery:
     each file is what the list's own Export -> XML produces and what System
     Import Sets -> Import XML accepts, sys_ids intact. It exists because an
     update set that fails to preview cleanly on a target is a bad moment to
     discover you have no other copy.

The snapshot is read-only against the PDI: it only GETs. It is checked before it
is trusted -- every file must parse as XML and hold exactly the number of records
the instance reports for that type -- and a manifest records sizes and SHA-256
so a later copy can be verified byte for byte.

What none of these carry, by design of the platform: task data (incidents and so
on -- product/deploy/seed.py regenerates the demo shape), users and their role
grants (setup_app.py recreates the personas), and user preferences. See
docs/use-case-2/24-workspace-integration-and-backup.md.
"""

import argparse
import datetime
import hashlib
import json
import subprocess
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from snclient import Instance, InstanceError  # noqa: E402

SCOPE = "x_2185255_command"
REPO = Path(__file__).resolve().parents[2]
OUT_ROOT = REPO / "backup" / "pdi"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--release", default=None,
                    help="also publish the app to an update set with this version and "
                         "export it to product/dist (writes to the PDI)")
    ap.add_argument("--credentials", default=None)
    args = ap.parse_args()

    inst = Instance(args.credentials, verbose=False).login()
    app = inst.get_one("sys_app", f"scope={SCOPE}", ["sys_id", "name", "version"])
    if not app:
        raise InstanceError(f"no application {SCOPE} on {inst.host}")
    scope_id = app["sys_id"]

    stamp = datetime.datetime.now().strftime("%Y-%m-%dT%H%M%S")
    out = OUT_ROOT / stamp
    out.mkdir(parents=True, exist_ok=True)
    print(f"\n  snapshot of {app['name']} {app['version']} on {inst.host}\n  -> {out.relative_to(REPO)}\n")

    # What the application is made of, by record type, as the instance sees it.
    rows = inst.query("sys_metadata", f"sys_scope={scope_id}", ["sys_class_name"], limit=5000)
    counts = {}
    for r in rows:
        counts[r["sys_class_name"]] = counts.get(r["sys_class_name"], 0) + 1
    # The application record itself is not a sys_metadata row.
    counts["sys_app"] = 1

    manifest = {"instance": inst.host, "app": app["name"], "scope": SCOPE,
                "version": app["version"], "taken": stamp, "files": {}}
    try:
        manifest["git"] = subprocess.run(["git", "-C", str(REPO), "rev-parse", "HEAD"],
                                         capture_output=True, text=True).stdout.strip()
    except OSError:
        manifest["git"] = None

    problems = []
    for table in sorted(counts):
        query = f"sys_id={scope_id}" if table == "sys_app" else f"sys_scope={scope_id}"
        body = inst.fetch(f"/{table}.do?XML&sysparm_query={query}"
                          f"&sysparm_default_export_fields=all")
        try:
            root = ET.fromstring(body.encode("utf-8"))
        except ET.ParseError as e:
            problems.append(f"{table}: export is not XML ({e})")
            continue
        got = sum(1 for el in root if el.tag == table)
        want = counts[table]
        f = out / f"{table}.xml"
        f.write_text(body, encoding="utf-8")
        digest = hashlib.sha256(body.encode("utf-8")).hexdigest()
        manifest["files"][f.name] = {"records": got, "expected": want,
                                     "bytes": len(body.encode("utf-8")), "sha256": digest}
        mark = "ok" if got == want else f"## EXPECTED {want}"
        print(f"    {table:36s} {got:>4} records  {len(body):>9,}b  {mark}")
        if got != want:
            problems.append(f"{table}: exported {got}, instance has {want}")

    if args.release:
        print(f"\n  publishing update set {args.release} ...")
        res = subprocess.run([sys.executable, str(Path(__file__).parent / "package.py"),
                              "--version", args.release]
                             + (["--credentials", args.credentials] if args.credentials else []),
                             capture_output=True, text=True)
        print("    " + res.stdout.strip().replace("\n", "\n    "))
        if res.returncode != 0:
            problems.append("update set publish failed: " + res.stderr.strip()[-400:])
        else:
            us = REPO / "product" / "dist" / f"COMMAND-Analytics-{args.release}-update-set.xml"
            data = us.read_bytes()
            ET.fromstring(data)                       # must parse, or it is not a backup
            manifest["update_set"] = {"file": str(us.relative_to(REPO)), "bytes": len(data),
                                      "sha256": hashlib.sha256(data).hexdigest()}

    (out / "MANIFEST.json").write_text(json.dumps(manifest, indent=2))
    total = sum(v["records"] for v in manifest["files"].values())
    print(f"\n  {total} records in {len(manifest['files'])} files, manifest written")
    if problems:
        print("\n  BACKUP INCOMPLETE:\n    " + "\n    ".join(problems) + "\n")
        return 1
    print("  every file parsed and matched the instance's own count\n")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except InstanceError as e:
        print(f"\n  BACKUP ABORTED: {e}\n", file=sys.stderr)
        sys.exit(1)
