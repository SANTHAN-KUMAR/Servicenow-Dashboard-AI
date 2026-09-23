/**
 * CmdWorkspace: the gate between a workspace list's URL parameters and the
 * engine. Offline, with a stubbed platform, for the parts that decide safety:
 *
 *   - the javascript: allowlist (a URL query must never run an arbitrary script
 *     on the server, and must still carry "Last 30 days" and "is me");
 *   - resolving the bare global helpers getMyAssignments()/getMyGroups(), which
 *     measurably mis-evaluate inside the scoped app (650 rows where the platform
 *     counts 0);
 *   - combining the list definition's condition with the viewer's filter across
 *     ^NQ branches, where plain concatenation would filter only the last branch;
 *   - the context() refusals: bad table, invalid field (a silently widened
 *     query), wrong list for the table, oversized query.
 *
 * The live counterpart is workspace_live.py, which proves the same behaviour on
 * the instance against the platform's own counts.
 *
 * Run with: node product/tests/test_workspace_context.js
 */
'use strict';

var fs = require('fs');
var path = require('path');
var vm = require('vm');

var USER = '6816f79cc0a8016401c5a33be04be441';
var GROUPS = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa,bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
var TABLES = { incident: ['active', 'priority', 'state', 'assigned_to', 'assignment_group',
                          'caller_id', 'opened_at', 'short_description'] };
var LISTS = {
    '11111111111111111111111111111111': { table: 'incident', condition: 'active=true^EQ',
                                          fixed_query: '', columns: 'number,priority,state',
                                          group_by_column: '', view: '' },
    '22222222222222222222222222222222': { table: 'task', condition: '', fixed_query: '',
                                          columns: '', group_by_column: '', view: '' },
    '33333333333333333333333333333333': { table: 'incident', condition: 'priority=1^NQpriority=2',
                                          fixed_query: '', columns: '', group_by_column: 'state',
                                          view: '' }
};

function GlideRecord(table) {
    this.table = table;
    this.row = null;
}
GlideRecord.prototype = {
    isValid: function () { return !!TABLES[this.table] || this.table === 'sys_ux_list' ||
                                  this.table === 'sys_ui_list' || this.table === 'sys_ui_view' ||
                                  this.table === 'sys_ui_list_element'; },
    isValidField: function (f) { return (TABLES[this.table] || []).indexOf(f) !== -1; },
    /* Valid when every field a clause names exists. Mirrors the platform's rule
       that an unknown field is what makes a query invalid. */
    isEncodedQueryValid: function (q) {
        var fields = TABLES[this.table] || [];
        var clauses = q.replace(/\^NQ/g, '^').replace(/\^OR/g, '^').split('^');
        for (var i = 0; i < clauses.length; i++) {
            var m = /^([a-z0-9_.]+?)(?:[A-Z!=<>]|$)/.exec(clauses[i]);
            if (m && fields.indexOf(m[1]) === -1) return false;
        }
        return true;
    },
    get: function (id) {
        if (this.table === 'sys_ux_list' && LISTS[id]) { this.row = LISTS[id]; return true; }
        return false;
    },
    getValue: function (f) { return this.row ? this.row[f] : ''; },
    addQuery: function () {}, addNullQuery: function () {}, setLimit: function () {},
    orderBy: function () {}, query: function () {}, next: function () { return false; },
    isValidRecord: function () { return false; },
    initialize: function () {}, getElement: function () { return null; }
};

var sandbox = {
    Class: { create: function () {
        return function () { if (this.initialize) this.initialize.apply(this, arguments); };
    } },
    GlideRecord: GlideRecord,
    GlideRecordSecure: GlideRecord,
    gs: {
        getUserID: function () { return USER; },
        getUser: function () { return { getMyGroups: function () { return '[' + GROUPS + ']'; } }; }
    }
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'script-includes', 'CmdWorkspace.js'),
                                'utf8') + '\nthis.CmdWorkspace = CmdWorkspace;', sandbox);
var W = new sandbox.CmdWorkspace();

var passed = 0, failed = 0;
function eq(name, got, want) {
    var ok = JSON.stringify(got) === JSON.stringify(want);
    if (ok) passed++; else { failed++; console.log('FAIL ' + name + '\n  got  ' + JSON.stringify(got) + '\n  want ' + JSON.stringify(want)); }
}

/* ── the javascript: allowlist ── */
var allowed = [
    'opened_atONLast 30 days@javascript:gs.beginningOfLast30Days()@javascript:gs.endOfLast30Days()',
    'opened_at>=javascript:gs.daysAgoStart(7)',
    "opened_at>=javascript:gs.dateGenerate('2026-01-01','00:00:00')",
    'assigned_to=javascript:gs.getUserID()',
    'sys_created_on>javascript:gs.hoursAgo(-2)'
];
allowed.forEach(function (q) { eq('allowed: ' + q, W._unsafeScript(q), ''); });
var refused = [
    "short_description=javascript:gs.getSession().getUser().setPassword('x')",
    "sys_idINjavascript:new GlideRecord('sys_user').deleteMultiple()",
    'priority=javascript:gs.getUserID();gs.eventQueue("x")',
    'assigned_to=javascript:gs.getUserID(gs.getProperty("glide.x"))',
    'priority=javascript:(function(){return 1})()',
    'priority=javascript:gs.beginningOfToday()+gs.getProperty("a")',
    'priority=javascript:eval("1")'
];
refused.forEach(function (q) { eq('refused: ' + q.slice(0, 50), W._unsafeScript(q) !== '', true); });

