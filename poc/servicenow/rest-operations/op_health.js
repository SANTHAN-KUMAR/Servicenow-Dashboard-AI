(function process(request, response) {

    var ai = new global.EYAIDashAI();
    var out = {
        ok: true,
        instance: gs.getProperty('instance_name'),
        viewer: gs.getUserName(),
        time: new GlideDateTime().getDisplayValue(),
        ai: ai.status()
    };

    // ?probe=1 spends a real outbound call to prove egress to the AI provider.
    var probe = request.queryParams.probe ? request.queryParams.probe[0] : '';
    if (probe === '1') {
        out.connectivity = ai.connectivity();
    }

    response.setStatus(200);
    response.setBody(out);

})(request, response);
