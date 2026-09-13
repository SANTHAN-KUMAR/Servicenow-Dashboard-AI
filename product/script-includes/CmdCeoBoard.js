/**
 * CmdCeoBoard. The CEO Dashboard front page: one page, eight portfolios, every
 * number permission-checked, computed fast enough to be the first thing a leader
 * opens in the morning.
 *
 * What the client asked for, 2026-09-13: "for ceo dashboard front page and
 * navigation page all in one page with multiple section". Their own Control Tower
 * app is two hops -- a Summary page and a header menu that swaps whole screens,
 * one per portfolio. This is the model behind a page that holds all of it: an
 * orbit of the eight portfolios as the navigation, the Summary's cross-portfolio
 * Speed / Productivity / Risk grid, and each portfolio's full nine slots opening in
 * place.
 *
 * Two jobs, split so the page can paint before it has counted anything:
 *
 *   frame()      what the page is: portfolios, slots, names, units, directions,
 *                filters, periods. Configuration only -- ten cheap queries, no
 *                record counting -- so it is embedded in the page and the whole
 *                layout paints on the first response.
 *   measures()   what the numbers are, for a set of indicators, a period and a
 *                filter. Called over GlideAjax (see CmdCeoAjax), several calls in
 *                flight at once, so the numbers fill the frame as they arrive.
 *
 * ── Why a period at all, when PA's definitions say "today" ──
 *
 * Almost every measure on the source dashboard is pinned to a single day:
 * `resolved_atONToday`, `closed_atONToday`. Measured on the client instance, 51 of
 * the 72 slots print blank or zero, because the instance's records are not from
 * today -- and on any quiet morning the same is true of a real one. A leadership
 * page that is mostly blank before lunch is not a leadership page.
 *
 * So each measure is computed for a chosen period (today, 7, 30, 90 days, 12
 * months) by widening exactly the one clause that pins it to today, and PA's own
 * definition -- today -- is always computed alongside and shown on the card, so the
 * number that matches the source dashboard is never hidden. A measure that is a
 * point-in-time stock ("open now") is not a flow and ignores the period, and says
 * so.
 *
 * ── Why one query per measure ──
 *
 * A card needs: today's value (PA's definition), the period's value, the previous
 * period's value for the delta, thirty days and twelve months of history. Asked
 * one question at a time that is fifty queries a measure. One GlideAggregate
 * trended by day over the span answers all of them -- measured on dev390988 at
 * 77ms for 400 days of incidents -- and the rest is arithmetic over that map.
 *
 * ── Permission checking ──
 *
 * Unchanged from the rest of the product, and not optional. Each table is proved
 * once per request (CmdData.aclVerdict over the whole table); a viewer who can read
 * every row takes the aggregate path, and a viewer who cannot gets the same
 * numbers from a permission-checked scan, time-boxed, and labelled BOUNDED when the
 * box was not big enough. The role opens the dashboard; it grants no data.
 *
 * ES5. Rhino. No eval.
 */
var CmdCeoBoard = Class.create();

CmdCeoBoard.ROLE = 'x_2185255_command.ceo_viewer';
CmdCeoBoard.NAMES_PROPERTY = 'x_2185255_command.ceo_portfolio_names';
CmdCeoBoard.PERIOD_PROPERTY = 'x_2185255_command.ceo_default_period';
CmdCeoBoard.HEADLINE_PROPERTY = 'x_2185255_command.ceo_headline_indicator';

/* "Number of open incidents". The centre of the orbit: the enterprise's open work,
   the way the client's own Summary puts one total at the top of the page. */
CmdCeoBoard.DEFAULT_HEADLINE = 'fb007202d7130100b96d45a3ce6103b4';

CmdCeoBoard.PERIODS = [
    { key: 'today', days: 1,   label: 'Today',          short: 'Today', prev: 'yesterday' },
    { key: '7d',    days: 7,   label: 'Last 7 days',    short: '7D',    prev: 'the 7 days before' },
    { key: '30d',   days: 30,  label: 'Last 30 days',   short: '30D',   prev: 'the 30 days before' },
    { key: '90d',   days: 90,  label: 'Last 90 days',   short: '90D',   prev: 'the 90 days before' },
    { key: '12m',   days: 365, label: 'Last 12 months', short: '12M',   prev: 'the 12 months before' }
];
CmdCeoBoard.DEFAULT_PERIOD = '30d';

/* The slicers. Declared, never taken from the browser: a filter arrives as field
   names and values, both checked against this list and against the dictionary,
   and is turned into a clause here. No encoded query ever comes from a client. */
CmdCeoBoard.FILTER_FIELDS = ['priority', 'category', 'assignment_group'];
CmdCeoBoard.MAX_FILTER_VALUES = 12;
CmdCeoBoard.GROUP_OPTIONS = 14;

CmdCeoBoard.MONTHS = 12;
CmdCeoBoard.DAYS = 30;
CmdCeoBoard.MAX_IDS = 64;

/* Permission-checked scans for a viewer who is not trusted on a table. Per measure
   and per request, so one expensive table cannot hold the page hostage. */
CmdCeoBoard.SECURE_LEAF_MS = 1500;
CmdCeoBoard.SECURE_TOTAL_MS = 8000;

/* Per-viewer result memory. The same three minutes as CmdData's proof memory, for
   the same reason: long enough that moving around the page is instant, short
   enough that nobody reads a stale number as live. Refresh bypasses it. */
CmdCeoBoard.CACHE_PREFIX = 'cmd.ceo.v2.';
CmdCeoBoard.CACHE_TTL_MS = 180000;

CmdCeoBoard.allowed = function () {
    return gs.hasRole(CmdCeoBoard.ROLE);
};

/** A PA query widened from today to the last `days` days, or null. Shared with
    CmdCeo.measure so an analysis opened from a card counts the same rows. */
CmdCeoBoard.windowQuery = function (query, days) {
    var c = ceoClassify(query);
    if (c.kind !== 'event') return null;
    return ceoWindowQuery(c, days, 0);
};

CmdCeoBoard.periodOf = function (key) {
    var want = String(key || '');
    if (!want) want = String(gs.getProperty(CmdCeoBoard.PERIOD_PROPERTY, CmdCeoBoard.DEFAULT_PERIOD) || '');
    for (var i = 0; i < CmdCeoBoard.PERIODS.length; i++) {
        if (CmdCeoBoard.PERIODS[i].key === want) return CmdCeoBoard.PERIODS[i];
    }
    return CmdCeoBoard.PERIODS[2];
};

