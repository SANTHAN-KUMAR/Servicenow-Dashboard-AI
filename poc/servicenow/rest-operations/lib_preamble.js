    // ---- EY AI Dashboard inline engine -------------------------------------
    // Kept self-contained inside the operation so the resource never depends on a
    // cross-scope call into the global Script Includes (which requires a
    // Restricted Caller Access grant on this instance).
    var SECURE_SCAN_CAP = 20000;

    function fastGroupBy(table, field, q) {
        var out = [];
        var ga = new GlideAggregate(table);
        if (q) ga.addEncodedQuery(q);
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
    }

    function secureGroupBy(table, field, q) {
        var counts = {}, labels = {}, scanned = 0, capped = false;
        var gr = new GlideRecordSecure(table);
        if (q) gr.addEncodedQuery(q);
        gr.query();
        while (gr.next()) {
            if (scanned >= SECURE_SCAN_CAP) { capped = true; break; }
            scanned++;
            var k = gr.getValue(field) || '(empty)';
            counts[k] = (counts[k] || 0) + 1;
            if (!labels[k]) labels[k] = gr.getDisplayValue(field) || '(empty)';
        }
        var rows = [];
        for (var key in counts) {
            if (counts.hasOwnProperty(key)) rows.push({ key: key, label: labels[key], count: counts[key] });
        }
        rows.sort(function(a, b) { return b.count - a.count; });
        return { rows: rows, scanned: scanned, capped: capped };
    }

    function profileField(table, field, q) {
        var rows = fastGroupBy(table, field, q);
        var total = 0, i;
        for (i = 0; i < rows.length; i++) total += rows[i].count;
        rows.sort(function(a, b) { return b.count - a.count; });
        var distinct = rows.length;
        var topShare = (total > 0 && distinct > 0) ? rows[0].count / total : 0;
        var headN = Math.max(1, Math.ceil(distinct * 0.2));
        var headSum = 0;
        for (i = 0; i < headN && i < rows.length; i++) headSum += rows[i].count;
        var concentration = total > 0 ? headSum / total : 0;
        return {
            field: field, total: total, distinct: distinct,
            top_share: Math.round(topShare * 1000) / 1000,
            concentration: Math.round(concentration * 1000) / 1000,
            rows: rows
        };
    }

    function monthlySeries(table, dateField, months, q) {
        months = months || 12;
        var series = [];
        var now = new GlideDateTime();
        for (var i = months - 1; i >= 0; i--) {
            var cursor = new GlideDateTime(now);
            cursor.addMonthsUTC(-i);
            var ym = cursor.getValue().substr(0, 7);
            var from = ym + '-01 00:00:00';
            var next = new GlideDateTime(from);
            next.addMonthsUTC(1);
            var qq = dateField + '>=' + from + '^' + dateField + '<' + next.getValue();
            if (q) qq += '^' + q;
            var ga = new GlideAggregate(table);
            ga.addEncodedQuery(qq);
            ga.addAggregate('COUNT');
            ga.query();
            var c = 0;
            if (ga.next()) c = parseInt(ga.getAggregate('COUNT'), 10) || 0;
            series.push({ period: ym, count: c });
        }
        return series;
    }

    function avgResolutionHours(table, groupField, q) {
        var qq = 'resolved_atISNOTEMPTY^opened_atISNOTEMPTY';
        if (q) qq += '^' + q;
        var sums = {}, ns = {};
        var gr = new GlideRecordSecure(table);
        gr.addEncodedQuery(qq);
        gr.setLimit(SECURE_SCAN_CAP);
        gr.query();
        while (gr.next()) {
            var o = new GlideDateTime(gr.getValue('opened_at'));
            var r2 = new GlideDateTime(gr.getValue('resolved_at'));
            var h = GlideDateTime.subtract(o, r2).getNumericValue() / 3600000;
            if (h < 0) continue;
            var k = gr.getDisplayValue(groupField) || '(empty)';
            sums[k] = (sums[k] || 0) + h;
            ns[k] = (ns[k] || 0) + 1;
        }
        var out = [];
        for (var key in sums) {
            if (sums.hasOwnProperty(key))
                out.push({ label: key, hours: Math.round((sums[key] / ns[key]) * 10) / 10, n: ns[key] });
        }
        out.sort(function(a, b) { return b.hours - a.hours; });
        return out;
    }

    function aclProof(table, field, q) {
        var canReadTable = new GlideRecord(table).canRead();
        var fast = fastGroupBy(table, field, q);
        var fastTotal = 0, i;
        for (i = 0; i < fast.length; i++) fastTotal += fast[i].count;
        var secure = secureGroupBy(table, field, q);
        var secureTotal = 0;
        for (i = 0; i < secure.rows.length; i++) secureTotal += secure.rows[i].count;
        return {
            table: table, field: field, query: q || '',
            user: gs.getUserName(), user_display: gs.getUserDisplayName(),
            table_can_read: canReadTable,
            aggregate_total: fastTotal, secure_total: secureTotal,
            leaked: fastTotal - secureTotal, capped: secure.capped,
            aggregate_rows: fast, secure_rows: secure.rows
        };
    }
    // ------------------------------------------------------------------------
