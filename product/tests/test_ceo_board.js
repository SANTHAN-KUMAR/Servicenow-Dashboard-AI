/**
 * The CEO board's pure helpers, against the real file.
 *
 * Every number on the CEO page goes through three transformations that are plain
 * string and arithmetic work, and each has a way of being quietly wrong:
 *
 *   classify   which clause of a PA query pins it to "today". Widen the wrong one
 *              and a flow ("resolved today") becomes a stock, or PA's "open as at
 *              today" OR-group is torn apart into a query that counts something
 *              nobody defined.
 *   window     today -> the last N days, and the N days before that for the delta.
 *              Off by one here is a delta computed against an overlapping period.
 *   fill       a daily map -> today / period / previous period / 30 days / 12
 *              months. Every card's headline, delta and sparkline come from this.
 *
 *   node product/tests/test_ceo_board.js
 */
'use strict';

var fs = require('fs');
var vm = require('vm');
var path = require('path');

var SRC = path.join(__dirname, '..', 'script-includes', 'CmdCeoBoard.js');
var sandbox = {
    Class: { create: function () { return function () {}; } },
    gs: { getProperty: function (n, d) { return d; } },
    JSON: JSON, Math: Math, Date: Date, parseInt: parseInt, parseFloat: parseFloat, isNaN: isNaN
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(SRC, 'utf8'), sandbox, { filename: SRC });

var pass = 0, fail = 0;
function ok(name, cond, detail) {
    if (cond) pass++;
    else { fail++; console.log('  FAIL  ' + name + (detail ? '  -> ' + detail : '')); }
}
function eq(name, a, b) {
    ok(name, JSON.stringify(a) === JSON.stringify(b), 'got ' + JSON.stringify(a) + ', expected ' + JSON.stringify(b));
}

var S = sandbox;

/* The client's own cube conditions, verbatim from the inventory. */
var OPEN = 'opened_atONToday@javascript:gs.beginningOfToday()@javascript:gs.endOfToday()^ORopened_at<javascript:gs.beginningOfToday()^resolved_atISEMPTY^ORresolved_at>javascript:gs.endOfToday()^state!=8';
var RESOLVED = 'resolved_atONToday@javascript:gs.daysAgoStart(0)@javascript:gs.daysAgoEnd(0)^EQ';
var RESOLVED_FIRST = RESOLVED + '^reassignment_count=0^EQ';
var SELF_SERVICE = 'closed_atONToday@javascript:gs.daysAgoStart(0)@javascript:gs.daysAgoEnd(0)^EQ^\n            close_code=Resolved by caller^EQ';
var STALE = OPEN + '^sys_updated_onRELATIVELE@dayofweek@ago@30^EQ';
var SLA = 'sla.type=SLA^stage!=cancelled^task.sys_class_name=sc_req_item^task.closed_atONtoday@javascript:gs.beginningOfToday()@javascript:gs.endOfToday()';

console.log('classify');
eq('resolved today is an event on resolved_at', S.ceoClassify(RESOLVED).kind, 'event');
eq('its date field', S.ceoClassify(RESOLVED).field, 'resolved_at');
eq('its rest is empty once the window and EQ go', S.ceoClassify(RESOLVED).rest, '');
eq('an extra clause survives into the rest', S.ceoClassify(RESOLVED_FIRST).rest, 'reassignment_count=0');
eq('leading whitespace in an indicator condition is trimmed',
   S.ceoClassify(SELF_SERVICE).rest, 'close_code=Resolved by caller');
eq('the open-as-at-today OR group is a stock, not an event', S.ceoClassify(OPEN).kind, 'stock');
eq('a stock with a RELATIVE clause is marked relative', S.ceoClassify(STALE).relative, true);
eq('a dot-walked date field with a lowercase "today" label is an event',
   S.ceoClassify(SLA).field, 'task.closed_at');
eq('no today window at all is static', S.ceoClassify('type=emergency').kind, 'static');
eq('an NQ query is static rather than guessed at', S.ceoClassify('a=1^NQb=2').kind, 'static');

