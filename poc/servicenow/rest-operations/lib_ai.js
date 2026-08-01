    // ---- EY AI Dashboard inline AI layer -----------------------------------
    // Default path is Now Assist (already licensed on this instance, nothing to
    // configure). The bring-your-own-provider path only activates if someone
    // deliberately sets the property, so out of the box there are no keys to manage.
    var ONE_EXTEND_CAP = '3de07c0fa3b41210cdf300c2f31e6164'; // Analytics query generation
    var ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
    var ANTHROPIC_MODEL = 'claude-opus-5';

    function aiKey() { return gs.getProperty('ey.ai.dashboard.anthropic_key', ''); }

    function aiProvider() {
        var p = gs.getProperty('ey.ai.dashboard.provider', 'auto');
        if (p === 'nowassist' || p === 'anthropic') return p;
        return aiKey() ? 'anthropic' : 'nowassist';
    }

    function aiStatus() {
        return {
            effective_provider: aiProvider(),
            byo_key_present: !!aiKey(),
            nowassist_capability: ONE_EXTEND_CAP,
            model: aiProvider() === 'anthropic' ? ANTHROPIC_MODEL : 'now-assist (Azure OpenAI)'
        };
    }

    function aiNowAssist(payloadObj, context) {
        try {
            var req = {
                executionRequests: [{
                    capabilityId: ONE_EXTEND_CAP,
                    payload: {
                        prompt: 'Return the analysis as a json object.',
                        utterance: 'You are an ITSM analytics advisor. Analyse this ServiceNow ' +
                            'aggregate data and respond in json with keys "headline" (string) and ' +
                            '"insights" (array of {title, detail, severity}). Data: ' +
                            JSON.stringify(payloadObj),
                        context: context || 'ServiceNow ITSM operational data',
                        current_time: new GlideDateTime().getDisplayValue()
                    }
                }]
            };
            var out = sn_one_extend.OneExtendUtil.execute(req);
            var caps = (out && out.capabilities) ? out.capabilities : {};
            var cap = caps[ONE_EXTEND_CAP];
            if (!cap || cap.status !== 'success') {
                return { ok: false, provider: 'nowassist',
                         error: (cap && (cap.error || cap.errorCode)) || 'one-extend call failed',
                         raw: JSON.stringify(out).substring(0, 800) };
            }
            var text = cap.response || '';
            var obj = null;
            try { obj = JSON.parse(text); } catch (e) {}
            return {
                ok: true, provider: 'nowassist', model: cap.model || 'now-assist',
                headline: (obj && obj.headline) || 'Now Assist analysis',
                insights: (obj && obj.insights) || [
                    { title: 'Now Assist response', detail: String(text).substring(0, 400), severity: 'info' }
                ],
                recommended_metrics: (obj && obj.recommended_metrics) || []
            };
        } catch (e) {
            return { ok: false, provider: 'nowassist', error: String(e) };
        }
    }

    function aiAnthropic(payloadObj, context) {
        var schema = {
            type: 'object',
            properties: {
                headline: { type: 'string' },
                insights: { type: 'array', items: { type: 'object', properties: {
                    title: { type: 'string' }, detail: { type: 'string' },
                    severity: { type: 'string', 'enum': ['info', 'watch', 'critical'] }
                }, required: ['title', 'detail', 'severity'], additionalProperties: false } },
                recommended_metrics: { type: 'array', items: { type: 'object', properties: {
                    metric: { type: 'string' }, why: { type: 'string' },
                    chart: { type: 'string', 'enum': ['bar','line','area','donut','treemap','heatmap','scatter','gauge'] }
                }, required: ['metric', 'why', 'chart'], additionalProperties: false } }
            },
            required: ['headline', 'insights', 'recommended_metrics'],
            additionalProperties: false
        };
        var body = {
            model: ANTHROPIC_MODEL,
            max_tokens: 2000,
            system: 'You are an ITSM analytics advisor embedded in a ServiceNow dashboard. The ' +
                    'aggregates you receive were computed under the viewing user\'s access rules. ' +
                    'Report only what the numbers support; invent nothing. Be quantitative. ' +
                    'Do not include internal or system XML tags. Keep each detail under 30 words.',
            output_config: { effort: 'low', format: { type: 'json_schema', schema: schema } },
            messages: [{ role: 'user', content:
                'Context: ' + (context || 'ServiceNow ITSM') + '\n\nAggregates (json):\n' +
                JSON.stringify(payloadObj) + '\n\nGive a headline, 3-5 insights, and 2-4 further ' +
                'metrics worth tracking with the chart type that fits each metric\'s shape.' }]
        };
        try {
            var r = new sn_ws.RESTMessageV2();
            r.setEndpoint(ANTHROPIC_URL);
            r.setHttpMethod('POST');
            r.setRequestHeader('content-type', 'application/json');
            r.setRequestHeader('x-api-key', aiKey());
            r.setRequestHeader('anthropic-version', '2023-06-01');
            r.setRequestBody(JSON.stringify(body));
            r.setHttpTimeout(55000);
            var resp = r.execute();
            var st = resp.getStatusCode();
            var raw = resp.getBody();
            if (st < 200 || st >= 300)
                return { ok: false, provider: 'anthropic', error: 'HTTP ' + st, raw: String(raw).substring(0, 600) };
            var parsed = JSON.parse(raw);
            if (parsed.stop_reason === 'refusal')
                return { ok: false, provider: 'anthropic', error: 'refusal' };
            var text = '', c = parsed.content || [];
            for (var i = 0; i < c.length; i++) if (c[i].type === 'text') text += c[i].text;
            var obj = JSON.parse(text);
            return { ok: true, provider: 'anthropic', model: parsed.model,
                     headline: obj.headline, insights: obj.insights || [],
                     recommended_metrics: obj.recommended_metrics || [], usage: parsed.usage };
        } catch (e) {
            return { ok: false, provider: 'anthropic', error: String(e) };
        }
    }

    function aiInsights(payloadObj, context) {
        return aiProvider() === 'anthropic' ? aiAnthropic(payloadObj, context)
                                            : aiNowAssist(payloadObj, context);
    }
    // ------------------------------------------------------------------------
