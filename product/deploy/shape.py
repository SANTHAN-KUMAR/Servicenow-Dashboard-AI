#!/usr/bin/env python3
"""Reshape seeded records so the remaining chart forms have data that earns them.

Five forms could not appear on dev390988, and in every case the gate that rejected
them was doing its job: `funnel` needs a declared sequence whose counts actually
shed volume stage by stage, `small_multiples` needs more categories than a single
plot can separate, `slope` and `bump` need rank movement over the window. Stock
demo data has none of those shapes, so the renderers shipped untested against real
payloads.

The honest options were to relax the gates, to invent fixtures, or to create data
that genuinely has these shapes. Relaxing the gates is the one thing we must not
do -- they are the product's central claim, that a form is chosen because the data
supports it. So this creates the data instead.

Two rules keep it defensible:

  1. It only ever touches records this engagement created, matched on
     correlation_id = CMD_SEED_V1. Nothing pre-existing on the instance is
     modified, and `seed.py --purge` still removes every trace.
  2. The distributions it writes are ones the real world produces. A change
     pipeline really does thin out towards its later stages at any given moment,
     and category mix really does shift between months. It is synthetic data, not
     impossible data.

    python3 product/deploy/shape.py [--status] [--dry-run]
"""
import argparse
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from snclient import Instance, InstanceError  # noqa: E402

TAG = "CMD_SEED_V1"

# ── the shapes ──────────────────────────────────────────────────────────────

# A change pipeline photographed at one moment. Most work sits early; each
# subsequent stage holds less, because reaching it requires surviving the one
# before. The values are ServiceNow's own change_request.state choices, and the
# weights decline monotonically, which is exactly what CmdAnalysis.funnel() tests
# for before it will draw a funnel.
CHANGE_PIPELINE = [
    ("-5", 30),   # New
    ("-4", 22),   # Assess
    ("-3", 17),   # Authorize
    ("-2", 12),   # Scheduled
    ("-1", 9),    # Implement
    ("0", 6),     # Review
    ("3", 4),     # Closed
]

# Category mix per month, for incident, oldest month first.
#
# Designed so that Network and Software trade places twice: Network leads, falls
# behind in the middle of the window, then recovers. That reversal is what
# CmdAnalysis.rankShift() looks for when deciding between a bump chart and a slope
# chart -- a series that climbs and then falls back is precisely the case the two
# endpoints of a slope would hide.
#
# Every category seed.py can write MUST appear here, at every month.
#
# It did not, and that was a real bug with a visible consequence. seed.py writes
# six categories including password_reset at weight 8; this table listed five.
# Reshaping assigns each record a category drawn only from this table, so the
# first shaping run moved every password_reset incident to something else and no
# later run could ever put one back. Measured on dev390988 afterwards:
# password_reset was extinct table-wide, 0 records, against the 2,237 recorded
# before we touched the instance. It is still a live, active choice on the
# dictionary, so the platform's own reports carried an empty category that the
# data says should be populated -- we had silently deleted a category from the
# client's demo data.
#
# password_reset is parked at a constant 8, matching seed.py's own weight, and
# clear of database at 10 so the two never trade ranks on sampling noise alone.
INCIDENT_MIX = [
    {"network": 34, "software": 18, "hardware": 16, "inquiry": 14, "database": 10, "password_reset": 8},
    {"network": 31, "software": 21, "hardware": 16, "inquiry": 14, "database": 10, "password_reset": 8},
    {"network": 27, "software": 25, "hardware": 16, "inquiry": 14, "database": 10, "password_reset": 8},
    {"network": 22, "software": 30, "hardware": 17, "inquiry": 13, "database": 10, "password_reset": 8},
    {"network": 18, "software": 34, "hardware": 18, "inquiry": 12, "database": 10, "password_reset": 8},
    {"network": 16, "software": 35, "hardware": 20, "inquiry": 11, "database": 10, "password_reset": 8},
    {"network": 17, "software": 33, "hardware": 22, "inquiry": 11, "database": 10, "password_reset": 8},
    {"network": 21, "software": 29, "hardware": 22, "inquiry": 11, "database": 10, "password_reset": 8},
    {"network": 26, "software": 25, "hardware": 21, "inquiry": 11, "database": 10, "password_reset": 8},
    {"network": 30, "software": 22, "hardware": 20, "inquiry": 11, "database": 10, "password_reset": 8},
    {"network": 33, "software": 20, "hardware": 19, "inquiry": 11, "database": 10, "password_reset": 8},
    {"network": 35, "software": 19, "hardware": 18, "inquiry": 11, "database": 10, "password_reset": 8},
]

