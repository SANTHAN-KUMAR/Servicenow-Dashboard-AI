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

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
