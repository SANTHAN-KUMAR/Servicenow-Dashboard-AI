/**
 * CmdDrill. Hierarchy discovery and the drill gates.
 *
 * The client wants Power BI style drilldown: click a value, keep going down.
 * The obvious implementation reads the dictionary's declared parent-child pairs
 * and follows them. Measured, that implementation is a trap.
 *
 * `incident.subcategory` is declared dependent on `category` and is populated on
 * 42 of 13,986 records on the tenant where that was measured, which is 0.3%. So a
 * viewer clicks into Software, expecting detail, and lands on a level where
 * effectively every record reads "(none)". That is the dumb-stub failure again,
 * expressed as an interaction rather than as a chart. It is not universal:
 * `change_request` category to type is fully populated. Drill quality is a
 * property of a specific field pair on a specific table, and it has to be
 * measured per slice.
 *
 * This is the same lesson the form engine encodes, one question further down.
 * `sys_report.type` records which chart somebody picked;
 * `sys_dictionary.dependent` records that somebody intended a hierarchy. Neither
 * is a property of the rows.
 *
 * Two rules make the result honest:
 *
 *   1. A level is offered only after passing fill-rate and cardinality gates.
 *      A rejected level is not a disabled control that disappoints, it carries
 *      the reason it was rejected, which is itself worth knowing.
 *   2. The gates run against the viewer's own permitted rows. Measuring fill rate
 *      over the whole table would decide a viewer's drill affordances using data
 *      they are not entitled to see, and would leak the shape of it.
 *
 * ES5 only. Rhino.
 */
var CmdDrill = Class.create();

/* Depth below the top level. Three plus the terminal record list covers the
   questions a leader actually asks, and bounds both the payload and the number of
   queries a single page can trigger. Unbounded drill is unbounded cost. */
CmdDrill.MAX_DEPTH = 3;

CmdDrill.GATES = {
    MIN_FILL: 0.60,        // below this the level describes a minority of the slice
    FATAL_FILL: 0.10,      // below this it is not a level at all
    MIN_DISTINCT: 2,       // one value is not a breakdown
    MAX_DISTINCT: 50,      // beyond this, offer search rather than a chart level
    MIN_ROWS: 10           // too few rows left to break down further
};

