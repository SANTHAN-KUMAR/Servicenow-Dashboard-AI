/**
 * CmdReport. Takes the reports that already exist on the instance and redraws
 * them, without changing what they count.
 *
 * This is the answer to the question the client asked twice: will our page show
 * the same data as the report they already have, with no manipulation and no
 * reduction. The honest answer needs three separate things to be true, and this
 * file is built around keeping them apart so that each can be checked.
 *
 *   1. Same subject and same filter. The report's own table and its own saved
 *      filter are executed verbatim. Nothing is re-scoped, sampled, capped or
 *      rewritten. `describe` normalises the filter only by removing the query
 *      builder's own punctuation, and it records every edit it makes.
 *
 *   2. Same count, and proof of it. `parity` runs the report's filter twice --
 *      once the way the platform's own reporting engine counts, which is
 *      GlideAggregate, and once the way this product counts, which is
 *      permission-checked. A viewer who may read everything gets identical
 *      numbers, and that identity is the proof that nothing was reduced. A
 *      viewer who may not gets a smaller number, and the difference is the
 *      rows the native report was showing them that they cannot open.
 *
 *   3. A different drawing. The form is chosen from the measured shape of the
 *      data rather than from `sys_report.type`, which records what somebody
 *      picked from a menu. Both are reported, so the page can say what the
 *      native report drew, what we draw, and why they differ.
 *
 * Point 2 is the one worth being careful about. It is tempting to present the
 * delta as "the native report is wrong", and that overstates it. GlideAggregate
 * is doing what it documents. The claim that holds is narrower and stronger: a
 * count built on it is a count of rows matching a filter, not a count of rows
 * this viewer may read, and on any table with row-level ACLs those are different
 * numbers. Measured on dev390988 against a role-less persona, `incident` reports
 * 4,266 and admits 815.
 *
 * ES5 only. Rhino.
 */
var CmdReport = Class.create();

CmdReport.VERSION = 1;

/* Reports listed in one call. The instance this was built against carries 682,
   and a catalog is a browsing surface rather than an export, so this bounds the
   page rather than the library. `list` reports the true total either way. */
CmdReport.MAX_LIST = 300;

/* Wall-clock budget for the permission-checked half of a parity check. A parity
   check that cannot finish returns a floor and says so, exactly as every other
   bounded count in this product does. */
CmdReport.PARITY_MS = 2500;

/* Reports whose definition we can execute as a breakdown. `list` and `pivot`
   are readable subjects but their native form is a grid rather than a chart, so
   they convert to a subject page rather than to a single panel. Anything else
   is offered as a subject with its filter applied. */
CmdReport.CHART_TYPES = {
    bar: 1, horizontal_bar: 1, vertical_bar: 1, column: 1, pie: 1, donut: 1,
    semi_donut: 1, line: 1, spline: 1, area: 1, trend: 1, funnel: 1,
    single_score: 1, solid_gauge: 1, speedometer: 1, dial: 1, heatmap: 1
};

/* Clauses the query builder writes into `filter` that are punctuation rather
   than filtering. Removing them changes no row; leaving them in breaks the
   encoded query when it is concatenated with a drill step. */
CmdReport.NOISE_CLAUSES = { EQ: 1, RLQUERY: 0 };

