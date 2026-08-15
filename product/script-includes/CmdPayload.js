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
CmdPayload.MAX_PANELS = 4;

/* Rich analysis panels per page, on top of the single-dimension breakdowns.
 *
 * Five is a page you read; ten is a page you scroll past. The builders are ordered
 * by what they add, so a cap here drops the least useful rather than a random tail,
 * and what was dropped is reported. */
CmdPayload.MAX_ANALYSIS = 6;

/* How wide the shared page scan guesses.
 *
 * These bound the number of accumulators the single pass carries, not the number
 * of panels drawn. An accumulator that goes unused costs a few field reads per
 * row, which is immeasurable beside the ACL evaluation that admitted the row, so
 * the asymmetry strongly favours guessing wide: being wrong costs microseconds,
 * being narrow costs a whole extra scan of the table. */
CmdPayload.SCAN_DIMS = 8;
CmdPayload.SCAN_LEADS = 3;
CmdPayload.SCAN_MEASURES = 4;

/* Budget for the shared page scan.
 *
 * It gets its own allowance rather than "whatever is left of the page budget",
 * which is what it had first and which starved everything after it: the scan
 * spent the entire budget, and the KPI row and half the panels were then skipped
 * as over-budget even though their data was by then already computed and free.
 * Bounding the one expensive thing, and letting the cheap assembly that follows
 * run regardless, is the correct shape. */
CmdPayload.SCAN_MS = 3200;

/* The share the largest real value must hold before a wide dimension is drawn.
 *
 * Only applied past the bar limit, where a chart is already showing a head and a
 * folded tail. Below this the head is not a head: cmdb_ci_computer.asset spreads
 * 1,383 records over about 200 values whose largest holds 22, which draws as one
 * "(none)" tile beside an "Other (176)" block and answers nothing. */
CmdPayload.MIN_TOP_SHARE = 0.04;

/* Ordinal fields tried when looking for a workflow to draw as a funnel, and for a
   grouping whose spread differs enough to draw as a box. Each attempt is a
   memoised profile plus a cheap test, so this is bounded work rather than a scan
   per try. */
CmdPayload.FUNNEL_TRIES = 6;

/* How many ordinal dimensions the box-plot builder may try before giving up, and
   therefore how many the lead scan must plan for. One constant so the plan and
   the builder cannot disagree; when they did, each unanticipated try became its
   own full rescan of the table. */
CmdPayload.SPREAD_TRIES = 6;

/* Candidate dimensions examined to fill those panels. Higher gives better panels
   and costs more; each rejected candidate still costs its profile. */
CmdPayload.MAX_CANDIDATES = 14;

/* Date fields tried when looking for one with usable spread. Each costs `buckets`
   bounded counts, so this is the trade between finding a good trend and paying to
   look for one. */
CmdPayload.DATE_CANDIDATES = 5;

/* Buckets of the window that must be occupied for a trend to be drawn at all. A
   single bar beside nine empty slots reads as an outage, not as a distribution.
 *
 * Scaled to the window by occupiedFloor(), not applied flat. As a flat five it was
 * unsatisfiable the moment the window slicer offered three months: a three-bucket
 * window can never have five occupied buckets, so every short view came back with
 * no trend, no backlog and no rank comparison, and nothing said why. The bug was
 * invisible while twelve months was the only window there was. */
CmdPayload.MIN_OCCUPIED_BUCKETS = 5;

/* The occupancy a window of this length must reach. Three fifths of the buckets,
   never fewer than two, never more than the flat floor above. */
