#!/usr/bin/env python3
"""COMMAND as a side panel on every Next Experience workspace list.

    python3 product/deploy/workspace.py            create or update, verify by readback
    python3 product/deploy/workspace.py --remove   deactivate the button (nothing deleted)

The employee clicks "Analyse in COMMAND" in a list's header and COMMAND opens
docked beside the list, in the same side-panel slot as the platform's own Data
visualization, analysing that list's rows. Nothing ServiceNow owns is edited:
every record below is NEW and belongs to the x_2185255_command application.

The chain, and the platform mechanism each link uses:

  1 sys_declarative_action_payload_definition   what the button sends. Tokens
       {{table}} {{query}} {{groupBy}} {{sysIds}} are the List model's own
       fields, filled by the platform at click time.
  2 sys_declarative_action_assignment           the header button. List model,
       UXF client action, table=global, all configurable experiences.
  3 sys_ux_addon_event_mapping                  turns the button's event into
       LIST_CTRL#OPEN_PANEL on the List Controller -- a controller-scoped add-on
       mapping, the documented way to add an event handler without editing a
       page. The List Controller's own "Open panel" script then opens the route.
  4 sys_ux_app_route                            the panel route, registered on the
       List Controller's "List Page Panes" viewport extension point -- the same
       extension point Data visualization, Quick edit and Multi edit use.
  5 sys_ux_screen_type + sys_ux_screen          the route's screen.
  6 sys_ux_macroponent (category page)          OUR page: the stock iFrame
       component, used unmodified, with src/title bound to the route's fields.

Why 6 is our own page and never the stock component directly: a sys_ux_screen
renames the macroponent it points at to its own name. Pointing a screen at the
stock iFrame on 2026-09-23 renamed ServiceNow's component (restored from its
shipped version the same day, doc 24 section 10). So every deploy ends by
checking that component is exactly as shipped, and aborts loudly if it is not.

Retired: the earlier header button that opened COMMAND in a centred modal
(x_2185255_command_analyse, a client-script action). The side panel replaces it;
the record is deactivated, not deleted, so its history stays.
"""

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from snclient import Instance, InstanceError  # noqa: E402

SCOPE = "x_2185255_command"

LIST_MODEL = "c3547169534723003eddddeeff7b126c"      # declarative action model "List"
LIST_CONTROLLER = "5865e308432021105571609dc7b8f23b"  # sys_ux_controller "List Controller"
LIST_HEADER = "b685c9c6773ab64a2c11c88564fc9f62"      # macroponent "Record List Header"
OPEN_PANEL = "0fcd1e0c43ab21106760319a6bb8f28a"       # sys_ux_event LIST_CTRL#OPEN_PANEL
LIST_PANES = "4d9e0c2143efa11041505119ebb8f270"       # extension point "List Page Panes"
SHELL = "76a83a645b122010b913030a1d81c780"            # "UXR Base Experience Shell"
STOCK_IFRAME = "2eda8d95aae6d05a26d94fbf692ac6f9"     # ServiceNow's iFrame component
PAGE_BASE = "19be392623033300f4b4c50947bf65ba"        # what a page macroponent extends
GRID_TEMPLATE = "5832fd4d53c31010e6bcddeeff7b12db"

ROUTE = "x-2185255-command-analytics"
ACTION_KEY = "X_2185255_COMMAND#OPEN_PANEL"
FRAME = "/x_2185255_command_cmd_frame.do"
SRC = (FRAME + "?ws=1&embed=1&panel=1&table={{table}}&wq={{query}}"
       "&wgroup={{groupBy}}&wsel={{sysIds}}")

RETIRED_ACTIONS = ["x_2185255_command_analyse"]


def upsert(inst, table, key, keyval, payload):
    """Create or update one of OUR records, then prove it is in our scope."""
    q = f"{key}={keyval}^sys_scope={inst.scope_id}"
    ex = inst.get_one(table, q, ["sys_id"])
    if ex:
        inst.update(table, ex["sys_id"], payload)
        sid, act = ex["sys_id"], "updated"
    else:
        body = dict(payload)
        body[key] = keyval
        sid, act = inst.insert(table, body).get("sys_id"), "created"
    back = inst.get_one(table, f"sys_id={sid}", ["sys_scope"] + [k for k in payload][:6])
    if not back or back.get("sys_scope") != inst.scope_id:
        raise InstanceError(f"{table} {keyval}: not stored in {SCOPE}")
    for k, v in payload.items():
        if k in back and isinstance(v, str) and not v.startswith(("[", "{")) and back[k] != v:
            raise InstanceError(f"{table} {keyval}: {k} stored as {back[k]!r}, sent {v!r}")
    print(f"  {act:8s} {table:44s} {keyval[:40]}")
    return sid


