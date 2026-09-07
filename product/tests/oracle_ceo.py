#!/usr/bin/env python3
"""The CEO dashboard oracle: check our reading of PA against PA's own answers.

    python3 product/tests/oracle_ceo.py            every indicator the dashboard uses
    python3 product/tests/oracle_ceo.py Portfolio1 one portfolio

CmdCeo resolves a `pa_indicators` reference into something computable -- a table,
an encoded query and an aggregate for a leaf; an arithmetic tree over other
indicators for a formula; a pair of moments for one of the six scripted
elapsed-time measures. Every one of those steps is an inference about somebody
else's product, and an inference that is wrong in a plausible direction puts a
believable number on a leadership dashboard with nothing marking it as invented.

So it is checked against Performance Analytics itself. `/api/now/pa/scorecards`
returns, for an indicator, not only the value PA would print but the facts table
and the encoded query PA resolved it to. That makes two independent oracles:

  RESOLUTION  our table and query against PA's own, compared as strings
  VALUE       our count against PA's, allowing for drift

Drift is expected and is not a failure. PA's score is taken for a period -- the
sample below is labelled "Sep 06" -- while ours is live, so an open-incident count
moves between the two. A resolution mismatch is a real failure; a value that
differs by more than the tolerance is worth reading before it is believed.

This is READ ONLY. It issues GETs against the client instance and writes nothing,
which is the condition the instance was made available under.

Requires CLIENT_INSTANCE, CLIENT_USER and CLIENT_PASSWORD in the environment.
"""

import base64
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

HOST = os.environ.get("CLIENT_INSTANCE", "")
USER = os.environ.get("CLIENT_USER", "")
PASS = os.environ.get("CLIENT_PASSWORD", "")

# How far a value may sit from PA's before it is worth a second look. PA scores a
# period and we count live, so a busy table moves between the two.
VALUE_TOLERANCE = 0.02          # 2%
CONFIG_TABLE = "sn_controltower_ceo_dashboard"

AGG = {"1": "COUNT", "2": "SUM", "3": "AVG", "4": "MIN", "5": "MAX", "6": "COUNT_DISTINCT"}


def _auth():
    if not (HOST and USER and PASS):
        sys.exit("Set CLIENT_INSTANCE, CLIENT_USER and CLIENT_PASSWORD first. "
                 "This reads a client instance and must never be pointed anywhere "
                 "it could write.")
    return base64.b64encode(f"{USER}:{PASS}".encode()).decode()


def _get(path):
    req = urllib.request.Request(
        f"https://{HOST}{path}",
        headers={"Accept": "application/json", "Authorization": "Basic " + _auth()})
    with urllib.request.urlopen(req, timeout=180) as r:
        return json.load(r)


def table(name, query="", fields="", limit=200):
    """A Table API read. Fields are named explicitly: an unknown column in
    sysparm_query is ignored rather than refused, so a typo silently matches
    every row instead of failing."""
    p = (f"/api/now/table/{name}"
         f"?sysparm_query={urllib.parse.quote(query, safe='^=,!<>@')}"
         f"&sysparm_limit={limit}&sysparm_exclude_reference_link=true")
    if fields:
        p += f"&sysparm_fields={fields}"
    return _get(p).get("result", [])


def count(name, query=""):
    p = (f"/api/now/stats/{name}?sysparm_count=true"
         f"&sysparm_query={urllib.parse.quote(query, safe='^=,!<>@')}")
    return int(_get(p)["result"]["stats"]["count"])


def scorecard(uuid):
    """PA's own answer. `sysparm_uuid`, not `uuid`: the plain form is ignored and
    the endpoint answers 200 with some other indicator entirely."""
    r = _get(f"/api/now/pa/scorecards?sysparm_uuid={uuid}").get("result", [])
    return r[0] if r else None


_IND, _CUBE = {}, {}


def indicator(sid):
    if sid not in _IND:
        r = table("pa_indicators", f"sys_id={sid}",
                  "sys_id,name,type,aggregate,field,conditions,cube,formula,"
                  "scripted,script,unit", 1)
        _IND[sid] = r[0] if r else None
    return _IND[sid]


def cube(sid):
    if not sid:
        return None
    if sid not in _CUBE:
        r = table("pa_cubes", f"sys_id={sid}", "sys_id,name,facts_table,conditions", 1)
        _CUBE[sid] = r[0] if r else None
    return _CUBE[sid]


