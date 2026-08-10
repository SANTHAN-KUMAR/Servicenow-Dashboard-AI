/**
 * Regression tests for the pure reduction helpers in CmdData.
 *
 * These matter more than most tests in this repo, because the helpers exist
 * specifically to replace GlideDateTime with arithmetic on the stored string. That
 * swap is worth roughly two orders of magnitude inside a 20,000-row scan, and it is
 * only safe if the arithmetic is right across leap years, century boundaries and
 * quarter edges. GlideDateTime was correct and slow; being fast and subtly wrong
 * about February would be a much worse trade than the one it replaced.
 *
 * Everything under test is a plain function on plain values, so it runs in Node
 * against the real file rather than a copy of it. The file is loaded through `vm`
 * because its helpers are file-scope function declarations, not exports, and the
 * point is to test the code that actually ships.
 *
 *   node product/tests/test_data_helpers.js
 */
'use strict';

var fs = require('fs');
var vm = require('vm');
var path = require('path');

var SRC = path.join(__dirname, '..', 'script-includes', 'CmdData.js');

/* Enough of the platform to let the file evaluate. Nothing under test touches any
   of it; the stubs exist so `var CmdData = Class.create()` and the prototype
   literal can be defined at all. */
var sandbox = {
    Class: { create: function () { return function () {}; } },
    GlideRecord: function () {},
    GlideRecordSecure: function () {},
    GlideAggregate: function () {},
    GlideDateTime: function () {},
    gs: { print: function () {}, getUserName: function () { return 'test'; } }
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(SRC, 'utf8'), sandbox, { filename: SRC });

var pass = 0, fail = 0;

function ok(name, cond, detail) {
    if (cond) { pass++; }
    else { fail++; console.log('  FAIL  ' + name + (detail ? '  -> ' + detail : '')); }
}

function eq(name, actual, expected) {
    ok(name, actual === expected, 'got ' + JSON.stringify(actual) +
       ', expected ' + JSON.stringify(expected));
}

function near(name, actual, expected, tol) {
    ok(name, Math.abs(actual - expected) <= (tol === undefined ? 1e-6 : tol),
       'got ' + actual + ', expected ~' + expected);
}

var civilDays = sandbox.civilDays;
var civilToIso = sandbox.civilToIso;
var epochSecOf = sandbox.epochSecOf;
var dowMondayFirst = sandbox.dowMondayFirst;
var bucketKeyOf = sandbox.bucketKeyOf;
var quantilesOf = sandbox.quantilesOf;
var binsOf = sandbox.binsOf;
var correlationOf = sandbox.correlationOf;

console.log('\ncivilDays — days since 1970-01-01');
eq('epoch itself', civilDays(1970, 1, 1), 0);
eq('day after epoch', civilDays(1970, 1, 2), 1);
eq('day before epoch', civilDays(1969, 12, 31), -1);
/* 2000 is a leap year (divisible by 400); 1900 is not (divisible by 100 but not
   400). This pair is the classic off-by-one in hand-rolled date maths. */
eq('2000-03-01 across a leap day', civilDays(2000, 3, 1), 11017);
eq('1900-03-01 across a non-leap century', civilDays(1900, 3, 1), -25508);
eq('2024-02-29 exists', civilDays(2024, 3, 1) - civilDays(2024, 2, 28), 2);
eq('2023-02 has no 29th', civilDays(2023, 3, 1) - civilDays(2023, 2, 28), 1);
eq('2026-08-03 (today on this engagement)', civilDays(2026, 8, 3), 20668);

console.log('civilToIso — the inverse');
var roundTripFails = 0;
for (var d = -30000; d <= 30000; d += 7) {
    var iso = civilToIso(d);
    var y = parseInt(iso.substr(0, 4), 10);
    var m = parseInt(iso.substr(5, 2), 10);
    var dd = parseInt(iso.substr(8, 2), 10);
    if (civilDays(y, m, dd) !== d) roundTripFails++;
}
eq('round trips over ~164 years', roundTripFails, 0);
eq('epoch formats', civilToIso(0), '1970-01-01');
eq('leap day formats', civilToIso(civilDays(2024, 2, 29)), '2024-02-29');

console.log('dowMondayFirst — 0=Monday');
eq('1970-01-01 was a Thursday', dowMondayFirst('1970-01-01 00:00:00'), 3);
eq('2026-08-03 is a Monday', dowMondayFirst('2026-08-03 09:00:00'), 0);
eq('2026-08-09 is a Sunday', dowMondayFirst('2026-08-09 09:00:00'), 6);
eq('2024-02-29 was a Thursday', dowMondayFirst('2024-02-29 12:00:00'), 3);
eq('garbage in returns -1', dowMondayFirst('not-a-date'), -1);

