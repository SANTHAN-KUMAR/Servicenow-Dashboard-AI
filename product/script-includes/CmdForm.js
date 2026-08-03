/**
 * CmdForm. The form engine.
 *
 * Chooses a visual form from the measured shape of the data rather than from an
 * author's preference. This is the piece that justifies the whole product: the
 * instance stores no field-to-form mapping, because the platform has no such
 * logic, so `sys_report.type` records what somebody picked and not what the data
 * warranted. Measured on the live instance: `priority` is drawn nine different
 * ways, `category` eleven, and `sys_created_on`, a datetime, is drawn as a scalar
 * 20 times out of 26 with not one line, trend, spline or area.
 *
 * Two design rules make this reviewable rather than magic.
 *
 * 1. It is a flat rule table, first match wins, top to bottom. No scoring, no
 *    weights, no model. A human can read the table and predict the output, and a
 *    regression run can diff every one of the 2,368 live reports against it.
 * 2. It is a pure function. No GlideRecord, no gs, no instance state. Everything
 *    it needs arrives on the context object, which means it runs unchanged in
 *    Rhino on the instance and in Node in the test harness.
 *
 * Selection happens first, then guards run against the chosen form. A guard never
 * picks a form; it either annotates it with a caveat the renderer must show, or
 * demotes it when the data cannot honestly carry it. That ordering matters: it is
 * what stops a technically valid chart from being a dishonest one.
 *
 * ES5 only. This runs in Rhino.
 */

/* Rhino on the instance provides Class. Node does not, and this file has to load
   in both so the regression harness can exercise the real engine rather than a
   copy of it that drifts. Declared before first use, not after. */
if (typeof Class === 'undefined') {
    var Class = { create: function () { return function () {}; } };
}

var CmdForm = Class.create();

/* Forms this engine can emit. The renderer must implement every one of these,
   and the test harness asserts that the two lists agree. */
CmdForm.FORMS = [
    'stat_tile',
    'stat_tile_delta',
    'line',
    'line_multi',
    'area',
    'stream',
    'small_multiples',
    'column',
    'ranked_bar',
    'ranked_bar_top_n',
    'stacked_proportion',
    'stacked_ordinal',
    'donut',
    'semi_donut',
    'heatmap',
    'calendar_heatmap',
    'treemap',
    'scatter',
    'histogram',
    'box',
    'gauge',
    'waterfall',
    'pareto',
    'slope',
    'matrix'
];

/* Thresholds. Named, in one place, so a reviewer can argue with the numbers
   without reading the logic, and so the regression harness can sweep them. */
CmdForm.T = {
    LOW_N: 30,               // below this, a distribution is anecdote not evidence
    SPARSE_FILL: 0.60,       // a dimension this empty is not a dimension
    BAR_MAX: 12,             // above this, rank and truncate rather than draw all
    ORDINAL_MAX: 7,          // ordinal scales stay readable to about here
    PART_WHOLE_MAX: 6,       // arcs stop being comparable beyond this
    CONCENTRATED: 0.80,      // top 20% of categories holding this much mass
    DISPERSED: 0.50,         // ... or this little, which argues for area not length
    FACET_MAX: 9,            // small multiples stop being small beyond this
    HEATMAP_MIN: 3,          // a 2x2 grid is a table, not a heatmap
    TREEMAP_MIN: 8,          // below this, length beats area every time
    HIST_MIN_DISTINCT: 12    // a numeric field with fewer levels is categorical
};

