/**
 * CmdCeo. Redrawing a Performance Analytics dashboard in COMMAND's own terms.
 *
 * The client has a CEO Dashboard on their instance: a UI Builder experience with
 * eight portfolio pages, each holding eight KPI cards and a breakdown chart. They
 * asked for exactly one of those pages redrawn in our design, to put in front of
 * their leadership. Not a converter for everything -- one page, done properly.
 *
 * The thing that makes this non-trivial is that it is not built the way the rest
 * of our conversion path assumes. Everything else here starts from a table, a
 * filter and a chart type. This starts from a `pa_indicators` reference, and an
 * indicator is not a query. Measured on the client instance, the 72 config rows
 * of that dashboard resolve to 27 distinct indicators, and they come in three
 * kinds:
 *
 *   - 20 leaf indicators, which do resolve to a table and a filter, through
 *     `cube` -> `pa_cubes.facts_table` plus the conditions on both records.
 *   -  6 scripted, which are age and duration expressions with no column behind
 *     them: `hours(current.opened_at, score_end)` and five siblings of the same
 *     shape. They are recognised, not executed -- see _script.
 *   -  9 formula, which are arithmetic over other indicators, and nest.
 *
 * So this module resolves an indicator to something computable, and then computes
 * it the way the rest of the product computes everything: permission-checked,
 * through CmdData, so a converted card inherits the same ACL verdict as any other
 * number on any other page. That is the whole point of redrawing it rather than
 * screenshotting it -- PA's own scores bypass row-level ACLs, and ours do not, so
 * for any viewer who is not an admin the two will differ and ours is the one that
 * matches what the viewer can open.
 *
 * What it does not do is read `pa_scores`. That table is empty on the client
 * instance, which is why every sparkline on their dashboard draws the same shape.
 * Trends here are computed from the base table like every other trend in this
 * product.
 *
 * ES5 only. Rhino, and an es_latest scope. No `eval` anywhere near the formulas.
 */
var CmdCeo = Class.create();

/* pa_indicators.aggregate. Read from sys_choice on the client instance rather
   than remembered: an earlier draft of the findings had 3/4/5 as Max/Min/Avg,
   which would have silently mislabelled every Average indicator. */
CmdCeo.AGG = {
    '1': 'COUNT', '2': 'SUM', '3': 'AVG',
    '4': 'MIN', '5': 'MAX', '6': 'COUNT_DISTINCT'
};

/* pa_indicators.type. 1 is collected from a source, the rest are derived. */
CmdCeo.TYPE_AUTOMATED = '1';

/* How deep a formula may nest before we stop. The client's deepest is two, so
   this is not a limit anyone reaches -- it is there because the references form a
   graph that nothing stops from containing a cycle, and a cycle would otherwise
   be an infinite loop inside a page render. Cycles are also detected directly;
   this is the second bound. */
CmdCeo.MAX_DEPTH = 6;

/* Which table holds the dashboard's slot configuration.
 *
 * On the client this is Control Tower's own table. On a development instance
 * Control Tower is not installed, and it does not need to be: the PA indicators
 * are platform content with stable sys_ids -- 24 of the 27 the CEO dashboard uses
 * are already present on dev390988 with identical ids -- so only the 72 config
 * rows have to be reproduced. Pointing at that copy is a property, not a code
 * change, which is what keeps the tested path and the delivered path the same. */
CmdCeo.SOURCE_PROPERTY = 'x_2185255_command.ceo_source_table';
CmdCeo.DEFAULT_SOURCE = 'sn_controltower_ceo_dashboard';

/* Which portfolios the catalog offers.
 *
 * The client asked for one page redrawn, and said so twice. The resolver handles
 * all eight and the source table describes all eight, but offering all eight
 * would put seven pages nobody asked for in front of them -- and on any instance
 * where the other portfolios are thin, seven sparse pages argue against the one
 * good one. Empty means every portfolio; the default is the one that was asked
 * for. Reaching a portfolio by URL always works regardless. */
CmdCeo.OFFER_PROPERTY = 'x_2185255_command.ceo_portfolios';
CmdCeo.DEFAULT_OFFER = 'Portfolio1';

/* The slots a portfolio page has, in the order the original draws them. The
   names are Control Tower's. Bubblechart is the breakdown panel; the rest are
   KPI cards. */
CmdCeo.SLOT_ORDER = ['Anchor1', 'Anchor2', 'Speed1', 'Speed2',
                     'Productivity1', 'Productivity2', 'Risk1', 'Risk2',
                     'Bubblechart'];

