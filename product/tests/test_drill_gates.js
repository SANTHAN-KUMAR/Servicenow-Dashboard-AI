/**
 * Regression test for the false-uniformity claim found in the 2026-09-09 audit.
 *
 * `task` on dev390988 is expensive to permission-check. Its profile scans were
 * spending their whole budget before admitting a single row, so CmdData._shape
 * returned distinct 0 over total 0 -- and CmdDrill.gate read that as
 *
 *     "every record here has the same active"
 *
 * printed on the page, in the same voice the product uses for real measurements.
 * The column actually holds 7,380 true and 1,123 false. The page stated a fact
 * about 8,503 records on the strength of having read none of them, and it did the
 * same for approval, escalation, contact type, reassignment count and additional
 * assignee list -- six false claims on one screen.
 *
 * The rule these tests pin down: **a bounded scan proves presence and never
 * absence.** Every gate rejection except MAX_DISTINCT concludes that something is
 * not there, and no such conclusion survives a scan that stopped early, because
 * the rows it never reached are exactly the ones that would overturn it. The two
 * directions that do survive are lower bounds: a prefix already holding enough
 * distinct values proves the slice does, and one already holding too many proves
 * that too.
 *
 * Run with: node product/tests/test_drill_gates.js
 */
'use strict';

var fs = require('fs');
var path = require('path');
var vm = require('vm');

var SRC = path.join(__dirname, '..', 'script-includes', 'CmdDrill.js');
var DATA = path.join(__dirname, '..', 'script-includes', 'CmdData.js');

var sandbox = {
    Class: {
        create: function () {
            return function () {
                if (this.initialize) this.initialize.apply(this, arguments);
            };
        }
    },
    GlideRecord: function () {},
    GlideRecordSecure: function () {},
    GlideAggregate: function () {},
    GlideDateTime: function () {},
    GlideDuration: function () {},
    GlideStringUtil: {},
    gs: { print: function () {}, info: function () {}, getUserName: function () { return 'test'; },
          getUserDisplayName: function () { return 'Test'; },
          getProperty: function () { return null; } }
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(SRC, 'utf8'), sandbox, { filename: SRC });
vm.runInContext(fs.readFileSync(DATA, 'utf8'), sandbox, { filename: DATA });

var pass = 0, fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass++; }
    else { fail++; console.log('  FAIL  ' + name + (detail ? '  -> ' + detail : '')); }
}
function has(name, hay, needle) {
    ok(name, String(hay).indexOf(needle) !== -1,
       'got ' + JSON.stringify(String(hay)));
}
function hasnt(name, hay, needle) {
    ok(name, String(hay).indexOf(needle) === -1,
       'got ' + JSON.stringify(String(hay)));
}

/* _shape is the thing that decides whether a profile rests on any rows, so it is
   exercised directly rather than through a faked profile object. Called on a bare
   object because it reads nothing off `this`. */
var shapeOf = sandbox.CmdData.prototype._shape;
function shape(rows, acl) {
    var total = 0;
    for (var i = 0; i < rows.length; i++) total += rows[i].count;
    return shapeOf.call({}, 'task', 'active', rows, total, acl);
}

var CAPPED = { mode: 'BOUNDED', capped: true };
var WHOLE = { mode: 'FILTERED', capped: false };

/* A CmdData stand-in returning one prepared profile, plus the row count the gate
   asks for before it profiles anything. */
function drillWith(profile, rows) {
    var C = sandbox.CmdDrill;
    return new C({
        total: function () { return { count: rows === undefined ? 1000 : rows }; },
        profile: function () { return profile; }
    }, { dimensions: function () { return []; } });
}
var DIM = { name: 'active', label: 'Active' };

console.log('CmdDrill.gate — a bounded scan proves presence, never absence\n');

/* ── _shape: reading nothing is not the same as finding nothing ─────────── */

var nothingRead = shape([], CAPPED);
ok('a capped scan that admitted no rows is marked unmeasured',
   nothingRead.measured === false, JSON.stringify(nothingRead.measured));
