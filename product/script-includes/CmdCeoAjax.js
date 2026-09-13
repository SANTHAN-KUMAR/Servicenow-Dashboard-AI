/**
 * CmdCeoAjax. The CEO Dashboard's data channel: GlideAjax, client-callable.
 *
 * Why this exists at all, when every other COMMAND page embeds its payload.
 *
 * The rest of the product computes server-side in <g:evaluate> and embeds the
 * result, because an XHR from a logged-in browser session to Scripted REST was
 * measured never to return (eypocinst, 2026-08) and the Table API behaved the same.
 * That constraint is why a portfolio page costs its whole server build before the
 * browser paints anything.
 *
 * The CEO Dashboard cannot afford that. It is eight portfolios on one page, and the
 * sum of their server time is the page's time to first paint. GlideAjax is a
 * different mechanism -- a POST to xmlhttp.do, the channel the platform's own forms
 * run on -- and it was measured on dev390988 on 2026-09-14 from a scoped UI Page in
 * headless Chrome: 413ms round trip, 11ms of it server. So the page paints its
 * frame at once and fills itself from here, several calls in flight together.
 *
 * Every entry point checks the role itself. A client-callable Script Include is
 * reachable by anyone who can post to xmlhttp.do, so the page's own role check is
 * not a gate on this, and the numbers are still counted against the caller's own
 * row-level access underneath -- the role opens the dashboard, it grants no data.
 *
 * Every answer is a JSON string. Errors are answers too, never exceptions: a
 * thrown error reaches the browser as an empty response, which the page would have
 * to interpret, and it is better told.
 */
var CmdCeoAjax = Class.create();
CmdCeoAjax.prototype = Object.extendsObject(global.AbstractAjaxProcessor, {

    /** Values, deltas and trends for a set of indicators. */
    measures: function () {
        var self = this;
        return cmdCeoAnswer(function (board) {
            return board.measures(
                String(self.getParameter('sysparm_ids') || '').split(','),
                String(self.getParameter('sysparm_period') || ''),
                String(self.getParameter('sysparm_filters') || ''),
                { nocache: String(self.getParameter('sysparm_nocache') || '') === '1' });
        });
    },

    /** The breakdown panel of one portfolio. */
    breakdown: function () {
        var self = this;
        return cmdCeoAnswer(function (board) {
            return board.breakdown(
                String(self.getParameter('sysparm_portfolio') || ''),
                String(self.getParameter('sysparm_period') || ''),
                String(self.getParameter('sysparm_filters') || ''));
        });
    },

    type: 'CmdCeoAjax'
});

/* Outside the prototype, so it is not itself a callable GlideAjax method. */
function cmdCeoAnswer(fn) {
    var started = new Date().getTime();
    var out;
    try {
        if (!CmdCeoBoard.allowed()) {
            out = { denied: true,
                    error: 'The CEO Dashboard needs the ' + CmdCeoBoard.ROLE + ' role.' };
        } else {
            out = fn(new CmdCeoBoard());
        }
    } catch (e) {
        out = { error: 'The dashboard could not compute this: ' + e };
    }
    out.serverMs = new Date().getTime() - started;
    return JSON.stringify(out);
}
