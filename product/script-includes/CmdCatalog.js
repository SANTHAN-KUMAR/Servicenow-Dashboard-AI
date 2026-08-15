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
CmdCatalog.MIN_ROWS = 120;

/* Prefixes that are platform plumbing rather than a subject anybody runs a
   dashboard on. They are excluded from the catalog, and this is a curation
   decision rather than a security one: a viewer who can read sys_flow_context can
   still open its list view and build a report on it. What they cannot do is have it
   presented as a leadership analytics subject alongside Incident and Contract.
   Measured, these were half the catalog and the reason it read as noise: flow engine
   contexts, API transaction stats, client transaction logs and usage counters. They
   are also the slowest tables on the instance to permission-check. */
CmdCatalog.EXCLUDE_PREFIX = [
    'sys_', 'syslog', 'ua_', 'usageanalytics', 'v_', 'ts_', 'sn_devstudio',
    'sysauto', 'sysevent', 'sysrule', 'clone_', 'ecc_', 'pa_', 'sa_taxonomy'
];

/* Ceiling on the per-card ACL-checked count. A card needs a magnitude, not a
   total, and the count is the expensive part: one ACL evaluation per row, per card.
   Measured at 2,000 the catalog took 13.8s for twelve cards, and that cost is the
   entry page, the first thing anybody sees. Above the cap the card reads "400+" and
   the dashboard computes the exact ACL-checked figure when the subject is opened,
   which is the only place an exact figure is worth paying for. */
CmdCatalog.CARD_COUNT_CAP = 400;

/* Dimensions tried per card when looking for a preview worth drawing. Each is a
   grouped query, and there are a dozen cards, so this is the knob that decides
   whether the entry page is fast or informative. Four is enough to get past a
   single-valued leading field without turning the catalog into a dashboard. */
/* Wall-clock budget for one card's scan. Twelve cards at this bound puts the entry
   page comfortably inside its budget even when every table is expensive to
   permission-check. */
CmdCatalog.CARD_SCAN_MS = 320;

/* Candidate dimensions measured per card. They share one scan, so this costs field
   reads rather than ACL evaluations, and the winner is chosen after measuring
   instead of guessed before. */
CmdCatalog.PREVIEW_FIELDS = 4;

/* How populated a field must be to preview a subject. A column that is mostly blank
   describes the minority that filled it in, not the subject. */
CmdCatalog.PREVIEW_MIN_FILL = 0.60;

