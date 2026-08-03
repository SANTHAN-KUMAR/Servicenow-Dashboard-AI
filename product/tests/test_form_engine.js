/**
 * Regression harness for the form engine.
 *
 * Loads the real CmdForm.js, not a copy, so the thing under test is the thing
 * that ships. Run with: node product/tests/test_form_engine.js
 *
 * Three groups of assertions:
 *
 *  1. The measured failures. Every one of these is a case the live instance gets
 *     wrong today, taken from 08-live-report-inventory.md. If the engine agreed
 *     with the instance on any of them it would have no reason to exist.
 *  2. The guards. Each guard gets a case that triggers it and, where the guard
 *     demotes rather than annotates, a case that proves the demotion happens.
 *  3. Structural. Every form the engine can emit is reachable, and every form it
 *     emits is on the declared list. A form the rule table can never produce is
 *     dead code; a form it produces that the renderer does not know about is a
 *     blank panel in production.
 */

var path = require('path');
var m = require(path.join(__dirname, '..', 'script-includes', 'CmdForm.js'));
var engine = m.create();

var pass = 0, fail = 0;
var failures = [];
var emitted = {};

function check(name, ctx, expect) {
    var got = engine.decide(ctx);
    emitted[got.form] = true;
    var ok = true, why = [];

    if (expect.form && got.form !== expect.form) {
        ok = false; why.push('form: expected ' + expect.form + ', got ' + got.form);
    }
    if (expect.demoted !== undefined && got.demoted !== expect.demoted) {
        ok = false; why.push('demoted: expected ' + expect.demoted + ', got ' + got.demoted);
    }
    if (expect.caveat) {
        var codes = got.caveats.map(function (c) { return c.code; });
        if (codes.indexOf(expect.caveat) === -1) {
            ok = false; why.push('caveat: expected "' + expect.caveat + '", got [' + codes.join(', ') + ']');
        }
    }
    if (expect.noCaveat) {
        var codes2 = got.caveats.map(function (c) { return c.code; });
        if (codes2.indexOf(expect.noCaveat) !== -1) {
            ok = false; why.push('caveat: did not expect "' + expect.noCaveat + '"');
        }
    }

    if (ok) { pass++; }
    else { fail++; failures.push({ name: name, why: why, got: got }); }
}

/* ══════════════════════════════════════════════════════════════════════════
   1. The failures measured on the live instance.
   ══════════════════════════════════════════════════════════════════════════ */

// The instance draws sys_created_on, a datetime, as single_score 20 times out of
// 26 and as a line exactly never. This is the headline failure.
check('datetime, 12 months of data', {
    field: 'sys_created_on', fieldType: 'glide_date_time', isTime: true,
    grain: 'month', dims: 1, distinct: 12, n: 13986, seriesCount: 1
}, { form: 'line' });

// priority: ordinal, 5 values. The instance draws it nine different ways
// including as a line chart four times and a single_score three times.
check('priority, ordinal 5 values', {
    field: 'priority', fieldType: 'integer', isOrdinal: true, isPartToWhole: true,
    dims: 1, distinct: 5, n: 13986, concentration: 0.62
}, { form: 'stacked_ordinal' });

// category: nominal, ~10 values. Instance draws it eleven ways.
check('category, nominal 10 values', {
    field: 'category', fieldType: 'string', dims: 1, distinct: 10,
    n: 13986, topShare: 0.27, concentration: 0.48
}, { form: 'ranked_bar' });

// active: boolean, 200 reports group by it.
check('active, boolean', {
    field: 'active', fieldType: 'boolean', isBoolean: true,
    dims: 1, distinct: 2, n: 13986
}, { form: 'stacked_proportion' });

// 36.9% of live reports have no group-by at all. A scalar is correct for them.
check('no dimension', { field: null, n: 13986 }, { form: 'stat_tile' });

check('no dimension, with a prior period', {
    field: null, n: 13986, hasComparison: true
}, { form: 'stat_tile_delta' });

// assigned_to: reference, high cardinality, concentrated head.
check('assigned_to, high cardinality concentrated', {
    field: 'assigned_to', fieldType: 'reference', dims: 1, distinct: 140,
    n: 13986, topShare: 0.19, concentration: 0.87
}, { form: 'ranked_bar_top_n', caveat: 'truncated' });

/* ══════════════════════════════════════════════════════════════════════════
   2. Guards.
   ══════════════════════════════════════════════════════════════════════════ */

// The measured 99.7%-empty subcategory. Must not draw a distribution at all.
check('incident.subcategory, 99.7% empty', {
    field: 'subcategory', fieldLabel: 'Subcategory', fieldType: 'string',
    dims: 1, distinct: 13, n: 13986, filledN: 42, fillRate: 42 / 13986,
    concentration: 0.6
}, { form: 'stat_tile', demoted: true, caveat: 'sparse_fatal' });

