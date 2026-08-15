#!/usr/bin/env python3
"""Diagnostic only, no writes: why did F2's restrictive ACL not bite on `incident`?

f2_persona_test.py added a role-scoped, conditional read ACL on `incident` and
a test user holding only that role, and the test user still saw every row.
ACL evaluation for a table+operation is effectively OR'd across every ACL that
matches the user's role -- and `incident` already carries a read ACL with no
role requirement and no condition, which matches everyone unconditionally and
alone is enough to grant full read regardless of what else fails. Adding
another ACL cannot out-compete that; only removing or narrowing the existing
one would, and that is real production security config on a client-facing
instance, not something to touch for a test.

So before writing another ACL anywhere, this finds a table that does NOT
already have an unconditional read ACL, by resolving the actual roles/
conditions on every read ACL for a short list of real dashboard tables. Zero
writes, safe to re-run.

    python3 product/deploy/f2_acl_survey.py
"""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from snclient import Instance, InstanceError  # noqa: E402

TABLES = ["incident", "problem", "change_request", "kb_knowledge", "sys_user"]

SURVEY_JS = r"""
var TABLES = __TABLES__;
var out = {};

for (var i = 0; i < TABLES.length; i++) {
    var table = TABLES[i];
    var acls = [];
    var ag = new GlideRecord('sys_security_acl');
    ag.addQuery('name', table);
    ag.addQuery('operation', 'read');
    ag.addQuery('type', 'record');
    ag.addQuery('active', true);
    ag.query();
    while (ag.next()) {
        var roles = [];
        var rr = new GlideRecord('sys_security_acl_role');
        rr.addQuery('sys_security_acl', ag.getUniqueValue());
        rr.query();
        while (rr.next()) roles.push(rr.getDisplayValue('sys_user_role'));

        acls.push({
            sysId: ag.getUniqueValue(),
            roles: roles,
            hasScript: !!ag.getValue('script'),
            hasCondition: !!ag.getValue('condition'),
            adminOverrides: ag.getValue('admin_overrides'),
            unconditionalOpen: roles.length === 0 && !ag.getValue('script') &&
                                !ag.getValue('condition')
        });
    }
    out[table] = acls;
}

gs.print('@@' + JSON.stringify(out));
"""


def main():
    inst = Instance(verbose=True).login()
    res = inst.run_json(SURVEY_JS.replace('__TABLES__', json.dumps(TABLES)))

    for table, acls in res.items():
        open_acls = [a for a in acls if a["unconditionalOpen"]]
        print(f"\n  {table}  ({len(acls)} active read ACL(s))")
        for a in acls:
            tag = "OPEN (no role, no condition)" if a["unconditionalOpen"] else (
                f"roles={a['roles']}" if a["roles"] else "no role"
            ) + (", scripted" if a["hasScript"] else "") + (
                ", conditional" if a["hasCondition"] else "")
            print(f"    - {tag}")
        if open_acls:
            print(f"    => any authenticated user can read every row; "
                  f"a new restrictive ACL here cannot win.")
        else:
            print(f"    => every read ACL requires a role or a condition; "
                  f"a persona lacking all of them should be filtered or denied.")

    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except InstanceError as exc:
        print(f"\n  FAILED: {exc}\n", file=sys.stderr)
        sys.exit(1)
