/**
 * CmdMeta. Schema introspection.
 *
 * The product has to work over GRC, ITSM, customer service, HR, projects and
 * assets without a line of per-table configuration, so nothing here may know the
 * name of any table or field. Everything is derived from `sys_dictionary` at
 * request time.
 *
 * That constraint is what makes the thing a product rather than six hard-coded
 * dashboards, and it is also the reason the classification below is careful: a
 * field misclassified here becomes a wrong chart downstream, and the form engine
 * cannot detect the mistake because it only ever sees the classification.
 *
 * Memoised per request. Dictionary reads are cheap individually and there are a
 * lot of them, so each table is described once per page load and reused.
 *
 * ES5 only. Rhino.
 */
var CmdMeta = Class.create();

/* Internal types, grouped by what they mean for charting rather than by what the
   platform calls them. Read `sys_dictionary.internal_type` against these. */
CmdMeta.TYPES = {
    DATE: ['glide_date_time', 'glide_date', 'glide_time', 'due_date',
           'glide_utc_time', 'datetime', 'date'],

    /* Durations are numeric in spirit but need converting before they mean
       anything, so they are tracked separately from plain numbers. */
    DURATION: ['glide_duration', 'timer'],

    NUMBER: ['integer', 'decimal', 'float', 'longint', 'currency', 'price',
             'percent_complete', 'order_index'],

    BOOL: ['boolean'],

    REF: ['reference', 'glide_list', 'document_id', 'domain_id'],

    /* Short strings that are worth grouping by only if their cardinality turns
       out to be low. Decided by measurement, not by type. */
    TEXT: ['string', 'char', 'translated_field', 'translated_text'],

    /* Never a dimension and never a measure. Grouping by a journal or an HTML
       body produces one group per record, which is the failure mode that puts a
       datetime on a scalar tile. */
    OPAQUE: ['journal', 'journal_input', 'journal_list', 'html', 'translated_html',
             'script', 'script_plain', 'script_server', 'xml', 'json', 'sys_class_name',
             'password', 'password2', 'GUID', 'sys_id', 'user_image', 'image',
             'documentation_field', 'conditions', 'glide_var', 'variables',
             'template_value', 'field_name', 'table_name', 'wide_text', 'email_script']
};

/* Fields that are technically groupable and never interesting. Excluded by name
   because their types do not distinguish them from useful fields. */
CmdMeta.NOISE = {
    'sys_id': 1, 'sys_mod_count': 1, 'sys_created_by': 1, 'sys_updated_by': 1,
    'sys_tags': 1, 'sys_domain': 1, 'sys_domain_path': 1, 'sys_class_name': 1,
    'number': 1, 'upon_approval': 1, 'upon_reject': 1, 'order': 1,
    'activity_due': 1, 'wf_activity': 1, 'sys_effective_from': 1,
    'sys_effective_to': 1, 'correlation_id': 1, 'correlation_display': 1
};

/* A cardinality above this and a plain string field is an identifier, not a
   dimension. Applied only to untyped text; choice and reference fields carry
   their own evidence. */
CmdMeta.TEXT_DIM_MAX_DISTINCT = 40;

