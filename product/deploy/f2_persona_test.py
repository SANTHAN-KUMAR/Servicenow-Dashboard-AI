#!/usr/bin/env python3
"""F2: prove the FILTERED ACL path is real, not just present in code.

Every other check this engagement has run against dev390988 used an admin
session. GlideAggregate and GlideRecordSecure agree for an admin -- admin
bypasses row-level ACLs entirely, so an admin-only test can never distinguish
"the product computes the secure count" from "the product computes the fast
count and nothing has ever disagreed with it." That gap is what let F1 and an
earlier historical bug both reach a live instance unnoticed.

First pass targeted `incident` with a synthetic role-scoped ACL. It came back
VERIFIED, not FILTERED: `incident` (like `change_request` and `sys_user`, per
f2_acl_survey.py) already carries a read ACL with no role requirement and no
condition, which matches every user unconditionally regardless of what else
fails, and no additional ACL can out-compete that. `problem`, by contrast, has
no such open ACL -- every read ACL on it requires a role or a script/
condition -- so a persona holding none of those roles is filtered by the
platform's own production ACL configuration, not a synthetic one added for
this test. That is the stronger proof, and it needs no new ACL at all: the
role/user this script still creates exists only so the persona is a real,
tagged, removable identity, not to grant or restrict anything on `problem`.

This script closes it in one round trip (the instance is slow enough that
round trips are the budget to spend, not calls):

  1. create (idempotently) a role and a test user holding only that role --
     no itil, no problem_task_analyst, no admin, nothing that any of
     `problem`'s existing read ACLs would match
  2. impersonate that user
  3. run the actual product code (CmdPayload().dashboard) exactly as the UI
     page does, plus an independent raw GlideAggregate/GlideRecordSecure
     count as a cross-check that does not go through the product at all
  4. de-impersonate
  5. return everything, including a dump of every read ACL on `problem` or
     `*` -- so if the test comes back "nothing was filtered," the reason is
     visible without a second round trip

    python3 product/deploy/f2_persona_test.py            run the test
    python3 product/deploy/f2_persona_test.py --purge     remove the role/user
"""

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from snclient import Instance, InstanceError  # noqa: E402

TAG = "CMD_F2_TEST_V1"
ROLE_NAME = "cmd_test_restricted"
USER_NAME = "cmd.test.restricted"
TARGET_TABLE = "problem"

RUN_JS = r"""
var TAG = '__TAG__';
var ROLE_NAME = '__ROLE_NAME__';
var USER_NAME = '__USER_NAME__';
var TABLE = '__TABLE__';

function findOrCreate(table, query, fields) {
    var gr = new GlideRecord(table);
    gr.addEncodedQuery(query);
    gr.query();
    if (gr.next()) return { sysId: gr.getUniqueValue(), created: false };
    var ins = new GlideRecord(table);
    ins.initialize();
    for (var k in fields) ins.setValue(k, fields[k]);
    var id = ins.insert();
    return { sysId: id, created: true };
}

var out = { tag: TAG, table: TABLE };

/* 1. a real, tagged, removable identity -- holds only this one role, which
   none of `problem`'s own read ACLs require, so it grants nothing there.
   It exists so the persona is a genuine sys_user (impersonation needs one),
   not to influence access. */
var role = findOrCreate('sys_user_role', 'name=' + ROLE_NAME, {
    name: ROLE_NAME,
    description: 'CMD engagement: F2 non-admin persona for live ACL verification. ' + TAG
});
out.roleId = role.sysId;

var user = findOrCreate('sys_user', 'user_name=' + USER_NAME, {
    user_name: USER_NAME,
    first_name: 'CMD',
    last_name: 'Test Restricted',
    active: true
});
out.userId = user.sysId;

var userRole = findOrCreate('sys_user_has_role',
    'user=' + user.sysId + '^role=' + role.sysId, {
        user: user.sysId,
        role: role.sysId
    });
out.userHasRoleId = userRole.sysId;

/* diagnostic: every active read ACL on TABLE or *, with roles resolved, so a
   "nothing was filtered" result is explainable without a second round trip */
out.readAcls = [];
var ag = new GlideRecord('sys_security_acl');
ag.addQuery('operation', 'read');
ag.addQuery('name', 'IN', TABLE + ',*');
ag.addQuery('active', true);
ag.query();
while (ag.next()) {
    var roles = [];
    var rr = new GlideRecord('sys_security_acl_role');
    rr.addQuery('sys_security_acl', ag.getUniqueValue());
    rr.query();
    while (rr.next()) roles.push(rr.getDisplayValue('sys_user_role'));
    out.readAcls.push({
        name: ag.getValue('name'),
        roles: roles,
        hasScript: !!ag.getValue('script'),
        hasCondition: !!ag.getValue('condition')
    });
}

/* 2-4. impersonated: raw cross-check plus the actual product code */
var before = gs.getUserID();
gs.impersonate(USER_NAME);
try {
    var agg = new GlideAggregate(TABLE);
    agg.addAggregate('COUNT');
    agg.query();
    out.rawAggregate = agg.next() ? parseInt(agg.getAggregate('COUNT'), 10) : 0;

    var sec = new GlideRecordSecure(TABLE);
    sec.query();
    var secCount = 0;
    while (sec.next()) secCount++;
    out.rawSecure = secCount;

    var payload = new CmdPayload().dashboard(TABLE, [], {});
    out.productMode = payload.acl && payload.acl.mode;
    out.productAggregate = payload.acl && payload.acl.aggregate;
    out.productSecure = payload.acl && payload.acl.secure;
    out.productTotal = payload.total;
} finally {
    gs.impersonate(before);
}

out.impersonatedAs = USER_NAME;
gs.print('@@' + JSON.stringify(out));
"""