CmdForm.prototype = {

    initialize: function () {},

    /**
     * The rule table. First match wins.
     *
     * Read the conditions as "what question is this panel answering", not as
     * "what does this field look like". The order encodes precedence: time beats
     * category, declared measures beat counts, and shape only decides between
     * forms that are already appropriate to the question.
     *
     * @param ctx see normalise() for the full contract
     * @return {{form:string, reason:string}}
     */
    selectForm: function (ctx) {
        var T = CmdForm.T;
        var c = this.normalise(ctx);

        /* No dimension at all. 36.9% of reports on this instance are in this
           category, and a scalar is the honest answer for them. */
        if (!c.field) {
            /* A target turns a bare number into a question with an answer, which
               is what a gauge is for. Without one there is nothing to fill. */
            if (c.hasTarget) {
                return this.pick('gauge', 'a single value measured against a declared target');
            }
            return c.hasComparison
                ? this.pick('stat_tile_delta', 'no dimension, and a prior period exists to compare against')
                : this.pick('stat_tile', 'no dimension, so there is nothing to plot');
        }

        /* A single distinct value is not a distribution. */
        if (c.distinct <= 1) {
            return this.pick('stat_tile', 'the dimension resolves to one value, so there is no comparison to draw');
        }

        /* ── Time. The instance gets this wrong more than anything else. ── */
        if (c.isTime) {
            if (c.grain === 'hour_of_week') {
                return this.pick('calendar_heatmap', 'time of day against day of week is a two-dimensional cycle, not a series');
            }
            /* Exactly two periods across several categories is not a series, it
               is a before and after. A line between two points invites reading a
               trend that two observations cannot support; a slope chart states
               the comparison and ranks the movement. */
            if (c.periods === 2 && c.seriesCount > 1) {
                return this.pick('slope', 'two periods compared across categories, which is a ranking change and not a trend');
            }
            if (c.seriesCount <= 1) {
                if (c.n < T.LOW_N) {
                    return this.pick('column', 'one series over time but too few points for a trend line to mean anything');
                }
                /* Stock against flow. A level that exists at each point in time,
                   like open backlog, is bounded below by zero and the area under
                   it is meaningful, so fill it. A count of events occurring in
                   each period is a rate, where the area means nothing and the
                   line alone is the honest mark. */
                return c.isStock
                    ? this.pick('area', 'a level measured at each point in time, where the area to the zero baseline is meaningful')
                    : this.pick('line', 'one series of events per period, where the line is the mark and area would overstate it');
            }
            if (c.seriesCount <= 4 && c.isPartToWhole) {
                return this.pick('stream', 'a few series over time whose parts sum to a meaningful whole');
            }
            if (c.seriesCount <= 4) {
                return this.pick('line_multi', 'a few independent series over time, comparable on one axis');
            }
            if (c.seriesCount <= T.FACET_MAX) {
                return this.pick('small_multiples', 'too many series to overplot, few enough to facet');
            }
            return this.pick('small_multiples', 'more series than can be faceted, so facet the top ones and fold the rest into Other');
        }

        /* ── Two dimensions. ── */
        if (c.dims === 2) {
            /* Two numeric measures against each other is a correlation question,
               not a cross-tabulation. Binning either of them into cells would
               throw away the thing being asked about. */
            if (c.isMeasure && c.isMeasure2) {
                return this.pick('scatter', 'two numeric measures against each other, where the question is how they relate');
            }
            if (c.distinct >= T.HEATMAP_MIN && c.distinct2 >= T.HEATMAP_MIN) {
                return this.pick('heatmap', 'two categorical dimensions, both wide enough that a grid of cells beats a grouped bar');
            }
            return this.pick('matrix', 'two dimensions, at least one of them narrow, so the numbers themselves are the visual');
        }

        /* ── A declared numeric measure changes the question from "how many"
              to "how much", and that changes the appropriate forms. ── */
        if (c.isMeasure) {
            if (c.aggregate === 'AVG' && c.distinct <= T.BAR_MAX) {
                return this.pick('ranked_bar', 'an average per category is a length comparison, and averages must never be stacked');
            }
            if (c.isSigned) {
                return this.pick('waterfall', 'a signed measure across categories reads as contribution to a net position');
            }
            if (c.distinct >= T.TREEMAP_MIN && c.concentration < T.DISPERSED) {
                return this.pick('treemap', 'a dispersed additive measure over many categories, where area carries the total better than length');
            }
            if (c.distinct <= T.BAR_MAX) {
                return this.pick('ranked_bar', 'an additive measure over few enough categories to rank directly');
            }
            return this.pick('pareto', 'an additive measure over many categories, where the cumulative share is the actual question');
        }

        /* ── Boolean. Two values, and the interesting thing is the ratio. ── */
        if (c.isBoolean) {
            return this.pick('stacked_proportion', 'a boolean split, where the share matters and the absolute pair does not');
        }

        /* ── Ordinal. Order is meaningful, so never sort by magnitude. ── */
        if (c.isOrdinal) {
            if (c.distinct <= T.ORDINAL_MAX) {
                return this.pick('stacked_ordinal', 'an ordered scale, so the sequence is preserved and the parts are shown against the whole');
            }
            return this.pick('column', 'an ordered scale too long to stack, drawn in its own order rather than ranked');
        }

        /* ── Numeric, undeclared as a measure: a distribution question. ── */
        if (c.isNumeric) {
            if (c.distinct >= T.HIST_MIN_DISTINCT) {
                return c.hasGroups
                    ? this.pick('box', 'a numeric distribution compared across groups')
                    : this.pick('histogram', 'a numeric distribution with enough levels to bin');
            }
            return this.pick('column', 'a numeric field with few enough levels to treat as categorical');
        }

        /* ── Plain nominal categories. The commonest case, and the one where
              shape actually decides. ── */
        if (c.isPartToWhole && c.distinct <= T.PART_WHOLE_MAX) {
            return c.distinct <= 3
                ? this.pick('semi_donut', 'a part-to-whole with very few slices, where a half arc reads cleaner and leaves room for the total')
                : this.pick('donut', 'a part-to-whole with few enough slices for arcs to stay comparable');
        }
        if (c.distinct <= T.BAR_MAX) {
            return this.pick('ranked_bar', 'few enough categories to rank and draw in full');
        }
        if (c.concentration >= T.CONCENTRATED) {
            return this.pick('ranked_bar_top_n', 'many categories but the mass is concentrated at the head, so rank the head and fold the tail');
        }
        if (c.distinct >= T.TREEMAP_MIN && c.concentration < T.DISPERSED) {
            return this.pick('treemap', 'many categories with the mass spread evenly, where area shows the whole and length would not fit');
        }
        return this.pick('ranked_bar_top_n', 'many categories with no dominant head, ranked and truncated with the remainder named');
    },

    /**
     * Guards. These run after selection and never choose a form.
     *
     * Two kinds. A caveat annotates the panel: the chart still stands, but the
     * viewer is told something about the data they would otherwise have to
     * assume. A demotion replaces the form, because the data cannot honestly
     * carry the one that was chosen.
     *
     * @return {{form, reason, caveats:Array, demoted:boolean, suppressed:boolean}}
     */
    applyGuards: function (chosen, ctx) {
        var T = CmdForm.T;
        var c = this.normalise(ctx);
        var form = chosen.form;
        var reason = chosen.reason;
        var caveats = [];
        var demoted = false;
        var suppressed = false;

        /* 1. Nothing to draw. Not an error, and not an empty chart either: an
              empty state that says which filter emptied it. */
        if (c.n === 0) {
            return {
                form: 'stat_tile', reason: 'no rows match', caveats: [
                    { code: 'empty', text: 'No records match this filter for you.' }
                ], demoted: true, suppressed: true
            };
        }

        /* 2. Row-level ACLs removed rows from the aggregate. This is the
              engagement's lead correctness claim and it is never silent. */
        if (c.aclFiltered) {
            caveats.push({
                code: 'acl_filtered',
                severity: 'info',
                text: 'Filtered to the ' + fmt(c.secureTotal) + ' records you can read. ' +
                      fmt(c.aclDelta) + ' more exist that you do not have access to.'
            });
        }

        /* 3. The secure scan hit its cap, so every count is a floor and not a
              total. Presenting a capped count as exact would be a lie. */
        if (c.capped) {
            caveats.push({
                code: 'capped',
                severity: 'warn',
                text: 'Counts are a lower bound. The permission-checked scan stopped at ' +
                      fmt(c.scanCap) + ' records.'
            });
        }

        /* 4. Sparse dimension. This is the 99.7%-empty subcategory case, and it
              is the difference between a useful panel and a dumb stub. */
        if (c.fillRate < T.SPARSE_FILL) {
            var emptyPct = Math.round((1 - c.fillRate) * 1000) / 10;
            if (c.fillRate < 0.10) {
                form = 'stat_tile';
                demoted = true;
                reason = 'the dimension is empty on ' + emptyPct + '% of these records, so there is no distribution to draw';
                caveats.push({
                    code: 'sparse_fatal', severity: 'warn',
                    text: c.fieldLabel + ' is empty on ' + emptyPct + '% of these records. ' +
                          'Charting it would describe ' + fmt(c.filledN) + ' records, not ' + fmt(c.n) + '.'
                });
            } else {
                caveats.push({
                    code: 'sparse', severity: 'warn',
                    text: c.fieldLabel + ' is empty on ' + emptyPct + '% of these records. ' +
                          'The chart covers the ' + fmt(c.filledN) + ' that have a value.'
                });
            }
        }

        /* 5. Low n. A distribution over 11 records is an anecdote. */
        if (c.n > 0 && c.n < T.LOW_N) {
            caveats.push({
                code: 'low_n', severity: 'info',
                text: 'Only ' + fmt(c.n) + ' records. Treat the shape as indicative.'
            });
        }

        /* 6. Part-to-whole forms cannot represent mixed signs. An arc has no way
              to draw a negative slice, so it silently lies. */
        if (c.isSigned && isPartToWholeForm(form)) {
            form = 'waterfall';
            demoted = true;
            reason = 'the measure has both positive and negative values, which a part-to-whole form cannot represent';
            caveats.push({
                code: 'signed', severity: 'info',
                text: 'Values are both positive and negative, so this is drawn as contribution to a net total.'
            });
        }

        /* 7. Zero variance. Every category identical: a bar chart of equal bars
              tells you less than one number and a note. */
        if (c.zeroVariance && form !== 'stat_tile') {
            form = 'stat_tile';
            demoted = true;
            reason = 'every category holds the same value, so the distribution carries no information';
            caveats.push({
                code: 'flat', severity: 'info',
                text: 'All ' + fmt(c.distinct) + ' values are equal.'
            });
        }

        /* 8. The trailing period is still open, so its dip is an artefact of
              when you looked and not a fall in the data. */
        if (c.partialTail && isTimeForm(form)) {
            caveats.push({
                code: 'partial_tail', severity: 'info',
                text: 'The final ' + (c.grain || 'period') + ' is still in progress and is drawn dashed.'
            });
        }

        /* 9. A truncated tail is always named and counted. Never a silent top-N. */
        if (form === 'ranked_bar_top_n' && c.distinct > T.BAR_MAX) {
            caveats.push({
                code: 'truncated', severity: 'info',
                text: 'Showing the top ' + T.BAR_MAX + ' of ' + fmt(c.distinct) +
                      '. The remaining ' + fmt(c.distinct - T.BAR_MAX) + ' are grouped as Other.'
            });
        }

        return {
            form: form, reason: reason, caveats: caveats,
            demoted: demoted, suppressed: suppressed
        };
    },

    /**
     * The whole decision, selection then guards, as one call. This is what the
     * payload builder uses.
     */
    decide: function (ctx) {
        var chosen = this.selectForm(ctx);
        var guarded = this.applyGuards(chosen, ctx);
        return {
            form: guarded.form,
            reason: guarded.reason,
            selected_form: chosen.form,
            selected_reason: chosen.reason,
            demoted: guarded.demoted,
            suppressed: guarded.suppressed,
            caveats: guarded.caveats
        };
    },

    /**
     * Fills in defaults and derives the flags the rule table reads, so every
     * caller does not have to. Keeping this separate is what lets the rule table
     * stay readable.
     */
    normalise: function (ctx) {
        var c = ctx || {};
        var n = num(c.n, 0);
        var filledN = c.filledN === undefined ? n : num(c.filledN, 0);
        var fillRate = c.fillRate === undefined
            ? (n > 0 ? filledN / n : 1)
            : num(c.fillRate, 1);

        var secureTotal = c.secureTotal === undefined ? n : num(c.secureTotal, n);
        var aggregateTotal = c.aggregateTotal === undefined ? secureTotal : num(c.aggregateTotal, secureTotal);
        var aclDelta = aggregateTotal - secureTotal;

        return {
            field: c.field || null,
            fieldLabel: c.fieldLabel || c.field || 'this dimension',
            fieldType: c.fieldType || '',
            dims: num(c.dims, c.field ? 1 : 0),
            distinct: num(c.distinct, 0),
            distinct2: num(c.distinct2, 0),
            n: n,
            filledN: filledN,
            fillRate: fillRate,
            topShare: num(c.topShare, 0),
            concentration: num(c.concentration, 0),
            aggregate: c.aggregate || 'COUNT',
            grain: c.grain || null,
            seriesCount: num(c.seriesCount, 1),
            periods: num(c.periods, 0),

            isTime: !!c.isTime,
            isOrdinal: !!c.isOrdinal,
            isBoolean: !!c.isBoolean,
            isNumeric: !!c.isNumeric,
            isMeasure: !!c.isMeasure,
            isMeasure2: !!c.isMeasure2,
            isSigned: !!c.isSigned,
            isStock: !!c.isStock,
            hasTarget: !!c.hasTarget,
            isPartToWhole: !!c.isPartToWhole,
            hasGroups: !!c.hasGroups,
            hasComparison: !!c.hasComparison,
            zeroVariance: !!c.zeroVariance,
            partialTail: !!c.partialTail,

            capped: !!c.capped,
            scanCap: num(c.scanCap, 20000),
            aclFiltered: aclDelta > 0,
            aclDelta: aclDelta,
            secureTotal: secureTotal,
            aggregateTotal: aggregateTotal
        };
    },

    pick: function (form, reason) {
        return { form: form, reason: reason };
    },

    type: 'CmdForm'
};

/* ── helpers, file-local ── */

function isPartToWholeForm(f) {
    return f === 'donut' || f === 'semi_donut' ||
           f === 'stacked_proportion' || f === 'stacked_ordinal' ||
           f === 'treemap' || f === 'stream';
}

function isTimeForm(f) {
    return f === 'line' || f === 'line_multi' || f === 'area' ||
           f === 'stream' || f === 'small_multiples' || f === 'slope' ||
           f === 'calendar_heatmap';
}

function num(v, d) {
    var x = typeof v === 'number' ? v : parseFloat(v);
    return isNaN(x) ? d : x;
}

function fmt(v) {
    var s = String(Math.round(num(v, 0)));
    var out = '';
    var count = 0;
    for (var i = s.length - 1; i >= 0; i--) {
        out = s.charAt(i) + out;
        count++;
        if (count % 3 === 0 && i > 0) out = ',' + out;
    }
    return out;
}

/* Node test harness interop. On the instance this block is inert, because there
   is no `module`. Keeping the engine loadable in Node is what makes the
   regression run against all 2,368 live report shapes possible at all. */
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        CmdForm: CmdForm,
        FORMS: CmdForm.FORMS,
        T: CmdForm.T,
        create: function () { return new CmdForm(); }
    };
}
