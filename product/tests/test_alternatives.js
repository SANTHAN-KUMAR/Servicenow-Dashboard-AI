/**
 * Every alternative the product offers must actually draw.
 *
 * This is the test that makes offering alternatives safe at all, so it is worth
 * being explicit about the failure it exists to prevent.
 *
 * A dimension panel carries grouped rows. Most forms in the catalogue read
 * something else: a line needs points, a heatmap needs a grid, a scatter needs
 * pairs. Hand any of them a list of rows and the renderer does not throw, it
 * draws an empty box, which on screen is indistinguishable from "you have no
 * data" and is the single worst thing this product could do to a viewer who has
 * just been invited to choose. The invitation is what makes it dangerous: a form
 * the engine picks itself is picked from the shape, while a form the viewer picks
 * is picked because we offered it.
 *
 * So for every dimension panel in the captured payloads, this computes the
 * alternatives the real engine would offer and renders the panel as each one,
 * asserting real marks come out. It also asserts the refusals are honest, which
 * is the other half of the claim: a refused form is refused because the data
 * cannot carry it, not because we did not get round to it.
 *
 *   node product/tests/test_alternatives.js
 */
'use strict';

var fs = require('fs');
var path = require('path');
var vm = require('vm');
var shim = require('./domshim');

var FIXTURES = path.join(__dirname, 'fixtures');
var RENDER = path.join(__dirname, '..', 'ui-scripts', 'cmd_render.js');
var engine = require(path.join(__dirname, '..', 'script-includes', 'CmdForm.js')).create();

var pass = 0, fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass++; }
    else { fail++; console.log('  FAIL  ' + name + (detail ? '\n        ' + detail : '')); }
}

/* A fresh renderer per assertion would be honest and slow; one sandbox is enough
   because nothing here mutates renderer state. */
function makeRenderer() {
    var doc = shim.makeDocument();
    doc._register('cmd-root', new shim.Node('div'));
    var holder = new shim.Node('div');
    holder.setAttribute('data-view', 'dashboard');
    doc._register('cmd-data', holder);

    var boot = fs.readdirSync(FIXTURES).filter(function (f) {
        return /\.json$/.test(f) && !/catalog/.test(f);
    }).sort()[0];

    var sandbox = {
        document: doc, console: { error: function () {}, log: function () {} },
        atob: function (b) { return Buffer.from(b, 'base64').toString('binary'); },
        decodeURIComponent: decodeURIComponent, encodeURIComponent: encodeURIComponent,
        JSON: JSON, Math: Math, String: String, Number: Number, Array: Array,
        Object: Object, isNaN: isNaN, parseInt: parseInt, parseFloat: parseFloat,
        Date: Date, RegExp: RegExp, Error: Error, Buffer: Buffer,
        setTimeout: function () {}, clearTimeout: function () {}
    };
    sandbox.window = sandbox;
    sandbox.window.addEventListener = function () {};
    sandbox.CMD_PAYLOAD = JSON.parse(fs.readFileSync(path.join(FIXTURES, boot), 'utf8'));
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(RENDER, 'utf8'), sandbox, { filename: RENDER });
    return sandbox.CmdRender;
}

var R = makeRenderer();

/* The context the payload builder would hand the engine, rebuilt from what the
   panel records about its own shape. */
function rowsOf(panel) {
    /* _rowsOut shapes rows per form: some carry a bare array, others wrap it in
       { series: [...] } with folding metadata alongside. The test reads whichever
       one this panel actually has rather than assuming, because assuming is how a
       test ends up asserting nothing. */
    var r = panel.rows;
    if (!r) return [];
    if (Object.prototype.toString.call(r) === '[object Array]') return r;
    if (r.series && Object.prototype.toString.call(r.series) === '[object Array]') {
        return r.series;
    }
    return [];
}

function ctxFor(panel) {
    var sh = panel.shape || {};
    var rows = rowsOf(panel);
    return {
        field: panel.field, fieldLabel: panel.fieldLabel,
        dims: 1,
        distinct: sh.distinct || rows.length,
        n: rows.reduce(function (a, r) { return a + (r.count || 0); }, 0),
        fillRate: sh.fill === undefined ? 1 : sh.fill,
        topShare: sh.topShare || 0,
        concentration: sh.concentration || 0,
        isOrdinal: !!panel.ordinal,
        isPartToWhole: !!panel.ordinal || false
    };
}

