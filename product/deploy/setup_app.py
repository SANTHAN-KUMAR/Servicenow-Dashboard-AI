#!/usr/bin/env python3
"""Everything the CEO Dashboard needs on an instance besides code.

    python3 product/deploy/setup_app.py              roles, settings, menu, personas
    python3 product/deploy/setup_app.py --no-users   the application records only

deploy.py ships Script Includes, UI Scripts and UI Pages. The dashboard also needs
records that are configuration rather than code, and they have to exist for the
page to be usable by anyone but an administrator:

  roles       x_2185255_command.ceo_viewer   opens the CEO Dashboard
              x_2185255_command.admin        configures it; contains ceo_viewer
  settings    ceo_portfolio_names            JSON of display names per portfolio
              ceo_default_period             today | 7d | 30d | 90d | 12m
              ceo_headline_indicator         the orbit's centre, a pa_indicators id
  menu        COMMAND Analytics -> CEO Dashboard / Dashboards and reports / Settings

Roles, settings and the menu are application records, written inside the scope so
they travel in the update set. The personas are data, written in global and never
packaged: they exist on the development instance so the role gate and the
permission proof can be demonstrated with real logins.

  ceo.leader       ceo_viewer + itil   the leadership view: every table readable
  ceo.restricted   ceo_viewer only     the differentiator: the same page, counted
                                       against a viewer who can read far less

Idempotent: every record is found by its natural key and updated in place, and
every write is read back (snclient.upsert_verified) rather than trusted.
"""

import argparse
import json
import secrets
import string
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from snclient import Instance, InstanceError  # noqa: E402

SCOPE = "x_2185255_command"
ROLE_VIEWER = f"{SCOPE}.ceo_viewer"
ROLE_ADMIN = f"{SCOPE}.admin"
CRED = Path(__file__).parent / "credentials.json"

PROPERTIES = [
    (f"{SCOPE}.ceo_portfolio_names", "",
     "CEO Dashboard: display names for the portfolios, as JSON, e.g. "
     '{"portfolio1":"Service Operations"}. Empty shows the source keys as Portfolio 1..n.'),
    (f"{SCOPE}.ceo_default_period", "30d",
     "CEO Dashboard: the period a viewer sees first. One of today, 7d, 30d, 90d, 12m. "
     "PA's own today value is shown on every card whatever this is."),
    (f"{SCOPE}.ceo_headline_indicator", "",
     "CEO Dashboard: the pa_indicators sys_id at the centre of the orbit. Empty uses "
     "Number of open incidents."),
]

PERSONAS = [
    ("ceo.leader", "CEO", "Leader", [ROLE_VIEWER, "itil"]),
    ("ceo.restricted", "CEO", "Restricted", [ROLE_VIEWER]),
]

PROBES = [("sys_script_include", "name", "CmdProbeAjax"),
          ("sys_ui_page", "name", "cmd_probe"),
          ("sys_ui_script", "script_name", "cmd_probe_js")]


def one(inst, table, query, fields):
    rows = inst.query(table, query, fields, limit=2)
    return rows[0] if rows else None


def ensure_role(inst, name, description, scope_id):
    return inst.upsert_verified("sys_user_role", "name", name,
                                {"name": name, "description": description,
                                 "suffix": name.split(".", 1)[1]},
                                verify_field="description",
                                match_query=f"sys_scope={scope_id}")


def role_id(inst, name):
    r = one(inst, "sys_user_role", f"name={name}", ["sys_id"])
    if not r:
        raise InstanceError(f"role {name} does not exist")
    return r["sys_id"]


def ensure_contains(inst, parent, child):
    p, c = role_id(inst, parent), role_id(inst, child)
    if one(inst, "sys_user_role_contains", f"role={p}^contains={c}", ["sys_id"]):
        return
    inst.insert("sys_user_role_contains", {"role": p, "contains": c})
    if not one(inst, "sys_user_role_contains", f"role={p}^contains={c}", ["sys_id"]):
        raise InstanceError(f"{parent} does not contain {child} after writing it")
    print(f"  created  role contains            {parent} > {child}")


def ensure_property(inst, name, default, description, scope_id):
    existing = one(inst, "sys_properties", f"name={name}", ["sys_id", "value"])
    payload = {"name": name, "type": "string", "description": description}
    if not existing:
        payload["value"] = default
        inst.insert("sys_properties", payload)
        print(f"  created  sys_properties           {name} = {default!r}")
    else:
        # Never overwrite a value somebody has set; only keep the description current.
        inst.update("sys_properties", existing["sys_id"], {"description": description})
        print(f"  kept     sys_properties           {name} = {existing.get('value')!r}")