console.log('window');
var c = S.ceoClassify(RESOLVED_FIRST);
eq('30 days ending today',
   S.ceoWindowQuery(c, 30, 0),
   'reassignment_count=0^resolved_at>=javascript:gs.daysAgoStart(29)^resolved_at<=javascript:gs.daysAgoEnd(0)');
eq('the previous 30 days do not overlap the current ones',
   S.ceoWindowQuery(c, 30, 30),
   'reassignment_count=0^resolved_at>=javascript:gs.daysAgoStart(59)^resolved_at<=javascript:gs.daysAgoEnd(30)');
eq('today alone is the one-day window', S.ceoWindowQuery(S.ceoClassify(RESOLVED), 1, 0),
   'resolved_at>=javascript:gs.daysAgoStart(0)^resolved_at<=javascript:gs.daysAgoEnd(0)');
eq('the shared static entry point widens an event', S.CmdCeoBoard.windowQuery(RESOLVED, 7),
   'resolved_at>=javascript:gs.daysAgoStart(6)^resolved_at<=javascript:gs.daysAgoEnd(0)');
eq('and refuses a stock', S.CmdCeoBoard.windowQuery(OPEN, 7), null);

console.log('as of');
var then = S.ceoAsOf(OPEN, 30);
ok('as of 30 days ago moves both ends of the day', then.indexOf('gs.daysAgoStart(30)') !== -1 &&
   then.indexOf('gs.daysAgoEnd(30)') !== -1 && then.indexOf('Today()') === -1, then);
ok('and keeps the OR structure intact', then.indexOf('^ORopened_at<') !== -1 && then.indexOf('^ORresolved_at>') !== -1);
eq('a RELATIVE stock has no honest as-of', S.ceoAsOf(STALE, 30), null);
ok('month-end as-of uses monthsAgoEnd', S.ceoAsOfMonthEnd(OPEN, 3).indexOf('gs.monthsAgoEnd(3)') !== -1);

console.log('calendar');
eq('add across a month end', S.ceoIsoAdd('2026-03-01', -1), '2026-02-28');
eq('add across a leap day', S.ceoIsoAdd('2024-03-01', -1), '2024-02-29');
eq('add across a year', S.ceoIsoAdd('2026-01-01', -1), '2025-12-31');
eq('days between', S.ceoDaysBetween('2026-01-01', '2026-03-01'), 59);
eq('month back across a year', S.ceoMonthBack('2026-02-14', 3), '2025-11');
eq('month back twelve', S.ceoMonthBack('2026-09-14', 11), '2025-10');
eq('a UTC datetime as a Los Angeles date, evening', S.ceoLocalKey('2026-09-14 03:00:00', -25200000), '2026-09-13');
eq('a UTC datetime as an Indian date, morning', S.ceoLocalKey('2026-09-13 20:00:00', 19800000), '2026-09-14');
eq('trend key, platform default format', S.ceoTrendKey('2026-09-08/2026', 'yyyy-MM-dd'), '2026-09-08');
eq('trend key, US format', S.ceoTrendKey('09-08-2026/2026', 'MM-dd-yyyy'), '2026-09-08');
eq('trend key, day first with slashes', S.ceoTrendKey('08/09/2026/2026', 'dd/MM/yyyy'), '2026-09-08');
eq('trend key that cannot be read is null', S.ceoTrendKey('Week 36/2026', 'yyyy-MM-dd'), null);

console.log('fill');
var today = '2026-09-14';
var keys = [];
for (var i = 0; i < 400; i++) keys.push(S.ceoIsoAdd(today, -i));
var monthKeys = [];
for (var m = 11; m >= 0; m--) monthKeys.push(S.ceoMonthBack(today, m));
var map = {};
map['2026-09-14'] = 5;            /* today */
map['2026-09-10'] = 3;            /* inside 7 and 30 */
map['2026-08-20'] = 7;            /* inside 30, day 25 */
map['2026-08-10'] = 11;           /* day 35: previous 30 */
map['2025-10-05'] = 2;            /* inside the 12 months */
map['2025-09-30'] = 100;          /* outside the 12 months */
var L = {};
S.ceoFill(L, map, { dayKeys: keys, days: 30, monthKeys: monthKeys });
eq('today is PA\'s own number', L.pa, 5);
eq('the period sums days 0..29', L.win, 15);
eq('the previous period sums days 30..59', L.prev, 11);
eq('thirty daily points, oldest first, today last', [L.days.length, L.days[29], L.days[25]], [30, 5, 3]);
eq('twelve months, oldest first', L.months.length, 12);
eq('the current month is last', L.months[11], 8);
eq('a month outside the window is not counted', L.months[0], 2);
var L1 = {};
S.ceoFill(L1, map, { dayKeys: keys, days: 1, monthKeys: monthKeys });
eq('a one-day period is today, and its previous is yesterday', [L1.win, L1.prev], [5, 0]);

