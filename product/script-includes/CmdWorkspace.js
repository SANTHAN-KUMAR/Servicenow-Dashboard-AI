/**
 * CmdWorkspace. The context a workspace list hands to COMMAND, made safe.
 *
 * "Analyse in COMMAND" is a List declarative action on every Next Experience
 * workspace list (product/workspace/cmd_workspace_action.js). It opens the
 * dashboard in the workspace's own modal with what the viewer was looking at:
 * the table, the list's encoded query, the column they grouped by, the rows they
 * selected and the list's title. All of that arrives as URL parameters, and this
 * class is the only thing that turns it into something the engine will accept.
 *
 * Why the engine needs a gate here at all. `CmdPayload.dashboard` treats
 * `opts.baseQuery` as the slice every panel, drill gate and ACL verdict starts
 * from, and until now it only ever came from platform configuration -- a saved
 * report's filter. A query from a URL is different in exactly two ways that
 * matter, and both are handled here:
 *
 *   1. `javascript:` in an encoded query is evaluated on the server. Workspace
 *      lists legitimately carry a handful of these (date ranges such as
 *      "Last 30 days", "is me", "my groups"), so they cannot simply be refused,
 *      and an arbitrary one cannot be allowed. Each is matched in full against a
 *      short allowlist of read-only platform helpers with literal arguments.
 *      Anything else refuses the whole context, with the reason shown.
 *   2. A query naming a field that does not exist is not an error on this
 *      platform: the bad clause is dropped and the query quietly widens. So the
 *      query is checked with isEncodedQueryValid and refused if it would widen,
 *      rather than analysing more rows than the list showed.
 *
 * What this class does not do is decide what the viewer may see. That stays
 * where it has always been, in CmdData.aclVerdict against the viewer's own
 * session, so a hand-edited URL can ask for any query and still only ever counts
 * rows the viewer can read -- the same guarantee the native list gives.
 *
 * ES5 only. Rhino.
 */
var CmdWorkspace = Class.create();

/* Longest query accepted. A workspace list query with every filter a viewer can
   reasonably add is a few hundred characters; this is ten times that. */
CmdWorkspace.MAX_QUERY = 6000;

/* Selected rows analysed as a set. The client caps at the same number so the
   URL stays well under proxy limits; this is the server's own bound. */
CmdWorkspace.MAX_SELECTED = 100;

/* The javascript: helpers a workspace filter is allowed to carry. Each is a
   read-only platform helper that returns a date, a user or a group list. The
   argument list must be literals only -- quoted strings or numbers. */
CmdWorkspace.SAFE_JS = new RegExp('^javascript:(?:' + [
    'gs\\.(?:beginningOf|endOf)[A-Za-z0-9]+',
    'gs\\.(?:days|hours|minutes|months|quarters|years)Ago(?:Start|End)?',
    'gs\\.dateGenerate',
    'gs\\.(?:getUserID|getUserName|now|nowDateTime|nowNoTZ)',
    'gs\\.getUser\\(\\)\\.getMyGroups',
    'getMyGroups',
    'getMyApprovals',
    'getMyAssignments'
].join('|') + ')\\((?:\\s*(?:\'[^\'\\\\^@]*\'|"[^"\\\\^@]*"|-?\\d+(?:\\.\\d+)?)\\s*,?)*\\s*\\)$');

/* Operators, longest first so that NOT LIKE is not read as LIKE. The label is
   what the viewer reads in the context strip. */
CmdWorkspace.OPERATORS = [
    ['ISNOTEMPTY', 'is not empty'], ['ISEMPTY', 'is empty'],
    ['EMPTYSTRING', 'is empty string'], ['ANYTHING', 'is anything'],
    ['NOT LIKE', 'does not contain'], ['NOT IN', 'is not one of'],
    ['NOTLIKE', 'does not contain'], ['NOTIN', 'is not one of'],
    ['STARTSWITH', 'starts with'], ['ENDSWITH', 'ends with'],
    ['DYNAMIC', 'is'], ['BETWEEN', 'between'], ['NOTON', 'not on'],
    ['RELATIVEGT', 'after'], ['RELATIVELT', 'before'],
    ['SAMEAS', 'same as'], ['NSAMEAS', 'not same as'],
    ['VALCHANGES', 'changes'], ['CHANGESFROM', 'changes from'], ['CHANGESTO', 'changes to'],
    ['LIKE', 'contains'], ['IN', 'is one of'], ['ON', 'on'],
    ['!=', 'is not'], ['>=', 'at least'], ['<=', 'at most'],
    ['>', 'greater than'], ['<', 'less than'], ['=', 'is']
];

