/* GET|POST /api/eyi/ey_ai_dashboard/aiconfig
 *
 * Self-service AI provider setup, so nobody has to configure an Outbound REST
 * message, a credential record or a MID server to get the in-page AI working.
 *
 * GET  reports what is currently wired up and whether the instance can actually
 *      reach the provider - egress is the thing that silently breaks this, so it
 *      is probed rather than assumed.
 * POST accepts a key, validates it with a real (1-token) call before saving, and
 *      only persists it if the provider answers. A key that does not work never
 *      makes it into the property, so the dashboard cannot end up pointing at a
 *      provider that will fail at demo time.
 *
 * The key lands in ey.ai.dashboard.anthropic_key, type password2 (encrypted at
 * rest, admin-only read). It is never echoed back - responses report presence and
 * a masked tail only.
 */
(function process(request, response) {

    var KEY_PROP = 'ey.ai.dashboard.anthropic_key';
    var ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
    var ANTHROPIC_MODEL = 'claude-opus-5';

    function key() { return gs.getProperty(KEY_PROP, '') || ''; }

    function mask(k) {
        if (!k) return null;
        return k.length > 8 ? k.substring(0, 7) + '...' + k.substring(k.length - 4) : 'set';
    }

    /* A keyless POST is enough to tell reachable-and-rejecting (401 with a JSON
     * error body) apart from cannot-get-there-at-all (transport exception). */
    function probeEgress() {
        try {
            var r = new sn_ws.RESTMessageV2();
            r.setEndpoint(ANTHROPIC_URL);
            r.setHttpMethod('POST');
            r.setRequestHeader('content-type', 'application/json');
            r.setRequestHeader('anthropic-version', '2023-06-01');
            r.setRequestBody('{}');
            r.setHttpTimeout(15000);
            var resp = r.execute();
            var st = resp.getStatusCode();
            return {
                reachable: true,
                status: st,
                detail: 'Instance reached api.anthropic.com (HTTP ' + st +
                        '). Outbound egress is open; a valid key is all that is missing.'
            };
        } catch (e) {
            return {
                reachable: false,
                detail: 'Instance could not reach api.anthropic.com: ' + String(e) +
                        ' Outbound HTTPS is blocked, so the bring-your-own-key path ' +
                        'cannot work from inside the platform. Use the MCP path instead.'
            };
        }
    }

    function validate(candidate) {
        try {
            var r = new sn_ws.RESTMessageV2();
            r.setEndpoint(ANTHROPIC_URL);
            r.setHttpMethod('POST');
            r.setRequestHeader('content-type', 'application/json');
            r.setRequestHeader('x-api-key', candidate);
            r.setRequestHeader('anthropic-version', '2023-06-01');
            r.setRequestBody(JSON.stringify({
                model: ANTHROPIC_MODEL,
                max_tokens: 4,
                messages: [{ role: 'user', content: 'Reply with the single word: ok' }]
            }));
            r.setHttpTimeout(30000);
            var resp = r.execute();
            var st = resp.getStatusCode();
            var raw = String(resp.getBody() || '');
            if (st >= 200 && st < 300) {
                var p = JSON.parse(raw);
                return { ok: true, model: p.model };
            }
            var msg = raw;
            try { msg = JSON.parse(raw).error.message; } catch (e2) {}
            return { ok: false, error: 'Provider rejected the key (HTTP ' + st + '): ' + msg };
        } catch (e) {
            return { ok: false, error: 'Could not reach the provider: ' + String(e) };
        }
    }

    var method = request.httpMethod;

    if (method === 'GET') {
        var k = key();
        return {
            configured: !!k,
            key_hint: mask(k),
            provider: k ? 'anthropic' : 'nowassist',
            model: k ? ANTHROPIC_MODEL : 'now-assist (Azure OpenAI)',
            egress: probeEgress(),
            note: k ? 'In-page AI runs on your own Anthropic key.'
                    : 'No key set. The dashboard will try Now Assist, which on this instance ' +
                      'has no active provider definition for free-form analysis. Paste a key ' +
                      'to switch providers - nothing else needs configuring.'
        };
    }

    var body = request.body && request.body.data ? request.body.data : {};

    /* Clearing is explicit and needs no validation - it just reverts to Now Assist. */
    if (body.clear === true) {
        gs.setProperty(KEY_PROP, '');
        return { ok: true, configured: false, provider: 'nowassist',
                 note: 'Key cleared. Reverted to Now Assist.' };
    }

    var candidate = String(body.key || '').trim();
    if (!candidate)
        return { ok: false, error: 'No key supplied. POST {"key": "sk-ant-..."} or {"clear": true}.' };

    var v = validate(candidate);
    if (!v.ok) return { ok: false, configured: !!key(), error: v.error };

    gs.setProperty(KEY_PROP, candidate);
    gs.info('[EY AI dashboard] Anthropic provider configured by ' + gs.getUserName());

    return {
        ok: true,
        configured: true,
        provider: 'anthropic',
        model: v.model,
        key_hint: mask(candidate),
        note: 'Key validated against the provider and saved encrypted. In-page AI is live.'
    };

})(request, response);