ok('and it carries the cap forward so callers can see why',
   nothingRead.capped === true);

var genuinelyEmpty = shape([], WHOLE);
ok('a completed scan over an empty slice IS measured -- there is simply nothing there',
   genuinelyEmpty.measured === true, JSON.stringify(genuinelyEmpty.measured));

var partial = shape([{ key: 'true', count: 40 }], CAPPED);
ok('a capped scan that did admit rows is measured, on the rows it read',
   partial.measured === true);
ok('and is still flagged capped, because its numbers are a floor',
   partial.capped === true);

var complete = shape([{ key: 'true', count: 7380 }, { key: 'false', count: 1123 }], WHOLE);
ok('a completed scan is measured and not capped',
   complete.measured === true && complete.capped === false);

/* ── the live failure, pinned ───────────────────────────────────────────── */

var g = drillWith(nothingRead).gate('task', DIM, '');
ok('the live task case is not offered as a level', g.offer === false);
hasnt('and it no longer claims every record shares one value',
      g.reason, 'every record here has the same');
has('it says the scan read nothing instead', g.reason, 'not measured');
ok('and it is flagged for a caller that wants to treat it apart from a rejection',
   g.unmeasured === true);

/* ── uniformity is only claimable off a complete scan ───────────────────── */

var oneValueWhole = drillWith(shape([{ key: 'true', count: 8503 }], WHOLE))
    .gate('task', DIM, '');
has('a completed scan finding one value does say every record shares it',
    oneValueWhole.reason, 'every record here has the same active');
ok('and still refuses the level', oneValueWhole.offer === false);

var oneValueCapped = drillWith(shape([{ key: 'true', count: 300 }], CAPPED))
    .gate('task', DIM, '');
hasnt('a capped scan finding one value does not generalise to the slice',
      oneValueCapped.reason, 'every record here has the same');
has('it says how many rows it actually read', oneValueCapped.reason, '300 records read');
has('and that this is too few to conclude anything about the rest',
    oneValueCapped.reason, 'too few to tell whether the rest do');

/* ── emptiness is an absence too, so it is scoped to what was read ──────── */

var mostlyEmptyCapped = drillWith(shape(
    [{ key: '', count: 950 }, { key: 'true', count: 50 }], CAPPED))
    .gate('task', DIM, '');
ok('a field empty on almost everything read is still refused', mostlyEmptyCapped.offer === false);
has('but the claim is scoped to the rows the scan reached',
    mostlyEmptyCapped.reason, 'records read before the scan stopped');

var mostlyEmptyWhole = drillWith(shape(
    [{ key: '', count: 950 }, { key: 'true', count: 50 }], WHOLE))
    .gate('task', DIM, '');
has('over a complete scan the same claim is made about the slice itself',
    mostlyEmptyWhole.reason, 'of these records');

/* ── the two conclusions a lower bound DOES support ─────────────────────── */

var rows = [];
for (var i = 0; i < 60; i++) rows.push({ key: 'k' + i, count: 5 });
var tooMany = drillWith(shape(rows, CAPPED)).gate('task', DIM, '');
ok('too many distinct values is sound under a cap and still rejects', tooMany.offer === false);
has('and it is stated as the floor it is', tooMany.reason, 'at least 60 distinct values');
ok('with search offered instead', tooMany.searchable === true);

var enough = drillWith(shape(
    [{ key: 'true', count: 600 }, { key: 'false', count: 400 }], CAPPED))
    .gate('task', DIM, '');
ok('a capped scan already holding enough distinct values proves the slice does, so it is offered',
   enough.offer === true, enough.reason);
has('and the reader is told the fill is over what was read',
    enough.reason, 'of those read');

/* ── the cheap gates still short-circuit before any of this ─────────────── */

var tiny = drillWith(nothingRead, 4).gate('task', DIM, '');
has('too few rows is decided before profiling and is unchanged',
    tiny.reason, 'too few to break down further');

var none = drillWith(nothingRead, 0).gate('task', DIM, '');
has('an empty slice is decided before profiling and is unchanged',
    none.reason, 'no records in this slice');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
