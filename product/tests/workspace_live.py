#!/usr/bin/env python3
"""Workspace -> COMMAND end to end, with a count oracle.

    python3 product/tests/workspace_live.py                 as admin
    python3 product/tests/workspace_live.py --user ceo.leader
    python3 product/tests/workspace_live.py --shots /tmp/ws

Runs workspace_live.mjs (a real browser clicking "Analyse in COMMAND" on real
Service Operations Workspace lists) and then checks each result against the
platform itself:

  1. the query the analysis ran is the list's query -- the list definition's own
     condition (read from sys_ux_list here, independently of CmdWorkspace) is
     contained in it, so "Open" never silently becomes "All";
  2. for admin, the row count equals the platform's own ACL-enforced count of
     that exact query (Table API X-Total-Count), so the modal counts what the
     list counts;
  3. a column group-by arrives as the leading breakdown, a row selection arrives
     as exactly those rows, and the modal renders without a failed panel.

Exit status is non-zero if any scenario fails, so this can gate a deploy.
"""

import argparse
import json
import subprocess
import sys
import urllib.parse
from pathlib import Path

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE.parent / "deploy"))
from snclient import Instance  # noqa: E402

LISTS = {"s1": "7ae4da1ec3013010965e070e9140dd66", "s2": "b16a321ac3013010965e070e9140dd3a",
         "s3": "7ae4da1ec3013010965e070e9140dd66", "s4": "b16a321ac3013010965e070e9140dd3a",
         "s5": "cabc35660b023010bac9818393673a21", "s6": "12103f09533330105264ddeeff7b127e",
         "s7": "39c0de18c3753010965e070e9140ddd3", "s8": "c8725c5553b330105264ddeeff7b1212",
         "s9": "1e44b5eb53313010b569ddeeff7b129f", "s10": "b16a321ac3013010965e070e9140dd3a",
         "s11": "b16a321ac3013010965e070e9140dd3a"}


def secure_count(inst, table, query):
    """The Table API's X-Total-Count: the platform's row-ACL-enforced count of a
    query, which is what the workspace list itself shows. The Aggregate API is
    the wrong oracle -- it is a GlideAggregate and ignores row-level ACLs, so on
    kb_knowledge it counts 757 where an admin can open 750."""
    import urllib.request
    url = (f"{inst.base}/api/now/table/{table}?sysparm_limit=1&sysparm_fields=sys_id"
           f"&sysparm_query=" + urllib.parse.quote(query))
    req = urllib.request.Request(url, headers={"Accept": "application/json",
                                               "X-UserToken": inst.token})
    with inst._op.open(req, timeout=180) as r:
        return int(r.headers.get("X-Total-Count"))


