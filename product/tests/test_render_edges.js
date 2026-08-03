/**
 * Every form, including the eight the instance cannot currently produce, and the
 * degenerate inputs that are where charts actually break.
 *
 * test_render_live.js covers the nineteen forms dev390988 has data for. The other
 * eight -- area, small_multiples, scatter, box, pareto, slope, funnel, bump -- are
 * gated off on this instance for good reasons: assignment_group is too dispersed
 * for a Pareto, incident state does not shed volume monotonically so it is not a
 * funnel, the best numeric column has no variance. Those rejections are correct,
 * and they mean those renderers ship untested unless something else exercises them.
 *
 * These fixtures are constructed rather than captured, and that difference is worth
 * being honest about: constructed data tends to agree with whatever the renderer
 * already does, which is exactly why it is the weaker of the two suites and not a
 * replacement for the captured one. What it is good for is the cases a live capture
 * will almost never contain -- one row, every value identical, a zero total, a
 * single period, a count of zero in the middle of a series. Those are where a chart
 * divides by a zero range and silently emits NaN into a coordinate.
 *
 *   node product/tests/test_render_edges.js
 */
'use strict';

var fs = require('fs');
var path = require('path');
var vm = require('vm');
var shim = require('./domshim');

var RENDER = path.join(__dirname, '..', 'ui-scripts', 'cmd_render.js');
var FORM = path.join(__dirname, '..', 'script-includes', 'CmdForm.js');

var pass = 0, fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass++; }
    else { fail++; console.log('  FAIL  ' + name + (detail ? '\n        ' + detail : '')); }
}

function sandboxFor(payload) {
    var doc = shim.makeDocument();
    var mount = new shim.Node('div');
    var holder = new shim.Node('div');
    holder.setAttribute('data-view', 'dashboard');
    doc._register('cmd-root', mount);
    doc._register('cmd-data', holder);

    var s = {
        document: doc, console: { error: function () {}, log: function () {} },
        atob: function (b) { return Buffer.from(b, 'base64').toString('binary'); },
        decodeURIComponent: decodeURIComponent, encodeURIComponent: encodeURIComponent,
        JSON: JSON, Math: Math, String: String, Number: Number, Array: Array,
        Object: Object, isNaN: isNaN, parseInt: parseInt, parseFloat: parseFloat,
        Date: Date, RegExp: RegExp, Error: Error, Buffer: Buffer, CMD_PAYLOAD: payload
    };
    s.window = s;
    s.window.addEventListener = function () {};
    s.window.pageXOffset = 0; s.window.pageYOffset = 0;
    vm.createContext(s);
    vm.runInContext(fs.readFileSync(RENDER, 'utf8'), s, { filename: RENDER });
    return { mount: mount, api: s.CmdRender };
}

/* ── builders for each shape ── */

function periods(n, partialLast) {
    var out = [];
    for (var i = 0; i < n; i++) {
        out.push({ period: '2026-' + (i < 9 ? '0' : '') + (i + 1),
                   label: 'M' + (i + 1),
                   partial: partialLast && i === n - 1 });
    }
    return out;
}

function counts(n, fn) {
    var out = [];
    for (var i = 0; i < n; i++) out.push(fn(i));
    return out;
}

function seriesSet(nGroups, nPeriods, fn) {
    var out = [];
    for (var g = 0; g < nGroups; g++) {
        var c = counts(nPeriods, function (i) { return fn(g, i); });
        var t = 0;
        for (var i = 0; i < c.length; i++) t += c[i];
        out.push({ key: 'k' + g, label: 'Group ' + (g + 1), counts: c, total: t });
    }
    return out;
}

function base(form, extra) {
    var p = {
        id: form, kind: 'test', form: form, span: 2,
        question: 'A test of ' + form, reason: 'constructed fixture',
        field: 'category', fieldLabel: 'Category', caveats: []
    };
    for (var k in extra) { if (extra.hasOwnProperty(k)) p[k] = extra[k]; }
    return p;
}

function groupedRows(n, fn) {
    var rows = [];
    for (var i = 0; i < n; i++) {
        rows.push({ key: 'k' + i, label: 'Value ' + (i + 1), count: fn(i) });
    }
    return { series: rows, other: null };
}

/* ── the cases ── */

