#!/usr/bin/env python3
"""Seed dev390988 with enough synthetic data to exercise the product honestly.

    python3 product/deploy/seed.py            seed
    python3 product/deploy/seed.py --purge    remove everything this ever created
    python3 product/deploy/seed.py --status   count what is currently seeded

Why this exists. dev390988 carries 67 incidents and 105 change requests, which is
not enough to tell whether a form engine picks good forms: almost every rule falls
through to the low-n guard. It is also not enough to demonstrate drilldown, because
three levels of drill over 67 records reaches single figures immediately.

Design rules, because synthetic data that is too clean proves nothing:

  * Deterministic. A seeded linear congruential generator, not Math.random, so a
    re-run produces the same instance state and a measurement taken against it can
    be reproduced.
  * Shaped, not uniform. Uniform random data makes every distribution flat, and a
    flat distribution is the one case where the form engine's concentration rules
    never fire. Categories are weighted, priority follows a realistic pyramid,
    demand has a weekday and business-hours cycle, and volume trends upward with a
    step change part way through so a trend line has something to say.
  * Deliberately imperfect. `subcategory` is populated on roughly 70% of records
    and only for the categories that plausibly have one, so the drill gate offers
    it with a partial caveat. `cmdb_ci` and `hold_reason` are left genuinely sparse
    so the gate can be seen rejecting a level for a real reason rather than a
    contrived one. Data that passes every gate would hide the thing worth showing.
  * Tagged. Every record carries a correlation_id, so --purge removes exactly what
    was added and nothing else. Nothing here touches a record it did not create.

Business rules and workflow are suppressed on insert. Without that, seeding fires
notifications, SLA attachment and assignment rules for every row, which is slow and
would email real users in the demo data.
"""

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from snclient import Instance, InstanceError  # noqa: E402

TAG = "CMD_SEED_V1"

TARGETS = {"incident": 4200, "change_request": 1400, "problem": 520}
BATCH = 300


# The category to subcategory map. Real ServiceNow choice values, but the pairing
# is ours: the instance stores subcategory choices as a flat list, and a hierarchy
# that is not in the data is exactly what this product exists to detect.
SUBCATS = {
    "software": ["email", "os", "internal application", "antivirus"],
    "hardware": ["cpu", "keyboard", "memory", "mouse", "monitor", "disk"],
    "network": ["dhcp", "dns", "ip address", "vpn", "wireless"],
    "database": ["oracle", "sql server", "db2"],
    # inquiry and password_reset get none, which is realistic and is what makes
    # the drill gate's partial-fill path observable.
}

