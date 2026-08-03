/**
 * CmdPayload. Assembles a dashboard.
 *
 * One call produces everything a page needs, computed server side and embedded in
 * the response. That shape is not a preference, it is forced: measured on this
 * instance, an XHR from a logged-in browser session to a Scripted REST endpoint
 * never returns, and the platform's own Table API behaves the same way from the
 * same context. So there is one round trip and no fetch waterfall, which is
 * incidentally the best thing that could happen to first paint.
 *
 * The cost of that shape is drilldown, which by nature wants data on demand. The
 * answer here is that a drill step is a navigation: the drill path travels in the
 * URL and the server rebuilds the payload for the new slice. It is a full page
 * load rather than a partial update, which is how the platform's own reporting has
 * always worked, and it makes the drill state shareable and reversible for free.
 * Whether a UXF component can fetch incrementally instead is the open question the
 * phase 1 spike answers.
 *
 * Every number in here has been through CmdData, so every number carries an ACL
 * mode. Nothing reaches a viewer without a verdict attached.
 *
 * ES5 only. Rhino.
 */
var CmdPayload = Class.create();

CmdPayload.VERSION = 1;

/* Panels per dashboard. Each one costs a grouped query, and the point of
   diminishing returns is well before the point where the page stops fitting on a
   screen. Six plus the header and the series is a dense, readable page. */
CmdPayload.MAX_PANELS = 6;

/* Candidate dimensions examined to fill those panels. Higher gives better panels
   and costs more; each rejected candidate still costs its profile. */
CmdPayload.MAX_CANDIDATES = 14;

/* Date fields tried when looking for one with usable spread. Each costs `buckets`
   bounded counts, so this is the trade between finding a good trend and paying to
   look for one. */
CmdPayload.DATE_CANDIDATES = 5;

/* Buckets of the window that must be occupied for a trend to be drawn at all. A
   single bar beside nine empty slots reads as an outage, not as a distribution. */
CmdPayload.MIN_OCCUPIED_BUCKETS = 5;

/* Wall-clock budget for building a whole page.
 *
 * Every individual query here is already bounded, and that turned out not to be
 * enough: bounding each of fourteen drill-gate profiles at 1.2s still permits a
 * seventeen-second page. Measured on kb_knowledge and task, both of which carry
 * expensive read ACLs, pages ran to 28s with every single query inside its own
 * limit.
 *
 * So the page gets a deadline of its own. Panels and drill gates are optional work,
 * added while there is budget and skipped when there is not, and what was skipped is
 * reported in `notes` rather than silently dropped. The header, the total and the
 * ACL verdict are not optional and always run. */
CmdPayload.BUDGET_MS = 6000;

/* Panels that are built regardless of the budget.
 *
 * A pure deadline produced a worse failure than the one it fixed: on kb_knowledge
 * the permission proof plus one grouped query consumed the budget and the page came
 * back with zero panels. An empty dashboard is not a faster dashboard, it is a
 * broken one. So a floor of panels is always attempted and the deadline governs
 * everything after it. */
CmdPayload.MIN_PANELS = 3;

/* Candidates the page will attempt past its deadline, chasing that floor.
 *
 * The floor cannot be expressed as "three successful panels", which is what it was
 * first written as. On kb_knowledge most candidates are rejected for having a single
 * distinct value, so the loop kept paying 1.25s per rejected candidate while the
 * success count stayed at zero: thirteen attempts, 18.7 seconds, every individual
 * query inside its own limit. Bounding attempts rather than successes makes the
 * worst case arithmetic instead of data-dependent. */
CmdPayload.MAX_ATTEMPTS_PAST_DEADLINE = 5;