function casesFor(form) {
    var out = [];

    function add(label, extra) { out.push({ label: label, panel: base(form, extra) }); }

    if (form === 'line' || form === 'area') {
        add('normal', { kind: 'series', points: counts(12, function (i) {
            return { period: 'p' + i, label: 'M' + i, count: 40 + i * 3, partial: i === 11 };
        }) });
        add('all zero', { kind: 'series', points: counts(12, function (i) {
            return { period: 'p' + i, label: 'M' + i, count: 0, partial: false };
        }) });
        add('single point', { kind: 'series', points: [
            { period: 'p0', label: 'M0', count: 7, partial: false }] });
        add('with a forecast', { kind: 'series',
            points: counts(12, function (i) {
                return { period: 'p' + i, label: 'M' + i, count: 30 + i * 4, partial: i === 11 };
            }),
            annotation: { slope: 4, intercept: 30, sigma: 3.2, direction: 'rising',
                perPeriod: 4, method: 'least squares on 11 complete periods',
                anomalies: [{ index: 5, value: 90, expected: 50, sigma: 3.1 }],
                forecast: [{ index: 12, value: 78, lo: 70, hi: 86 },
                           { index: 13, value: 82, lo: 72, hi: 92 },
                           { index: 14, value: 86, lo: 73, hi: 99 }],
                fitFrom: { index: 0, value: 30 }, fitTo: { index: 10, value: 70 } } });
        return out;
    }

    if (form === 'line_multi' || form === 'stream' || form === 'small_multiples') {
        var n = form === 'small_multiples' ? 9 : form === 'stream' ? 7 : 4;
        add('normal', { periods: periods(12, true),
            series: seriesSet(n, 12, function (g, i) { return 5 + g * 3 + (i % 4) * 2; }) });
        add('one empty series', { periods: periods(12, true),
            series: seriesSet(n, 12, function (g, i) { return g === 0 ? 0 : 4 + i; }) });
        add('all zero', { periods: periods(12, true),
            series: seriesSet(n, 12, function () { return 0; }) });
        add('single period', { periods: periods(1, false),
            series: seriesSet(n, 1, function (g) { return g + 1; }) });
        add('with an Other fold', { periods: periods(12, true),
            series: seriesSet(n, 12, function (g, i) { return 3 + g + i; }),
            other: { key: '__other__', label: 'Other (4)',
                     counts: counts(12, function (i) { return i; }), total: 66,
                     isOther: true } });
        return out;
    }

    if (form === 'slope' || form === 'bump') {
        var rows = [];
        for (var i = 0; i < 6; i++) {
            rows.push({ key: 'k' + i, label: 'Group ' + (i + 1),
                        from: 100 - i * 12, to: 60 + i * 9,
                        rankFrom: i + 1, rankTo: 6 - i });
        }
        add('normal', { rows: rows, fromLabel: 'Jan to Mar', toLabel: 'Apr to Jun' });
        add('all equal', { rows: rows.map(function (r, k) {
            return { key: r.key, label: r.label, from: 50, to: 50,
                     rankFrom: k + 1, rankTo: k + 1 }; }),
            fromLabel: 'Jan to Mar', toLabel: 'Apr to Jun' });
        add('all zero', { rows: rows.map(function (r, k) {
            return { key: r.key, label: r.label, from: 0, to: 0,
                     rankFrom: k + 1, rankTo: k + 1 }; }),
            fromLabel: 'A', toLabel: 'B' });

        if (form === 'bump') {
            var pathRows = [], keys = [];
            for (var g = 0; g < 5; g++) keys.push({ key: 'k' + g, label: 'Group ' + (g + 1) });
            for (var t = 0; t < 6; t++) {
                var rank = {};
                for (var q = 0; q < 5; q++) rank['k' + q] = ((q + t) % 5) + 1;
                pathRows.push({ label: 'M' + t, rank: rank });
            }
            add('full rank path', { rows: rows, keys: keys, path: pathRows,
                fromLabel: 'M0', toLabel: 'M5' });
            add('single key', { rows: rows.slice(0, 1),
                keys: [{ key: 'k0', label: 'Only' }],
                path: [{ label: 'M0', rank: { k0: 1 } }, { label: 'M1', rank: { k0: 1 } }],
                fromLabel: 'M0', toLabel: 'M1' });
        }
        return out;
    }

    if (form === 'waterfall') {
        add('normal', { start: 200, end: 260, startLabel: 'Jun', endLabel: 'Jul',
            steps: [{ key: 'a', label: 'Network', delta: 40, from: 60, to: 100 },
                    { key: 'b', label: 'Software', delta: -15, from: 50, to: 35 },
                    { key: 'c', label: 'Hardware', delta: 35, from: 40, to: 75 }] });
        add('all negative', { start: 200, end: 120, startLabel: 'Jun', endLabel: 'Jul',
            steps: [{ key: 'a', label: 'Network', delta: -40, from: 60, to: 20 },
                    { key: 'b', label: 'Software', delta: -40, from: 50, to: 10 }] });
        add('crosses zero', { start: 20, end: -30, startLabel: 'Jun', endLabel: 'Jul',
            steps: [{ key: 'a', label: 'Down hard', delta: -50, from: 20, to: -30 }] });
        add('zero start', { start: 0, end: 0, startLabel: 'Jun', endLabel: 'Jul',
            steps: [{ key: 'a', label: 'Nothing', delta: 0, from: 0, to: 0 }] });
        return out;
    }

    if (form === 'heatmap') {
        add('crosstab', { kind: 'cross',
            rowFieldLabel: 'Category', colFieldLabel: 'Priority',
            rowKeys: ['a', 'b', 'c'], colKeys: ['1', '2', '3', '4'],
            rowLabels: ['Network', 'Software', 'Hardware'],
            colLabels: ['Critical', 'High', 'Moderate', 'Low'],
            rowTotals: [30, 20, 10], colTotals: [12, 18, 20, 10],
            grid: [[5, 10, 10, 5], [3, 5, 7, 5], [4, 3, 3, 0]],
            maxCell: 10, grand: 60 });
        add('cycle', { kind: 'cycle',
            rowLabels: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
            grid: (function () {
                var g = [];
                for (var d = 0; d < 7; d++) {
                    var r = [];
                    for (var h = 0; h < 24; h++) r.push(d < 5 && h > 8 && h < 18 ? h : 0);
                    g.push(r);
                }
                return g;
            })(), maxCell: 17, total: 400 });
        add('all zero cells', { kind: 'cross',
            rowFieldLabel: 'A', colFieldLabel: 'B',
            rowKeys: ['a', 'b'], colKeys: ['x', 'y'],
            rowLabels: ['A1', 'A2'], colLabels: ['B1', 'B2'],
            rowTotals: [0, 0], colTotals: [0, 0],
            grid: [[0, 0], [0, 0]], maxCell: 0, grand: 0 });
        return out;
    }

    if (form === 'calendar_heatmap') {
        var byDay = {};
        for (var d2 = 0; d2 < 150; d2++) {
            var dt = new Date(Date.UTC(2026, 2, 1) + d2 * 86400000);
            byDay[dt.toISOString().substr(0, 10)] = d2 % 7 === 0 ? 0 : (d2 % 11);
        }
        add('normal', { kind: 'calendar', byDay: byDay, maxCell: 10, total: 600,
            endDay: '2026-07-28', days: 182 });
        add('one day', { kind: 'calendar', byDay: { '2026-07-28': 3 }, maxCell: 3,
            total: 3, endDay: '2026-07-28', days: 182 });
        add('all zero', { kind: 'calendar', byDay: byDay, maxCell: 0, total: 0,
            endDay: '2026-07-28', days: 182 });
        return out;
    }

    if (form === 'histogram') {
        add('binned', { bins: counts(12, function (i) {
                return { from: i * 10, to: (i + 1) * 10, count: 40 - Math.abs(i - 6) * 5 };
            }), lo: 0, hi: 120, n: 300, mean: 58, median: 60, q1: 35, q3: 82 });
        add('binned, zero range', { bins: [{ from: 5, to: 5, count: 100 }],
            lo: 5, hi: 5, n: 100, mean: 5, median: 5, q1: 5, q3: 5 });
        add('grouped rows fallback', { rows: groupedRows(9, function (i) { return i * 3 + 1; }) });
        return out;
    }

    if (form === 'box') {
        var brows = [];
        for (var b = 0; b < 5; b++) {
            brows.push({ key: 'k' + b, label: 'Group ' + (b + 1), n: 40 + b,
                min: b, q1: 10 + b, median: 20 + b * 3, q3: 35 + b * 4,
                max: 90 + b, lo: 5 + b, hi: 70 + b * 3,
                outliers: b === 2 ? [120, 140] : [], sum: 800, avg: 22 });
        }
        add('normal', { rows: brows, groupField: 'category', groupFieldLabel: 'Category',
            fieldLabel: 'Duration' });
        add('identical boxes', { rows: brows.map(function (r) {
                return { key: r.key, label: r.label, n: 20, min: 10, q1: 10, median: 10,
                         q3: 10, max: 10, lo: 10, hi: 10, outliers: [] }; }),
            groupField: 'category', groupFieldLabel: 'Category', fieldLabel: 'Duration' });
        add('one group', { rows: [brows[0]], groupField: 'category',
            groupFieldLabel: 'Category', fieldLabel: 'Duration' });
        return out;
    }

    if (form === 'scatter') {
        var pts = [], pts2 = [];
        for (var s2 = 0; s2 < 200; s2++) {
            pts.push({ x: s2 % 40, y: (s2 % 40) * 2 + (s2 % 7), g: 'g' + (s2 % 3),
                       gl: 'Group ' + (s2 % 3) });
            pts2.push({ x: 5, y: 9, g: '', gl: '' });
        }
        add('normal', { points: pts, corr: 0.91, xFieldLabel: 'Reassignments',
            yFieldLabel: 'Duration', groupField: 'category', groupFieldLabel: 'Category' });
        add('no variance', { points: pts2, corr: null, xFieldLabel: 'A',
            yFieldLabel: 'B', groupField: null });
        add('two points', { points: pts.slice(0, 2), corr: null, xFieldLabel: 'A',
            yFieldLabel: 'B', groupField: null });
        add('dense', { points: (function () {
                var many = [];
                for (var i = 0; i < 2000; i++) many.push({ x: i % 97, y: (i * 7) % 89, g: '', gl: '' });
                return many;
            })(), corr: 0.02, xFieldLabel: 'A', yFieldLabel: 'B', groupField: null });
        return out;
    }

    if (form === 'pareto') {
        var prows = [], acc = 0, tot = 0, i2;
        var raw = [90, 70, 50, 30, 20, 12, 8, 5, 3, 2];
        for (i2 = 0; i2 < raw.length; i2++) tot += raw[i2];
        for (i2 = 0; i2 < raw.length; i2++) {
            acc += raw[i2];
            prows.push({ key: 'k' + i2, label: 'Value ' + (i2 + 1), count: raw[i2],
                         cumulative: Math.round((acc / tot) * 1000) / 1000 });
        }
        add('normal', { rows: prows, total: tot, eightyAt: 4 });
        add('flat', { rows: prows.map(function (r, k) {
                return { key: r.key, label: r.label, count: 10,
                         cumulative: (k + 1) / prows.length }; }),
            total: 100, eightyAt: 8 });
        return out;
    }

    if (form === 'funnel') {
        add('normal', { stages: [
            { key: '1', label: 'New', count: 1000, share: 1, stepShare: 1 },
            { key: '2', label: 'Triaged', count: 700, share: 0.7, stepShare: 0.7 },
            { key: '3', label: 'In progress', count: 420, share: 0.42, stepShare: 0.6 },
            { key: '4', label: 'Resolved', count: 380, share: 0.38, stepShare: 0.905 }] });
        add('drops to zero', { stages: [
            { key: '1', label: 'New', count: 500, share: 1, stepShare: 1 },
            { key: '2', label: 'Triaged', count: 20, share: 0.04, stepShare: 0.04 },
            { key: '3', label: 'Done', count: 0, share: 0, stepShare: 0 }] });
        return out;
    }

    if (form === 'matrix') {
        add('with trend', { rows: counts(8, function (i) {
                return { key: 'k' + i, label: 'Value ' + (i + 1), count: 100 - i * 9,
                         share: (100 - i * 9) / 500,
                         spark: counts(12, function (j) { return 5 + ((i + j) % 7); }),
                         delta: i % 3 === 0 ? 4 : -3,
                         change: i % 3 === 0 ? 0.12 : (i % 3 === 1 ? -0.08 : null) };
            }), total: 500, periods: periods(12, true), grain: 'month' });
        add('no trend column', { rows: counts(4, function (i) {
                return { key: 'k' + i, label: 'Value ' + (i + 1), count: 10,
                         share: 0.25, spark: null, delta: null, change: null };
            }), total: 40, periods: null, grain: 'month' });
        add('zero total', { rows: [{ key: 'a', label: 'None', count: 0, share: 0,
            spark: null, delta: null, change: null }], total: 0, periods: null,
            grain: 'month' });
        return out;
    }

    if (form === 'gauge') {
        add('normal', { kind: 'kpi', value: 62.5, target: 100, median: 58, n: 400,
            fieldLabel: 'Percent complete', span: 1 });
        add('at zero', { kind: 'kpi', value: 0, target: 100, median: 0, n: 40,
            fieldLabel: 'Percent complete', span: 1 });
        add('at target', { kind: 'kpi', value: 100, target: 100, median: 100, n: 40,
            fieldLabel: 'Percent complete', span: 1 });
        return out;
    }

    if (form === 'stat_tile' || form === 'stat_tile_delta') {
        add('kpi with delta', { kind: 'kpi', span: 1, value: 420,
            fieldLabel: 'Records',
            delta: { current: 200, previous: 380, currentLabel: 'Aug', previousLabel: 'Jul',
                     elapsedFraction: 0.5, paceAdjusted: 400, delta: 20, change: 0.053,
                     rawDelta: -180, rawChange: -0.47, partial: true, mode: 'VERIFIED',
                     capped: false } });
        add('kpi no delta', { kind: 'kpi', span: 1, value: 12, fieldLabel: 'Records',
            reason: 'no previous period', median: 4, n: 12 });
        add('kpi zero', { kind: 'kpi', span: 1, value: 0, fieldLabel: 'Records',
            reason: 'nothing here' });
        if (form === 'stat_tile') {
            add('dimension scalar', { kind: 'dimension',
                rows: groupedRows(1, function () { return 42; }) });
        }
        return out;
    }

    /* Everything grouped: ranked bar, column, donut, treemap, stacked. */
    add('normal', { kind: 'dimension',
        rows: groupedRows(6, function (i) { return 60 - i * 8; }) });
    add('one row', { kind: 'dimension', rows: groupedRows(1, function () { return 5; }) });
    add('all zero', { kind: 'dimension', rows: groupedRows(5, function () { return 0; }) });
    add('all equal', { kind: 'dimension', rows: groupedRows(5, function () { return 20; }) });
    add('with Other', { kind: 'dimension', rows: {
        series: groupedRows(4, function (i) { return 30 - i * 5; }).series,
        other: { count: 40, groups: 12 } } });
    add('empty key', { kind: 'dimension', rows: {
        series: [{ key: '', label: '', count: 30 },
                 { key: 'a', label: 'Real', count: 70 }], other: null } });
    return out;
}

