/**
 * CmdData. The data layer.
 *
 * Everything that touches rows lives here, and everything here is answerable to
 * one rule: a number shown to a viewer must not include records that viewer
 * cannot open.
 *
 * That rule is harder than it sounds on this platform. GlideAggregate does not
 * enforce row-level ACLs, there is no GlideAggregateSecure, and
 * GlideQuery.withAcls() throws rather than aggregate. Demonstrated live on
 * dev390988: a role-less user gets GlideAggregate = 67 where GlideRecordSecure
 * returns 0 rows. So the fast path is unsafe and the safe path is slow, and the
 * job of this file is to be fast when it can prove that is safe and slow when it
 * cannot.
 *
 * The strategy is tiered, in tieredGroupBy(): run the fast aggregate, run one
 * cheap secure count to prove it, and escalate to a full secure group-by only
 * when the two disagree. On an instance where the viewer can read everything,
 * which is the common case, that costs one extra count and nothing else.
 *
 * ES5 only. Rhino.
 */
var CmdData = Class.create();

/* Hard cap on secure row iteration, so a correctness check can never hang a page
   load. When this trips, every count derived from the scan is a lower bound and
   must be labelled as one. Never present a capped count as exact. */
CmdData.SECURE_SCAN_CAP = 20000;

/* Cap on distinct groups returned before the tail is folded into Other. Set well
   above the form engine's display thresholds so truncation is a rendering
   decision, not a data one. */
CmdData.MAX_GROUPS = 200;

/* Wall-clock budget for the permission-check proof, and how often the clock is
   consulted during it. Time, not rows, because the cost per row varies by two
   orders of magnitude across the tables on this instance. */
CmdData.PROOF_MS = 2500;
/* How often the clock is consulted inside a bounded scan.
 *
 * This was 250 and that made every time-box ineffective on exactly the tables that
 * needed one. A row on kb_knowledge costs 40 to 86ms to permission-check, so 250
 * rows is 10 to 20 seconds before the budget is even looked at: the box was set to
 * 1.2s and the scan ran for 9. Ten rows bounds the overshoot to under a second in
 * the worst case, and a getTime() call every ten rows is immeasurable next to an ACL
 * evaluation that costs milliseconds. */
CmdData.CHECK_EVERY = 10;

/* Wall-clock budget for one secure group-by, the per-panel fallback when the ACL
   verdict is not trusted. Smaller than the proof budget because a page runs several
   of these where it runs one proof. */
CmdData.GROUP_MS = 1200;

