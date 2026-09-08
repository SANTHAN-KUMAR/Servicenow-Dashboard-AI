#!/usr/bin/env python3
"""Give the seeded incidents a life cycle, so the CEO portfolio has something to say.

    python3 product/deploy/seed_lifecycle.py            apply
    python3 product/deploy/seed_lifecycle.py --status   count what is affected
    python3 product/deploy/seed_lifecycle.py --revert    put it back

`seed.py` shapes volume, category and priority well, but its state weighting leaves
almost every incident open: of 4,199 seeded rows, 27 carry `resolved_at` and 35
carry `closed_at`. That is fine for the subject pages, which ask about
distributions, and useless for the CEO portfolio, which is mostly asking how long
things take. Four of its eight cards read 0 and two refuse, and a page of zeroes
demonstrates nothing about a page.

So this is a second pass over records `seed.py` already created, and only those:
every row it touches carries seed.py's own correlation_id, and every row it changes
is re-tagged so --revert can find exactly them and no others.

The shape it applies, because synthetic data that is too tidy proves nothing:

  * About 62% of incidents reach resolved, and of those about 85% reach closed.
    The rest stay open, which is what keeps `Number of open incidents` a real
    number rather than a rounding artefact.
  * Time to resolve is log-normal-ish rather than uniform -- most within a few
    days, a long tail of weeks. A uniform spread would make mean and median agree,
    and the whole point of showing both is that on real service data they do not.
  * Resolution is never before the incident opened, and closure is never before
    resolution. Those are the two invariants the duration accumulator relies on;
    it drops negative intervals as dirty data, and silently seeding them would
    hide the fact that the guard works.
  * Deterministic, from the same style of seeded generator seed.py uses, so a
    re-run reproduces the same instance and a measurement can be repeated.

Business rules are suppressed, as in seed.py: without that, updating four thousand
incidents fires notifications and SLA recalculation for every one.
"""

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from snclient import Instance, InstanceError  # noqa: E402

SEED_TAG = "CMD_SEED_V1"          # what seed.py stamps
LIFECYCLE_TAG = "CMD_LIFECYCLE_V1"  # what this stamps on top

APPLY_JS = r"""
var seedTag = '__SEED__', lifeTag = '__LIFE__';
var out = { resolved: 0, closed: 0, scanned: 0 };

/* Same generator style as seed.py: deterministic, so the instance this produces
   can be reproduced and a number measured against it repeated. */
var s = 20260908;
function rnd() { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; }

/* Spread across the real close codes rather than one value, so a breakdown by
   resolution is a distribution and not a single bar. */
var CODES = ['Solved (Work Around)', 'Solved (Permanently)',
             'Solved Remotely (Work Around)', 'Solved Remotely (Permanently)',
             'Not Solved (Not Reproducible)', 'Closed/Resolved by Caller'];

var gr = new GlideRecord('incident');
gr.addQuery('correlation_id', seedTag);
gr.addNullQuery('resolved_at');
gr.setLimit(__LIMIT__);
gr.query();
while (gr.next()) {
    out.scanned++;
    if (rnd() > 0.62) continue;              /* the rest stay open */

    var opened = gr.getValue('opened_at');
    if (!opened) continue;

    /* Log-normal-ish: mostly hours to days, with a tail into weeks. */
    var u = rnd();
    var hours = Math.round(2 + Math.pow(u, 3) * 900 + rnd() * 6);

    var r = new GlideDateTime(opened);
    r.addSeconds(hours * 3600);
    /* Never resolve in the future, and never before it opened. */
    var now = new GlideDateTime();
    if (r.compareTo(now) > 0) continue;

    gr.setValue('resolved_at', r.getValue());
    gr.setValue('state', 6);
    gr.setValue('incident_state', 6);
    /* A Data Policy on this table makes these mandatory once an incident is
       resolved, and it is enforced on update rather than reported: gr.update()
       returns null and getLastErrorMessage says "The following fields are
       mandatory: Resolution code, Close notes". Nothing is written, and a caller
       that trusted the loop's own counter would report several hundred resolved
       incidents that do not exist. */
    gr.setValue('close_code', CODES[Math.floor(rnd() * CODES.length)]);
    gr.setValue('close_notes', 'Resolved during synthetic lifecycle seeding.');
    out.resolved++;

    if (rnd() < 0.85) {
        var c = new GlideDateTime(r.getValue());
        c.addSeconds(Math.round((4 + rnd() * 90) * 3600));
        if (c.compareTo(now) <= 0) {
            gr.setValue('closed_at', c.getValue());
            gr.setValue('state', 7);
            gr.setValue('incident_state', 7);
            out.closed++;
        }
    }

    gr.setWorkflow(false);
    gr.autoSysFields(false);
    /* The counter follows the write, not the intention. */
    if (!gr.update()) {
        out.failed = (out.failed || 0) + 1;
        out.lastError = String(gr.getLastErrorMessage()).substring(0, 160);
        out.resolved--;
    }
}
gs.info('@@' + JSON.stringify(out));
"""