SEED_JS = r"""
/* Deterministic PRNG. Math.random would make every run a different instance. */
var _s = __SEED__;
function rnd() { _s = (_s * 1103515245 + 12345) % 2147483648; return _s / 2147483648; }
function pick(a) { return a[Math.floor(rnd() * a.length)]; }
function weighted(pairs) {
  var t = 0, i;
  for (i = 0; i < pairs.length; i++) t += pairs[i][1];
  var r = rnd() * t, acc = 0;
  for (i = 0; i < pairs.length; i++) { acc += pairs[i][1]; if (r <= acc) return pairs[i][0]; }
  return pairs[pairs.length - 1][0];
}

var REF = __REF__;
var SUBCATS = __SUBCATS__;
var TAG = '__TAG__';
var TABLE = '__TABLE__';
var FROM = __FROM__, COUNT = __COUNT__;

/* Weighted so the head is concentrated. A flat category distribution never
   exercises the concentration branch of the form engine. */
var CATS = [['software',26],['hardware',22],['network',18],['inquiry',16],
            ['database',10],['password_reset',8]];
var PRIOS = [['1',4],['2',14],['3',46],['4',30],['5',6]];
var STATES = [['1',10],['2',14],['3',4],['6',34],['7',36],['8',2]];
var CR_CATS = [['Software',24],['Hardware',20],['Network',18],['Service',14],
               ['System Software',10],['Applications Software',8],['Telecom',4],['Other',2]];
var CR_TYPES = [['normal',62],['standard',26],['emergency',10],['model',2]];
var PROB_STATES = [['1',18],['2',22],['3',10],['4',44],['107',6]];

/* Business-hours and weekday demand cycle, so an hour-of-week heatmap has shape
   and is not a uniform block. Index 0 is Monday. */
var DAYW = [1.00, 0.96, 0.93, 0.90, 0.78, 0.17, 0.12];
var HOURW = [.04,.03,.02,.02,.03,.07,.16,.36,.74,1.00,.96,.82,
             .60,.79,.88,.83,.68,.45,.24,.15,.11,.08,.06,.05];

function pickHour() {
  for (var tries = 0; tries < 40; tries++) {
    var h = Math.floor(rnd() * 24);
    if (rnd() <= HOURW[h]) return h;
  }
  return 10;
}
function pickDow() {
  for (var tries = 0; tries < 40; tries++) {
    var d = Math.floor(rnd() * 7);
    if (rnd() <= DAYW[d]) return d;
  }
  return 2;
}

/* Volume rises over the window with a step change at month 7, so a trend line has
   a story and the "volume left its baseline" annotation is true rather than
   decorative. Returns a month offset back from now, 0..11. */
function pickMonthBack() {
  var w = [];
  for (var m = 0; m < 12; m++) {
    var age = 11 - m;                 /* 0 = oldest */
    var base = 0.55 + (age * 0.045);  /* gentle upward trend */
    if (age >= 7) base *= 1.42;       /* the step change */
    w.push([String(11 - age), base]);
  }
  return parseInt(weighted(w), 10);
}

function openedAt(monthsBack) {
  var d = new GlideDateTime();
  d.addMonthsUTC(-monthsBack);
  /* Land somewhere in that month, then snap onto the weekday/hour cycle. */
  var dom = 1 + Math.floor(rnd() * 27);
  var s = d.getValue().substr(0, 8) + (dom < 10 ? '0' + dom : dom);
  var g = new GlideDateTime(s + ' 12:00:00');
  var want = pickDow(), have = g.getDayOfWeekUTC() - 1;
  g.addDaysUTC(want - have);
  var h = pickHour();
  var hh = (h < 10 ? '0' + h : String(h));
  var mm = Math.floor(rnd() * 60); mm = (mm < 10 ? '0' + mm : String(mm));
  return new GlideDateTime(g.getValue().substr(0, 10) + ' ' + hh + ':' + mm + ':00');
}

/* Resolution time depends on priority, and one group is deliberately worse than
   the rest so a ranked bar of mean resolution has a finding in it. */
function resolveHours(prio, groupIdx) {
  var base = [0, 5, 14, 46, 120, 260][parseInt(prio, 10)] || 46;
  var spread = 0.35 + rnd() * 1.7;
  var penalty = (groupIdx === 2) ? 2.3 : 1.0;
  return base * spread * penalty;
}

var made = 0, skipped = 0;
for (var i = FROM; i < FROM + COUNT; i++) {
  var gr = new GlideRecord(TABLE);
  gr.initialize();
  gr.setWorkflow(false);        /* no business rules, no notifications, no SLAs */
  gr.autoSysFields(false);      /* so sys_created_on can match opened_at */

  var mb = pickMonthBack();
  var opened = openedAt(mb);
  var gi = Math.floor(rnd() * REF.groups.length);
  var prio = weighted(PRIOS);

  gr.setValue('opened_at', opened.getValue());
  gr.setValue('sys_created_on', opened.getValue());
  gr.setValue('correlation_id', TAG);
  gr.setValue('assignment_group', REF.groups[gi].id);
  if (rnd() < 0.82) gr.setValue('assigned_to', pick(REF.users).id);

  if (TABLE === 'incident') {
    var cat = weighted(CATS);
    gr.setValue('category', cat);
    /* Only where a subcategory plausibly exists, and only ~70% of the time. */
    var subs = SUBCATS[cat];
    if (subs && rnd() < 0.70) gr.setValue('subcategory', pick(subs));
    var st = weighted(STATES);
    gr.setValue('state', st);
    gr.setValue('incident_state', st);
    gr.setValue('priority', prio);
    gr.setValue('urgency', prio === '1' ? '1' : (prio === '2' ? '2' : '3'));
    gr.setValue('impact', prio === '1' ? '1' : (prio === '5' ? '3' : '2'));
    gr.setValue('contact_type', pick(REF.contactType));
    gr.setValue('short_description', 'Seeded ' + cat + ' incident ' + i);
    /* Left sparse on purpose, so the drill gate can be seen rejecting a level. */
    if (rnd() < 0.34) gr.setValue('cmdb_ci', pick(REF.cis).id);
    if (st === '3' && rnd() < 0.8) gr.setValue('hold_reason', String(1 + Math.floor(rnd() * 4)));
    if (st === '6' || st === '7') {
      var r1 = new GlideDateTime(opened.getValue());
      r1.addSeconds(Math.round(resolveHours(prio, gi) * 3600));
      gr.setValue('resolved_at', r1.getValue());
      if (st === '7') { var c1 = new GlideDateTime(r1.getValue());
        c1.addSeconds(Math.round((4 + rnd() * 70) * 3600)); gr.setValue('closed_at', c1.getValue()); }
    }
  } else if (TABLE === 'change_request') {
    /* Both levels always populated, the deliberate contrast with incident:
       the same declared hierarchy shape, one healthy and one not. */
    gr.setValue('category', weighted(CR_CATS));
    gr.setValue('type', weighted(CR_TYPES));
    gr.setValue('priority', prio);
    gr.setValue('risk', String(2 + Math.floor(rnd() * 3)));
    gr.setValue('impact', prio === '1' ? '1' : '2');
    var cst = weighted([['-5',12],['-4',10],['-3',8],['-2',6],['0',10],['3',44],['4',10]]);
    gr.setValue('state', cst);
    gr.setValue('short_description', 'Seeded change ' + i);
    if (cst === '3' || cst === '4') {
      var r2 = new GlideDateTime(opened.getValue());
      r2.addSeconds(Math.round(resolveHours(prio, gi) * 3600 * 1.6));
      gr.setValue('closed_at', r2.getValue());
    }
  } else {
    gr.setValue('state', weighted(PROB_STATES));
    gr.setValue('priority', prio);
    gr.setValue('impact', prio === '1' ? '1' : '2');
    gr.setValue('short_description', 'Seeded problem ' + i);
    if (rnd() < 0.5) gr.setValue('cmdb_ci', pick(REF.cis).id);
  }

  if (gr.insert()) made++; else skipped++;
}
gs.print('@@' + JSON.stringify({table: TABLE, made: made, skipped: skipped}));
"""