CmdData.prototype = {

    initialize: function () {
        /* Per-request memoisation. Measured before this existed: assembling eight
           panels plus drill gates over 4,264 incidents took 60 seconds, because
           every panel independently re-scanned the table securely to get a
           denominator that was the same number every time.
           See aclVerdict() for the change that actually matters. */
        this._verdict = {};
        this._counts = {};
        this._profiles = {};
        this._meta = null;
    },

    /**
     * The per-request ACL verdict for one table and query. This is the single
     * most important performance decision in the product.
     *
     * The correctness obligation is that no number includes rows the viewer
     * cannot open. The naive reading of that is "compute everything securely",
     * which costs one ACL evaluation per row per panel and does not survive
     * contact with a real page.
     *
     * The observation that fixes it: whether row-level ACLs filter this table for
     * this viewer is a property of the viewer and the table, not of the panel. So
     * establish it once, with one fast count and one bounded secure count, and
     * then every panel in the request can use the fast path with that proof
     * attached. A viewer who can read everything, which is the common case, pays
     * for one proof instead of one scan per panel.
     *
     * When the proof fails, nothing is trusted and every panel pays for the
     * secure path. That is the correct trade: correctness is not negotiable, and
     * the slow case is the case that actually needs the work.
     */
    aclVerdict: function (table, query) {
        var key = table + '|' + (query || '');
        if (this._verdict[key]) return this._verdict[key];

        var v;
        if (!this.canRead(table)) {
            v = { trusted: false, denied: true, aggregate: 0, secure: 0,
                  delta: 0, capped: false, timedOut: false, proof: 'no read access' };
            this._verdict[key] = v;
            return v;
        }

        var fast = this.fastCount(table, query);

        /* The proof is a row scan, time-boxed.
         *
         * A structural shortcut was tried and abandoned: check whether any read ACL
         * carries a condition or a script, and skip the scan when none does.
         * Measured, it clears almost nothing. Every interesting table here has one
         * or two row-filtering read ACLs of its own, and the `*` wildcard adds three
         * more that cannot safely be ignored, because a wildcard ACL with a script
         * filters as effectively as a table-specific one. A check that clears two
         * tables out of six is not worth the code or the risk of being wrong.
         *
         * So the scan stays, and its cost is bounded by wall clock rather than by a
         * row count. A row count is the wrong bound because the cost per row varies
         * by two orders of magnitude: this instance logs Slow ACL at 40 to 86ms per
         * evaluation on kb_knowledge and sys_flow_context and under 1ms on incident,
         * so a 4,000-row cap is instant on one table and eight seconds on another.
         * Time-boxing spends the same budget everywhere and degrades to a labelled
         * floor rather than to a slow page. */
        var proof = this.secureCountBoxed(table, query, CmdData.PROOF_MS);

        v = {
            trusted: (!proof.capped && !proof.timedOut && proof.count === fast),
            denied: false,
            aggregate: fast,
            secure: proof.count,
            delta: fast - proof.count,
            capped: proof.capped || proof.timedOut,
            timedOut: proof.timedOut,
            proof: proof.timedOut
                ? 'permission check stopped after ' + CmdData.PROOF_MS + 'ms at ' +
                  proof.count + ' rows, so counts are a floor'
                : proof.capped
                ? 'permission check stopped at the ' + CmdData.SECURE_SCAN_CAP + ' row cap'
                : 'every permitted row was permission-checked'
        };
        this._verdict[key] = v;
        return v;
    },

    /**
     * ACL-correct count with a wall-clock budget.
     *
     * The clock is consulted every CHECK_EVERY rows rather than every row, because
     * getTime() in the inner loop of a 20,000-row scan is itself measurable.
     */
    secureCountBoxed: function (table, query, budgetMs) {
        var ck = table + '|' + (query || '') + '|boxed';
        if (this._counts[ck]) return this._counts[ck];

        var t0 = new Date().getTime();
        var gr = new GlideRecordSecure(table);
        if (query) gr.addEncodedQuery(query);
        gr.setLimit(CmdData.SECURE_SCAN_CAP + 1);
        gr.query();

        var n = 0, capped = false, timedOut = false;
        while (gr.next()) {
            if (n >= CmdData.SECURE_SCAN_CAP) { capped = true; break; }
            n++;
            if (n % CmdData.CHECK_EVERY === 0 &&
                (new Date().getTime() - t0) > budgetMs) { timedOut = true; break; }
        }

        this._counts[ck] = { count: n, capped: capped, timedOut: timedOut,
                             ms: new Date().getTime() - t0 };
        return this._counts[ck];
    },

    /** Lazily shared CmdMeta, so the table chain is looked up once. */
    meta: function () {
        if (!this._meta) this._meta = new CmdMeta();
        return this._meta;
    },

    /** The row count to show, and where it came from. Cheap after the first call. */
    total: function (table, query) {
        var v = this.aclVerdict(table, query);
        return {
            count: v.trusted ? v.aggregate : v.secure,
            mode: v.denied ? 'DENIED'
                : v.capped ? 'BOUNDED'
                : v.trusted ? 'VERIFIED' : 'FILTERED',
            delta: v.delta,
            capped: v.capped
        };
    },

    /* ══════════════════════════════════════════════════════════════════════
       Counting
       ══════════════════════════════════════════════════════════════════════ */

    /** Unsafe by design. Never surface without pairing it with a proof. */
    fastCount: function (table, query) {
        var ga = new GlideAggregate(table);
        if (query) ga.addEncodedQuery(query);
        ga.addAggregate('COUNT');
        ga.query();
        return ga.next() ? (parseInt(ga.getAggregate('COUNT'), 10) || 0) : 0;
    },

    /**
     * ACL-correct count. Bounded, so it returns {count, capped}: `capped` true
     * means the real total is at least `count` and the caller must say so.
     *
     * `cap` overrides the default scan limit, and callers should use it. Measured
     * on this instance: a secure count is one ACL evaluation per row, and the
     * platform logs "Slow ACL" on tables with expensive read rules. kb_knowledge
     * and sys_flow_context both hit 40 to 86ms on single evaluations. Scanning
     * 20,000 rows of those to populate a catalog card that only needs to say
     * "enough rows to be worth opening" is the wrong trade, which is why the
     * catalog passes a small cap and renders a floor rather than an exact total.
     */
    secureCount: function (table, query, cap) {
        cap = cap || CmdData.SECURE_SCAN_CAP;
        var ck = table + '|' + (query || '') + '|' + cap;
        if (this._counts[ck]) return this._counts[ck];
        var gr = new GlideRecordSecure(table);
        if (query) gr.addEncodedQuery(query);
        gr.setLimit(cap + 1);
        gr.query();
        var n = 0, capped = false;
        while (gr.next()) {
            if (n >= cap) { capped = true; break; }
            n++;
        }
        this._counts[ck] = { count: n, capped: capped };
        return this._counts[ck];
    },

    /**
     * Is this table worth offering at all, answered as cheaply as possible.
     *
     * The catalog needs a yes or no and a magnitude, not a total. Stops as soon as
     * `enough` rows have been seen, so a table with a million readable rows costs
     * the same as one with `enough`.
     */
    hasAtLeast: function (table, query, enough) {
        var gr = new GlideRecordSecure(table);
        if (query) gr.addEncodedQuery(query);
        gr.setLimit(enough);
        gr.query();
        var n = 0;
        while (gr.next()) n++;
        return { count: n, atLeast: n >= enough };
    },

    /* ══════════════════════════════════════════════════════════════════════
       Grouping
       ══════════════════════════════════════════════════════════════════════ */

    /**
     * Unsafe by design. Never surface without pairing it with a proof.
     *
     * Ordering is done in JavaScript, deliberately, and this is not a style
     * preference. Measured on this instance, release Australia:
     *
     *     groupBy('type')                                  -> 20 groups
     *     groupBy('type').orderByAggregate('COUNT','desc') ->  0 groups
     *     groupBy('type').orderByAggregate('COUNT')        -> 20 groups
     *     groupBy('type').orderByDesc('COUNT')             -> 20 groups, and
     *                                                         logs "Skip invalid
     *                                                         GroupBy condition"
     *
     * Passing a direction to orderByAggregate returns an empty result set with no
     * error, no exception and nothing in the log. A dashboard built on it renders
     * every panel blank and looks like a data problem. So the aggregate is asked
     * only for the grouping, and the sort and the cap are applied here where they
     * are visible. Sorting after collection is also what makes the MAX_GROUPS cap
     * correct: truncating an unordered result would drop the largest groups.
     */
    fastGroupBy: function (table, field, query) {
        var all = [];
        var ga = new GlideAggregate(table);
        if (query) ga.addEncodedQuery(query);
        ga.addAggregate('COUNT');
        ga.groupBy(field);
        ga.query();
        while (ga.next()) {
            var raw = ga.getValue(field);
            all.push({
                key: raw === null || raw === '' ? '' : String(raw),
                label: this._label(ga, field, raw),
                count: parseInt(ga.getAggregate('COUNT'), 10) || 0
            });
        }
        all.sort(function (a, b) { return b.count - a.count; });
        return all.length > CmdData.MAX_GROUPS
            ? all.slice(0, CmdData.MAX_GROUPS)
            : all;
    },

    /**
     * ACL-correct group-by. Iterates securely and counts in memory, which is the
     * only correct option the platform offers and is slow by construction.
     */
    /**
     * ACL-correct group-by. Iterates securely and counts in memory, which is the
     * only correct option the platform offers and is slow by construction.
     *
     * Time-boxed, and this matters more than it looks. This is the fallback taken
     * whenever the ACL verdict is not trusted, and it runs once per panel. Measured
     * unbounded on kb_knowledge, a table whose read ACL costs 40 to 86ms per row:
     * three panels took 39 seconds between them. Bounding the scan turns that into a
     * page that loads with counts honestly labelled as a floor, which is the right
     * trade. An exact number nobody waits for is worth less than an approximate one
     * that says so.
     */
    secureGroupBy: function (table, field, query, budgetMs) {
        var ck = 'sgb|' + table + '|' + field + '|' + (query || '');
        if (this._counts[ck]) return this._counts[ck];

        budgetMs = budgetMs || CmdData.GROUP_MS;
        var counts = {}, labels = {}, scanned = 0, capped = false, timedOut = false;
        var t0 = new Date().getTime();

        var gr = new GlideRecordSecure(table);
        if (query) gr.addEncodedQuery(query);
        gr.setLimit(CmdData.SECURE_SCAN_CAP + 1);
        gr.query();
        while (gr.next()) {
            if (scanned >= CmdData.SECURE_SCAN_CAP) { capped = true; break; }
            scanned++;
            var raw = gr.getValue(field);
            var k = raw === null || raw === '' ? '' : String(raw);
            counts[k] = (counts[k] || 0) + 1;
            if (labels[k] === undefined) {
                labels[k] = k === '' ? '' : (gr.getDisplayValue(field) || k);
            }
            if (scanned % CmdData.CHECK_EVERY === 0 &&
                (new Date().getTime() - t0) > budgetMs) { timedOut = true; break; }
        }

        var rows = [];
        for (var key in counts) {
            if (counts.hasOwnProperty(key)) {
                rows.push({ key: key, label: labels[key], count: counts[key] });
            }
        }
        rows.sort(function (a, b) { return b.count - a.count; });

        this._counts[ck] = { rows: rows, scanned: scanned,
                             capped: capped || timedOut, timedOut: timedOut };
        return this._counts[ck];
    },

    /**
     * Group by several fields in one permission-checked pass.
     *
     * The point is that the expensive part of a secure scan is the ACL evaluation
     * per row, not the field reads. Once a row has been admitted, pulling three more
     * values off it is nearly free. So a catalog card can measure three candidate
     * dimensions for the price of one, and then choose the most informative
     * afterwards instead of having to guess which field to group by before the scan
     * begins. Guessing produced cards previewing `approval` at 91% in one value,
     * which is a bar with nothing in it.
     *
     * Returns {byField: {field: rows[]}, scanned, capped}.
     */
    secureMultiGroupBy: function (table, fields, query, budgetMs) {
        var ck = 'mgb|' + table + '|' + fields.join(',') + '|' + (query || '');
        if (this._counts[ck]) return this._counts[ck];

        budgetMs = budgetMs || CmdData.GROUP_MS;
        var t0 = new Date().getTime();
        var counts = {}, labels = {}, i;
        for (i = 0; i < fields.length; i++) { counts[fields[i]] = {}; labels[fields[i]] = {}; }

        var scanned = 0, capped = false, timedOut = false;
        var gr = new GlideRecordSecure(table);
        if (query) gr.addEncodedQuery(query);
        gr.setLimit(CmdData.SECURE_SCAN_CAP + 1);
        gr.query();
        while (gr.next()) {
            if (scanned >= CmdData.SECURE_SCAN_CAP) { capped = true; break; }
            scanned++;
            for (i = 0; i < fields.length; i++) {
                var f = fields[i];
                var raw = gr.getValue(f);
                var k = (raw === null || raw === '') ? '' : String(raw);
                counts[f][k] = (counts[f][k] || 0) + 1;
                if (labels[f][k] === undefined) {
                    labels[f][k] = k === '' ? '' : (gr.getDisplayValue(f) || k);
                }
            }
            if (scanned % CmdData.CHECK_EVERY === 0 &&
                (new Date().getTime() - t0) > budgetMs) { timedOut = true; break; }
        }

        var byField = {};
        for (i = 0; i < fields.length; i++) {
            var fld = fields[i], rows = [];
            for (var key in counts[fld]) {
                if (counts[fld].hasOwnProperty(key)) {
                    rows.push({ key: key, label: labels[fld][key], count: counts[fld][key] });
                }
            }
            rows.sort(function (a, b) { return b.count - a.count; });
            byField[fld] = rows;
        }

        this._counts[ck] = { byField: byField, scanned: scanned,
                             capped: capped || timedOut, timedOut: timedOut };
        return this._counts[ck];
    },

    /**
     * The tiered strategy. This is the method the payload builder should call.
     *
     * Fast path, then one cheap secure count as a proof, then escalate only on
     * disagreement. Returns the rows plus an `acl` block that records which path
     * produced them, so the renderer can badge the panel and the log can show
     * that the check actually ran.
     *
     * `mode` is one of:
     *   VERIFIED  fast path used, and a secure count agreed with its total
     *   FILTERED  the two disagreed, so the secure group-by was used instead
     *   BOUNDED   the secure scan hit its cap, so counts are a floor
     *   DENIED    the viewer cannot read the table at all
     */
    tieredGroupBy: function (table, field, query) {
        var v = this.aclVerdict(table, query);

        if (v.denied) {
            return { rows: [],
                     acl: { mode: 'DENIED', aggregate: 0, secure: 0, delta: 0, capped: false } };
        }

        /* The proof already ran once for this table and query, so a trusted
           verdict means the fast path is known safe and costs one grouped query
           with no per-row ACL evaluation at all. */
        if (v.trusted) {
            return {
                rows: this.fastGroupBy(table, field, query),
                acl: { mode: 'VERIFIED', aggregate: v.aggregate,
                       secure: v.secure, delta: 0, capped: false }
            };
        }

        /* Not trusted, so pay for the correct answer. */
        var secure = this.secureGroupBy(table, field, query);
        var total = 0;
        for (var i = 0; i < secure.rows.length; i++) total += secure.rows[i].count;
        return {
            rows: secure.rows,
            acl: { mode: secure.capped ? 'BOUNDED' : 'FILTERED',
                   aggregate: v.aggregate, secure: total,
                   delta: v.aggregate - total, capped: secure.capped }
        };
    },

    /**
     * The standalone proof, for the correctness panel and the deployment log.
     * Runs both paths over the same query as the current user and reports the
     * delta. A non-zero delta is a demonstrated leak in the naive approach.
     */
    aclProof: function (table, field, query) {
        var fast = this.fastGroupBy(table, field, query);
        var fastTotal = 0, i;
        for (i = 0; i < fast.length; i++) fastTotal += fast[i].count;

        var secure = this.secureGroupBy(table, field, query);
        var secureTotal = 0;
        for (i = 0; i < secure.rows.length; i++) secureTotal += secure.rows[i].count;

        return {
            table: table, field: field, query: query || '',
            user: gs.getUserName(), user_display: gs.getUserDisplayName(),
            table_can_read: this.canRead(table),
            aggregate_total: fastTotal,
            secure_total: secureTotal,
            leaked: fastTotal - secureTotal,
            capped: secure.capped
        };
    },

    canRead: function (table) {
        try { return new GlideRecord(table).canRead(); }
        catch (e) { return false; }
    },

    /* ══════════════════════════════════════════════════════════════════════
       Shape
       ══════════════════════════════════════════════════════════════════════ */

    /**
     * How much of a field is actually populated, over the viewer's own rows.
     *
     * This is the gate that stops the 99.7%-empty-subcategory failure. It is
     * deliberately computed on the permitted slice rather than the table: a fill
     * rate measured over rows the viewer cannot see would decide their drill
     * affordances using data they are not entitled to.
     */
    fillRate: function (table, field, query) {
        /* Derived from the grouping rather than counted separately. A group-by
           already returns the empty bucket, so the fill rate is arithmetic on
           data in hand; counting it independently cost two more table scans per
           field and returned the same answer. */
        var p = this.profile(table, field, query);
        return {
            total: p.total,
            filled: p.total - p.empty,
            rate: p.fill,
            capped: p.acl.capped
        };
    },

    /**
     * Profiles a column so a form can be fitted to the real shape of the data.
     * Returns distinct count, top share and concentration alongside the rows.
     */
    profile: function (table, field, query) {
        var pk = table + '|' + field + '|' + (query || '');
        if (this._profiles[pk]) return this._profiles[pk];
        var g = this.tieredGroupBy(table, field, query);
        var rows = g.rows;
        var total = 0, i;
        for (i = 0; i < rows.length; i++) total += rows[i].count;

        var distinct = rows.length;
        var topShare = (total > 0 && distinct > 0) ? rows[0].count / total : 0;

        /* Share of the mass held by the top fifth of categories. High means a
           ranked bar of the head tells the story; low means the total is spread
           and area carries it better than length. */
        var headN = Math.max(1, Math.ceil(distinct * 0.2));
        var headSum = 0;
        for (i = 0; i < headN && i < rows.length; i++) headSum += rows[i].count;

        /* Are all groups the same size? A bar chart of equal bars says less than
           one number plus a note, so the form engine demotes it. */
        var zeroVariance = distinct > 1;
        for (i = 1; i < rows.length; i++) {
            if (rows[i].count !== rows[0].count) { zeroVariance = false; break; }
        }

        var emptyCount = 0;
        for (i = 0; i < rows.length; i++) {
            if (rows[i].key === '') { emptyCount = rows[i].count; break; }
        }

        var out = {
            table: table, field: field,
            total: total,
            distinct: distinct,
            /* The empty bucket is not a category. Excluded from distinct so a
               field with two real values plus blanks does not look like three. */
            distinctNonEmpty: emptyCount > 0 ? distinct - 1 : distinct,
            empty: emptyCount,
            fill: total > 0 ? (total - emptyCount) / total : 1,
            topShare: round3(topShare),
            concentration: round3(total > 0 ? headSum / total : 0),
            zeroVariance: zeroVariance,
            rows: rows,
            acl: g.acl
        };
        this._profiles[pk] = out;
        return out;
    },

    /**
     * Cross-tabulation for a heatmap or a matrix. Secure throughout: there is no
     * fast path for a two-dimensional group-by that could be proved cheaply, so
     * this one always pays.
     */
    crossTab: function (table, fieldA, fieldB, query) {
        var cells = {}, aKeys = {}, bKeys = {}, aLabels = {}, bLabels = {};
        var scanned = 0, capped = false;

        var gr = new GlideRecordSecure(table);
        if (query) gr.addEncodedQuery(query);
        gr.query();
        while (gr.next()) {
            if (scanned >= CmdData.SECURE_SCAN_CAP) { capped = true; break; }
            scanned++;
            var a = gr.getValue(fieldA) || '';
            var b = gr.getValue(fieldB) || '';
            if (aLabels[a] === undefined) aLabels[a] = gr.getDisplayValue(fieldA) || a;
            if (bLabels[b] === undefined) bLabels[b] = gr.getDisplayValue(fieldB) || b;
            aKeys[a] = 1; bKeys[b] = 1;
            var k = a + ' ' + b;
            cells[k] = (cells[k] || 0) + 1;
        }

        var rows = objKeys(aKeys), cols = objKeys(bKeys);
        var grid = [];
        for (var i = 0; i < rows.length; i++) {
            var line = [];
            for (var j = 0; j < cols.length; j++) {
                line.push(cells[rows[i] + ' ' + cols[j]] || 0);
            }
            grid.push(line);
        }

        return {
            rowKeys: rows, colKeys: cols,
            rowLabels: mapLabels(rows, aLabels), colLabels: mapLabels(cols, bLabels),
            grid: grid, scanned: scanned, capped: capped
        };
    },

    /* ══════════════════════════════════════════════════════════════════════
       Time
       ══════════════════════════════════════════════════════════════════════ */

    /**
     * A time series at a given grain.
     *
     * One bounded count per bucket rather than grouping the datetime column,
     * because grouping a timestamp directly buckets per second and yields one
     * group per record. That mistake is exactly why the instance draws
     * `sys_created_on` as a scalar.
     *
     * The final bucket is marked `partial` when it contains now, because its dip
     * is an artefact of when you looked and the renderer must dash it rather than
     * let a viewer read it as a fall.
     */
    periodSeries: function (table, dateField, grain, buckets, query) {
        grain = grain || 'month';
        buckets = buckets || 12;

        var series = [];
        var now = new GlideDateTime();

        for (var i = buckets - 1; i >= 0; i--) {
            var b = this._bucketBounds(now, grain, i);
            var q = dateField + '>=' + b.from + '^' + dateField + '<' + b.to;
            if (query) q = query + '^' + q;

            var c = this.fastCount(table, q);
            series.push({
                period: b.key,
                label: b.label,
                count: c,
                partial: i === 0
            });
        }
        return series;
    },

    /**
     * How far a date field actually spreads, in one query.
     *
     * MIN and MAX plus a non-empty count is enough to know whether a field is worth
     * drawing a trend from, and it costs one grouped query. The obvious alternative,
     * bucketing the field and counting how many buckets are occupied, costs one
     * query per bucket: trying five candidate date fields over a twelve-month window
     * that way is sixty queries, which measured out slower than the page it was
     * meant to improve.
     *
     * Returns {nonEmpty, min, max, monthsSpanned}.
     */
    dateSpread: function (table, field, query) {
        var ck = 'spread|' + table + '|' + field + '|' + (query || '');
        if (this._counts[ck]) return this._counts[ck];

        var q = field + 'ISNOTEMPTY';
        if (query) q = query + '^' + q;

        /* Two ordered single-row reads, not GlideAggregate.
         *
         * GlideAggregate cannot be trusted for MIN and MAX on a datetime on this
         * release. Measured on incident.opened_at, whose real range is 2015-08-12 to
         * 2026-08-28:
         *
         *   addAggregate('COUNT') + MIN + MAX   -> count=1, min==max, silently
         *                                          behaves as a group-by
         *   addAggregate('MIN', f) alone        -> 2015-08-12   correct
         *   addAggregate('MAX', f) alone        -> 2015-08-12   WRONG, returns the min
         *   orderBy(f).setLimit(1)              -> 2015-08-12   correct
         *   orderByDesc(f).setLimit(1)          -> 2026-08-28   correct
         *
         * So MAX is quietly wrong and the combined form is quietly a group-by. Two
         * ordered reads of one row each are indexed, cheap, and right.
         *
         * Secure rather than raw, because this decides what the viewer is shown and
         * the range of rows they cannot read is not theirs to influence.
         */
        var out = { nonEmpty: 0, min: '', max: '', monthsSpanned: 0,
                    monthsSinceMax: 9999 };

        var lo = new GlideRecordSecure(table);
        lo.addEncodedQuery(q);
        lo.orderBy(field);
        lo.setLimit(1);
        lo.query();
        if (lo.next()) out.min = lo.getValue(field) || '';

        if (out.min) {
            var hi = new GlideRecordSecure(table);
            hi.addEncodedQuery(q);
            hi.orderByDesc(field);
            hi.setLimit(1);
            hi.query();
            if (hi.next()) out.max = hi.getValue(field) || '';

            out.nonEmpty = this.fastCount(table, q);

            if (out.max && out.min.length >= 7 && out.max.length >= 7) {
                var y0 = parseInt(out.min.substr(0, 4), 10);
                var m0 = parseInt(out.min.substr(5, 2), 10);
                var y1 = parseInt(out.max.substr(0, 4), 10);
                var m1 = parseInt(out.max.substr(5, 2), 10);
                if (!isNaN(y0) && !isNaN(y1)) {
                    out.monthsSpanned = ((y1 - y0) * 12 + (m1 - m0)) + 1;
                    /* Span alone is not enough. A field can span fifteen years and
                       stop in 2019, in which case a twelve-month trend drawn from it
                       is twelve empty buckets. How recent the newest value is decides
                       whether the window has anything in it at all. */
                    var nowV = new GlideDateTime().getValue();
                    var ny = parseInt(nowV.substr(0, 4), 10);
                    var nm = parseInt(nowV.substr(5, 2), 10);
                    out.monthsSinceMax = (ny - y1) * 12 + (nm - m1);
                    if (out.monthsSinceMax < 0) out.monthsSinceMax = 0;
                }
            }
        }

        this._counts[ck] = out;
        return out;
    },

    /**
     * Demand by day of week against hour of day. A cycle, not a series, which is
     * why it gets a calendar heatmap and not a line.
     */
    hourOfWeek: function (table, dateField, query) {
        var grid = [];
        for (var d = 0; d < 7; d++) {
            grid.push([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
                       0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
        }
        var scanned = 0, capped = false;

        var gr = new GlideRecordSecure(table);
        var q = dateField + 'ISNOTEMPTY';
        if (query) q = query + '^' + q;
        gr.addEncodedQuery(q);
        gr.query();
        while (gr.next()) {
            if (scanned >= CmdData.SECURE_SCAN_CAP) { capped = true; break; }
            scanned++;
            var gdt = new GlideDateTime(gr.getValue(dateField));
            /* getDayOfWeekUTC is 1=Monday through 7=Sunday. */
            var dow = gdt.getDayOfWeekUTC() - 1;
            var hour = parseInt(gdt.getValue().substr(11, 2), 10);
            if (dow >= 0 && dow < 7 && hour >= 0 && hour < 24) grid[dow][hour]++;
        }
        return { grid: grid, scanned: scanned, capped: capped };
    },

    /* ══════════════════════════════════════════════════════════════════════
       Measures
       ══════════════════════════════════════════════════════════════════════ */

    /**
     * SUM, AVG, MIN and MAX of a numeric field, by group.
     *
     * Secure iteration, because the same ACL problem applies and is worse: a SUM
     * over rows the viewer cannot read is not merely a wrong count, it discloses
     * the magnitude of data they have no access to.
     */
    measureByGroup: function (table, measureField, groupField, query) {
        var sums = {}, ns = {}, mins = {}, maxs = {}, labels = {};
        var scanned = 0, capped = false, anyNegative = false;

        var gr = new GlideRecordSecure(table);
        var q = measureField + 'ISNOTEMPTY';
        if (query) q = query + '^' + q;
        gr.addEncodedQuery(q);
        gr.query();
        while (gr.next()) {
            if (scanned >= CmdData.SECURE_SCAN_CAP) { capped = true; break; }
            scanned++;
            var v = parseFloat(gr.getValue(measureField));
            if (isNaN(v)) continue;
            if (v < 0) anyNegative = true;

            var k = groupField ? (gr.getValue(groupField) || '') : '';
            if (labels[k] === undefined) {
                labels[k] = groupField ? (gr.getDisplayValue(groupField) || k) : '';
            }
            sums[k] = (sums[k] || 0) + v;
            ns[k] = (ns[k] || 0) + 1;
            if (mins[k] === undefined || v < mins[k]) mins[k] = v;
            if (maxs[k] === undefined || v > maxs[k]) maxs[k] = v;
        }

        var rows = [];
        for (var key in sums) {
            if (!sums.hasOwnProperty(key)) continue;
            rows.push({
                key: key, label: labels[key],
                sum: round3(sums[key]),
                avg: round3(sums[key] / ns[key]),
                min: round3(mins[key]), max: round3(maxs[key]),
                n: ns[key]
            });
        }
        rows.sort(function (a, b) { return b.sum - a.sum; });

        return { rows: rows, scanned: scanned, capped: capped, signed: anyNegative };
    },

    /**
     * Elapsed hours between two date fields, by group. Generalised rather than
     * hard-coded to opened_at and resolved_at, because the product covers audit
     * engagements, projects and contracts as well as incidents, and every one of
     * those measures duration between a different pair of columns.
     */
    durationHours: function (table, startField, endField, groupField, query) {
        var sums = {}, ns = {}, labels = {};
        var scanned = 0, capped = false, skipped = 0;

        var q = startField + 'ISNOTEMPTY^' + endField + 'ISNOTEMPTY';
        if (query) q = query + '^' + q;

        var gr = new GlideRecordSecure(table);
        gr.addEncodedQuery(q);
        gr.query();
        while (gr.next()) {
            if (scanned >= CmdData.SECURE_SCAN_CAP) { capped = true; break; }
            scanned++;
            var a = new GlideDateTime(gr.getValue(startField));
            var b = new GlideDateTime(gr.getValue(endField));
            var hrs = GlideDateTime.subtract(a, b).getNumericValue() / 3600000;
            /* A negative elapsed time is dirty data, not a fast resolution.
               Counted and excluded rather than silently averaged in. */
            if (hrs < 0) { skipped++; continue; }

            var k = groupField ? (gr.getValue(groupField) || '') : '';
            if (labels[k] === undefined) {
                labels[k] = groupField ? (gr.getDisplayValue(groupField) || k) : '';
            }
            sums[k] = (sums[k] || 0) + hrs;
            ns[k] = (ns[k] || 0) + 1;
        }

        var rows = [];
        for (var key in sums) {
            if (!sums.hasOwnProperty(key)) continue;
            rows.push({ key: key, label: labels[key],
                        hours: round1(sums[key] / ns[key]), n: ns[key] });
        }
        rows.sort(function (a, b) { return b.hours - a.hours; });

        return { rows: rows, scanned: scanned, capped: capped, skipped: skipped };
    },

    /* ── internals ── */

    _label: function (ga, field, raw) {
        if (raw === null || raw === '') return '';
        var d = ga.getDisplayValue(field);
        return d || String(raw);
    },

    /**
     * Bounds of the i-th bucket back from `now`, at the given grain. Returns
     * platform-format strings so they can go straight into an encoded query.
     */
    _bucketBounds: function (now, grain, back) {
        var c = new GlideDateTime(now);
        var from, to, key, label;

        if (grain === 'day') {
            c.addDaysUTC(-back);
            key = c.getValue().substr(0, 10);
            from = key + ' 00:00:00';
            var n1 = new GlideDateTime(from); n1.addDaysUTC(1);
            to = n1.getValue();
            label = key.substr(5);
        } else if (grain === 'week') {
            c.addDaysUTC(-back * 7);
            /* Snap to Monday. getDayOfWeekUTC is 1=Monday. */
            c.addDaysUTC(-(c.getDayOfWeekUTC() - 1));
            key = c.getValue().substr(0, 10);
            from = key + ' 00:00:00';
            var n2 = new GlideDateTime(from); n2.addDaysUTC(7);
            to = n2.getValue();
            label = 'w/c ' + key.substr(5);
        } else if (grain === 'quarter') {
            c.addMonthsUTC(-back * 3);
            var m = parseInt(c.getValue().substr(5, 2), 10);
            var qStart = m - ((m - 1) % 3);
            var ym = c.getValue().substr(0, 4) + '-' + pad2(qStart);
            key = ym;
            from = ym + '-01 00:00:00';
            var n3 = new GlideDateTime(from); n3.addMonthsUTC(3);
            to = n3.getValue();
            label = 'Q' + Math.ceil(qStart / 3) + " '" + c.getValue().substr(2, 2);
        } else {
            c.addMonthsUTC(-back);
            key = c.getValue().substr(0, 7);
            from = key + '-01 00:00:00';
            var n4 = new GlideDateTime(from); n4.addMonthsUTC(1);
            to = n4.getValue();
            label = MONTHS[parseInt(key.substr(5, 2), 10) - 1] + " '" + key.substr(2, 2);
        }

        return { from: from, to: to, key: key, label: label };
    },

    type: 'CmdData'
};

var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
              'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function pad2(n) { return n < 10 ? '0' + n : String(n); }
function round1(v) { return Math.round(v * 10) / 10; }
function round3(v) { return Math.round(v * 1000) / 1000; }

function objKeys(o) {
    var out = [];
    for (var k in o) { if (o.hasOwnProperty(k)) out.push(k); }
    return out;
}

function mapLabels(keys, labels) {
    var out = [];
    for (var i = 0; i < keys.length; i++) {
        out.push(labels[keys[i]] === undefined || labels[keys[i]] === ''
            ? '(empty)' : labels[keys[i]]);
    }
    return out;
}