PURGE_JS = r"""
var removed = { user_roles: 0, users: 0, roles: 0 };

var ur = new GlideRecord('sys_user_has_role');
ur.addQuery('role.name', '__ROLE_NAME__');
ur.query();
while (ur.next()) { ur.deleteRecord(); removed.user_roles++; }

var u = new GlideRecord('sys_user');
u.addQuery('user_name', '__USER_NAME__');
u.query();
while (u.next()) { u.deleteRecord(); removed.users++; }

var r = new GlideRecord('sys_user_role');
r.addQuery('name', '__ROLE_NAME__');
r.query();
while (r.next()) { r.deleteRecord(); removed.roles++; }

/* also remove the synthetic incident ACL from the abandoned first pass,
   if it is still there */
var a = new GlideRecord('sys_security_acl');
a.addQuery('description', '__TAG__');
a.query();
while (a.next()) { a.deleteRecord(); removed.acls = (removed.acls || 0) + 1; }

gs.print('@@' + JSON.stringify(removed));
"""


def render(js):
    return (js.replace('__TAG__', TAG)
              .replace('__ROLE_NAME__', ROLE_NAME)
              .replace('__USER_NAME__', USER_NAME)
              .replace('__TABLE__', TARGET_TABLE))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--purge", action="store_true")
    ap.add_argument("--credentials", default=None)
    args = ap.parse_args()

    inst = Instance(args.credentials, verbose=True).login()

    if args.purge:
        res = inst.run_json(render(PURGE_JS))
        print("  removed:", json.dumps(res, indent=2))
        return 0

    print(f"  running the F2 live persona test against `{TARGET_TABLE}` ({TAG})\n")
    res = inst.run_json(render(RUN_JS))
    print(json.dumps(res, indent=2))

    print()
    if res.get("rawAggregate") == res.get("rawSecure"):
        print(f"  FAIL: raw aggregate == raw secure count on `{TARGET_TABLE}` -- "
              f"nothing was filtered. See res.readAcls above for a matching ACL "
              f"that may be granting this user access some other way.")
        return 1
    if res.get("productMode") not in ("FILTERED", "DENIED"):
        print(f"  FAIL: raw counts disagree ({res.get('rawAggregate')} vs "
              f"{res.get('rawSecure')}) but the product reported mode="
              f"{res.get('productMode')!r}, not FILTERED/DENIED.")
        return 1
    if res.get("productSecure") != res.get("rawSecure"):
        print(f"  FAIL: product's secure count ({res.get('productSecure')}) does not "
              f"match the independent raw secure count ({res.get('rawSecure')}).")
        return 1
    if res.get("productTotal") != res.get("rawSecure"):
        print(f"  FAIL: the number the dashboard would actually display "
              f"({res.get('productTotal')}) is not the secure count "
              f"({res.get('rawSecure')}) -- a restricted viewer would see a wrong "
              f"total.")
        return 1

    print(f"  PASS: aggregate={res.get('rawAggregate')} secure={res.get('rawSecure')} "
          f"on `{TARGET_TABLE}` -- the restricted persona sees only "
          f"{res.get('rawSecure')} of {res.get('rawAggregate')} records, the "
          f"product reported mode={res.get('productMode')}, and the number it would "
          f"actually display ({res.get('productTotal')}) is the correct restricted "
          f"count, not the inflated aggregate.")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except InstanceError as exc:
        print(f"\n  FAILED: {exc}\n", file=sys.stderr)
        sys.exit(1)