console.log('epochSecOf — and the durations built on it');
eq('epoch is zero', epochSecOf('1970-01-01 00:00:00'), 0);
eq('one hour', epochSecOf('1970-01-01 01:00:00'), 3600);
eq('date-only tolerated', epochSecOf('1970-01-02'), 86400);
eq('unparseable returns null', epochSecOf('x'), null);
eq('empty returns null', epochSecOf(''), null);
/* The thing the duration accumulator actually computes. */
near('elapsed hours across a month boundary',
     (epochSecOf('2026-03-01 06:30:00') - epochSecOf('2026-02-28 18:30:00')) / 3600, 12);
near('elapsed hours across a leap day',
     (epochSecOf('2024-03-01 00:00:00') - epochSecOf('2024-02-28 00:00:00')) / 3600, 48);

console.log('platform strings — the Rhino java.lang.String trap');
/* GlideDateTime.getValue() hands back a java.lang.String, and on one of those
 * `length` resolves to the Java method rather than to the JS property. So
 * `s.length < 10` compares a function with a number, Rhino cannot coerce it, and
 * the page dies with "Cannot find default value for object" on a line that reads
 * as obviously correct. It cost a deployment.
 *
 * A plain JS string can never reproduce it, which is exactly why the Node suite
 * was green while the instance was failing. This fake has the shape that matters:
 * a `length` that is callable rather than numeric, and a working toString. */
function javaish(value) {
    return {
        length: function () { return value.length; },
        substr: function (a, b) { return value.substr(a, b); },
        toString: function () { return value; }
    };
}
eq('epochSecOf survives a java-style string',
   epochSecOf(javaish('1970-01-02 00:00:00')), 86400);
eq('bucketKeyOf survives a java-style string',
   bucketKeyOf(javaish('2026-08-03 11:22:33'), 'month'), '2026-08');
eq('dowMondayFirst survives a java-style string',
   dowMondayFirst(javaish('2026-08-03 09:00:00')), 0);
/* And the guards still reject genuinely absent input rather than coercing it to
   the string "null" and reading a year out of it. */
eq('null is still rejected', epochSecOf(null), null);
eq('undefined is still rejected', epochSecOf(undefined), null);
eq('null is still rejected by bucketKeyOf', bucketKeyOf(null, 'month'), null);
eq('undefined is still rejected by dowMondayFirst', dowMondayFirst(undefined), -1);

console.log('bucketKeyOf — must match what _bucketBounds keys on');
eq('month', bucketKeyOf('2026-08-03 11:22:33', 'month'), '2026-08');
eq('day', bucketKeyOf('2026-08-03 11:22:33', 'day'), '2026-08-03');
eq('Q3 starts in July', bucketKeyOf('2026-08-03 00:00:00', 'quarter'), '2026-07');
eq('Q1 starts in January', bucketKeyOf('2026-02-14 00:00:00', 'quarter'), '2026-01');
eq('Q4 starts in October', bucketKeyOf('2026-12-31 00:00:00', 'quarter'), '2026-10');
/* A week key is the Monday of that week, because that is what _bucketBounds
   snaps to. A Sunday belongs to the week that started six days earlier. */
eq('Monday keys itself', bucketKeyOf('2026-08-03 00:00:00', 'week'), '2026-08-03');
eq('Sunday keys back to Monday', bucketKeyOf('2026-08-09 23:59:59', 'week'), '2026-08-03');
eq('week crossing a month', bucketKeyOf('2026-09-01 10:00:00', 'week'), '2026-08-31');
eq('short input returns null', bucketKeyOf('2026', 'month'), null);

console.log('quantilesOf — five-number summary and Tukey fences');
var q = quantilesOf([1, 2, 3, 4, 5, 6, 7, 8, 9]);
eq('median of 1..9', q.median, 5);
eq('q1 of 1..9', q.q1, 3);
eq('q3 of 1..9', q.q3, 7);
eq('min', q.min, 1);
eq('max', q.max, 9);
eq('no outliers in a uniform run', q.outlierCount, 0);
/* Interpolated, matching the spreadsheet convention, so a client checking by hand
   gets the same number. */