/* ── scoped-broken global helpers become literals ── */
eq('getMyAssignments', W._clean('active=true^assigned_to=javascript:getMyAssignments()^EQ').query,
   'active=true^assigned_to=' + USER);
eq('not getMyAssignments', W._clean('assigned_to!=javascript:getMyAssignments()').query,
   'assigned_to!=' + USER);
eq('getMyGroups', W._clean('assignment_group=javascript:getMyGroups()').query,
   'assignment_groupIN' + GROUPS);
eq('OR getMyGroups', W._clean('priority=1^ORassignment_group=javascript:gs.getUser().getMyGroups()').query,
   'priority=1^ORassignment_groupIN' + GROUPS);
eq('clean drops view state', W._clean('active=true^ORDERBYnumber^GROUPBYpriority^EQ'),
   { query: 'active=true', group: 'priority' });

/* ── AND across ^NQ ── */
eq('and plain', W._and('a=1', 'b=2'), 'a=1^b=2');
eq('and empty left', W._and('', 'b=2'), 'b=2');
eq('and NQ left', W._and('a=1^NQc=3', 'b=2'), 'a=1^b=2^NQc=3^b=2');
eq('and NQ right', W._and('a=1', 'b=2^NQc=3'), 'b=2^a=1^NQc=3^a=1');
eq('and NQ both refused', W._and('a=1^NQc=3', 'b=2^NQd=4'), null);

/* ── context() ── */
var c = W.context('incident', { query: 'priority=1', list: '11111111111111111111111111111111',
                                group: '^GROUPBYstate', title: 'Incidents - Open' });
eq('context ok', c.ok, true);
eq('list condition AND viewer filter', c.query, 'active=true^priority=1');
eq('viewer part kept for links', c.listQuery, 'priority=1');
eq('group from ^GROUPBY form', c.focus, 'state');
eq('list columns', c.columns, ['number', 'priority', 'state']);

c = W.context('incident', { query: '', list: '33333333333333333333333333333333' });
eq('list default grouping leads', c.focus, 'state');
eq('list NQ condition kept whole', c.query, 'priority=1^NQpriority=2');

c = W.context('incident', { query: 'state=2', list: '33333333333333333333333333333333' });
eq('NQ list AND viewer filter distributes', c.query, 'priority=1^state=2^NQpriority=2^state=2');

eq('wrong table for list', W.context('incident', { list: '22222222222222222222222222222222' }).ok, false);
eq('unknown list', W.context('incident', { list: '44444444444444444444444444444444' }).ok, false);
eq('malformed list id', W.context('incident', { list: 'abc' }).ok, false);
eq('bad table name', W.context('incident; x', {}).ok, false);
eq('missing table', W.context('nosuchtable', {}).ok, false);
eq('invalid field refused (would widen)', W.context('incident', { query: 'active=true^nosuch=1' }).ok, false);
eq('oversized query refused', W.context('incident', { query: new Array(7000).join('a') }).ok, false);
eq('script refused', W.context('incident', { query: "priority=javascript:eval('1')" }).ok, false);

c = W.context('incident', { query: 'active=true', selected: '46d44a23a9fe19810012d100cca80666,bad,' +
                            '57af7aec73d423002728660c4cf6a71c' });
eq('selection keeps only ids', c.query, 'sys_idIN46d44a23a9fe19810012d100cca80666,57af7aec73d423002728660c4cf6a71c');
eq('selection count', c.selected, 2);
eq('bad group dropped', W.context('incident', { group: 'priority; drop' }).focus, '');
eq('title stripped of markup', W.context('incident', { title: '<b>Mine</b>' }).title, 'bMine/b');

/* ── fieldChoices ── */
var dims = [{ name: 'priority', label: 'Priority' }, { name: 'category', label: 'Category' },
            { name: 'short_description', label: 'Short description', needsCardinalityCheck: true },
            { name: 'state', label: 'State' }];
var fc = W.fieldChoices(dims, ['number', 'state', 'priority', 'short_description'], 'state');
eq('columns first, in list order, non-dims and free text dropped',
   fc.map(function (f) { return (f.inList ? '*' : '') + f.name + (f.active ? '!' : ''); }),
   ['*state!', '*priority', 'category']);

console.log(passed + ' passed' + (failed ? ', ' + failed + ' FAILED' : ''));
process.exit(failed ? 1 : 0);
