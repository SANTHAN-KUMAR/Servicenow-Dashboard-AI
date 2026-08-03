/**
 * CmdCatalog. The entry surface.
 *
 * The client's own Dashboards experience opens on a list of what you can open,
 * not on one page of charts. The POC shipped a single hard-coded page over
 * `incident` and was called a dumb stub with some random default graphs, which
 * was fair: a page that only ever shows one subject is a spike, not a product.
 *
 * Two design decisions here matter more than the code.
 *
 * **The catalog is derived, not configured.** There is no list of subjects
 * anywhere in this file or in a table. Candidates come from `sys_report`: the
 * tables that people on this instance have actually built reports against are, by
 * definition, the tables worth offering, and that evidence is already sitting on
 * the instance. It costs one grouped query. It also means the product works
 * unchanged on an instance with GRC, audit, HR and PPM installed and on one
 * without them, which is the difference between a product and a demo.
 *
 * **The catalog is permission-scoped, and that is a correctness concern, not a
 * tidiness one.** A viewer must not see a card for data they cannot read. Card
 * membership is filtered on the table-level read check, and every count shown on
 * a card comes from the ACL-checked path, so the catalog cannot disclose the
 * existence or the size of something the viewer has no access to.
 *
 * ES5 only. Rhino.
 */
var CmdCatalog = Class.create();

/* Subject grouping. Prefix to area, longest prefix wins.
 *
 * This is presentation only: it decides which heading a card sits under and
 * nothing else. An unmatched table still appears, under Other, so a table this
 * list has never heard of is never hidden from a viewer who can read it. That is
 * the difference between a grouping and a whitelist. */
CmdCatalog.AREAS = [
    ['sn_grc', 'Risk and compliance'],
    ['sn_risk', 'Risk and compliance'],
    ['sn_audit', 'Risk and compliance'],
    ['sn_compliance', 'Risk and compliance'],
    ['sn_policy', 'Risk and compliance'],
    ['sn_vul', 'Security'],
    ['sn_si', 'Security'],
    ['sn_ti', 'Security'],
    ['sn_customerservice', 'Customer service'],
    ['csm_', 'Customer service'],
    ['sn_hr', 'HR service delivery'],
    ['hr_', 'HR service delivery'],
    ['pm_', 'Projects and portfolio'],
    ['dmn_', 'Projects and portfolio'],
    ['rm_', 'Projects and portfolio'],
    ['cost_', 'Projects and portfolio'],
    ['fm_', 'Projects and portfolio'],
    ['alm_', 'Assets and configuration'],
    ['ast_', 'Assets and configuration'],
    ['cmdb', 'Assets and configuration'],
    ['sam_', 'Assets and configuration'],
    ['samp_', 'Assets and configuration'],
    ['clm_', 'Assets and configuration'],
    ['sc_', 'Service catalogue'],
    ['asmt_', 'Assessments and surveys'],
    ['em_', 'Event management'],
    ['ua_', 'Platform usage'],
    ['usageanalytics', 'Platform usage'],
    ['sys_', 'Platform'],
    ['change_request', 'IT service management'],
    ['incident', 'IT service management'],
    ['problem', 'IT service management'],
    ['task_sla', 'IT service management'],
    ['task', 'IT service management'],
    ['kb_', 'Knowledge']
];

/* A subject needs enough rows to say anything. Below this a dashboard is a list
   with extra steps, so the card is not offered. */
CmdCatalog.MIN_ROWS = 12;

/* Ceiling on the per-card ACL-checked count. A card needs a magnitude, not a
   total, and the count is the expensive part. Above this the card says "2,000+"
   and the dashboard computes the exact figure when it is opened. */
CmdCatalog.CARD_COUNT_CAP = 2000;

/* Cap on candidates examined. Each survivor costs a bounded secure count, so this
   bounds the catalog's cost. Ordered by report count first, so the cap drops the
   least-reported tables rather than an arbitrary set. */
CmdCatalog.MAX_CANDIDATES = 40;