CmdMeta.prototype = {

    initialize: function () {
        this._tables = {};   // table -> descriptor, memoised per request
        this._fields = {};   // table -> field array
    },

    /**
     * Describes a table without reading a single row of it.
     *
     * `canRead` is the table-level check. It is necessary and not sufficient:
     * passing it means the viewer may query the table, not that they may see any
     * particular row, which is exactly the distinction that makes
     * GlideAggregate unsafe. Row-level correctness is CmdData's job.
     */
    describe: function (table) {
        if (this._tables[table]) return this._tables[table];

        var d = { name: table, label: table, plural: table, exists: false, canRead: false };

        var t = new GlideRecord('sys_db_object');
        t.addQuery('name', table);
        t.setLimit(1);
        t.query();
        if (t.next()) {
            d.exists = true;
            d.label = t.getValue('label') || table;
            d.plural = t.getValue('label') ? (t.getValue('label') + 's') : table;
            d.superClass = t.getDisplayValue('super_class') || '';
        }

        if (d.exists) {
            try {
                d.canRead = new GlideRecord(table).canRead();
            } catch (e) {
                d.canRead = false;
            }
        }

        this._tables[table] = d;
        return d;
    },

    /**
     * Every field on the table, classified. Walks the dictionary including
     * inherited fields, which matters because most of the interesting tables
     * extend `task` and would otherwise appear to have almost no columns.
     */
    fields: function (table) {
        if (this._fields[table]) return this._fields[table];

        var out = [];
        var seen = {};

        var gr = new GlideRecord('sys_dictionary');
        gr.addQuery('name', 'IN', this._hierarchy(table).join(','));
        gr.addNotNullQuery('element');
        gr.query();

        while (gr.next()) {
            var el = gr.getValue('element');
            if (!el || seen[el]) continue;
            seen[el] = true;

            var it = gr.getValue('internal_type') || '';
            var f = {
                name: el,
                label: gr.getValue('column_label') || el,
                type: it,
                reference: gr.getValue('reference') || '',
                dependent: gr.getValue('dependent') || '',
                maxLength: parseInt(gr.getValue('max_length'), 10) || 0,
                isDate: this._in(it, CmdMeta.TYPES.DATE),
                isDuration: this._in(it, CmdMeta.TYPES.DURATION),
                isNumber: this._in(it, CmdMeta.TYPES.NUMBER),
                isBool: this._in(it, CmdMeta.TYPES.BOOL),
                isRef: this._in(it, CmdMeta.TYPES.REF),
                isText: this._in(it, CmdMeta.TYPES.TEXT),
                isOpaque: this._in(it, CmdMeta.TYPES.OPAQUE) || !!CmdMeta.NOISE[el]
            };

            /* A choice list is the strongest evidence a field is a dimension:
               somebody has already declared its permitted values. Cheaper to
               read the dictionary flag than to count distinct values. */
            var ch = gr.getValue('choice');
            f.isChoice = (ch === '1' || ch === '2' || ch === '3');

            /* Ordinal means the sequence carries meaning, so the renderer must
               not sort by magnitude. Numeric choice fields are the reliable
               signal here; priority and state are the canonical cases. */
            f.isOrdinal = f.isChoice && (f.isNumber || it === 'integer');

            /* Long free text is never a dimension regardless of type. */
            if (f.isText && f.maxLength > 255) f.isOpaque = true;

            out.push(f);
        }

        out.sort(function (a, b) { return a.label < b.label ? -1 : 1; });
        this._fields[table] = out;
        return out;
    },

    field: function (table, name) {
        var all = this.fields(table);
        for (var i = 0; i < all.length; i++) {
            if (all[i].name === name) return all[i];
        }
        return null;
    },

    /**
     * Fields worth grouping by, best first.
     *
     * "Best" is a prior, not a decision. It orders the candidates that then get
     * measured; nothing here looks at data. The ordering matters only because
     * measuring every field on a wide table would be slow, so the caller
     * measures down this list and stops when it has enough panels.
     */
    dimensions: function (table) {
        var f = this.fields(table);
        var out = [];

        for (var i = 0; i < f.length; i++) {
            var x = f[i];
            if (x.isOpaque || x.isDate) continue;
            if (!(x.isChoice || x.isBool || x.isRef || x.isText || x.isNumber)) continue;

            /* Plain unbounded text needs its cardinality measured before it can
               be trusted as a dimension. Flagged, not excluded. */
            out.push({
                name: x.name,
                label: x.label,
                type: x.type,
                isChoice: x.isChoice,
                isBool: x.isBool,
                isRef: x.isRef,
                isOrdinal: x.isOrdinal,
                isNumber: x.isNumber,
                needsCardinalityCheck: x.isText && !x.isChoice,
                rank: this._dimRank(x)
            });
        }

        out.sort(function (a, b) { return a.rank - b.rank; });
        return out;
    },

    /** Date fields, best first. The one used for a trend defaults to the first. */
    dates: function (table) {
        var f = this.fields(table);
        var out = [];
        for (var i = 0; i < f.length; i++) {
            if (!f[i].isDate || f[i].isOpaque) continue;
            out.push({ name: f[i].name, label: f[i].label, type: f[i].type,
                       rank: this._dateRank(f[i]) });
        }
        out.sort(function (a, b) { return a.rank - b.rank; });
        return out;
    },

    /** Numeric fields that can carry a SUM or an AVG. */
    measures: function (table) {
        var f = this.fields(table);
        var out = [];
        for (var i = 0; i < f.length; i++) {
            var x = f[i];
            if (x.isOpaque) continue;
            if (!x.isNumber && !x.isDuration) continue;
            /* A numeric choice field is an ordinal dimension, not a measure.
               Summing priority produces a number with no meaning. */
            if (x.isChoice) continue;
            out.push({ name: x.name, label: x.label, type: x.type,
                       isDuration: x.isDuration });
        }
        return out;
    },

    /**
     * Declared parent-child field pairs, the dictionary's own hierarchy claim.
     *
     * Returned as candidates only. Measured on this instance,
     * `incident.subcategory` is declared dependent on `category` and is populated
     * on 42 of 13,986 records, so a declaration here means somebody intended a
     * hierarchy and says nothing about whether one exists in the data. CmdDrill
     * gates these on fill rate before any of them reaches a user.
     */
    dependentPairs: function (table) {
        var f = this.fields(table);
        var out = [];
        for (var i = 0; i < f.length; i++) {
            if (!f[i].dependent || f[i].isOpaque) continue;
            var parent = this.field(table, f[i].dependent);
            if (!parent || parent.isOpaque) continue;
            out.push({
                parent: parent.name, parentLabel: parent.label,
                child: f[i].name, childLabel: f[i].label,
                declared: true
            });
        }
        return out;
    },

    /* ── internals ── */

    /**
     * The table and everything it extends, so inherited columns are found.
     * Without this, `sn_grc_issue` looks like it has six fields.
     */
    _hierarchy: function (table) {
        var chain = [table];
        var cursor = table;
        var guard = 0;
        while (cursor && guard < 12) {
            guard++;
            var t = new GlideRecord('sys_db_object');
            t.addQuery('name', cursor);
            t.setLimit(1);
            t.query();
            if (!t.next()) break;
            var sup = t.getDisplayValue('super_class');
            if (!sup || sup === cursor) break;
            chain.push(sup);
            cursor = sup;
        }
        return chain;
    },

    /* Lower rank sorts first. Ordering is a prior on usefulness: a declared
       choice list beats a reference, which beats a raw string. */
    _dimRank: function (x) {
        if (x.isOrdinal) return 10;
        if (x.isChoice) return 20;
        if (x.isBool) return 30;
        if (x.isRef) return 40;
        if (x.isNumber) return 60;
        return 80;
    },

    /* An opened or created date is what a trend almost always means. A closed or
       resolved date describes only the subset that reached that state, which
       makes it a worse default and a legitimate explicit choice. */
    _dateRank: function (x) {
        var n = x.name;
        if (n === 'opened_at' || n === 'sys_created_on') return 10;
        if (n.indexOf('opened') === 0 || n.indexOf('start') === 0) return 20;
        if (n === 'sys_updated_on') return 70;
        if (n.indexOf('closed') === 0 || n.indexOf('resolved') === 0) return 50;
        if (n.indexOf('due') === 0 || n.indexOf('end') === 0) return 40;
        return 30;
    },

    _in: function (v, arr) {
        for (var i = 0; i < arr.length; i++) {
            if (arr[i] === v) return true;
        }
        return false;
    },

    type: 'CmdMeta'
};