/** Does this panel carry any non-zero magnitude at all? */
function hasMagnitude(panel) {
    var i, j;
    if (panel.series) {
        for (i = 0; i < panel.series.length; i++) {
            for (j = 0; j < panel.series[i].counts.length; j++) {
                if (panel.series[i].counts[j] > 0) return true;
            }
        }
        return false;
    }
    if (panel.stages) {
        for (i = 0; i < panel.stages.length; i++) if (panel.stages[i].count > 0) return true;
        return false;
    }
    if (panel.steps) {
        for (i = 0; i < panel.steps.length; i++) if (panel.steps[i].delta !== 0) return true;
        return false;
    }
    if (panel.rows && panel.rows.length && panel.rows[0].from !== undefined) {
        for (i = 0; i < panel.rows.length; i++) {
            if (panel.rows[i].from > 0 || panel.rows[i].to > 0) return true;
        }
        return false;
    }
    if (panel.rows && panel.rows.series) {
        for (i = 0; i < panel.rows.series.length; i++) {
            if (panel.rows.series[i].count > 0) return true;
        }
        return false;
    }
    return true;
}

/**
 * Which of a panel's data items never made it into the output.
 *
 * The assertion that node counting cannot make. A renderer that draws one series
 * out of five emits a completely healthy number of nodes -- a line, its markers, an
 * axis, a legend -- and passes every structural check. It fails this one, which is
 * the whole reason this function exists: `line_multi` aliased to the single-series
 * renderer was exactly that bug, it shipped, and a mutation test proved the suite
 * would not have caught it coming back.
 *
 * Only applied where every item is genuinely expected on screen. Forms that
 * legitimately fold, rank or truncate their input are excluded by item count rather
 * than by special-casing the form, so a new form gets this check for free.
 */
