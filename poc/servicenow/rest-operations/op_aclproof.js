(function process(request, response) {

    var d = new global.EYAIDashData();
    var table = request.queryParams.table ? request.queryParams.table[0] : 'incident';
    var field = request.queryParams.field ? request.queryParams.field[0] : 'category';
    var query = request.queryParams.query ? request.queryParams.query[0] : '';

    var proof = d.aclProof(table, field, query);

    proof.verdict = proof.leaked > 0
        ? 'LEAK: GlideAggregate reports ' + proof.aggregate_total + ' but this viewer can only read ' +
          proof.secure_total + '. A naive KPI card would expose ' + proof.leaked + ' records they cannot open.'
        : 'SAFE: aggregate and ACL-filtered counts agree for this viewer (' + proof.secure_total + ').';

    if (proof.capped) {
        proof.verdict += ' NOTE: secure scan hit the row cap, so the secure figure is a floor, not a total.';
    }

    response.setStatus(200);
    response.setBody(proof);

})(request, response);