# Problem category mix: the same idea without the reversal. Hardware climbs
# steadily and Network declines steadily, so ranks change but nothing turns
# around, which is the case a slope chart states better than a bump chart.
PROBLEM_MIX = [
    # Two movers crossing once, and three others parked at clearly separated
    # volumes so their own ranks never touch.
    #
    # The separation is the point. An earlier version had the three stationary
    # categories at 24, 14 and 10, which on 520 problems over twelve months is
    # roughly 10, 6 and 4 records a month -- close enough that ordinary sampling
    # noise swapped them back and forth, and a swap in either direction reads as a
    # reversal. Every subject then came out as a bump chart and the slope branch was
    # unreachable on real data. Parking them far apart leaves exactly one genuine
    # crossing, which is what a slope chart states better than a bump chart.
    {"network": 46, "hardware": 6, "software": 28, "inquiry": 14, "database": 6},
    {"network": 43, "hardware": 9, "software": 28, "inquiry": 14, "database": 6},
    {"network": 40, "hardware": 12, "software": 28, "inquiry": 14, "database": 6},
    {"network": 37, "hardware": 15, "software": 28, "inquiry": 14, "database": 6},
    {"network": 34, "hardware": 18, "software": 28, "inquiry": 14, "database": 6},
    {"network": 31, "hardware": 21, "software": 28, "inquiry": 14, "database": 6},
    {"network": 28, "hardware": 24, "software": 28, "inquiry": 14, "database": 6},
    {"network": 24, "hardware": 28, "software": 28, "inquiry": 14, "database": 6},
    {"network": 20, "hardware": 32, "software": 28, "inquiry": 14, "database": 6},
    {"network": 16, "hardware": 36, "software": 28, "inquiry": 14, "database": 6},
    {"network": 12, "hardware": 40, "software": 28, "inquiry": 14, "database": 6},
    {"network": 8, "hardware": 44, "software": 28, "inquiry": 14, "database": 6},
]

# Reassignment counts by priority.
#
# A box plot shows a difference in spread, which is the one thing a bar chart of
# averages cannot. It therefore needs a measure whose spread actually differs
# between groups, and stock incident data has none: reassignment_count runs 0 to 2
# across the whole table, so every group's quartiles come out identical and the
# panel is correctly refused.
#
# These distributions say something true about how service desks work. A P1 gets
# escalated and passed around; a P4 is usually handled by whoever picks it up. So
# the median rises and, more importantly, the spread widens as priority increases.
REASSIGNMENT_BY_PRIORITY = {
    "1": [0, 1, 1, 2, 2, 3, 3, 4, 5, 6, 7, 9],
    "2": [0, 0, 1, 1, 2, 2, 3, 3, 4, 5, 6],
    "3": [0, 0, 0, 1, 1, 1, 2, 2, 3, 4],
    "4": [0, 0, 0, 0, 1, 1, 1, 2],
    "5": [0, 0, 0, 0, 0, 1, 1],
}

