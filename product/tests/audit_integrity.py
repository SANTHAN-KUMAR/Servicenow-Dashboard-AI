"""Data integrity audit. READ ONLY — makes no writes of any kind.

Written after a client demo raised the question this should have answered long
ago: is the dashboard describing the instance's real data, or data we created?

Three questions:

1. **Did we delete real records?** Research recorded 13,986 incidents on
   2026-08-03; the native list now shows 4,266. `seed.py --purge` deletes
   everything tagged CMD_SEED_V1, so if any run tagged a pre-existing record, a
   purge took real data with it.
2. **What is the true seed footprint**, per table.
3. **Did we mutate pre-existing records or only add rows?** The decisive test:
   split every distribution by provenance. A payload already showed `Hardware`
   with a capital H sitting alongside lowercase `network`/`software`, and the
   platform had no label for it — so something wrote values that are not choice
   values.

Uses the aggregate Stats API rather than background scripts: `sys.scripts.do` on
this instance routinely takes minutes, and every result here is a plain COUNT
with a group-by, which the API does natively.

    python3 product/tests/audit_integrity.py
"""
import sys
import json
import urllib.parse
import pathlib

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "deploy"))
from snclient import Instance                                    # noqa: E402

TABLES = ["incident", "change_request", "problem", "sc_req_item", "cmdb_ci_computer"]
SEED_TAG = "correlation_id=CMD_SEED_V1"


def out(line=""):
    print(line, flush=True)


class Stats:
    def __init__(self, inst):
        self.i = inst

    def count(self, table, query=""):
        p = {"sysparm_count": "true"}
        if query:
            p["sysparm_query"] = query
        r = self.i._call("GET", "/api/now/stats/%s?%s" % (table, urllib.parse.urlencode(p)))
        return int(r.get("result", {}).get("stats", {}).get("count", 0))

    def group(self, table, field, query=""):
        """[(value, count)] descending. Raw values, not display values."""
        p = {"sysparm_count": "true", "sysparm_group_by": field,
             "sysparm_display_value": "false"}
        if query:
            p["sysparm_query"] = query
        r = self.i._call("GET", "/api/now/stats/%s?%s" % (table, urllib.parse.urlencode(p)))
        rows = []
        for g in r.get("result", []):
            val = ""
            for gb in g.get("groupby_fields", []):
                if gb.get("field") == field:
                    val = gb.get("value", "")
            rows.append((val, int(g.get("stats", {}).get("count", 0))))
        rows.sort(key=lambda x: -x[1])
        return rows


def table_dist(title, rows, total=None):
    out("\n  " + title)
    if not rows:
        out("    (none)")
        return
    for k, n in rows:
        pct = ("  %5.1f%%" % (100.0 * n / total)) if total else ""
        out("    %-30s %8d%s" % (k if k else "(empty)", n, pct))


def main():
    inst = Instance(None, verbose=True)
    inst.login()
    s = Stats(inst)
    out("\nREAD-ONLY integrity audit against %s" % inst.host)

    out("\n" + "=" * 76)
    out("1. ROW COUNTS")
    out("=" * 76)
    out("\n  %-22s %9s %9s %9s" % ("table", "total", "seedTag", "descSeeded"))
    totals = {}
    for t in TABLES:
        try:
            tot = s.count(t)
            tag = s.count(t, SEED_TAG)
            try:
                dsc = s.count(t, "short_descriptionSTARTSWITHSeeded")
            except Exception:                                    # noqa: BLE001
                dsc = -1
            totals[t] = (tot, tag, dsc)
            out("  %-22s %9d %9d %9s" % (t, tot, tag, dsc if dsc >= 0 else "n/a"))
        except Exception as e:                                    # noqa: BLE001
            out("  %-22s ERROR %s" % (t, str(e)[:50]))

    out("\n  Research recorded 13,986 incidents on 2026-08-03.")
    if "incident" in totals:
        out("  The instance now holds %d." % totals["incident"][0])

    out("\n" + "=" * 76)
    out("2. DID WE MUTATE PRE-EXISTING RECORDS?  (incident.category, RAW values)")
    out("=" * 76)
    allc = s.group("incident", "category")
    seeded = s.group("incident", "category", SEED_TAG)
    organic = s.group("incident", "category",
                      "correlation_id!=CMD_SEED_V1^ORcorrelation_idISEMPTY")
    nAll = sum(n for _, n in allc)
    nSeed = sum(n for _, n in seeded)
    nOrg = sum(n for _, n in organic)
    table_dist("ALL — %d rows" % nAll, allc, nAll or None)
    table_dist("SEEDED (we created these) — %d rows" % nSeed, seeded, nSeed or None)
    table_dist("ORGANIC (we did not create these) — %d rows" % nOrg, organic, nOrg or None)

    out("\n" + "=" * 76)
    out("3. VALUES THAT ARE NOT CHOICE VALUES")
    out("=" * 76)
    choices = s.group("sys_choice", "value",
                      "name=incident^element=category^inactive=false")
    valid = {v for v, _ in choices}
    out("\n  declared choice values: %s" % (sorted(valid) or "none found"))
    bogus = [(k, n) for k, n in allc if k and k not in valid]
    if bogus:
        out("\n  >>> categories present in DATA but not declared as choices:")
        for k, n in bogus:
            src = dict(seeded).get(k, 0)
            out("      %-28s %7d rows   (%d of them ours)" % (k, n, src))
    else:
        out("\n  every category value in the data is a declared choice.")

    out("\n" + "=" * 76)
    out("4. WHAT THE DASHBOARD IS DESCRIBING")
    out("=" * 76)
    if nAll:
        out("  %d of %d incidents (%.1f%%) are records we created."
            % (nSeed, nAll, 100.0 * nSeed / nAll))
    orgd = dict(organic)
    out("  password_reset in organic rows: %s"
        % ("%d" % orgd["password_reset"] if "password_reset" in orgd else "ABSENT"))
    out("  empty category in organic rows: %d" % orgd.get("", 0))
    out("  (research measured password_reset 2,237 and 340 empties)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
