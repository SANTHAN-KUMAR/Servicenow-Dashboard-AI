#!/usr/bin/env python3
"""Every delivered surface, against a live instance.

    python3 product/tests/acceptance_live.py
    python3 product/tests/acceptance_live.py --global    the fallback deployment

The offline suite covers the engine. This covers the product: that each page a
client will open actually renders, that its numbers are permission-checked rather
than a floor, and that the things they click go where they say they go.

On what it does *not* assert. Panel count is deliberately not pinned. The page has
a wall-clock scan budget and spends it on reductions, so on a loaded instance it
draws fewer panels rather than taking longer -- that is the design, and the same
instance has been measured at 0.23ms and 1.29ms per permission-checked row a day
apart. Asserting eleven panels would be asserting that the instance is quiet.

What is pinned instead is correctness: the verdict is VERIFIED and not a floor,
every card is measured, every link resolves, and a drill that matches nothing says
so. Those hold whatever the instance is doing. Starvation is reported as
information, because it is worth seeing, not as a failure.
"""

import argparse
import base64
import json
import re
import sys
import urllib.parse
import urllib.request
import html
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "deploy"))
from snclient import Instance, InstanceError  # noqa: E402

SCOPE_PREFIX = "x_2185255_command_"
PANEL_FLOOR = 6          # below this the page is not showing a dashboard at all


def seg(field, key):
    return (urllib.parse.quote(field, safe="") + ":" +
            urllib.parse.quote(key, safe=""))


class Surface:
    def __init__(self, inst, prefix):
        self.inst, self.prefix = inst, prefix

    def url(self, page, qs=""):
        return f"/{self.prefix}cmd_{page}.do{qs}"

    def payload(self, page, qs=""):
        # A card's analysisUrl is a bare query string relative to the dashboard,
        # which is what the browser resolves it against.
        path = self.url("dashboard", page) if page.startswith("?") else self.url(page, qs)
        req = urllib.request.Request(
            f"{self.inst.base}{path}",
            headers={"X-UserToken": self.inst.token, "Accept": "text/html"})
        with self.inst._op.open(req, timeout=300) as r:
            html = r.read().decode("utf-8", "replace")
        m = re.search(r'data-b64="([^"]*)"', html)
        if not m or m.group(1) == "null":
            return None
        return json.loads(base64.b64decode(m.group(1)).decode("utf-8"))


def ajax(inst, method, **params):
    """A GlideAjax call exactly as the page makes it: POST xmlhttp.do."""
    body = {"sysparm_processor": f"{SCOPE_PREFIX[:-1]}.CmdCeoAjax", "sysparm_name": method}
    body.update(params)
    req = urllib.request.Request(
        f"{inst.base}/xmlhttp.do", data=urllib.parse.urlencode(body).encode(), method="POST",
        headers={"Content-Type": "application/x-www-form-urlencoded",
                 "X-UserToken": inst.token, "Accept": "application/xml"})
    with inst._op.open(req, timeout=300) as r:
        xml = r.read().decode("utf-8", "replace")
    m = re.search(r'answer="([^"]*)"', xml)
    return json.loads(html.unescape(m.group(1))) if m else {"error": "no answer: " + xml[:200]}