CmdDrill.prototype = {

    initialize: function () {
        this.meta = new CmdMeta();
        this.data = new CmdData();
    },

    /**
     * Candidate child dimensions for a slice, best first, each already gated.
     *
     * `used` is the fields already consumed by ancestors of this slice; drilling
     * into the same field twice is a no-op that looks like a bug.
     *
     * Returns every candidate considered, offered or not, because the rejected
     * ones and their reasons are what the UI shows instead of a dead end.
     */
    candidates: function (table, query, used, limit) {
        used = used || [];
        limit = limit || 4;

        var dims = this.meta.dimensions(table);
        var out = [];
        var considered = 0;

        for (var i = 0; i < dims.length && out.length < limit && considered < 14; i++) {
            var d = dims[i];
            if (this._contains(used, d.name)) continue;
            considered++;
            out.push(this.gate(table, d, query));
        }

        /* Offered first, then the rejected ones in the order they were tried, so
           the UI can show "you can go here" above "and here is why not there". */
        out.sort(function (a, b) {
            if (a.offer !== b.offer) return a.offer ? -1 : 1;
            return 0;
        });
        return out;
    },

    /**
     * The gate. Measures one candidate field against one slice and decides.
     *
     * Ordered cheapest first: the row count is one bounded secure count, the fill
     * rate is two, and the distinct count needs a group-by, so it is only paid
     * for once the field has survived the cheaper checks.
     */
    gate: function (table, dim, query) {
        var G = CmdDrill.GATES;
        var res = {
            field: dim.name,
            label: dim.label,
            isOrdinal: !!dim.isOrdinal,
            isRef: !!dim.isRef,
            offer: false,
            reason: '',
            fill: null,
            distinct: null,
            rows: null
        };

        var total = this.data.secureCount(table, query);
        res.rows = total.count;

        if (total.count === 0) {
            res.reason = 'no records in this slice';
            return res;
        }
        if (total.count < G.MIN_ROWS) {
            res.reason = 'only ' + total.count + ' records left, too few to break down further';
            return res;
        }

        var fr = this.data.fillRate(table, dim.name, query);
        res.fill = Math.round(fr.rate * 1000) / 1000;

        if (fr.rate < G.FATAL_FILL) {
            res.reason = dim.label + ' is empty on ' +
                         this._pct(1 - fr.rate) + ' of these records';
            return res;
        }

        var prof = this.data.profile(table, dim.name, query);
        res.distinct = prof.distinctNonEmpty;

        if (prof.distinctNonEmpty < G.MIN_DISTINCT) {
            res.reason = 'every record here has the same ' + dim.label.toLowerCase();
            return res;
        }
        if (prof.distinctNonEmpty > G.MAX_DISTINCT) {
            res.reason = prof.distinctNonEmpty + ' distinct values, too many for a level';
            res.searchable = true;
            return res;
        }
        if (fr.rate < G.MIN_FILL) {
            /* Offered, but the caveat travels with it. A 45%-populated field is
               still a real breakdown of the part that is populated. */
            res.offer = true;
            res.partial = true;
            res.reason = 'covers the ' + this._pct(fr.rate) + ' of records that have a ' +
                         dim.label.toLowerCase();
            return res;
        }

        res.offer = true;
        res.reason = prof.distinctNonEmpty + ' values, populated on ' + this._pct(fr.rate);
        return res;
    },

    /**
     * Declared pairs from the dictionary, gated the same way as anything else.
     *
     * Kept separate from candidates() so the payload can say "the schema claims
     * this hierarchy and here is whether it survives contact with the data",
     * which is the most direct demonstration of why the product exists.
     */
    declaredPath: function (table, query) {
        var pairs = this.meta.dependentPairs(table);
        var out = [];
        for (var i = 0; i < pairs.length && i < 8; i++) {
            var child = this.meta.field(table, pairs[i].child);
            if (!child) continue;
            var g = this.gate(table, {
                name: child.name, label: child.label,
                isOrdinal: child.isOrdinal, isRef: child.isRef
            }, query);
            g.declaredParent = pairs[i].parent;
            g.declaredParentLabel = pairs[i].parentLabel;
            out.push(g);
        }
        return out;
    },

    /**
     * Builds the encoded query for one step down.
     *
     * The empty key is a real slice, not a missing one, so it becomes ISEMPTY
     * rather than an equality against the empty string. Getting that wrong makes
     * the "(none)" bar unclickable, which is the bar a viewer most wants to click
     * when they are trying to find out why a field is unpopulated.
     */
    stepQuery: function (query, field, key) {
        var clause = (key === '' || key === null || key === undefined)
            ? field + 'ISEMPTY'
            : field + '=' + key;
        return query ? query + '^' + clause : clause;
    },

    /**
     * The URL for the terminal step: the platform's own list view.
     *
     * This is the one place where being inside ServiceNow beats Power BI rather
     * than constraining us. The list enforces row-level ACLs itself, so we do not
     * build a record grid, do not paginate, and cannot get the security wrong.
     */
    listUrl: function (table, query) {
        return '/' + table + '_list.do?sysparm_query=' +
               encodeURIComponent(query || '') + '&sysparm_view=';
    },

    atMaxDepth: function (path) {
        return (path || []).length >= CmdDrill.MAX_DEPTH;
    },

    _contains: function (arr, v) {
        for (var i = 0; i < arr.length; i++) {
            if (arr[i] === v) return true;
        }
        return false;
    },

    _pct: function (r) {
        var p = r * 100;
        return (p >= 99.5 || p < 0.05 ? Math.round(p) : Math.round(p * 10) / 10) + '%';
    },

    type: 'CmdDrill'
};
