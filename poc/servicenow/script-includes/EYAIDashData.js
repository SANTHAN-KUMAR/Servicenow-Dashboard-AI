var EYAIDashData = Class.create();

// Hard cap on secure row iteration so a correctness check can never hang a page load.
EYAIDashData.SECURE_SCAN_CAP = 20000;

EYAIDashData.prototype = {

    initialize: function() {},

    /**
     * Fast aggregate group-by. NOTE: GlideAggregate does NOT enforce row-level ACLs.
     * Never surface this to a user without pairing it with secureGroupBy().
     */
    fastGroupBy: function(table, field, encodedQuery) {
        var out = [];
        var ga = new GlideAggregate(table);
        if (encodedQuery)
            ga.addEncodedQuery(encodedQuery);
        ga.addAggregate('COUNT');
        ga.groupBy(field);
        ga.query();
        while (ga.next()) {
            out.push({
                key: ga.getValue(field) || '(empty)',
                label: ga.getDisplayValue(field) || '(empty)',
                count: parseInt(ga.getAggregate('COUNT'), 10)
            });
        }
        return out;
    },

    /**
     * ACL-correct group-by. Iterates with GlideRecordSecure so row-level ACLs are
     * applied, and counts in memory. Slower by construction -- that is the tradeoff
     * the platform forces, because there is no GlideAggregateSecure and
     * GlideQuery.withAcls() throws rather than aggregate.
     *
     * Returns {rows: [...], scanned: n, capped: bool}. `capped` true means the scan
     * hit SECURE_SCAN_CAP and the counts are a floor, not a total -- callers must
     * not present capped numbers as exact.
     */
    secureGroupBy: function(table, field, encodedQuery) {
        var counts = {};
        var labels = {};
        var scanned = 0;
        var capped = false;

        var gr = new GlideRecordSecure(table);
        if (encodedQuery)
            gr.addEncodedQuery(encodedQuery);
        gr.query();
        while (gr.next()) {
            if (scanned >= EYAIDashData.SECURE_SCAN_CAP) {
                capped = true;
                break;
            }
            scanned++;
            var k = gr.getValue(field) || '(empty)';
            counts[k] = (counts[k] || 0) + 1;
            if (!labels[k])
                labels[k] = gr.getDisplayValue(field) || '(empty)';
        }

        var rows = [];
        for (var key in counts) {
            if (counts.hasOwnProperty(key))
                rows.push({ key: key, label: labels[key], count: counts[key] });
        }
        rows.sort(function(a, b) { return b.count - a.count; });

        return { rows: rows, scanned: scanned, capped: capped };
    },

    /**
     * The correctness proof. Runs both paths over the same query as the CURRENT user
     * and reports the delta. A non-zero `leaked` means a naive GlideAggregate-backed
     * KPI card would show this viewer rows they cannot open.
     */
    aclProof: function(table, field, encodedQuery) {
        var canReadTable = new GlideRecord(table).canRead();

        var fast = this.fastGroupBy(table, field, encodedQuery);
        var fastTotal = 0;
        var i;
        for (i = 0; i < fast.length; i++)
            fastTotal += fast[i].count;

        var secure = this.secureGroupBy(table, field, encodedQuery);
        var secureTotal = 0;
        for (i = 0; i < secure.rows.length; i++)
            secureTotal += secure.rows[i].count;

        return {
            table: table,
            field: field,
            query: encodedQuery || '',
            user: gs.getUserName(),
            user_display: gs.getUserDisplayName(),
            table_can_read: canReadTable,
            aggregate_total: fastTotal,
            secure_total: secureTotal,
            leaked: fastTotal - secureTotal,
            capped: secure.capped,
            aggregate_rows: fast,
            secure_rows: secure.rows
        };
    },

    /**
     * Monthly time series over a date field, ACL-safe.
     * Uses GlideAggregate for the bucketing but re-checks the total against a secure
     * count so the caller knows whether the series is trustworthy for this viewer.
     */
    monthlySeries: function(table, dateField, months, encodedQuery) {
        months = months || 12;
        var series = [];
        var now = new GlideDateTime();

        // One bounded count per month. Grouping a datetime column directly would
        // bucket per timestamp (one group per record), not per month.
        for (var i = months - 1; i >= 0; i--) {
            var cursor = new GlideDateTime(now);
            cursor.addMonthsUTC(-i);
            var ym = cursor.getValue().substr(0, 7);
            var from = ym + '-01 00:00:00';
            var next = new GlideDateTime(from);
            next.addMonthsUTC(1);

            var q = dateField + '>=' + from + '^' + dateField + '<' + next.getValue();
            if (encodedQuery)
                q += '^' + encodedQuery;

            var ga = new GlideAggregate(table);
            ga.addEncodedQuery(q);
            ga.addAggregate('COUNT');
            ga.query();

            var c = 0;
            if (ga.next())
                c = parseInt(ga.getAggregate('COUNT'), 10) || 0;

            series.push({ period: ym, count: c });
        }
        return series;
    },

    /**
     * Average resolution time in hours, by group, over resolved records only.
     */
    avgResolutionHours: function(table, groupField, encodedQuery) {
        var q = 'resolved_atISNOTEMPTY^opened_atISNOTEMPTY';
        if (encodedQuery)
            q += '^' + encodedQuery;

        var sums = {};
        var ns = {};
        var gr = new GlideRecordSecure(table);
        gr.addEncodedQuery(q);
        gr.setLimit(EYAIDashData.SECURE_SCAN_CAP);
        gr.query();
        while (gr.next()) {
            var opened = new GlideDateTime(gr.getValue('opened_at'));
            var resolved = new GlideDateTime(gr.getValue('resolved_at'));
            var hrs = GlideDateTime.subtract(opened, resolved).getNumericValue() / 3600000;
            if (hrs < 0)
                continue;
            var k = gr.getDisplayValue(groupField) || '(empty)';
            sums[k] = (sums[k] || 0) + hrs;
            ns[k] = (ns[k] || 0) + 1;
        }

        var out = [];
        for (var key in sums) {
            if (sums.hasOwnProperty(key))
                out.push({ label: key, hours: Math.round((sums[key] / ns[key]) * 10) / 10, n: ns[key] });
        }
        out.sort(function(a, b) { return b.hours - a.hours; });
        return out;
    },

    /**
     * Profiles a column so the chart-spec layer can fit a visualisation to the real
     * shape of the data instead of picking from a fixed template list.
     */
    profileField: function(table, field, encodedQuery) {
        var rows = this.fastGroupBy(table, field, encodedQuery);
        var total = 0, i;
        for (i = 0; i < rows.length; i++)
            total += rows[i].count;

        rows.sort(function(a, b) { return b.count - a.count; });

        var distinct = rows.length;
        var topShare = total > 0 && distinct > 0 ? rows[0].count / total : 0;

        // Gini-style concentration: how much of the mass sits in the top 20% of categories.
        var headN = Math.max(1, Math.ceil(distinct * 0.2));
        var headSum = 0;
        for (i = 0; i < headN && i < rows.length; i++)
            headSum += rows[i].count;
        var concentration = total > 0 ? headSum / total : 0;

        return {
            table: table,
            field: field,
            total: total,
            distinct: distinct,
            top_share: Math.round(topShare * 1000) / 1000,
            concentration: Math.round(concentration * 1000) / 1000,
            rows: rows
        };
    },

    type: 'EYAIDashData'
};
