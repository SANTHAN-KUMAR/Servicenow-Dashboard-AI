#!/usr/bin/env python3
"""Capture real dashboard payloads from the instance as renderer fixtures.

The renderer tests need data with the shapes the instance actually produces, not
data we invented. Invented fixtures agree with whatever the renderer already does;
captured ones disagree, which is the entire point of having them.

Fixtures are checked in so the suite runs offline, and so a payload that once broke
a renderer stays in the suite permanently rather than depending on the instance
still holding that data six months from now.

    python3 product/tests/capture_payloads.py [table ...]
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "deploy"))
from snclient import Instance  # noqa: E402

OUT = Path(__file__).parent / "fixtures"

# Chosen for shape coverage rather than for importance: between them these reach
# every form the instance can currently produce, including the degenerate cases
# (a subject with one row, a subject whose ACL scan is bounded) that are exactly
# where renderers divide by zero.
DEFAULT = [
    "incident",
    "change_request",
    "problem",
    "task",
    "sc_request",
    "kb_knowledge",
    "cmdb_ci",
    "sys_user",
    "sc_req_item",
    "asmt_assessment_instance",
]

SCRIPT = """
var out = {};
%s
gs.print('@@' + JSON.stringify(out));
"""


def capture(inst, tables):
    OUT.mkdir(exist_ok=True)
    written = []

    for table in tables:
        body = (
            "try { out = new CmdPayload().dashboard(%r, [], {}); } "
            "catch (e) { out = { captureError: '' + (e.message || e) }; }"
            % table
        )
        try:
            payload = inst.run_json(SCRIPT % body)
        except Exception as exc:                       # noqa: BLE001
            print(f"  {table:<28} SKIPPED: {exc}")
            continue

        if payload.get("captureError"):
            print(f"  {table:<28} ERROR: {payload['captureError']}")
            continue

        path = OUT / f"{table}.json"
        path.write_text(json.dumps(payload, indent=1), encoding="utf-8")
        panels = len(payload.get("panels", []))
        kpis = len(payload.get("kpis", []))
        size = path.stat().st_size
        print(f"  {table:<28} {panels} panels, {kpis} kpis, {size:>7,}b")
        written.append(table)

    # The catalog is a different surface with a different payload shape, and it
    # has its own renderer, so it needs its own fixture.
    try:
        cat = inst.run_json(SCRIPT % "out = new CmdCatalog().build();")
        (OUT / "catalog.json").write_text(json.dumps(cat, indent=1), encoding="utf-8")
        print(f"  {'catalog':<28} {len(cat.get('cards', []))} cards")
        written.append("catalog")
    except Exception as exc:                           # noqa: BLE001
        print(f"  {'catalog':<28} SKIPPED: {exc}")

    return written


def main():
    tables = sys.argv[1:] or DEFAULT
    inst = Instance(None, verbose=False).login()
    print(f"\ncapturing {len(tables)} payloads into {OUT}\n")
    written = capture(inst, tables)
    print(f"\n{len(written)} fixtures written\n")


if __name__ == "__main__":
    main()
