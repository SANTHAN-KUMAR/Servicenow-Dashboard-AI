/* GET /api/eyi/ey_ai_dashboard/rendercheck?page=ey_ai_dashboard
 *
 * Diagnostic. A UI Page can only be fetched over an interactive session, so a
 * blank page cannot be inspected from outside the browser - which is exactly
 * when you most need to see it. This runs the page's Jelly through the platform
 * and returns whatever comes out, including the parse error if there is one.
 *
 * Temporary: delete once the page is confirmed working.
 */
(function process(request, response) {

    var name = request.queryParams.page ? String(request.queryParams.page) : 'ey_ai_dashboard';

    var gr = new GlideRecord('sys_ui_page');
    if (!gr.get('name', name))
        return { ok: false, error: 'No sys_ui_page named ' + name };

    var src = String(gr.getValue('html') || '');
    var out = {
        ok: true,
        page: name,
        sys_id: String(gr.getUniqueValue()),
        direct: String(gr.getValue('direct')),
        category: String(gr.getValue('category')),
        scope: String(gr.getValue('sys_scope')),
        source_bytes: src.length,
        client_script_bytes: String(gr.getValue('client_script') || '').length,
        processing_script_bytes: String(gr.getValue('processing_script') || '').length
    };

    /* Render it the way the platform does. Whatever this throws is the same thing
     * the browser is silently receiving as an empty document. */
    try {
        var runner = new GlideJellyRunner();
        var html = runner.renderFromString(src);
        html = String(html === null || html === undefined ? '' : html);
        out.rendered_bytes = html.length;
        out.rendered_head = html.substring(0, 1200);
        out.rendered_tail = html.length > 1200 ? html.substring(html.length - 600) : '';
        out.verdict = html.length < 200
            ? 'RENDERED EMPTY - Jelly produced nothing. The markup is being dropped server-side.'
            : 'Jelly produced output. If the browser still shows nothing, the failure is ' +
              'client-side (CSS or script), not in the template.';
    } catch (e) {
        out.render_error = String(e);
        out.verdict = 'JELLY THREW - this is the root cause of the blank page.';
    }

    return out;

})(request, response);
