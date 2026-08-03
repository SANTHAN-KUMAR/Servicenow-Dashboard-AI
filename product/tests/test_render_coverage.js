/**
 * Renderer coverage, and the aliasing check.
 *
 * Two failures this exists to catch, both of which had already happened:
 *
 *  1. A form the engine can emit with no renderer. That degrades to a table with a
 *     note, which is survivable but is not what anyone signed off, and it is
 *     invisible until a client opens the one subject that triggers it.
 *
 *  2. A form aliased to the wrong renderer. This is worse and it is the reason the
 *     second half of this file exists. `line_multi` was aliased to the single-series
 *     line renderer, so it drew the first category and silently discarded the rest.
 *     `pareto` was aliased to the ranked bar, dropping the cumulative line, which is
 *     the only thing that makes it a Pareto. `stat_tile_delta` dropped the delta.
 *     All three produced a chart that looked finished and answered a different
 *     question than the one in its own title. A coverage check that only asks "is
 *     there an entry" passes all three, so this also asserts that forms whose whole
 *     point is a distinct treatment do not share an implementation.
 *
 * Parsing the source rather than executing it, because cmd_render.js is a browser
 * IIFE that touches `document` at load. The FORMS table is a flat object literal by
 * design, which keeps it parseable and keeps it readable as documentation.
 *
 *   node product/tests/test_render_coverage.js
 */
'use strict';

var fs = require('fs');
var path = require('path');

var RENDER = path.join(__dirname, '..', 'ui-scripts', 'cmd_render.js');
var FORM = path.join(__dirname, '..', 'script-includes', 'CmdForm.js');

var pass = 0, fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass++; }
    else { fail++; console.log('  FAIL  ' + name + (detail ? '\n        ' + detail : '')); }
}

/* ── declared forms ── */
var formSrc = fs.readFileSync(FORM, 'utf8');
var declBlock = formSrc.match(/CmdForm\.FORMS\s*=\s*\[([\s\S]*?)\];/);
if (!declBlock) { console.log('could not find CmdForm.FORMS'); process.exit(1); }
var declared = [];
declBlock[1].replace(/'([a-z_0-9]+)'/g, function (_, n) { declared.push(n); });

/* ── rendered forms, and what each maps to ── */
var renderSrc = fs.readFileSync(RENDER, 'utf8');
var formsBlock = renderSrc.match(/\n  var FORMS = \{([\s\S]*?)\n  \};/);
if (!formsBlock) { console.log('could not find the FORMS table'); process.exit(1); }
var body = formsBlock[1];

/* Strip comments so a form name mentioned in prose is not read as an entry. */
var clean = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

var mapped = {};
var entry = /(^|[\s{,])([a-z_0-9]+)\s*:\s*([\s\S]*?)(?=\n    [a-z_0-9]+\s*:|$)/g;
var m;
while ((m = entry.exec(clean)) !== null) {
    var name = m[2];
    var impl = m[3].trim().replace(/,\s*$/, '');
    if (declared.indexOf(name) === -1) continue;
    mapped[name] = impl;
}

console.log('\nCoverage');
console.log('  declared ' + declared.length + ', mapped ' + Object.keys(mapped).length);

var missing = declared.filter(function (f) { return !mapped[f]; });
ok('every declared form has a renderer', missing.length === 0,
   'no renderer for: ' + missing.join(', '));

var extra = Object.keys(mapped).filter(function (f) { return declared.indexOf(f) === -1; });
ok('no renderer for an undeclared form', extra.length === 0,
   'not in CmdForm.FORMS: ' + extra.join(', '));

/* ── the aliasing check ── */
console.log('\nDistinct treatment');

/* Which draw function each form ultimately reaches. A form implemented as a thunk
   calling another draw function resolves to that function plus its arguments, so
   `line` and `area` correctly read as different despite sharing drawLine. */
function resolve(impl) {
    var call = impl.match(/return\s+(draw[A-Za-z]+)\s*\(([^)]*)\)/);
    if (call) {
        var args = call[2].split(',').slice(1).map(function (a) { return a.trim(); });
        return call[1] + (args.length ? '(' + args.join(',') + ')' : '');
    }
    var direct = impl.match(/^(draw[A-Za-z]+)$/);
    if (direct) return direct[1];
    /* A dispatching thunk reaches more than one renderer, which is a deliberate
       distinct treatment rather than an alias. */
    var many = impl.match(/draw[A-Za-z]+/g);
    if (many) return many.sort().join('|');
    return impl;
}

/* Pairs that must not share an implementation, each with the bug that happened
   when they did. These are assertions about meaning, not about code shape. */
var mustDiffer = [
    ['line', 'line_multi',
     'line_multi drew only the first series when it was aliased to drawLine'],
    ['ranked_bar', 'pareto',
     'pareto without its cumulative line is just a sorted bar chart'],
    ['stat_tile', 'stat_tile_delta',
     'stat_tile_delta dropped the delta when it was aliased to the plain tile'],
    ['line_multi', 'stream',
     'a stream is normalised to share; a multi-line is not'],
    ['line_multi', 'small_multiples',
     'small multiples share one scale across separate panels'],
    ['heatmap', 'calendar_heatmap',
     'a calendar encodes the date in position; a heatmap does not'],
    ['column', 'histogram',
     'a histogram bins a continuous axis; a column chart does not'],
    ['slope', 'bump',
     'a bump chart draws every period, which is the point of it'],
    ['ranked_bar', 'waterfall',
     'waterfall bars are signed contributions that reconcile two totals'],
    ['donut', 'gauge',
     'a gauge is measured against a target, not against a whole']
];

for (var i = 0; i < mustDiffer.length; i++) {
    var a = mustDiffer[i][0], b = mustDiffer[i][1], why = mustDiffer[i][2];
    if (!mapped[a] || !mapped[b]) continue;
    var ra = resolve(mapped[a]), rb = resolve(mapped[b]);
    ok(a + ' is drawn differently from ' + b, ra !== rb,
       'both resolve to ' + ra + '  --  ' + why);
}

/* Aliases that ARE legitimate, asserted so that a future "cleanup" that
   accidentally makes them differ gets a reason to stop and think. */
var mayShare = [
    ['ranked_bar', 'ranked_bar_top_n'],
    ['stacked_proportion', 'stacked_ordinal']
];
for (var j = 0; j < mayShare.length; j++) {
    var x = mayShare[j][0], y = mayShare[j][1];
    if (!mapped[x] || !mapped[y]) continue;
    ok(x + ' and ' + y + ' share a renderer by design',
       resolve(mapped[x]).split('(')[0] === resolve(mapped[y]).split('(')[0]);
}

console.log('\nMapping');
declared.forEach(function (f) {
    console.log('  ' + pad(f, 20) + (mapped[f] ? resolve(mapped[f]) : '— MISSING'));
});
function pad(s, n) { while (s.length < n) s += ' '; return s; }

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