CmdCeoBoard.prototype = {

    initialize: function (builder) {
        builder = builder || new CmdPayload();
        this.builder = builder;
        this.data = builder.data;
        this.meta = builder.meta;
        this.drill = builder.drill;
        this.ceo = new CmdCeo(this.data, this.meta, this.drill);
        this._leaf = {};
        this._roots = {};
        this._verdicts = {};
        this._units = {};
        this._config = null;
        this._secureSpent = 0;
    },

    /* ══════════════════════════════════════════════════════════════════════
       The frame
       ══════════════════════════════════════════════════════════════════════ */

    frame: function () {
        var started = new Date().getTime();
        var rows = this.config();
        var ids = [], seen = {}, i;
        for (i = 0; i < rows.length; i++) {
            if (!seen[rows[i].indicator]) { seen[rows[i].indicator] = true; ids.push(rows[i].indicator); }
        }
        var headline = String(gs.getProperty(CmdCeoBoard.HEADLINE_PROPERTY, '') || '') ||
                       CmdCeoBoard.DEFAULT_HEADLINE;
        if (!/^[0-9a-f]{32}$/.test(headline)) headline = CmdCeoBoard.DEFAULT_HEADLINE;
        if (!seen[headline]) { ids.push(headline); seen[headline] = true; }
        this.preload(ids);

        var names = this._names();
        var byP = {}, order = [];
        for (i = 0; i < rows.length; i++) {
            var r = rows[i];
            if (!byP[r.portfolio]) { byP[r.portfolio] = {}; order.push(r.portfolio); }
            byP[r.portfolio][r.slot] = r;
        }
        order.sort(ceoNaturalCompare);

        var portfolios = [], indicators = {};
        for (i = 0; i < order.length; i++) {
            var key = order[i], slots = byP[key], list = [], distinct = {}, nDistinct = 0;
            var tables = {}, tableOrder = [];
            for (var s = 0; s < CmdCeo.SLOT_ORDER.length; s++) {
                var slotName = CmdCeo.SLOT_ORDER[s];
                var row = slots[slotName];
                if (!row || slotName === 'Bubblechart') continue;
                list.push({ slot: slotName, id: row.indicator });
                if (!distinct[row.indicator]) { distinct[row.indicator] = true; nDistinct++; }
                var t = this._tableOf(row.indicator);
                if (t && !tables[t]) { tables[t] = 0; tableOrder.push(t); }
                if (t) tables[t]++;
            }
            tableOrder.sort(function (a, b) { return tables[b] - tables[a]; });
            var bubble = slots.Bubblechart;
            portfolios.push({
                key: key,
                label: names[String(key).toLowerCase()] || this.ceo.portfolioLabel(key),
                named: !!names[String(key).toLowerCase()],
                subtitle: this._subtitle(tableOrder),
                tables: tableOrder,
                slots: list,
                breakdown: bubble ? { id: bubble.indicator, breakdown: bubble.breakdown || '' } : null,
                duplicate: nDistinct === 1 && list.length > 1,
                distinct: nDistinct
            });
        }

        for (i = 0; i < ids.length; i++) indicators[ids[i]] = this._describe(ids[i]);

        var periods = [];
        for (i = 0; i < CmdCeoBoard.PERIODS.length; i++) {
            var p = CmdCeoBoard.PERIODS[i];
            periods.push({ key: p.key, label: p.label, short: p.short, prev: p.prev, days: p.days });
        }

        return {
            version: 2,
            view: 'ceo',
            viewer: { name: gs.getUserName(), display: gs.getUserDisplayName() },
            generated: new GlideDateTime().getDisplayValue(),
            instance: gs.getProperty('instance_name', ''),
            source: this.ceo.sourceTable(),
            headline: headline,
            portfolios: portfolios,
            indicators: indicators,
            periods: periods,
            period: CmdCeoBoard.periodOf('').key,
            filters: this._filterOptions(),
            frameMs: new Date().getTime() - started
        };
    },

    /** Every active slot of the configured source, in one query. */
    config: function () {
        if (this._config) return this._config;
        var c = this.ceo.columns();
        var out = [];
        if (!c) { this._config = out; return out; }
        var gr = new GlideRecord(this.ceo.sourceTable());
        gr.addQuery(c.active, true);
        gr.query();
        while (gr.next()) {
            var ind = String(gr.getValue(c.indicator) || '');
            if (!/^[0-9a-f]{32}$/.test(ind)) continue;
            out.push({
                portfolio: String(gr.getValue(c.portfolio) || ''),
                slot: String(gr.getValue(c.slot) || ''),
                indicator: ind,
                breakdown: String(gr.getValue(c.breakdown) || '')
            });
        }
        this._config = out;
        return out;
    },

    /**
     * Fill CmdCeo's indicator and cube memos with a handful of IN queries instead
     * of one GlideRecord.get per id. Formula references are followed breadth first,
     * so a two-level formula costs three queries rather than a query per node.
     */
    preload: function (ids) {
        var want = ids.slice(), rounds = 0, cubes = {}, units = {};
        while (want.length && rounds < CmdCeo.MAX_DEPTH) {
            rounds++;
            var next = [];
            var gr = new GlideRecord('pa_indicators');
            gr.addQuery('sys_id', 'IN', want.join(','));
            gr.query();
            while (gr.next()) {
                var id = String(gr.getUniqueValue());
                var rec = {
                    sys_id: id,
                    name: gr.getValue('name'),
                    type: gr.getValue('type'),
                    aggregate: gr.getValue('aggregate'),
                    field: gr.getValue('field'),
                    conditions: gr.getValue('conditions') || '',
                    cube: gr.getValue('cube') || '',
                    formula: gr.getValue('formula') || '',
                    scripted: this.ceo._bool(gr.getValue('scripted')),
                    script: gr.getValue('script') || '',
                    unit: gr.getValue('unit') || '',
                    precision: gr.getValue('precision') || '',
                    direction: gr.getValue('direction') || ''
                };
                this.ceo._ind[id] = rec;
                if (rec.cube) cubes[rec.cube] = true;
                if (rec.unit) units[rec.unit] = true;
                var refs = String(rec.formula).match(/\[\[([0-9a-f]{32})\]\]/g) || [];
                for (var k = 0; k < refs.length; k++) {
                    var ref = refs[k].substring(2, 34);
                    if (this.ceo._ind[ref] === undefined) next.push(ref);
                }
            }
            for (var m = 0; m < want.length; m++) {
                if (this.ceo._ind[want[m]] === undefined) this.ceo._ind[want[m]] = null;
            }
            want = next;
        }
        var cubeIds = ceoKeys(cubes);
        if (cubeIds.length) {
            var cg = new GlideRecord('pa_cubes');
            cg.addQuery('sys_id', 'IN', cubeIds.join(','));
            cg.query();
            while (cg.next()) {
                this.ceo._cube[String(cg.getUniqueValue())] = {
                    name: cg.getValue('name'),
                    table: cg.getValue('facts_table'),
                    conditions: cg.getValue('conditions') || ''
                };
            }
        }
        var unitIds = ceoKeys(units);
        if (unitIds.length) {
            var ug = new GlideRecord('pa_units');
            ug.addQuery('sys_id', 'IN', unitIds.join(','));
            ug.query();
            while (ug.next()) {
                var n = String(ug.getValue('name') || '').toLowerCase();
                this._units[String(ug.getUniqueValue())] =
                    (n.indexOf('percent') !== -1 || n === '%') ? '%'
                    : n.indexOf('day') !== -1 ? 'd'
                    : n.indexOf('hour') !== -1 ? 'h' : '';
            }
        }
    },

    _unit: function (unitId) {
        if (!unitId) return '';
        if (this._units[unitId] === undefined) this._units[unitId] = this.ceo._unitCode(unitId);
        return this._units[unitId];
    },

    /* The table an indicator's number rests on: its own, or its formula's subject. */
    _tableOf: function (id) {
        var node = this.ceo.resolve(id);
        if (node.table) return node.table;
        var leaf = this.ceo._formulaLeaf(id, 0, {});
        return leaf ? leaf.table : (this.ceo._formulaTable(id, 0, {}) || '');
    },

    _describe: function (id) {
        var ind = this.ceo.indicator(id);
        if (!ind) return { id: id, name: 'Missing indicator', missing: true, kind: 'refused' };
        var node = this.ceo.resolve(id);
        return {
            id: id,
            name: ind.name,
            unit: this._unit(ind.unit),
            dir: ind.direction === '2' ? 'down' : ind.direction === '3' ? 'up' : 'none',
            kind: this._kindOf(node, 0),
            formula: !!ind.formula,
            table: this._tableOf(id)
        };
    },

    /* event, stock or static: whether the period applies to this measure. */
    _kindOf: function (node, depth) {
        if (!node || node.kind === 'refused') return 'refused';
        if (node.kind === 'formula') {
            var kinds = {}, self = this;
            var walk = function (n) {
                if (!n) return;
                if (n.ref !== undefined) {
                    if (depth > CmdCeo.MAX_DEPTH) return;
                    kinds[self._kindOf(self.ceo.resolve(n.ref), depth + 1)] = true;
                    return;
                }
                walk(n.a); walk(n.b);
            };
            walk(node.ast);
            if (kinds.refused) return 'refused';
            if (kinds.event) return 'event';
            if (kinds.stock) return 'stock';
            return 'static';
        }
        return ceoClassify(node.query).kind;
    },

    _names: function () {
        var raw = String(gs.getProperty(CmdCeoBoard.NAMES_PROPERTY, '') || '');
        var out = {};
        if (!raw) return out;
        try {
            var o = JSON.parse(raw);
            for (var k in o) {
                if (o.hasOwnProperty(k) && typeof o[k] === 'string' && o[k].length <= 60) {
                    out[String(k).toLowerCase()] = o[k];
                }
            }
        } catch (e) { /* a malformed property names nothing, it does not break the page */ }
        return out;
    },

    /* What a portfolio is about, in words, counted from where its cards rest. */
    _subtitle: function (tables) {
        if (!tables.length) return 'No measurable slots';
        var words = [];
        for (var i = 0; i < tables.length && i < 3; i++) {
            var d = this.meta.describe(tables[i]);
            words.push(d && d.plural ? d.plural : (d && d.label ? d.label : tables[i]));
        }
        if (tables.length > 3) words.push('more');
        if (words.length === 1) return words[0];
        return words.slice(0, -1).join(', ') + ' & ' + words[words.length - 1];
    },

    _filterOptions: function () {
        var out = [], i;
        var add = function (field, label, options) {
            if (options && options.length) out.push({ field: field, label: label, options: options });
        };
        var choices = function (meta, table, field) {
            var list = meta.choices(table, field) || [], res = [];
            for (var j = 0; j < list.length && res.length < 40; j++) {
                if (list[j].value === '' || list[j].value === null) continue;
                res.push({ value: String(list[j].value), label: String(list[j].label || list[j].value) });
            }
            return res;
        };
        try { add('priority', 'Priority', choices(this.meta, 'incident', 'priority')); } catch (e1) { /* optional */ }
        try { add('category', 'Category', choices(this.meta, 'incident', 'category')); } catch (e2) { /* optional */ }
        try {
            var groups = [];
            var ga = new GlideAggregate('incident');
            ga.addNotNullQuery('assignment_group');
            ga.addAggregate('COUNT');
            ga.groupBy('assignment_group');
            ga.orderByAggregate('COUNT');
            ga.query();
            var rows = [];
            while (ga.next()) {
                rows.push({ value: String(ga.getValue('assignment_group')),
                            label: String(ga.assignment_group.getDisplayValue() || ''),
                            n: parseInt(ga.getAggregate('COUNT'), 10) || 0 });
            }
            rows.sort(function (a, b) { return b.n - a.n; });
            for (i = 0; i < rows.length && groups.length < CmdCeoBoard.GROUP_OPTIONS; i++) {
                if (rows[i].label) groups.push({ value: rows[i].value, label: rows[i].label });
            }
            groups.sort(function (a, b) { return a.label < b.label ? -1 : 1; });
            add('assignment_group', 'Assignment group', groups);
        } catch (e3) { /* optional */ }
        return out;
    },

    /* ══════════════════════════════════════════════════════════════════════
       Measures
       ══════════════════════════════════════════════════════════════════════ */

    measures: function (ids, periodKey, filterStr, opts) {
        opts = opts || {};
        var started = new Date().getTime();
        var P = CmdCeoBoard.periodOf(periodKey);
        var allowed = {}, rows = this.config(), i;
        for (i = 0; i < rows.length; i++) allowed[rows[i].indicator] = true;
        var headline = String(gs.getProperty(CmdCeoBoard.HEADLINE_PROPERTY, '') || '') ||
                       CmdCeoBoard.DEFAULT_HEADLINE;
        allowed[headline] = true;

        /* Only indicators this dashboard is configured with. Nothing here is a
           security boundary -- every number is permission-checked -- but it is a
           cost boundary: an arbitrary id list is an arbitrary amount of work. */
        var list = [], seen = {};
        for (i = 0; i < ids.length && list.length < CmdCeoBoard.MAX_IDS; i++) {
            var id = String(ids[i] || '');
            if (!/^[0-9a-f]{32}$/.test(id) || !allowed[id] || seen[id]) continue;
            seen[id] = true;
            list.push(id);
        }
        var filters = this.parseFilters(filterStr);
        var fkey = ceoFilterKey(filters);

        /* Remembered per indicator, not per call: the page asks in three groups,
           a period change asks again, an analysis page comes back -- and each of
           those is a different set of ids over the same numbers. Keyed per
           indicator, any view assembles from whatever this viewer already has and
           computes only what is missing. */
        var base = gs.getUserID() + '|' + P.key + '|' + fkey;
        var results = {}, missing = [], oldest = null;
        for (i = 0; i < list.length; i++) {
            var hit = opts.nocache ? null : this._cacheGet(ceoCacheKey(base, list[i]));
            if (hit) {
                results[list[i]] = hit.v;
                if (oldest === null || hit.t < oldest) oldest = hit.t;
            } else {
                missing.push(list[i]);
            }
        }
        var metaHit = opts.nocache ? null : this._cacheGet(ceoCacheKey(base, 'meta'));

        var ctx = this._ctx(P, filters);
        if (missing.length) {
            this.preload(missing);
            for (i = 0; i < missing.length; i++) {
                try {
                    results[missing[i]] = this._root(missing[i], ctx);
                } catch (e) {
                    results[missing[i]] = { id: missing[i], ok: false, value: null,
                                            why: 'this measure could not be computed: ' + e };
                }
                this._cachePut(ceoCacheKey(base, missing[i]), results[missing[i]]);
            }
        }

        var tables = (metaHit && metaHit.v && metaHit.v.tables) ? metaHit.v.tables : {};
        for (var t in this._verdicts) {
            if (!this._verdicts.hasOwnProperty(t)) continue;
            var v = this._verdicts[t];
            tables[t] = { mode: ceoMode(v), aggregate: v.aggregate, secure: v.secure,
                          delta: v.delta, label: (this.meta.describe(t) || {}).plural || t };
        }
        if (missing.length) this._cachePut(ceoCacheKey(base, 'meta'), { tables: tables });

        var out = {
            period: P.key, periodLabel: P.label, prevLabel: P.prev, days: P.days,
            filters: filters,
            results: results,
            monthKeys: ctx.monthKeys, monthLabels: ctx.monthLabels,
            dayKeys: ctx.dayKeys.slice(0, CmdCeoBoard.DAYS).reverse(),
            today: ctx.today,
            tables: tables,
            generated: new GlideDateTime().getDisplayValue(),
            computeMs: new Date().getTime() - started,
            computed: missing.length,
            cached: !missing.length,
            ageMs: (!missing.length && oldest !== null) ? new Date().getTime() - oldest : 0
        };
        return out;
    },

    /**
     * The breakdown slot of one portfolio, over the chosen period and filters, as
     * an ordinary COMMAND panel -- so it is drawn by the same renderer, in the form
     * the data supports, with the same drill wiring as every other panel.
     */
    breakdown: function (portfolio, periodKey, filterStr) {
        var P = CmdCeoBoard.periodOf(periodKey);
        var rows = this.config(), slot = null, i;
        for (i = 0; i < rows.length; i++) {
            if (rows[i].portfolio === portfolio && rows[i].slot === 'Bubblechart') { slot = rows[i]; break; }
        }
        if (!slot || !slot.breakdown) return { panel: null, why: 'this portfolio has no breakdown slot' };
        this.preload([slot.indicator]);
        var node = this.ceo.resolve(slot.indicator);
        if (!node.table) return { panel: null, why: node.why || 'the breakdown measure has no source table' };
        var field = this.ceo._breakdownField(slot.breakdown, node.table);
        var f = field ? this.meta.field(node.table, field) : null;
        if (!f) return { panel: null, why: 'the breakdown does not map to a column on ' + node.table };

        var filters = this.parseFilters(filterStr);
        var fc = this._filterClause(node.table, filters);
        var cls = ceoClassify(node.query);
        var q = cls.kind === 'event' ? ceoWindowQuery(cls, P.days, 0) : node.query;
        q = ceoJoin(q, fc.clause);

        var res = this.data.tieredGroupBy(node.table, field, q);
        var list = res.rows || [];
        var total = 0;
        for (i = 0; i < list.length; i++) total += list[i].count;
        for (i = 0; i < list.length; i++) list[i].share = total ? list[i].count / total : 0;
        /* An ordinal field is read in its own order -- Critical before High --
           because that sequence is the meaning; anything else largest first. */
        if (f.isOrdinal) {
            list.sort(function (a, b) {
                var x = parseFloat(a.key), y = parseFloat(b.key);
                if (isNaN(x) || isNaN(y)) return String(a.key) < String(b.key) ? -1 : 1;
                return x - y;
            });
        } else {
            list.sort(function (a, b) { return b.count - a.count; });
        }

        return {
            panel: list.length ? {
                id: 'ceo_breakdown_' + portfolio,
                kind: 'dimension',
                field: field,
                fieldLabel: f.label,
                question: node.name + ', by ' + f.label,
                reason: (cls.kind === 'event' ? P.label + '. ' : '') +
                        'The breakdown the source dashboard applies to this measure' +
                        (f.isOrdinal ? ', in its own order' : ', largest first') + '.',
                rows: { series: list, total: total },
                span: 2,
                form: f.isOrdinal || list.length <= 6 ? 'column' : 'ranked_bar',
                caveats: []
            } : null,
            why: list.length ? '' : 'no records in this period',
            measure: { id: slot.indicator, name: node.name, table: node.table },
            total: total,
            acl: res.acl,
            filter: fc.state,
            records: this.drill.listUrl(node.table, q),
            period: P.key
        };
    },

    /** "priority:1,2|category:network" -> [{field, values}], checked. */
    parseFilters: function (raw) {
        var out = [], s = String(raw || '');
        if (!s) return out;
        var parts = s.split('|'), seen = {};
        for (var i = 0; i < parts.length; i++) {
            var bits = parts[i].split(':');
            var field = String(bits[0] || '');
            if (CmdCeoBoard.FILTER_FIELDS.indexOf(field) === -1 || seen[field] || bits.length !== 2) continue;
            var vals = String(bits[1] || '').split(','), ok = [];
            for (var j = 0; j < vals.length && ok.length < CmdCeoBoard.MAX_FILTER_VALUES; j++) {
                var v = String(vals[j]);
                if (field === 'assignment_group') {
                    if (/^[0-9a-f]{32}$/.test(v)) ok.push(v);
                } else if (/^[A-Za-z0-9_\-. ]{1,40}$/.test(v)) {
                    ok.push(v);
                }
            }
            if (ok.length) { seen[field] = true; out.push({ field: field, values: ok }); }
        }
        out.sort(function (a, b) { return a.field < b.field ? -1 : 1; });
        return out;
    },

    /* The filter as a clause for one table: only the fields that table has. */
    _filterClause: function (table, filters) {
        if (!filters.length) return { clause: '', state: 'n/a' };
        var parts = [], applied = 0;
        for (var i = 0; i < filters.length; i++) {
            if (!this.meta.field(table, filters[i].field)) continue;
            parts.push(filters[i].field + 'IN' + filters[i].values.join(','));
            applied++;
        }
        return { clause: parts.join('^'),
                 state: applied === filters.length ? 'all' : applied ? 'some' : 'none' };
    },

    _ctx: function (P, filters) {
        var today = String(new GlideDateTime().getLocalDate().getValue()).substring(0, 10);
        var monthKeys = [], monthLabels = [];
        for (var m = CmdCeoBoard.MONTHS - 1; m >= 0; m--) {
            var ym = ceoMonthBack(today, m);
            monthKeys.push(ym);
            monthLabels.push(CEO_MONTHS[parseInt(ym.substring(5, 7), 10) - 1] + " '" + ym.substring(2, 4));
        }
        /* Enough history for twelve whole months and for the previous period. */
        var spanMonths = ceoDaysBetween(monthKeys[0] + '-01', today) + 1;
        var span = Math.max(spanMonths, P.days * 2, CmdCeoBoard.DAYS);
        var dayKeys = [];
        for (var d = 0; d < span; d++) dayKeys.push(ceoIsoAdd(today, -d));
        var fmt = '';
        try { fmt = String(gs.getDateFormat() || ''); } catch (e) { fmt = ''; }
        var off = 0;
        try { off = new GlideDateTime().getTZOffset(); } catch (e2) { off = 0; }
        return {
            key: P.key + '|' + ceoFilterKey(filters),
            period: P, days: P.days, filters: filters,
            today: today, span: span, dayKeys: dayKeys,
            monthKeys: monthKeys, monthLabels: monthLabels,
            dateFormat: fmt, tzOffsetMs: off
        };
    },

    _verdict: function (table) {
        if (this._verdicts[table] === undefined) this._verdicts[table] = this.data.aclVerdict(table, '');
        return this._verdicts[table];
    },

    /* ── one root indicator ─────────────────────────────────────────────── */

    _root: function (id, ctx) {
        var ck = id + '|' + ctx.key;
        if (this._roots[ck]) return this._roots[ck];
        var d = this._describe(id);
        var node = this.ceo.resolve(id);
        var L = this._series(node, ctx, 0, {});
        var out = this._shape(id, d, node, L, ctx);
        this._roots[ck] = out;
        return out;
    },

    /**
     * A node's series: {ok, pa, win, prev, days[], months[], ...}. Leaves are
     * counted; a formula is its components' series combined by its own
     * arithmetic, point by point, so every number on a formula card -- headline,
     * delta, sparkline -- is the same formula applied to the same rows.
     */
    _series: function (node, ctx, depth, seen) {
        if (node.kind === 'refused') return { ok: false, why: node.why };
        if (node.kind !== 'formula') return this._leafSeries(node, ctx);
        if (depth > CmdCeo.MAX_DEPTH || seen[node.id]) {
            return { ok: false, why: 'the formula for "' + node.name + '" nests too deep or refers to itself' };
        }
        var next = {};
        for (var k in seen) { if (seen.hasOwnProperty(k)) next[k] = true; }
        next[node.id] = true;

        var parts = {}, failure = null, self = this;
        var collect = function (n) {
            if (failure || !n) return;
            if (n.ref !== undefined) {
                if (parts[n.ref]) return;
                var sub = self._series(self.ceo.resolve(n.ref, depth + 1, next), ctx, depth + 1, next);
                if (!sub.ok) { failure = sub; return; }
                parts[n.ref] = sub;
                return;
            }
            collect(n.a); collect(n.b);
        };
        collect(node.ast);
        if (failure) return failure;

        var out = { ok: true, mode: 'VERIFIED', bounded: false, filter: 'n/a', tables: [] };
        var modes = [], filters = [], tset = {};
        for (var r in parts) {
            if (!parts.hasOwnProperty(r)) continue;
            modes.push(parts[r].mode);
            filters.push(parts[r].filter);
            if (parts[r].bounded) out.bounded = true;
            var pts = parts[r].tables || [parts[r].table];
            for (var q = 0; q < pts.length; q++) {
                if (pts[q] && !tset[pts[q]]) { tset[pts[q]] = true; out.tables.push(pts[q]); }
            }
        }
        out.mode = ceoWorstMode(modes);
        out.filter = ceoFilterState(filters);

        var scalar = function (field) {
            return ceoEval(node.ast, function (ref) { return parts[ref][field]; });
        };
        var pa = scalar('pa'), win = scalar('win'), prev = scalar('prev');
        out.pa = pa.v; out.whyPa = pa.why;
        out.win = win.v; out.whyWin = win.why;
        out.prev = prev.v;
        out.days = ceoEvalArray(node.ast, parts, 'days');
        out.months = ceoEvalArray(node.ast, parts, 'months');
        return out;
    },

    _leafSeries: function (node, ctx) {
        var ck = node.id + '|' + ctx.key;
        if (this._leaf[ck]) return this._leaf[ck];
        var L = this._leafCompute(node, ctx);
        this._leaf[ck] = L;
        return L;
    },

    _leafCompute: function (node, ctx) {
        var table = node.table;
        if (!table || !this.meta.describe(table) || !this.meta.describe(table).exists) {
            return { ok: false, why: 'the table "' + table + '" behind this measure is not on this instance' };
        }
        var v = this._verdict(table);
        var mode = ceoMode(v);
        if (v.denied) {
            return { ok: false, denied: true, mode: 'DENIED', table: table,
                     why: 'you cannot read any of the records behind this measure' };
        }
        var trusted = !!v.trusted;
        var cls = ceoClassify(node.query);
        var fc = this._filterClause(table, ctx.filters);
        var L = { ok: true, table: table, kind: cls.kind, mode: mode, bounded: !!v.capped,
                  filter: fc.state, pa: null, win: null, prev: null, days: null, months: null };

        if (node.kind === 'duration') {
            return this._durationSeries(node, cls, fc, ctx, L);
        }

        var agg = node.agg || 'COUNT';
        var field = node.field;
        if (cls.kind === 'event') {
            var rest = ceoJoin(cls.rest, fc.clause);
            if (agg === 'COUNT' || agg === 'SUM') {
                var daily = trusted
                    ? this._fastDaily(table, rest, cls.field, agg, field, ctx)
                    : this._secureDaily(table, rest, cls.field, agg, field, ctx);
                if (daily) {
                    ceoFill(L, daily.map, ctx);
                    if (daily.bounded) { L.bounded = true; L.mode = 'BOUNDED'; }
                    return L;
                }
            }
            /* Distinct counts and the rest do not add across days, so ask the
               three questions directly and leave the history out. */
            var qToday = ceoJoin(node.query, fc.clause);
            L.pa = this._single(table, qToday, agg, field, trusted, L);
            L.win = this._single(table, ceoJoin(ceoWindowQuery(cls, ctx.days, 0), fc.clause), agg, field, trusted, L);
            L.prev = this._single(table, ceoJoin(ceoWindowQuery(cls, ctx.days, ctx.days), fc.clause), agg, field, trusted, L);
            return L;
        }

        /* A stock, or a measure with no period in it at all: its value is now. */
        var base = ceoJoin(node.query, fc.clause);
        L.pa = L.win = this._single(table, base, agg, field, trusted, L);
        if (cls.kind === 'stock' && trusted && agg === 'COUNT') {
            var then = ceoAsOf(base, ctx.days);
            if (then) L.prev = this._single(table, then, agg, field, trusted, L);
            var months = [];
            for (var m = CmdCeoBoard.MONTHS - 1; m >= 0; m--) {
                if (m === 0) { months.push(L.pa); continue; }
                var q = ceoAsOfMonthEnd(base, m);
                if (!q) { months = null; break; }
                months.push(this._single(table, q, agg, field, trusted, L));
            }
            L.months = months;
        }
        return L;
    },

    /* Elapsed-time measures are sums over records, so they need the records.
       Read with an unchecked cursor only when this viewer is proved on the whole
       table; otherwise through GlideRecordSecure, time-boxed like every other
       permission-checked scan here. Not through CmdData.reduce: its trust
       transfer deliberately refuses queries with ^OR in them (the drill-URL
       injection fix), and PA's "open as at today" cube is an OR group, so every
       age measure would pay a full permission scan for a viewer already proved
       on all of `incident`. The query here is configuration, never input. */
    _hours: function (table, q, from, to, trusted, L) {
        var budget = trusted ? CmdCeoBoard.SECURE_TOTAL_MS : this._secureBudget();
        if (budget <= 0) { L.bounded = true; return null; }
        var started = new Date().getTime(), nowMs = started;
        var gr = trusted ? new GlideRecord(table) : new GlideRecordSecure(table);
        if (q) gr.addEncodedQuery(q);
        gr.query();
        var sum = 0, i = 0;
        while (gr.next()) {
            if ((++i & 15) === 0 && new Date().getTime() - started > budget) { L.bounded = true; break; }
            var a = from === '*now*' ? nowMs : ceoUtcMs(String(gr.getValue(from) || ''));
            var b = to === '*now*' ? nowMs : ceoUtcMs(String(gr.getValue(to) || ''));
            if (a === null || b === null) continue;
            sum += (b - a) / 3600000;
        }
        if (!trusted) this._secureSpent += new Date().getTime() - started;
        return sum;
    },

    _durationSeries: function (node, cls, fc, ctx, L) {
        var self = this, trusted = !!this._verdict(node.table).trusted;
        var hours = function (q) { return self._hours(node.table, q, node.from, node.to, trusted, L); };
        if (cls.kind === 'event') {
            L.pa = hours(ceoJoin(node.query, fc.clause));
            L.win = hours(ceoJoin(ceoWindowQuery(cls, ctx.days, 0), fc.clause));
            L.prev = hours(ceoJoin(ceoWindowQuery(cls, ctx.days, ctx.days), fc.clause));
        } else {
            L.pa = L.win = hours(ceoJoin(node.query, fc.clause));
        }
        if (L.bounded && L.mode === 'VERIFIED') L.mode = 'BOUNDED';
        return L;
    },

    /* One value, by the fastest correct path for this viewer. */
    _single: function (table, q, agg, field, trusted, L) {
        if (trusted) {
            var ga = new GlideAggregate(table);
            if (q) ga.addEncodedQuery(q);
            if (agg === 'COUNT') {
                ga.addAggregate('COUNT');
                ga.query();
                return ga.next() ? (parseInt(ga.getAggregate('COUNT'), 10) || 0) : 0;
            }
            if (agg === 'COUNT_DISTINCT') {
                ga.addAggregate('COUNT(DISTINCT', field);
                ga.query();
                return ga.next() ? (parseInt(ga.getAggregate('COUNT(DISTINCT', field), 10) || 0) : 0;
            }
            /* SUM, AVG, MIN, MAX. GlideAggregate groups by the aggregated column by
               default, so there can be several rows; they are folded here, with
               the counts carried so an average stays an average. */
            ga.addAggregate(agg, field);
            ga.addAggregate('COUNT');
            ga.query();
            var acc = null, n = 0;
            while (ga.next()) {
                var x = parseFloat(ga.getAggregate(agg, field));
                var c = parseInt(ga.getAggregate('COUNT'), 10) || 0;
                if (isNaN(x)) continue;
                if (agg === 'SUM') acc = (acc || 0) + x;
                else if (agg === 'AVG') acc = (acc || 0) + x * c;
                else if (agg === 'MIN') acc = acc === null ? x : Math.min(acc, x);
                else if (agg === 'MAX') acc = acc === null ? x : Math.max(acc, x);
                n += c;
            }
            if (agg === 'AVG') return n ? acc / n : null;
            return acc === null ? (agg === 'SUM' ? 0 : null) : acc;
        }

        /* Permission-checked: every row is read through GlideRecordSecure, so only
           the rows this viewer may open contribute. Time-boxed per measure and per
           request; running out is reported, never silently absorbed. */
        var budget = this._secureBudget();
        if (budget <= 0) { L.bounded = true; return null; }
        var started = new Date().getTime();
        var gr = new GlideRecordSecure(table);
        if (q) gr.addEncodedQuery(q);
        gr.query();
        var count = 0, sum = 0, min = null, max = null, distinct = {}, nd = 0, i = 0, capped = false;
        while (gr.next()) {
            if ((++i & 15) === 0 && new Date().getTime() - started > budget) { capped = true; break; }
            count++;
            if (agg === 'COUNT') continue;
            var raw = gr.getValue(field);
            if (agg === 'COUNT_DISTINCT') {
                var key = String(raw);
                if (!distinct[key]) { distinct[key] = true; nd++; }
                continue;
            }
            var val = parseFloat(raw);
            if (isNaN(val)) continue;
            sum += val;
            if (min === null || val < min) min = val;
            if (max === null || val > max) max = val;
        }
        this._secureSpent += new Date().getTime() - started;
        if (capped) L.bounded = true;
        if (agg === 'COUNT') return count;
        if (agg === 'COUNT_DISTINCT') return nd;
        if (agg === 'SUM') return sum;
        if (agg === 'AVG') return count ? sum / count : null;
        if (agg === 'MIN') return min;
        return max;
    },

    _secureBudget: function () {
        return Math.min(CmdCeoBoard.SECURE_LEAF_MS, CmdCeoBoard.SECURE_TOTAL_MS - this._secureSpent);
    },

    /**
     * Daily totals over the whole span in one aggregate query, keyed by the
     * viewer's calendar date. GlideAggregate trends in the session's own time
     * zone, which is the same zone gs.beginningOfToday() uses, so "today" here is
     * exactly PA's today.
     */
    _fastDaily: function (table, rest, dateField, agg, aggField, ctx) {
        var ga = new GlideAggregate(table);
        ga.addEncodedQuery(ceoJoin(rest, dateField + '>=javascript:gs.daysAgoStart(' + (ctx.span - 1) + ')'));
        ga.addTrend(dateField, 'Date');
        if (agg === 'SUM') ga.addAggregate('SUM', aggField);
        else ga.addAggregate('COUNT');
        ga.query();
        var map = {}, bad = 0;
        while (ga.next()) {
            var k = ceoTrendKey(String(ga.getValue('timeref') || ''), ctx.dateFormat);
            if (!k) { bad++; continue; }
            var n = parseFloat(agg === 'SUM' ? ga.getAggregate('SUM', aggField) : ga.getAggregate('COUNT')) || 0;
            map[k] = (map[k] || 0) + n;
        }
        if (bad) return null;        /* a date format this cannot read: ask directly instead */
        return { map: map, bounded: false };
    },

    /** The same map from permission-checked rows, for a viewer who is filtered. */
    _secureDaily: function (table, rest, dateField, agg, aggField, ctx) {
        var budget = this._secureBudget();
        if (budget <= 0) return { map: {}, bounded: true };
        var started = new Date().getTime();
        var gr = new GlideRecordSecure(table);
        gr.addEncodedQuery(ceoJoin(rest, dateField + '>=javascript:gs.daysAgoStart(' + (ctx.span - 1) + ')'));
        gr.query();
        var map = {}, i = 0, capped = false;
        while (gr.next()) {
            if ((++i & 15) === 0 && new Date().getTime() - started > budget) { capped = true; break; }
            var dv = String(gr.getValue(dateField) || '');
            if (dv.length < 19) continue;
            var k = ceoLocalKey(dv, ctx.tzOffsetMs);
            var add = agg === 'SUM' ? (parseFloat(gr.getValue(aggField)) || 0) : 1;
            map[k] = (map[k] || 0) + add;
        }
        this._secureSpent += new Date().getTime() - started;
        return { map: map, bounded: capped };
    },

    /* ── the card, as the page wants it ─────────────────────────────────── */

    _shape: function (id, d, node, L, ctx) {
        var out = {
            id: id, name: d.name, unit: d.unit, dir: d.dir, kind: d.kind,
            periodApplies: d.kind === 'event',
            ok: !!L.ok, mode: L.mode || null, bounded: !!L.bounded,
            filter: L.filter || 'n/a', table: d.table
        };
        if (!L.ok) {
            out.value = null;
            out.why = L.why;
            out.denied = !!L.denied;
            return out;
        }
        var value = d.kind === 'event' ? L.win : L.pa;
        out.value = ceoRound(value, d.unit);
        out.pa = ceoRound(L.pa, d.unit);
        out.prev = ceoRound(L.prev, d.unit);
        if (value === null || value === undefined) {
            out.why = (d.kind === 'event' ? L.whyWin : L.whyPa) ||
                      'there is nothing to measure in this period';
        }
        if (L.pa === null || L.pa === undefined) out.whyPa = L.whyPa || 'not computable today';
        out.delta = ceoDelta(value, L.prev, d.dir);
        out.days = ceoRoundArray(L.days, d.unit);
        out.months = ceoRoundArray(L.months, d.unit);
        out.definition = this._definition(id, node);
        out.records = this._recordsUrl(id, node, ctx);
        return out;
    },

    /* The indicator, in words a leader can check. */
    _definition: function (id, node) {
        var self = this;
        if (node.kind === 'formula') {
            var ind = this.ceo.indicator(id) || {};
            var text = String(ind.formula || '').replace(/\[\[([0-9a-f]{32})\]\]/g, function (m, ref) {
                var r = self.ceo.indicator(ref);
                return r ? '“' + r.name + '”' : 'a missing indicator';
            }).replace(/\*/g, '×').replace(/\//g, '÷').replace(/\s+/g, ' ');
            return { formula: text, table: this._tableOf(id), slice: '' };
        }
        if (node.kind === 'refused') return { why: node.why };
        var cls = ceoClassify(node.query);
        return {
            table: node.table,
            aggregate: node.agg || 'COUNT',
            field: node.field && node.field !== 'sys_id' ? node.field : '',
            slice: this.ceo._describeQuery(node.table, cls.kind === 'event' ? cls.rest : node.query),
            dateField: cls.kind === 'event' ? cls.field : '',
            elapsed: node.kind === 'duration' ? { from: node.from, to: node.to } : null
        };
    },

    /* The platform list behind a card, over the same period and filters. */
    _recordsUrl: function (id, node, ctx) {
        var src = node;
        if (node.kind === 'formula') src = this.ceo._formulaLeaf(id, 0, {}) || null;
        if (!src || !src.table || !src.query) return null;
        var cls = ceoClassify(src.query);
        var q = cls.kind === 'event' ? ceoWindowQuery(cls, ctx.days, 0) : src.query;
        return this.drill.listUrl(src.table, ceoJoin(q, this._filterClause(src.table, ctx.filters).clause));
    },

    /* ── per-viewer memory ──────────────────────────────────────────────── */

    _cacheGet: function (key) {
        try {
            var raw = gs.getSession().getClientData(key);
            if (!raw) return null;
            var o = JSON.parse(String(raw));
            var age = new Date().getTime() - o.t;
            if (!(age >= 0) || age > CmdCeoBoard.CACHE_TTL_MS) return null;
            return o;
        } catch (e) {
            return null;
        }
    },

    _cachePut: function (key, value) {
        try {
            gs.getSession().putClientData(key, JSON.stringify({ t: new Date().getTime(), v: value }));
        } catch (e) { /* not remembering costs time, nothing else */ }
    },

    /**
     * The order the page asks for its numbers in.
     *
     * Measured on dev390988, 2026-09-14: GlideAjax calls from one session are
     * served one at a time. Two calls sent together came back at 3.4s and 4.7s,
     * the second having waited for the first. So splitting cannot make the proofs
     * run side by side; what it can do is decide what arrives first. `hero` is
     * the orbit -- the enterprise headline and each portfolio's anchor -- which is
     * what a leader looks at in the first second. `pulse` is the Summary's Speed /
     * Productivity / Risk. `rest` is every other slot.
     */
    groups: function (frame) {
        var hero = [], pulse = [], rest = [], seen = {}, i, j;
        var push = function (list, id) { if (id && !seen[id]) { seen[id] = true; list.push(id); } };
        var pulseSlots = { Speed1: true, Productivity1: true, Risk1: true };
        push(hero, frame.headline);
        for (i = 0; i < frame.portfolios.length; i++) {
            var sl = frame.portfolios[i].slots;
            for (j = 0; j < sl.length; j++) if (sl[j].slot === 'Anchor1') push(hero, sl[j].id);
        }
        for (i = 0; i < frame.portfolios.length; i++) {
            var s1 = frame.portfolios[i].slots;
            for (j = 0; j < s1.length; j++) if (pulseSlots[s1[j].slot]) push(pulse, s1[j].id);
        }
        for (i = 0; i < frame.portfolios.length; i++) {
            var s2 = frame.portfolios[i].slots;
            for (j = 0; j < s2.length; j++) push(rest, s2[j].id);
        }
        var out = [{ name: 'hero', ids: hero }];
        if (pulse.length) out.push({ name: 'pulse', ids: pulse });
        if (rest.length) out.push({ name: 'rest', ids: rest });
        return out;
    },

    /** This viewer's remembered measures for these ids, or null if any is missing. */
    cachedMeasures: function (ids, periodKey, filterStr) {
        for (var i = 0; i < ids.length; i++) {
            if (!this._cacheGet(ceoCacheKey(gs.getUserID() + '|' + CmdCeoBoard.periodOf(periodKey).key + '|' +
                                            ceoFilterKey(this.parseFilters(filterStr)), ids[i]))) return null;
        }
        return this.measures(ids, periodKey, filterStr, {});
    },

    type: 'CmdCeoBoard'
};

/* ════════════════════════════════════════════════════════════════════════════
   Pure helpers. File-level functions on plain values, prefixed so they cannot
   collide with another Script Include's, and exercised offline by
   product/tests/test_ceo_board.js against this file.
   ════════════════════════════════════════════════════════════════════════════ */

var CEO_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/* A clause that pins a date column to today, in either form PA writes it. */
var CEO_TODAY_RE = /^([a-z0-9_.]+)ON[A-Za-z ]*@javascript:gs\.(?:beginningOfToday\(\)|daysAgoStart\(0\))@javascript:gs\.(?:endOfToday\(\)|daysAgoEnd\(0\))$/;

function ceoKeys(o) {
    var out = [];
    for (var k in o) { if (o.hasOwnProperty(k)) out.push(k); }
    return out;
}

/** An encoded query as AND-groups of OR-alternatives, or null when it uses ^NQ. */
function ceoGroups(query) {
    var raw = String(query || '').split('^'), groups = [];
    for (var i = 0; i < raw.length; i++) {
        var t = raw[i].replace(/^\s+|\s+$/g, '');
        if (!t || t === 'EQ') continue;
        if (t.indexOf('NQ') === 0) return null;
        if (/^(ORDERBY|GROUPBY|TRENDBY)/.test(t)) continue;
        if (t.indexOf('OR') === 0 && groups.length) { groups[groups.length - 1].push(t.substring(2)); continue; }
        groups.push([t]);
    }
    return groups;
}

function ceoRebuild(groups) {
    var out = [];
    for (var i = 0; i < groups.length; i++) out.push(groups[i].join('^OR'));
    return out.join('^');
}

function ceoJoin(a, b) {
    a = String(a || ''); b = String(b || '');
    if (!a) return b;
    if (!b) return a;
    return a + '^' + b;
}

/**
 * What kind of measure a PA query describes.
 *
 *   event   one AND-clause pins one date column to today: a flow ("resolved today").
 *           The period widens that clause and nothing else.
 *   stock   the today window sits inside an OR group -- PA's "open as at the end of
 *           today" shape. A point in time, so the period does not apply.
 *   static  no today window at all; the value is simply now.
 */
function ceoClassify(query) {
    var g = ceoGroups(query);
    if (!g) return { kind: 'static', rest: String(query || '') };
    var eventAt = -1, field = null, stock = false, events = 0;
    for (var i = 0; i < g.length; i++) {
        for (var j = 0; j < g[i].length; j++) {
            var m = CEO_TODAY_RE.exec(g[i][j]);
            if (!m) continue;
            if (g[i].length === 1) { events++; eventAt = i; field = m[1]; }
            else stock = true;
        }
    }
    if (events === 1 && !stock) {
        var rest = [];
        for (var k = 0; k < g.length; k++) { if (k !== eventAt) rest.push(g[k]); }
        return { kind: 'event', field: field, rest: ceoRebuild(rest) };
    }
    if (stock && !events) return { kind: 'stock', relative: /RELATIVE/.test(String(query)) };
    return { kind: 'static' };
}

/** An event query over `days` days ending `offset` days ago. */
function ceoWindowQuery(cls, days, offset) {
    var f = cls.field;
    return ceoJoin(cls.rest,
        f + '>=javascript:gs.daysAgoStart(' + (offset + days - 1) + ')^' +
        f + '<=javascript:gs.daysAgoEnd(' + offset + ')');
}

/**
 * A stock query as it would have read `n` days ago, or null.
 * Null when the query carries a RELATIVE clause ("not updated in 30 days"): that
 * is measured from now, not from the as-of day, and shifting the rest of the query
 * around it would describe a set nobody ever counted.
 */
function ceoAsOf(query, n) {
    var q = String(query || '');
    if (/RELATIVE/.test(q)) return null;
    return q.replace(/gs\.beginningOfToday\(\)/g, 'gs.daysAgoStart(' + n + ')')
            .replace(/gs\.endOfToday\(\)/g, 'gs.daysAgoEnd(' + n + ')')
            .replace(/gs\.daysAgoStart\(0\)/g, 'gs.daysAgoStart(' + n + ')')
            .replace(/gs\.daysAgoEnd\(0\)/g, 'gs.daysAgoEnd(' + n + ')');
}

/** A stock query as at the end of the month `k` months back. */
function ceoAsOfMonthEnd(query, k) {
    var q = String(query || '');
    if (/RELATIVE/.test(q)) return null;
    var e = 'gs.monthsAgoEnd(' + k + ')';
    return q.replace(/gs\.beginningOfToday\(\)|gs\.endOfToday\(\)|gs\.daysAgoStart\(0\)|gs\.daysAgoEnd\(0\)/g, e);
}

/* ── calendar arithmetic on yyyy-MM-dd strings ───────────────────────────── */

function ceoIsoToMs(iso) {
    return Date.UTC(parseInt(iso.substring(0, 4), 10), parseInt(iso.substring(5, 7), 10) - 1,
                    parseInt(iso.substring(8, 10), 10));
}

function ceoMsToIso(ms) {
    var d = new Date(ms);
    var m = d.getUTCMonth() + 1, day = d.getUTCDate();
    return d.getUTCFullYear() + '-' + (m < 10 ? '0' : '') + m + '-' + (day < 10 ? '0' : '') + day;
}

function ceoIsoAdd(iso, n) { return ceoMsToIso(ceoIsoToMs(iso) + n * 86400000); }

function ceoDaysBetween(a, b) { return Math.round((ceoIsoToMs(b) - ceoIsoToMs(a)) / 86400000); }

/** yyyy-MM of the month `back` months before the one holding `iso`. */
function ceoMonthBack(iso, back) {
    var y = parseInt(iso.substring(0, 4), 10), m = parseInt(iso.substring(5, 7), 10) - back;
    while (m <= 0) { m += 12; y--; }
    return y + '-' + (m < 10 ? '0' : '') + m;
}

/** A stored 'yyyy-MM-dd HH:mm:ss' UTC datetime as epoch milliseconds, or null. */
function ceoUtcMs(dv) {
    if (!dv || dv.length < 19) return null;
    return Date.UTC(parseInt(dv.substring(0, 4), 10), parseInt(dv.substring(5, 7), 10) - 1,
                    parseInt(dv.substring(8, 10), 10), parseInt(dv.substring(11, 13), 10),
                    parseInt(dv.substring(14, 16), 10), parseInt(dv.substring(17, 19), 10));
}

/** A stored UTC datetime as the viewer's calendar date. */
function ceoLocalKey(dv, offsetMs) {
    var ms = Date.UTC(parseInt(dv.substring(0, 4), 10), parseInt(dv.substring(5, 7), 10) - 1,
                      parseInt(dv.substring(8, 10), 10), parseInt(dv.substring(11, 13), 10),
                      parseInt(dv.substring(14, 16), 10), parseInt(dv.substring(17, 19), 10));
    return ceoMsToIso(ms + (offsetMs || 0));
}

/**
 * A GlideAggregate day-trend key ("2026-09-08/2026", in the viewer's own date
 * format) as yyyy-MM-dd, or null when the format is not one this can read.
 */
function ceoTrendKey(timeref, fmt) {
    var s = String(timeref || '').replace(/\/\d{4}$/, '');
    var f = String(fmt || 'yyyy-MM-dd');
    var order = [], rx = '^';
    for (var i = 0; i < f.length;) {
        if (f.substr(i, 4) === 'yyyy') { rx += '(\\d{4})'; order.push('y'); i += 4; continue; }
        if (f.substr(i, 2) === 'MM') { rx += '(\\d{1,2})'; order.push('m'); i += 2; continue; }
        if (f.substr(i, 2) === 'dd') { rx += '(\\d{1,2})'; order.push('d'); i += 2; continue; }
        var ch = f.charAt(i);
        rx += /[A-Za-z0-9]/.test(ch) ? ch : '\\' + ch;
        i++;
    }
    var m = new RegExp(rx + '$').exec(s);
    if (!m || order.length !== 3) {
        m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
        if (!m) return null;
        return s;
    }
    var y = 0, mo = 0, d = 0;
    for (var j = 0; j < 3; j++) {
        var v = parseInt(m[j + 1], 10);
        if (order[j] === 'y') y = v; else if (order[j] === 'm') mo = v; else d = v;
    }
    if (!y || !mo || !d) return null;
    return y + '-' + (mo < 10 ? '0' : '') + mo + '-' + (d < 10 ? '0' : '') + d;
}

/* ── from a daily map to a card ──────────────────────────────────────────── */

function ceoFill(L, map, ctx) {
    var keys = ctx.dayKeys, D = ctx.days, i;
    var sum = function (from, to) {
        var t = 0;
        for (var k = from; k < to && k < keys.length; k++) t += map[keys[k]] || 0;
        return t;
    };
    L.pa = map[keys[0]] || 0;
    L.win = D === 1 ? L.pa : sum(0, D);
    L.prev = keys.length >= 2 * D ? sum(D, 2 * D) : null;
    var days = [];
    for (i = CmdCeoBoard.DAYS - 1; i >= 0; i--) days.push(map[keys[i]] || 0);
    L.days = days;
    var byMonth = {};
    for (i = 0; i < keys.length; i++) {
        var ym = keys[i].substring(0, 7);
        byMonth[ym] = (byMonth[ym] || 0) + (map[keys[i]] || 0);
    }
    var months = [];
    for (i = 0; i < ctx.monthKeys.length; i++) months.push(byMonth[ctx.monthKeys[i]] || 0);
    L.months = months;
}

/** A formula tree evaluated with values from `get`, or {v:null, why}. */
function ceoEval(ast, get) {
    var why = null;
    var walk = function (n) {
        if (why) return 0;
        if (n.num !== undefined) return n.num;
        if (n.ref !== undefined) {
            var x = get(n.ref);
            if (x === null || x === undefined || isNaN(x)) { why = 'a component of this measure has no value here'; return 0; }
            return x;
        }
        if (n.op === 'neg') return -walk(n.a);
        var a = walk(n.a), b = walk(n.b);
        if (why) return 0;
        if (n.op === '+') return a + b;
        if (n.op === '-') return a - b;
        if (n.op === '*') return a * b;
        if (n.op === '/') {
            if (b === 0) { why = 'its denominator is zero, so there is nothing to divide'; return 0; }
            return a / b;
        }
        why = 'unsupported operator';
        return 0;
    };
    var v = walk(ast);
    return why ? { v: null, why: why } : { v: v, why: null };
}

/** The same formula applied point by point to its components' histories. */
function ceoEvalArray(ast, parts, field) {
    var len = -1;
    for (var r in parts) {
        if (!parts.hasOwnProperty(r)) continue;
        var arr = parts[r][field];
        if (!arr) return null;
        if (len === -1) len = arr.length;
        else if (len !== arr.length) return null;
    }
    if (len <= 0) return null;
    var out = [], any = false;
    for (var i = 0; i < len; i++) {
        var e = ceoEval(ast, function (ref) { return parts[ref][field][i]; });
        out.push(e.v);
        if (e.v) any = true;
    }
    return any ? out : null;
}

function ceoRound(v, unit) {
    if (v === null || v === undefined || isNaN(v)) return null;
    return Math.round(v * 100) / 100;
}

function ceoRoundArray(arr, unit) {
    if (!arr) return null;
    var out = [];
    for (var i = 0; i < arr.length; i++) out.push(ceoRound(arr[i], unit));
    return out;
}

/** Change against the previous period, and whether that is good news. */
function ceoDelta(cur, prev, dir) {
    if (cur === null || cur === undefined || prev === null || prev === undefined) return null;
    var abs = cur - prev;
    var rel = prev !== 0 ? abs / Math.abs(prev) : null;
    var better = null;
    if (abs !== 0 && dir === 'down') better = abs < 0;
    if (abs !== 0 && dir === 'up') better = abs > 0;
    return { abs: Math.round(abs * 100) / 100,
             rel: rel === null ? null : Math.round(rel * 10000) / 10000,
             prev: Math.round(prev * 100) / 100, better: better };
}

function ceoMode(v) {
    if (!v) return null;
    return v.denied ? 'DENIED' : v.capped ? 'BOUNDED' : v.trusted ? 'VERIFIED' : 'FILTERED';
}

function ceoWorstMode(modes) {
    var rank = { VERIFIED: 0, FILTERED: 1, BOUNDED: 2, DENIED: 3 }, worst = 'VERIFIED';
    for (var i = 0; i < modes.length; i++) {
        if (modes[i] && rank[modes[i]] > rank[worst]) worst = modes[i];
    }
    return worst;
}

function ceoFilterState(states) {
    var all = true, none = true, any = false;
    for (var i = 0; i < states.length; i++) {
        if (states[i] === 'n/a') continue;
        any = true;
        if (states[i] !== 'all') all = false;
        if (states[i] !== 'none') none = false;
    }
    if (!any) return 'n/a';
    return all ? 'all' : none ? 'none' : 'some';
}

function ceoFilterKey(filters) {
    var out = [];
    for (var i = 0; i < filters.length; i++) out.push(filters[i].field + ':' + filters[i].values.join(','));
    return out.join('|');
}

/** Portfolio2 before Portfolio10. */
function ceoNaturalCompare(a, b) {
    var ra = /^(.*?)(\d+)$/.exec(String(a)), rb = /^(.*?)(\d+)$/.exec(String(b));
    if (ra && rb && ra[1].toLowerCase() === rb[1].toLowerCase()) {
        return parseInt(ra[2], 10) - parseInt(rb[2], 10);
    }
    return String(a).toLowerCase() < String(b).toLowerCase() ? -1 : 1;
}

/** One remembered entry: this viewer, period and filter, and one indicator. */
function ceoCacheKey(base, id) {
    return CmdCeoBoard.CACHE_PREFIX + ceoHash(base) + '.' + id;
}

/** 32-bit FNV-1a, as hex. A cache key, not a secret. */
function ceoHash(s) {
    var h = 0x811c9dc5;
    s = String(s);
    for (var i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return ('0000000' + h.toString(16)).slice(-8);
}
