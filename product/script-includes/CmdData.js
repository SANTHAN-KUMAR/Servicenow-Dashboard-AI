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

CmdData.prototype = {

    initialize: function () {},

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
     */
    secureCount: function (table, query) {
        var gr = new GlideRecordSecure(table);
        if (query) gr.addEncodedQuery(query);
        gr.setLimit(CmdData.SECURE_SCAN_CAP + 1);
        gr.query();
        var n = 0, capped = false;
        while (gr.next()) {
            if (n >= CmdData.SECURE_SCAN_CAP) { capped = true; break; }
            n++;
        }
        return { count: n, capped: capped };
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
    secureGroupBy: function (table, field, query) {
        var counts = {}, labels = {}, scanned = 0, capped = false;

        var gr = new GlideRecordSecure(table);
        if (query) gr.addEncodedQuery(query);
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
        }

        var rows = [];
        for (var key in counts) {
            if (counts.hasOwnProperty(key)) {
                rows.push({ key: key, label: labels[key], count: counts[key] });
            }
        }
        rows.sort(function (a, b) { return b.count - a.count; });
        return { rows: rows, scanned: scanned, capped: capped };
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
        if (!this.canRead(table)) {
            return {
                rows: [],
                acl: { mode: 'DENIED', aggregate: 0, secure: 0, delta: 0, capped: false }
            };
        }

        var fast = this.fastGroupBy(table, field, query);
        var fastTotal = 0, i;
        for (i = 0; i < fast.length; i++) fastTotal += fast[i].count;

        /* The proof. One count, not a full group-by: it answers "did the ACLs
           remove anything" without paying for a second grouped pass. */
        var proof = this.secureCount(table, query);

        if (proof.capped) {
            var capped = this.secureGroupBy(table, field, query);
            return {
                rows: capped.rows,
                acl: { mode: 'BOUNDED', aggregate: fastTotal, secure: capped.scanned,
                       delta: fastTotal - capped.scanned, capped: true }
            };
        }

        if (proof.count === fastTotal) {
            return {
                rows: fast,
                acl: { mode: 'VERIFIED', aggregate: fastTotal, secure: proof.count,
                       delta: 0, capped: false }
            };
        }

        /* They disagree, so the fast numbers include rows this viewer cannot
           open. Pay for the correct answer. */
        var secure = this.secureGroupBy(table, field, query);
        var secureTotal = 0;
        for (i = 0; i < secure.rows.length; i++) secureTotal += secure.rows[i].count;

        return {
            rows: secure.rows,
            acl: { mode: secure.capped ? 'BOUNDED' : 'FILTERED',
                   aggregate: fastTotal, secure: secureTotal,
                   delta: fastTotal - secureTotal, capped: secure.capped }
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
        var total = this.secureCount(table, query);
        if (total.count === 0) {
            return { total: 0, filled: 0, rate: 1, capped: total.capped };
        }
        var q = field + 'ISNOTEMPTY';
        if (query) q = query + '^' + q;
        var filled = this.secureCount(table, q);
        return {
            total: total.count,
            filled: filled.count,
            rate: filled.count / total.count,
            capped: total.capped || filled.capped
        };
    },

    /**
     * Profiles a column so a form can be fitted to the real shape of the data.
     * Returns distinct count, top share and concentration alongside the rows.
     */
    profile: function (table, field, query) {
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
            acl: g.acl
        };
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