SHAPE_JS = r"""
var TAG = '@@TAG@@';
var DRY = @@DRY@@;
var out = { changed: {}, groups: 0, notes: [] };

/* Deterministic, so a rerun produces the same instance rather than a different
   one. The same generator the seeder uses. */
var _s = 20260803;
function rnd() { _s = (_s * 1103515245 + 12345) % 2147483648; return _s / 2147483648; }
function pick(weights) {
    var total = 0, k;
    for (k in weights) { if (weights.hasOwnProperty(k)) total += weights[k]; }
    var r = rnd() * total, acc = 0;
    for (k in weights) {
        if (!weights.hasOwnProperty(k)) continue;
        acc += weights[k];
        if (r < acc) return k;
    }
    return k;
}

/* Months back from now, 0 = this month. Matches CmdData's month bucketing, which
   keys on the first seven characters of the stored UTC value. */
function monthsBack(value) {
    if (!value || ('' + value).length < 7) return -1;
    var v = '' + value;
    var y = parseInt(v.substr(0, 4), 10), m = parseInt(v.substr(5, 2), 10);
    var now = new GlideDateTime().getValue();
    var ny = parseInt(now.substr(0, 4), 10), nm = parseInt(now.substr(5, 2), 10);
    return (ny - y) * 12 + (nm - m);
}

var groups = [];
(function () {
    var g = new GlideRecord('sys_user_group');
    g.addQuery('active', true);
    g.setLimit(12);
    g.query();
    while (g.next()) groups.push(g.getUniqueValue());
})();
out.groups = groups.length;

function shapeMix(table, mixes, dateField) {
    var n = 0;
    var gr = new GlideRecord(table);
    gr.addQuery('correlation_id', TAG);
    gr.setLimit(20000);
    gr.query();
    gr.setWorkflow(false);
    gr.autoSysFields(false);
    while (gr.next()) {
        var back = monthsBack(gr.getValue(dateField));
        if (back < 0 || back >= mixes.length) continue;
        /* mixes[0] is the oldest month in the window. */
        var mix = mixes[mixes.length - 1 - back];
        var cat = pick(mix);
        if (gr.getValue('category') === cat) continue;
        gr.setValue('category', cat);
        if (!DRY) gr.update();
        n++;
    }
    return n;
}

/* Incident and problem: a category mix that moves month by month, so rank
   position over the window becomes a real question. */
out.changed.incident = shapeMix('incident', @@INCIDENT_MIX@@, 'opened_at');
out.changed.problem  = shapeMix('problem',  @@PROBLEM_MIX@@,  'opened_at');

/* Change request: an in-flight pipeline, plus assignment spread across every
   available group so a per-category trend has more series than one plot can
   separate. */
(function () {
    var pipeline = @@CHANGE_PIPELINE@@;
    var weights = {};
    for (var i = 0; i < pipeline.length; i++) weights[pipeline[i][0]] = pipeline[i][1];

    var n = 0, gi = 0;
    var gr = new GlideRecord('change_request');
    gr.addQuery('correlation_id', TAG);
    gr.setLimit(20000);
    gr.query();
    gr.setWorkflow(false);
    gr.autoSysFields(false);
    while (gr.next()) {
        gr.setValue('state', pick(weights));
        if (groups.length) {
            /* Round robin rather than weighted, so the spread is even and no single
               group dominates -- an even spread across many categories is exactly
               the shape that argues for small multiples over a single plot. */
            gr.setValue('assignment_group', groups[gi % groups.length]);
            gi++;
        }
        if (!DRY) gr.update();
        n++;
    }
    out.changed.change_request = n;
})();

/* Reassignment counts that differ in spread between priorities, so a box plot has
   something to show. Drawn from a per-priority pool rather than a formula, so the
   quartiles are whatever the pool produces rather than whatever we asserted. */
(function () {
    var pools = @@REASSIGN@@;
    var n = 0;
    var gr = new GlideRecord('incident');
    gr.addQuery('correlation_id', TAG);
    gr.setLimit(20000);
    gr.query();
    gr.setWorkflow(false);
    gr.autoSysFields(false);
    while (gr.next()) {
        var pool = pools[gr.getValue('priority')];
        if (!pool) pool = pools['3'];
        var v = pool[Math.floor(rnd() * pool.length)];
        gr.setValue('reassignment_count', v);
        /* A reopen is rarer and correlates with reassignment, which gives the
           scatter two columns that genuinely relate rather than two noise columns. */
        gr.setValue('reopen_count', v >= 4 ? (rnd() < 0.5 ? 1 : 2)
                                   : v >= 2 ? (rnd() < 0.25 ? 1 : 0) : 0);
        if (!DRY) gr.update();
        n++;
    }
    out.changed.incident_measures = n;
})();

gs.print('@@' + JSON.stringify(out));
"""

