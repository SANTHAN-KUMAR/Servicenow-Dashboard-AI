(function process(request, response) {

    var ai = new global.EYAIDashAI();
    var body = request.body ? request.body.data : null;

    if (!body || !body.aggregates) {
        response.setStatus(400);
        response.setBody({ error: 'POST body must contain an "aggregates" object.' });
        return;
    }

    var result = ai.insights(body.aggregates, body.context || '');
    result.ai_status = ai.status();

    response.setStatus(result.ok ? 200 : 502);
    response.setBody(result);

})(request, response);