CmdPayload.occupiedFloor = function (buckets) {
    return Math.min(CmdPayload.MIN_OCCUPIED_BUCKETS,
                    Math.max(2, Math.ceil(buckets * 0.6)));
};

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
        /* Shares the same CmdData, so every reduction the analysis panels run is
           memoised alongside the profiles the dimension panels already computed and
           the ACL verdict established once for the request. Handing it a fresh
           CmdData instead would double the cost of every page. */
        this.analysis = new CmdAnalysis(this.data, this.meta, this.form);
        this._dateField = {};
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

        /* There is deliberately no table-level canRead() gate here. It was one,
           and it was wrong: canRead() evaluates the read ACLs with no record in
           context, so a condition or script referencing `current` fails it for a
           viewer who can still read a real subset of the rows. Live on dev390988 a
           role-less persona holds 815 readable incidents and 669 readable
           knowledge articles, and this line reported "You do not have read access
           to this table" to them for both. Access is decided below by
           data.aclVerdict, which reaches its answer from a permission-checked
           scan rather than from a context-free ACL evaluation. */

        /* The path arrives from a URL parameter and is cut to its longest safe
           prefix before anything downstream sees it -- an unvalidated field name
           or a key containing '^' reaches stepQuery as an arbitrary query clause
           otherwise. See CmdDrill.sanitizePath. Everything below this line, and
           _pathOut's breadcrumbs, use the sanitized path, never the raw one. */
        path = this.drill.sanitizePath(table, path);

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
            /* Distinguish the two zeroes. "Nothing matches" and "nothing here is
               yours to see" look identical in a count and are entirely different
               facts to put in front of a viewer, and only the verdict knows which
               one this is. */
            payload.notes.push(verdict.denied
                ? ('This subject holds ' + verdict.aggregate + ' records and your ' +
                   'permissions do not admit any of them, so there is nothing to show.')
                : 'No records match this filter for you.');
            payload.timingMs = new Date().getTime() - t0;
            return payload;
        }

        /* ── the series. A dashboard over a task-like table without a trend is
              missing the one question every leader asks first. ── */
        var dateField = this._pickDateField(table, query, opts);

        /* ── one scan for the whole page ──
         *
         * Declared before any panel is built, so every reduction this page could
         * want is satisfied by a single pass over the rows. What this replaces was
         * four or more independent passes over the identical rows -- the ACL proof,
         * the trend, the profiles, the matrix -- each paying the full per-row ACL
         * cost again.
         *
         * On a table with expensive ACLs that is the difference between a usable
         * page and an unusable one, but the correctness argument matters more than
         * the speed one. Those independent scans were each time-boxed separately
         * and so each stopped at a different row, which meant a single page could
         * show a trend computed over 420 rows beside a breakdown computed over 880.
         * Both were individually correct and individually labelled, and their totals
         * did not agree. One scan means one row set: when it is truncated, the whole
         * page is truncated together and says so once. */
        this._planScan(table, query, dateField, opts);

        var series = this._seriesPanel(table, query, total, opts);
        if (series) {
            /* The analytics pane, in the one place it belongs. A trend without a
               fitted line is a picture; with one it is a claim about direction that
               the reader can check. The method is stated on the panel so nobody
               mistakes least squares over twelve points for a forecasting model. */
            series.annotation = this.analysis.annotate(series.points);
            payload.panels.push(series);
        }

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

        /* One scan for all the candidate profiles, where that is the cheaper route.
         *
         * On a table whose ACL verdict is not trusted, each profile below is its own
         * permission-checked scan over the same rows. Measured on `task`, six
         * candidates cost 7,408ms that way. Admitting a row once and reading six
         * values off it is the same work as admitting it once to read one, so this
         * pre-computes them together and the loop then finds them memoised.
         *
         * It is a no-op on a trusted table, where the fast path already makes each
         * profile cost about 12ms and a batched secure scan would be strictly worse. */
        var warm = [];
        for (i = 0; i < dims.length && i < CmdPayload.MAX_CANDIDATES; i++) {
            if (!this._contains(used, dims[i].name)) warm.push(dims[i].name);
        }
        this.data.warmProfiles(table, warm.slice(0, 8), query, CmdData.GROUP_MS);
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
        var dimPanels = this._diversify(candidates, CmdPayload.MAX_PANELS);

        /* ── the analysis grid ──
         *
         * Everything above answers "how does one field break down". This is the part
         * that answers the questions a leader actually asks next: how did that move,
         * what drove the change, where do two things coincide, how much does it vary,
         * does one thing track another.
         *
         * Built as a list of thunks rather than a sequence of calls so the budget can
         * govern it. Each builder costs at most one bounded reduction, each returns
         * null rather than a degenerate chart, and the page takes them in order of
         * how much they add until either the panel cap or the clock stops it. What
         * was skipped is reported, never silently dropped.
         */
        /* Built regardless of the clock, because after the shared scan its inputs
           are memoised and it is close to free. Gating it on the page deadline was
           costing exactly the wrong thing: on cmdb_ci the scan finished, every
           number the KPI row needed was already computed, and the row was dropped
           anyway for being over budget. */
        payload.kpis = this.analysis.kpiRow(table, query, total, dateField,
                                            CmdData.GROUP_MS);

        /* From here on the expensive work is done and everything left reads
           memoised results, so the deadline that governs it starts now. Measuring
           it from the top of the request charged the shared scan's cost against
           every cheap step that followed and skipped them for no gain. */
        var tAssembly = new Date().getTime();

        var lead = this._leadDims(candidates, dims, used);

        /* The second declared scan, now that the lead dimension is known. */
        this._planLeadScan(table, query, dateField, lead,
                           this.analysis.rankMeasures(table, query, CmdData.GROUP_MS),
                           opts, used);

        payload.panels = payload.panels.concat(
            this._analysisGrid(table, query, dateField, lead, opts, tAssembly,
                               payload, used));

        payload.panels = payload.panels.concat(dimPanels);

        /* ── the report matrix ──
         *
         * The artifact that separates a report from a dashboard, and the thing the
         * client's own tool gives them that a chart grid does not: dense,
         * hierarchical, printable, read for ten minutes rather than glanced at.
         * Always last, because it is the detail you drop to after the charts have
         * told you where to look.
         */
        /* Part of the floor, not of the optional work.
         *
         * It was budget-gated like the analysis panels, and the consequence was that
         * `incident` -- the largest and most-looked-at subject on the instance -- was
         * the one page that never got a matrix, because it is the page most likely to
         * be over budget by the time the matrix is reached. The panels a page drops
         * under load should be the marginal ones, and this is the opposite of
         * marginal: it is the dense, printable read that a grid of charts cannot
         * substitute for, and the specific artifact the client's existing tool gives
         * them.
         *
         * Affordable as a floor item because its inputs are largely already paid
         * for: the profile is memoised from the dimension pass and the sparkline
         * series is one bounded reduction that the trend panel has usually already
         * run for the same field and window. */
        payload.matrix = null;
        if (lead.primary) {
            payload.matrix = this.analysis.reportMatrix(
                table, query, lead.primary, dateField,
                opts.grain || 'month', opts.months || 12, CmdData.GROUP_MS);
        }

        /* ── drill options for the slice we are looking at ── */
        if (payload.drill.atMax) {
            payload.notes.push(
                'Maximum drill depth reached. Open the record list to go further.');
        } else if (this._overBudget(tAssembly)) {
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

        /* What the page spent on rows, and what it therefore could not draw. A
           dashboard that quietly shows less under load is the failure this whole
           budget mechanism exists to prevent, so the shortfall is stated. */
        payload.scan = this.data.scanBudget();
        if (payload.scan.starved > 0) {
            payload.notes.push(
                'This subject is expensive to permission-check, so the page stopped ' +
                'reading rows after ' + Math.round(payload.scan.spentMs / 100) / 10 +
                's. ' + payload.scan.starved + ' further measurement' +
                (payload.scan.starved === 1 ? ' was' : 's were') + ' not attempted, ' +
                'and the panels shown are built from the rows that were read.');
        }

        payload.timingMs = new Date().getTime() - t0;
        return payload;
    },

    /**
     * Declares every reduction this page might need, and runs them in one pass.
     *
     * The list is deliberately generous. An accumulator that turns out not to be
     * used costs a few field reads per row, which is immeasurable next to the ACL
     * evaluation that admitted the row in the first place -- so guessing wide and
     * discarding is far cheaper than guessing narrow and re-scanning. That asymmetry
     * is the whole reason this works.
     *
     * The one thing it cannot know in advance is which dimension will turn out to be
     * the page's lead, since that depends on profiles this scan is computing. So it
     * asks for the time-series and crosstab reductions against the top few candidates
     * by metadata rank, and the lead is chosen from those afterwards. Being wrong
     * costs an unused accumulator; being narrow would cost a second scan.
     */
    _planScan: function (table, query, dateField, opts) {
        var v = this.data.aclVerdict(table, query);
        if (v.denied) return;

        var grain = opts.grain || 'month';
        var months = opts.months || 12;
        var sp = this.data.specs;
        var plan = [], i;

        var dims = this.meta.dimensions(table);
        var usable = [];
        for (i = 0; i < dims.length && usable.length < CmdPayload.SCAN_DIMS; i++) {
            usable.push(dims[i]);
        }

        /* Every candidate breakdown. These produce the profiles, and the profiles
           are what decide the page's lead dimension.
         *
         * Only when the row scan is the cheaper way to get them, which is when the
         * verdict is not trusted. A grouped count is the one thing the database
         * does better than any scan: on a trusted table the same eight breakdowns
         * are eight indexed GlideAggregate queries at roughly 12ms each, against
         * eight accumulators riding a 4,266 row pass. Planning them here regardless
         * of the verdict meant the common case, an unfiltered viewer, paid scan
         * prices for an answer an index already had.
         *
         * Correctness is unaffected either way: the fast path is only reachable
         * when aclVerdict has proved this viewer may read every row of this query,
         * which is the same proof tieredGroupBy relies on. */
        if (!v.trusted) {
            for (i = 0; i < usable.length; i++) plan.push(sp.group(usable[i].name));
        }

        /* The trend, the week cycle and the calendar all read the same column. */
        if (dateField) {
            plan.push(sp.series(dateField, null, grain, months));
            plan.push(sp.dow(dateField));
            plan.push(sp.day(dateField, 182));
        }

        /* Numeric columns, for the ranking that decides which are worth a chart. */
        var ms = this.meta.measures(table), added = 0;
        for (i = 0; i < ms.length && added < CmdPayload.SCAN_MEASURES; i++) {
            if (ms[i].isDuration) continue;
            plan.push(sp.numeric(ms[i].name));
            added++;
        }

        /* Elapsed time, and the open backlog, both over the same pair of dates. */
        var pair = this.analysis._durationPair(table, query, CmdData.GROUP_MS);
        if (pair) {
            plan.push(sp.duration(pair.start.name, pair.end.name, null));
            plan.push(sp.stock(pair.start.name, pair.end.name, grain, months));
        }

        this.data.planScan(table, query, plan, CmdPayload.SCAN_MS);
    },

    /**
     * The second scan: the reductions that depend on which dimension leads.
     *
     * Two scans rather than one, for a reason that cannot be engineered away. Half
     * the panels are keyed on a lead dimension, and the lead is chosen from the
     * profiles, which the first scan is what produces. You cannot know what to
     * measure about the lead until you know what the lead is.
     *
     * Guessing the lead from metadata rank instead was tried and is worse. It
     * misses often enough that each missed builder opened its own unplanned scan,
     * which is unbounded in number and invisible in the timings -- the failure mode
     * this whole mechanism exists to remove. Two declared, bounded scans is the
     * honest shape of the problem.
     */
    /**
     * Ordinal dimensions not already spent on the drill path, best first.
     *
     * Extracted so the scan plan and the panel builders walk the identical list.
     * When they disagreed, every field the builders tried and the plan had not
     * anticipated opened its own full rescan of the table, which is the exact cost
     * the two-scan design exists to prevent.
     */
    _ordinalDims: function (table, used) {
        var out = [], all = this.meta.dimensions(table);
        for (var i = 0; i < all.length; i++) {
            if (all[i].isOrdinal && !this._contains(used, all[i].name)) out.push(all[i]);
        }
        return out;
    },

    _planLeadScan: function (table, query, dateField, lead, measures, opts, used) {
        if (!lead || !lead.primary) return;
        if (this.data.aclVerdict(table, query).denied) return;

        var grain = opts.grain || 'month';
        var months = opts.months || 12;
        var sp = this.data.specs;
        var plan = [], i;

        if (dateField) {
            plan.push(sp.series(dateField, lead.primary.name, grain, months));
            /* Three buckets, for the change breakdown's two complete periods. */
            plan.push(sp.series(dateField, lead.primary.name, grain, 3));
            if (lead.wide) plan.push(sp.series(dateField, lead.wide.name, grain, months));
        }
        if (lead.secondary) {
            plan.push(sp.cross(lead.primary.name, lead.secondary.name));
        }
        for (i = 0; i < measures.length && i < 2; i++) {
            plan.push(sp.measure(measures[i].name, lead.primary.name));
            if (lead.ordinals.length) {
                plan.push(sp.measure(measures[i].name, lead.ordinals[0].name));
            }
        }

        /* The box-plot builder asks for the leading measure split by each ordinal
           dimension in turn, taking the first that shows a real difference in
           spread, and most of them decline. Every one of those tries is a
           reduction, and until they were planned here each was an unplanned full
           rescan of the table.
         *
         * Measured on `change_request`, admin, before this: nine `measure`
         * reductions over the same 1,505 rows, eight of them unplanned, costing
         * 4.5s of a 7.9s page. The tries are capped and the cap is shared with the
         * builder through SPREAD_TRIES, so the plan and the builder cannot drift
         * apart again -- that drift is what made the cost invisible. */
        if (measures.length) {
            var ordinals = this._ordinalDims(table, used || []);
            for (i = 0; i < ordinals.length && i < CmdPayload.SPREAD_TRIES; i++) {
                plan.push(sp.measure(measures[0].name, ordinals[i].name));
            }
        }
        if (measures.length >= 2) {
            plan.push(sp.pair(measures[0].name, measures[1].name, lead.primary.name));
        }

        if (plan.length) this.data.planScan(table, query, plan, CmdPayload.SCAN_MS);
    },

    /* ── the analysis grid ──────────────────────────────────────────────── */

    /**
     * The dimensions the rich panels crossed, split and ranked by.
     *
     * Reuses the profiles the dimension pass already paid for, so choosing these
     * costs nothing. `primary` is the most informative field on the subject, which
     * is the one worth putting a trend, a matrix and a breakdown behind; `secondary`
     * is the best field that is not it, for the one panel that needs two.
     *
     * Deliberately taken from the same scored candidate list the visible panels come
     * from, rather than picked independently. A page whose heatmap crosses two
     * fields that appear nowhere else reads as two unrelated dashboards stapled
     * together.
     */
    _leadDims: function (candidates, dims, used) {
        var out = { primary: null, secondary: null, ordinal: null,
                    concentrated: null, wide: null, ordinals: [] };
        if (!candidates.length) return out;

        var scored = candidates.slice();
        var self = this;
        scored.sort(function (a, b) {
            return self._informativeness(b) - self._informativeness(a);
        });

        var byName = {}, i;
        for (i = 0; i < dims.length; i++) byName[dims[i].name] = dims[i];

        for (i = 0; i < scored.length; i++) {
            var d = byName[scored[i].field];
            if (!d || this._contains(used, d.name)) continue;
            if (!out.primary) { out.primary = d; continue; }
            if (!out.secondary) { out.secondary = d; }
            /* Every ordinal candidate, not just the first.
             *
             * A funnel needs a field whose declared order is a workflow, and most
             * tables have several ordinal fields of which only one is. On
             * change_request the first by rank is `priority`, which is a severity
             * scale and sheds nothing, so the funnel builder tested priority,
             * correctly refused, and never reached `state` -- which does form a
             * pipeline and does decline at every stage. The gate was right and the
             * candidate was wrong. */
            if (d.isOrdinal) {
                out.ordinals.push(d);
                if (!out.ordinal) out.ordinal = d;
            }
        }
        if (out.primary && out.primary.isOrdinal) out.ordinals.push(out.primary);
        if (!out.ordinal && out.primary && out.primary.isOrdinal) {
            out.ordinal = out.primary;
        }

        /* The most concentrated dimension, which is the one a Pareto is about. Not
           necessarily the most informative: informativeness deliberately penalises
           concentration, because a chart where one bar is everything says little,
           and a Pareto is the one form for which that shape is the subject. */
        var best = -1;
        for (i = 0; i < scored.length; i++) {
            var c = scored[i];
            if (!c.shape || this._contains(used, c.field)) continue;
            if (c.shape.concentration > best) {
                best = c.shape.concentration;
                out.concentrated = byName[c.field] || null;
            }
        }

        /* The widest usable dimension, which is what small multiples are for.
         *
         * Without this the form was unreachable in practice. A trend by category
         * was only ever offered on `primary`, and `primary` is chosen for being the
         * most informative single breakdown -- which strongly favours a field with
         * a handful of well-populated values, exactly the case that draws as a
         * multi-line. The dimension with eighteen assignment groups, the one that
         * genuinely cannot be separated in a single plot, was never asked.
         *
         * It is a different question rather than a duplicate: primary answers "how
         * did the main categories move", this answers "how did every team move",
         * and the second only makes sense as a grid of small panels sharing a scale. */
        var widest = 0;
        for (i = 0; i < scored.length; i++) {
            var w = scored[i];
            if (!w.shape || this._contains(used, w.field)) continue;
            if (out.primary && w.field === out.primary.name) continue;
            if (w.shape.distinct < CmdAnalysis.FACET_MAX) continue;
            if (w.shape.distinct > widest) {
                widest = w.shape.distinct;
                out.wide = byName[w.field] || null;
            }
        }
        return out;
    },

    /**
     * Builds the rich panels, in value order, until the cap or the clock stops it.
     *
     * Order is a judgement about what a leader wants after the headline: how the
     * breakdown moved, what drove the change, then spread, coincidence and
     * concentration. A builder that returns null costs its reduction and yields
     * nothing, which is the correct outcome when the data does not support the
     * form and is why the order matters more than the count.
     */
    _analysisGrid: function (table, query, dateField, lead, opts, t0, payload, used) {
        var self = this;
        var grain = opts.grain || 'month';
        var months = opts.months || 12;
        var budget = CmdData.GROUP_MS;
        var out = [];

        /* The builder list, ordered by how much passing its gate tells you.
         *
         * Not by how generally useful the form is, which is what it was first
         * ordered by, and which meant the same six kinds of chart opened every
         * page. The rarer builders sat at positions ten to twelve and were never
         * reached on any subject rich enough to have earlier panels -- so a change
         * pipeline that genuinely forms a funnel never showed one.
         *
         * The rule now: a panel whose gate is strict is worth more when it passes.
         * A funnel only draws where a declared sequence really sheds volume at
         * every stage; a scatter only where two measures really vary together; a
         * box only where the spread really differs between groups. Those are
         * findings. A crosstab or a calendar draws almost anywhere there is a date,
         * so it says correspondingly less by appearing.
         *
         * The three questions a leader asks first still lead, because ordering by
         * rarity alone would bury the trend under a novelty.
         */
        var builders = [];

        /* ── what a leader asks first ── */
        if (dateField && lead.primary) {
            builders.push({ name: 'trend by ' + lead.primary.label, fn: function () {
                return self.analysis.trendByGroup(table, query, dateField,
                    lead.primary, grain, months, budget);
            }});
        }
        builders.push({ name: 'backlog', fn: function () {
            return self.analysis.backlog(table, query, grain, months, budget);
        }});
        if (dateField && lead.primary) {
            builders.push({ name: 'change breakdown', fn: function () {
                return self.analysis.changeBreakdown(table, query, dateField,
                    lead.primary, grain, budget);
            }});
        }

        /* ── strict gates: rare, and therefore informative when they pass ── */
        /* Funnel candidates come from the schema, not from the panel candidates.
         *
         * "Is this field a good breakdown" and "is this field a workflow" are
         * different questions, and ranking for the first was silently answering the
         * second. On change_request the candidate list is capped at fourteen
         * dimensions interleaved by kind, and `state` -- the only field on the table
         * that is actually a pipeline -- ranks below escalation, impact and
         * priority and never made the list. The funnel builder was being handed
         * three severity scales, correctly refusing all three, and never seeing the
         * one field that forms a sequence.
         *
         * Asking every ordinal field is affordable because the gate is cheap and
         * strict: it is one memoised profile and a monotonic-decline test, and
         * almost every field fails it immediately. */
        var ordinalFields = this._ordinalDims(table, used);
        if (ordinalFields.length) {
            builders.push({ name: 'funnel', fn: function () {
                /* First ordinal field whose declared order actually sheds volume.
                   Most will not, and that is the point of asking each of them. */
                for (var q = 0; q < ordinalFields.length &&
                                 q < CmdPayload.FUNNEL_TRIES; q++) {
                    var f = self.analysis.funnel(table, query, ordinalFields[q]);
                    if (f) return f;
                }
                return null;
            }});
        }

        var measures = this.analysis.rankMeasures(table, query, budget);

        if (measures.length >= 2) {
            builders.push({ name: 'relationship', fn: function () {
                return self.analysis.relationship(table, query, measures[0],
                    measures[1], lead.primary, budget);
            }});
        }
        if (measures.length && lead.primary) {
            builders.push({ name: 'spread by group', fn: function () {
                /* Try the ordinal dimensions before the lead.
                 *
                 * A box plot earns its place by showing a difference in SPREAD, and
                 * spread differences follow severity far more often than they
                 * follow subject: reassignment counts vary with priority, not with
                 * whether the ticket is about email or a laptop. Offering only the
                 * lead dimension meant the panel was measured against the field
                 * least likely to separate, refused, and the one that would have
                 * worked was never asked. */
                var tries = ordinalFields.slice(0, CmdPayload.SPREAD_TRIES)
                                        .concat([lead.primary]), q;
                for (q = 0; q < tries.length; q++) {
                    var b = self.analysis.spreadByGroup(table, query,
                        measures[0], tries[q], budget);
                    if (b) return b;
                }
                return null;
            }});
        }
        if (dateField && lead.primary) {
            builders.push({ name: 'rank shift', fn: function () {
                return self.analysis.rankShift(table, query, dateField,
                    lead.primary, grain, months, budget);
            }});
        }
        if (lead.concentrated) {
            builders.push({ name: 'pareto', fn: function () {
                return self.analysis.pareto(table, query, lead.concentrated);
            }});
        }
        if (dateField && lead.wide) {
            builders.push({ name: 'small multiples by ' + lead.wide.label, fn: function () {
                return self.analysis.trendByGroup(table, query, dateField,
                    lead.wide, grain, months, budget);
            }});
        }

        /* ── loose gates: draw almost anywhere, so they fill what is left ── */
        if (lead.primary && lead.secondary) {
            builders.push({ name: 'crosstab', fn: function () {
                return self.analysis.crossHeat(table, query, lead.primary,
                    lead.secondary, budget);
            }});
        }
        if (measures.length) {
            builders.push({ name: 'distribution', fn: function () {
                return self.analysis.distribution(table, query, measures[0], budget);
            }});
        }
        if (dateField) {
            builders.push({ name: 'week cycle', fn: function () {
                return self.analysis.weekCycle(table, query, dateField, budget);
            }});
            builders.push({ name: 'calendar', fn: function () {
                return self.analysis.calendar(table, query, dateField, 182, budget);
            }});
        }

        /* Build everything the budget allows, then choose across the results for a
         * spread of forms.
         *
         * Taking the first N builders that succeed was wrong in the same way that
         * taking the top N dimensions was wrong, and it produced the same symptom
         * the client named: a page that looks like every other page. The builder
         * list is ordered by usefulness, so the first six winners were always the
         * same six kinds of chart, and the rarer forms -- the funnel, the box plot,
         * the rank path -- sat at positions ten to twelve and were never reached on
         * any subject that had earlier panels available.
         *
         * Building all of them is affordable now in a way it was not before: after
         * the shared scan their inputs are memoised, so a builder that gets
         * discarded costs the arithmetic and not another pass over the table.
         */
        var built = [], skipped = 0, i;
        for (i = 0; i < builders.length; i++) {
            if (this._overBudget(t0)) { skipped++; continue; }
            var p = null;
            try {
                p = builders[i].fn();
            } catch (e) {
                /* One failing builder must not take the page with it. The panel is
                   dropped and the fault is surfaced as a note rather than a stack
                   trace in place of a dashboard. */
                payload.notes.push('The ' + builders[i].name + ' panel could not be ' +
                    'built: ' + (e.message || e));
            }
            if (p) { p._rank = i; built.push(p); }
        }

        /* One of each form first, in builder order, then fill the remaining slots by
           usefulness. A second heatmap is worth less than a first funnel. */
        var seenForm = {}, j;
        for (j = 0; j < built.length && out.length < CmdPayload.MAX_ANALYSIS; j++) {
            if (seenForm[built[j].form]) continue;
            seenForm[built[j].form] = true;
            out.push(built[j]);
        }
        for (j = 0; j < built.length && out.length < CmdPayload.MAX_ANALYSIS; j++) {
            if (this._contains(out, built[j])) continue;
            out.push(built[j]);
        }
        out.sort(function (a, b) { return a._rank - b._rank; });

        var dropped = built.length - out.length;
        if (dropped > 0) {
            payload.notes.push(dropped + ' further analysis panel' +
                (dropped === 1 ? '' : 's') + ' could have been drawn but would have ' +
                'repeated a form already on this page.');
        }
        if (skipped > 0) {
            payload.notes.push(skipped + ' analysis panel' +
                (skipped === 1 ? ' was' : 's were') + ' not attempted, to keep this ' +
                'page inside its time budget. This table is expensive to ' +
                'permission-check.');
        }
        return out;
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
    /**
     * The date field a page draws its time from, chosen once and reused.
     *
     * Extracted from _seriesPanel because five things now need the same answer —
     * the trend, the KPI comparison, the week cycle, the calendar and the matrix's
     * sparkline column — and each of them independently re-deciding it would both
     * cost five times as much and risk a page where the trend is drawn on one
     * column and the variance beside it on another.
     */
    _pickDateField: function (table, query, opts) {
        if (opts && opts.dateField) return opts.dateField;

        var ck = table + '|' + (query || '');
        if (this._dateField && this._dateField[ck] !== undefined) {
            return this._dateField[ck];
        }
        if (!this._dateField) this._dateField = {};

        var dates = this.meta.dates(table);
        var buckets = (opts && opts.months) || 12;
        var field = null, bestSpan = 0, i;

        /* One MIN/MAX query per candidate decides which field to draw, and only
           the winner pays for its buckets. Bucketing every candidate to count
           occupancy was sixty queries and measurably slower than the problem it
           solved. */
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
        if (bestSpan < CmdPayload.occupiedFloor(buckets)) field = null;

        this._dateField[ck] = field;
        return field;
    },

    _seriesPanel: function (table, query, total, opts) {
        var dates = this.meta.dates(table);
        if (!dates.length) return null;

        var grain = opts.grain || 'month';
        var buckets = opts.months || 12;

        var field = this._pickDateField(table, query, opts);
        var pts = null;
        var i;

        if (!field) return null;

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
        if (occupied < CmdPayload.occupiedFloor(pts.length)) return null;

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

        /* The blank bucket must not be the biggest thing on the chart.
         *
         * A 5% fill floor is not enough on a wide, sparse reference column. Measured
         * on cmdb_ci_computer.asset: 1,383 records spread over ~200 values so thinly
         * that the largest single value held 22 records while "(none)" held more, and
         * the treemap drawn from it led with a "(none)" tile and folded almost
         * everything else into Other. It passed every existing gate -- well over 5%
         * populated, far more than two distinct values -- and said nothing at all.
         *
         * If the most common answer to "what is this field" is "nobody filled it in",
         * that is a data-quality observation and not a breakdown, and it does not
         * earn a panel. */
        var biggest = prof.rows.length ? prof.rows[0] : null;
        if (biggest && biggest.key === '') return null;

        /* Nor may the chart be almost entirely tail. A field whose largest real value
           holds a couple of percent has no shape to show at this size; every mark
           lands at the same near-zero width and the reader learns only that the
           column is diffuse. */
        if (prof.distinctNonEmpty > CmdForm.T.BAR_MAX &&
            prof.topShare < CmdPayload.MIN_TOP_SHARE) {
            return null;
        }

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
