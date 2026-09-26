/**
 * cmd_frame: loads the COMMAND dashboard into the inner iframe of cmd_frame.
 *
 * The frame page exists because the workspace modal closes when its own iframe
 * navigates (see cmd_frame.xhtml). This script is the whole of its behaviour:
 * take this page's query string and give it to the dashboard page, on this
 * origin, at a path derived from this page's own path. Nothing from the query
 * string chooses where the inner frame goes -- only what it is asked for -- so the
 * frame cannot be turned into a way to load an arbitrary page.
 *
 * ES5, no dependencies.
 */
(function () {
  function boot() {
    var inner = document.getElementById('cmd-inner');
    if (!inner) return;
    /* x_2185255_command_cmd_frame.do -> x_2185255_command_cmd_dashboard.do, and
       cmd_frame.do -> cmd_dashboard.do for a global deployment. */
    var path = window.location.pathname.replace(/cmd_frame\.do$/, 'cmd_dashboard.do');
    if (path === window.location.pathname) return;
    inner.addEventListener('load', function () {
      var wait = document.getElementById('cmd-frame-wait');
      if (wait) wait.parentNode.removeChild(wait);
    });
    inner.src = path + panelContext(window.location.search);
  }

  /**
   * In the side panel the context arrives from the list action's own tokens
   * ({{table}}, {{query}}, {{groupBy}}, {{sysIds}}), which cannot carry the
   * list's id or tell one ticked row from several. Both are completed here:
   *   - the list's sys_ux_list id is read from the workspace address the panel
   *     sits in (/list/params/list-id/<id>), so the list definition's own
   *     condition applies -- read only, same origin, and simply skipped if the
   *     address has another shape;
   *   - one ticked row becomes wrec (that record, in the list's context) and
   *     several stay wsel (exactly those rows), the same rule the header button
   *     used in the modal.
   * Empty tokens are dropped rather than sent as empty parameters.
   */
  function panelContext(search) {
    if (!/[?&]panel=1(&|$)/.test(search)) return search;
    var parts = search.replace(/^\?/, '').split('&'), kept = [];
    for (var i = 0; i < parts.length; i++) {
      var kv = parts[i].split('='), k = kv[0], v = parts[i].substring(k.length + 1);
      if (!k || v === '' || v === 'undefined' || v === 'null') continue;
      if (k === 'wsel') {
        var ids = decodeURIComponent(v).split(',');
        if (ids.length === 1) { kept.push('wrec=' + encodeURIComponent(ids[0])); continue; }
      }
      kept.push(parts[i]);
    }
    try {
      var m = /list-id\/([0-9a-f]{32})/.exec(String(window.top.location.pathname));
      if (m && !/[?&]wlist=/.test(search)) kept.push('wlist=' + m[1]);
    } catch (e) { /* not same origin, or no workspace around us: no list id */ }
    return '?' + kept.join('&');
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