function missingItems(panel, text) {
    var items = [];
    var i;

    /* Scalar forms show one aggregate on purpose. A stat tile that listed the
       categories behind its number would not be a stat tile. */
    var SCALAR = ['stat_tile', 'stat_tile_delta', 'gauge'];
    for (i = 0; i < SCALAR.length; i++) if (panel.form === SCALAR[i]) return [];

    /* A panel whose every value is zero has nothing to draw, and the correct
       output is the explicit empty state rather than a set of zero-width marks
       carrying labels. Requiring the labels there would be asserting that the
       renderer must fake a chart, which is the opposite of the rule. */
    if (!hasMagnitude(panel)) return [];

    /* A bump chart draws the keys along the rank path, not the endpoint rows it
       also carries for its slope fallback, so those are the items to expect. */
    if (panel.keys && panel.path) {
        for (i = 0; i < panel.keys.length; i++) items.push(panel.keys[i].label);
    } else if (panel.series) {
        for (i = 0; i < panel.series.length; i++) items.push(panel.series[i].label);
        if (panel.other) items.push(panel.other.label);
    } else if (panel.stages) {
        for (i = 0; i < panel.stages.length; i++) items.push(panel.stages[i].label);
    } else if (panel.steps) {
        for (i = 0; i < panel.steps.length; i++) items.push(panel.steps[i].label);
    } else if (panel.rows && panel.rows.length && panel.rows[0].label !== undefined) {
        for (i = 0; i < panel.rows.length; i++) items.push(panel.rows[i].label);
    } else if (panel.rows && panel.rows.series) {
        for (i = 0; i < panel.rows.series.length; i++) {
            var lab = panel.rows.series[i].label;
            /* The empty key renders as "(none)", which is a label the payload does
               not carry, so asserting on it would be asserting on the renderer's
               own vocabulary rather than on the data reaching the page. */
            if (lab) items.push(lab);
        }
    }

    /* Above this, legends and axes legitimately truncate with a "+N more", and a
       missing label is a layout decision rather than dropped data. */
    if (!items.length || items.length > 9) return [];

    var missing = [];
    for (i = 0; i < items.length; i++) {
        /* Labels are truncated for display, so match on a prefix short enough to
           survive any of the truncation widths in the renderer. */
        var probe = String(items[i]).substring(0, 8);
        if (probe && text.indexOf(probe) === -1) missing.push(items[i]);
    }
    return missing;
}

