(function process(request, response) {

    var d = new global.EYAIDashData();
    var table = request.queryParams.table ? request.queryParams.table[0] : 'incident';
    var months = request.queryParams.months ? parseInt(request.queryParams.months[0], 10) : 12;

    function count(t, q) {
        var ga = new GlideAggregate(t);
        if (q) ga.addEncodedQuery(q);
        ga.addAggregate('COUNT');
        ga.query();
        return ga.next() ? parseInt(ga.getAggregate('COUNT'), 10) : 0;
    }

    function secureCount(t, q) {
        var gr = new GlideRecordSecure(t);
        if (q) gr.addEncodedQuery(q);
        gr.query();
        return gr.getRowCount();
    }

    var total = count(table, '');
    var totalSecure = secureCount(table, '');
    var active = count(table, 'active=true');
    var p1 = count(table, 'priority=1');
    var unassigned = count(table, 'assigned_toISEMPTY^active=true');

    // Mean time to resolve across the whole resolved population.
    var mttr = 0, mttrN = 0;
    var gaR = new GlideAggregate(table);
    gaR.addEncodedQuery('resolved_atISNOTEMPTY^opened_atISNOTEMPTY');
    gaR.addAggregate('COUNT');
    gaR.query();
    if (gaR.next()) mttrN = parseInt(gaR.getAggregate('COUNT'), 10);

    var sample = new GlideRecord(table);
    sample.addEncodedQuery('resolved_atISNOTEMPTY^opened_atISNOTEMPTY');
    sample.orderByDesc('opened_at');
    sample.setLimit(2000);
    sample.query();
    var acc = 0, n = 0;
    while (sample.next()) {
        var o = new GlideDateTime(sample.getValue('opened_at'));
        var r2 = new GlideDateTime(sample.getValue('resolved_at'));
        var h = GlideDateTime.subtract(o, r2).getNumericValue() / 3600000;
        if (h >= 0) { acc += h; n++; }
    }
    if (n > 0) mttr = Math.round((acc / n) * 10) / 10;

    var body = {
        generated_at: new GlideDateTime().getDisplayValue(),
        viewer: gs.getUserName(),
        viewer_display: gs.getUserDisplayName(),
        table: table,
        kpis: {
            total: total,
            total_visible_to_viewer: totalSecure,
            acl_hidden_from_viewer: total - totalSecure,
            active: active,
            p1: p1,
            unassigned_active: unassigned,
            mttr_hours: mttr,
            mttr_sample: n,
            resolved_total: mttrN
        },
        by_category: d.profileField(table, 'category', ''),
        by_priority: d.profileField(table, 'priority', ''),
        by_state: d.profileField(table, 'state', ''),
        by_group: d.profileField(table, 'assignment_group', ''),
        monthly: d.monthlySeries(table, 'opened_at', months, ''),
        mttr_by_category: d.avgResolutionHours(table, 'category', '')
    };

    response.setStatus(200);
    response.setBody(body);

})(request, response);
