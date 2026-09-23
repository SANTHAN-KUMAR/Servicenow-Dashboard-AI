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
    inner.src = path + window.location.search;
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
