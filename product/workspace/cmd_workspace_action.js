function onClick() {
    /* "Analyse in COMMAND" -- a List declarative action, the supported extension
       point for Next Experience workspace lists. It runs in the platform's list
       client-script sandbox, where `g_list` is the live list and `g_modal` is the
       workspace modal service; `window` and `document` are deliberately null
       there, so nothing below touches them.

       What it hands over is exactly what the viewer is looking at:
         table   g_list.getTableName()
         query   g_list.getQuery({ fixed: true }) -- the list's own condition plus
                 every filter the viewer added, without ORDERBY/GROUPBY
         group   g_list.getGroupBy() -- set when the viewer used "Group by <col>"
                 on a column, and it becomes the breakdown the analysis leads with
         checked the selected rows, when there are any, capped so the URL stays
                 well under any proxy's limit
         title   the list's own title, so the analysis is named what the viewer
                 clicked
       The page re-validates every one of these server-side and counts only what
       this viewer's ACLs admit. Nothing here is trusted by the server. */
    /* One ticked row means "this record": COMMAND analyses the list with that
       record placed in it (where it sits, and records like it by each of its
       values). Two or more ticked rows are analysed as exactly that set.

       Not in the row's own more-actions menu, deliberately. In Service
       Operations Workspace that menu is built by sn_sow.SOWListTransformSNC, a
       script in SOW's own scope; the only way to add an item is to edit its
       customer stub SOWListTransform -- a ServiceNow-owned record -- and it
       would still only reach SOW. Ticking one row and using this button gives
       the same result with nothing native touched. */
    /* The frame page, not the dashboard: the workspace modal closes when its
       own iframe navigates, and an analysis navigates on every drill. cmd_frame
       holds the dashboard in an inner iframe so the modal never sees a reload. */
    var PAGE = '/x_2185255_command_cmd_frame.do';
    var MAX_CHECKED = 100;

    /* Every g_list read is guarded. Measured on Australia: on a list with no
       query at all ("Incidents - All") the list holds query = null, and the
       platform's own getQuery()/getGroupBy() call .split on it and throw. An
       empty list query is a legitimate state -- it means "every row" -- so it
       is read as '' rather than allowed to abort the click. */
    function safe(fn, fallback) {
        try {
            var v = fn();
            return (v === null || v === undefined) ? fallback : v;
        } catch (e) {
            return fallback;
        }
    }
    var table = g_list.getTableName();
    var fixed = safe(function () { return g_list.getFixedQuery(); }, '');
    var query = safe(function () { return g_list.getQuery({ fixed: true }); }, null);
    if (query === null) {
        /* getQuery threw: rebuild the same string it would have returned. */
        var live = safe(function () { return g_list.query; }, '') || '';
        query = [fixed, live].filter(function (s) { return !!s; }).join('^');
    }
    /* getGroupBy() answers with the encoded form ("^GROUPBYpriority"), not
       the field, so the field is lifted out of it. */
    var groupRaw = String(safe(function () { return g_list.getGroupBy(); }, ''));
    var gm = /GROUPBY([a-z0-9_]+)/.exec(groupRaw);
    var group = gm ? gm[1] : '';

    /* The list definition's own condition ("Open" = active=true) is applied by
       the list's data broker and is NOT in g_list, which only holds what the
       viewer changed. So the list's sys_ux_list id is passed too, read from the
       workspace route (/list/params/list-id/<id>), and the server reads that
       list's condition from configuration -- never from the browser. */
    var listId = '';
    try {
        var lm = /list-id\/([0-9a-f]{32})/.exec(String(top.location.pathname));
        if (lm) listId = lm[1];
    } catch (e) { listId = ''; }
    var title = safe(function () { return g_list.getTitle(); }, '');
    var checked = String(safe(function () { return g_list.getChecked(); }, '')).split(',').filter(function (s) {
        /* getChecked() can return "display@sys_id" on some lists; keep the id. */
        return !!s;
    }).map(function (s) {
        var parts = s.split('@');
        return parts[parts.length - 1];
    });

    var url = PAGE + '?table=' + encodeURIComponent(table) +
        '&ws=1&embed=1' +
        '&wq=' + encodeURIComponent(query) +
        (listId ? '&wlist=' + listId : '') +
        (group ? '&wgroup=' + encodeURIComponent(group) : '') +
        (title ? '&wtitle=' + encodeURIComponent(title) : '') +
        (checked.length === 1
            ? '&wrec=' + encodeURIComponent(checked[0])
            : (checked.length ? '&wsel=' + encodeURIComponent(checked.slice(0, MAX_CHECKED).join(',')) : ''));

    var heading = 'COMMAND Analytics' + (title ? ' — ' + title : '');

    /* g_modal.showFrame is the workspace's own iframe modal, so the analysis opens
       over the list and closing it returns the viewer to exactly where they were.
       If a host experience ever runs this without the modal service, fall back to
       a browser tab rather than doing nothing. */
    if (typeof g_modal !== 'undefined' && g_modal && typeof g_modal.showFrame === 'function') {
        g_modal.showFrame({
            title: heading,
            url: url,
            size: 'fw',
            height: '82vh'
        });
    } else {
        top.window.open(url.replace('&embed=1', ''), '_blank');
    }
}