def ensure_menu(inst, scope_id):
    app = one(inst, "sys_app_application", f"title=COMMAND Analytics^sys_scope={scope_id}", ["sys_id"])
    if not app:
        inst.insert("sys_app_application", {"title": "COMMAND Analytics", "active": "true",
                                            "order": "100", "roles": "",
                                            "hint": "Dashboards and reports, counted against your access"})
        app = one(inst, "sys_app_application", f"title=COMMAND Analytics^sys_scope={scope_id}", ["sys_id"])
        if not app:
            raise InstanceError("the application menu was not created")
        print("  created  sys_app_application      COMMAND Analytics")
    modules = [
        ("CEO Dashboard", f"{SCOPE}_cmd_ceo.do", ROLE_VIEWER, 100),
        ("Dashboards and reports", f"{SCOPE}_cmd_catalog.do", "", 200),
        ("CEO Dashboard settings",
         "sys_properties_list.do?sysparm_query=nameSTARTSWITH" + SCOPE + ".ceo", "admin," + ROLE_ADMIN, 300),
    ]
    for title, url, roles, order in modules:
        mod = one(inst, "sys_app_module", f"title={title}^application={app['sys_id']}", ["sys_id"])
        payload = {"title": title, "application": app["sys_id"], "link_type": "DIRECT",
                   "query": url, "roles": roles, "order": str(order), "active": "true",
                   "window_name": ""}
        if mod:
            inst.update("sys_app_module", mod["sys_id"], payload)
        else:
            inst.insert("sys_app_module", payload)
        back = one(inst, "sys_app_module", f"title={title}^application={app['sys_id']}", ["query", "roles"])
        if not back or back.get("query") != url:
            raise InstanceError(f"module {title} did not store its URL")
        print(f"  ok       sys_app_module           {title:26s} -> {url}")


def password():
    alphabet = string.ascii_letters + string.digits
    core = "".join(secrets.choice(alphabet) for _ in range(14))
    return core + "!9a"


def ensure_personas(inst):
    cred = json.loads(CRED.read_text())
    pw = cred.get("demo_password")
    if not pw:
        pw = password()
        cred["demo_password"] = pw
        CRED.write_text(json.dumps(cred, indent=2))
        print("  wrote    demo_password to credentials.json (gitignored)")
    for user, first, last, roles in PERSONAS:
        u = one(inst, "sys_user", f"user_name={user}", ["sys_id"])
        payload = {"user_name": user, "first_name": first, "last_name": last, "active": "true",
                   "locked_out": "false", "password_needs_reset": "false"}
        if not u:
            payload["user_password"] = pw
            inst.insert("sys_user", payload)
            u = one(inst, "sys_user", f"user_name={user}", ["sys_id"])
            print(f"  created  sys_user                 {user}")
        else:
            payload["user_password"] = pw
            inst.update("sys_user", u["sys_id"], payload)
        # A password written through the Table API is accepted with HTTP 200 and
        # does not work: the login page comes straight back. setDisplayValue on
        # the password2 field is what hashes it, so it is set server-side.
        inst.run_json(
            "var u=new GlideRecord('sys_user'); var out={};"
            "if (u.get('user_name', %s)) { u.setDisplayValue('user_password', %s);"
            " u.setValue('locked_out', false); u.setValue('password_needs_reset', false);"
            " u.setWorkflow(false); u.update(); out.ok = true; }"
            "gs.info('@@' + JSON.stringify(out));" % (json.dumps(user), json.dumps(pw)))
        for r in roles:
            rid = role_id(inst, r)
            if not one(inst, "sys_user_has_role", f"user={u['sys_id']}^role={rid}", ["sys_id"]):
                inst.insert("sys_user_has_role", {"user": u["sys_id"], "role": rid})
            if not one(inst, "sys_user_has_role", f"user={u['sys_id']}^role={rid}", ["sys_id"]):
                raise InstanceError(f"{user} does not hold {r} after granting it")
        print(f"  ok       persona                  {user:16s} {', '.join(roles)}")


def remove_probes(inst):
    for table, key, name in PROBES:
        for row in inst.query(table, f"{key}={name}", ["sys_id"], limit=5):
            inst._call("DELETE", f"/api/now/table/{table}/{row['sys_id']}")
            print(f"  removed  {table:24s} {name}  (build-time probe)")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-users", action="store_true")
    args = ap.parse_args()
    inst = Instance(verbose=False).login()
    print(f"\n  {inst.host}")
    scope_id = inst.use_scope(SCOPE)
    remove_probes(inst)
    ensure_role(inst, ROLE_VIEWER, "Opens the COMMAND CEO Dashboard. Grants no data: every "
                "number on it is counted against the viewer's own access.", scope_id)
    ensure_role(inst, ROLE_ADMIN, "Configures COMMAND Analytics. Contains ceo_viewer.", scope_id)
    ensure_contains(inst, ROLE_ADMIN, ROLE_VIEWER)
    for name, default, desc in PROPERTIES:
        ensure_property(inst, name, default, desc, scope_id)
    ensure_menu(inst, scope_id)
    if not args.no_users:
        inst.use_scope("global")
        ensure_personas(inst)
    inst.use_scope(SCOPE)
    print("\n  done\n")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except InstanceError as e:
        print(f"\n  SETUP ABORTED: {e}\n", file=sys.stderr)
        sys.exit(1)
