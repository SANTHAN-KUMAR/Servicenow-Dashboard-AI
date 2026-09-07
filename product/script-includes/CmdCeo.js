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
            scripted: gr.getValue('scripted') === 'true',
            script: gr.getValue('script') || '',
            unit: gr.getValue('unit') || '',
            precision: gr.getValue('precision') || ''
        } : null;
        return this._ind[id];
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
                n = this.data.total(node.table, node.query);
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

    type: 'CmdCeo'
};