console.log('formula');
var ast = { op: '*', a: { op: '/', a: { ref: 'a' }, b: { ref: 'b' } }, b: { num: 100 } };
eq('a ratio evaluates', S.ceoEval(ast, function (r) { return r === 'a' ? 3 : 4; }).v, 75);
eq('a zero denominator is refused, not Infinity',
   S.ceoEval(ast, function (r) { return r === 'a' ? 3 : 0; }).why,
   'its denominator is zero, so there is nothing to divide');
eq('a missing component is refused', S.ceoEval(ast, function () { return null; }).v, null);
var arr = S.ceoEvalArray(ast, { a: { days: [1, 2, 0] }, b: { days: [2, 0, 4] } }, 'days');
eq('point by point, with a gap where the denominator is zero', arr, [50, null, 0]);
eq('unequal histories are not combined', S.ceoEvalArray(ast, { a: { days: [1] }, b: { days: [1, 2] } }, 'days'), null);

console.log('delta and direction');
eq('fewer of a minimise measure is better', S.ceoDelta(8, 10, 'down').better, true);
eq('more of a maximise measure is better', S.ceoDelta(12, 10, 'up').better, true);
eq('no change is neither', S.ceoDelta(10, 10, 'up').better, null);
eq('a direction of none never judges', S.ceoDelta(12, 10, 'none').better, null);
eq('relative change', S.ceoDelta(15, 10, 'up').rel, 0.5);
eq('from zero there is no relative change', S.ceoDelta(5, 0, 'up').rel, null);
eq('no previous, no delta', S.ceoDelta(5, null, 'up'), null);

console.log('modes, filters, keys');
eq('the worst verdict wins', S.ceoWorstMode(['VERIFIED', 'FILTERED', 'VERIFIED']), 'FILTERED');
eq('bounded outranks filtered', S.ceoWorstMode(['FILTERED', 'BOUNDED']), 'BOUNDED');
eq('filter applied everywhere', S.ceoFilterState(['all', 'all']), 'all');
eq('filter applied to part of a formula', S.ceoFilterState(['all', 'none']), 'some');
eq('no filters', S.ceoFilterState(['n/a']), 'n/a');
eq('natural order puts 2 before 10', ['portfolio10', 'portfolio2', 'portfolio1'].sort(S.ceoNaturalCompare),
   ['portfolio1', 'portfolio2', 'portfolio10']);
eq('the cache key is stable', S.ceoHash('abc'), S.ceoHash('abc'));
ok('and differs for different input', S.ceoHash('abc') !== S.ceoHash('abd'));

console.log('filter parsing');
var B = new S.CmdCeoBoard();
var parse = S.CmdCeoBoard.prototype.parseFilters;
eq('fields and values', parse.call(B, 'priority:1,2|category:network'),
   [{ field: 'category', values: ['network'] }, { field: 'priority', values: ['1', '2'] }]);
eq('an undeclared field is dropped', parse.call(B, 'caller_id:abc|priority:1'), [{ field: 'priority', values: ['1'] }]);
eq('a value carrying a query operator is dropped', parse.call(B, 'category:software^ORsys_idISNOTEMPTY'), []);
eq('an assignment group must be a sys_id', parse.call(B, 'assignment_group:Service Desk'), []);
eq('a field given twice keeps the first', parse.call(B, 'priority:1|priority:2'), [{ field: 'priority', values: ['1'] }]);

console.log('\n' + pass + ' passed' + (fail ? ', ' + fail + ' FAILED' : ''));
process.exit(fail ? 1 : 0);