CmdPayload.prototype = {

    initialize: function () {
        /* One CmdData for the whole request, so the ACL verdict is established
           once and the profiles are computed once. Handing the same instance to
           CmdDrill is what keeps a page at 1.6s instead of 60s. */
        this.data = new CmdData();
        this.meta = new CmdMeta();
        this.form = new CmdForm();
        this.drill = new CmdDrill(this.data, this.meta);
    },

    /**
     * @param table  the subject
     * @param path   drill path, array of {field, key, label}
     * @param opts   {grain, dateField, months}
     */
    dashboard: function (table, path, opts) {
        var t0 = new Date().getTime();
        path = path || [];
        opts = opts || {};

        var d = this.meta.describe(table);
        if (!d.exists) return this._error(table, 'That table does not exist on this instance.');
        if (!d.canRead) return this._error(table, 'You do not have read access to this table.');

        /* The drill path becomes the query. Built through CmdDrill so the empty
           slice is expressed as ISEMPTY rather than an equality against '', which
           is what makes the "(none)" bar clickable. */
        var query = '';
        var used = [];
        var i;
        for (i = 0; i < path.length && i < CmdDrill.MAX_DEPTH; i++) {
            query = this.drill.stepQuery(query, path[i].field, path[i].key);
            used.push(path[i].field);
        }

        var total = this.data.total(table, query);
        var verdict = this.data.aclVerdict(table, query);

        var payload = {
            version: CmdPayload.VERSION,
            generated: new GlideDateTime().getDisplayValue(),
            viewer: {
                name: gs.getUserName(),
                display: gs.getUserDisplayName()
            },
            subject: {
                table: table,
                label: d.label,
                query: query,
                rows: total.count,
                listUrl: this.drill.listUrl(table, query)
            },
            acl: {
                mode: total.mode,
                aggregate: verdict.aggregate,
                secure: verdict.secure,
                delta: verdict.delta,
                capped: verdict.capped
            },
            path: this._pathOut(table, path),
            panels: [],
            drill: { atMax: this.drill.atMaxDepth(path), options: [] },
            notes: []
        };

        if (total.count === 0) {
            payload.notes.push('No records match this filter for you.');
            payload.timingMs = new Date().getTime() - t0;
            return payload;
        }

        /* ── the series. A dashboard over a task-like table without a trend is
              missing the one question every leader asks first. ── */
        var series = this._seriesPanel(table, query, total, opts);
        if (series) payload.panels.push(series);

        /* ── dimension panels, selected for variety of question ──
         *
         * Two passes, and the second one is the point. Taking the top N candidates
         * by rank produced a page of six identical charts, because the ranking puts
         * every ordinal choice field first and a table like `incident` has six of
         * them: escalation, impact, incident state, priority, severity, hold reason.
         * All correct individually, and collectively the exact failure the client
         * named when they said a fixed chart set for every subject is what was
         * wrong with the last build.
         *
         * So build every candidate, then choose across them for a spread of forms.
         * A dashboard should answer different kinds of question, not the same kind
         * six times. */
        var candidates = [];
        var dims = this.meta.dimensions(table);
        var examined = 0;
        for (i = 0; i < dims.length && i < CmdPayload.MAX_CANDIDATES; i++) {
            if (this._contains(used, dims[i].name)) continue;
            /* The floor is attempted whatever the clock says; the deadline only
               governs work beyond it. */
            if (this._overBudget(t0) &&
                (candidates.length >= CmdPayload.MIN_PANELS ||
                 examined >= CmdPayload.MAX_ATTEMPTS_PAST_DEADLINE)) break;
            examined++;
            var cand = this._dimPanel(table, query, dims[i], total);
            if (cand) candidates.push(cand);
        }
        if (examined < dims.length && this._overBudget(t0)) {
            payload.notes.push(
                'Stopped after examining ' + examined + ' of ' + dims.length +
                ' fields, to keep this page inside its time budget. This table is ' +
                'expensive to permission-check.');
        }
        payload.panels = payload.panels.concat(
            this._diversify(candidates, CmdPayload.MAX_PANELS));

        /* ── drill options for the slice we are looking at ── */
        if (payload.drill.atMax) {
            payload.notes.push(
                'Maximum drill depth reached. Open the record list to go further.');
        } else if (this._overBudget(t0)) {
            payload.notes.push('Drill options were not computed, to keep this page ' +
                               'inside its time budget.');
        } else {
            payload.drill.options = this.drill.candidates(table, query, used, 6);
        }

        /* ── the declared-hierarchy comparison. This is the product's argument,
              rendered: what the schema claims against what the data supports. ── */
        payload.declared = this._overBudget(t0)
            ? []
            : this.drill.declaredPath(table, query);

        payload.timingMs = new Date().getTime() - t0;
        return payload;
    },

    /* ── panels ─────────────────────────────────────────────────────────── */

    /**
     * Picks the date field with the best measured spread, then draws it.
     *
     * The first version took the highest-ranked date field by name, preferring
     * `opened_at` then `sys_created_on`. On seeded tables that is right. On eleven
     * of seventeen real subjects it was badly wrong, because out-of-the-box demo
     * rows were all created when the instance was provisioned: `sys_created_on` has
     * one to three months of spread and the trend renders as a spike with nine
     * empty buckets. A viewer reads that as a data outage.
     *
     * The fix is the same principle as everything else here. Do not choose a field
     * by its name, measure the candidates and choose the one the data supports. A
     * table whose creation dates are bunched usually has another date that is not:
     * an install date, a discovery date, a due date. And where no date field has
     * spread, there is no trend to draw and the panel is dropped rather than faked.
     */
    _seriesPanel: function (table, query, total, opts) {
        var dates = this.meta.dates(table);
        if (!dates.length) return null;

        var grain = opts.grain || 'month';
        var buckets = opts.months || 12;

        var field = opts.dateField || null;
        var pts = null;
        var i;

        if (!field) {
            /* One MIN/MAX query per candidate decides which field to draw, and only
               the winner pays for its buckets. Bucketing every candidate to count
               occupancy was sixty queries and measurably slower than the problem it
               solved. */
            var bestSpan = 0;
            for (i = 0; i < dates.length && i < CmdPayload.DATE_CANDIDATES; i++) {
                var sp = this.data.dateSpread(table, dates[i].name, query);
                if (sp.nonEmpty === 0) continue;
                /* The newest value has to be inside the window, or the trend is
                   drawn entirely in the past and every bucket is empty. */
                if (sp.monthsSinceMax >= buckets) continue;
                /* Capped at the window: a field spanning eight years is not better
                   than one spanning twelve months when the window is twelve months.
                   Ties break toward the earlier candidate, which is the better name. */
                var span = Math.min(sp.monthsSpanned, buckets);
                if (span > bestSpan) { bestSpan = span; field = dates[i].name; }
                if (bestSpan >= buckets) break;
            }
            if (bestSpan < CmdPayload.MIN_OCCUPIED_BUCKETS) return null;
        }

        pts = this.data.periodSeries(table, field, grain, buckets, query);

        if (!field || !pts) return null;

        var sum = 0;
        for (i = 0; i < pts.length; i++) sum += pts[i].count;
        if (sum === 0) return null;

        /* Final occupancy check on the field actually drawn. The spread measurement
           bounds min to max; this catches the case where the data sits at the two
           ends of the window with a hole in the middle. */
        var occupied = 0;
        for (i = 0; i < pts.length; i++) if (pts[i].count > 0) occupied++;
        if (occupied < CmdPayload.MIN_OCCUPIED_BUCKETS) return null;

        var label = field;
        var fm = this.meta.field(table, field);
        if (fm) label = fm.label;

        var decision = this.form.decide({
            field: field, fieldLabel: label, isTime: true, grain: grain,
            dims: 1, distinct: pts.length, n: total.count, seriesCount: 1,
            partialTail: true,
            aggregateTotal: this.data.aclVerdict(table, query).aggregate,
            secureTotal: total.count, capped: total.capped
        });

        return {
            id: 'series',
            kind: 'series',
            question: this._seriesQuestion(label, grain),
            field: field, fieldLabel: label, grain: grain,
            form: decision.form,
            reason: decision.reason,
            caveats: decision.caveats,
            points: pts,
            story: this._story(pts),
            span: 2
        };
    },

    _dimPanel: function (table, query, dim, total) {
        var prof = this.data.profile(table, dim.name, query);

        /* Nothing to show. Not an error and not an empty chart: just not a panel,
           because a panel per unpopulated field is how a dashboard fills up with
           noise. */
        if (prof.total === 0) return null;
        if (prof.distinctNonEmpty < 2) return null;
        if (prof.fill < 0.05) return null;

        var f = this.meta.field(table, dim.name);
        var isChoice = f ? !!f.isChoice : false;
        var isBool = f ? !!f.isBool : false;

        /* Identifier fields are not dimensions, and the shape profile cannot tell
           the difference on its own: a reference number has high cardinality and
           evenly spread mass, which is exactly the signature that argues for a
           treemap. `change_request.effective_number` was drawn as one before this
           check existed. A free-text field whose cardinality is this high is
           labelling rows, not grouping them. */
        /* Numeric fields are excluded from this check on purpose. A currency or
           decimal column has high cardinality by nature and that is not a reason to
           drop it: it is the signature of a distribution, which is what a histogram
           is for. Removing this exclusion silently cost the asset dashboard both of
           its cost histograms. */
        var openText = !isChoice && !isBool && !dim.isRef && !dim.isOrdinal &&
                       !dim.isNumber;
        if (openText && prof.distinctNonEmpty > CmdMeta.TEXT_DIM_MAX_DISTINCT) return null;
        if (this._looksLikeIdentifier(dim.name)) return null;

        var decision = this.form.decide({
            field: dim.name,
            fieldLabel: dim.label,
            fieldType: dim.type,
            dims: 1,
            distinct: prof.distinctNonEmpty,
            n: prof.total,
            filledN: prof.total - prof.empty,
            fillRate: prof.fill,
            topShare: prof.topShare,
            concentration: prof.concentration,
            zeroVariance: prof.zeroVariance,
            isOrdinal: !!dim.isOrdinal,
            isBoolean: isBool,
            isNumeric: !!dim.isNumber && !isChoice,
            /* Part-to-whole only where the values are a closed declared set. An
               open reference field has no meaningful whole to be part of. */
            isPartToWhole: isChoice || isBool,
            aggregateTotal: prof.acl.aggregate,
            secureTotal: prof.acl.secure,
            capped: prof.acl.capped
        });

        if (decision.suppressed) return null;

        return {
            id: 'dim_' + dim.name,
            kind: 'dimension',
            question: this._dimQuestion(dim.label, decision.form),
            field: dim.name,
            fieldLabel: dim.label,
            form: decision.form,
            selectedForm: decision.selected_form,
            demoted: decision.demoted,
            reason: decision.reason,
            caveats: decision.caveats,
            rows: this._rowsOut(prof.rows, decision.form),
            shape: {
                distinct: prof.distinctNonEmpty,
                fill: prof.fill,
                topShare: prof.topShare,
                concentration: prof.concentration
            },
            ordinal: !!dim.isOrdinal,
            span: (decision.form === 'heatmap' || decision.form === 'treemap') ? 2 : 1
        };
    },

    /**
     * Picks `want` panels from the candidates, favouring a spread of forms.
     *
     * Greedy over rounds: each round takes the best remaining candidate for each
     * form not yet used, so the first pass across the page is all distinct forms
     * and only then does a second of any form appear. Capped at two of any one
     * form, because three ranked bars is a table with extra steps.
     *
     * Within a form, "best" is the candidate with the most information in it:
     * well-populated, and not so concentrated that one bar is the whole chart.
     */
    _diversify: function (cands, want) {
        var i;
        for (i = 0; i < cands.length; i++) {
            cands[i]._score = this._informativeness(cands[i]);
        }
        cands.sort(function (a, b) { return b._score - a._score; });

        var out = [], usedForm = {}, taken = {};
        var rounds = 0;
        while (out.length < want && rounds < 3) {
            rounds++;
            for (i = 0; i < cands.length && out.length < want; i++) {
                if (taken[cands[i].id]) continue;
                var f = cands[i].form;
                var seen = usedForm[f] || 0;
                if (seen >= rounds) continue;      /* round 1 allows 1, round 2 allows 2 */
                if (seen >= 2) continue;           /* never more than two of a form */
                usedForm[f] = seen + 1;
                taken[cands[i].id] = true;
                out.push(cands[i]);
            }
        }
        for (i = 0; i < out.length; i++) delete out[i]._score;
        return out;
    },

    /**
     * How much a panel actually tells you, 0 to 1.
     *
     * Rewards being populated, penalises a single dominant value, and mildly
     * prefers a middling number of categories: two values is a ratio rather than a
     * distribution, and forty is a list. This decides which of two candidates for
     * the same form earns the slot; it never decides the form.
     */
    _informativeness: function (panel) {
        var s = panel.shape;
        var score = s.fill;                                   /* populated matters most */
        score -= Math.max(0, s.topShare - 0.55) * 0.9;         /* one bar is not a chart */
        var d = s.distinct;
        var band = (d >= 3 && d <= 14) ? 0.25 : (d === 2 ? 0.0 : 0.1);
        score += band;
        if (panel.demoted) score -= 0.3;                       /* it could not carry its form */
        for (var i = 0; i < panel.caveats.length; i++) {
            if (panel.caveats[i].severity === 'warn') score -= 0.15;
        }
        return score;
    },

    /**
     * Truncates a long tail into a named Other, and never silently: the renderer
     * gets the count that was folded so the caveat can say how many.
     */
    _rowsOut: function (rows, form) {
        var keep = (form === 'ranked_bar_top_n' || form === 'pareto') ? 12
                 : (form === 'donut' || form === 'semi_donut') ? 6
                 : 24;
        if (rows.length <= keep) return { series: rows, other: null };

        var head = rows.slice(0, keep);
        var restCount = 0, restGroups = 0, i;
        for (i = keep; i < rows.length; i++) { restCount += rows[i].count; restGroups++; }
        return {
            series: head,
            other: { count: restCount, groups: restGroups }
        };
    },

    /* ── narration. Plain arithmetic, no model. ────────────────────────── */

    /**
     * One sentence about the series, derived rather than written.
     *
     * Compares the last three closed buckets against the mean of the ones before
     * them. The open bucket is excluded, because including a partial period is how
     * a dashboard reports a fall that has not happened.
     */
    _story: function (pts) {
        var closed = [];
        for (var i = 0; i < pts.length; i++) {
            if (!pts[i].partial) closed.push(pts[i]);
        }
        if (closed.length < 5) return null;

        var tailN = 3;
        var tail = 0, head = 0, i2;
        for (i2 = closed.length - tailN; i2 < closed.length; i2++) tail += closed[i2].count;
        tail = tail / tailN;
        for (i2 = 0; i2 < closed.length - tailN; i2++) head += closed[i2].count;
        head = head / (closed.length - tailN);

        if (head === 0) return null;
        var change = (tail - head) / head;
        var pct = Math.abs(Math.round(change * 100));
        if (pct < 8) {
            return 'Flat: the last three ' + 'periods are within ' + pct +
                   '% of the earlier average.';
        }
        var dir = change > 0 ? 'above' : 'below';
        return 'The last three periods run ' + pct + '% ' + dir +
               ' the average of the ' + (closed.length - tailN) + ' before them.';
    },

    _seriesQuestion: function (label, grain) {
        var per = grain === 'day' ? 'per day'
                : grain === 'week' ? 'per week'
                : grain === 'quarter' ? 'per quarter' : 'per month';
        return 'Volume by ' + label.toLowerCase() + ', ' + per;
    },

    /* Name-based rejection for the identifier fields whose cardinality alone does
       not give them away, because they are references or choices. */
    _looksLikeIdentifier: function (name) {
        var pats = ['number', '_id', 'correlation', 'guid', 'uuid', 'sys_class',
                    '_key', 'checksum', 'hash', 'token', 'sequence'];
        for (var i = 0; i < pats.length; i++) {
            if (name === pats[i]) return true;
            if (name.length >= pats[i].length &&
                name.substring(name.length - pats[i].length) === pats[i]) return true;
        }
        return false;
    },

    _dimQuestion: function (label, form) {
        if (form === 'histogram') return 'Distribution of ' + label.toLowerCase();
        if (form === 'box') return label.toLowerCase() + ' spread across groups';
        if (form === 'column') return label + ' by value';
        if (form === 'waterfall') return label + ', contribution to the total';
        if (form === 'pareto') return label + ', cumulative share';
        if (form === 'scatter') return label + ' against the measure';
        if (form === 'stacked_proportion') return 'Share by ' + label.toLowerCase();
        if (form === 'stacked_ordinal') return label + ' across the scale';
        if (form === 'donut' || form === 'semi_donut') return label + ' as a share of the whole';
        if (form === 'treemap') return 'Where the volume sits, by ' + label.toLowerCase();
        if (form === 'heatmap') return label + ' cross-tabulated';
        if (form === 'stat_tile') return label;
        return label + ', ranked';
    },

    /* ── helpers ──────────────────────────────────────────────────────── */

    /** Has the page spent its wall-clock budget? Optional work checks this. */
    _overBudget: function (t0) {
        return (new Date().getTime() - t0) > CmdPayload.BUDGET_MS;
    },

    _pathOut: function (table, path) {
        var out = [];
        var q = '';
        for (var i = 0; i < path.length; i++) {
            q = this.drill.stepQuery(q, path[i].field, path[i].key);
            var f = this.meta.field(table, path[i].field);
            out.push({
                field: path[i].field,
                fieldLabel: f ? f.label : path[i].field,
                key: path[i].key,
                label: path[i].label || (path[i].key === '' ? '(empty)' : path[i].key),
                query: q
            });
        }
        return out;
    },

    _error: function (table, message) {
        return {
            version: CmdPayload.VERSION,
            error: message,
            subject: { table: table, label: table, rows: 0 },
            panels: [], path: [], notes: [message],
            drill: { atMax: true, options: [] }
        };
    },

    _contains: function (arr, v) {
        for (var i = 0; i < arr.length; i++) {
            if (arr[i] === v) return true;
        }
        return false;
    },

    type: 'CmdPayload'
};