/* Above this many values a preview bar stops distinguishing anything. */
CmdCatalog.PREVIEW_MAX_DISTINCT = 12;

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
     * number ON A CARD is ACL-checked -- `rows` comes from a bounded
     * GlideRecordSecure scan (secureMultiGroupBy), and `dimensions`/`dates` are
     * schema metadata, not row data, so there is nothing to check.
     *
     * `sys_report`'s own report count is the one number in this file that is
     * NOT ACL-checked, and it does not reach a card: `sys_report` carries
     * genuinely private, owner-scoped rows, and counting them with
     * fastGroupBy (GlideAggregate) would both display a number the viewer
     * cannot verify and rank candidate tables by reports they cannot see. It
     * is read once, in _candidates, purely to decide which tables are worth
     * offering at all and in what order -- an internal ranking signal, never
     * a displayed fact. See _candidates for where that line is drawn.
     */
    build: function (limit) {
        limit = limit || CmdCatalog.MAX_CANDIDATES;
        var t0 = new Date().getTime();

        var candidates = this._candidates(limit);
        var cards = [];
        var considered = 0, denied = 0, tooSmall = 0;

        for (var i = 0; i < candidates.length; i++) {
            var t = candidates[i];
            considered++;

            var d = this.meta.describe(t.table);
            if (!d.exists) continue;

            /* There is deliberately no table-level canRead() gate here.
             *
             * It was one, and it emptied the catalog for exactly the viewers the
             * catalog is supposed to be scoped for. canRead() evaluates the read
             * ACLs with no record in context, so any ACL whose condition or script
             * mentions `current` fails it for a viewer who can still read plenty of
             * rows. Live on dev390988 a role-less persona fails canRead() on
             * `incident` and `kb_knowledge` while holding 815 and 669 readable rows
             * respectively, and this line removed both cards.
             *
             * Membership is decided instead by the permission-checked probe below,
             * which is the same thing the card's own numbers are built from. It
             * costs more than a context-free ACL evaluation and it is the only one
             * of the two that answers the question actually being asked. A viewer
             * who genuinely has nothing still learns nothing: the probe returns
             * zero and the card is dropped before any count is computed. */

            /* One bounded, permission-checked scan per card, doing double duty.
             *
             * It returns both the count and the distribution of a chosen dimension,
             * so a card costs one scan instead of a count plus a profile. Three
             * earlier shapes were measured and discarded: an uncapped secure count
             * per card, 13.8s for twelve cards; the same capped at 2,000, still
             * 13.8s; and capped at 400 with the preview gated on the count being
             * provably unfiltered, which was fast but left eleven of twelve cards
             * with no preview and every count reading "400+".
             *
             * This is ACL-correct rather than provably-equal-to-unsafe: it iterates
             * with GlideRecordSecure, so every row counted is a row this viewer can
             * open. It is bounded, so on a large table it describes a prefix rather
             * than the whole, and the card says so. A share of a labelled sample is
             * an honest statement; a share of rows the viewer cannot see is not. */
            /* Membership first, and cheaply. hasAtLeast stops at the threshold, so
               it is bounded by rows rather than by time and a table with expensive
               ACLs cannot disappear from the catalog just for being slow. Two
               subjects vanished that way before this split. */
            var member = this.data.hasAtLeast(t.table, '', CmdCatalog.MIN_ROWS);
            if (!member.atLeast) {
                /* Zero readable rows and no readable rows are worth telling apart in
                   the diagnostics, because one means the viewer is shut out of this
                   subject and the other means the subject is too thin to be worth a
                   card for anyone. The viewer sees neither card either way. */
                if (member.count === 0) denied++; else tooSmall++;
                continue;
            }

            var fields = this._previewFields(t.table);
            var probe = fields.length
                ? this.data.secureMultiGroupBy(t.table, fields, '', CmdCatalog.CARD_SCAN_MS)
                : { byField: {}, scanned: 0, capped: true };

            var dims = this.meta.dimensions(t.table);
            var dates = this.meta.dates(t.table);

            cards.push({
                table: t.table,
                label: d.label,
                area: this.area(t.table),
                rows: probe.scanned,
                capped: probe.capped,
                atLeast: CmdCatalog.MIN_ROWS,
                /* t.reports (sys_report count) deliberately does not appear here.
                   It is an ACL-unchecked, owner-scoped number -- see build()'s
                   docstring -- and stops at ranking candidates in _candidates.
                   It must never reach a card. */
                dimensions: dims.length,
                dates: dates.length,
                /* What the card previews: the first offered dimension is what the
                   dashboard will lead with, so the card can honestly say what the
                   viewer is about to get. */
                leadDimension: dims.length ? dims[0].label : null,
                leadDate: dates.length ? dates[0].label : null,
                /* Previews are the optional part of a card, so they are the part
                   that gets dropped when the page runs out of time. */
                preview: this._bestPreview(fields, probe, dims),
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
                ms: new Date().getTime() - t0,
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
     *
     * The count comes from fastGroupBy -- GlideAggregate, not ACL-checked -- and
     * that is deliberate here, not an oversight: it exists only to rank and
     * shortlist candidates, is never rendered, and never reaches the client.
     * A viewer's card counts (rows, dimensions, dates) are computed separately,
     * later, and ARE checked. Do not wire this count to anything user-facing
     * without switching it to a secure count first -- sys_report rows are
     * privately owned and this number does not survive that scrutiny as-is.
     */
    _candidates: function (limit) {
        var rows = this.data.fastGroupBy('sys_report', 'table', 'tableISNOTEMPTY');
        var out = [];
        for (var i = 0; i < rows.length && out.length < limit; i++) {
            var name = rows[i].key;
            if (!name) continue;
            /* Report definitions pointed at a view or a deleted table are noise. */
            if (name.indexOf('_list') > -1) continue;
            if (this._excluded(name)) continue;
            out.push({ table: name, reports: rows[i].count });
        }
        return out;
    },

    /**
     * The dimensions worth measuring for a card preview, best guesses first.
     *
     * Several rather than one, because they are all measured in the same scan and
     * the winner is chosen afterwards. Non-ordinal choice lists lead: a named
     * category reads instantly, where an ordinal previews as a scale and a reference
     * previews as a list of people.
     */
    _previewFields: function (table) {
        var dims = this.meta.dimensions(table);
        var out = [], i;
        for (i = 0; i < dims.length && out.length < CmdCatalog.PREVIEW_FIELDS; i++) {
            if (dims[i].isChoice && !dims[i].isOrdinal) out.push(dims[i].name);
        }
        for (i = 0; i < dims.length && out.length < CmdCatalog.PREVIEW_FIELDS; i++) {
            if ((dims[i].isChoice || dims[i].isBool) &&
                out.indexOf(dims[i].name) === -1) out.push(dims[i].name);
        }
        for (i = 0; i < dims.length && out.length < CmdCatalog.PREVIEW_FIELDS; i++) {
            if (dims[i].isRef && out.indexOf(dims[i].name) === -1) out.push(dims[i].name);
        }
        /* Deliberately never free text. `task` previewed Short description, which is
           one value per record and arrives with newlines in it. */
        return out;
    },

    /**
     * The most informative of the measured candidates.
     *
     * Least concentrated wins, because a bar where one value holds 91% shows nothing
     * that the number alone would not. Anything single-valued is rejected outright:
     * that is not a distribution.
     */
    _bestPreview: function (fields, probe, dims) {
        var best = null, bestTop = 2, i;
        for (i = 0; i < fields.length; i++) {
            var cand = this._previewFrom(fields[i], probe.byField[fields[i]],
                                         probe.capped, dims);
            if (!cand) continue;
            if (cand.top[0].share < bestTop) { bestTop = cand.top[0].share; best = cand; }
        }
        return best;
    },

    _previewFrom: function (field, rows, sampled, dims) {
        if (!rows || !rows.length) return null;

        var scanned = 0, empty = 0, i;
        for (i = 0; i < rows.length; i++) {
            scanned += rows[i].count;
            if (rows[i].key === '') empty = rows[i].count;
        }
        if (scanned === 0) return null;

        /* Shares are of the populated records, not of the scan.
         *
         * Dividing by the scan made an almost-empty field look like the most evenly
         * spread one in the subject, because ninety-eight percent blank leaves every
         * real value at a tiny share. The "least concentrated wins" rule then picked
         * exactly the worst field on every card: Close code at two percent, which is
         * two values scattered across a column nobody fills in. */
        var populated = scanned - empty;
        if (populated === 0) return null;

        /* And a field this empty is not a preview of the subject at all, however
           evenly the remainder happens to be spread. */
        if ((populated / scanned) < CmdCatalog.PREVIEW_MIN_FILL) return null;

        var distinct = empty > 0 ? rows.length - 1 : rows.length;
        if (distinct < 2) return null;
        /* Past a dozen values a three-segment bar shows a few percent each and the
           legend is a list of near-identical numbers. One card previewed fifty
           configuration items at one percent apiece. */
        if (distinct > CmdCatalog.PREVIEW_MAX_DISTINCT) return null;

        var top = [], shown = 0, covered = 0;
        for (i = 0; i < rows.length && shown < 3; i++) {
            if (rows[i].key === '') continue;
            top.push({ label: rows[i].label || rows[i].key, count: rows[i].count,
                       share: rows[i].count / populated });
            covered += rows[i].count;
            shown++;
        }
        if (!top.length) return null;

        var label = field;
        for (i = 0; i < dims.length; i++) {
            if (dims[i].name === field) { label = dims[i].label; break; }
        }

        return {
            field: field, fieldLabel: label, distinct: distinct, top: top,
            restShare: Math.max(0, (populated - covered) / populated),
            fill: populated / scanned,
            /* True when the scan described a prefix rather than the whole subject, so
               the card can say the shares are from a sample instead of implying they
               are complete. */
            sampled: !!sampled,
            scanned: scanned
        };
    },

    _excluded: function (table) {
        for (var i = 0; i < CmdCatalog.EXCLUDE_PREFIX.length; i++) {
            if (table.indexOf(CmdCatalog.EXCLUDE_PREFIX[i]) === 0) return true;
        }
        return false;
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
