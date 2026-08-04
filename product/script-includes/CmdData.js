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

/* Rows to observe before extrapolating what a full permission proof would cost.
 *
 * Low enough to bail out of a hopeless proof quickly, high enough that the
 * estimate is not dominated by the first few rows, which are always the slowest
 * while caches warm. Fifty rows costs incident about 10ms and kb_knowledge about
 * 250ms, and either is enough to tell the two apart by an order of magnitude. */
CmdData.PREDICT_AFTER = 50;

/* Wall-clock budget for one secure group-by, the per-panel fallback when the ACL
   verdict is not trusted. Smaller than the proof budget because a page runs several
   of these where it runs one proof. */
CmdData.GROUP_MS = 1200;

/* Wall-clock budget for the shared reduction pass, and the cap on raw values any
   one accumulator will retain.
 *
 * The budget is larger than GROUP_MS on purpose: this single scan replaces what
 * used to be one scan per rich panel, so it is allowed to cost more than any one of
 * them did while costing far less than all of them together.
 *
 * The value cap exists because quantiles and equal-width bins need the values
 * themselves, not a running total. 20,000 numbers is a few hundred KB in Rhino and
 * is bounded by SECURE_SCAN_CAP anyway; it is named here so the memory cost of a
 * box plot is a stated number rather than an accident. */
CmdData.REDUCE_MS = 3000;

/* Cumulative scan time one request may spend, across every reduction it runs.
 *
 * The ceiling that actually bounds a page. Per-scan budgets bound a scan; only
 * this bounds the page, because the number of scans is decided by the data and
 * not by the code. When it is exhausted, further reductions do not run and the
 * page reports fewer panels rather than taking longer. */
CmdData.SCAN_ALLOWANCE_MS = 5000;

/* The smallest slice a permission-checked count may have, even with the request
   allowance exhausted. A count of zero would be read as "there are no records"
   rather than as "this was not measured", and the difference matters more than
   the quarter second. */
CmdData.MIN_COUNT_MS = 250;

/* Distinct display values resolved per field before falling back to the stored
 * value.
 *
 * getDisplayValue on a reference field is a join. Caching by raw value already
 * collapses it to one lookup per distinct value, which is the right first move,
 * but on a high-cardinality reference -- an assignee, a caller, a configuration
 * item -- "one per distinct value" is still hundreds of joins spread through the
 * scan.
 *
 * Measured, this is now the dominant cost, not the ACL: on incident, whose raw
 * cursor runs at 0.11ms per row, a sixteen-accumulator scan ran at 2.25ms per row.
 * The permission check was not what made it slow.
 *
 * Sixty is far past anything a chart displays -- the widest form here shows twelve
 * categories and folds the rest into Other -- so the cap costs nothing visible.
 * Past it the stored value is used as the label, which is correct if less pretty,
 * and only ever for values already deep in a tail nobody is reading. */
CmdData.LABEL_CAP = 60;
CmdData.VALUE_CAP = 20000;

/* Cap on scatter points carried to the browser.
 *
 * This is a payload bound, not a scan bound. 4,000 points is about 90 KB of JSON
 * after rounding, which fits the 250 KB page budget alongside everything else, and
 * it is already more marks than a 520-wide plot can separate. Beyond this the
 * points are dropped and the count of dropped ones is reported, because a scatter
 * silently showing a third of the data is worse than one that says so. */
CmdData.PAIR_CAP = 4000;

/* Where the whiskers of a box plot stop. 1.5 times the interquartile range is the
   Tukey convention; anything past it is drawn as an individual outlier rather than
   absorbed into the whisker, because those records are the ones worth clicking. */
CmdData.IQR_WHISKER = 1.5;
/* Cap on outliers retained per group, so one pathological column cannot put ten
   thousand dots in the payload. The count is reported either way. */
