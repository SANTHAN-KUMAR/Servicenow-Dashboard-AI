/**
 * CmdAnalysis. The panel builders for every form beyond a single grouped count.
 *
 * CmdPayload answers "what is this subject, and how does one dimension of it
 * break down". That reaches eleven of the declared forms and no more, because
 * every remaining form needs data with a different shape: two dimensions crossed,
 * a series per category, the values of a numeric column rather than counts of
 * them, two measures against each other, a period against the one before it.
 *
 * This file builds those. Each method is one panel, each panel costs at most one
 * CmdData.reduce() pass, and each returns null rather than a degenerate chart when
 * the data does not support it. That last rule is the important one: the client's
 * stated complaint about the previous build was a fixed chart set drawn regardless
 * of subject, and the cure is not a bigger fixed set. A panel that cannot be
 * honestly drawn is not drawn.
 *
 * Every builder takes an explicit budget and every scan underneath is time-boxed,
 * so adding a panel to a page cannot make the page unbounded — it makes each
 * panel's share of the scan smaller, and truncation is reported on the panel
 * rather than hidden inside it.
 *
 * ES5 only. Rhino.
 */
var CmdAnalysis = Class.create();

/* Group counts that decide which form a time-by-category question takes. Below
   LINE_MAX the series are separable as lines; above it, lines become spaghetti and
   the honest forms are share-over-time or a grid of small panels. */
CmdAnalysis.LINE_MAX = 5;
CmdAnalysis.STREAM_MAX = 8;
CmdAnalysis.FACET_MAX = 9;

/* A crosstab has to be small enough that every cell is readable. Past this it is a
   matrix with a scrollbar, not a heatmap. */
CmdAnalysis.HEAT_MAX_ROWS = 12;
CmdAnalysis.HEAT_MAX_COLS = 12;

/* Below this many populated values a distribution is an anecdote. The box plot and
   the histogram both refuse under it. */
CmdAnalysis.DIST_MIN_N = 30;

/* A box plot needs enough observations per group to have quartiles worth drawing,
   and few enough groups to fit side by side. */
CmdAnalysis.BOX_MIN_PER_GROUP = 12;
CmdAnalysis.BOX_MAX_GROUPS = 8;

/* A scatter needs enough points to show a shape, and the correlation reported
   beneath it needs enough to mean anything. */
CmdAnalysis.SCATTER_MIN_N = 25;

/* Pareto only says something when the mass really is concentrated. Drawing an 80/20
   chart of a flat distribution is a chart arguing against itself. */
CmdAnalysis.PARETO_MIN_CONCENTRATION = 0.55;
CmdAnalysis.PARETO_MIN_GROUPS = 5;

/* A funnel is a sequence, so it needs a declared order and a real decline. A set of
   states that does not monotonically shed volume is a distribution drawn as a
   funnel, which is the single most common abuse of the form. */
CmdAnalysis.FUNNEL_MIN_STAGES = 3;
CmdAnalysis.FUNNEL_MAX_STAGES = 8;

/* Buckets needed before a forecast is offered. Fitting a trend to four points and
   projecting three more is astrology with error bars. */
CmdAnalysis.FORECAST_MIN_POINTS = 8;
CmdAnalysis.FORECAST_AHEAD = 3;
/* Residuals beyond this many standard deviations are marked as anomalies. Two is
   deliberately loose: this is a "look here" marker, not a significance test, and it
   is labelled as one. */
CmdAnalysis.ANOMALY_SIGMA = 2;

/* A gauge needs a target. Nothing on a stock instance declares one, so the only
   honest generic source is a column whose measured range is a percentage. Detected
   by measurement, never by column name, for the same reason every other decision
   here is: a name records an intention and the rows record a fact. */
CmdAnalysis.PCT_MAX = 100;
CmdAnalysis.PCT_MIN_DISTINCT = 3;