// The software slice of the same field: 99.3% empty within the slice.
check('software slice, 99.3% empty', {
    field: 'subcategory', fieldLabel: 'Subcategory', fieldType: 'string',
    dims: 1, distinct: 3, n: 2651, filledN: 18, fillRate: 18 / 2651
}, { form: 'stat_tile', demoted: true, caveat: 'sparse_fatal' });

// Partially sparse: annotate but still draw.
check('partially sparse, 45% filled', {
    field: 'location', fieldLabel: 'Location', fieldType: 'reference',
    dims: 1, distinct: 8, n: 1000, filledN: 450, fillRate: 0.45,
    concentration: 0.55
}, { form: 'ranked_bar', demoted: false, caveat: 'sparse' });

// change_request category to type, fully populated. Must NOT get a sparse caveat.
check('change_request, fully populated', {
    field: 'category', fieldType: 'string', dims: 1, distinct: 7,
    n: 238, filledN: 238, fillRate: 1.0, concentration: 0.71
}, { form: 'ranked_bar', noCaveat: 'sparse' });

// ACL divergence must be surfaced, never silent.
check('acl filtered', {
    field: 'category', fieldType: 'string', dims: 1, distinct: 6,
    n: 40, filledN: 40, aggregateTotal: 67, secureTotal: 40, concentration: 0.6
}, { caveat: 'acl_filtered' });

check('acl clean, no badge', {
    field: 'category', fieldType: 'string', dims: 1, distinct: 6,
    n: 500, filledN: 500, aggregateTotal: 500, secureTotal: 500, concentration: 0.6
}, { noCaveat: 'acl_filtered' });

// A capped secure scan makes every count a floor.
check('secure scan capped', {
    field: 'category', fieldType: 'string', dims: 1, distinct: 6,
    n: 20000, filledN: 20000, capped: true, scanCap: 20000, concentration: 0.6
}, { caveat: 'capped' });

// Low n.
check('low n', {
    field: 'category', fieldType: 'string', dims: 1, distinct: 4,
    n: 11, filledN: 11, concentration: 0.7
}, { caveat: 'low_n' });

// Zero rows: an empty state, not an empty chart.
check('no matching rows', {
    field: 'category', fieldType: 'string', dims: 1, distinct: 0, n: 0
}, { form: 'stat_tile', demoted: true, caveat: 'empty' });

// A signed measure cannot be drawn as a part-to-whole.
check('signed measure, part-to-whole rejected', {
    field: 'cost_centre', fieldType: 'string', isMeasure: true, isNumeric: true,
    isSigned: true, isPartToWhole: true, aggregate: 'SUM',
    dims: 1, distinct: 5, n: 400, filledN: 400, concentration: 0.6
}, { form: 'waterfall' });

// Every category identical.
check('zero variance', {
    field: 'state', fieldType: 'integer', isOrdinal: true,
    dims: 1, distinct: 5, n: 500, filledN: 500, zeroVariance: true
}, { form: 'stat_tile', demoted: true, caveat: 'flat' });

// The open trailing period.
check('partial trailing period', {
    field: 'opened_at', isTime: true, grain: 'month', dims: 1,
    distinct: 12, n: 13986, seriesCount: 1, partialTail: true
}, { form: 'line', caveat: 'partial_tail' });

/* ══════════════════════════════════════════════════════════════════════════
   3. Reaching the rest of the forms.
   ══════════════════════════════════════════════════════════════════════════ */

check('time, few part-to-whole series', {
    field: 'opened_at', isTime: true, grain: 'month', dims: 1, distinct: 12,
    n: 5000, seriesCount: 3, isPartToWhole: true
}, { form: 'stream' });

check('time, few independent series', {
    field: 'opened_at', isTime: true, grain: 'month', dims: 1, distinct: 12,
    n: 5000, seriesCount: 3
}, { form: 'line_multi' });

check('time, many series', {
    field: 'opened_at', isTime: true, grain: 'month', dims: 1, distinct: 12,
    n: 5000, seriesCount: 7
}, { form: 'small_multiples' });

check('time, too few points for a line', {
    field: 'opened_at', isTime: true, grain: 'month', dims: 1, distinct: 4,
    n: 20, seriesCount: 1
}, { form: 'column' });

check('hour of week cycle', {
    field: 'opened_at', isTime: true, grain: 'hour_of_week', dims: 1,
    distinct: 168, n: 13986
}, { form: 'calendar_heatmap' });

check('two wide categoricals', {
    field: 'category', fieldType: 'string', dims: 2, distinct: 8, distinct2: 6,
    n: 13986, filledN: 13986
}, { form: 'heatmap' });

check('two dimensions, one narrow', {
    field: 'category', fieldType: 'string', dims: 2, distinct: 8, distinct2: 2,
    n: 13986, filledN: 13986
}, { form: 'matrix' });

check('average per category', {
    field: 'assignment_group', fieldType: 'reference', isMeasure: true,
    isNumeric: true, aggregate: 'AVG', dims: 1, distinct: 9, n: 4000,
    filledN: 4000, concentration: 0.6
}, { form: 'ranked_bar' });