def stock_iframe_state(inst):
    return inst.get_one("sys_ux_macroponent", f"sys_id={STOCK_IFRAME}",
                        ["name", "sys_mod_count", "sys_updated_on"])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--remove", action="store_true")
    ap.add_argument("--credentials", default=None)
    args = ap.parse_args()

    inst = Instance(args.credentials).login()
    inst.use_scope(SCOPE)
    iframe_before = stock_iframe_state(inst)
    if iframe_before.get("name") != "iFrame":
        raise InstanceError("ServiceNow's iFrame component is not as shipped "
                            f"({iframe_before}); fix that before deploying anything.")

    bind = lambda n: {"type": "CONTEXT_BINDING", "binding": {"address": [n], "category": "props"}}
    lit = lambda v: {"type": "JSON_LITERAL", "value": v}

    page = upsert(inst, "sys_ux_macroponent", "name", "COMMAND Analytics panel page", {
        "category": "page", "extends": PAGE_BASE, "schema_version": "1.0.0", "data": "[]",
        "internal_event_mappings": "{}", "form_factors": "{}", "disable_auto_reflow": "false",
        "props": json.dumps([
            {"id": "src", "name": "src", "label": "Source", "fieldType": "string",
             "description": "COMMAND page address, from the route"},
            {"id": "title", "name": "title", "label": "Title", "fieldType": "string",
             "description": ""}]),
        "composition": json.dumps([{
            "definition": {"id": STOCK_IFRAME, "type": "MACROPONENT"},
            "elementId": "command_frame", "elementLabel": "COMMAND frame",
            "eventMappings": [], "isHidden": lit(None), "preset": None, "slot": None,
            "propertyValues": {"src": bind("src"), "title": bind("title"),
                               "width": lit("100%"), "height": lit("100%"),
                               "disableSandbox": lit(True), "allowTopNavigation": lit(False)},
            "styles": {"height": "100%", "width": "100%", "min-height": "100%"}}]),
        "layout": json.dumps({"default": {
            "children": None, "items": [{"element_id": "command_frame"}], "root": None,
            "rules": None, "templateId": GRID_TEMPLATE, "type": "grid",
            "styles": {"display": "grid", "grid-template-columns": "1fr",
                       "grid-template-rows": "1fr", "align-items": "stretch",
                       "height": "100%", "min-height": "100%", "width": "100%"}},
            "version": "3.1.0"}),
    })

    stype = upsert(inst, "sys_ux_screen_type", "name", "COMMAND Analytics panel", {})
    upsert(inst, "sys_ux_screen", "name", "COMMAND Analytics panel", {
        "screen_type": stype, "macroponent": page, "active": "true", "order": "0",
        "macroponent_config": json.dumps({"src": lit(""), "title": lit("COMMAND Analytics")}),
    })
    upsert(inst, "sys_ux_app_route", "route_type", ROUTE, {
        "name": "COMMAND Analytics", "parent_macroponent": SHELL, "screen_type": stype,
        "fields": "src,title", "optional_parameters": "", "extension_point": LIST_PANES,
    })
    pd = upsert(inst, "sys_declarative_action_payload_definition", "action_key", ACTION_KEY, {
        "label": "COMMAND Analytics side panel", "applicable_to": LIST_MODEL,
        "payload_template": json.dumps({"src": SRC, "title": "COMMAND Analytics"}),
    })
    da = upsert(inst, "sys_declarative_action_assignment", "action_name", "x_2185255_command_panel", {
        "label": "Analyse in COMMAND", "model": LIST_MODEL, "table": "global",
        "declarative_action_type": "uxf_client_action", "client_action": pd,
        "active": "false" if args.remove else "true", "enabled": "true",
        "enable_for_all_experiences": "true", "record_selection_required": "false",
        "button_type": "secondary", "order": "50",
        "tooltip": "Analyse this list in COMMAND, beside the list. Group the list by a "
                   "column, or tick a row, and COMMAND opens straight on it.",
    })
    upsert(inst, "sys_ux_addon_event_mapping", "name", "X_2185255_COMMAND open side panel", {
        "source_component": LIST_HEADER, "controller": LIST_CONTROLLER, "source_da": da,
        "target_event": OPEN_PANEL, "active": "true",
        "parent_macroponent": "", "source_element_id": "",
        "target_payload_mapping": json.dumps({"type": "MAP_CONTAINER", "container": {
            "route": lit(ROUTE),
            "fields": {"type": "MAP_CONTAINER", "container": {
                "src": {"type": "EVENT_PAYLOAD_BINDING", "binding": {"address": ["src"]}},
                "title": {"type": "EVENT_PAYLOAD_BINDING", "binding": {"address": ["title"]}}}}}}),
    })

    for name in RETIRED_ACTIONS + ["x_2185255_command_panel_spike"]:
        old = inst.get_one("sys_declarative_action_assignment",
                           f"action_name={name}^sys_scope={inst.scope_id}", ["sys_id", "active"])
        if old and old["active"] == "true":
            inst.update("sys_declarative_action_assignment", old["sys_id"], {"active": "false"})
            print(f"  retired  sys_declarative_action_assignment        {name}")

    iframe_after = stock_iframe_state(inst)
    if iframe_after != iframe_before:
        raise InstanceError(f"ServiceNow's iFrame component changed during this deploy: "
                            f"{iframe_before} -> {iframe_after}. Restore it from its "
                            f"shipped version (doc 24 section 10).")
    print("\n  ServiceNow's iFrame component: unchanged, as shipped")
    print(f"  'Analyse in COMMAND' {'removed' if args.remove else 'opens COMMAND as a side panel'}"
          f" on every workspace list\n")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except InstanceError as e:
        print(f"\n  WORKSPACE DEPLOY ABORTED: {e}\n", file=sys.stderr)
        sys.exit(1)