def clean(q):
    return "^".join(p for p in (q or "").split("^")
                    if p and p != "EQ" and not p.startswith("ORDERBY") and not p.startswith("GROUPBY"))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--user", default=None)
    ap.add_argument("--shots", default=None)
    ap.add_argument("--only", default=None)
    a = ap.parse_args()

    cmd = ["node", str(HERE / "workspace_live.mjs")]
    for k in ("user", "shots", "only"):
        if getattr(a, k):
            cmd += [f"--{k}", getattr(a, k)]
    out = subprocess.run(cmd, capture_output=True, text=True, timeout=2400).stdout
    results = [json.loads(l) for l in out.splitlines() if l.startswith("{")]

    inst = Instance(verbose=False).login()
    admin = not a.user
    failed = 0
    print()
    for r in results:
        if r.get("summary"):
            if r["pageExceptionsFromCommand"]:
                failed += 1
                print("  FAIL  page exceptions from COMMAND:", r["pageExceptionsFromCommand"])
            continue
        problems = []
        # Platform gate, measured 2026-09-23: a list header action is not sent to
        # a user whose table-level, context-free canRead() is false -- the same
        # gate that hides Edit and New. For ceo.leader that is task, kb_knowledge
        # and sys_report. Expected absence, not a failure.
        GATED = {"ceo.leader": {"s5", "s6", "s12"}}
        if (r.get("fail") == "the Analyse in COMMAND button never appeared"
                and r["id"] in GATED.get(a.user or "", set())):
            print(f"  gate {r['id']} {r['name'][:52]:52s} header actions hidden by the "
                  f"platform for this user (table-level canRead false)")
            continue
        if r.get("fail"):
            problems.append(r["fail"])
        else:
            if r.get("error"):
                problems.append("refused: " + r["error"])
            if r.get("renderErrors"):
                problems.append("panel failed to render")
            ul = (inst.get_one("sys_ux_list", f"sys_id={LISTS[r['id']]}", ["condition", "fixed_query"])
                  if r["id"] in LISTS else None)
            want = clean(ul.get("condition")) if ul else ""
            query = r.get("query") or ""
            w = r.get("workspace") or {}
            # Every clause of the list's own condition must be in the analysed
            # query. Clauses using the bare global helpers are resolved to
            # literals by CmdWorkspace, so for those only the field is checked.
            for clause in (want.split("^") if want and not w.get("selected") else []):
                probe = clause.split("javascript:getMy")[0] if "javascript:getMy" in clause else clause
                probe = probe.rstrip("=!").replace("NOT IN", "").rstrip()
                if probe.startswith("OR"):
                    probe = probe[2:]
                if probe not in query:
                    problems.append(f"list clause {clause!r} missing from analysed query {query!r}")
            if r.get("emptyList"):
                # An empty list says so on the picker instead of offering columns.
                if r.get("rows") != 0 or r.get("pickerShown"):
                    problems.append("empty list, but the picker still offered columns")
            elif r.get("pickerShown") and r.get("tileClicked") not in (None, "Whole-list overview"):
                fm = r.get("fieldMode") or {}
                if fm.get("label") != r.get("tileClicked"):
                    problems.append(f"chose {r.get('tileClicked')!r}, analysis is about {fm.get('label')!r}")
            if r["id"] == "s3" and w.get("group") != "priority":
                problems.append(f"group-by did not arrive (got {w.get('group')!r})")
            if r["id"] == "s10":
                rec = w.get("record") or {}
                if not rec.get("ok") or not rec.get("facts"):
                    problems.append(f"no record context in the modal: {rec}")
                elif "This record" not in (r.get("recordStrip") or ""):
                    problems.append("record strip not drawn")
            if r["id"] == "s11":
                if w.get("group") != "state" or r.get("focusField") != "state":
                    problems.append(f"picker choice did not arrive (group={w.get('group')!r}, "
                                    f"focus={r.get('focusField')!r})")
                elif "state" not in (r.get("panelFields") or []) and not any(
                        "State" in n for n in r.get("notes") or []):
                    problems.append("State neither drawn nor explained")
            if r["id"] == "s10" and r.get("rows") in (0, 1):
                problems.append("one ticked row analysed as a one-row set, not in context")
            if r["id"] == "s12":
                rep = r.get("report") or {}
                if not rep.get("sysId"):
                    problems.append("the ticked report did not open as a converted report")
                else:
                    back = inst.get_one("sys_report", f"sys_id={rep['sysId']}", ["table", "filter"])
                    if not back or back.get("table") != r.get("table"):
                        problems.append(f"analysed {r.get('table')}, the report is on {back and back.get('table')}")
            if r["id"] == "s4" and r.get("rows") != len((w.get("selected") or "").split(",")):
                problems.append("selection count differs from rows analysed")
            oracle = None
            if admin and not problems and not r.get("emptyList"):
                oracle = secure_count(inst, r["table"], query)
                acl = r.get("acl") or {}
                if acl.get("mode") == "BOUNDED" and acl.get("capped"):
                    # Expensive per-row ACLs (kb_knowledge user criteria): the engine
                    # proves a floor inside its time budget and labels it BOUNDED on
                    # screen. Correct means the floor never exceeds the truth.
                    if not (0 <= r.get("rows", -1) <= oracle):
                        problems.append(f"bounded floor {r.get('rows')} exceeds platform count {oracle}")
                elif oracle != r.get("rows"):
                    problems.append(f"analysed {r.get('rows')} rows, platform counts {oracle}")
        status = "FAIL" if problems else "ok  "
        failed += bool(problems)
        print(f"  {status} {r['id']} {r['name'][:52]:52s} rows={r.get('rows')!s:>5} "
              f"oracle={oracle if not r.get('fail') and admin else '-'!s:>5} "
              f"render={r.get('clickToRenderMs')}ms")
        if not problems:
            print(f"         strip: {(r.get('stripText') or '')[:120]}")
        for p in problems:
            print(f"         {p}")
    print(f"\n  {len([r for r in results if not r.get('summary')]) - failed} passed, {failed} failed\n")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