def ceo_checks(s, check, notes):
    f = s.payload("ceo")
    check("CEO page: frame renders", f and f.get("view") == "ceo" and f.get("portfolios"),
          f"{len(f.get('portfolios') or [])} portfolios, frame {f.get('frameMs')}ms" if f else "no payload")
    if not f or not f.get("portfolios"):
        return
    ids = list(f["indicators"].keys())
    check("CEO page: calls ordered hero first", [g["name"] for g in f.get("groups", [])][:1] == ["hero"],
          ", ".join(f"{g['name']}:{len(g['ids'])}" for g in f.get("groups", [])))

    m = ajax(s.inst, "measures", sysparm_ids=",".join(ids), sysparm_period="30d", sysparm_nocache="1")
    res = m.get("results") or {}
    check("CEO measures: every indicator answered", len(res) == len(ids) and not m.get("error"),
          f"{len(res)} of {len(ids)}, {m.get('serverMs')}ms server")
    head = res.get(f["headline"]) or {}
    check("CEO measures: headline measured", head.get("ok") and head.get("value") is not None,
          f"{head.get('name')} = {head.get('value')}")
    modes = {t: v["mode"] for t, v in (m.get("tables") or {}).items()}
    check("CEO measures: every table proved", modes and all(v in ("VERIFIED", "FILTERED", "BOUNDED", "DENIED")
                                                          for v in modes.values()), str(modes))

    bad = ajax(s.inst, "measures", sysparm_ids=",".join(ids[:3]), sysparm_period="999d",
               sysparm_filters="category:software^ORsys_idISNOTEMPTY|caller_id:x")
    check("CEO measures: bad period and injected filter are refused",
          bad.get("period") == f.get("period") and bad.get("filters") == [],
          f"period {bad.get('period')}, filters {bad.get('filters')}")

    bd = ajax(s.inst, "breakdown", sysparm_portfolio=f["portfolios"][0]["key"], sysparm_period="30d")
    check("CEO breakdown: a panel for the first portfolio", bd.get("panel") or bd.get("why"),
          (bd["panel"]["form"] + f", {bd.get('total')} records") if bd.get("panel") else bd.get("why", ""))

    # A card's analysis counts the same rows as the card.
    new_id = next((i for i, d in f["indicators"].items() if d["name"] == "Number of new incidents"), None)
    if new_id and res.get(new_id, {}).get("ok"):
        port = next(p["key"] for p in f["portfolios"] if any(sl["id"] == new_id for sl in p["slots"]))
        a = s.payload("dashboard", f"?portfolio={port}&measure={new_id}&period=30d")
        rows = a["subject"]["rows"] if a else None
        check("CEO: a card's analysis counts the card's rows", rows == res[new_id]["value"],
              f"card {res[new_id]['value']}, analysis {rows}; {(a or {}).get('measure', {}).get('slice', '')}")

    w = s.payload("ceo")
    warm = (w or {}).get("warm") or {}
    if warm:
        check("CEO page: a returning viewer's numbers are embedded", True, ", ".join(warm.keys()))
    else:
        notes.append("CEO page embedded no remembered numbers on reload; the page still fills over GlideAjax")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--global", dest="use_global", action="store_true")
    args = ap.parse_args()

    inst = Instance(verbose=False).login()
    s = Surface(inst, "" if args.use_global else SCOPE_PREFIX)
    where = "global" if args.use_global else "x_2185255_command"
    print(f"\n  {inst.host}, {where}\n")

    checks, notes = [], []

    def check(name, ok, detail=""):
        checks.append((name, bool(ok), detail))

    # ── the entry point ──
    cat = s.payload("catalog")
    check("catalog renders", cat and cat.get("areas"),
          f"{len(cat.get('areas') or [])} areas" if cat else "no payload")
    ceo_cards = [c for a in (cat.get("areas") or []) if a["area"] == "CEO Dashboard"
                 for c in a["cards"]] if cat else []
    check("catalog offers the CEO Dashboard and its portfolios",
          len(ceo_cards) >= 2 and all("cmd_ceo.do" in (c.get("url") or "") for c in ceo_cards),
          f"{len(ceo_cards)} cards")

    # ── a subject dashboard ──
    d = s.payload("dashboard", "?table=incident")
    check("subject renders", d is not None)
    if d:
        check("numbers are proved, not a floor",
              d["acl"]["mode"] == "VERIFIED" and not d["acl"].get("capped"),
              f"{d['acl']['mode']}, {d['subject']['rows']:,} rows")
        check("draws a dashboard", len(d["panels"]) >= PANEL_FLOOR,
              f"{len(d['panels'])} panels")
        if any("not attempted" in str(n) for n in (d.get("notes") or [])):
            notes.append("subject page ran out of scan budget; fewer panels than "
                         "a quiet instance would draw")

    # ── the converted CEO page ──
    p = s.payload("dashboard", "?portfolio=Portfolio1")
    check("CEO portfolio renders", p is not None)
    if p:
        kpis = p.get("kpis") or []
        measured = [k for k in kpis if k.get("value") is not None]
        linked = [k for k in kpis if k.get("analysisUrl")]
        trends = [k for k in kpis if k.get("spark")]
        check("CEO: eight cards", len(kpis) == 8, str(len(kpis)))
        check("CEO: every measured card links",
              len(linked) == len(measured), f"{len(linked)} of {len(measured)}")
        check("CEO: header timing is a number",
              isinstance(p.get("timingMs"), int), f"{p.get('timingMs')}ms")
        if len(measured) < len(kpis):
            notes.append(f"{len(kpis) - len(measured)} CEO card(s) not measurable "
                         f"on this data; each states why")
        if len(trends) < 6:
            notes.append(f"only {len(trends)} of {len(kpis)} CEO cards have a trend")

        # every card must open a real, in-portal, permission-checked analysis
        bad, slices = [], set()
        for k in linked:
            a = s.payload(k["analysisUrl"])
            if not a or a["acl"]["mode"] not in ("VERIFIED", "FILTERED", "BOUNDED"):
                bad.append(k["fieldLabel"])
                continue
            m = a.get("measure") or {}
            if not m.get("slice"):
                bad.append(k["fieldLabel"] + " (no slice stated)")
            slices.add(m.get("slice"))
        check("CEO: cards open our own analysis, each stating its rows",
              not bad, f"{len(slices)} distinct slices"
              + (f"; problems: {bad}" if bad else ""))

    # ── the CEO Dashboard: one page, numbers over GlideAjax ──
    ceo_checks(s, check, notes)

    # ── drilldown ──
    d = s.payload("dashboard", "?table=incident&path=" +
                  urllib.parse.quote(seg("category", "hardware"), safe=""))
    check("drill by value", d and len(d["path"]) == 1,
          f"{d['subject']['rows']:,} rows" if d else "")
    d = s.payload("dashboard", "?table=incident&path=" + urllib.parse.quote(
        seg("sys_created_on", "~d~2026-06-01 00:00:00~2026-07-01 00:00:00"), safe=""))
    check("drill by period", d and len(d["path"]) == 1,
          f"{d['path'][0]['label']}, {d['subject']['rows']:,} rows" if d and d["path"] else "")
    d = s.payload("dashboard", "?table=incident&path=" +
                  urllib.parse.quote(seg("reassignment_count", "~r~900~1000"), safe=""))
    check("a drill matching nothing says so",
          d and d["subject"]["rows"] == 0 and not d["panels"], "0 rows, 0 panels")

    failed = 0
    for name, ok, detail in checks:
        if not ok:
            failed += 1
        print(f"  {'PASS' if ok else 'FAIL'}  {name:44s} {detail}")

    if notes:
        print("\n  worth knowing, not failures:")
        for n in notes:
            print(f"    - {n}")

    print(f"\n  {len(checks) - failed}/{len(checks)} passing\n")
    return 1 if failed else 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except InstanceError as e:
        print(f"\n  ABORTED: {e}\n", file=sys.stderr)
        sys.exit(1)