/* ── run ── */

var declared = [];
fs.readFileSync(FORM, 'utf8')
  .match(/CmdForm\.FORMS\s*=\s*\[([\s\S]*?)\];/)[1]
  .replace(/'([a-z_0-9]+)'/g, function (_, n) { declared.push(n); });

var shell = {
    version: 1, generated: 'test', viewer: { name: 't', display: 'T' },
    subject: { table: 'incident', label: 'Incident', query: '', rows: 100,
               listUrl: 'incident_list.do' },
    acl: { mode: 'VERIFIED', aggregate: 100, secure: 100, delta: 0, capped: false },
    path: [], panels: [], kpis: [], matrix: null, notes: [],
    drill: { atMax: false, options: [] }, declared: [], timingMs: 1
};

console.log('\n' + declared.length + ' forms, degenerate cases included\n');
var totalCases = 0;

declared.forEach(function (form) {
    var cases = casesFor(form);
    var bad = [];
    cases.forEach(function (c) {
        totalCases++;
        var payload = JSON.parse(JSON.stringify(shell));
        if (c.panel.kind === 'kpi') payload.kpis = [c.panel];
        else if (c.panel.form === 'matrix') payload.matrix = c.panel;
        else payload.panels = [c.panel];
        try {
            var r = sandboxFor(payload);
            var n = shim.summarise(r.mount).total;
            if (n < 5) bad.push(c.label + ' (drew only ' + n + ' nodes)');
            var missed = missingItems(c.panel, shim.textOf(r.mount));
            if (missed.length) {
                bad.push(c.label + ': drew nothing for ' + missed.join(', '));
            }
        } catch (e) {
            bad.push(c.label + ': ' + e.message);
        }
    });
    ok(form + '  (' + cases.length + ' cases)', bad.length === 0, bad.join('\n        '));
});

console.log('\n' + totalCases + ' cases across ' + declared.length + ' forms');
console.log(pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