CmdAnalysis.prototype = {

    /**
     * @param data  a shared CmdData, so the ACL verdict and every memoised count
     *              carry over from the page that owns this
     * @param meta  a shared CmdMeta
     * @param form  a shared CmdForm, used for caveats rather than for selection:
     *              these panels know their own form by construction
     */
    initialize: function (data, meta, form) {
        this.data = data || new CmdData();
        this.meta = meta || new CmdMeta();
        this.form = form || new CmdForm();
    },

    /* ══════════════════════════════════════════════════════════════════════
       Headline tiles
       ══════════════════════════════════════════════════════════════════════ */

    /**
     * The KPI row: the numbers a leader reads before looking at any chart.
     *
     * A tile always carries a comparison where one can be computed. A bare number
     * is not a KPI, it is a fact, and the difference between the two is the whole
     * reason the client is asking for this product rather than reading a list view.
     */
    kpiRow: function (table, query, total, dateField, budgetMs) {
        var out = [];

        var headline = this.countTile(table, query, total, dateField);
        if (headline) out.push(headline);

        var g = this.gaugeTile(table, query, budgetMs);
        if (g) out.push(g);

        var d = this.durationTile(table, query, budgetMs);
        if (d) out.push(d);

        var m = this.measureTile(table, query, budgetMs);
        if (m) out.push(m);

        return out;
    },

    /** Record count, against the previous period of the same length. */
    countTile: function (table, query, total, dateField) {
        var base = {
            id: 'kpi_count', kind: 'kpi', span: 1,
            question: 'How many records, and is that more or fewer than before?',
            fieldLabel: 'Records',
            value: total.count,
            capped: !!total.capped
        };

        if (!dateField) {
            base.form = 'stat_tile';
            base.reason = 'no date field with usable spread, so there is no ' +
                          'previous period to compare against';
            return base;
        }

        var d = this.data.periodDelta(table, dateField, 'month', query);
        if (!d || d.previous === 0) {
            base.form = 'stat_tile';
            base.reason = 'the previous period holds no records, so a percentage ' +
                          'change would divide by zero';
            return base;
        }

        base.form = 'stat_tile_delta';
        base.reason = 'compared with the previous month on ' + dateField;
        base.delta = d;
        base.caveats = [];
        if (d.partial) {
            /* This is the caveat that stops the most common dashboard lie. The
               current month is incomplete by definition, so the raw comparison
               reads as a fall every time you look at it before the month ends. */
            base.caveats.push({
                severity: 'info',
                text: 'This month is ' + Math.round(d.elapsedFraction * 100) +
                      '% elapsed, so the comparison is projected to a full month. ' +
                      'Actual so far is ' + d.current + ' against ' + d.previous +
                      ' last month.'
            });
        }
        return base;
    },

    /**
     * A gauge, where and only where the data declares something to measure against.
     *
     * A percentage column is the one generic target that exists on a stock
     * instance: the target is 100 and the column says so itself. Everything else
     * would require a threshold nobody has stated, and inventing one would put a
     * number on screen that the client would reasonably ask us to justify.
     */
    gaugeTile: function (table, query, budgetMs) {
        var ms = this.meta.measures(table);
        for (var i = 0; i < ms.length && i < 6; i++) {
            if (ms[i].isDuration) continue;
            var p = this.data.numericProfile(table, ms[i].name, query, budgetMs);
            if (!p || p.n < CmdAnalysis.DIST_MIN_N) continue;
            /* Measured, not assumed. A column is a percentage if its values behave
               like one. */
            if (p.min < 0 || p.max > CmdAnalysis.PCT_MAX) continue;
            if (p.max <= 1) continue;               /* a 0-1 ratio, not a 0-100 percent */
            var distinct = p.bins && p.bins.k ? p.bins.k : 0;
            if (distinct < CmdAnalysis.PCT_MIN_DISTINCT) continue;

            return {
                id: 'kpi_gauge_' + ms[i].name, kind: 'kpi', span: 1,
                form: 'gauge',
                question: 'Where does ' + ms[i].label.toLowerCase() + ' sit against complete?',
                fieldLabel: ms[i].label,
                field: ms[i].name,
                value: p.mean,
                target: CmdAnalysis.PCT_MAX,
                median: p.median,
                n: p.n,
                reason: 'measured range is 0 to ' + p.max + ' across ' + p.n +
                        ' records, which is a percentage, so 100 is a target the ' +
                        'column declares rather than one we chose',
                capped: !!p.capped
            };
        }
        return null;
    },

    /**
     * Average elapsed time between the first and last date fields that are both
     * well populated. Reports the median beside the mean, because these
     * distributions are strongly right-skewed and the mean alone flatters them.
     */
    durationTile: function (table, query, budgetMs) {
        var pair = this._durationPair(table, query, budgetMs);
        if (!pair) return null;

        var r = this.data.durationHours(table, pair.start.name, pair.end.name,
                                        null, query, budgetMs);
        if (!r.rows.length || r.rows[0].n < CmdAnalysis.DIST_MIN_N) return null;
        var row = r.rows[0];

        var out = {
            id: 'kpi_duration', kind: 'kpi', span: 1,
            form: 'stat_tile',
            question: 'How long does one take, from ' + pair.start.label.toLowerCase() +
                      ' to ' + pair.end.label.toLowerCase() + '?',
            fieldLabel: 'Mean hours, ' + pair.start.label + ' to ' + pair.end.label,
            value: row.hours,
            unit: 'h',
            median: row.median,
            n: row.n,
            reason: 'measured over ' + row.n + ' records where both dates are set',
            caveats: [],
            capped: !!r.capped
        };
        if (row.median > 0 && row.hours / row.median > 1.5) {
            out.caveats.push({
                severity: 'info',
                text: 'The mean is ' + Math.round((row.hours / row.median) * 10) / 10 +
                      ' times the median, so a small number of very long-running ' +
                      'records is pulling it up. The median of ' + row.median +
                      'h is the more representative number.'
            });
        }
        if (r.skipped > 0) {
            out.caveats.push({
                severity: 'warn',
                text: r.skipped + ' records were excluded because the end date is ' +
                      'before the start date, which is dirty data rather than a ' +
                      'fast resolution.'
            });
        }
        return out;
    },

    /** The sum of the most populated genuine measure, if there is one. */
    measureTile: function (table, query, budgetMs) {
        var ms = this.meta.measures(table);
        for (var i = 0; i < ms.length && i < 4; i++) {
            if (ms[i].isDuration) continue;
            var p = this.data.numericProfile(table, ms[i].name, query, budgetMs);
            if (!p || p.n < CmdAnalysis.DIST_MIN_N) continue;
            /* A percentage column has already become a gauge; summing it is
               meaningless. */
            if (p.min >= 0 && p.max <= CmdAnalysis.PCT_MAX && p.max > 1) continue;
            if (p.sum === 0) continue;
            return {
                id: 'kpi_sum_' + ms[i].name, kind: 'kpi', span: 1,
                form: 'stat_tile',
                question: 'What does ' + ms[i].label.toLowerCase() + ' total?',
                fieldLabel: 'Total ' + ms[i].label.toLowerCase(),
                field: ms[i].name,
                value: p.sum,
                mean: p.mean,
                median: p.median,
                n: p.n,
                reason: 'summed over ' + p.n + ' records where the field is set',
                capped: !!p.capped
            };
        }
        return null;
    },

    /* ══════════════════════════════════════════════════════════════════════
       Time by category
       ══════════════════════════════════════════════════════════════════════ */

    /**
     * One series per category over time.
     *
     * The group count picks the form, and this is the clearest case in the product
     * of shape choosing form rather than a template being applied: two to five
     * categories separate as lines, six to eight are unreadable as lines but read
     * well as share-over-time, and beyond that the only honest option is a grid of
     * small panels each with its own baseline.
     */
    trendByGroup: function (table, query, dateField, dim, grain, buckets, budgetMs) {
        var r = this.data.seriesByGroup(table, dateField, dim.name, grain,
                                        buckets || 12, query, budgetMs);
        if (!r || !r.series.length) return null;

        /* Empty-keyed groups are not a category. A series of records with no value
           set is noise on a trend and it is always the flattest line on the chart. */
        var series = [];
        var i, dropped = 0;
        for (i = 0; i < r.series.length; i++) {
            if (r.series[i].key === '') { dropped += r.series[i].total; continue; }
            series.push(r.series[i]);
        }
        if (series.length < 2) return null;

        var occupied = this._occupiedBuckets(series, r.periods.length);
        if (occupied < 4) return null;

        var kept, other = null, form, reason;
        if (series.length <= CmdAnalysis.LINE_MAX) {
            kept = series;
            form = 'line_multi';
            reason = series.length + ' categories, few enough that separate lines ' +
                     'stay legible and each keeps its own baseline';
        } else if (series.length <= CmdAnalysis.STREAM_MAX) {
            kept = series;
            form = 'stream';
            reason = series.length + ' categories, too many to separate as lines, ' +
                     'so the question becomes how the share moved rather than how ' +
                     'each count moved';
        } else {
            kept = series.slice(0, CmdAnalysis.FACET_MAX);
            other = this._foldSeries(series.slice(CmdAnalysis.FACET_MAX),
                                     r.periods.length);
            form = 'small_multiples';
            reason = series.length + ' categories: one panel each, sharing a scale, ' +
                     'because a single plot with this many series is unreadable ' +
                     'whichever way it is drawn';
        }

        var out = {
            id: 'trend_by_' + dim.name,
            kind: 'trend_group',
            form: form,
            question: 'How has ' + dim.label.toLowerCase() + ' moved over time?',
            reason: reason,
            field: dim.name, fieldLabel: dim.label,
            dateField: dateField, grain: grain,
            periods: r.periods,
            series: kept,
            other: other,
            span: 2,
            caveats: []
        };

        if (dropped > 0) {
            out.caveats.push({
                severity: 'info',
                text: dropped + ' records have no ' + dim.label.toLowerCase() +
                      ' set and are not drawn, because a series of blanks is not a ' +
                      'category.'
            });
        }
        if (r.capped) {
            out.caveats.push({
                severity: 'warn',
                text: 'The permission-checked scan stopped early, so these counts ' +
                      'are a lower bound rather than a total.'
            });
        }
        if (r.outside > 0) {
            out.caveats.push({
                severity: 'info',
                text: r.outside + ' records fall outside the window shown.'
            });
        }
        return out;
    },

    /**
     * Rank movement between the ends of the window: who overtook whom.
     *
     * Slope for a straight two-period comparison, bump when there are enough
     * periods that the path between the ends is itself the story.
     */
    rankShift: function (table, query, dateField, dim, grain, buckets, budgetMs) {
        var r = this.data.seriesByGroup(table, dateField, dim.name, grain,
                                        buckets || 12, query, budgetMs);
        if (!r || r.series.length < 3) return null;

        var series = [], i;
        for (i = 0; i < r.series.length; i++) {
            if (r.series[i].key !== '') series.push(r.series[i]);
        }
        if (series.length < 3) return null;
        series = series.slice(0, 8);

        /* Closed buckets only. The current period is partial, so ranking on it
           would report a change caused by the calendar rather than by the data. */
        var closed = [];
        for (i = 0; i < r.periods.length; i++) {
            if (!r.periods[i].partial) closed.push(i);
        }
        if (closed.length < 2) return null;

        var half = Math.floor(closed.length / 2);
        var firstHalf = closed.slice(0, half);
        var lastHalf = closed.slice(half);

        var rows = [];
        for (i = 0; i < series.length; i++) {
            rows.push({
                key: series[i].key,
                label: series[i].label,
                from: this._sumAt(series[i].counts, firstHalf),
                to: this._sumAt(series[i].counts, lastHalf)
            });
        }
        /* A comparison where nothing moved is not worth a panel. */
        var moved = false;
        var byFrom = rows.slice().sort(function (a, b) { return b.from - a.from; });
        var byTo = rows.slice().sort(function (a, b) { return b.to - a.to; });
        for (i = 0; i < rows.length; i++) {
            if (byFrom[i].key !== byTo[i].key) { moved = true; break; }
        }
        if (!moved) return null;

        for (i = 0; i < byFrom.length; i++) byFrom[i].rankFrom = i + 1;
        for (i = 0; i < byTo.length; i++) byTo[i].rankTo = i + 1;

        var out = {
            id: 'rank_' + dim.name,
            kind: 'rank',
            form: 'slope',
            question: 'Which ' + dim.label.toLowerCase() + ' values overtook which?',
            reason: 'ranked over the first and second halves of the closed window, ' +
                    'so the comparison is between two equal spans and neither end ' +
                    'is a partial period',
            field: dim.name, fieldLabel: dim.label,
            fromLabel: r.periods[firstHalf[0]].label + ' to ' +
                       r.periods[firstHalf[firstHalf.length - 1]].label,
            toLabel: r.periods[lastHalf[0]].label + ' to ' +
                     r.periods[lastHalf[lastHalf.length - 1]].label,
            rows: rows,
            span: 1,
            caveats: []
        };

        /* With enough closed periods the path between the endpoints is itself the
         * story, and a slope chart throws it away: two categories can finish in the
         * same order having crossed twice in between. Where the periods exist to
         * show that, rank every one of them and draw the whole path.
         *
         * Only where a crossing actually happened, though. A bump chart of lines
         * that never touch is a slope chart with redundant ink. */
        if (closed.length >= 4) {
            var path = [], p, ranked;
            for (p = 0; p < closed.length; p++) {
                ranked = series.slice().sort(function (a, b) {
                    return (b.counts[closed[p]] || 0) - (a.counts[closed[p]] || 0);
                });
                var at = {};
                for (i = 0; i < ranked.length; i++) at[ranked[i].key] = i + 1;
                path.push({ label: r.periods[closed[p]].label, rank: at });
            }

            var crossed = false;
            for (p = 1; p < path.length && !crossed; p++) {
                for (i = 0; i < series.length; i++) {
                    if (path[p].rank[series[i].key] !== path[p - 1].rank[series[i].key]) {
                        crossed = true; break;
                    }
                }
            }

            if (crossed) {
                out.form = 'bump';
                out.reason = 'rank position at every complete period, because these ' +
                             'categories change places during the window and only ' +
                             'the endpoints would hide that';
                out.path = path;
                out.keys = [];
                for (i = 0; i < series.length; i++) {
                    out.keys.push({ key: series[i].key, label: series[i].label });
                }
                out.span = 2;
            }
        }

        return out;
    },

    /**
     * What actually drove the change between two periods.
     *
     * This is the panel that answers "why is the number different", which is the
     * question a KPI tile provokes and cannot itself answer. Contributions sum to
     * the total change by construction, so the bars reconcile the two ends.
     */
    changeBreakdown: function (table, query, dateField, dim, grain, budgetMs) {
        var r = this.data.seriesByGroup(table, dateField, dim.name, grain, 2,
                                        query, budgetMs);
        if (!r || r.periods.length < 2) return null;

        /* Both periods must be closed for the comparison to be fair. With a window
           of two the second is the current, partial one, so this asks for three and
           uses the two that are complete. */
        var r3 = this.data.seriesByGroup(table, dateField, dim.name, grain, 3,
                                         query, budgetMs);
        if (!r3 || r3.periods.length < 3) return null;
        var iPrev = 0, iCur = 1;
        if (r3.periods[2] && !r3.periods[2].partial) { iPrev = 1; iCur = 2; }

        var steps = [], startTotal = 0, endTotal = 0, i;
        for (i = 0; i < r3.series.length; i++) {
            var s = r3.series[i];
            if (s.key === '') continue;
            var a = s.counts[iPrev] || 0, b = s.counts[iCur] || 0;
            startTotal += a; endTotal += b;
            if (a === b) continue;
            steps.push({ key: s.key, label: s.label, delta: b - a, from: a, to: b });
        }
        if (steps.length < 2) return null;

        steps.sort(function (x, y) { return Math.abs(y.delta) - Math.abs(x.delta); });
        /* Keep the movers that matter and fold the rest, so the bars still
           reconcile the two totals exactly. */
        var keep = steps.slice(0, 8), restDelta = 0;
        for (i = 8; i < steps.length; i++) restDelta += steps[i].delta;
        if (restDelta !== 0) {
            keep.push({ key: '__rest__', label: 'Other (' + (steps.length - 8) + ')',
                        delta: restDelta, isOther: true });
        }
        keep.sort(function (x, y) { return y.delta - x.delta; });

        return {
            id: 'change_' + dim.name,
            kind: 'change',
            form: 'waterfall',
            question: 'What moved the total between ' + r3.periods[iPrev].label +
                      ' and ' + r3.periods[iCur].label + '?',
            reason: 'each bar is the contribution of one ' + dim.label.toLowerCase() +
                    ' value to the change, so the steps reconcile the two totals ' +
                    'exactly rather than approximately',
            field: dim.name, fieldLabel: dim.label,
            startLabel: r3.periods[iPrev].label, endLabel: r3.periods[iCur].label,
            start: startTotal, end: endTotal,
            steps: keep,
            span: 2,
            caveats: []
        };
    },

    /* ══════════════════════════════════════════════════════════════════════
       Two dimensions at once
       ══════════════════════════════════════════════════════════════════════ */

    /**
     * Two dimensions crossed. A heatmap where the grid is small enough to read
     * every cell, and nothing at all where it is not.
     */
    crossHeat: function (table, query, dimA, dimB, budgetMs) {
        var x = this.data.crossTab(table, dimA.name, dimB.name, query, budgetMs);
        if (!x || !x.grid.length) return null;

        var rows = x.rowKeys.length, cols = x.colKeys.length;
        if (rows < 2 || cols < 2) return null;
        if (rows > CmdAnalysis.HEAT_MAX_ROWS || cols > CmdAnalysis.HEAT_MAX_COLS) {
            return null;
        }
        if (x.grand === 0) return null;

        /* A grid where one cell holds nearly everything is a fact, not a heatmap;
           every other cell would render at the same near-zero step. */
        if (x.maxCell / x.grand > 0.9) return null;

        return {
            id: 'heat_' + dimA.name + '_' + dimB.name,
            kind: 'cross',
            form: 'heatmap',
            question: 'Where do ' + dimA.label.toLowerCase() + ' and ' +
                      dimB.label.toLowerCase() + ' concentrate together?',
            reason: 'a ' + rows + ' by ' + cols + ' grid, small enough that every ' +
                    'cell is readable, so brightness carries the count',
            rowField: dimA.name, rowFieldLabel: dimA.label,
            colField: dimB.name, colFieldLabel: dimB.label,
            rowKeys: x.rowKeys, colKeys: x.colKeys,
            rowLabels: x.rowLabels, colLabels: x.colLabels,
            rowTotals: x.rowTotals, colTotals: x.colTotals,
            grid: x.grid, maxCell: x.maxCell, grand: x.grand,
            span: 2,
            caveats: x.capped ? [{ severity: 'warn',
                text: 'The permission-checked scan stopped early, so these cells ' +
                      'are lower bounds.' }] : []
        };
    },

    /**
     * The report matrix. Power BI's most-used artifact and the one thing a
     * dashboard cannot substitute for: dense, hierarchical, printable, and read
     * for ten minutes rather than glanced at.
     *
     * Five devices are doing work per row — count, share, in-row bar, trend
     * sparkline, and period variance — and each is derived, not decorative.
     */
    reportMatrix: function (table, query, dim, dateField, grain, buckets, budgetMs) {
        var prof = this.data.profile(table, dim.name, query);
        if (!prof || prof.distinctNonEmpty < 2) return null;

        var series = null;
        if (dateField) {
            series = this.data.seriesByGroup(table, dateField, dim.name, grain || 'month',
                                             buckets || 12, query, budgetMs);
        }

        var byKey = {};
        if (series) {
            for (var s = 0; s < series.series.length; s++) {
                byKey[series.series[s].key] = series.series[s];
            }
        }

        var rows = [], i, total = prof.total;
        for (i = 0; i < prof.rows.length && i < 20; i++) {
            var p = prof.rows[i];
            var line = {
                key: p.key,
                label: p.key === '' ? '(not set)' : (p.label || p.key),
                count: p.count,
                share: total > 0 ? Math.round((p.count / total) * 1000) / 1000 : 0,
                spark: null, delta: null, change: null
            };
            var sg = byKey[p.key];
            if (sg && sg.counts) {
                line.spark = sg.counts;
                /* Variance against the previous closed period, not against the
                   current partial one, for the same reason the KPI tile projects. */
                var closed = [];
                for (var c = 0; c < series.periods.length; c++) {
                    if (!series.periods[c].partial) closed.push(c);
                }
                if (closed.length >= 2) {
                    var last = sg.counts[closed[closed.length - 1]] || 0;
                    var prev = sg.counts[closed[closed.length - 2]] || 0;
                    line.delta = last - prev;
                    line.change = prev > 0 ? Math.round(((last - prev) / prev) * 1000) / 1000
                                           : null;
                }
            }
            rows.push(line);
        }
        if (!rows.length) return null;

        return {
            id: 'matrix_' + dim.name,
            kind: 'matrix',
            form: 'matrix',
            question: dim.label + ', in full',
            reason: 'the dense read: every value with its share, its shape over ' +
                    'time and its movement against the last complete period',
            field: dim.name, fieldLabel: dim.label,
            rows: rows,
            total: total,
            periods: series ? series.periods : null,
            grain: grain || 'month',
            span: 2,
            caveats: []
        };
    },

    /* ══════════════════════════════════════════════════════════════════════
       Cycles
       ══════════════════════════════════════════════════════════════════════ */

    /** Day of week against hour of day. A cycle, so it gets a grid and not a line. */
    weekCycle: function (table, query, dateField, budgetMs) {
        var r = this.data.hourOfWeek(table, dateField, query, budgetMs);
        if (!r || r.total < CmdAnalysis.DIST_MIN_N) return null;
        /* If every record lands in one hour the field is a timestamp of a batch
           job, not a record of when work happened. */
        if (r.maxCell / r.total > 0.5) return null;

        return {
            id: 'cycle_' + dateField,
            kind: 'cycle',
            form: 'heatmap',
            question: 'When in the week does this happen?',
            reason: 'a repeating cycle rather than a trend, so the honest form is a ' +
                    'grid of day against hour, not a line',
            dateField: dateField,
            grid: r.grid, maxCell: r.maxCell, total: r.total,
            rowLabels: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
            span: 2,
            caveats: [{
                severity: 'info',
                /* Stated rather than quietly assumed. The platform stores UTC and
                   this reads the stored value, which is what keeps the scan cheap;
                   a viewer in another timezone is looking at a shifted cycle and
                   deserves to know before concluding anything about business hours. */
                text: 'Hours are UTC as stored on the record, not your local time.'
            }]
        };
    },

    /** Counts per calendar day, as a calendar grid. */
    calendar: function (table, query, dateField, days, budgetMs) {
        days = days || 182;
        var r = this.data.dayGrid(table, dateField, query, days, budgetMs);
        if (!r || r.total < CmdAnalysis.DIST_MIN_N) return null;

        var keys = [], k;
        for (k in r.byDay) { if (r.byDay.hasOwnProperty(k)) keys.push(k); }
        if (keys.length < 20) return null;
        keys.sort();

        /* Only the window ending today; older records exist but a calendar of six
           years is a wall of grey. */
        var end = keys[keys.length - 1];
        return {
            id: 'cal_' + dateField,
            kind: 'calendar',
            form: 'calendar_heatmap',
            question: 'Which days were busy?',
            reason: keys.length + ' days with records, drawn as a calendar so ' +
                    'weekends, gaps and spikes are visible as position rather than ' +
                    'as a dip in a line',
            dateField: dateField,
            byDay: r.byDay, maxCell: r.maxCell, total: r.total,
            endDay: end, days: days,
            span: 2,
            caveats: r.capped ? [{ severity: 'warn',
                text: 'The scan stopped early, so quieter days may be undercounted.' }] : []
        };
    },

    /* ══════════════════════════════════════════════════════════════════════
       Numeric distributions
       ══════════════════════════════════════════════════════════════════════ */

    /**
     * The distribution of one numeric column, binned over the observations.
     *
     * Note this bins values, not group-by rows. The previous histogram binned the
     * distinct values returned by a group-by, so a column where one value occurs
     * ten thousand times and another twice drew two equal-looking bars. That is not
     * a histogram, it is a bar chart of a value list.
     */
    distribution: function (table, query, measure, budgetMs) {
        var p = this.data.numericProfile(table, measure.name, query, budgetMs);
        if (!p || p.n < CmdAnalysis.DIST_MIN_N) return null;
        if (!p.bins || !p.bins.bins.length || p.bins.degenerate) return null;

        var out = {
            id: 'dist_' + measure.name,
            kind: 'distribution',
            form: 'histogram',
            question: 'How is ' + measure.label.toLowerCase() + ' distributed?',
            reason: p.bins.k + ' equal-width bins over ' + p.n + ' values, sized by ' +
                    'the interquartile range rather than by a fixed count',
            field: measure.name, fieldLabel: measure.label,
            bins: p.bins.bins, lo: p.bins.lo, hi: p.bins.hi,
            n: p.n, mean: p.mean, median: p.median,
            q1: p.q1, q3: p.q3,
            span: 1,
            caveats: []
        };
        if (p.median !== 0 && Math.abs(p.mean / p.median) > 1.5) {
            out.caveats.push({
                severity: 'info',
                text: 'The distribution is skewed: mean ' + p.mean + ' against ' +
                      'median ' + p.median + '. The median is the more ' +
                      'representative single number.'
            });
        }
        if (p.outlierCount > 0) {
            out.caveats.push({
                severity: 'info',
                text: p.outlierCount + ' values sit beyond 1.5 times the ' +
                      'interquartile range, so the axis is wider than the bulk of ' +
                      'the data.'
            });
        }
        return out;
    },

    /**
     * The same numeric column, split by a category, as box plots. This is the form
     * that shows a difference in spread rather than a difference in average, which
     * a bar chart of means cannot do at all.
     */
    spreadByGroup: function (table, query, measure, dim, budgetMs) {
        var r = this.data.measureByGroup(table, measure.name, dim.name, query, budgetMs);
        if (!r || !r.rows.length) return null;

        var rows = [], i;
        for (i = 0; i < r.rows.length; i++) {
            if (r.rows[i].key === '') continue;
            if (r.rows[i].n < CmdAnalysis.BOX_MIN_PER_GROUP) continue;
            rows.push(r.rows[i]);
            if (rows.length >= CmdAnalysis.BOX_MAX_GROUPS) break;
        }
        if (rows.length < 2) return null;

        /* Boxes that are all the same say nothing a single number would not. */
        var spread = false;
        for (i = 1; i < rows.length; i++) {
            if (rows[i].median !== rows[0].median || rows[i].q3 !== rows[0].q3) {
                spread = true; break;
            }
        }
        if (!spread) return null;

        return {
            id: 'box_' + measure.name + '_' + dim.name,
            kind: 'spread',
            form: 'box',
            question: 'How does ' + measure.label.toLowerCase() + ' vary within each ' +
                      dim.label.toLowerCase() + '?',
            reason: 'quartiles per group, so a difference in spread is visible and ' +
                    'not just a difference in average, which is all a bar of means ' +
                    'can show',
            field: measure.name, fieldLabel: measure.label,
            groupField: dim.name, groupFieldLabel: dim.label,
            rows: rows,
            span: 2,
            caveats: r.truncatedValues ? [{ severity: 'warn',
                text: 'Quartiles are computed from the first ' + CmdData.VALUE_CAP +
                      ' values read, not from every record.' }] : []
        };
    },

    /**
     * Two measures against each other. The only form here that can show a
     * relationship rather than a breakdown.
     */
    relationship: function (table, query, mx, my, dim, budgetMs) {
        var r = this.data.pairSample(table, mx.name, my.name,
                                     dim ? dim.name : null, query, budgetMs);
        if (!r || r.points.length < CmdAnalysis.SCATTER_MIN_N) return null;

        /* A scatter of a column against itself, or against a copy, is a diagonal
           line and a waste of a panel. */
        if (r.corr !== null && Math.abs(r.corr) > 0.999) return null;

        /* Every point identical on either axis is a strip, not a scatter. */
        var i, x0 = r.points[0].x, y0 = r.points[0].y, varX = false, varY = false;
        for (i = 1; i < r.points.length; i++) {
            if (r.points[i].x !== x0) varX = true;
            if (r.points[i].y !== y0) varY = true;
            if (varX && varY) break;
        }
        if (!varX || !varY) return null;

        var strength = (r.corr === null) ? 'no measurable'
            : Math.abs(r.corr) > 0.7 ? 'a strong'
            : Math.abs(r.corr) > 0.4 ? 'a moderate'
            : Math.abs(r.corr) > 0.2 ? 'a weak'
            : 'effectively no';

        return {
            id: 'scatter_' + mx.name + '_' + my.name,
            kind: 'relationship',
            form: 'scatter',
            question: 'Does ' + my.label.toLowerCase() + ' move with ' +
                      mx.label.toLowerCase() + '?',
            reason: r.points.length + ' records plotted, showing ' + strength +
                    ' relationship' +
                    (r.corr === null ? '' : ' (r = ' + r.corr + ')'),
            xField: mx.name, xFieldLabel: mx.label,
            yField: my.name, yFieldLabel: my.label,
            groupField: dim ? dim.name : null,
            groupFieldLabel: dim ? dim.label : null,
            points: r.points, corr: r.corr,
            span: 1,
            caveats: r.dropped > 0 ? [{ severity: 'info',
                text: r.dropped + ' further records are not plotted, because past ' +
                      CmdData.PAIR_CAP + ' points the marks overlap into a solid ' +
                      'mass and the payload stops being worth its size.' }] : []
        };
    },

    /* ══════════════════════════════════════════════════════════════════════
       Concentration and sequence
       ══════════════════════════════════════════════════════════════════════ */

    /**
     * Pareto: ranked bars with the cumulative share as a line, offered only where
     * the mass genuinely is concentrated. An 80/20 chart of a flat distribution is
     * a chart arguing against its own premise.
     */
    pareto: function (table, query, dim) {
        var prof = this.data.profile(table, dim.name, query);
        if (!prof || prof.distinctNonEmpty < CmdAnalysis.PARETO_MIN_GROUPS) return null;
        if (prof.concentration < CmdAnalysis.PARETO_MIN_CONCENTRATION) return null;

        var rows = [], i, total = 0;
        for (i = 0; i < prof.rows.length; i++) {
            if (prof.rows[i].key === '') continue;
            rows.push({ key: prof.rows[i].key, label: prof.rows[i].label,
                        count: prof.rows[i].count });
            total += prof.rows[i].count;
        }
        if (rows.length < CmdAnalysis.PARETO_MIN_GROUPS || total === 0) return null;

        rows = rows.slice(0, 12);
        var acc = 0, shown = 0;
        for (i = 0; i < rows.length; i++) {
            acc += rows[i].count;
            rows[i].cumulative = Math.round((acc / total) * 1000) / 1000;
            if (rows[i].cumulative <= 0.8) shown = i + 1;
        }

        return {
            id: 'pareto_' + dim.name,
            kind: 'pareto',
            form: 'pareto',
            question: 'How few ' + dim.label.toLowerCase() + ' values account for ' +
                      'most of the volume?',
            reason: (shown + 1) + ' of ' + prof.distinctNonEmpty + ' values cover ' +
                    '80% of records, which is what makes the ranked view worth ' +
                    'drawing with a cumulative line rather than as plain bars',
            field: dim.name, fieldLabel: dim.label,
            rows: rows, total: total, eightyAt: shown + 1,
            span: 2,
            caveats: []
        };
    },

    /**
     * A funnel, and only for a field that is genuinely a sequence.
     *
     * The test is monotonic decline across the declared choice order. A set of
     * states that does not shed volume stage by stage is a distribution, and
     * drawing it as a funnel asserts a progression that the data does not contain.
     * This is the single most common abuse of the form, so the gate is strict and
     * the reason is reported.
     */
    funnel: function (table, query, dim) {
        if (!dim.isOrdinal) return null;
        var prof = this.data.profile(table, dim.name, query);
        if (!prof) return null;

        var choices = this.meta.choices(table, dim.name);
        if (!choices || choices.length < CmdAnalysis.FUNNEL_MIN_STAGES) return null;
        if (choices.length > CmdAnalysis.FUNNEL_MAX_STAGES) return null;

        var byKey = {}, i;
        for (i = 0; i < prof.rows.length; i++) byKey[prof.rows[i].key] = prof.rows[i];

        var stages = [];
        for (i = 0; i < choices.length; i++) {
            var c = choices[i];
            var row = byKey[String(c.value)];
            stages.push({ key: String(c.value), label: c.label,
                          count: row ? row.count : 0 });
        }

        /* Trailing empty stages are not a funnel narrowing to nothing, they are
           states nobody uses. Trim them before testing the shape. */
        while (stages.length && stages[stages.length - 1].count === 0) stages.pop();
        if (stages.length < CmdAnalysis.FUNNEL_MIN_STAGES) return null;
        if (stages[0].count === 0) return null;

        for (i = 1; i < stages.length; i++) {
            if (stages[i].count > stages[i - 1].count) return null;
        }

        for (i = 0; i < stages.length; i++) {
            stages[i].share = stages[0].count > 0
                ? Math.round((stages[i].count / stages[0].count) * 1000) / 1000 : 0;
            stages[i].stepShare = (i === 0 || stages[i - 1].count === 0) ? 1
                : Math.round((stages[i].count / stages[i - 1].count) * 1000) / 1000;
        }

        return {
            id: 'funnel_' + dim.name,
            kind: 'funnel',
            form: 'funnel',
            question: 'Where does volume drop out across ' + dim.label.toLowerCase() + '?',
            reason: 'the declared order of this field sheds volume at every stage, ' +
                    'so it is a sequence and not just a set of states',
            field: dim.name, fieldLabel: dim.label,
            stages: stages,
            span: 1,
            caveats: []
        };
    },

    /* ══════════════════════════════════════════════════════════════════════
       Annotation on the trend
       ══════════════════════════════════════════════════════════════════════ */

    /**
     * A least-squares trend, a forecast with a confidence band, and anomaly
     * markers, computed on the closed buckets of an existing series.
     *
     * Deliberately simple and deliberately labelled. Ordinary least squares on the
     * bucket index with a band at two residual standard deviations is not a
     * forecasting model, and the panel says so. The alternative — shipping nothing
     * — leaves the client's most-requested analytic affordance absent; the wrong
     * alternative would be shipping this and calling it a prediction.
     */
    annotate: function (points) {
        if (!points || points.length < CmdAnalysis.FORECAST_MIN_POINTS) return null;

        var closed = [], i;
        for (i = 0; i < points.length; i++) {
            if (!points[i].partial) closed.push({ i: i, y: points[i].count });
        }
        if (closed.length < CmdAnalysis.FORECAST_MIN_POINTS) return null;

        var n = closed.length, sx = 0, sy = 0;
        for (i = 0; i < n; i++) { sx += closed[i].i; sy += closed[i].y; }
        var mx = sx / n, my = sy / n;
        var num = 0, den = 0;
        for (i = 0; i < n; i++) {
            var dx = closed[i].i - mx;
            num += dx * (closed[i].y - my);
            den += dx * dx;
        }
        if (den === 0) return null;
        var slope = num / den;
        var intercept = my - slope * mx;

        var ss = 0;
        for (i = 0; i < n; i++) {
            var fit = slope * closed[i].i + intercept;
            var e = closed[i].y - fit;
            ss += e * e;
        }
        var sigma = Math.sqrt(ss / Math.max(1, n - 2));

        var anomalies = [];
        for (i = 0; i < n; i++) {
            var f2 = slope * closed[i].i + intercept;
            var resid = closed[i].y - f2;
            if (sigma > 0 && Math.abs(resid) > CmdAnalysis.ANOMALY_SIGMA * sigma) {
                anomalies.push({ index: closed[i].i, value: closed[i].y,
                                 expected: Math.round(f2),
                                 sigma: Math.round((resid / sigma) * 10) / 10 });
            }
        }

        var forecast = [];
        var lastIdx = points.length - 1;
        for (i = 1; i <= CmdAnalysis.FORECAST_AHEAD; i++) {
            var xi = lastIdx + i;
            var yi = slope * xi + intercept;
            /* The band widens with distance, which is the honest shape: the
               uncertainty of a projection three periods out is not the uncertainty
               of one period out. */
            var widen = sigma * CmdAnalysis.ANOMALY_SIGMA * Math.sqrt(1 + i / n);
            forecast.push({
                index: xi,
                value: Math.max(0, Math.round(yi)),
                lo: Math.max(0, Math.round(yi - widen)),
                hi: Math.max(0, Math.round(yi + widen))
            });
        }

        return {
            slope: Math.round(slope * 100) / 100,
            intercept: Math.round(intercept * 100) / 100,
            sigma: Math.round(sigma * 100) / 100,
            direction: slope > 0 ? 'rising' : slope < 0 ? 'falling' : 'flat',
            perPeriod: Math.round(slope * 10) / 10,
            anomalies: anomalies,
            forecast: forecast,
            fitFrom: { index: closed[0].i,
                       value: Math.round(slope * closed[0].i + intercept) },
            fitTo: { index: closed[n - 1].i,
                     value: Math.round(slope * closed[n - 1].i + intercept) },
            method: 'least squares on ' + n + ' complete periods, band at ' +
                    CmdAnalysis.ANOMALY_SIGMA + ' residual standard deviations'
        };
    },

    /* ── internals ── */

    /**
     * The best-populated pair of date fields to measure elapsed time between.
     * Ordered by measured spread rather than by name, so this works on a change
     * request, an audit engagement and a project without knowing anything about
     * any of them.
     */
    _durationPair: function (table, query, budgetMs) {
        var dates = this.meta.dates(table);
        if (dates.length < 2) return null;

        var usable = [], i;
        for (i = 0; i < dates.length && i < 6; i++) {
            var sp = this.data.dateSpread(table, dates[i].name, query);
            if (sp.nonEmpty < CmdAnalysis.DIST_MIN_N) continue;
            usable.push({ f: dates[i], min: sp.min, max: sp.max, n: sp.nonEmpty });
        }
        if (usable.length < 2) return null;

        /* Start before end, decided by the measured earliest value rather than by
           which column is called "opened". */
        usable.sort(function (a, b) { return a.min < b.min ? -1 : a.min > b.min ? 1 : 0; });
        var start = usable[0], end = null;
        for (i = usable.length - 1; i > 0; i--) {
            if (usable[i].max > start.min) { end = usable[i]; break; }
        }
        if (!end || end.f.name === start.f.name) return null;
        return { start: start.f, end: end.f };
    },

    _occupiedBuckets: function (series, nPeriods) {
        var occupied = 0;
        for (var b = 0; b < nPeriods; b++) {
            for (var s = 0; s < series.length; s++) {
                if (series[s].counts[b] > 0) { occupied++; break; }
            }
        }
        return occupied;
    },

    _foldSeries: function (rest, nPeriods) {
        if (!rest.length) return null;
        var counts = [], i, s;
        for (i = 0; i < nPeriods; i++) counts.push(0);
        for (s = 0; s < rest.length; s++) {
            for (i = 0; i < nPeriods; i++) counts[i] += (rest[s].counts[i] || 0);
        }
        var total = 0;
        for (i = 0; i < nPeriods; i++) total += counts[i];
        return { key: '__other__', label: 'Other (' + rest.length + ')',
                 counts: counts, total: total, isOther: true };
    },

    _sumAt: function (counts, idxs) {
        var t = 0;
        for (var i = 0; i < idxs.length; i++) t += (counts[idxs[i]] || 0);
        return t;
    },

    type: 'CmdAnalysis'
};