CmdData.OUTLIER_CAP = 40;

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
        this._planned = null;
        /* Request-level scan accounting, so a page can report what it spent and
           what it went without, rather than either being invisible. */
        this._scanSpent = 0;
        this._scans = 0;
        this._starved = 0;
        this._scanLog = [];
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
                ? (proof.predictedMs > 0
                    ? 'a full permission check of ' + proof.target + ' rows was ' +
                      'measured at about ' + Math.round(proof.predictedMs / 100) / 10 +
                      's from the first ' + proof.count + ', which does not fit the ' +
                      'budget, so counts are a floor'
                    : 'permission check stopped after ' + CmdData.PROOF_MS + 'ms at ' +
                      proof.count + ' rows, so counts are a floor')
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

        /* How many rows a complete proof would have to admit. Known up front and
           cheaply, because the unchecked count is an indexed aggregate. */
        var target = this.fastCount(table, query);

        /* Subject to the request allowance like any other scan.
         *
         * This charged the allowance but never checked it, and that was the whole
         * remaining overshoot: measured on `task`, the two planned reductions
         * honoured their budgets and stopped at 5s, and then the period-comparison
         * counts opened two more proofs of 615ms and 1853ms on top, because nothing
         * told them the budget was gone. A floor is kept so that a late count
         * returns a small honest lower bound rather than a zero, which would read
         * as "no records" rather than as "not measured". */
        var allowance = CmdData.SCAN_ALLOWANCE_MS - this._scanSpent;
        budgetMs = Math.min(budgetMs, Math.max(CmdData.MIN_COUNT_MS, allowance));

        var t0 = new Date().getTime();
        var gr = new GlideRecordSecure(table);
        if (query) gr.addEncodedQuery(query);
        gr.setLimit(CmdData.SECURE_SCAN_CAP + 1);
        gr.query();

        var n = 0, capped = false, timedOut = false, predicted = 0;
        while (gr.next()) {
            if (n >= CmdData.SECURE_SCAN_CAP) { capped = true; break; }
            n++;

            if (n % CmdData.CHECK_EVERY === 0) {
                var spent = new Date().getTime() - t0;
                if (spent > budgetMs) { timedOut = true; break; }

                /* Don't start what you cannot finish.
                 *
                 * The proof either completes, and the table is trusted, or it does
                 * not, and the answer is "cannot tell" -- a partial proof is worth
                 * exactly nothing, because a scan that stopped early cannot show
                 * that the rows it never reached were readable.
                 *
                 * So once enough rows have gone by to estimate the per-row cost,
                 * extrapolate to the full count. If finishing is not possible within
                 * the budget, stop immediately rather than spending the whole budget
                 * to arrive at the same "cannot tell". Measured on task and
                 * kb_knowledge, whose ACLs cost 2.9ms and 5.0ms per row against
                 * incident's 0.2ms, this turns 2.5 wasted seconds into about 0.15
                 * and reaches an identical verdict.
                 *
                 * It can only ever cause an earlier BOUNDED, never a wrong VERIFIED,
                 * so the correctness claim is untouched. */
                if (n >= CmdData.PREDICT_AFTER && target > n) {
                    predicted = (spent / n) * target;
                    if (predicted > budgetMs) { timedOut = true; break; }
                }
            }
        }

        /* Charged against the request allowance like any other scan. It reads rows
           and pays the per-row ACL cost, so leaving it out of the accounting would
           understate exactly the pages that need the accounting most. */
        var took = new Date().getTime() - t0;
        this._scanSpent += took;
        this._scans++;
        this._scanLog.push({ via: 'proof', ms: took, rows: n, budget: budgetMs });

        this._counts[ck] = { count: n, capped: capped, timedOut: timedOut,
                             predictedMs: Math.round(predicted),
                             target: target, ms: took };
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

        /* Not trusted, so pay for the correct answer -- through reduce(), so that
         * this scan is subject to the same request-level allowance as every other
         * one and can be satisfied by the page scan if it already covered the field.
         *
         * It used to call secureGroupBy directly, which put it outside the
         * accounting entirely. That was the missing five seconds on `task`: the page
         * scan honoured its allowance and reported two scans, while the drill gates
         * quietly opened six more group-bys of their own, each inside its own 1.2s
         * budget and none of them counted. Every individual query was bounded and
         * the page still took ten seconds, which is the same failure this budget has
         * now been rewritten three times to catch. */
        var g = this._one(table, query, this.specs.group(field), CmdData.GROUP_MS);
        var rows = g.rows || [];
        var total = 0;
        for (var i = 0; i < rows.length; i++) total += rows[i].count;
        return {
            rows: rows,
            acl: { mode: g.capped ? 'BOUNDED' : 'FILTERED',
                   aggregate: v.aggregate, secure: total,
                   delta: v.aggregate - total, capped: !!g.capped }
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
    /**
     * Profiles several columns in one permission-checked pass, seeding the memo.
     *
     * Only worth calling when the verdict is not trusted, and then it is worth a
     * great deal. profile() goes through tieredGroupBy, which on an untrusted table
     * means one full secure scan per field: measured on `task`, six candidate
     * dimensions cost 7,408ms as six scans over the identical rows. The expensive
     * step is admitting each row, and admitting it once to read six values is the
     * same work as admitting it once to read one.
     *
     * This does not change any answer. It computes exactly what six profile() calls
     * would and stores them under the same keys, so callers keep calling profile()
     * and simply find it already done.
     */
    warmProfiles: function (table, fields, query, budgetMs) {
        var v = this.aclVerdict(table, query);
        if (v.denied || v.trusted) return;      /* fast path is already cheap */

        var todo = [], i;
        for (i = 0; i < fields.length; i++) {
            var pk = table + '|' + fields[i] + '|' + (query || '');
            if (!this._profiles[pk]) todo.push(fields[i]);
        }
        if (todo.length < 2) return;            /* one field is not worth batching */

        /* Through the group accumulator rather than secureMultiGroupBy, so that a
           planScan covering these fields has already computed them and this becomes
           free. Going through a second, parallel batching path would re-scan the
           table to recompute numbers the page scan already holds. */
        for (i = 0; i < todo.length; i++) {
            var g = this._one(table, query, this.specs.group(todo[i]),
                              budgetMs || CmdData.GROUP_MS);
            var rows = g.rows || [];
            var total = 0, j;
            for (j = 0; j < rows.length; j++) total += rows[j].count;
            this._profiles[table + '|' + todo[i] + '|' + (query || '')] =
                this._shape(table, todo[i], rows, total, {
                    mode: g.capped ? 'BOUNDED' : 'FILTERED',
                    aggregate: v.aggregate, secure: total,
                    delta: v.aggregate - total, capped: !!g.capped
                });
        }
    },

    profile: function (table, field, query) {
        var pk = table + '|' + field + '|' + (query || '');
        if (this._profiles[pk]) return this._profiles[pk];
        var g = this.tieredGroupBy(table, field, query);
        var rows = g.rows;
        var total = 0, i;
        for (i = 0; i < rows.length; i++) total += rows[i].count;
        var out = this._shape(table, field, rows, total, g.acl);
        this._profiles[pk] = out;
        return out;
    },

    /**
     * The shape of a grouped column: distinct, fill, concentration.
     *
     * Extracted so that warmProfiles() and profile() cannot drift. They arrive at
     * the same rows by different routes -- one batched scan against one scan per
     * field -- and if the derived shape differed between them, a page would silently
     * change which chart it drew depending on whether the batch had run.
     */
    _shape: function (table, field, rows, total, acl) {
        var i;

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

        return {
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
            acl: acl
        };
    },

    /**
     * Cross-tabulation for a heatmap or a matrix. Secure throughout: there is no
     * fast path for a two-dimensional group-by that could be proved cheaply, so
     * this one always pays.
     *
     * A thin wrapper over reduce(), which is where the scan actually lives. Kept as
     * a named method because a caller wanting exactly one crosstab should not have
     * to assemble a spec list to get it.
     */
    crossTab: function (table, fieldA, fieldB, query, budgetMs) {
        return this._one(table, query, this.specs.cross(fieldA, fieldB), budgetMs);
    },

    /* ══════════════════════════════════════════════════════════════════════
       The shared reduction pass

       One bounded, permission-checked scan that feeds many accumulators.

       This exists because of a cost asymmetry that decides the whole design. In a
       secure scan the expensive step is the ACL evaluation admitting the row, not
       reading fields off it once admitted: measured on this instance, admission
       costs 40 to 86ms per row on kb_knowledge, while pulling four more values off
       an already-admitted row is not separately measurable. So N rich panels over
       the same rows should cost one scan, not N.

       Before this, each of crossTab, hourOfWeek, measureByGroup and durationHours
       opened its own GlideRecordSecure with no time budget and no memoisation. Any
       one of them on a slow table could run for a quarter of an hour, which is why
       none of them were ever wired into a page: they were correct and unusable.
       Making them accumulators over a shared, time-boxed scan is what makes the
       rich forms affordable at all.

       Every accumulator is bounded by the same clock, so a page cannot be made slow
       by asking for one more panel — asking for more panels makes each one's share
       of the scan smaller, and the truncation is reported rather than hidden.
       ══════════════════════════════════════════════════════════════════════ */

    /**
     * Run several reductions over one permission-checked pass.
     *
     * @param table  the table to scan
     * @param query  encoded query, may be empty
     * @param specs  array of accumulator specs, each with a unique `id`:
     *
     *   {id, kind:'group',     field}
     *        counts by one field                         -> {rows}
     *   {id, kind:'cross',     fieldA, fieldB}
     *        two-dimensional counts                      -> {rowKeys,colKeys,grid,...}
     *   {id, kind:'timegroup', dateField, grain, groupField, buckets}
     *        one series per group over time              -> {periods, series}
     *        groupField omitted gives a single series, which is the ACL-correct
     *        replacement for twelve fastCount() calls.
     *   {id, kind:'measure',   field, groupField}
     *        sum/avg/min/max/n by group, plus the values -> {rows}
     *        Values are retained per group up to VALUE_CAP so quantiles come free.
     *   {id, kind:'numeric',   field}
     *        the values of one numeric column            -> {values, n, ...}
     *   {id, kind:'pair',      xField, yField, groupField}
     *        measure against measure                     -> {points}
     *   {id, kind:'duration',  startField, endField, groupField}
     *        elapsed hours by group                      -> {rows, skipped}
     *   {id, kind:'dow',       dateField}
     *        day-of-week against hour-of-day             -> {grid}
     *   {id, kind:'day',       dateField, days}
     *        counts per calendar day                     -> {days, byDay}
     *
     * @return {{results:{}, scanned:number, capped:boolean, timedOut:boolean, ms:number}}
     */
    reduce: function (table, query, specs, budgetMs) {
        var i, j;

        /* Memoised on the full spec list. A page assembles its specs once and hands
           them over once, but the drill gates and the matrix can ask for overlapping
           reductions, and re-scanning a table to recompute an answer already in hand
           is the exact fault that made the first build take sixty seconds. */
        var ck = 'red|' + table + '|' + (query || '') + '|' + this._specKey(specs);
        if (this._counts[ck]) return this._counts[ck];

        /* The request-level scan allowance.
         *
         * Every individual scan being bounded is not the same as the page being
         * bounded, and this is the third time that distinction has cost a rewrite.
         * Bounding each query still allowed a 17s page; bounding each panel still
         * allowed a 28s one; and after the shared scan was introduced, two planned
         * scans plus a handful of unplanned ones still reached 12.8s on `task`,
         * because the ceiling was per scan and the number of scans was not fixed.
         *
         * So the budget that matters is cumulative and belongs to the request. Once
         * it is gone, further scans do not run at all: they return empty and say so,
         * which degrades a page to fewer panels rather than to a slower one. That
         * makes the worst case arithmetic instead of data-dependent, which is the
         * same reasoning behind MAX_ATTEMPTS_PAST_DEADLINE.
         *
         * Note this deliberately cannot make a number wrong. A starved reduction
         * yields no panel; it never yields a panel computed from fewer rows without
         * saying so. */
        var remaining = CmdData.SCAN_ALLOWANCE_MS - this._scanSpent;
        if (remaining <= 0) {
            this._starved++;
            return { results: {}, scanned: 0, capped: true, timedOut: true,
                     starved: true, path: 'not run', ms: 0 };
        }

        budgetMs = Math.min(budgetMs || CmdData.REDUCE_MS, remaining);
        var t0 = new Date().getTime();
        this._scans++;

        /* Fields to read per row, deduplicated. Reading the same column twice
           because two accumulators both want it is free-ish but pointless, and the
           dedup also tells us the display-value fields to resolve. */
        var accs = [];
        for (i = 0; i < specs.length; i++) {
            var a = this._accumulator(specs[i]);
            if (a) accs.push(a);
        }
        if (!accs.length) {
            return { results: {}, scanned: 0, capped: false, timedOut: false, ms: 0 };
        }

        var needValue = {}, needDisplay = {};
        for (i = 0; i < accs.length; i++) {
            for (j = 0; j < accs[i].valueFields.length; j++) {
                needValue[accs[i].valueFields[j]] = 1;
            }
            for (j = 0; j < accs[i].displayFields.length; j++) {
                needDisplay[accs[i].displayFields[j]] = 1;
                needValue[accs[i].displayFields[j]] = 1;
            }
        }
        var valueFields = objKeys(needValue), displayFields = objKeys(needDisplay);

        /* Labels are resolved once per distinct key, not once per row.
         *
         * getDisplayValue on a reference field is a join, so resolving it per row on
         * a 20,000-row scan is 20,000 joins to learn a few dozen labels. Caching by
         * raw value collapses that to one lookup per distinct value. */
        var labelCache = {}, labelCount = {};
        for (i = 0; i < displayFields.length; i++) {
            labelCache[displayFields[i]] = {};
            labelCount[displayFields[i]] = 0;
        }

        /* The cursor, and the single biggest cost decision in this method.
         *
         * The expensive part of a secure scan is the ACL evaluation admitting each
         * row. Where the verdict has already *proved* that this viewer can read
         * every row matching this query, that evaluation is being paid for a
         * guarantee we already hold: measured on `incident`, six dimension profiles
         * take 71ms on the proven-safe path while each analysis panel was taking a
         * full 1,203ms secure scan over the same rows for the same answer.
         *
         * This is the identical justification tieredGroupBy already uses to reach
         * for fastGroupBy, applied to the reduction pass, and it is sound for the
         * same reason. It is also the only place in this file where an unchecked
         * cursor is opened, which is why the decision is made once, here, from the
         * verdict rather than from a caller's flag. */
        var trusted = this._trustedFor(table, query);
        var scanned = 0, capped = false, timedOut = false;
        var gr = trusted ? new GlideRecord(table) : new GlideRecordSecure(table);
        if (query) gr.addEncodedQuery(query);
        gr.setLimit(CmdData.SECURE_SCAN_CAP + 1);
        gr.query();

        var row = {};
        while (gr.next()) {
            if (scanned >= CmdData.SECURE_SCAN_CAP) { capped = true; break; }
            scanned++;

            for (i = 0; i < valueFields.length; i++) {
                var f = valueFields[i];
                var raw = gr.getValue(f);
                row[f] = (raw === null || raw === undefined) ? '' : String(raw);
            }
            for (i = 0; i < displayFields.length; i++) {
                var df = displayFields[i], rv = row[df];
                if (labelCache[df][rv] === undefined) {
                    if (rv === '') {
                        labelCache[df][rv] = '';
                    } else if (labelCount[df] < CmdData.LABEL_CAP) {
                        labelCache[df][rv] = gr.getDisplayValue(df) || rv;
                        labelCount[df]++;
                    } else {
                        /* Past the cap the stored value stands in for the label. */
                        labelCache[df][rv] = rv;
                    }
                }
            }

            for (i = 0; i < accs.length; i++) accs[i].row(row, labelCache);

            if (scanned % CmdData.CHECK_EVERY === 0 &&
                (new Date().getTime() - t0) > budgetMs) { timedOut = true; break; }
        }

        var results = {};
        for (i = 0; i < accs.length; i++) results[accs[i].id] = accs[i].done();

        var out = {
            results: results,
            scanned: scanned,
            capped: capped || timedOut,
            timedOut: timedOut,
            /* Recorded, not inferred. Which cursor produced a number is part of the
               answer, and a reviewer should be able to see it without re-deriving
               the verdict. */
            path: trusted ? 'proven-safe' : 'permission-checked',
            ms: new Date().getTime() - t0
        };
        this._scanSpent += out.ms;
        this._scanLog.push({ via: 'reduce', ms: out.ms, rows: out.scanned,
                             n: specs.length, budget: budgetMs });
        this._counts[ck] = out;
        return out;
    },

    /** What this request spent scanning, and what it therefore went without. */
    scanBudget: function () {
        return {
            spentMs: this._scanSpent,
            allowanceMs: CmdData.SCAN_ALLOWANCE_MS,
            scans: this._scans,
            starved: this._starved,
            exhausted: this._scanSpent >= CmdData.SCAN_ALLOWANCE_MS,
            log: this._scanLog
        };
    },

    /**
     * Whether an unchecked cursor is provably safe for this table and query.
     *
     * Trust is established per table and query by aclVerdict(). The reductions here
     * run against *narrowed* queries — a panel adds `field ISNOTEMPTY` or a date
     * window to whatever the page is already filtered by — and re-proving each one
     * would cost a 2.5s permission scan per panel, which is far worse than the
     * problem being solved.
     *
     * It does not need re-proving. If the viewer can read every row matching Q, then
     * they can read every row matching Q AND anything, because that is a subset. So
     * a trusted verdict transfers to any query that extends it, and this looks for
     * an established verdict whose query this one extends. An empty base query is a
     * prefix of everything, which is the common case: the page proves the whole
     * table once and every panel inherits it.
     *
     * The implication only runs one way. Trust established on a narrow slice says
     * nothing about the table, so a verdict is only ever borrowed by a query that
     * contains it, never the reverse. When nothing matches, the answer is no and the
     * scan is permission-checked.
     */
    _trustedFor: function (table, query) {
        query = query || '';
        var prefix = table + '|';
        for (var k in this._verdict) {
            if (!this._verdict.hasOwnProperty(k)) continue;
            if (k.substring(0, prefix.length) !== prefix) continue;
            if (!this._verdict[k].trusted) continue;
            var vq = k.substring(prefix.length);
            if (vq === '' || query === vq ||
                query.substring(0, vq.length + 1) === vq + '^') {
                return true;
            }
        }
        return false;
    },

    /* ══════════════════════════════════════════════════════════════════════
       The shared page scan

       One pass for a whole page, rather than one pass per panel.

       reduce() already collapses N accumulators into one scan, but only for
       callers that ask for them together, and the panel builders each ask
       separately. Measured on `task`: the ACL proof scanned ~880 rows, the trend
       re-scanned from row zero, the profiles re-scanned again, the matrix once
       more. Four passes over identical rows, each paying the 2.85ms-per-row ACL
       cost, each timing out somewhere different.

       That last part is not just slow, it is incoherent. A page whose trend
       stopped at 420 rows and whose profiles stopped at 880 is showing panels
       computed over different subsets of the same table, and their totals do not
       agree. Nothing reported this, because each scan was individually correct and
       individually labelled bounded.

       planScan fixes both. Everything a page needs is declared up front, one scan
       fills all of it, and every panel is therefore derived from exactly the same
       rows -- so when the scan is truncated, the whole page is truncated together
       and consistently.
       ══════════════════════════════════════════════════════════════════════ */

    /**
     * Spec factories.
     *
     * Shared so that a panel builder asking for a reduction on its own, and
     * planScan asking for the same reduction as part of a page, produce a byte
     * identical spec and therefore hit the same memo entry. If these were written
     * out twice the sharing would silently stop working the moment one copy gained
     * a parameter, and the only symptom would be that pages got slower again.
     */
    specs: {
        group: function (field) {
            return { id: 'g', kind: 'group', field: field };
        },
        cross: function (a, b) {
            return { id: 'x', kind: 'cross', fieldA: a, fieldB: b };
        },
        series: function (dateField, groupField, grain, buckets) {
            return { id: 's', kind: 'timegroup', dateField: dateField,
                     groupField: groupField || null, grain: grain || 'month',
                     buckets: buckets || 12 };
        },
        numeric: function (field) {
            return { id: 'n', kind: 'numeric', field: field };
        },
        measure: function (field, groupField) {
            return { id: 'm', kind: 'measure', field: field,
                     groupField: groupField || null };
        },
        pair: function (x, y, groupField) {
            return { id: 'p', kind: 'pair', xField: x, yField: y,
                     groupField: groupField || null };
        },
        duration: function (start, end, groupField) {
            return { id: 'd', kind: 'duration', startField: start, endField: end,
                     groupField: groupField || null };
        },
        dow: function (dateField) {
            return { id: 'h', kind: 'dow', dateField: dateField };
        },
        day: function (dateField, days) {
            return { id: 'd', kind: 'day', dateField: dateField, days: days || 182 };
        }
    },

    /** One reduction, memoised, and satisfied by a prior planScan if there was one. */
    _one: function (table, query, spec, budgetMs) {
        var r = this.reduce(table, query, [spec], budgetMs);
        /* A starved scan has no results at all, and the caller must still get the
           shape it expects. Returning a bare {} here meant every builder that
           reached for `.periods[2]` or `.points[0]` threw instead of simply having
           nothing to draw -- which turned "we ran out of scan budget", a condition
           this design deliberately allows, into an error note on the page. */
        var out = r.results[spec.id];
        if (!out) {
            out = this._emptyFor(spec);
            out.starved = true;
        }
        return this._withScan(out, r);
    },

    /**
     * The well-formed empty result for a spec.
     *
     * Shapes, not values: every array a builder might index into exists and is
     * empty, so the builder's own guards do their job and it declines to draw a
     * panel rather than failing to build one.
     */
    _emptyFor: function (spec) {
        switch (spec.kind) {
        case 'group':
            return { rows: [] };
        case 'cross':
            return { rowKeys: [], colKeys: [], rowLabels: [], colLabels: [],
                     rowTotals: [], colTotals: [], grid: [], maxCell: 0, grand: 0 };
        case 'timegroup':
            return { periods: [], series: [], outside: 0, grain: spec.grain };
        case 'measure':
            return { rows: [], signed: false, truncatedValues: false };
        case 'numeric':
            return { values: [], n: 0, sum: 0, mean: 0, signed: false,
                     min: 0, max: 0, q1: 0, median: 0, q3: 0, lo: 0, hi: 0,
                     outliers: [], outlierCount: 0,
                     bins: { bins: [], lo: 0, hi: 0, width: 0 } };
        case 'pair':
            return { points: [], dropped: 0, corr: null };
        case 'duration':
            return { rows: [], skipped: 0 };
        case 'dow':
            return { grid: [], maxCell: 0, total: 0 };
        case 'day':
            return { byDay: {}, days: spec.days || 0, maxCell: 0, total: 0 };
        default:
            return {};
        }
    },

    /**
     * Run every reduction a page needs in a single pass.
     *
     * Each spec's result is written to the memo under the key a lone reduce() call
     * for that spec would have produced, so the panel builders need no knowledge of
     * this at all: they call seriesByGroup() or crossTab() exactly as before and
     * find the answer already computed.
     *
     * @return the raw reduction, whose `scanned` and `capped` describe the whole
     *         page rather than any one panel
     */
    planScan: function (table, query, specs, budgetMs) {
        if (!specs || !specs.length) return null;

        var temp = [], i, k;
        for (i = 0; i < specs.length; i++) {
            var copy = {};
            for (k in specs[i]) {
                if (specs[i].hasOwnProperty(k)) copy[k] = specs[i][k];
            }
            /* Unique within this scan; the original id is restored when the result
               is filed, because that is the id the lone caller will look under. */
            copy.id = 'p' + i;
            temp.push(copy);
        }

        var r = this.reduce(table, query, temp, budgetMs);

        for (i = 0; i < specs.length; i++) {
            this._file(table, query, specs[i], r, 'p' + i);
        }
        this._planned = { table: table, query: query || '', scanned: r.scanned,
                          capped: r.capped, path: r.path, ms: r.ms,
                          reductions: specs.length };
        return r;
    },

    /** Files one result from a shared scan under its lone-call memo key. */
    _file: function (table, query, spec, r, tempId) {
        var results = {};
        results[spec.id] = r.results[tempId];
        var ck = 'red|' + table + '|' + (query || '') + '|' + this._specKey([spec]);
        this._counts[ck] = {
            results: results, scanned: r.scanned, capped: r.capped,
            timedOut: r.timedOut, path: r.path, ms: r.ms, shared: true
        };
    },

    /** What the shared scan did, for the page to report honestly. */
    plannedScan: function () { return this._planned || null; },

    /**
     * Builds one accumulator. Each returns {id, valueFields, displayFields, row, done}.
     *
     * `row` is called once per admitted record with the already-read values, so an
     * accumulator never touches the GlideRecord and cannot accidentally issue a
     * query inside the scan loop.
     */
    _accumulator: function (spec) {
        var self = this;
        var id = spec.id;

        if (spec.kind === 'group') {
            var gc = {}, gl = {};
            return {
                id: id, valueFields: [], displayFields: [spec.field],
                row: function (r, lc) {
                    var k = r[spec.field];
                    gc[k] = (gc[k] || 0) + 1;
                    if (gl[k] === undefined) gl[k] = lc[spec.field][k];
                },
                done: function () { return { rows: rowsFrom(gc, gl) }; }
            };
        }

        if (spec.kind === 'cross') {
            /* Nested objects, not a composite string key.
             *
             * The previous implementation joined the two keys with a literal NUL byte
             * embedded in the source. It worked in Rhino and was invisible in every
             * editor, but a raw NUL inside a sys_script_include field is not
             * something to rely on surviving transport, and an invisible separator
             * is not something a reviewer can check. Nesting removes the question. */
            var cells = {}, aK = {}, bK = {}, aL = {}, bL = {};
            return {
                id: id, valueFields: [], displayFields: [spec.fieldA, spec.fieldB],
                row: function (r, lc) {
                    var a = r[spec.fieldA], b = r[spec.fieldB];
                    if (aL[a] === undefined) { aL[a] = lc[spec.fieldA][a]; aK[a] = 1; }
                    if (bL[b] === undefined) { bL[b] = lc[spec.fieldB][b]; bK[b] = 1; }
                    if (!cells[a]) cells[a] = {};
                    cells[a][b] = (cells[a][b] || 0) + 1;
                },
                done: function () {
                    var rowKeys = objKeys(aK), colKeys = objKeys(bK), g = [], t;
                    /* Ordered by mass so the dense corner of the grid is top-left
                       and the reader's eye lands on the cells that matter. */
                    var rt = {}, ct = {};
                    for (t = 0; t < rowKeys.length; t++) {
                        rt[rowKeys[t]] = sumObj(cells[rowKeys[t]]);
                    }
                    for (t = 0; t < colKeys.length; t++) {
                        var cs = 0;
                        for (var rk in cells) {
                            if (cells.hasOwnProperty(rk)) cs += (cells[rk][colKeys[t]] || 0);
                        }
                        ct[colKeys[t]] = cs;
                    }
                    rowKeys.sort(function (x, y) { return rt[y] - rt[x]; });
                    colKeys.sort(function (x, y) { return ct[y] - ct[x]; });

                    var maxCell = 0, grand = 0;
                    for (var i = 0; i < rowKeys.length; i++) {
                        var line = [];
                        for (var j = 0; j < colKeys.length; j++) {
                            var vv = (cells[rowKeys[i]] || {})[colKeys[j]] || 0;
                            if (vv > maxCell) maxCell = vv;
                            grand += vv;
                            line.push(vv);
                        }
                        g.push(line);
                    }
                    return {
                        rowKeys: rowKeys, colKeys: colKeys,
                        rowLabels: mapLabels(rowKeys, aL),
                        colLabels: mapLabels(colKeys, bL),
                        rowTotals: pickTotals(rowKeys, rt),
                        colTotals: pickTotals(colKeys, ct),
                        grid: g, maxCell: maxCell, grand: grand
                    };
                }
            };
        }

        if (spec.kind === 'timegroup') {
            var grain = spec.grain || 'month';
            var nb = spec.buckets || 12;
            var order = this._bucketKeys(grain, nb);
            var slot = {};
            for (var q = 0; q < order.keys.length; q++) slot[order.keys[q]] = q;
            var byGroup = {}, tgLabels = {}, outside = 0;
            var gf = spec.groupField || null;
            return {
                id: id,
                valueFields: [spec.dateField],
                displayFields: gf ? [gf] : [],
                row: function (r, lc) {
                    var dv = r[spec.dateField];
                    if (!dv) return;
                    var key = bucketKeyOf(dv, grain);
                    var at = slot[key];
                    if (at === undefined) { outside++; return; }
                    var k = gf ? r[gf] : '';
                    if (!byGroup[k]) {
                        byGroup[k] = zeros(order.keys.length);
                        tgLabels[k] = gf ? lc[gf][k] : '';
                    }
                    byGroup[k][at]++;
                },
                done: function () {
                    var series = [], k;
                    for (k in byGroup) {
                        if (!byGroup.hasOwnProperty(k)) continue;
                        series.push({
                            key: k, label: tgLabels[k],
                            counts: byGroup[k], total: sumArr(byGroup[k])
                        });
                    }
                    series.sort(function (x, y) { return y.total - x.total; });
                    return {
                        periods: order.periods, series: series,
                        outside: outside, grain: grain
                    };
                }
            };
        }

        if (spec.kind === 'measure') {
            var ms = {}, mn = {}, mmin = {}, mmax = {}, mvals = {}, mlab = {};
            var kept = 0, neg = false;
            var mgf = spec.groupField || null;
            return {
                id: id,
                valueFields: [spec.field],
                displayFields: mgf ? [mgf] : [],
                row: function (r, lc) {
                    var raw = r[spec.field];
                    if (raw === '') return;
                    var val = parseFloat(raw);
                    if (isNaN(val)) return;
                    if (val < 0) neg = true;
                    var k = mgf ? r[mgf] : '';
                    if (ms[k] === undefined) {
                        ms[k] = 0; mn[k] = 0; mvals[k] = [];
                        mlab[k] = mgf ? lc[mgf][k] : '';
                    }
                    ms[k] += val; mn[k]++;
                    if (mmin[k] === undefined || val < mmin[k]) mmin[k] = val;
                    if (mmax[k] === undefined || val > mmax[k]) mmax[k] = val;
                    if (kept < CmdData.VALUE_CAP) { mvals[k].push(val); kept++; }
                },
                done: function () {
                    var rows = [], k;
                    for (k in ms) {
                        if (!ms.hasOwnProperty(k)) continue;
                        var qs = quantilesOf(mvals[k]);
                        rows.push({
                            key: k, label: mlab[k],
                            sum: round3(ms[k]), avg: round3(ms[k] / mn[k]),
                            min: round3(mmin[k]), max: round3(mmax[k]),
                            n: mn[k],
                            q1: qs.q1, median: qs.median, q3: qs.q3,
                            /* Whisker ends at the furthest value inside 1.5 IQR, and
                               anything beyond is an outlier the renderer draws as a
                               dot. Clamping whiskers to min/max instead would hide
                               exactly the records worth clicking through to. */
                            lo: qs.lo, hi: qs.hi, outliers: qs.outliers
                        });
                    }
                    rows.sort(function (x, y) { return y.sum - x.sum; });
                    return { rows: rows, signed: neg, truncatedValues: kept >= CmdData.VALUE_CAP };
                }
            };
        }

        if (spec.kind === 'numeric') {
            var nvals = [], nsum = 0, nneg = false;
            return {
                id: id, valueFields: [spec.field], displayFields: [],
                row: function (r) {
                    var raw = r[spec.field];
                    if (raw === '') return;
                    var val = parseFloat(raw);
                    if (isNaN(val)) return;
                    if (val < 0) nneg = true;
                    nsum += val;
                    if (nvals.length < CmdData.VALUE_CAP) nvals.push(val);
                },
                done: function () {
                    var qs = quantilesOf(nvals);
                    return {
                        values: nvals, n: nvals.length, sum: round3(nsum),
                        mean: nvals.length ? round3(nsum / nvals.length) : 0,
                        signed: nneg,
                        min: qs.min, max: qs.max, q1: qs.q1, median: qs.median,
                        q3: qs.q3, lo: qs.lo, hi: qs.hi, outliers: qs.outliers,
                        bins: binsOf(nvals)
                    };
                }
            };
        }

        if (spec.kind === 'pair') {
            var pts = [], pgf = spec.groupField || null, dropped = 0;
            return {
                id: id,
                valueFields: [spec.xField, spec.yField],
                displayFields: pgf ? [pgf] : [],
                row: function (r, lc) {
                    if (pts.length >= CmdData.PAIR_CAP) { dropped++; return; }
                    var xv = parseFloat(r[spec.xField]);
                    var yv = parseFloat(r[spec.yField]);
                    if (isNaN(xv) || isNaN(yv)) return;
                    pts.push({
                        x: round3(xv), y: round3(yv),
                        g: pgf ? r[pgf] : '',
                        gl: pgf ? lc[pgf][r[pgf]] : ''
                    });
                },
                done: function () {
                    return {
                        points: pts, dropped: dropped,
                        corr: correlationOf(pts)
                    };
                }
            };
        }

        if (spec.kind === 'duration') {
            var ds = {}, dn = {}, dvals = {}, dlab = {}, dskip = 0, dkept = 0;
            var dgf = spec.groupField || null;
            return {
                id: id,
                valueFields: [spec.startField, spec.endField],
                displayFields: dgf ? [dgf] : [],
                row: function (r, lc) {
                    var sv = r[spec.startField], ev = r[spec.endField];
                    if (!sv || !ev) return;
                    /* Arithmetic on the stored string rather than two GlideDateTime
                       constructions and a subtract. Both are UTC in the database, so
                       the difference is the same number, and it is roughly two orders
                       of magnitude cheaper inside a 20,000-row loop. */
                    var hrs = (epochSecOf(ev) - epochSecOf(sv)) / 3600;
                    if (hrs === null || isNaN(hrs)) return;
                    /* Negative elapsed time is dirty data, not a fast resolution.
                       Counted and excluded rather than silently averaged in. */
                    if (hrs < 0) { dskip++; return; }
                    var k = dgf ? r[dgf] : '';
                    if (ds[k] === undefined) {
                        ds[k] = 0; dn[k] = 0; dvals[k] = [];
                        dlab[k] = dgf ? lc[dgf][k] : '';
                    }
                    ds[k] += hrs; dn[k]++;
                    if (dkept < CmdData.VALUE_CAP) { dvals[k].push(hrs); dkept++; }
                },
                done: function () {
                    var rows = [], k;
                    for (k in ds) {
                        if (!ds.hasOwnProperty(k)) continue;
                        var qs = quantilesOf(dvals[k]);
                        rows.push({
                            key: k, label: dlab[k],
                            hours: round1(ds[k] / dn[k]), n: dn[k],
                            /* The median is reported next to the mean because
                               duration distributions on this data are strongly
                               right-skewed and the mean alone flatters them. */
                            median: round1(qs.median),
                            q1: round1(qs.q1), q3: round1(qs.q3),
                            lo: round1(qs.lo), hi: round1(qs.hi),
                            outliers: qs.outliers
                        });
                    }
                    rows.sort(function (x, y) { return y.hours - x.hours; });
                    return { rows: rows, skipped: dskip };
                }
            };
        }

        if (spec.kind === 'dow') {
            var grid = [], d;
            for (d = 0; d < 7; d++) grid.push(zeros(24));
            var dowMax = 0, dowTotal = 0;
            return {
                id: id, valueFields: [spec.dateField], displayFields: [],
                row: function (r) {
                    var dv = r[spec.dateField];
                    if (!dv || dv.length < 13) return;
                    /* Day of week from the date string by pure arithmetic. The old
                       implementation built a GlideDateTime per row purely to call
                       getDayOfWeekUTC, which is the single most expensive thing that
                       was happening inside that loop. */
                    var dowIdx = dowMondayFirst(dv);
                    if (dowIdx < 0) return;
                    var hour = parseInt(dv.substr(11, 2), 10);
                    if (isNaN(hour) || hour < 0 || hour > 23) return;
                    grid[dowIdx][hour]++;
                    dowTotal++;
                    if (grid[dowIdx][hour] > dowMax) dowMax = grid[dowIdx][hour];
                },
                done: function () {
                    return { grid: grid, maxCell: dowMax, total: dowTotal };
                }
            };
        }

        if (spec.kind === 'day') {
            var nDays = spec.days || 182;
            var byDay = {}, dayMax = 0, dayTotal = 0;
            return {
                id: id, valueFields: [spec.dateField], displayFields: [],
                row: function (r) {
                    var dv = r[spec.dateField];
                    if (!dv || dv.length < 10) return;
                    var k = dv.substr(0, 10);
                    byDay[k] = (byDay[k] || 0) + 1;
                    dayTotal++;
                    if (byDay[k] > dayMax) dayMax = byDay[k];
                },
                done: function () {
                    return { byDay: byDay, days: nDays, maxCell: dayMax, total: dayTotal };
                }
            };
        }

        return null;
    },

    _specKey: function (specs) {
        var parts = [];
        for (var i = 0; i < specs.length; i++) {
            var s = specs[i], bits = [];
            for (var k in s) { if (s.hasOwnProperty(k)) bits.push(k + '=' + s[k]); }
            bits.sort();
            parts.push(bits.join(','));
        }
        return parts.join(';');
    },

    _withScan: function (obj, r) {
        obj.scanned = r.scanned;
        obj.capped = r.capped;
        obj.timedOut = r.timedOut;
        return obj;
    },

    /** The ordered bucket keys for a grain and window, so the scan can slot a row. */
    _bucketKeys: function (grain, buckets) {
        var now = new GlideDateTime();
        var keys = [], periods = [];
        for (var i = buckets - 1; i >= 0; i--) {
            var b = this._bucketBounds(now, grain, i);
            keys.push(b.key);
            periods.push({ period: b.key, label: b.label, partial: i === 0 });
        }
        return { keys: keys, periods: periods };
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

        var ck = 'ps|' + table + '|' + dateField + '|' + grain + '|' + buckets +
                 '|' + (query || '');
        if (this._counts[ck]) return this._counts[ck];

        /* This used to call fastCount() per bucket, and that was a correctness bug
         * in the most visible place on the product.
         *
         * fastCount is GlideAggregate, which does not enforce row-level ACLs. So on
         * any table where the viewer's access is actually filtered, the trend line —
         * the one panel every dashboard leads with — was drawn from counts including
         * records that viewer cannot open, underneath a header badge stating the
         * page was filtered to their access. The badge was telling the truth about
         * the other panels and lying about this one.
         *
         * It went unnoticed because every test ran as admin, where the fast and
         * secure counts agree by construction. That is precisely the case the ACL
         * verdict exists to distinguish, so use it: trusted means the aggregate has
         * been *proved* equal to the permission-checked count for this table and
         * query, and only then is the cheap path also the correct one.
         */
        var v = this.aclVerdict(table, query);
        var series = [], i, b;
        var now = new GlideDateTime();

        if (v.denied) {
            for (i = buckets - 1; i >= 0; i--) {
                b = this._bucketBounds(now, grain, i);
                series.push({ period: b.key, label: b.label, count: 0,
                              partial: i === 0 });
            }
            this._counts[ck] = series;
            return series;
        }

        if (v.trusted) {
            for (i = buckets - 1; i >= 0; i--) {
                b = this._bucketBounds(now, grain, i);
                var q = dateField + '>=' + b.from + '^' + dateField + '<' + b.to;
                if (query) q = query + '^' + q;
                series.push({
                    period: b.key, label: b.label,
                    count: this.fastCount(table, q),
                    partial: i === 0
                });
            }
            this._counts[ck] = series;
            return series;
        }

        /* Not trusted, so the buckets have to be filled from permission-checked
         * rows. One reduction pass fills all of them, which is also cheaper than the
         * twelve counts it replaces.
         *
         * Explicitly on the per-panel budget rather than the larger reduction
         * budget. Correctness here is not optional, but its cost lands entirely on
         * the tables that are already the slowest -- measured, this scan is 3.0s on
         * `task` and 1.8s on `kb_knowledge`, both of which carry expensive scripted
         * read ACLs. Those are exactly the pages that cannot afford another three
         * seconds, so the trend takes the same 1.2s slice every other panel gets and
         * reports a bounded result if that is not enough, rather than being the one
         * panel allowed to spend the page's remaining time. */
        var g = this.seriesByGroup(table, dateField, null, grain, buckets, query,
                                   CmdData.GROUP_MS);
        var counts = g.series.length ? g.series[0].counts : zeros(buckets);
        for (i = 0; i < g.periods.length; i++) {
            series.push({
                period: g.periods[i].period,
                label: g.periods[i].label,
                count: counts[i] || 0,
                partial: g.periods[i].partial,
                bounded: g.capped
            });
        }
        this._counts[ck] = series;
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
     * why it gets a heatmap and not a line.
     *
     * Wrapper over reduce(). Note that the grid is in UTC, because that is how the
     * platform stores a datetime and reading it as stored is what keeps this cheap.
     * A viewer in a non-UTC timezone is looking at a shifted cycle, so the panel
     * says so rather than implying local business hours.
     */
    hourOfWeek: function (table, dateField, query, budgetMs) {
        return this._one(table, query, this.specs.dow(dateField), budgetMs);
    },

    /**
     * Counts per calendar day, for a calendar heatmap.
     */
    dayGrid: function (table, dateField, query, days, budgetMs) {
        return this._one(table, query, this.specs.day(dateField, days), budgetMs);
    },

    /**
     * One series per category over time, for a multi-line, stream, small-multiples,
     * slope or bump chart. All of those are the same reduction and differ only in
     * how the renderer draws it.
     */
    seriesByGroup: function (table, dateField, groupField, grain, buckets, query, budgetMs) {
        return this._one(table, query,
            this.specs.series(dateField, groupField, grain, buckets), budgetMs);
    },

    /**
     * The distribution of one numeric column: quantiles, bins and outliers.
     * Feeds a histogram or a box plot without a second pass.
     */
    numericProfile: function (table, field, query, budgetMs) {
        return this._one(table, query, this.specs.numeric(field), budgetMs);
    },

    /**
     * Profile several numeric columns in one pass.
     *
     * Six columns for the price of one scan, which is the whole reason reduce()
     * takes a list. Calling numericProfile() once per candidate would be six
     * permission-checked scans to answer a question -- which of these columns is
     * worth drawing -- that has to be answered before any of them is drawn.
     */
    numericProfiles: function (table, fields, query, budgetMs) {
        var out = {}, i;
        for (i = 0; i < fields.length; i++) {
            out[fields[i]] = this._one(table, query,
                this.specs.numeric(fields[i]), budgetMs);
        }
        return out;
    },

    /**
     * Measure against measure, for a scatter.
     */
    pairSample: function (table, xField, yField, groupField, query, budgetMs) {
        return this._one(table, query,
            this.specs.pair(xField, yField, groupField), budgetMs);
    },

    /**
     * This period against the one before it, for a KPI delta and a waterfall.
     *
     * Two windows of the same length ending now and at the start of now's window.
     * Both counted through total(), so both carry the same ACL guarantee as every
     * other number on the page, and the comparison is between like and like.
     *
     * The current window is partial by definition — you are inside it — so the raw
     * comparison is unfair and would read as a fall every single time. `paceAdjusted`
     * projects the current window forward on elapsed fraction and is the number the
     * renderer shows as the comparison, with the raw pair kept alongside it so the
     * projection is inspectable rather than asserted.
     */
    periodDelta: function (table, dateField, grain, query) {
        var ck = 'pd|' + table + '|' + dateField + '|' + grain + '|' + (query || '');
        if (this._counts[ck]) return this._counts[ck];

        var now = new GlideDateTime();
        var cur = this._bucketBounds(now, grain, 0);
        var prev = this._bucketBounds(now, grain, 1);

        var qCur = dateField + '>=' + cur.from + '^' + dateField + '<' + cur.to;
        var qPrev = dateField + '>=' + prev.from + '^' + dateField + '<' + prev.to;
        if (query) { qCur = query + '^' + qCur; qPrev = query + '^' + qPrev; }

        var c = this.total(table, qCur);
        var p = this.total(table, qPrev);

        /* How far through the current window we are, from the window bounds rather
           than from a calendar assumption, so it is right for a quarter as well as a
           month and right on the last day of February. */
        var span = epochSecOf(cur.to) - epochSecOf(cur.from);
        var done = epochSecOf(now.getValue()) - epochSecOf(cur.from);
        var frac = (span > 0) ? Math.min(1, Math.max(0.02, done / span)) : 1;

        var projected = Math.round(c.count / frac);
        var out = {
            current: c.count, previous: p.count,
            currentLabel: cur.label, previousLabel: prev.label,
            elapsedFraction: round3(frac),
            paceAdjusted: projected,
            delta: projected - p.count,
            change: p.count > 0 ? round3((projected - p.count) / p.count) : null,
            rawDelta: c.count - p.count,
            rawChange: p.count > 0 ? round3((c.count - p.count) / p.count) : null,
            partial: frac < 0.98,
            mode: c.mode,
            capped: c.capped || p.capped
        };
        this._counts[ck] = out;
        return out;
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
    measureByGroup: function (table, measureField, groupField, query, budgetMs) {
        return this._one(table, query,
            this.specs.measure(measureField, groupField), budgetMs);
    },

    /**
     * Elapsed hours between two date fields, by group. Generalised rather than
     * hard-coded to opened_at and resolved_at, because the product covers audit
     * engagements, projects and contracts as well as incidents, and every one of
     * those measures duration between a different pair of columns.
     */
    durationHours: function (table, startField, endField, groupField, query, budgetMs) {
        return this._one(table, query,
            this.specs.duration(startField, endField, groupField), budgetMs);
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

/* ══════════════════════════════════════════════════════════════════════════
   Reduction helpers

   Pure functions on plain values. Nothing here touches a GlideRecord, which is
   what lets the regression harness run them in Node against fixtures.
   ══════════════════════════════════════════════════════════════════════════ */

function zeros(n) {
    var a = [];
    for (var i = 0; i < n; i++) a.push(0);
    return a;
}

function sumArr(a) {
    var t = 0;
    for (var i = 0; i < a.length; i++) t += a[i];
    return t;
}

function sumObj(o) {
    var t = 0;
    for (var k in o) { if (o.hasOwnProperty(k)) t += o[k]; }
    return t;
}

function pickTotals(keys, totals) {
    var out = [];
    for (var i = 0; i < keys.length; i++) out.push(totals[keys[i]] || 0);
    return out;
}

function rowsFrom(counts, labels) {
    var rows = [];
    for (var k in counts) {
        if (counts.hasOwnProperty(k)) {
            rows.push({ key: k, label: labels[k], count: counts[k] });
        }
    }
    rows.sort(function (a, b) { return b.count - a.count; });
    return rows;
}

/**
 * Coerces a platform value to a real JavaScript string.
 *
 * This is not defensive tidying, it is a load-bearing fix for a Rhino trap that
 * cost a deployment. GlideDateTime.getValue() returns a java.lang.String, and on a
 * java.lang.String `length` resolves to the Java *method* rather than to the
 * JavaScript property. So `s.length < 10` compares a function object with a number,
 * Rhino tries to coerce the function to a primitive, and the whole page dies with
 * "Cannot find default value for object" -- pointing at a line that reads as
 * obviously correct.
 *
 * It is invisible from the Node test suite, which passes real JS strings, and it
 * only bites the helpers that take a datetime straight off the platform instead of
 * through reduce(), which already coerces every field it reads. Every string helper
 * below therefore coerces first and asks questions second.
 */
function jsStr(v) { return '' + v; }

/**
 * Seconds since the epoch from a platform datetime string, by arithmetic.
 *
 * Both operands of every duration in this file are stored UTC, so the difference
 * of two of these is the same number GlideDateTime.subtract would give, at a
 * fraction of the cost inside a 20,000-row loop. Returns null on anything that is
 * not a parseable 'YYYY-MM-DD HH:MM:SS'.
 */
function epochSecOf(s) {
    if (s === null || s === undefined) return null;
    s = jsStr(s);
    if (s.length < 10) return null;
    var y = parseInt(s.substr(0, 4), 10);
    var mo = parseInt(s.substr(5, 2), 10);
    var d = parseInt(s.substr(8, 2), 10);
    if (isNaN(y) || isNaN(mo) || isNaN(d)) return null;
    var days = civilDays(y, mo, d);
    var h = s.length >= 13 ? parseInt(s.substr(11, 2), 10) : 0;
    var mi = s.length >= 16 ? parseInt(s.substr(14, 2), 10) : 0;
    var se = s.length >= 19 ? parseInt(s.substr(17, 2), 10) : 0;
    return days * 86400 + (isNaN(h) ? 0 : h) * 3600 +
           (isNaN(mi) ? 0 : mi) * 60 + (isNaN(se) ? 0 : se);
}

/**
 * Days since 1970-01-01 from a proleptic Gregorian date. Howard Hinnant's
 * days_from_civil. Correct across leap years and centuries, and it is pure integer
 * arithmetic, which is the point: this runs once per scanned row.
 */
function civilDays(y, m, d) {
    y -= (m <= 2) ? 1 : 0;
    var era = Math.floor(y / 400);
    var yoe = y - era * 400;
    var doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
    var doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
    return era * 146097 + doe - 719468;
}

/** 0=Monday .. 6=Sunday, from a datetime string. 1970-01-01 was a Thursday. */
function dowMondayFirst(s) {
    if (s === null || s === undefined) return -1;
    s = jsStr(s);
    var y = parseInt(s.substr(0, 4), 10);
    var m = parseInt(s.substr(5, 2), 10);
    var d = parseInt(s.substr(8, 2), 10);
    if (isNaN(y) || isNaN(m) || isNaN(d)) return -1;
    var n = civilDays(y, m, d) + 3;
    return ((n % 7) + 7) % 7;
}

/**
 * The bucket key a datetime falls in, matching the keys _bucketBounds produces.
 * String slicing rather than date construction, for the same reason as above.
 */
function bucketKeyOf(s, grain) {
    if (s === null || s === undefined) return null;
    s = jsStr(s);
    if (s.length < 10) return null;
    if (grain === 'day') return s.substr(0, 10);
    if (grain === 'month') return s.substr(0, 7);
    if (grain === 'quarter') {
        var m = parseInt(s.substr(5, 2), 10);
        if (isNaN(m)) return null;
        return s.substr(0, 4) + '-' + pad2(m - ((m - 1) % 3));
    }
    if (grain === 'week') {
        /* Snap back to the Monday of that week, which is what _bucketBounds keys on. */
        var y = parseInt(s.substr(0, 4), 10);
        var mo = parseInt(s.substr(5, 2), 10);
        var d = parseInt(s.substr(8, 2), 10);
        if (isNaN(y) || isNaN(mo) || isNaN(d)) return null;
        var days = civilDays(y, mo, d);
        var monday = days - (((days + 3) % 7) + 7) % 7;
        return civilToIso(monday);
    }
    return s.substr(0, 7);
}

/** Inverse of civilDays, as 'YYYY-MM-DD'. Hinnant's civil_from_days. */
function civilToIso(z) {
    z += 719468;
    var era = Math.floor(z / 146097);
    var doe = z - era * 146097;
    var yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) -
                          Math.floor(doe / 146096)) / 365);
    var y = yoe + era * 400;
    var doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
    var mp = Math.floor((5 * doy + 2) / 153);
    var d = doy - Math.floor((153 * mp + 2) / 5) + 1;
    var m = mp + (mp < 10 ? 3 : -9);
    y += (m <= 2) ? 1 : 0;
    return y + '-' + pad2(m) + '-' + pad2(d);
}

/**
 * Five-number summary plus Tukey whiskers and outliers.
 *
 * Linear interpolation between order statistics, which is the same convention
 * spreadsheets use, so a number here matches what the client would get checking it
 * by hand. An empty input returns zeros rather than throwing, because a group with
 * no parseable values is a real case and not an error.
 */
function quantilesOf(values) {
    var empty = { min: 0, max: 0, q1: 0, median: 0, q3: 0, lo: 0, hi: 0,
                  outliers: [], outlierCount: 0, n: 0 };
    if (!values || !values.length) return empty;

    var v = values.slice().sort(function (a, b) { return a - b; });
    var n = v.length;

    function at(p) {
        if (n === 1) return v[0];
        var idx = p * (n - 1);
        var lo = Math.floor(idx), hi = Math.ceil(idx);
        if (lo === hi) return v[lo];
        return v[lo] + (v[hi] - v[lo]) * (idx - lo);
    }

    var q1 = at(0.25), med = at(0.5), q3 = at(0.75);
    var iqr = q3 - q1;
    var fenceLo = q1 - CmdData.IQR_WHISKER * iqr;
    var fenceHi = q3 + CmdData.IQR_WHISKER * iqr;

    /* Whiskers stop at the furthest actual value inside the fence, never at the
       fence itself, so the whisker end is always a real observation. */
    var lo = v[0], hi = v[n - 1], i;
    for (i = 0; i < n; i++) { if (v[i] >= fenceLo) { lo = v[i]; break; } }
    for (i = n - 1; i >= 0; i--) { if (v[i] <= fenceHi) { hi = v[i]; break; } }

    var outliers = [], count = 0;
    for (i = 0; i < n; i++) {
        if (v[i] < lo || v[i] > hi) {
            count++;
            if (outliers.length < CmdData.OUTLIER_CAP) outliers.push(round3(v[i]));
        }
    }

    return {
        min: round3(v[0]), max: round3(v[n - 1]),
        q1: round3(q1), median: round3(med), q3: round3(q3),
        lo: round3(lo), hi: round3(hi),
        outliers: outliers, outlierCount: count, n: n
    };
}

/**
 * Equal-width bins over the values themselves.
 *
 * The old histogram binned the *group-by rows* client side, which meant it was
 * binning distinct values rather than observations: a column where one value
 * occurs ten thousand times and another twice produced two equal-looking bars.
 * Binning the observations is what makes the gaps and the skew mean anything.
 *
 * Bin count by Freedman-Diaconis where the IQR is non-zero, falling back to
 * Sturges when it is, both clamped to a range a 520-wide plot can actually
 * separate.
 */
function binsOf(values) {
    if (!values || values.length < 2) return { bins: [], lo: 0, hi: 0, width: 0 };

    var v = values.slice().sort(function (a, b) { return a - b; });
    var n = v.length, lo = v[0], hi = v[n - 1];
    if (hi === lo) {
        return { bins: [{ from: lo, to: lo, count: n }], lo: lo, hi: hi, width: 0,
                 degenerate: true };
    }

    var q = quantilesOf(v);
    var iqr = q.q3 - q.q1;
    var k;
    if (iqr > 0) {
        var width = 2 * iqr / Math.pow(n, 1 / 3);
        k = width > 0 ? Math.ceil((hi - lo) / width) : 0;
    } else {
        k = Math.ceil(Math.log(n) / Math.LN2) + 1;
    }
    if (!k || !isFinite(k)) k = 12;
    k = Math.max(6, Math.min(24, k));

    var w = (hi - lo) / k, bins = [], i;
    for (i = 0; i < k; i++) {
        bins.push({ from: round3(lo + i * w), to: round3(lo + (i + 1) * w), count: 0 });
    }
    for (i = 0; i < n; i++) {
        var idx = Math.floor((v[i] - lo) / w);
        if (idx >= k) idx = k - 1;
        if (idx < 0) idx = 0;
        bins[idx].count++;
    }
    return { bins: bins, lo: round3(lo), hi: round3(hi), width: round3(w), k: k };
}

/**
 * Pearson correlation of the scatter points, so the panel can say whether the
 * relationship it is drawing is one at all. Reported, never used to hide the
 * chart: a scatter with no correlation is a finding.
 */
function correlationOf(pts) {
    var n = pts.length;
    if (n < 3) return null;
    var sx = 0, sy = 0, i;
    for (i = 0; i < n; i++) { sx += pts[i].x; sy += pts[i].y; }
    var mx = sx / n, my = sy / n;
    var num = 0, dx = 0, dy = 0;
    for (i = 0; i < n; i++) {
        var a = pts[i].x - mx, b = pts[i].y - my;
        num += a * b; dx += a * a; dy += b * b;
    }
    if (dx === 0 || dy === 0) return null;
    return round3(num / Math.sqrt(dx * dy));
}