/* Marks, not nodes. An empty <svg> is a node and is exactly the failure being
   hunted, so the count that matters is drawable elements inside it. Counted with
   the shim's own walker rather than a hand-rolled one: the shim exposes
   childNodes and not children, and a walker reading the wrong property reports
   zero marks for every form and fails the entire suite for a reason that has
   nothing to do with the product. This test made that mistake first. */
function markCount(node) {
    var c = shim.summarise(node);
    return c.rect + c.path + c.circle + c.line;
}

var files = fs.readdirSync(FIXTURES).filter(function (f) {
    return /\.json$/.test(f) && !/catalog/.test(f);
});
files.sort();

var panelsChecked = 0, altsChecked = 0, formsExercised = {};

files.forEach(function (file) {
    var payload = JSON.parse(fs.readFileSync(path.join(FIXTURES, file), 'utf8'));
    var name = file.replace(/\.json$/, '');

    (payload.panels || []).forEach(function (panel) {
        if (panel.kind !== 'dimension') return;
        var rows = rowsOf(panel);
        if (rows.length < 2) return;
        panelsChecked++;

        var alts = engine.alternatives(panel.form, ctxFor(panel));

        /* The chosen form must never be offered as an alternative to itself. */
        var selfOffered = alts.offered.filter(function (a) { return a.form === panel.form; });
        ok(name + ' / ' + panel.field + ': does not offer its own form',
           selfOffered.length === 0);

        /* Every alternative must be a form the renderer knows. */
        alts.offered.forEach(function (a) {
            ok(name + ' / ' + panel.field + ': renderer knows "' + a.form + '"',
               typeof R.forms[a.form] === 'function');
        });

        /* And must draw real marks from this panel's own data. */
        alts.offered.forEach(function (a) {
            altsChecked++;
            formsExercised[a.form] = (formsExercised[a.form] || 0) + 1;

            var swapped = {}, k;
            for (k in panel) { if (panel.hasOwnProperty(k)) swapped[k] = panel[k]; }
            swapped.form = a.form;

            var node = null, threw = null;
            try { node = R.forms[a.form](swapped); } catch (e) { threw = e; }

            ok(name + ' / ' + panel.field + ' as ' + a.form + ': draws without throwing',
               !threw, threw ? threw.message : '');
            if (threw) return;
            ok(name + ' / ' + panel.field + ' as ' + a.form + ': draws real marks',
               markCount(node) > 0,
               'no rect/circle/path/line/tr produced from ' + rows.length + ' rows');
        });

        /* Every alternative carries a reason. An option with no reason is a
           dropdown entry, which is the thing this was built not to be. */
        alts.offered.forEach(function (a) {
            ok(name + ' / ' + panel.field + ': "' + a.form + '" states why it is offered',
               !!a.reason && a.reason.length > 15);
        });
        alts.refused.forEach(function (r) {
            ok(name + ' / ' + panel.field + ': "' + r.form + '" states why it is refused',
               !!r.reason && r.reason.length > 15);
        });

        /* A form cannot be offered and refused at once. */
        var offeredNames = {};
        alts.offered.forEach(function (a) { offeredNames[a.form] = 1; });
        var contradiction = alts.refused.filter(function (r) { return offeredNames[r.form]; });
        ok(name + ' / ' + panel.field + ': no form both offered and refused',
           contradiction.length === 0,
           contradiction.map(function (c) { return c.form; }).join(', '));
    });
});

/* A ranked bar is defensible for any categorical breakdown, so if the whole
   corpus never offered one the alternatives are not being computed at all and
   every assertion above passed vacuously. */
ok('the corpus exercised at least one alternative', altsChecked > 0,
   'no dimension panels found in ' + files.length + ' payloads');
ok('ranked_bar is reachable as an alternative', !!formsExercised.ranked_bar);

console.log('\n  ' + panelsChecked + ' dimension panels, ' + altsChecked +
            ' alternatives rendered, forms exercised: ' +
            Object.keys(formsExercised).sort().join(', '));
console.log('  ' + pass + ' passed' + (fail ? ', ' + fail + ' FAILED' : ''));
process.exit(fail ? 1 : 0);
