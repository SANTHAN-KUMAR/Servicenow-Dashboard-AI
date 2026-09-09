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

    /**
     * Accepts the caller's CmdData and CmdMeta so the whole request shares one
     * memoisation cache. Constructing its own would give the drill gates a second
     * empty cache and make them re-prove and re-profile everything the panels had
     * already paid for, which is most of the cost of a page.
     */
    initialize: function (data, meta) {
        this.data = data || new CmdData();
        this.meta = meta || new CmdMeta();
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

        /* Routed through total() so it uses the request's single ACL verdict
           rather than re-proving the table for every candidate field. */
        var total = this.data.total(table, query);
        res.rows = total.count;

        if (total.count === 0) {
            res.reason = 'no records in this slice';
            return res;
        }
        if (total.count < G.MIN_ROWS) {
            res.reason = 'only ' + total.count + (total.count === 1 ? ' record' : ' records') +
                         ' left, too few to break down further';
            return res;
        }

        /* One grouped query answers fill rate and cardinality together. Asking
           for them separately cost two extra table scans per candidate field, and
           a gate that examines fourteen candidates pays that fourteen times. */
        var prof = this.data.profile(table, dim.name, query);
        res.fill = prof.fill;
        res.distinct = prof.distinctNonEmpty;
        res.capped = !!prof.capped;

        /* A bounded scan proves presence and never absence.
         *
         * This is the rule the rest of this method now obeys, and it is worth
         * stating plainly because getting it wrong shipped the worst claim this
         * product has made. Every rejection below except MAX_DISTINCT concludes
         * that something is NOT there -- not enough distinct values, not enough
         * fill -- and no such conclusion survives a scan that stopped early,
         * because the rows it never reached are exactly the ones that would
         * overturn it.
         *
         * Live on dev390988, `task` rejected six levels as "every record here has
         * the same X" from a profile that had admitted no rows at all. The columns
         * hold two to eight values each. The page stated a fact about 8,503
         * records on the strength of having read none of them, and it stated it in
         * the same calm voice it uses for measurements that are real -- which is
         * what made it dangerous rather than merely wrong.
         *
         * The asymmetry is what makes a lower bound still useful: a prefix that
         * already holds enough distinct values proves the whole slice does, and
         * one that already holds too many proves that too. Those two directions
         * survive capping. Nothing else does. */
        if (!prof.measured) {
            res.unmeasured = true;
            res.reason = 'not measured: the permission-checked scan ran out of ' +
                         'time on this subject before it read any rows, so ' +
                         'whether this is a level is unknown rather than no';
            return res;
        }

        /* Where the scan was capped, every number below describes the rows that
           were read rather than the slice, and the wording has to say so. */
        var read = prof.capped
            ? ' of the ' + prof.total + ' records read before the scan stopped'
            : ' of these records';

        if (prof.fill < G.FATAL_FILL) {
            res.reason = dim.label + ' is empty on ' +
                         this._pct(1 - prof.fill) + read;
            return res;
        }

        if (prof.distinctNonEmpty < G.MIN_DISTINCT) {
            /* Uniformity is an absence -- of a second value -- so it is only
               claimable off a complete scan. Under a cap the honest statement is
               about what was read, and it stops short of the whole slice. */
            res.reason = prof.capped
                ? 'the ' + prof.total + ' records read before the scan stopped all '
                  + 'share one ' + dim.label.toLowerCase() +
                  ', which is too few to tell whether the rest do'
                : 'every record here has the same ' + dim.label.toLowerCase();
            return res;
        }
        if (prof.distinctNonEmpty > G.MAX_DISTINCT) {
            /* Sound under a cap: a prefix holding this many distinct values is a
               floor, and the whole slice can only hold more. */
            res.reason = (prof.capped ? 'at least ' : '') + prof.distinctNonEmpty +
                         ' distinct values, too many for a level';
            res.searchable = true;
            return res;
        }
        if (prof.fill < G.MIN_FILL) {
            /* Offered, but the caveat travels with it. A 45%-populated field is
               still a real breakdown of the part that is populated. */
            res.offer = true;
            res.partial = true;
            res.reason = 'covers the ' + this._pct(prof.fill) + ' of records that have a ' +
                         dim.label.toLowerCase() + (prof.capped ? ', of those read' : '');
            return res;
        }

        res.offer = true;
        res.reason = prof.distinctNonEmpty + ' values, populated on ' +
                     this._pct(prof.fill) + (prof.capped ? ' of those read' : '');
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
    /**
     * One drill step, as an encoded-query clause.
     *
     * Most steps are a value on a dimension. Two kinds are not, and they are the
     * ones the client meant by "click anything": a bar in a histogram stands for a
     * numeric interval, and a point on a time series stands for a period. Neither
     * is expressible as `field=value`, so a step may also carry a half-open range,
     * written `~r~lo~hi` for numbers and `~d~from~to` for dates.
     *
     * Half-open on purpose. Ranges that share an endpoint are what a histogram and
     * a month axis both produce, and a closed range would count the boundary row
     * in two neighbouring buckets -- so the totals of the drills would exceed the
     * total of the chart they came from, which is the kind of arithmetic a viewer
     * checks.
     *
     * `table` is optional only so existing callers keep working; without it a
     * range is refused rather than guessed at, because the field's type is what
     * decides whether a range means anything and it cannot be read without it.
     */
    stepQuery: function (query, field, key, table) {
        var clause;
        var r = table ? this.parseRange(table, field, key) : null;
        if (r) {
            clause = field + '>=' + r.lo + '^' + field + '<' + r.hi;
        } else if (key === '' || key === null || key === undefined) {
            clause = field + 'ISEMPTY';
        } else {
            clause = field + '=' + key;
        }
        return query ? query + '^' + clause : clause;
    },

    /**
     * A range key, parsed and proved safe, or null.
     *
     * Null for anything that is not exactly the expected shape, so an unrecognised
     * key falls through and is treated as a literal value -- a category that
     * happens to begin with a tilde still filters as itself.
     *
     * The strictness here is load-bearing. This is the only place in the product
     * where a drill key becomes something other than the right-hand side of an
     * `=`, and the clause it builds contains `^`. A key that reached it unchecked
     * could therefore inject a clause, which is the exact failure sanitizePath
     * exists to prevent -- so both endpoints are matched against a full-string
     * numeric or timestamp pattern, and the field's own declared type has to agree
     * that a range is meaningful for it.
     */
    parseRange: function (table, field, key) {
        if (key === null || key === undefined) return null;
        var m = /^~([rd])~([^~]*)~([^~]*)$/.exec(String(key));
        if (!m) return null;

        var kind = m[1], lo = m[2], hi = m[3];
        var f = this.meta.field(table, field);
        if (!f) return null;
        if (kind === 'r' && !(f.isNumber || f.isDuration)) return null;
        if (kind === 'd' && !f.isDate) return null;

        var ok = (kind === 'r')
            ? /^-?[0-9]+(\.[0-9]+)?$/
            : /^[0-9]{4}-[0-9]{2}-[0-9]{2}( [0-9]{2}:[0-9]{2}:[0-9]{2})?$/;
        if (!ok.test(lo) || !ok.test(hi)) return null;

        return { kind: kind, lo: lo, hi: hi };
    },

    /**
     * Cuts a drill path down to its longest safe prefix.
     *
     * The path arrives from a URL query parameter, decoded and otherwise
     * unvalidated, and it is walked straight into stepQuery, which concatenates
     * `field + '=' + key` into an encoded query with no escaping. Two things make
     * that dangerous rather than merely untidy:
     *
     *   1. `field` was never checked against the table. Any string reaches the
     *      query as a clause.
     *   2. `key` was never checked for `^`, which is the encoded-query clause
     *      separator. A key of `software^ORsys_idISNOTEMPTY` does not narrow the
     *      drill to Software, it ORs in a clause that matches every row.
     *
     * That second one defeats CmdData._trustedFor, which decides an unchecked
     * cursor is safe by testing whether the query is a narrower version of one
     * already proven -- true for `^` used as AND, false for `^OR` and `^NQ`,
     * which widen instead. Confirmed live on dev390988: a drill path of
     * `category:software^ORsys_idISNOTEMPTY` returned all 4,266 incidents,
     * labelled VERIFIED, and the widened clause was carried verbatim into the
     * terminal record-list link.
     *
     * So every segment is checked before any of it reaches a query: `field` must
     * be one of the table's own dimensions, and `key` must not contain `^`. The
     * first bad segment truncates the path there -- a drill three levels deep
     * with a poisoned second step is not "partially honoured with the bad part
     * removed," it is cut back to one level, because a level's meaning depends on
     * the ones above it.
     *
     * This is one of two independent checks. CmdData._trustedFor also refuses to
     * transfer trust across `^OR` / `^NQ` on its own, so a path that reached a
     * query through any other caller is still caught.
     */
    sanitizePath: function (table, path) {
        var out = [];
        if (!path || !path.length) return out;

        var dims = this.meta.dimensions(table);
        var valid = {};
        var i;
        for (i = 0; i < dims.length; i++) valid[dims[i].name] = true;

        for (i = 0; i < path.length; i++) {
            var seg = path[i];
            if (!seg) break;

            /* A range step is admitted on its own terms. Its field is a date or a
               number, which is deliberately not a dimension -- you cannot group by
               `opened_at` -- so the dimension test would reject every histogram bin
               and every point on a time series. parseRange is at least as strict:
               it checks the field exists, that its declared type makes a range
               meaningful, and that both endpoints are literal numbers or
               timestamps. */
            var ranged = this.parseRange(table, seg.field, seg.key);
            if (!ranged && !valid[seg.field]) break;

            var key = seg.key;
            if (!ranged && key !== '' && key !== null && key !== undefined &&
                String(key).indexOf('^') !== -1) break;
            out.push(seg);
        }
        return out;
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