CmdCeo.prototype = {

    initialize: function (data, meta, drill) {
        this.data = data;
        this.meta = meta;
        this.drill = drill;
        this._ind = {};        /* sys_id -> pa_indicators row, memoised */
        this._cube = {};       /* sys_id -> pa_cubes row, memoised */
        this._val = {};        /* sys_id -> computed value, memoised per request */
        this._cols = null;
    },

    /* ── configuration ─────────────────────────────────────────────────── */

    sourceTable: function () {
        var t = gs.getProperty(CmdCeo.SOURCE_PROPERTY, '');
        return t ? String(t) : CmdCeo.DEFAULT_SOURCE;
    },

    /**
     * The four columns this reads, resolved against whichever table is
     * configured.
     *
     * Control Tower's own table names them plainly. A table created on a
     * development instance cannot: the platform prefixes custom columns with
     * `u_`, and refusing to cope with that would mean the code exercised in
     * testing was not the code that ships. So the names are discovered from the
     * dictionary rather than assumed, and a table that has neither shape is
     * reported as such instead of silently reading nothing.
     */
    columns: function () {
        if (this._cols) return this._cols;
        var t = this.sourceTable();
        var present = {};
        var gr = new GlideRecord('sys_dictionary');
        gr.addQuery('name', t);
        gr.addNotNullQuery('element');
        gr.query();
        while (gr.next()) present[gr.getValue('element')] = true;

        var plain = { portfolio: 'business_function', slot: 'metric_type',
                      indicator: 'pa_indicator', breakdown: 'breakdown',
                      active: 'active' };
        var pref = { portfolio: 'u_business_function', slot: 'u_metric_type',
                     indicator: 'u_pa_indicator', breakdown: 'u_breakdown',
                     active: 'u_active' };

        if (present[plain.portfolio] && present[plain.indicator]) this._cols = plain;
        else if (present[pref.portfolio] && present[pref.indicator]) this._cols = pref;
        else this._cols = null;
        return this._cols;
    },

    available: function () {
        var t = this.sourceTable();
        if (!this.meta.describe(t)) return false;
        return !!this.columns();
    },

    /** The portfolios the catalog should offer, which is not all of them. */
    offered: function () {
        var raw = gs.getProperty(CmdCeo.OFFER_PROPERTY, CmdCeo.DEFAULT_OFFER);
        raw = String(raw === null || raw === undefined ? '' : raw);
        var all = this.portfolios();
        if (!raw) return all;

        var want = {}, parts = raw.split(','), i;
        for (i = 0; i < parts.length; i++) {
            var t = parts[i].replace(/^\s+|\s+$/g, '').toLowerCase();
            if (t) want[t] = true;
        }
        var out = [];
        for (i = 0; i < all.length; i++) {
            if (want[String(all[i]).toLowerCase()]) out.push(all[i]);
        }
        return out;
    },

    /** A portfolio's name as it should read, from the key the source stores. */
    portfolioLabel: function (name) {
        var m = /^([A-Za-z]+?)\s*(\d+)$/.exec(String(name || ''));
        if (!m) return String(name || '');
        var word = m[1];
        return word.charAt(0).toUpperCase() + word.substring(1).toLowerCase() +
               ' ' + m[2];
    },

    /** Every portfolio the configured source declares, in first-seen order. */
    portfolios: function () {
        var c = this.columns();
        if (!c) return [];
        var out = [], seen = {};
        var gr = new GlideRecord(this.sourceTable());
        gr.addQuery(c.active, true);
        gr.orderBy(c.portfolio);
        gr.query();
        while (gr.next()) {
            var p = gr.getValue(c.portfolio);
            if (!p || seen[p]) continue;
            seen[p] = true;
            out.push(p);
        }
        return out;
    },

    /** The slots of one portfolio: slot name -> {indicator, breakdown}. */
    slots: function (portfolio) {
        var c = this.columns();
        if (!c) return {};
        var out = {};
        var gr = new GlideRecord(this.sourceTable());
        gr.addQuery(c.portfolio, portfolio);
        gr.addQuery(c.active, true);
        gr.query();
        while (gr.next()) {
            var slot = gr.getValue(c.slot);
            if (!slot) continue;
            out[slot] = {
                indicator: gr.getValue(c.indicator),
                breakdown: gr.getValue(c.breakdown) || ''
            };
        }
        return out;
    },

    /* ── resolving an indicator to something computable ────────────────── */

    indicator: function (id) {
        if (this._ind[id] !== undefined) return this._ind[id];
        var gr = new GlideRecord('pa_indicators');
        this._ind[id] = gr.get(id) ? {
            sys_id: id,
            name: gr.getValue('name'),
            type: gr.getValue('type'),
            aggregate: gr.getValue('aggregate'),
            field: gr.getValue('field'),
            conditions: gr.getValue('conditions') || '',
            cube: gr.getValue('cube') || '',
            formula: gr.getValue('formula') || '',
            /* '1', not 'true'. GlideRecord.getValue returns a boolean column as
               '0' or '1', and comparing it against 'true' is false for every row
               -- which silently turned all six scripted indicators into a plain
               SUM over whatever vestigial column they name. `Summed age of open
               incidents` declares field='active', so summing it counted the open
               rows, and the average-age formula above it came out as exactly
               1/24 of a day for every portfolio. It looked like a number. */
            scripted: this._bool(gr.getValue('scripted')),
            script: gr.getValue('script') || '',
            unit: gr.getValue('unit') || '',
            precision: gr.getValue('precision') || ''
        } : null;
        return this._ind[id];
    },

    /* A boolean as GlideRecord reports it. Accepts both spellings because the
       Table API says 'true'/'false' and getValue says '1'/'0', and this module is
       read from both directions. */
    _bool: function (v) {
        var s = String(v === null || v === undefined ? '' : v).toLowerCase();
        return s === '1' || s === 'true';
    },

    cube: function (id) {
        if (!id) return null;
        if (this._cube[id] !== undefined) return this._cube[id];
        var gr = new GlideRecord('pa_cubes');
        this._cube[id] = gr.get(id) ? {
            name: gr.getValue('name'),
            table: gr.getValue('facts_table'),
            conditions: gr.getValue('conditions') || ''
        } : null;
        return this._cube[id];
    },

    /**
     * What an indicator actually asks of the data, or a refusal saying why not.
     *
     * Returns one of:
     *   {kind:'count',    table, query, agg, field}
     *   {kind:'duration', table, query, from, to}
     *   {kind:'formula',  ast, refs}
     *   {kind:'refused',  why}
     *
     * A refusal is a first-class result. The alternative -- guessing at an
     * indicator we do not understand -- puts a plausible number on a leadership
     * dashboard with nothing to mark it as invented, which is the one outcome
     * worse than a blank card.
     */
    resolve: function (id, depth, seen) {
        depth = depth || 0;
        seen = seen || {};
        var ind = this.indicator(id);
        if (!ind) return { kind: 'refused', why: 'indicator ' + id + ' does not exist' };
        if (depth > CmdCeo.MAX_DEPTH) {
            return { kind: 'refused', why: 'formula nests deeper than ' + CmdCeo.MAX_DEPTH };
        }
        if (seen[id]) {
            return { kind: 'refused', why: 'the formula for "' + ind.name + '" refers back to itself' };
        }

        if (ind.formula) {
            var ast = this.parseFormula(ind.formula);
            if (!ast) {
                return { kind: 'refused',
                         why: 'the formula for "' + ind.name + '" is not arithmetic this can read' };
            }
            return { kind: 'formula', ast: ast, name: ind.name, unit: ind.unit, id: id };
        }

        if (ind.scripted) {
            var s = this._script(ind);
            if (!s) {
                return { kind: 'refused',
                         why: '"' + ind.name + '" is computed by a script whose shape is ' +
                              'not one of the elapsed-time forms this recognises' };
            }
            var cs = this.cube(ind.cube);
            if (!cs || !cs.table) {
                return { kind: 'refused', why: '"' + ind.name + '" has no source table' };
            }
            return { kind: 'duration', table: cs.table,
                     query: this._query(cs, ind), from: s.from, to: s.to,
                     agg: CmdCeo.AGG[ind.aggregate] || 'SUM',
                     name: ind.name, unit: ind.unit, id: id };
        }

        var c = this.cube(ind.cube);
        if (!c || !c.table) {
            return { kind: 'refused',
                     why: '"' + ind.name + '" is not a formula and has no source table' };
        }
        return { kind: 'count', table: c.table, query: this._query(c, ind),
                 agg: CmdCeo.AGG[ind.aggregate] || 'COUNT',
                 field: ind.field || 'sys_id',
                 name: ind.name, unit: ind.unit, id: id };
    },

    /* The filter is the cube's, narrowed by the indicator's own. Both are stored
       as encoded queries and PA applies them together. */
    _query: function (cube, ind) {
        var parts = [];
        if (cube.conditions) parts.push(cube.conditions);
        if (ind.conditions) parts.push(ind.conditions);
        return parts.join('^');
    },

    /**
     * The two moments a PA time script measures between, or null.
     *
     * Every scripted indicator on the client's CEO dashboard -- all six of them --
     * is the same three lines, differing only in its two arguments:
     *
     *     var diff=function(x,y){return y.dateNumericValue() - x.dateNumericValue();};
     *     var hours=function(x,y){return diff(x,y)/(60*60*1000);};
     *     hours(current.opened_at, score_end);
     *
     * So the script is recognised rather than run. Matching a known shape and
     * refusing everything else is the only safe way to read someone else's script
     * from a dashboard: executing it would mean running arbitrary stored code with
     * this user's rights, and approximating it would mean inventing a number.
     *
     * `score_end` is the moment the score was taken, which for a live figure is
     * now. That is what separates an age from a duration.
     */
    _script: function (ind) {
        if (!ind.script) return null;
        var gr = new GlideRecord('pa_scripts');
        if (!gr.get(ind.script)) return null;
        var src = String(gr.getValue('script') || '');

        var m = /hours\s*\(\s*([A-Za-z_.]+)\s*,\s*([A-Za-z_.]+)\s*\)/.exec(src);
        if (!m) return null;

        var operand = function (t) {
            if (t === 'score_end' || t === 'score_start') return '*now*';
            var f = /^current\.([A-Za-z0-9_]+)$/.exec(t);
            return f ? f[1] : null;
        };
        var from = operand(m[1]), to = operand(m[2]);
        if (!from || !to) return null;
        if (from === '*now*' && to === '*now*') return null;
        return { from: from, to: to };
    },

    /* ── the formula language ──────────────────────────────────────────── */

    /**
     * A PA formula, parsed to a tree. Never evaluated as JavaScript.
     *
     * The grammar is small and closed: numbers, references of the form
     * [[sys_id]], the four operators, parentheses and unary minus. `eval` would
     * be shorter and would also mean handing a string stored in a table on
     * someone else's instance to the script engine, with our rights.
     *
     * Returns null for anything outside the grammar, which becomes a refusal
     * upstream rather than a zero.
     */
    parseFormula: function (src) {
        var text = String(src || '');
        var toks = [], i = 0;
        while (i < text.length) {
            var ch = text.charAt(i);
            if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') { i++; continue; }
            if (ch === '[' && text.charAt(i + 1) === '[') {
                var close = text.indexOf(']]', i + 2);
                if (close === -1) return null;
                var ref = text.substring(i + 2, close);
                if (!/^[0-9a-f]{32}$/.test(ref)) return null;
                toks.push({ t: 'ref', v: ref });
                i = close + 2;
                continue;
            }
            if (ch >= '0' && ch <= '9' || ch === '.') {
                var j = i;
                while (j < text.length && /[0-9.]/.test(text.charAt(j))) j++;
                var numTxt = text.substring(i, j);
                if (!/^[0-9]+(\.[0-9]+)?$|^\.[0-9]+$/.test(numTxt)) return null;
                toks.push({ t: 'num', v: parseFloat(numTxt) });
                i = j;
                continue;
            }
            if ('+-*/()'.indexOf(ch) !== -1) { toks.push({ t: ch }); i++; continue; }
            return null;
        }
        if (!toks.length) return null;

        var pos = 0;
        function peek() { return pos < toks.length ? toks[pos] : null; }
        function take() { return toks[pos++]; }

        function expr() {
            var left = term();
            if (left === null) return null;
            for (;;) {
                var p = peek();
                if (!p || (p.t !== '+' && p.t !== '-')) return left;
                take();
                var right = term();
                if (right === null) return null;
                left = { op: p.t, a: left, b: right };
            }
        }
        function term() {
            var left = unary();
            if (left === null) return null;
            for (;;) {
                var p = peek();
                if (!p || (p.t !== '*' && p.t !== '/')) return left;
                take();
                var right = unary();
                if (right === null) return null;
                left = { op: p.t, a: left, b: right };
            }
        }
        function unary() {
            var p = peek();
            if (p && p.t === '-') { take(); var u = unary(); return u === null ? null : { op: 'neg', a: u }; }
            if (p && p.t === '+') { take(); return unary(); }
            return atom();
        }
        function atom() {
            var p = peek();
            if (!p) return null;
            if (p.t === 'num') { take(); return { num: p.v }; }
            if (p.t === 'ref') { take(); return { ref: p.v }; }
            if (p.t === '(') {
                take();
                var e = expr();
                if (e === null) return null;
                var c = peek();
                if (!c || c.t !== ')') return null;
                take();
                return e;
            }
            return null;
        }

        var ast = expr();
        if (ast === null || pos !== toks.length) return null;
        return ast;
    },

    /* ── computing ─────────────────────────────────────────────────────── */

    /**
     * An indicator's value, permission-checked, or a refusal.
     *
     * Returns {ok:true, value, table, query, acl} or {ok:false, why}.
     *
     * Division by zero returns a refusal rather than Infinity or NaN. On this
     * dashboard that is not a corner case: 51 of the 72 slots on the client
     * instance currently have no data behind them, so several of the ratios have
     * a zero denominator, and "not computable" is the honest thing for a card to
     * say where PA prints a 0.
     */
    value: function (id, depth, seen) {
        depth = depth || 0;
        seen = seen || {};
        if (this._val[id] !== undefined && depth === 0) return this._val[id];

        var node = this.resolve(id, depth, seen);
        var out = this._valueOf(node, depth, seen);
        if (depth === 0) this._val[id] = out;
        return out;
    },

    _valueOf: function (node, depth, seen) {
        if (node.kind === 'refused') return { ok: false, why: node.why };

        if (node.kind === 'count') {
            var verdict = this.data.aclVerdict(node.table, node.query);
            if (verdict.denied) {
                return { ok: false, denied: true, table: node.table, query: node.query,
                         why: 'you cannot read any of the records behind this measure' };
            }
            var n;
            if (node.agg === 'COUNT') {
                /* total() returns the count together with how it was reached, so
                   that no caller can print a number without the verdict that
                   qualifies it. The verdict is already carried on the result
                   below; what is wanted here is the number. */
                n = this.data.total(node.table, node.query).count;
            } else {
                n = this._aggregate(node);
                if (n === null) {
                    return { ok: false, why: 'the ' + node.agg + ' of ' +
                             (node.field || '') + ' could not be measured here' };
                }
            }
            return { ok: true, value: n, table: node.table, query: node.query,
                     acl: verdict, unit: node.unit };
        }

        if (node.kind === 'duration') {
            var v2 = this.data.aclVerdict(node.table, node.query);
            if (v2.denied) {
                return { ok: false, denied: true, table: node.table, query: node.query,
                         why: 'you cannot read any of the records behind this measure' };
            }
            var r = this.data.reduce(node.table, node.query, [{
                id: 'd', kind: 'duration',
                startField: node.from, endField: node.to, groupField: null
            }]);
            if (r.starved) {
                return { ok: false, why: 'this page ran out of its scan budget before ' +
                                         'this elapsed-time measure could be taken' };
            }
            var res = r.results && r.results.d;
            var rows = (res && res.rows && res.rows.length) ? res.rows[0] : null;
            if (!rows || !rows.n) {
                return { ok: false, why: 'no record here has both moments recorded, ' +
                                         'so there is no elapsed time to measure' };
            }
            /* PA's elapsed-time indicators are sums, and the formulas above them
               divide that sum by a count to get an average. The accumulator
               carries both, so the sum is taken directly rather than rebuilt from
               a rounded mean. */
            return { ok: true, value: rows.sumHours, mean: rows.hours,
                     rows: rows.n, table: node.table, query: node.query,
                     acl: v2, unit: node.unit, partial: !!r.capped };
        }

        if (node.kind === 'formula') {
            var self = this;
            var nextSeen = {};
            for (var k in seen) { if (seen.hasOwnProperty(k)) nextSeen[k] = true; }
            nextSeen[node.id] = true;

            var failure = null;
            var walk = function (n) {
                if (failure) return 0;
                if (n.num !== undefined) return n.num;
                if (n.ref !== undefined) {
                    var sub = self.value(n.ref, depth + 1, nextSeen);
                    if (!sub.ok) { failure = sub.why; return 0; }
                    return sub.value;
                }
                if (n.op === 'neg') return -walk(n.a);
                var a = walk(n.a), b = walk(n.b);
                if (failure) return 0;
                if (n.op === '+') return a + b;
                if (n.op === '-') return a - b;
                if (n.op === '*') return a * b;
                if (n.op === '/') {
                    if (b === 0) { failure = 'its denominator is zero, so there is nothing to divide'; return 0; }
                    return a / b;
                }
                failure = 'unsupported operator';
                return 0;
            };
            var val = walk(node.ast);
            if (failure) return { ok: false, why: failure };
            return { ok: true, value: val, unit: node.unit, derived: true };
        }

        return { ok: false, why: 'this measure is of a kind this cannot compute' };
    },

    /**
     * SUM/AVG/MIN/MAX over a column, through the same shared scan as everything
     * else so it is permission-checked and charged to the same request budget.
     *
     * min and max come from the accumulator's own min/max, not from its whisker
     * ends: `lo` and `hi` are clamped to 1.5 IQR for the box plot that normally
     * consumes this, and reporting a clamped bound as an indicator's MAX would
     * understate it by exactly the outliers a leader is looking for.
     */
    _aggregate: function (node) {
        var f = node.field;
        if (!f || f === 'sys_id') return null;
        var r = this.data.reduce(node.table, node.query,
                                 [{ id: 'm', kind: 'measure', field: f, groupField: null }]);
        if (r.starved) return null;
        var res = r.results && r.results.m;
        var row = (res && res.rows && res.rows.length) ? res.rows[0] : null;
        if (!row || !row.n) return null;
        if (node.agg === 'SUM') return row.sum;
        if (node.agg === 'AVG') return row.avg;
        if (node.agg === 'MIN') return row.min;
        if (node.agg === 'MAX') return row.max;
        return null;
    },

    /* ── the page ──────────────────────────────────────────────────────── */

    /**
     * One portfolio, as a payload the existing renderer already knows how to draw.
     *
     * Deliberately no new drawing code. The cards come out as `kpi` panels and the
     * breakdown as an ordinary dimension panel, so a converted CEO page inherits
     * the approved design, the chart chooser, the drilldown and the ACL badge by
     * being the same shape as every other page rather than by copying them.
     */
    portfolio: function (name, opts) {
        opts = opts || {};
        /* Named for what it is, and not `t0`: the subject-picking loop below uses
           `t0` for a table name, `var` is function-scoped, and the timer was
           therefore a string by the time it was read -- `number - "incident"` is
           NaN, which JSON writes as null, which the header printed as
           "built in undefinedms". */
        var startedAt = new Date().getTime();
        var slots = this.slots(name);
        var slotNames = CmdCeo.SLOT_ORDER;
        var i, k;

        /* Which table this page is mostly about, decided by counting rather than
           assumed to be `incident`: portfolio 2 mixes in sys_user and change. */
        var tally = {}, best = null;
        for (i = 0; i < slotNames.length; i++) {
            var s0 = slots[slotNames[i]];
            if (!s0) continue;
            var n0 = this.resolve(s0.indicator);
            var t0 = n0.table || this._formulaTable(s0.indicator, 0, {});
            if (!t0) continue;
            tally[t0] = (tally[t0] || 0) + 1;
            if (!best || tally[t0] > tally[best]) best = t0;
        }
        var table = best || 'incident';

        /* One proof for the whole page.
         *
         * Every card on a portfolio filters the same table a different way, and
         * each of those queries would otherwise open its own permission proof --
         * eight scans where one will do. Proving the unfiltered table first lets
         * every narrower query inherit that proof, which is exactly what
         * CmdData._trustedFor exists for: a viewer who can read every row of the
         * table can read every row of a subset of it. */
        var verdict = this.data.aclVerdict(table, '');

        var d = this.meta.describe(table);
        var payload = {
            version: 1,
            generated: new GlideDateTime().getDisplayValue(),
            viewer: { name: gs.getUserName(), display: gs.getUserDisplayName() },
            subject: {
                table: table,
                label: (d && d.label) ? d.label : table,
                rows: this.data.total(table, '').count
            },
            ceo: { portfolio: name, source: this.sourceTable() },
            acl: {
                mode: verdict.denied ? 'DENIED'
                    : (verdict.trusted ? 'VERIFIED' : 'FILTERED'),
                aggregate: verdict.aggregate, secure: verdict.secure,
                delta: verdict.delta, capped: verdict.capped
            },
            kpis: [], panels: [], notes: [], path: [],
            drill: { atMax: false, options: [] },
            window: { months: 12, allowed: [3, 6, 12] }, forms: {}
        };

        var refusedCount = 0;
        for (i = 0; i < slotNames.length; i++) {
            var slotName = slotNames[i];
            var slot = slots[slotName];
            if (!slot) continue;

            if (slotName === 'Bubblechart') {
                var panel = this._breakdownPanel(slot, slotName);
                if (panel) payload.panels.push(panel);
                continue;
            }

            var node = this.resolve(slot.indicator);
            var v = this.value(slot.indicator);
            var card = {
                id: 'ceo_' + slotName,
                kind: 'kpi', form: 'kpi', slot: slotName,
                fieldLabel: node.name || slotName,
                unit: this._unitCode(node.unit)
            };
            if (v.ok) {
                card.value = this._round(v.value, card.unit);
                card.note = node.kind === 'formula'
                    ? 'derived from other measures'
                    : (node.table + (node.query ? ', filtered' : ''));
                /* A formula has no query of its own -- it is arithmetic over
                   other measures -- so the records behind it are the records
                   behind its parts. Where every part rests on one table and one
                   filter, that is a real destination; where they disagree, there
                   is no single honest answer and the card simply has no link.
                   Without this, the four formula cards were the only things on
                   the page still offering nothing to click. */
                var src = node;
                if (node.kind === 'formula') {
                    var leaf = this._formulaLeaf(slot.indicator, 0, {});
                    if (leaf) src = leaf;
                }
                if (src.table) {
                    card.table = src.table;
                    card.query = src.query;
                    card.derivedFrom = (src !== node) ? src.name : null;
                    /* A card is a number, so there is no value to filter the page
                       *by* -- which is why these were the only things on the page
                       with nothing to click. What a card can always do is show the
                       records it counted, which is the question a leader actually
                       has about a number on a leadership dashboard, and it lands
                       on the platform's own list where row-level security is
                       enforced for us. */
                    card.recordsUrl = this.drill
                        ? this.drill.listUrl(src.table, src.query)
                        : null;
                }
                var tr = this._trend(node);
                if (tr) {
                    card.spark = tr.counts;
                    card.periods = tr.periods;
                    card.sparkLabel = tr.label;
                }
            } else {
                refusedCount++;
                card.value = null;
                card.refused = v.why;
                card.note = v.why;
            }
            payload.kpis.push(card);
        }

        if (refusedCount) {
            payload.notes.push(
                refusedCount + (refusedCount === 1 ? ' card' : ' cards') +
                ' on this page could not be measured, and say why rather than ' +
                'showing a zero. On the source dashboard the same cards are blank.');
        }
        /* The header prints this. A dashboard payload sets it and this one did
           not, so the page read "built in undefinedms". */
        payload.timingMs = new Date().getTime() - startedAt;

        payload.notes.push(
            'Redrawn from ' + name + ' of the ' +
            'CEO Dashboard. Every number here is counted against your own ' +
            'permissions, which is why it can differ from the figure Performance ' +
            'Analytics prints for the same measure.');

        return payload;
    },

    /**
     * The one leaf a formula's records live in, or null when there is not one.
     *
     * A ratio of two counts over the same table and the same filter -- which is
     * most of them here, since a percentage is usually `part / whole * 100` --
     * has an unambiguous set of records behind it: the wider of the two. A
     * formula whose parts span different tables or different filters does not,
     * and gets no link rather than an arbitrary one.
     */
    _formulaLeaf: function (id, depth, seen) {
        if (depth > CmdCeo.MAX_DEPTH) return null;
        var node = this.resolve(id, depth, seen);
        if (node.kind === 'count' || node.kind === 'duration') return node;
        if (node.kind !== 'formula') return null;

        var self = this;
        var nextSeen = {};
        for (var k in seen) { if (seen.hasOwnProperty(k)) nextSeen[k] = true; }
        nextSeen[id] = true;

        var found = [];
        var walk = function (n) {
            if (!n) return;
            if (n.ref !== undefined) {
                var leaf = self._formulaLeaf(n.ref, depth + 1, nextSeen);
                if (leaf) found.push(leaf);
                return;
            }
            walk(n.a); walk(n.b);
        };
        walk(node.ast);
        if (!found.length) return null;

        /* Same table for every part, or no answer. */
        for (var i = 1; i < found.length; i++) {
            if (found[i].table !== found[0].table) return null;
        }
        /* The widest filter among them: a part's records are a subset of the
           whole's, so the shortest query is the set the card is really about. */
        var best = found[0];
        for (i = 1; i < found.length; i++) {
            if ((found[i].query || '').length < (best.query || '').length) best = found[i];
        }
        return best;
    },

    /* The table a formula ultimately rests on, for deciding the page's subject. */
    _formulaTable: function (id, depth, seen) {
        if (depth > CmdCeo.MAX_DEPTH) return null;
        var node = this.resolve(id, depth, seen);
        if (node.table) return node.table;
        if (node.kind !== 'formula') return null;
        var found = null;
        var self = this;
        var nextSeen = {};
        for (var k in seen) { if (seen.hasOwnProperty(k)) nextSeen[k] = true; }
        nextSeen[id] = true;
        var walk = function (n) {
            if (found || !n) return;
            if (n.ref !== undefined) {
                found = found || self._formulaTable(n.ref, depth + 1, nextSeen);
                return;
            }
            walk(n.a); walk(n.b);
        };
        walk(node.ast);
        return found;
    },

    /**
     * The breakdown slot, as an ordinary dimension panel.
     *
     * PA calls it a bubble chart. We do not draw one: which form fits is decided
     * by the shape of the data, the same way it is decided everywhere else in the
     * product, so this hands over the counts and lets the chooser answer. A
     * breakdown resolves through pa_breakdowns to a real column, and one that
     * does not is dropped rather than guessed at.
     */
    _breakdownPanel: function (slot, slotName) {
        var node = this.resolve(slot.indicator);
        if (!node.table || !slot.breakdown) return null;

        var field = this._breakdownField(slot.breakdown, node.table);
        if (!field) return null;
        var f = this.meta.field(node.table, field);
        if (!f) return null;

        var rows = this.data.tieredGroupBy
            ? this.data.tieredGroupBy(node.table, field, node.query)
            : { rows: this.data.fastGroupBy(node.table, field, node.query) };
        var list = rows.rows || rows;
        if (!list || !list.length) return null;

        var total = 0;
        for (var i = 0; i < list.length; i++) total += list[i].count;
        for (i = 0; i < list.length; i++) {
            list[i].share = total ? list[i].count / total : 0;
        }

        return {
            id: 'ceo_breakdown_' + field,
            kind: 'dimension',
            field: field,
            fieldLabel: f.label,
            question: node.name + ', by ' + f.label,
            reason: 'the breakdown the source dashboard applies to this measure, ' +
                    'drawn in the form this data supports',
            rows: { series: list, total: total },
            span: 2,
            caveats: []
        };
    },

    /**
     * The column a PA breakdown means, for a given facts table.
     *
     * `pa_breakdowns.field` is usually empty. A breakdown is a dimension -- a
     * shared idea like Priority -- and the column that carries it differs per
     * table, so the mapping lives in pa_breakdown_mappings: one row per facts
     * table. Reading the breakdown's own `field`, or following it to its
     * dimension, both dead-end -- the dimension for Priority reports
     * facts_table 'sys_choice' and field 'sys_id', which is PA's storage for the
     * dimension's values and not a column on incident.
     *
     * A scripted mapping is refused rather than approximated, and a dotted path
     * is refused too: it is a real mapping, but it groups through a reference and
     * this panel is built from a single column on the subject table.
     */
    _breakdownField: function (breakdownId, table) {
        if (!breakdownId) return null;
        var m = new GlideRecord('pa_breakdown_mappings');
        m.addQuery('breakdown', breakdownId);
        m.addQuery('facts_table', table);
        m.query();
        while (m.next()) {
            if (this._bool(m.getValue('scripted'))) continue;
            var f = m.getValue('field');
            if (f && f.indexOf('.') === -1) return f;
        }
        var bd = new GlideRecord('pa_breakdowns');
        if (bd.get(breakdownId)) {
            var direct = bd.getValue('field');
            if (direct && direct.indexOf('.') === -1) return direct;
        }
        return null;
    },

    /**
     * A real twelve-month history for a card, or null.
     *
     * This is the one place the redraw is worth more than the original rather than
     * merely prettier. Every card on the source dashboard carries a sparkline, and
     * `pa_scores` is empty on that instance -- 0 rows -- so those sparklines are
     * decoration: the same shape beside every number, including numbers that are
     * themselves zero.
     *
     * A trend does not need PA's score history. Most of these measures are "how
     * many X happened in a period", written as a filter pinning some date column
     * to today. Take that clause out and the same filter describes the measure for
     * any period, so counting it per month for twelve months is the history PA
     * would have had if it had ever collected one -- computed from the base table,
     * through the same permission-checked path as every other number here.
     *
     * Only for count measures with exactly one date window to remove. A measure
     * with two date clauses is ambiguous about which one makes it a period, and
     * guessing would produce a plausible line that means nothing.
     */
    _trend: function (node) {
        /* A ratio has a history too, and it is the histories of its parts.
         *
         * Four of Portfolio1's eight cards are formulas, and they are the
         * interesting ones -- an average age, a percentage. Leaving them without a
         * line while the plain counts have one would say the trend was a property
         * of simple measures, which it is not. So the formula is evaluated once
         * per period against its components' own monthly series, which is the same
         * arithmetic the card's headline number uses, twelve times.
         *
         * It yields nothing unless every component has a series of the same
         * length: a ratio computed from a mixture of periods and totals would be a
         * line that means nothing. A period where the denominator is zero is a gap
         * rather than a spike -- the same refusal the headline makes. */
        if (node.kind === 'formula') {
            var self = this;
            var seriesOf = {}, len = -1, failed = false;
            var collect = function (n) {
                if (failed || !n) return;
                if (n.ref !== undefined) {
                    if (seriesOf[n.ref] !== undefined) return;
                    var sub = self._trend(self.resolve(n.ref));
                    if (!sub) { failed = true; return; }
                    if (len === -1) len = sub.counts.length;
                    else if (len !== sub.counts.length) { failed = true; return; }
                    seriesOf[n.ref] = sub;
                    return;
                }
                collect(n.a); collect(n.b);
            };
            collect(node.ast);
            if (failed || len <= 0) return null;

            var counts = [], periods = null, any = false, i;
            for (i = 0; i < len; i++) {
                var bad = false;
                var walk = function (n) {
                    if (bad) return 0;
                    if (n.num !== undefined) return n.num;
                    if (n.ref !== undefined) {
                        periods = periods || seriesOf[n.ref].periods;
                        return seriesOf[n.ref].counts[i];
                    }
                    if (n.op === 'neg') return -walk(n.a);
                    var a = walk(n.a), b = walk(n.b);
                    if (n.op === '+') return a + b;
                    if (n.op === '-') return a - b;
                    if (n.op === '*') return a * b;
                    if (n.op === '/') { if (b === 0) { bad = true; return 0; } return a / b; }
                    bad = true; return 0;
                };
                var v = walk(node.ast);
                counts.push(bad ? 0 : Math.round(v * 100) / 100);
                if (!bad && v) any = true;
            }
            if (!any) return null;
            return { counts: counts, periods: periods, dateField: null,
                     label: 'monthly, evaluated from this measure\u2019s own components' };
        }

        if (node.kind !== 'count' || node.agg !== 'COUNT' || !node.query) return null;

        var parts = node.query.split('^');
        var dateField = null, keep = [], windows = 0, i;
        for (i = 0; i < parts.length; i++) {
            var p = parts[i];
            /* A period clause looks like `<field>ON<something>`, and `ON` is what
               the platform writes for every relative and absolute date window. */
            var m = /^([a-z0-9_]+)ON[A-Za-z]/.exec(p);
            if (m) {
                var f = this.meta.field(node.table, m[1]);
                if (f && f.isDate) {
                    windows++;
                    dateField = m[1];
                    continue;                       /* dropped from the filter */
                }
            }
            /* `EQ` is PA's clause terminator and means nothing on its own. */
            if (p === 'EQ' || p === '') continue;
            keep.push(p);
        }
        if (windows !== 1 || !dateField) return null;

        var rest = keep.join('^');
        var series = this.data.periodSeries(node.table, dateField, 'month', 12, rest);
        if (!series || !series.length) return null;

        var counts = [], any = false;
        for (i = 0; i < series.length; i++) {
            counts.push(series[i].count);
            if (series[i].count) any = true;
        }
        if (!any) return null;          /* a flat zero line is the thing being fixed */

        return { counts: counts, periods: series, dateField: dateField,
                 label: 'monthly, from ' + (this.meta.field(node.table, dateField) || {}).label };
    },

    /* PA units are a reference; only the two that change how a number reads are
       worth carrying into the card. */
    _unitCode: function (unitId) {
        if (!unitId) return '';
        var gr = new GlideRecord('pa_units');
        if (!gr.get(unitId)) return '';
        var n = String(gr.getValue('name') || '').toLowerCase();
        if (n.indexOf('percent') !== -1 || n === '%') return '%';
        if (n.indexOf('day') !== -1) return 'd';
        if (n.indexOf('hour') !== -1) return 'h';
        return '';
    },

    _round: function (v, unit) {
        if (v === null || v === undefined || isNaN(v)) return null;
        if (unit === '%' || unit === 'd' || unit === 'h') {
            return Math.round(v * 100) / 100;
        }
        return Math.round(v * 100) / 100;
    },

    type: 'CmdCeo'
};
