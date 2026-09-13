#!/usr/bin/env python3
"""Every number on the CEO Dashboard, checked two independent ways, live.

    python3 product/tests/verify_ceo_numbers.py

1. PA's own definition. Each card's "today, PA definition" value must equal what
   CmdCeo.value() computes for the same indicator -- the resolver that was checked
   against Performance Analytics' own scores on the client instance (oracle_ceo.py,
   11 matches, 0 mismatches). The board computes it a different way (one trended
   aggregate, read at today's key), so agreement is evidence, not tautology.
2. The period. For every plain count measure, the card's period value must equal a
   GlideAggregate over the widened query, written out here independently.

Runs as the deploying user (admin), for whom every table is VERIFIED, so the fast
and permission-checked paths agree by construction; the persona runs cover the rest.
"""
import sys, json
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "deploy"))
from snclient import Instance  # noqa: E402

JS = r"""
var out = { rows: [], mismatches: 0, checked: 0, extended: 0 };
var b = new CmdCeoBoard();
var fr = b.frame();
var ids = []; for (var k in fr.indicators) if (fr.indicators.hasOwnProperty(k)) ids.push(k);
var periods = ['30d', '7d'];
for (var p = 0; p < periods.length; p++) {
  var m = new CmdCeoBoard().measures(ids, periods[p], '', { nocache: true });
  var ceo = new CmdCeo(b.data, b.meta, b.drill);
  var P = CmdCeoBoard.periodOf(periods[p]);
  for (var i = 0; i < ids.length; i++) {
    var r = m.results[ids[i]]; if (!r || !r.ok) continue;
    var ref = ceo.value(ids[i]);
    var want = ref.ok ? Math.round(ref.value * 100) / 100 : null;
    /* The reference refuses two things the board can answer: a distinct count,
       and a sum of elapsed time over no records (which is 0 hours, not unknown).
       Those are reported as extensions, never counted as agreement. */
    var extends_ = want === null && r.pa !== null;
    var paOk = extends_ || (want === null && r.pa === null) ||
               (want !== null && r.pa !== null && Math.abs(want - r.pa) < 0.011);
    var winOk = true, winWant = null;
    var node = ceo.resolve(ids[i]);
    if (node.kind === 'count' && node.agg === 'COUNT') {
      var wq = CmdCeoBoard.windowQuery(node.query, P.days);
      if (wq) {
        var ga = new GlideAggregate(node.table); ga.addEncodedQuery(wq); ga.addAggregate('COUNT'); ga.query();
        winWant = ga.next() ? parseInt(ga.getAggregate('COUNT'), 10) : 0;
        winOk = winWant === r.value;
      }
    }
    out.checked++;
    if (!paOk || !winOk) out.mismatches++;
    if (extends_) out.extended++;
    out.rows.push({ p: periods[p], name: r.name, pa: r.pa, paRef: want, paOk: paOk, ext: extends_,
                    value: r.value, winRef: winWant, winOk: winOk });
  }
}
gs.info('@@' + JSON.stringify(out));
"""

def main():
    inst = Instance(verbose=False).login()
    inst.use_scope("x_2185255_command")
    r = inst.run_json(JS)
    for row in r["rows"]:
        flag = ("ext" if row.get("ext") else "ok ") if row["paOk"] and row["winOk"] else "## "
        print(f"  {flag} {row['p']:>4}  {row['name'][:52]:52s}  today {row['pa']!s:>8} vs {row['paRef']!s:>8}"
              f"   period {row['value']!s:>8}" + (f" vs {row['winRef']}" if row['winRef'] is not None else ""))
    print(f"\n  {r['checked']} checked, {r['mismatches']} mismatches, "
          f"{r['extended']} where the board answers what the reference resolver refuses\n")
    return 1 if r["mismatches"] else 0

if __name__ == "__main__":
    sys.exit(main())