CmdReport.prototype = {

    initialize: function (data, meta, form) {
        this.data = data || new CmdData();
        this.meta = meta || this.data.meta();
        this.form = form || new CmdForm();
    },

    /* ══════════════════════════════════════════════════════════════════════
       Reading the definition
       ══════════════════════════════════════════════════════════════════════ */

    /**
     * Normalise one `sys_report` row into something executable.
     *
     * The filter column is not a clean encoded query. It is whatever the report
     * builder wrote, and it mixes three different kinds of thing:
     *
     *   real conditions      active=true^priority=1
     *   grouping and order   ^GROUPBYcategory   ^ORDERBYDESCopened_at
     *   builder punctuation  a trailing ^EQ
     *
     * Only the first kind selects rows. `GROUPBY` is where a surprising number of
     * reports keep their dimension: `field` is empty and the grouping lives in
     * the filter instead, which is why a converter that reads `field` alone finds
     * nothing to draw on a report that clearly draws something. `ORDERBY` is a
     * presentation choice we make ourselves from the measured shape.
     *
     * Every removal is recorded in `edits`, because "we did not change your
     * report" is a claim that should be inspectable rather than asserted.
     */
    describe: function (gr) {
        var d = {
            sysId: gr.getUniqueValue(),
            title: String(gr.getValue('title') || '(untitled)'),
            table: String(gr.getValue('table') || ''),
            nativeType: String(gr.getValue('type') || ''),
            aggregate: String(gr.getValue('aggregate') || 'COUNT').toUpperCase(),
            aggField: String(gr.getValue('aggregation_field') || ''),
            owner: String(gr.getDisplayValue('user') || ''),
            rawFilter: String(gr.getValue('filter') || ''),
            groupField: String(gr.getValue('field') || ''),
            query: '',
            orderBy: '',
            edits: [],
            dynamic: false,
            supported: false,
            reason: ''
        };

        var parts = d.rawFilter ? d.rawFilter.split('^') : [];
        var keep = [], i;

        for (i = 0; i < parts.length; i++) {
            var p = parts[i];
            if (p === '') continue;

            if (p === 'EQ' || p === 'NQEQ') {
                d.edits.push('removed the query builder terminator "' + p + '"');
                continue;
            }
            if (p.indexOf('GROUPBY') === 0) {
                var gf = p.substring(7);
                if (gf && !d.groupField) {
                    d.groupField = gf;
                    d.edits.push('took the grouping from the filter clause "GROUPBY' +
                                 gf + '", where this report keeps it');
                } else {
                    d.edits.push('removed the grouping clause "GROUPBY' + gf + '"');
                }
                continue;
            }
            if (p.indexOf('ORDERBYDESC') === 0) {
                d.orderBy = p.substring(11) + ' desc';
                d.edits.push('removed the sort "' + p + '"; order here follows the data');
                continue;
            }
            if (p.indexOf('ORDERBY') === 0) {
                d.orderBy = p.substring(7);
                d.edits.push('removed the sort "' + p + '"; order here follows the data');
                continue;
            }
            /* TRENDBY is the report's time grouping, and leaving it in the query
               was a live defect worth recording.
             *
             * It selects no rows, but the two engines this product counts with do
             * not agree about it. Measured on dev390988, as admin, on the report
             * "KPI - Number of Incidents by Category", whose filter ends
             * `^GROUPBYcategory^TRENDBYsys_created_on,month`:
             *
             *     GlideAggregate      4,239
             *     GlideRecordSecure      12
             *
             * Same query, same user, and the user was admin, so no ACL filtered
             * anything. The verdict came back FILTERED with a delta of 4,227 and
             * the parity check announced that the viewer could not read 4,227
             * records they could in fact read. A presentation clause had
             * manufactured a permission finding. Anything the platform treats as
             * layout rather than as a condition has to come out here, or the one
             * number this product exists to get right is computed from a query
             * that does not mean what it says. */
            if (p.indexOf('TRENDBY') === 0) {
                d.edits.push('removed the trend grouping "' + p + '", which selects ' +
                             'no rows and is not read consistently by the two count ' +
                             'methods parity compares');
                continue;
            }
            if (p.indexOf('STARTAT') === 0) {
                d.edits.push('removed the paging clause "' + p + '"');
                continue;
            }
            if (p.indexOf('javascript:') > -1 || p.indexOf('DYNAMIC') > -1) {
                /* Kept, deliberately. A filter of `opened_by=javascript:
                   gs.getUserID()` is viewer-relative by design, and evaluating it
                   as the viewer is the correct behaviour, not a leak: it is the
                   platform that resolves it, against the session actually asking. */
                d.dynamic = true;
            }
            keep.push(p);
        }

        d.query = keep.join('^');

        if (!d.table) {
            d.reason = 'the report names no table';
        } else if (!this.meta.describe(d.table).exists) {
            d.reason = 'the table `' + d.table + '` is not on this instance';
        } else {
            d.supported = true;
        }

        d.isChart = !!CmdReport.CHART_TYPES[d.nativeType];
        return d;
    },

    /* ══════════════════════════════════════════════════════════════════════
       Listing
       ══════════════════════════════════════════════════════════════════════ */

    /**
     * The reports this viewer may open.
     *
     * Read through GlideRecordSecure rather than GlideRecord, and that is the
     * whole point: `sys_report` holds private, owner-scoped rows, so the list of
     * reports is itself entitlement-bearing data. A catalog that lists a report
     * the viewer cannot open is the same class of mistake as a count that
     * includes rows they cannot read.
     *
     * The count of reports on the instance is reported separately and is
     * deliberately not ACL-checked, because it is a capacity statement about the
     * conversion rather than a fact about the viewer's data. It is labelled as
     * such wherever it is displayed.
     */
    list: function (opts) {
        opts = opts || {};
        var limit = opts.limit || CmdReport.MAX_LIST;
        var t0 = new Date().getTime();

        var out = { reports: [], byTable: {}, stats: {
            visible: 0, converted: 0, unsupported: 0, truncated: false,
            onInstance: 0, ms: 0
        }};

        /* Capacity, not entitlement. See the note above. */
        var ag = new GlideAggregate('sys_report');
        ag.addAggregate('COUNT');
        ag.query();
        if (ag.next()) out.stats.onInstance = parseInt(ag.getAggregate('COUNT'), 10);

        var gr = new GlideRecordSecure('sys_report');
        if (opts.table) gr.addQuery('table', opts.table);
        gr.addNotNullQuery('table');
        gr.orderBy('table');
        gr.orderBy('title');
        gr.setLimit(limit + 1);
        gr.query();

        while (gr.next()) {
            if (out.reports.length >= limit) { out.stats.truncated = true; break; }
            out.stats.visible++;

            var d = this.describe(gr);
            if (d.supported) out.stats.converted++; else out.stats.unsupported++;

            out.reports.push({
                sysId: d.sysId, title: d.title, table: d.table,
                tableLabel: d.supported ? this.meta.describe(d.table).label : d.table,
                nativeType: d.nativeType, groupField: d.groupField,
                aggregate: d.aggregate, owner: d.owner, dynamic: d.dynamic,
                supported: d.supported, reason: d.reason,
                url: '/cmd_dashboard.do?report=' + d.sysId
            });

            if (!out.byTable[d.table]) out.byTable[d.table] = 0;
            out.byTable[d.table]++;
        }

        out.stats.ms = new Date().getTime() - t0;
        return out;
    },

    /* ══════════════════════════════════════════════════════════════════════
       Parity
       ══════════════════════════════════════════════════════════════════════ */

    /**
     * The same filter counted both ways, and what the difference means.
     *
     * This is the mechanism the client asked for when they asked how they would
     * know no data had been lost. It does not assert that nothing was lost, it
     * measures it, per report, for the person looking at it.
     *
     * `native` is GlideAggregate over the report's own filter, which is what the
     * platform's reporting engine counts and therefore what the existing report
     * displays. `ours` is the permission-checked count. Three outcomes:
     *
     *   MATCH       identical. Nothing was added, removed, sampled or capped.
     *               This is the answer for an unrestricted viewer and it is the
     *               claim "no data manipulation" reduces to.
     *   RESTRICTED  ours is smaller. The difference is rows matching the filter
     *               that this viewer may not read, which the native report was
     *               displaying to them anyway.
     *   BOUNDED     the permission check did not finish inside its budget, so
     *               ours is a floor. Never presented as exact.
     *
     * A fourth outcome, ours greater than native, is not possible and is reported
     * as an error rather than shown, because it would mean the permission-checked
     * scan admitted a row the unchecked count did not match.
     */
    parity: function (table, query) {
        var nativeCount = this.data.fastCount(table, query);
        var total = this.data.total(table, query);
        var v = this.data.aclVerdict(table, query);

        var p = {
            nativeCount: nativeCount,
            ours: total.count,
            mode: total.mode,
            delta: nativeCount - total.count,
            capped: !!v.capped,
            verdict: 'MATCH',
            statement: ''
        };

        if (p.ours > p.nativeCount) {
            p.verdict = 'ERROR';
            p.statement = 'The permission-checked count exceeded the unchecked one, ' +
                          'which should not be possible. Treat both as unverified.';
            return p;
        }

        if (v.capped) {
            p.verdict = 'BOUNDED';
            p.statement = 'The permission check stopped at its budget, so ' +
                          p.ours + ' is a floor rather than an exact count. ' +
                          'The native report shows ' + p.nativeCount + '.';
            return p;
        }

        if (p.delta === 0) {
            p.verdict = 'MATCH';
            p.statement = 'Identical to the native report: ' + p.nativeCount +
                          ' records, counted twice by two different methods. ' +
                          'Nothing was filtered, sampled or capped.';
            return p;
        }

        p.verdict = 'RESTRICTED';
        p.statement = 'The native report counts ' + p.nativeCount + ' records. You may ' +
                      'read ' + p.ours + ' of them. The other ' + p.delta +
                      ' match the filter but not your permissions, and the native ' +
                      'report counts them anyway.';
        return p;
    },

    /* ══════════════════════════════════════════════════════════════════════
       Conversion
       ══════════════════════════════════════════════════════════════════════ */

    /**
     * One saved report, redrawn.
     *
     * Deliberately thin. It reads the definition, hands the filter to CmdPayload
     * as the base query and decorates the result. Everything that makes the page
     * good -- the ACL verdict, the shape profiling, the form selection, the drill
     * gates -- is the same code path a subject dashboard uses, because a report
     * that behaved differently from the rest of the product would be a second
     * product to maintain and a second one to get wrong.
     *
     * What it adds is the comparison: the native definition beside ours, and the
     * parity check between them.
     */
    convert: function (payloadBuilder, sysId, path, opts) {
        opts = opts || {};

        var gr = new GlideRecordSecure('sys_report');
        gr.addQuery('sys_id', sysId);
        gr.setLimit(1);
        gr.query();
        if (!gr.next()) {
            return { version: CmdPayload.VERSION, error:
                     'That report does not exist, or you may not open it.',
                     subject: { table: '', label: 'Report', rows: 0 },
                     panels: [], path: [], notes: [], drill: { atMax: true, options: [] } };
        }

        var d = this.describe(gr);
        if (!d.supported) {
            return { version: CmdPayload.VERSION,
                     error: 'This report cannot be converted: ' + d.reason + '.',
                     subject: { table: d.table, label: d.title, rows: 0 },
                     report: d, panels: [], path: [], notes: [],
                     drill: { atMax: true, options: [] } };
        }

        var o = {}, k;
        for (k in opts) { if (opts.hasOwnProperty(k)) o[k] = opts[k]; }
        o.baseQuery = d.query;
        /* The report's own dimension leads the page when it names one. Without
           this the converted report answers a question the author did not ask,
           which is a different product rather than a better drawing of theirs. */
        o.leadField = d.groupField || null;

        var payload = payloadBuilder.dashboard(d.table, path || [], o);

        payload.report = {
            sysId: d.sysId, title: d.title, owner: d.owner,
            nativeType: d.nativeType, groupField: d.groupField,
            aggregate: d.aggregate, aggField: d.aggField,
            rawFilter: d.rawFilter, query: d.query, edits: d.edits,
            dynamic: d.dynamic
        };
        payload.parity = this.parity(d.table, payload.subject.query || d.query);

        /* The subject is the report, not the table. A page headed `incident` when
           the viewer clicked "Open incidents by assignment group" has lost the
           thing they were looking for. */
        payload.subject.label = d.title;
        payload.subject.sublabel = this.meta.describe(d.table).label;

        payload.notes.push(payload.parity.statement);

        /* The report's own breakdown, drawn first.
         *
         * Without this the converted page is a good dashboard about the same rows
         * rather than a redrawing of the report somebody saved. On "Problems By
         * State" the analysis panels all keyed on `state` -- a small-multiples, a
         * waterfall, a bump chart -- and not one of them was the plain breakdown
         * the author asked for, so the side-by-side had nothing to sit beside.
         *
         * It is added only when the shape gates accept it. When they do not, the
         * comparison says so in words rather than drawing a chart the data does
         * not support, because the whole argument for choosing forms by shape is
         * lost the moment we draw one anyway to fill a slot. */
        if (d.groupField && !this._panelFor(payload, d.groupField, 'dimension')) {
            var dim = this.meta.field(d.table, d.groupField);
            if (dim) {
                var own = payloadBuilder._dimPanel(
                    d.table, payload.subject.query || d.query, dim,
                    this.data.total(d.table, payload.subject.query || d.query));
                if (own) {
                    own.id = 'report_' + d.groupField;
                    own.question = d.title;
                    payload.panels.unshift(own);
                }
            }
        }

        /* What the author drew, against what the data supports.
         *
         * This is the product's central claim stated as a fact, so it has to be
         * the same question compared twice or it is worth nothing. The comparison
         * is only made against the panel drawing the report's own dimension. It
         * used to fall back to the first panel on the page, which on a report
         * grouped by assignment group compared a native bar chart against our
         * time series and announced a disagreement between two charts that were
         * never answering the same thing.
         *
         * The three honest outcomes are: we drew your dimension and chose this
         * form; you have no dimension, so there is nothing to compare a form
         * against; or your dimension did not earn a panel, and here is why. */
        payload.report.comparison = this._compare(d, payload);

        return payload;
    },

    /**
     * The like-for-like form comparison, or an explicit statement of why there
     * isn't one.
     */
    _compare: function (d, payload) {
        if (!d.groupField) {
            return {
                comparable: false,
                nativeForm: d.nativeType,
                why: 'This report groups by nothing, so it is a single number ' +
                     'rather than a shape. The same number is at the top of this ' +
                     'page, and everything below it is context the original ' +
                     'report did not carry.'
            };
        }

        /* A plain breakdown of the report's dimension is the like-for-like
           comparison. Any other panel keyed on the same field is answering a
           further question about it, which is worth having on the page and is not
           what the author drew. */
        var drawn = this._panelFor(payload, d.groupField, 'dimension') ||
                    this._panelFor(payload, d.groupField, null);

        if (!drawn) {
            var label = d.groupField;
            var f = this.meta.field(d.table, d.groupField);
            if (f && f.label) label = f.label;
            return {
                comparable: false,
                nativeForm: d.nativeType,
                field: d.groupField,
                why: 'This report groups by ' + label + ', and on the rows you can ' +
                     'read that column does not carry a shape worth drawing. The ' +
                     'count is unchanged and is shown above.'
            };
        }

        return {
            comparable: true,
            nativeForm: d.nativeType,
            ours: drawn.form,
            field: d.groupField,
            fieldLabel: drawn.fieldLabel || d.groupField,
            differs: !this._sameFamily(d.nativeType, drawn.form),
            reason: drawn.reason
        };
    },

    /** The panel drawing `field`, optionally of a particular kind. */
    _panelFor: function (payload, field, kind) {
        var panels = payload.panels || [];
        for (var i = 0; i < panels.length; i++) {
            if (panels[i].field !== field) continue;
            if (kind && panels[i].kind !== kind) continue;
            return panels[i];
        }
        return null;
    },

    /**
     * Whether two form names are the same idea drawn differently.
     *
     * A native `bar` against our `column` is not a disagreement worth showing the
     * client; a native `pie` against our `bar` is, because it is the part-to-whole
     * question being answered as a ranking. Grouping by family keeps the
     * comparison honest instead of inflating how often we differ.
     */
    _sameFamily: function (nativeType, ours) {
        var fam = {
            bar: 'rank', horizontal_bar: 'rank', vertical_bar: 'rank',
            column: 'rank', lollipop: 'rank', bullet: 'rank',
            pie: 'part', donut: 'part', semi_donut: 'part', treemap: 'part',
            stacked_bar: 'part', waffle: 'part',
            line: 'time', spline: 'time', area: 'time', trend: 'time',
            slope: 'time', calendar_heatmap: 'time',
            single_score: 'scalar', stat_tile: 'scalar', stat_tile_delta: 'scalar',
            solid_gauge: 'scalar', gauge: 'scalar', speedometer: 'scalar'
        };
        var a = fam[nativeType] || nativeType;
        var b = fam[ours] || ours;
        return a === b;
    },

    /* ══════════════════════════════════════════════════════════════════════
       Capacity
       ══════════════════════════════════════════════════════════════════════ */

    /**
     * What conversion costs at the size the client asked about.
     *
     * They asked whether there is a boundary, and named five thousand reports.
     * The answer is that conversion is not a batch job that runs once and
     * produces artefacts, so there is no five-thousand-report build to size.
     * A report is converted when someone opens it, from its own saved definition,
     * which is one read of `sys_report` plus the same page build any subject
     * dashboard costs. The list is paged.
     *
     * So the two numbers that bound it are measured here rather than estimated:
     * how long it takes to read and normalise N definitions, and how many of them
     * this build can actually execute. Both are facts about the instance, which
     * is why this is a method and not a paragraph in a document.
     */
    capacity: function (sample) {
        sample = sample || 500;
        var t0 = new Date().getTime();
        var out = { sampled: 0, supported: 0, unsupported: 0, byType: {},
                    byReason: {}, onInstance: 0, describeMs: 0, perReportMs: 0 };

        var ag = new GlideAggregate('sys_report');
        ag.addAggregate('COUNT');
        ag.query();
        if (ag.next()) out.onInstance = parseInt(ag.getAggregate('COUNT'), 10);

        var gr = new GlideRecord('sys_report');
        gr.setLimit(sample);
        gr.query();
        while (gr.next()) {
            out.sampled++;
            var d = this.describe(gr);
            out.byType[d.nativeType] = (out.byType[d.nativeType] || 0) + 1;
            if (d.supported) {
                out.supported++;
            } else {
                out.unsupported++;
                out.byReason[d.reason] = (out.byReason[d.reason] || 0) + 1;
            }
        }

        out.describeMs = new Date().getTime() - t0;
        out.perReportMs = out.sampled ? (out.describeMs / out.sampled) : 0;
        return out;
    }
};
