var EYAIDashAI = Class.create();

EYAIDashAI.ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
EYAIDashAI.ANTHROPIC_VERSION = '2023-06-01';
EYAIDashAI.MODEL = 'claude-opus-5';

// Native Now Assist capability used as the in-platform fallback path.
// "Analytics query generation" is the only analytics skill with an ACTIVE
// provider definition on this instance (the insight-generation ones are all
// active=false), and it is verified working as ey_Kumar.
EYAIDashAI.ONE_EXTEND_CAP = '3de07c0fa3b41210cdf300c2f31e6164';

EYAIDashAI.prototype = {

    initialize: function() {
        this.apiKey = gs.getProperty('ey.ai.dashboard.anthropic_key', '');
        this.provider = gs.getProperty('ey.ai.dashboard.provider', 'auto');
    },

    /**
     * Which AI path will actually be used, without spending a call.
     */
    status: function() {
        return {
            provider_setting: this.provider,
            anthropic_key_present: !!this.apiKey,
            effective_provider: this._pick(),
            model: EYAIDashAI.MODEL
        };
    },

    _pick: function() {
        if (this.provider === 'nowassist')
            return 'nowassist';
        if (this.provider === 'anthropic')
            return 'anthropic';
        return this.apiKey ? 'anthropic' : 'nowassist';
    },

    /**
     * Generate dashboard insights from an aggregate payload.
     * Returns {ok, provider, insights: [{title, detail, severity}], raw, error}
     */
    insights: function(payloadObj, context) {
        var which = this._pick();
        if (which === 'anthropic')
            return this._anthropicInsights(payloadObj, context);
        return this._nowAssistInsights(payloadObj, context);
    },

    // ---------------------------------------------------------------- Anthropic

    _anthropicInsights: function(payloadObj, context) {
        var schema = {
            type: 'object',
            properties: {
                headline: { type: 'string' },
                insights: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            title: { type: 'string' },
                            detail: { type: 'string' },
                            severity: { type: 'string', enum: ['info', 'watch', 'critical'] }
                        },
                        required: ['title', 'detail', 'severity'],
                        additionalProperties: false
                    }
                },
                recommended_metrics: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            metric: { type: 'string' },
                            why: { type: 'string' },
                            chart: {
                                type: 'string',
                                enum: ['bar', 'line', 'area', 'donut', 'treemap', 'heatmap', 'scatter', 'waterfall', 'gauge']
                            }
                        },
                        required: ['metric', 'why', 'chart'],
                        additionalProperties: false
                    }
                }
            },
            required: ['headline', 'insights', 'recommended_metrics'],
            additionalProperties: false
        };

        var system = 'You are an ITSM analytics advisor embedded in a ServiceNow dashboard. ' +
            'You are given aggregate counts already computed under the viewing user\'s access ' +
            'control rules. Report only what the numbers support. Do not invent records, ' +
            'trends, or causes you cannot see. Be specific and quantitative. ' +
            'Do not include internal or system XML tags in your response. ' +
            'Keep each detail under 30 words.';

        var user = 'Context: ' + (context || 'ServiceNow ITSM operational data') + '\n\n' +
            'Aggregates (json):\n' + JSON.stringify(payloadObj) + '\n\n' +
            'Produce a headline, 3-5 insights, and 2-4 recommended additional metrics ' +
            'worth tracking, each with the chart type that fits the shape of that metric.';

        var body = {
            model: EYAIDashAI.MODEL,
            // Deliberately small: this call runs inline in a dashboard page load and
            // must return well inside the platform's outbound REST timeout.
            max_tokens: 2000,
            system: system,
            output_config: {
                effort: 'low',
                format: { type: 'json_schema', schema: schema }
            },
            messages: [{ role: 'user', content: user }]
        };

        var res = this._post(EYAIDashAI.ANTHROPIC_URL, body);
        if (!res.ok)
            return { ok: false, provider: 'anthropic', error: res.error, status: res.status, raw: res.raw };

        var parsed;
        try {
            parsed = JSON.parse(res.raw);
        } catch (e) {
            return { ok: false, provider: 'anthropic', error: 'unparseable response', raw: res.raw };
        }

        if (parsed.stop_reason === 'refusal') {
            return { ok: false, provider: 'anthropic', error: 'refusal', raw: res.raw };
        }

        var text = '';
        var content = parsed.content || [];
        for (var i = 0; i < content.length; i++) {
            if (content[i].type === 'text')
                text += content[i].text;
        }

        var obj;
        try {
            obj = JSON.parse(text);
        } catch (e2) {
            return { ok: false, provider: 'anthropic', error: 'model did not return json', raw: text };
        }

        return {
            ok: true,
            provider: 'anthropic',
            model: parsed.model,
            headline: obj.headline,
            insights: obj.insights || [],
            recommended_metrics: obj.recommended_metrics || [],
            usage: parsed.usage
        };
    },

    _post: function(url, bodyObj) {
        try {
            var r = new sn_ws.RESTMessageV2();
            r.setEndpoint(url);
            r.setHttpMethod('POST');
            r.setRequestHeader('content-type', 'application/json');
            r.setRequestHeader('x-api-key', this.apiKey);
            r.setRequestHeader('anthropic-version', EYAIDashAI.ANTHROPIC_VERSION);
            r.setRequestBody(JSON.stringify(bodyObj));
            r.setHttpTimeout(55000);

            var resp = r.execute();
            var status = resp.getStatusCode();
            var raw = resp.getBody();

            if (status >= 200 && status < 300)
                return { ok: true, status: status, raw: raw };
            return { ok: false, status: status, error: 'HTTP ' + status, raw: raw };
        } catch (e) {
            return { ok: false, status: 0, error: String(e), raw: '' };
        }
    },

    /**
     * Reachability probe. A 401 from Anthropic is a SUCCESS for this test: it proves
     * the instance can egress to the provider and only the credential is missing.
     */
    connectivity: function() {
        var r = this._post(EYAIDashAI.ANTHROPIC_URL, {
            model: EYAIDashAI.MODEL,
            max_tokens: 16,
            messages: [{ role: 'user', content: 'Reply with the word OK.' }]
        });
        return {
            endpoint: EYAIDashAI.ANTHROPIC_URL,
            reachable: r.status > 0,
            status: r.status,
            authenticated: r.status >= 200 && r.status < 300,
            detail: (r.raw || r.error || '').toString().substring(0, 400)
        };
    },

    // ---------------------------------------------------------------- Now Assist

    _nowAssistInsights: function(payloadObj, context) {
        try {
            var request = {
                executionRequests: [{
                    capabilityId: EYAIDashAI.ONE_EXTEND_CAP,
                    payload: {
                        prompt: 'Return the analysis as a json object.',
                        utterance: 'Analyse this ServiceNow ITSM aggregate data and respond in json ' +
                            'with a headline and insights: ' + JSON.stringify(payloadObj),
                        context: context || 'ServiceNow ITSM operational data',
                        current_time: new GlideDateTime().getDisplayValue()
                    }
                }]
            };

            var out = sn_one_extend.OneExtendUtil.execute(request);
            var caps = (out && out.capabilities) ? out.capabilities : {};
            var cap = caps[EYAIDashAI.ONE_EXTEND_CAP];

            if (!cap || cap.status !== 'success') {
                return {
                    ok: false,
                    provider: 'nowassist',
                    error: (cap && (cap.error || cap.errorCode)) || 'one-extend call failed',
                    raw: JSON.stringify(out)
                };
            }

            var text = cap.response || '';
            var obj = null;
            try {
                obj = JSON.parse(text);
            } catch (e) { /* free text is acceptable from this skill */ }

            return {
                ok: true,
                provider: 'nowassist',
                model: cap.model || 'now-assist',
                headline: (obj && obj.headline) || 'Now Assist analysis',
                insights: (obj && obj.insights) || [{
                    title: 'Now Assist response',
                    detail: String(text).substring(0, 300),
                    severity: 'info'
                }],
                recommended_metrics: (obj && obj.recommended_metrics) || []
            };
        } catch (e) {
            return { ok: false, provider: 'nowassist', error: String(e) };
        }
    },

    type: 'EYAIDashAI'
};