CmdWorkspace.prototype = {

    initialize: function () {},

    /**
     * Validates everything the workspace sent and returns the engine's inputs.
     *
     * @param table  table name from the list, already coerced to a JS string
     * @param raw    { query, group, selected, title } -- all JS strings, all
     *               straight from the URL
     * @return { ok, error, query, focus, selected, title, clauses, notes }
     *         `ok` false means refuse to analyse and show `error`; nothing about a
     *         refused context is passed to the engine.
     */
    context: function (table, raw) {
        raw = raw || {};
        var out = { ok: true, error: '', query: '', listQuery: '', list: '', columns: [],
                    selectedIds: [],
                    focus: '', selected: 0,
                    title: this._title(raw.title), clauses: [], notes: [] };

        if (!/^[a-z0-9_]{1,80}$/.test(table || '')) {
            return this._refuse(out, 'That is not a table name.');
        }
        var probe = new GlideRecord(table);
        if (!probe.isValid()) return this._refuse(out, 'That table does not exist on this instance.');

        var q = String(raw.query || '');
        if (q.length > CmdWorkspace.MAX_QUERY) {
            return this._refuse(out, 'The list filter is longer than COMMAND accepts (' +
                                CmdWorkspace.MAX_QUERY + ' characters).');
        }

        var cleaned = this._clean(q);
        q = cleaned.query;
        var groupFromQuery = cleaned.group;

        /* Only the viewer's own part of the filter is checked against the
           allowlist. The list definition's condition, below, is platform
           configuration written by an administrator -- the same trust as a saved
           report's filter -- and is evaluated exactly as the native list does. */
        var js = this._unsafeScript(q);
        if (js) {
            return this._refuse(out, 'The list filter runs a script COMMAND will not ' +
                                'evaluate (' + js + '). Remove that condition and try again.');
        }
        out.listQuery = q;

        /* The list definition's own condition. The workspace list applies it in
           its data broker, so it never reaches g_list; the action passes the
           sys_ux_list id and the condition is read here, from configuration. */
        var def = '';
        var listGroup = '';
        var listId = String(raw.list || '');
        if (listId) {
            if (!/^[0-9a-f]{32}$/.test(listId)) return this._refuse(out, 'That is not a list id.');
            var ul = new GlideRecord('sys_ux_list');
            if (!ul.get(listId)) {
                return this._refuse(out, 'The workspace list this came from no longer exists.');
            }
            if (String(ul.getValue('table')) !== table) {
                return this._refuse(out, 'That workspace list is defined on ' +
                                    ul.getValue('table') + ', not ' + table + '.');
            }
            var fixedQ = this._clean(String(ul.getValue('fixed_query') || '')).query;
            var condQ = this._clean(String(ul.getValue('condition') || '')).query;
            def = this._and(fixedQ, condQ);
            if (def === null) {
                return this._refuse(out, 'The list definition combines OR-branches in a way ' +
                                    'COMMAND cannot reproduce exactly.');
            }
            out.list = listId;
            /* The list's own columns, in its order, lead the "Analyse by"
               picker; and a list defined with a default grouping leads with it
               when the viewer has not grouped by anything themselves. */
            var cols = String(ul.getValue('columns') || '').split(',');
            for (var ci = 0; ci < cols.length; ci++) {
                if (/^[a-z0-9_]{1,80}$/.test(cols[ci])) out.columns.push(cols[ci]);
            }
            listGroup = String(ul.getValue('group_by_column') || '');
            /* Most workspace lists carry no column set of their own and show
               their view's columns -- which are then what the viewer sees, so
               they are what "Columns in this list" means. */
            if (!out.columns.length) out.columns = this._viewColumns(table, String(ul.getValue('view') || ''));
        }
        if (!out.columns.length) out.columns = this._viewColumns(table, '');
        /* Some workspace lists (the CMDB ones, measured) already carry their own
           condition in g_list's query. ANDing it again changes no count but
           reads twice in the context strip, so the repeated part is dropped. */
        if (def && q) {
            if (q === def) q = '';
            else if (q.indexOf(def + '^') === 0) q = q.substring(def.length + 1);
            out.listQuery = q;
        }
        var combined = this._and(def, q);
        if (combined === null) {
            return this._refuse(out, 'Both the list and your filter use top-level OR ' +
                                'branches, and combining them exactly is not supported. ' +
                                'Simplify one of them and try again.');
        }
        q = combined;
        if (q && !probe.isEncodedQueryValid(q)) {
            return this._refuse(out, 'The list filter names a field this table does not ' +
                                'have. Analysing it would silently include rows the ' +
                                'list excluded, so COMMAND has not.');
        }

        /* Selected rows are a set of ids, analysed on their own. They came from
           this list, so the list's filter adds nothing -- and appending an IN to a
           query that contains ^NQ would attach it to the last OR-branch only. */
        var sel = this._ids(raw.selected);
        out.selectedIds = sel;
        if (sel.length) {
            out.selected = sel.length;
            out.query = 'sys_idIN' + sel.join(',');
            out.notes.push(sel.length + (sel.length === 1 ? ' selected row' : ' selected rows') +
                           ' from the list, analysed on their own.');
        } else {
            out.query = q;
        }

        /* g_list.getGroupBy() answers "^GROUPBYpriority"; accept that shape as
           well as the bare field, whichever a host workspace's client sends. */
        var group = String(raw.group || '').replace(/^\^?GROUPBY/, '') || groupFromQuery ||
                    listGroup;
        /* The field the employee was visualising in the native Data
           visualization panel, sent as its label. It wins over the list's
           grouping: it is what they were looking at when they clicked. Mapped
           to a field of this table by exact label, the list's own columns
           first; a label that is not a field of this table is ignored. */
        var byLabel = this._fieldForLabel(probe, String(raw.groupLabel || ''), out.columns);
        if (byLabel) group = byLabel;
        if (group && /^[a-z0-9_]{1,80}$/.test(group) && probe.isValidField(group)) {
            out.focus = group;
        }

        out.clauses = this.readable(table, sel.length ? '' : q);
        return out;
    },

    /**
     * The encoded query as a few short phrases, for the context strip.
     * GlideQueryBreadcrumbs does this in global and is refused in a scoped
     * application, so this is a deliberately small reader of the common shapes.
     * Anything it does not recognise is shown as the raw clause rather than
     * guessed at.
     */
    readable: function (table, q) {
        var out = [];
        if (!q) return out;
        /* initialize() is required, not tidiness: in a scoped application
           getElement() on a fresh GlideRecord returns null until it has run,
           which read every label back as the raw field name. */
        var gr = new GlideRecord(table);
        gr.initialize();
        var groups = q.split('^NQ');
        for (var g = 0; g < groups.length && out.length < 12; g++) {
            if (g > 0) out.push({ text: 'or', joiner: true });
            /* ^OR binds tighter than ^, so split on ^ and fold any part that
               starts with OR back into the clause before it. Splitting on ^OR
               first does not work: the ^ split then cuts it again. */
            var parts = groups[g].split('^'), clauses = [];
            for (var a = 0; a < parts.length; a++) {
                if (!parts[a]) continue;
                if (parts[a].indexOf('OR') === 0 && clauses.length &&
                    /^OR[a-z]/.test(parts[a])) {
                    clauses[clauses.length - 1].push(parts[a].substring(2));
                } else {
                    clauses.push([parts[a]]);
                }
            }
            for (var c = 0; c < clauses.length && out.length < 12; c++) {
                out.push({ text: this._orChain(gr, clauses[c]) });
            }
        }
        return out;
    },

    /* "Class is A or Class is B or ... (32 of them)" is unreadable, and it is
       what every CMDB workspace list is made of. An OR chain of equalities on
       one field reads as that field and its values, and past three values as a
       count, with every value still available to the page as `values`. */
    _orChain: function (gr, parts) {
        if (parts.length > 1) {
            var field = null, vals = [];
            for (var i = 0; i < parts.length; i++) {
                var m = /^([a-z0-9_.]+)=(.*)$/.exec(parts[i]);
                if (!m || (field !== null && m[1] !== field)) { field = null; break; }
                field = m[1];
                vals.push(this._value(gr, m[1], m[2]));
            }
            if (field) {
                var label = this._label(gr, field);
                return vals.length > 3
                    ? label + ' is one of ' + vals.length + ' values'
                    : label + ' is ' + vals.join(' or ');
            }
        }
        var bits = [];
        for (var o = 0; o < parts.length; o++) bits.push(this._clause(gr, parts[o]));
        return bits.join(' or ');
    },

    _clause: function (gr, c) {
        /* Field names are lower case and operators are upper case or symbols,
           so the shortest lower-case prefix followed by a known operator is the
           field. A greedy match read "assigned_toDYNAMIC<id>" as one field. */
        for (var i = 0; i < CmdWorkspace.OPERATORS.length; i++) {
            var op = CmdWorkspace.OPERATORS[i][0];
            var at = c.indexOf(op);
            if (at < 1 || !/^[a-z0-9_.]+$/.test(c.substring(0, at))) continue;
            var field = c.substring(0, at);
            var val = c.substring(at + op.length);
            var label = this._label(gr, field);
            var words = CmdWorkspace.OPERATORS[i][1];
            if (op === 'DYNAMIC') return label + ' is (' + this._dynamic(val) + ')';
            if (op === 'ISEMPTY' || op === 'ISNOTEMPTY' || op === 'ANYTHING' ||
                op === 'EMPTYSTRING' || op === 'VALCHANGES') return label + ' ' + words;
            if (op === 'ON' || op === 'NOTON') return label + ' ' + words + ' ' + val.split('@')[0];
            if (val.indexOf('javascript:') === 0) return label + ' ' + words + ' (relative)';
            return label + ' ' + words + ' ' + this._value(gr, field, val);
        }
        return c;
    },

    _label: function (gr, field) {
        if (field.indexOf('.') === -1 && gr.isValidField(field)) {
            /* Compared with null explicitly: a scoped GlideElement whose value
               is empty is falsy, and on an initialised, unsaved record every
               element is empty -- `if (el)` skipped every label. */
            var el = gr.getElement(field);
            if (el !== null && el !== undefined) return String(el.getLabel());
        }
        return field.replace(/_/g, ' ');
    },

    /* A reference value is a sys_id, which means nothing to a reader. Resolve
       it to its display value when the field is a plain reference; leave
       anything else, including lists of values, as it was. Resolution is read
       through GlideRecordSecure, so a value the viewer cannot read stays an id. */
    _value: function (gr, field, val) {
        if (!/^[0-9a-f]{32}$/.test(val) || field.indexOf('.') !== -1) return val;
        if (!gr.isValidField(field)) return val;
        var el = gr.getElement(field);
        var ref = (el !== null && el !== undefined) ? String(el.getReferenceTable() || '') : '';
        if (!ref) return val;
        var r = new GlideRecordSecure(ref);
        if (r.get(val)) return String(r.getDisplayValue());
        return val;
    },

    _dynamic: function (id) {
        var dy = new GlideRecord('sys_filter_option_dynamic');
        return dy.get(id) ? String(dy.getValue('label')) : 'dynamic';
    },

    /* The first javascript: token that is not on the allowlist, or ''. A token
       runs to the next clause (^) or range (@) separator. */
    /**
     * The fields the "Analyse by" picker offers: exactly the engine's own
     * dimensions for this table (CmdMeta.dimensions), because that is the list
     * CmdPayload validates a focus field against -- offering anything else would
     * be a click the engine then ignores. The list's own columns come first, in
     * the list's order, then the rest by label.
     */
    fieldChoices: function (dims, columns, focus) {
        var byName = {}, out = [], i;
        /* Free text still awaiting a cardinality check (short description,
           comments) is left out: it is almost never chartable, and offering it
           would mostly produce "could not be drawn" notes. */
        for (i = 0; i < (dims || []).length; i++) {
            if (!dims[i].needsCardinalityCheck) byName[dims[i].name] = dims[i];
        }
        var seen = {};
        for (i = 0; i < (columns || []).length; i++) {
            var d = byName[columns[i]];
            if (d && !seen[d.name]) {
                seen[d.name] = true;
                out.push({ name: d.name, label: String(d.label), inList: true });
            }
        }
        /* The rest in the engine's own order -- CmdMeta ranks dimensions best
           first -- and capped, so the useful fields are not buried under forty
           rarely-populated ones in alphabetical order. */
        var rest = [];
        for (i = 0; i < (dims || []).length && rest.length < 20; i++) {
            if (!seen[dims[i].name] && byName[dims[i].name]) rest.push({ name: dims[i].name, label: String(dims[i].label), inList: false });
        }
        out = out.concat(rest);
        for (i = 0; i < out.length; i++) out[i].active = (out[i].name === focus);
        return out;
    },

    /**
     * One record, analysed in context: opened from the row menu. The analysis
     * itself stays the list's -- one record is not a distribution -- and this
     * returns the record's own values on the fields COMMAND can break down by,
     * so the page can say where it sits and offer "records like this one" by
     * each of them as ordinary drill steps.
     *
     * Read through GlideRecordSecure: a record the viewer cannot open is refused,
     * and a field they cannot read is left out rather than shown.
     */
    recordContext: function (table, sysId, dims, columns) {
        if (!/^[0-9a-f]{32}$/.test(sysId || '')) return { ok: false, error: 'That is not a record id.' };
        var gr = new GlideRecordSecure(table);
        if (!gr.get(sysId)) {
            return { ok: false, error: 'That record does not exist or you cannot open it.' };
        }
        var choices = this.fieldChoices(dims, columns, '');
        var facts = [];
        for (var i = 0; i < choices.length && facts.length < 8; i++) {
            var f = choices[i].name;
            var el = gr.getElement(f);
            if (el === null || el === undefined || !el.canRead()) continue;
            var key = String(gr.getValue(f) || '');
            if (!key) continue;
            facts.push({ field: f, label: choices[i].label, key: key,
                         display: String(gr.getDisplayValue(f) || key) });
        }
        return { ok: true, sysId: sysId, table: table,
                 display: String(gr.getDisplayValue() || sysId), facts: facts };
    },

    /* The columns of a list view, in order. `viewId` is a sys_ui_view sys_id;
       empty means the Default view. Read-only configuration. */
    _viewColumns: function (table, viewId) {
        var out = [];
        var viewName = '';
        if (viewId) {
            var v = new GlideRecord('sys_ui_view');
            if (v.get(viewId)) viewName = String(v.getValue('name') || '');
        }
        var ls = new GlideRecord('sys_ui_list');
        ls.addQuery('name', table);
        ls.addQuery('view.name', viewName || 'NULL');
        ls.addNullQuery('parent');
        ls.addNullQuery('sys_user');
        ls.setLimit(1);
        ls.query();
        if (!ls.next() && viewName) return this._viewColumns(table, '');
        if (!ls.isValidRecord()) return out;
        var el = new GlideRecord('sys_ui_list_element');
        el.addQuery('list_id', ls.getUniqueValue());
        el.orderBy('position');
        el.setLimit(40);
        el.query();
        while (el.next()) {
            var f = String(el.getValue('element') || '');
            if (/^[a-z0-9_]{1,80}$/.test(f)) out.push(f);
        }
        return out;
    },

    _fieldForLabel: function (probe, label, columns) {
        label = label.replace(/^\s+|\s+$/g, '').toLowerCase();
        if (!label || label.length > 80) return '';
        var gr = new GlideRecord(probe.getTableName());
        gr.initialize();
        var i, f;
        for (i = 0; i < (columns || []).length; i++) {
            f = columns[i];
            if (!gr.isValidField(f)) continue;
            var ce = gr.getElement(f);
            if (ce !== null && ce !== undefined && String(ce.getLabel()).toLowerCase() === label) return f;
        }
        /* getElements(), not getFields(): the latter is refused in a scoped app. */
        var els = gr.getElements();
        for (i = 0; i < els.length; i++) {
            if (String(els[i].getLabel()).toLowerCase() === label) return String(els[i].getName());
        }
        return '';
    },

    /* Drops view state (ORDERBY, the ^EQ terminator) and lifts GROUPBY out. */
    _clean: function (q) {
        var kept = [], group = '';
        var parts = String(q || '').split('^');
        for (var i = 0; i < parts.length; i++) {
            var p = parts[i];
            if (!p || p === 'EQ') continue;
            if (p.indexOf('ORDERBY') === 0) continue;
            if (p.indexOf('GROUPBY') === 0) {
                if (!group) group = p.substring(7);
                continue;
            }
            p = this._resolveHelper(p);
            if (p === '') continue;
            kept.push(p);
        }
        return { query: kept.join('^'), group: group };
    },

    /**
     * The three bare global helpers a workspace list condition uses --
     * getMyAssignments(), getMyGroups(), getMyApprovals() -- are functions of
     * the global scope, and inside this scoped application they do not evaluate
     * to what they mean. Measured on dev390988 against the platform's own count
     * of the same query: "assigned_to=javascript:getMyAssignments()" counts 650
     * incidents in scope and 0 in global; getMyGroups() 46 against 0. Left alone
     * that turns "Tasks - Assigned to you" into an analysis of 1,500 strangers'
     * tasks. So each is resolved here, server-side, into the literal it stands
     * for, for this viewer: their user id, or their groups' ids. The gs.* date
     * and user helpers evaluate identically in scope (measured) and are kept.
     *
     * getMyAssignments() and getMyApprovals() also admit work delegated to the
     * viewer in global; the literal is the viewer alone. That can only narrow
     * the slice, never widen it.
     */
    _resolveHelper: function (p) {
        var m = /^(OR|NQ)?([a-z0-9_.]+)(!=|=|NOT IN|IN)javascript:(getMyAssignments|getMyApprovals|getMyGroups|gs\.getUser\(\)\.getMyGroups)\(\)$/.exec(p);
        if (!m) return p;
        var lead = m[1] || '', field = m[2], op = m[3], fn = m[4];
        var negate = (op === '!=' || op === 'NOT IN');
        if (fn === 'getMyAssignments' || fn === 'getMyApprovals') {
            return lead + field + (negate ? '!=' : '=') + gs.getUserID();
        }
        var ids = String(gs.getUser().getMyGroups() || '').replace(/[\[\]\s]/g, '');
        if (!ids) {
            /* No groups: "in my groups" matches nothing and "not in my groups"
               is every row, which is the clause dropped. */
            return negate ? (lead ? lead + field + 'ANYTHING' : '') : lead + field + '=NO_GROUPS';
        }
        return lead + field + (negate ? 'NOT IN' : 'IN') + ids;
    },

    /* a AND b, as an encoded query. ^NQ starts a new top-level OR branch, so
       "A^NQB" AND "U" is "A^U^NQB^U" -- plain concatenation would filter only
       the last branch. Two OR-shaped sides would need a cross product, which is
       refused (null) rather than approximated. */
    _and: function (a, b) {
        if (!a) return b || '';
        if (!b) return a;
        var an = a.indexOf('^NQ') !== -1, bn = b.indexOf('^NQ') !== -1;
        if (an && bn) return null;
        /* The list's own condition first, so the context strip reads the way the
           list does: "Active is true, Priority is 1", not the other way round. */
        if (!an && !bn) return a + '^' + b;
        var branches = an ? a.split('^NQ') : b.split('^NQ');
        var other = an ? b : a;
        var out = [];
        for (var i = 0; i < branches.length; i++) out.push(branches[i] + '^' + other);
        return out.join('^NQ');
    },

    _unsafeScript: function (q) {
        var at = 0;
        while ((at = q.indexOf('javascript:', at)) !== -1) {
            var end = q.length;
            var caret = q.indexOf('^', at), amp = q.indexOf('@', at);
            if (caret !== -1 && caret < end) end = caret;
            if (amp !== -1 && amp < end) end = amp;
            var tok = q.substring(at, end);
            if (!CmdWorkspace.SAFE_JS.test(tok)) return tok.substring(0, 60);
            at = end;
        }
        return '';
    },

    _ids: function (raw) {
        var out = [];
        var bits = String(raw || '').split(',');
        for (var i = 0; i < bits.length && out.length < CmdWorkspace.MAX_SELECTED; i++) {
            if (/^[0-9a-f]{32}$/.test(bits[i])) out.push(bits[i]);
        }
        return out;
    },

    _title: function (t) {
        t = String(t || '').replace(/[\u0000-\u001f<>]/g, '').substring(0, 120);
        return t;
    },

    _refuse: function (out, why) {
        out.ok = false;
        out.error = why;
        out.query = '';
        return out;
    },

    type: 'CmdWorkspace'
};
