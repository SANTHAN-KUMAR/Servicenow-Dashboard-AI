/**
 * The CSV export, against the same real payloads the renderer is tested on.
 *
 * Export is the one output that leaves the page and gets mailed around, so a
 * defect here is a wrong number in a spreadsheet on somebody's desk long after
 * the dashboard that produced it was closed. The properties that matter are that
 * every number carries the permission verdict it was computed under, that the
 * quoting survives labels containing commas and quotes, and that a panel's rows
 * are actually present rather than the file being a header and nothing else.
 *
 *   node product/tests/test_export.js
 */
'use strict';

var fs = require('fs');
var path = require('path');
var vm = require('vm');
var shim = require('./domshim');

var FIXTURES = path.join(__dirname, 'fixtures');
var RENDER = path.join(__dirname, '..', 'ui-scripts', 'cmd_render.js');

var pass = 0, fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass++; }
    else { fail++; console.log('  FAIL  ' + name + (detail ? '\n        ' + detail : '')); }
}

function api() {
    var doc = shim.makeDocument();
    doc._register('cmd-root', new shim.Node('div'));
    var holder = new shim.Node('div');
    holder.setAttribute('data-view', 'dashboard');
    doc._register('cmd-data', holder);
    var sandbox = {
        document: doc, console: { error: function () {}, log: function () {} },
        atob: function (b) { return Buffer.from(b, 'base64').toString('binary'); },
        decodeURIComponent: decodeURIComponent, encodeURIComponent: encodeURIComponent,
        JSON: JSON, Math: Math, String: String, Number: Number, Array: Array,
        Object: Object, isNaN: isNaN, parseInt: parseInt, parseFloat: parseFloat,
        Date: Date, RegExp: RegExp, Error: Error, Buffer: Buffer
    };
    sandbox.window = sandbox;
    sandbox.window.addEventListener = function () {};
    /* Booted on a real captured payload. A hand-made stub is thinner than
       anything the renderer ever sees, and the shim rightly rejects it, so the
       cheapest way to get a working API handle is to hand it real data. */
    var boot = fs.readdirSync(FIXTURES).filter(function (f) {
        return /\.json$/.test(f) && !/catalog/.test(f);
    }).sort()[0];
    sandbox.CMD_PAYLOAD = JSON.parse(fs.readFileSync(path.join(FIXTURES, boot), 'utf8'));
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(RENDER, 'utf8'), sandbox, { filename: RENDER });
    return sandbox.CmdRender;
}

var R = api();
ok('csv is exposed for testing', typeof R.csv === 'function');

/* Quoting, which is where every hand-rolled CSV writer eventually fails. */
var tricky = {
    subject: { label: 'Comma, and "quote"', table: 'incident', rows: 3, query: 'a=1^b=2' },
    acl: { mode: 'FILTERED', aggregate: 100, secure: 3 },
    panels: [{
        id: 'p', kind: 'dimension', question: 'By category', form: 'ranked_bar',
        rows: [
            { key: 'a,b', label: 'Hardware, laptops', count: 2 },
            { key: 'q', label: 'He said "no"', count: 1 },
            { key: 'n', label: 'line\nbreak', count: 0 }
        ]
    }]
};
var out = R.csv(tricky);
ok('a label containing a comma is quoted', out.indexOf('"Hardware, laptops"') > -1, out.slice(0, 300));
ok('an embedded quote is doubled', out.indexOf('"He said ""no"""') > -1);
ok('an embedded newline is quoted', out.indexOf('"line\nbreak"') > -1);
ok('the filter travels with the data', out.indexOf('a=1^b=2') > -1);

/* The verdict must survive export. A number without it has lost the property
   this product adds to it. */
ok('the ACL mode is in the file', out.indexOf('FILTERED') > -1);
ok('the unchecked aggregate is in the file', out.indexOf('100') > -1);
ok('the permission-checked count is in the file', /Permission-checked,3/.test(out));

/* Real payloads. */
var files = fs.readdirSync(FIXTURES).filter(function (f) {
    return /\.json$/.test(f) && !/catalog/.test(f);
});
files.sort();

files.forEach(function (file) {
    var payload = JSON.parse(fs.readFileSync(path.join(FIXTURES, file), 'utf8'));
    var name = file.replace(/\.json$/, '');
    var text = null, threw = null;
    try { text = R.csv(payload); } catch (e) { threw = e; }

    ok(name + ' exports without throwing', !threw, threw ? threw.message : '');
    if (threw) return;

    ok(name + ' carries its ACL verdict',
       !payload.acl || text.indexOf(payload.acl.mode) > -1);

    /* Every panel that has rows on screen must have rows in the file. Counting
       data lines rather than checking the file is non-empty, because a header
       block alone would pass that and is exactly the failure worth catching. */
    var withRows = (payload.panels || []).filter(function (p) {
        return (p.rows && p.rows.length) || (p.points && p.points.length);
    });
    var dataLines = text.split('\r\n').filter(function (l) {
        return l && l.indexOf(',') > -1;
    }).length;
    ok(name + ' has a data line for every panel with rows (' + withRows.length + ')',
       withRows.length === 0 || dataLines > withRows.length,
       'panels with rows ' + withRows.length + ', data lines ' + dataLines);

    /* No row may be silently dropped for having an awkward value. */
    ok(name + ' produces no undefined cells', text.indexOf('undefined') === -1);
});

console.log('\n  ' + pass + ' passed' + (fail ? ', ' + fail + ' FAILED' : ''));
process.exit(fail ? 1 : 0);