PURGE_JS = r"""
var total = 0, per = {};
var tables = __TABLES__;
for (var i = 0; i < tables.length; i++) {
  var gr = new GlideRecord(tables[i]);
  gr.addQuery('correlation_id', '__TAG__');
  gr.setWorkflow(false);
  gr.query();
  var n = gr.getRowCount();
  gr.deleteMultiple();
  per[tables[i]] = n; total += n;
}
gs.print('@@' + JSON.stringify({deleted: total, per: per}));
"""

STATUS_JS = r"""
var out = {};
var tables = __TABLES__;
for (var i = 0; i < tables.length; i++) {
  var t = tables[i];
  var a = new GlideAggregate(t); a.addAggregate('COUNT'); a.query();
  var all = a.next() ? parseInt(a.getAggregate('COUNT'), 10) : 0;
  var b = new GlideAggregate(t); b.addQuery('correlation_id', '__TAG__');
  b.addAggregate('COUNT'); b.query();
  var mine = b.next() ? parseInt(b.getAggregate('COUNT'), 10) : 0;
  out[t] = {total: all, seeded: mine};
}
gs.print('@@' + JSON.stringify(out));
"""


def render(tpl, **kw):
    """Token substitution rather than %-formatting: the JS contains literal % and
    would otherwise have to escape every one of them, which is a bug waiting to
    happen every time a comment is edited."""
    out = tpl
    for k, v in kw.items():
        out = out.replace("__" + k.upper() + "__", str(v))
    return out


def reference_data(inst):
    return inst.run_json("""
var out = {};
function ids(t, q, n, disp) {
  var a = []; var gr = new GlideRecord(t);
  if (q) gr.addEncodedQuery(q);
  gr.setLimit(n); gr.query();
  while (gr.next()) a.push({id: gr.getUniqueValue(), name: gr.getDisplayValue(disp || 'name')});
  return a;
}
out.groups = ids('sys_user_group', 'active=true', 8);
out.users  = ids('sys_user', 'active=true^emailISNOTEMPTY', 14, 'name');
out.cis    = ids('cmdb_ci', '', 12);
out.contactType = ['chat','email','phone','self-service','virtual_agent','walk-in'];
gs.print('@@' + JSON.stringify(out));
""")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--purge", action="store_true")
    ap.add_argument("--status", action="store_true")
    ap.add_argument("--only", default=None, help="seed one table only")
    ap.add_argument("--credentials", default=None)
    args = ap.parse_args()

    inst = Instance(args.credentials, verbose=False).login()
    tables = json.dumps(list(TARGETS.keys()))
    print()

    if args.status:
        st = inst.run_json(render(STATUS_JS, tables=tables, tag=TAG))
        for t, v in st.items():
            print(f"  {t:18s} {v['total']:>7,} total, {v['seeded']:>7,} seeded by us")
        print()
        return 0

    if args.purge:
        r = inst.run_json(render(PURGE_JS, tables=tables, tag=TAG))
        for t, n in r["per"].items():
            print(f"  purged {n:>7,} from {t}")
        print(f"\n  {r['deleted']:,} records removed, tagged {TAG}\n")
        return 0

    ref = reference_data(inst)
    print(f"  reference: {len(ref['groups'])} groups, {len(ref['users'])} users, "
          f"{len(ref['cis'])} CIs")

    existing = inst.run_json(render(STATUS_JS, tables=tables, tag=TAG))
    for table, target in TARGETS.items():
        if args.only and table != args.only:
            continue
        already = existing[table]["seeded"]
        need = max(0, target - already)
        if not need:
            print(f"  {table:18s} already at {already:,}, nothing to do")
            continue
        made = 0
        while made < need:
            n = min(BATCH, need - made)
            r = inst.run_json(render(
                SEED_JS,
                seed=20260803 + made + len(table),
                ref=json.dumps(ref),
                subcats=json.dumps(SUBCATS),
                tag=TAG, table=table,
                **{"from": already + made, "count": n}))
            made += r["made"]
            print(f"  {table:18s} +{r['made']:>4} (skipped {r['skipped']})  "
                  f"running total {already + made:,}")
        print()

    st = inst.run_json(render(STATUS_JS, tables=tables, tag=TAG))
    print("  final")
    for t, v in st.items():
        print(f"    {t:18s} {v['total']:>7,} total ({v['seeded']:,} seeded)")
    print()
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except InstanceError as e:
        print(f"\n  FAILED: {e}\n", file=sys.stderr)
        sys.exit(1)