def resolve(sid, depth=0, seen=None):
    """The Python mirror of CmdCeo.resolve. Kept deliberately small: its job is to
    reach the same table and query, which is then compared against PA's."""
    seen = seen or set()
    ind = indicator(sid)
    if not ind:
        return {"kind": "refused", "why": "no such indicator"}
    if sid in seen or depth > 6:
        return {"kind": "refused", "why": "cycle or too deep"}

    if ind.get("formula"):
        refs = re.findall(r"\[\[([0-9a-f]{32})\]\]", ind["formula"])
        return {"kind": "formula", "name": ind["name"], "formula": ind["formula"],
                "refs": refs, "unit": ind.get("unit")}

    c = cube(ind.get("cube"))
    if not c or not c.get("facts_table"):
        return {"kind": "refused", "name": ind["name"], "why": "no source table"}

    q = "^".join([x for x in (c.get("conditions"), ind.get("conditions")) if x])

    if str(ind.get("scripted")).lower() == "true":
        return {"kind": "duration", "name": ind["name"], "table": c["facts_table"],
                "query": q, "agg": AGG.get(str(ind.get("aggregate")), "SUM")}

    return {"kind": "count", "name": ind["name"], "table": c["facts_table"],
            "query": q, "agg": AGG.get(str(ind.get("aggregate")), "COUNT"),
            "field": ind.get("field") or "sys_id"}


def norm(q):
    """Encoded queries are compared after normalising what PA itself varies:
    trailing `^EQ` is a clause terminator PA appends, and whitespace inside a
    stored condition is not meaningful."""
    q = (q or "").strip()
    q = re.sub(r"\s+", "", q)
    while q.endswith("^EQ"):
        q = q[:-3]
    return q


def main():
    only = sys.argv[1] if len(sys.argv) > 1 else None

    rows = table(CONFIG_TABLE, "active=true",
                 "business_function,metric_type,pa_indicator,breakdown", 200)
    if only:
        rows = [r for r in rows if r.get("business_function", "").lower() == only.lower()]
    if not rows:
        sys.exit(f"no active config rows{' for ' + only if only else ''} in {CONFIG_TABLE}")

    uuids = []
    for r in rows:
        u = r.get("pa_indicator")
        if u and u not in uuids:
            uuids.append(u)

    print(f"\n{len(rows)} slots, {len(uuids)} distinct indicators"
          f"{' in ' + only if only else ''}\n")

    res_ok = res_bad = val_ok = val_drift = skipped = 0

    for u in uuids:
        node = resolve(u)
        sc = scorecard(u)
        name = (node.get("name") or (sc or {}).get("name") or u)[:52]

        if not sc:
            print(f"  {'?':>10}  {name:52s}  PA returned no scorecard")
            skipped += 1
            continue

        if node["kind"] == "formula":
            # Nothing to compare structurally: PA reports a formula indicator's
            # resolved query as empty. The components are checked on their own,
            # since every one of them appears in this list too.
            print(f"  {'formula':>10}  {name:52s}  PA={sc.get('value_formatted')}"
                  f"  <- {len(node['refs'])} components, each checked separately")
            continue

        if node["kind"] == "refused":
            print(f"  {'REFUSED':>10}  {name:52s}  {node.get('why')}")
            skipped += 1
            continue

        pa_table = (sc.get("facts_table") or {}).get("name", "")
        same_table = (pa_table == node["table"])
        same_query = norm(sc.get("query")) == norm(node["query"])

        if same_table and same_query:
            res_ok += 1
            verdict = "resolved"
        else:
            res_bad += 1
            verdict = "RESOLUTION MISMATCH"

        line = f"  {verdict:>10}  {name:52s}"

        # Only a plain COUNT is re-counted here. A SUM or an elapsed-time measure
        # needs a row scan, which is what the product does and what a read-only
        # check across someone else's instance should not.
        if node["kind"] == "count" and node["agg"] == "COUNT":
            try:
                ours = count(node["table"], node["query"])
            except urllib.error.HTTPError as e:
                print(line + f"  count failed: HTTP {e.code}")
                continue
            pa = sc.get("value")
            if pa in (None, ""):
                print(line + f"  ours={ours}  PA had no value")
            else:
                pa = float(pa)
                drift = abs(ours - pa) / pa if pa else (0 if ours == 0 else 1)
                if drift <= VALUE_TOLERANCE:
                    val_ok += 1
                    line += f"  ours={ours:<8} PA={pa:<10.0f} ok"
                else:
                    val_drift += 1
                    line += f"  ours={ours:<8} PA={pa:<10.0f} DRIFT {drift*100:.1f}%"
                print(line)
        else:
            print(line + f"  {node['agg']} — value not re-measured here")

        if not (same_table and same_query):
            print(f"{'':14}ours: {node['table']} | {norm(node['query'])[:110]}")
            print(f"{'':14}PA:   {pa_table} | {norm(sc.get('query'))[:110]}")

    print(f"\nresolution: {res_ok} match, {res_bad} mismatch"
          f"{', ' + str(skipped) + ' skipped' if skipped else ''}")
    print(f"values:     {val_ok} within {VALUE_TOLERANCE*100:.0f}%, {val_drift} beyond it")
    print("\nA value beyond tolerance is not automatically wrong: PA scores a period "
          "and this counts live.\nA resolution mismatch is a real failure.\n")
    return 1 if res_bad else 0


if __name__ == "__main__":
    sys.exit(main())