near('median of an even-length set', quantilesOf([1, 2, 3, 4]).median, 2.5);
near('q1 interpolates', quantilesOf([1, 2, 3, 4]).q1, 1.75);

var out = quantilesOf([10, 11, 12, 12, 13, 13, 14, 15, 200]);
ok('an extreme value is flagged as an outlier', out.outlierCount === 1,
   'count was ' + out.outlierCount);
ok('the whisker stops at a real observation, not the fence',
   out.hi === 15, 'hi was ' + out.hi);
eq('the outlier is carried for drawing', out.outliers[0], 200);

eq('empty input does not throw', quantilesOf([]).n, 0);
eq('single value', quantilesOf([7]).median, 7);
eq('all identical', quantilesOf([5, 5, 5, 5]).q1, 5);
eq('identical values produce no outliers', quantilesOf([5, 5, 5, 5]).outlierCount, 0);

console.log('binsOf — histogram over observations, not over distinct values');
/* The bug this replaces: binning the group-by rows counted each distinct value
   once, so a value occurring 10,000 times and one occurring twice drew equal bars.
   Here the second bin must dominate. */
var many = [];
for (var i = 0; i < 1000; i++) many.push(50);
many.push(1);
var b = binsOf(many);
ok('mass lands in one bin', Math.max.apply(null, b.bins.map(function (x) { return x.count; })) === 1000,
   JSON.stringify(b.bins.map(function (x) { return x.count; })));
eq('bin count is clamped to a drawable range', b.bins.length >= 6 && b.bins.length <= 24, true);

var spread = [];
for (var j = 0; j < 200; j++) spread.push(j);
var bs = binsOf(spread);
var tot = bs.bins.reduce(function (a, x) { return a + x.count; }, 0);
eq('every observation lands in exactly one bin', tot, 200);
eq('lo is the minimum', bs.lo, 0);
eq('hi is the maximum', bs.hi, 199);

eq('degenerate single-value column', binsOf([3, 3, 3]).degenerate, true);
eq('too few values to bin', binsOf([1]).bins.length, 0);

console.log('correlationOf');
var perfect = [];
for (var p = 0; p < 20; p++) perfect.push({ x: p, y: 2 * p + 1 });
near('a perfect line is 1', correlationOf(perfect), 1, 1e-9);
var inverse = [];
for (var n2 = 0; n2 < 20; n2++) inverse.push({ x: n2, y: -3 * n2 });
near('a perfect inverse is -1', correlationOf(inverse), -1, 1e-9);
eq('a constant column has no correlation',
   correlationOf([{ x: 1, y: 5 }, { x: 2, y: 5 }, { x: 3, y: 5 }]), null);
eq('too few points to say', correlationOf([{ x: 1, y: 1 }, { x: 2, y: 2 }]), null);

/* The regression these exist for: the projection used to divide elapsed-since-row-
   zero by rows-so-far, which charges every row for the query setup that happened
   once. On incident that read 0.64ms/row against a true 0.21ms/row and abandoned a
   proof that fits its budget three times over -- and because the overestimate races
   setup cost, identical page loads disagreed, showing 4,266 records or 50.
   The numbers below are the ones measured on dev390988. */
console.log('projectProof');
var projectProof = sandbox.CmdData.projectProof;
var MARGIN = sandbox.CmdData.PREDICT_MARGIN;

/* incident, solved from the two points the instance actually logged: a complete
   proof of 4,266 rows took 909ms, and a scan that bailed at row 50 had spent 32ms.
   Those give 0.208ms/row with 21.6ms of fixed setup -- so setup is two thirds of
   the elapsed time at row 50, which is exactly what the old estimate mistook for
   per-row cost. At row 150 the scan has spent 52.8ms and the last 100 rows took
   20.8ms. */
var inc = projectProof(52.8, 20.8, 100, 4266 - 150);
near('incident is projected at the 909ms it actually took', inc, 909, 15);
ok('so incident is allowed to finish', inc <= 2500 * MARGIN, 'projected ' + inc);

/* The old arithmetic on the same scan, at the row it actually gave up on. */
var oldWay = (32 / 50) * 4266;
ok('the old arithmetic overshot the budget and abandoned it', oldWay > 2500,
   'old projected ' + Math.round(oldWay) + 'ms for a proof that costs 909ms');

/* kb_knowledge: genuinely expensive at ~5ms/row. It must still be abandoned, and
   abandoned early -- 150 rows in, not after burning the whole budget. */
