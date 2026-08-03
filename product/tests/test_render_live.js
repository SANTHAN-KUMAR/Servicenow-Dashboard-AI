/**
 * Runs the real renderer over real payloads captured from the instance.
 *
 * The gap this closes: cmd_render.js had a coverage test proving every declared
 * form maps to a distinct function, and nothing whatsoever proving those functions
 * survive contact with data. A renderer that divides by a zero range, indexes past
 * the end of a series, or writes NaN into an SVG coordinate passes coverage and
 * draws an empty box in front of a client.
 *
 * Payloads are captured from dev390988 by capture_payloads.py and checked in, so
 * this runs offline and so a payload that once broke a renderer stays in the suite
 * as a fixture rather than depending on the instance still holding that data.
 *
 *   node product/tests/test_render_live.js
 */
'use strict';

var fs = require('fs');
var path = require('path');
var vm = require('vm');
var shim = require('./domshim');

var FIXTURES = path.join(__dirname, 'fixtures');
var RENDER = path.join(__dirname, '..', 'ui-scripts', 'cmd_render.js');

if (!fs.existsSync(FIXTURES)) {
    console.log('No fixtures. Run: python3 product/tests/capture_payloads.py');
    process.exit(1);
}

var pass = 0, fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass++; }
    else { fail++; console.log('  FAIL  ' + name + (detail ? '\n        ' + detail : '')); }
}

/** A fresh sandbox per payload, so one page's state cannot mask another's bug. */
function renderIn(payload, view) {
    var doc = shim.makeDocument();
    var mount = new shim.Node('div');
    var holder = new shim.Node('div');
    holder.setAttribute('data-view', view);
    doc._register('cmd-root', mount);
    doc._register('cmd-data', holder);

    var sandbox = {
        document: doc,
        console: { error: function () {}, log: function () {} },
        atob: function (b) { return Buffer.from(b, 'base64').toString('binary'); },
        decodeURIComponent: decodeURIComponent,
        encodeURIComponent: encodeURIComponent,
        JSON: JSON, Math: Math, String: String, Number: Number, Array: Array,
        Object: Object, isNaN: isNaN, parseInt: parseInt, parseFloat: parseFloat,
        Date: Date, RegExp: RegExp, Error: Error, Buffer: Buffer
    };
    sandbox.window = sandbox;
    sandbox.window.addEventListener = function () {};
    sandbox.window.pageXOffset = 0;
    sandbox.window.pageYOffset = 0;
    /* The payload is handed over directly rather than base64-encoded into the
       holder, because the transport is already validated by the deploy step and
       what is under test here is the drawing. */
    sandbox.CMD_PAYLOAD = payload;

    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(RENDER, 'utf8'), sandbox, { filename: RENDER });
    return { mount: mount, api: sandbox.CmdRender, doc: doc };
}

var files = fs.readdirSync(FIXTURES).filter(function (f) { return /\.json$/.test(f); });
files.sort();
console.log('\n' + files.length + ' captured payloads\n');

var formsSeen = {};

files.forEach(function (file) {
    var payload = JSON.parse(fs.readFileSync(path.join(FIXTURES, file), 'utf8'));
    var view = /catalog/.test(file) ? 'catalog' : 'dashboard';
    var name = file.replace(/\.json$/, '');

    var r, threw = null;
    try {
        r = renderIn(payload, view);
    } catch (e) {
        threw = e;
    }
    ok(name + ' renders without throwing', !threw,
       threw ? (threw.message + '\n        ' + String(threw.stack).split('\n')[1]) : '');
    if (threw) return;

    var counts = shim.summarise(r.mount);
    /* A render that throws nothing and draws nothing is the failure this is really
       looking for, and it is invisible without a node count. */
    ok(name + ' produced marks', counts.total > 20,
       'only ' + counts.total + ' nodes');

    if (view === 'dashboard') {
        var expected = (payload.panels || []).length +
                       (payload.kpis || []).length + (payload.matrix ? 1 : 0);
        ok(name + ' drew every panel it was given', expected === 0 || counts.total > expected,
           expected + ' panels in the payload, ' + counts.total + ' nodes out');

        (payload.panels || []).forEach(function (p) {
            formsSeen[p.form] = (formsSeen[p.form] || 0) + 1;
        });
        (payload.kpis || []).forEach(function (p) {
            formsSeen[p.form] = (formsSeen[p.form] || 0) + 1;
        });
        if (payload.matrix) formsSeen.matrix = (formsSeen.matrix || 0) + 1;

        /* Interactivity is part of the deliverable, not decoration: the hover
           report and the drill affordance have to actually reach the marks. */
        var interactive = (payload.panels || []).length > 0;
        if (interactive) {
            ok(name + ' attached hover reports', counts.tip > 0,
               'no data-tip anywhere in the page');

            /* Cross-highlighting is driven entirely by data-drill-field, so a page
             * without any is a page where clicking a bar does nothing. This is how
             * the gap was found: the seven original renderers were never given
             * marks, so the three subjects whose panels are all dimension
             * breakdowns -- the most common kind of page -- had no interactivity at
             * all while the newer forms did. Nothing threw, and the coverage test
             * was perfectly happy. */
            var hasDim = false;
            for (var d = 0; d < payload.panels.length; d++) {
                if (payload.panels[d].kind === 'dimension') hasDim = true;
            }
            if (hasDim) {
                ok(name + ' made its marks selectable', counts.hit > 0,
                   'no data-drill-field anywhere, so cross-highlighting is dead');
            }
        }
    }

    /* Every panel must also survive its table view, which is the accessibility
       fallback and is reached by a different code path from the chart. */
    if (view === 'dashboard' && r.api) {
        var tableThrew = null;
        try {
            var r2 = renderIn(payload, 'dashboard');
            var toggles = r2.mount.querySelectorAll('button');
            for (var i = 0; i < toggles.length; i++) {
                if (toggles[i].getAttribute('data-v') === 'table') {
                    var fns = toggles[i]._listeners.click || [];
                    for (var j = 0; j < fns.length; j++) fns[j]();
                }
            }
        } catch (e2) {
            tableThrew = e2;
        }
        ok(name + ' table view renders', !tableThrew,
           tableThrew ? tableThrew.message : '');
    }
});

console.log('\nForms exercised against real data:');
Object.keys(formsSeen).sort().forEach(function (f) {
    console.log('  ' + f + '  x' + formsSeen[f]);
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
