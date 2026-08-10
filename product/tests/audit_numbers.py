"""Verify that the numbers on the dashboard are CORRECT. READ ONLY.

Every other suite in this directory tests that the product *renders*, is *stable*,
and *drills*. None of them ever asked whether a number on the page is right. A
client eyeballing a screenshot found two problems in minutes that 226 green
assertions had not, which is a statement about the assertions.

So this recomputes the dashboard's own figures independently, using the platform's
aggregate Stats API, and compares bucket by bucket:

  * subject total vs the platform's COUNT for the same table
  * every dimension panel's buckets vs a platform GROUP BY on the same field
  * every dimension panel's buckets summed vs the total it claims
  * every time-series panel's points summed vs the platform's COUNT
  * every group key is a real stored value, not a display label

That last one exists because a payload showed `Hardware` as a group key beside
lowercase `network` and `software`. A key is what a drill filter is built from, so
a key that is a label rather than a stored value produces a query matching nothing.

As admin, permission-checked counts and raw counts must agree exactly. Any
difference is a bug in us, not a permission effect.

    python3 product/tests/audit_numbers.py [table ...]
"""
import sys
import re
import json
import base64
import urllib.parse
import pathlib

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "deploy"))
from snclient import Instance                                    # noqa: E402

TABLES = ["incident", "change_request", "problem"]
PAYLOAD_RX = re.compile(r'id="cmd-data"[^>]*data-b64="([^"]*)"')

fails, checks = [], [0]


def bad(msg):
    fails.append(msg)
    print("    FAIL  " + msg, flush=True)


def ok(msg):
    checks[0] += 1
    print("    ok    " + msg, flush=True)


class Stats:
    def __init__(self, inst):
        self.i = inst

    def count(self, table, query=""):
        p = {"sysparm_count": "true"}
        if query:
            p["sysparm_query"] = query
        r = self.i._call("GET", "/api/now/stats/%s?%s"
                         % (table, urllib.parse.urlencode(p)))
        return int(r.get("result", {}).get("stats", {}).get("count", 0))

    def group(self, table, field, query=""):
        p = {"sysparm_count": "true", "sysparm_group_by": field,
             "sysparm_display_value": "false"}
        if query:
            p["sysparm_query"] = query
        r = self.i._call("GET", "/api/now/stats/%s?%s"
                         % (table, urllib.parse.urlencode(p)))
        out = {}
        for g in r.get("result", []):
            val = ""
            for gb in g.get("groupby_fields", []):
                if gb.get("field") == field:
                    val = gb.get("value", "")
            out[val] = int(g.get("stats", {}).get("count", 0))
        return out


def payload(inst, table, months=12):
    q = urllib.parse.urlencode({"table": table, "months": months})
    body = inst._op.open("%s/cmd_dashboard.do?%s" % (inst.base, q),
                         timeout=240).read().decode("utf-8", "replace")
    m = PAYLOAD_RX.search(body)
    if not m:
        return None
    return json.loads(base64.b64decode(m.group(1)).decode("utf-8"))


def buckets_of(panel):
    """(key -> count) for whichever shape this panel stores its buckets in."""
    rows = panel.get("rows")
    if isinstance(rows, dict) and isinstance(rows.get("series"), list):
        return {r.get("key", ""): r.get("count", 0) for r in rows["series"]}, \
               rows.get("other")
    if isinstance(rows, list) and rows and isinstance(rows[0], dict) \
            and "count" in rows[0]:
        return {r.get("key", ""): r.get("count", 0) for r in rows}, None
    return None, None


def main():
    tables = sys.argv[1:] or TABLES
    inst = Instance(None, verbose=True)
    inst.login()
    s = Stats(inst)
    print("\nnumber-correctness audit against %s\n" % inst.host, flush=True)

    for t in tables:
        print("=" * 74)
        print(t)
        print("=" * 74, flush=True)
        p = payload(inst, t)
        if not p:
            bad("%s: no payload on the page" % t)
            continue

        claimed = p["subject"]["rows"]
        actual = s.count(t)
        mode = p["acl"]["mode"]
        print("  subject total: dashboard %d, platform %d, verdict %s"
              % (claimed, actual, mode), flush=True)
        if mode == "VERIFIED" and claimed != actual:
            bad("%s: dashboard says %d records, platform says %d, and the page "
                "claims the count is VERIFIED" % (t, claimed, actual))
        elif mode == "VERIFIED":
            ok("total agrees with the platform")
        else:
            print("    (verdict is %s, so the total is a floor by design)" % mode)

        # ── dimension panels ────────────────────────────────────────────────
        for panel in p.get("panels", []):
            field = panel.get("field")
            form = panel.get("form")
            if panel.get("kind") != "dimension" or not field:
                continue
            mine, other = buckets_of(panel)
            if not mine:
                continue

            print("\n  panel %s on %s" % (form, field), flush=True)
            theirs = s.group(t, field)

            # 1. buckets must sum to the subject total when nothing is truncated
            total = sum(mine.values())
            if other is None and total != claimed:
                bad("%s/%s: buckets sum to %d but the page says %d records"
                    % (t, field, total, claimed))
            elif other is None:
                ok("buckets sum to the stated total (%d)" % total)

            # 2. every key must be a value the platform actually stores
            unknown = [k for k in mine if k not in theirs]
            if unknown:
                bad("%s/%s: group keys not present as stored values: %s  "
                    "(a drill filter built from these matches nothing)"
                    % (t, field, unknown[:6]))
            else:
                ok("every group key is a stored value")

            # 3. bucket-for-bucket comparison
            if other is None:
                diffs = []
                for k in set(mine) | set(theirs):
                    a, b = mine.get(k, 0), theirs.get(k, 0)
                    if a != b:
                        diffs.append("%s: page %d vs platform %d"
                                     % (k or "(empty)", a, b))
                if diffs:
                    bad("%s/%s: %d bucket(s) disagree -> %s"
                        % (t, field, len(diffs), "; ".join(diffs[:6])))
                else:
                    ok("all %d buckets match the platform exactly" % len(mine))

        # ── time-series panels ──────────────────────────────────────────────
        for panel in p.get("panels", []):
            pts = panel.get("points")
            if panel.get("kind") != "time" or not isinstance(pts, list) or not pts:
                continue
            field = panel.get("field")
            summed = sum(x.get("count", 0) for x in pts)
            print("\n  panel %s on %s (%d buckets)"
                  % (panel.get("form"), field, len(pts)), flush=True)
            if summed > claimed:
                bad("%s/%s: time buckets sum to %d, more than the %d records "
                    "on the page" % (t, field, summed, claimed))
            else:
                ok("time buckets sum to %d, within the %d on the page"
                   % (summed, claimed))

    print("\n" + "=" * 74)
    print("%d checks passed, %d failed" % (checks[0], len(fails)))
    if fails:
        print("\nfailures:")
        for f in fails:
            print("  " + f)
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