var kb = projectProof(760, 500, 100, 757 - 150);
ok('a genuinely hopeless proof is still abandoned', kb > 2500 * MARGIN,
   'projected ' + kb);

/* A table whose true cost sits just over the budget is run rather than flipped on,
   because a projection from 100 rows cannot resolve a difference that small. */
var borderline = projectProof(300, 260, 100, 1000);
ok('borderline stays inside the margin', borderline > 2500 && borderline <= 2500 * MARGIN,
   'projected ' + borderline);

eq('nothing left to admit costs nothing more', projectProof(400, 100, 100, 0), 400);
eq('an empty window cannot set a rate', projectProof(400, 0, 0, 900), 400);

/* The regression: MySQL's default collation is case-insensitive, so GROUP BY
   folds `hardware` and `Hardware` into one bucket and returns an arbitrary
   casing, while the secure path reads each row and splits them into two. The
   same category therefore merged or split depending on which path ran, and the
   key -- which drill filters, ordinal sorts and choice lookups all compare
   exactly -- was not the declared value. Measured on dev390988: sys_choice
   declares one entry, value `hardware`, and the payload carried key `Hardware`. */
console.log('_canonKey — snapping grouped values to their declared spelling');
var data = new sandbox.CmdData();
data.meta = function () {
    return {
        choices: function (table, field) {
            if (table === 'incident' && field === 'category') {
                return [
                    { value: 'hardware', label: 'Hardware' },
                    { value: 'network', label: 'Network' },
                    { value: 'password_reset', label: 'Password Reset' }
                ];
            }
            return [];                                   // not a choice field
        }
    };
};

eq('a wrongly-cased value snaps to the declared one',
   data._canonKey('incident', 'category', 'Hardware'), 'hardware');
eq('an already-canonical value is untouched',
   data._canonKey('incident', 'category', 'network'), 'network');
eq('underscored values snap too',
   data._canonKey('incident', 'category', 'Password_Reset'), 'password_reset');
eq('a value absent from the list is left alone, not invented',
   data._canonKey('incident', 'category', 'Outllook SPA mailbox'),
   'Outllook SPA mailbox');
eq('a field with no choice list is never rewritten',
   data._canonKey('incident', 'short_description', 'Hardware'), 'Hardware');
eq('empty stays empty', data._canonKey('incident', 'category', ''), '');
eq('null becomes empty', data._canonKey('incident', 'category', null), '');
/* Reference and free-text fields must survive verbatim: rewriting a sys_id or a
   person's name to match some unrelated choice list would be far worse than the
   bug this fixes. */
eq('a sys_id is never touched',
   data._canonKey('incident', 'assigned_to', '681ccaf9c0a8016400b98a06818d57c7'),
   '681ccaf9c0a8016400b98a06818d57c7');

/* F1 from the 2026-08-10 adversarial review: a drill URL widened with `^OR` or
   `^NQ` was accepted as a subset of an already-proven query and handed to an
   unchecked GlideRecord cursor. Confirmed live on dev390988:
   `category=software^ORsys_idISNOTEMPTY` against `incident`, proven trusted on
   the empty base query, returned all 4,266 rows -- the whole table -- still
   labelled VERIFIED. This is the fix, tested at both layers the review asked
   for: the pure predicate, and _trustedFor wired to it. */
console.log('_wideningOperator / _trustedFor — the ^OR / ^NQ query-injection fix');
var widening = sandbox.CmdData._wideningOperator;

eq('a plain AND clause does not widen', widening('category=software'), false);
eq('empty adds nothing', widening(''), false);
eq('null is not widening', widening(null), false);
eq('OR right after the proven prefix widens',
   widening('ORsys_idISNOTEMPTY'), true);
eq('OR after a later ^ widens',
   widening('category=software^ORsys_idISNOTEMPTY'), true);
eq('NQ widens the same way', widening('category=software^NQsys_idISNOTEMPTY'), true);
eq('a lowercase field starting "or..." is not mistaken for the operator',
   widening('order_number=5'), false);
eq('a real clause containing the letters "or" mid-field is untouched',
   widening('category=software^priority=1'), false);

var d2 = new sandbox.CmdData();
d2._verdict = {};

/* The live scenario: an empty base query proven trusted, exactly the common
   case -- "the page proves the whole table once and every panel inherits it." */
d2._verdict['incident|'] = { trusted: true };
eq('a narrowing AND clause is trusted (the normal, safe drill)',
   d2._trustedFor('incident', 'category=software'), true);
