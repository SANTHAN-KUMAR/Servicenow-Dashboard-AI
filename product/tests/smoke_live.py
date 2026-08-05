"""End-to-end smoke test against the deployed instance.

The other suites run offline against captured fixtures, which is what makes them
fast and what makes them blind to a whole class of failure: every one of them
passed while the instance was serving a stale renderer, because a fixture cannot
tell you what the browser was actually handed.

So this one fetches the real pages over HTTP and asserts on what came back.

    python3 product/tests/smoke_live.py            # every table, every window
    python3 product/tests/smoke_live.py incident   # one table

What it checks, in the order these have actually bitten:

  * the page is not a zero-byte 200 -- a CDATA-wrapped <script> made the platform
    serve exactly that, with no error anywhere
  * the payload decodes and carries panels
  * no Jelly or Rhino trace leaked into the HTML
  * no unsubstituted @@PLACEHOLDER@@ survived the build
  * every asset the page references still exists, so a content-hashed renderer
    cannot be pruned out from under its own page
  * the ACL verdict and the headline count are the SAME across repeated identical
    requests -- a time-boxed proof can race, and a headline that changes on
    refresh discredits every other number on the page

The page is drawn client-side from a base64 payload, so there is no chart markup
in the server response and asserting on HTML structure here would prove nothing.
Panel and form assertions read the decoded payload; the drawing is covered by
test_render_live.js against the same payloads.
"""
import sys
import re
import json
import time
import base64
import pathlib
import urllib.parse

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "deploy"))
from snclient import Instance                                    # noqa: E402

TABLES = ["incident", "change_request", "problem", "sc_req_item", "sc_request",
          "sys_user", "cmdb_ci", "cmdb_ci_computer", "kb_knowledge",
          "asmt_assessment_instance", "task"]
WINDOWS = [3, 6, 12, 24]

# How many times to re-fetch one page when checking that the verdict is stable.
STABILITY_RUNS = 4
STABILITY_TABLES = ["incident", "change_request", "problem"]

POISON = [
    ("no renderer", re.compile(r"[Nn]o renderer for")),
    ("jelly trace", re.compile(r"org\.mozilla\.javascript|com\.glide\.|JellyException")),
    ("rhino error", re.compile(r"is not defined|Cannot find default value")),
    ("unsubstituted placeholder", re.compile(r"@@[A-Z_]+@@")),
    ("singular/plural disagreement", re.compile(r"[^,.\d]1 (records|subjects|levels)\b")),
]

PAYLOAD_RX = re.compile(r'id="cmd-data"[^>]*data-b64="([^"]*)"')
ASSET_RX = re.compile(r"([a-z_]+_[0-9a-f]{6,})\.jsdbx")

fails = []
rows = []


def fail(msg):
    fails.append(msg)


def fetch(inst, path):
    t0 = time.time()
    r = inst._op.open(inst.base + path, timeout=180)
    body = r.read().decode("utf-8", "replace")
    return body, r.status, int((time.time() - t0) * 1000)


def payload_of(body):
    m = PAYLOAD_RX.search(body)
    if not m:
        return None
    return json.loads(base64.b64decode(m.group(1)).decode("utf-8"))


def check_poison(where, body):
    for label, rx in POISON:
        m = rx.search(body)
        if m:
            fail("%s: %s -> %r" % (where, label, m.group(0)[:70]))


def check_assets(inst, where, body, seen):
    for ref in sorted(set(ASSET_RX.findall(body))):
        if ref in seen:
            continue
        seen[ref] = bool(inst.query("sys_ui_script", "name=" + ref, ["name"], limit=1))
        if not seen[ref]:
            fail("%s: references asset %s, which is not on the instance" % (where, ref))