STATUS_JS = r"""
var out = {};
function dist(table, field, limit) {
    var counts = {}, gr = new GlideAggregate(table);
    gr.addQuery('correlation_id', '@@TAG@@');
    gr.groupBy(field);
    gr.addAggregate('COUNT');
    gr.query();
    while (gr.next()) {
        counts[gr.getValue(field) || '(empty)'] =
            parseInt(gr.getAggregate('COUNT'), 10);
    }
    return counts;
}
out.change_state = dist('change_request', 'state');
out.change_group = dist('change_request', 'assignment_group');
out.incident_cat = dist('incident', 'category');
out.problem_cat  = dist('problem', 'category');
gs.print('@@' + JSON.stringify(out));
"""


def render(tpl, **kw):
    for k, v in kw.items():
        tpl = tpl.replace(f"@@{k}@@", v)
    return tpl


def check_mix_covers_seed():
    """Every category seed.py can write must be reachable after reshaping.

    Reshaping draws only from the mix, so a category seed.py writes but the mix
    omits is not merely under-represented -- it is deleted on the first run and
    can never come back. That is how password_reset went from 2,237 records to
    zero without anyone noticing. This turns a silent data loss into a failure
    before a single record is touched.
    """
    seed_src = (Path(__file__).parent / "seed.py").read_text()
    m = re.search(r"var CATS = \[(.*?)\];", seed_src, re.S)
    if not m:
        return                                   # seed.py restructured; nothing to check
    seed_cats = set(re.findall(r"\['([a-z_]+)'", m.group(1)))
    for month, mix in enumerate(INCIDENT_MIX):
        missing = seed_cats - set(mix)
        if missing:
            raise SystemExit(
                "shape.py refuses to run: INCIDENT_MIX month %d omits %s, which "
                "seed.py writes. Reshaping would delete those categories "
                "permanently. Add them to every month of the mix."
                % (month, ", ".join(sorted(missing))))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--status", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--credentials", default=None)
    args = ap.parse_args()

    check_mix_covers_seed()

    inst = Instance(args.credentials, verbose=False).login()
    print()

    if args.status:
        st = inst.run_json(render(STATUS_JS, TAG=TAG))
        for name, counts in st.items():
            items = sorted(counts.items(), key=lambda kv: -kv[1])
            total = sum(counts.values())
            print(f"  {name}  ({total:,} seeded, {len(items)} values)")
            for k, v in items[:10]:
                print(f"      {k:<38}{v:>7,}")
            print()
        return 0

    print(f"  reshaping records tagged {TAG}"
          f"{' (dry run)' if args.dry_run else ''}\n")
    res = inst.run_json(render(
        SHAPE_JS,
        TAG=TAG,
        DRY="true" if args.dry_run else "false",
        INCIDENT_MIX=json.dumps(INCIDENT_MIX),
        PROBLEM_MIX=json.dumps(PROBLEM_MIX),
        CHANGE_PIPELINE=json.dumps(CHANGE_PIPELINE),
        REASSIGN=json.dumps(REASSIGNMENT_BY_PRIORITY),
    ))
    for table, n in res["changed"].items():
        print(f"  {table:<20}{n:>7,} records reshaped")
    print(f"\n  spread across {res['groups']} assignment groups\n")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except InstanceError as exc:
        print(f"\n  FAILED: {exc}\n", file=sys.stderr)
        sys.exit(1)