CmdCatalog.prototype = {

    initialize: function () {
        this.meta = new CmdMeta();
        this.data = new CmdData();
    },

    /**
     * The catalog for the current user.
     *
     * Returns areas, each with cards, plus the counts the header needs. Every
     * number here is ACL-checked; nothing is a GlideAggregate total.
     */
    build: function (limit) {
        limit = limit || CmdCatalog.MAX_CANDIDATES;

        var candidates = this._candidates(limit);
        var cards = [];
        var considered = 0, denied = 0, tooSmall = 0;

        for (var i = 0; i < candidates.length; i++) {
            var t = candidates[i];
            considered++;

            var d = this.meta.describe(t.table);
            if (!d.exists) continue;

            /* Table-level read check first, because it is free and because a
               viewer who fails it must not even learn the row count. */
            if (!d.canRead) { denied++; continue; }

            /* Capped deliberately low. A card needs to say "worth opening" and a
               magnitude, not an exact total, and an exact total is expensive: a
               secure count is one ACL evaluation per row, and the platform logs
               Slow ACL at 40 to 86ms per evaluation on tables with costly read
               rules. Scanning every readable row of every candidate table to
               populate a catalog would make the entry page the slowest thing in
               the product. The dashboard pays for the exact number; the card does
               not need to. When capped, the card renders "2,000+". */
            var n = this.data.secureCount(t.table, '', CmdCatalog.CARD_COUNT_CAP);
            if (n.count < CmdCatalog.MIN_ROWS) { tooSmall++; continue; }

            var dims = this.meta.dimensions(t.table);
            var dates = this.meta.dates(t.table);

            cards.push({
                table: t.table,
                label: d.label,
                area: this.area(t.table),
                rows: n.count,
                capped: n.capped,
                reports: t.reports,
                dimensions: dims.length,
                dates: dates.length,
                /* What the card previews: the first offered dimension is what the
                   dashboard will lead with, so the card can honestly say what the
                   viewer is about to get. */
                leadDimension: dims.length ? dims[0].label : null,
                leadDate: dates.length ? dates[0].label : null,
                url: '/cmd_dashboard.do?table=' + encodeURIComponent(t.table)
            });
        }

        cards.sort(function (a, b) {
            if (b.reports !== a.reports) return b.reports - a.reports;
            return b.rows - a.rows;
        });

        return {
            areas: this._group(cards),
            cards: cards,
            stats: {
                user: gs.getUserDisplayName(),
                userName: gs.getUserName(),
                offered: cards.length,
                considered: considered,
                denied: denied,
                tooSmall: tooSmall
            }
        };
    },

    /**
     * Candidate subjects, derived from where reporting demand already is.
     *
     * `sys_report` is the evidence. A table with 73 reports against it is a
     * subject somebody cares about; a table with none is speculative. This is the
     * same principle as the form engine, applied to the catalog: read what the
     * instance can actually tell us instead of deciding for it.
     */
    _candidates: function (limit) {
        var rows = this.data.fastGroupBy('sys_report', 'table', 'tableISNOTEMPTY');
        var out = [];
        for (var i = 0; i < rows.length && out.length < limit; i++) {
            var name = rows[i].key;
            if (!name) continue;
            /* Report definitions pointed at a view or a deleted table are noise. */
            if (name.indexOf('_list') > -1) continue;
            out.push({ table: name, reports: rows[i].count });
        }
        return out;
    },

    area: function (table) {
        var best = null, bestLen = -1;
        for (var i = 0; i < CmdCatalog.AREAS.length; i++) {
            var p = CmdCatalog.AREAS[i][0];
            if (table.indexOf(p) === 0 && p.length > bestLen) {
                best = CmdCatalog.AREAS[i][1];
                bestLen = p.length;
            }
        }
        return best || 'Other';
    },

    _group: function (cards) {
        var order = [], byName = {};
        for (var i = 0; i < cards.length; i++) {
            var a = cards[i].area;
            if (!byName[a]) { byName[a] = { area: a, cards: [], rows: 0 }; order.push(a); }
            byName[a].cards.push(cards[i]);
            byName[a].rows += cards[i].rows;
        }
        var out = [];
        for (var j = 0; j < order.length; j++) out.push(byName[order[j]]);
        /* Areas ordered by how much the viewer can actually see in them, so the
           richest subject is at the top rather than whichever matched first. */
        out.sort(function (x, y) { return y.rows - x.rows; });
        return out;
    },

    type: 'CmdCatalog'
};