def main():
    tables = sys.argv[1:] or TABLES
    inst = Instance(None, verbose=False)
    inst.login()
    seen_assets = {}

    body, status, ms = fetch(inst, "/cmd_catalog.do")
    check_poison("catalog", body)
    check_assets(inst, "catalog", body, seen_assets)
    cat = payload_of(body)
    if cat is None:
        fail("catalog: no payload on the page (%d bytes)" % len(body))
    else:
        cards = cat.get("cards") or cat.get("items") or []
        rows.append(("catalog", "-", status, len(body), ms, "%d cards" % len(cards)))
        if len(cards) < 5:
            fail("catalog: only %d cards offered" % len(cards))

    allforms = set()
    for t in tables:
        for w in WINDOWS:
            q = urllib.parse.urlencode({"table": t, "months": w})
            where = "%s@%dm" % (t, w)
            try:
                body, status, ms = fetch(inst, "/cmd_dashboard.do?" + q)
            except Exception as e:                                # noqa: BLE001
                fail("%s: %s: %s" % (where, type(e).__name__, e))
                continue
            if status != 200:
                fail("%s: HTTP %d" % (where, status))
            if len(body) < 5000:
                fail("%s: %d-byte page, a 200 that served nothing" % (where, len(body)))
            check_poison(where, body)
            check_assets(inst, where, body, seen_assets)

            p = payload_of(body)
            if p is None:
                fail("%s: no payload on the page" % where)
                continue
            panels = (p.get("panels") or [])
            forms = [x.get("form") for x in panels if x.get("form")]
            allforms.update(forms)
            for x in p.get("kpis") or []:
                if x.get("form"):
                    allforms.add(x["form"])
            if p.get("matrix"):
                allforms.add("matrix")
            for x in panels:
                if not x.get("form"):
                    fail("%s: a panel carries no form" % where)
            rows.append((t, "%dm" % w, status, len(body), ms,
                         "%dp %df %dk" % (len(panels), len(set(forms)),
                                          len(p.get("kpis") or []))))

    # Drilldown, end to end through the URL.
    #
    # This is here because the parse is a few lines of Jelly that no offline suite
    # can reach, and it was silently broken: RP.getParameterValue returns a
    # java.lang.String, so split('|') bound to Java's split(regex) and split between
    # every character. "category:software" became sixteen drill levels, one per
    # letter. Every page still returned 200 with eleven panels, so nothing except an
    # assertion on the filtered row count would have caught it.
    if "incident" in tables:
        print("\ndrilldown")
        steps = ["", "category:software", "category:software|priority:3"]
        last = None
        for depth, pth in enumerate(steps):
            u = "/cmd_dashboard.do?table=incident&months=12"
            if pth:
                u += "&path=" + urllib.parse.quote(pth)
            p = payload_of(fetch(inst, u)[0])
            got, crumbs = p["subject"]["rows"], p["path"]
            print("  depth %d  %-34s %d rows" % (depth, pth or "(top)", got))
            if len(crumbs) != depth:
                fail("drill depth %d: %d breadcrumbs, expected %d -- the path did "
                     "not parse" % (depth, len(crumbs), depth))
            if last is not None and got >= last:
                fail("drill depth %d: %d rows, not fewer than the %d above it -- the "
                     "filter is not reaching the query" % (depth, got, last))
            # The terminal step hands off to the platform list view, so its query
            # has to be the real one; the platform enforces row security there.
            for seg in pth.split("|") if pth else []:
                f = seg.split(":")[0]
                if f and f + "=" not in urllib.parse.unquote(p["subject"]["listUrl"]):
                    fail("drill depth %d: %r missing from the record-list query"
                         % (depth, f))
            last = got

    # A verdict that changes between identical requests is worse than a slow page.
    print("\nstability, %d identical requests each" % STABILITY_RUNS)
    for t in [x for x in STABILITY_TABLES if x in tables]:
        seen = {}
        for _ in range(STABILITY_RUNS):
            body, _s, _ms = fetch(inst, "/cmd_dashboard.do?table=%s&months=12" % t)
            p = payload_of(body)
            k = (p["acl"]["mode"], p["subject"]["rows"])
            seen[k] = seen.get(k, 0) + 1
        verdicts = ", ".join("%s/%s x%d" % (m, r, c) for (m, r), c in seen.items())
        print("  %-18s %s" % (t, verdicts))
        if len(seen) > 1:
            fail("%s: verdict is not stable across identical requests -- %s" % (t, verdicts))

    print("\n%-26s%-6s%-5s%9s%8s  %s" % ("page", "win", "st", "bytes", "ms", "detail"))
    worst = 0
    for name, win, st, b, ms, detail in rows:
        worst = max(worst, ms)
        print("%-26s%-6s%-5s%9d%8d  %s%s"
              % (name, win, st, b, ms, detail, "  <-- SLOW" if ms > 8000 else ""))

    print("\nworst page %dms over %d fetches" % (worst, len(rows)))
    print("%d distinct forms live: %s" % (len(allforms), " ".join(sorted(allforms))))

    if fails:
        print("\n%d FAILURES" % len(fails))
        for f in fails:
            print("  " + f)
        return 1
    print("\nno poison text, no empty pages, no dead assets, verdicts stable")
    return 0


if __name__ == "__main__":
    sys.exit(main())