check('dispersed additive measure', {
    field: 'cost_centre', fieldType: 'string', isMeasure: true, isNumeric: true,
    aggregate: 'SUM', dims: 1, distinct: 22, n: 3000, filledN: 3000,
    concentration: 0.34
}, { form: 'treemap' });

check('additive measure, long tail', {
    field: 'vendor', fieldType: 'reference', isMeasure: true, isNumeric: true,
    aggregate: 'SUM', dims: 1, distinct: 60, n: 3000, filledN: 3000,
    concentration: 0.72
}, { form: 'pareto' });

check('part-to-whole, few slices', {
    field: 'approval', fieldType: 'string', isPartToWhole: true, dims: 1,
    distinct: 4, n: 900, filledN: 900, concentration: 0.7
}, { form: 'donut' });

check('part-to-whole, very few slices', {
    field: 'approval', fieldType: 'string', isPartToWhole: true, dims: 1,
    distinct: 2, n: 900, filledN: 900, concentration: 0.9
}, { form: 'semi_donut' });

check('long ordinal', {
    field: 'stage', fieldType: 'integer', isOrdinal: true, dims: 1,
    distinct: 11, n: 900, filledN: 900
}, { form: 'column' });

check('numeric distribution', {
    field: 'reassignment_count', fieldType: 'integer', isNumeric: true,
    dims: 1, distinct: 20, n: 5000, filledN: 5000, concentration: 0.6
}, { form: 'histogram' });

check('numeric distribution across groups', {
    field: 'duration_hours', fieldType: 'decimal', isNumeric: true,
    hasGroups: true, dims: 1, distinct: 40, n: 5000, filledN: 5000
}, { form: 'box' });

check('numeric, few levels', {
    field: 'reassignment_count', fieldType: 'integer', isNumeric: true,
    dims: 1, distinct: 5, n: 5000, filledN: 5000
}, { form: 'column' });

// A bare number with a declared target. The brand kit's service-level panel.
check('single value against a target', {
    field: null, n: 13986, hasTarget: true
}, { form: 'gauge' });

// Stock against flow. Same field, same grain, different question, different mark.
check('time series of a level, not a rate', {
    field: 'opened_at', isTime: true, grain: 'month', dims: 1, distinct: 12,
    n: 13986, seriesCount: 1, isStock: true
}, { form: 'area' });

check('time series of events per period', {
    field: 'opened_at', isTime: true, grain: 'month', dims: 1, distinct: 12,
    n: 13986, seriesCount: 1, isStock: false
}, { form: 'line' });

// Two periods is a before and after, not a trend.
check('two periods across categories', {
    field: 'opened_at', isTime: true, grain: 'year', dims: 1, distinct: 2,
    periods: 2, seriesCount: 6, n: 9000
}, { form: 'slope' });

// Two numeric measures. Must not be binned into a heatmap.
check('two numeric measures', {
    field: 'volume', fieldType: 'integer', dims: 2,
    isMeasure: true, isMeasure2: true, isNumeric: true,
    distinct: 40, distinct2: 40, n: 3000, filledN: 3000
}, { form: 'scatter' });

// ... but two dimensions where only one is a measure is still a cross-tab.
check('one measure across two categoricals', {
    field: 'category', fieldType: 'string', dims: 2, isMeasure: true,
    aggregate: 'AVG', distinct: 8, distinct2: 5, n: 3000, filledN: 3000
}, { form: 'heatmap' });

check('dispersed nominal, many categories', {
    field: 'configuration_item', fieldType: 'reference', dims: 1, distinct: 40,
    n: 6000, filledN: 6000, topShare: 0.06, concentration: 0.31
}, { form: 'treemap' });

/* ══════════════════════════════════════════════════════════════════════════
   Report.
   ══════════════════════════════════════════════════════════════════════════ */

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');

if (failures.length) {
    failures.forEach(function (f) {
        console.log('  FAIL  ' + f.name);
        f.why.forEach(function (w) { console.log('        ' + w); });
        console.log('        reason given: ' + f.got.reason);
    });
    console.log('');
}

/* Structural: which declared forms can the rule table never produce? */
var unreachable = m.FORMS.filter(function (f) { return !emitted[f]; });
var undeclared = Object.keys(emitted).filter(function (f) { return m.FORMS.indexOf(f) === -1; });

console.log('  forms declared            ' + m.FORMS.length);
console.log('  forms reached by tests    ' + Object.keys(emitted).length);
console.log('  not reached               ' + (unreachable.length ? unreachable.join(', ') : 'none'));
console.log('  emitted but not declared  ' + (undeclared.length ? undeclared.join(', ') : 'none'));

if (undeclared.length) {
    console.log('\n  ## An undeclared form is a blank panel in production.');
}
console.log('');
process.exit(fail || undeclared.length ? 1 : 0);