eq('the injected OR widening is REFUSED, not silently trusted',
   d2._trustedFor('incident', 'category=software^ORsys_idISNOTEMPTY'), false);
eq('the injected NQ widening is REFUSED the same way',
   d2._trustedFor('incident', 'category=software^NQsys_idISNOTEMPTY'), false);
eq('an untrusted table never becomes trusted',
   d2._trustedFor('change_request', 'category=software'), false);

/* The scenario the review's proof used: trust proven on a NARROWER base than the
   empty query (a time-windowed slice), so the fix must hold there too, not only
   in the common empty-base case. */
var d3 = new sandbox.CmdData();
d3._verdict = {};
d3._verdict['incident|opened_at>=2025-08-10 00:00:00'] = { trusted: true };
eq('narrowing a proven non-empty base is trusted',
   d3._trustedFor('incident', 'opened_at>=2025-08-10 00:00:00^category=software'),
   true);
eq('widening a proven non-empty base is refused',
   d3._trustedFor('incident',
     'opened_at>=2025-08-10 00:00:00^category=software^ORsys_idISNOTEMPTY'),
   false);
eq('an exact match to the proven base, no extra clause, is trusted',
   d3._trustedFor('incident', 'opened_at>=2025-08-10 00:00:00'), true);

/* F4 from the review, plus the performance question the fix raised: dateSpread's
   nonEmpty count used to be an unchecked fastCount() sitting right below a
   comment explaining why the rest of the function is secure. Routing it through
   total()/aclVerdict is correct, but aclVerdict re-proves from scratch for every
   distinct query string -- and dateSpread calls it once per candidate date
   field, each with its own field-specific query. Naively that would trade one
   correctness bug for a new one-proof-scan-per-field performance cost.
   aclVerdict now checks _trustedFor before proving, so a query that only
   narrows an already-trusted one inherits that trust instead. Tested here by
   stubbing out the Glide-backed methods so the LOGIC is exercised without an
   instance: does the narrowed query really skip secureCountBoxed. */
console.log('aclVerdict — inherits trust from a wider proof instead of re-proving');

function verdictProbe() {
    var d = new sandbox.CmdData();
    d._verdict = {};
    d._counts = {};
    d.canRead = function () { return true; };
    d.fastCount = function (table, query) {
        /* A stand-in table where the fast count of any subset of the proven
           base equals its true (secure) count -- i.e. ACLs filter nothing for
           this viewer, the case that makes trust transfer sound at all. */
        var known = { '': 100, 'category=software': 40,
                       'category=software^ORsys_idISNOTEMPTY': 100 };
        return known[query || ''] !== undefined ? known[query || ''] : 0;
    };
    var proofCalls = 0;
    d.secureCountBoxed = function (table, query, budgetMs) {
        proofCalls++;
        var n = d.fastCount(table, query);
        return { count: n, capped: false, timedOut: false, predictedMs: 0,
                target: n, ms: 1 };
    };
    d.proofCalls = function () { return proofCalls; };
    return d;
}

var vp = verdictProbe();
var root = vp.aclVerdict('incident', '');
eq('the first call for a table proves it, and finds it trusted', root.trusted, true);
eq('exactly one proof ran for the root query', vp.proofCalls(), 1);

var narrowed = vp.aclVerdict('incident', 'category=software');
eq('a query that only narrows the proven root is trusted too',
   narrowed.trusted, true);
eq('...without a second proof -- it inherited trust from _trustedFor',
   vp.proofCalls(), 1);
eq('its count is the fast count for THIS query, not the root\'s',
   narrowed.aggregate, 40);

/* The security fix and the performance fix must not cancel each other out: a
   widened query must still fall through to a real proof, never inherit trust
   silently. */
var widened = vp.aclVerdict('incident', 'category=software^ORsys_idISNOTEMPTY');
eq('a widened query does NOT inherit trust -- it triggers its own proof',
   vp.proofCalls(), 2);
eq('and that proof is what decides its trusted-ness, not a false inheritance',
   widened.trusted, true);                       // true here only because the
                                                   // stub's fast/secure agree for
                                                   // this query too; the point is
                                                   // proofCalls incremented, i.e.
                                                   // it was actually re-checked.

/* A second, unrelated table must never inherit another table's trust. */
var other = verdictProbe();
other.aclVerdict('incident', '');
var untouched = other.aclVerdict('change_request', 'category=software');
eq('an unrelated table is proved on its own, not inherited from incident',
   other.proofCalls(), 2);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