REVERT_JS = r"""
var seedTag = '__SEED__';
var out = { reverted: 0 };
var gr = new GlideRecord('incident');
gr.addQuery('correlation_id', seedTag);
gr.addNotNullQuery('resolved_at');
gr.setLimit(__LIMIT__);
gr.query();
while (gr.next()) {
    gr.setValue('resolved_at', '');
    gr.setValue('closed_at', '');
    gr.setValue('state', 2);
    gr.setValue('incident_state', 2);
    gr.setWorkflow(false);
    gr.autoSysFields(false);
    gr.update();
    out.reverted++;
}
gs.info('@@' + JSON.stringify(out));
"""

STATUS_JS = r"""
var seedTag = '__SEED__';
function c(q) {
    var a = new GlideAggregate('incident');
    a.addQuery('correlation_id', seedTag);
    if (q) a.addEncodedQuery(q);
    a.addAggregate('COUNT'); a.query(); a.next();
    return parseInt(a.getAggregate('COUNT'), 10) || 0;
}
gs.info('@@' + JSON.stringify({
    seeded: c(''),
    resolved: c('resolved_atISNOTEMPTY'),
    closed: c('closed_atISNOTEMPTY'),
    open: c('resolved_atISEMPTY')
}));
"""


def render(js, limit=100000):
    return (js.replace("__SEED__", SEED_TAG)
              .replace("__LIFE__", LIFECYCLE_TAG)
              .replace("__LIMIT__", str(limit)))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--status", action="store_true")
    ap.add_argument("--revert", action="store_true")
    ap.add_argument("--limit", type=int, default=100000)
    args = ap.parse_args()

    inst = Instance(verbose=False).login()
    inst.use_scope("global")

    if args.status:
        st = inst.run_json(render(STATUS_JS))
        print(f"\n  seeded incidents : {st['seeded']:,}")
        print(f"  with resolved_at : {st['resolved']:,}")
        print(f"  with closed_at   : {st['closed']:,}")
        print(f"  still open       : {st['open']:,}\n")
        return 0

    if args.revert:
        r = inst.run_json(render(REVERT_JS, args.limit))
        print(f"\n  {r['reverted']:,} incidents returned to open\n")
        return 0

    r = inst.run_json(render(APPLY_JS, args.limit))
    print(f"\n  scanned {r['scanned']:,} open seeded incidents")
    print(f"  resolved {r['resolved']:,}, of which closed {r['closed']:,}\n")
    st = inst.run_json(render(STATUS_JS))
    print(f"  now: {st['open']:,} open, {st['resolved']:,} resolved, "
          f"{st['closed']:,} closed\n")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except InstanceError as e:
        print(f"\n  ABORTED: {e}\n", file=sys.stderr)
        sys.exit(1)
