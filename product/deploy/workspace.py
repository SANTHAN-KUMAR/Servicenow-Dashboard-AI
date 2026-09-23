#!/usr/bin/env python3
"""Put "Analyse in COMMAND" on every Next Experience workspace list.

    python3 product/deploy/workspace.py            create or update, verify by readback
    python3 product/deploy/workspace.py --remove   deactivate it (nothing is deleted)

What this writes, and why it is the supported route rather than a workaround:

  sys_declarative_action_assignment   one List-model action, implemented as a
                                      Client Script, table = global (every list),
                                      enabled for all configurable experiences.

That is the platform's documented extension point for workspace list headers, and
it is exactly how ServiceNow ships its own cross-product list launcher: the
"Launch Process Mining" action on this instance is a List-model, Client Script,
table-global assignment that reads g_list.getTableName() / g_list.getQuery() and
hands off to a separate analytics experience. Ours does the same and opens the
result in the workspace's own modal (g_modal.showFrame) so the viewer never
leaves the list.

What it deliberately does not do: touch the column-header "Show visualization"
menu or the Data visualization panel. Neither has an extension model -- the menu
item is emitted by the list component and routed by a Service Operations
Workspace page script ("Open data visualization panel", LIST_CTRL#OPEN_PANEL,
route data-visualization), and the panel's chart types are the component's own.
The only way into either is a page variant that replaces a ServiceNow-owned page,
which is taking ownership of core UI. Recorded in doc 24.

Every record is written inside the x_2185255_command scope so it travels in the
application's update set, and is read back and compared rather than trusted.
"""

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from snclient import Instance, InstanceError  # noqa: E402

SCOPE = "x_2185255_command"
ROOT = Path(__file__).resolve().parents[1]
CLIENT_SCRIPT = ROOT / "workspace" / "cmd_workspace_action.js"

LIST_MODEL = "c3547169534723003eddddeeff7b126c"      # sys_declarative_action_model_definition "List"
LABEL = "Analyse in COMMAND"

ACTIONS = [
    {"name": "x_2185255_command_analyse", "selection": "false", "group": "",
     "label": "Analyse in COMMAND",
     "tooltip": "Open this list's records in COMMAND Analytics: dynamic analysis of "
                "exactly these rows, counted against your access. Tick one row to "
                "analyse that record in context, or several to analyse just those."},
]

# Removed on 2026-09-23 and recorded here so it is not re-added: a second,
# row-menu action. The row more-actions menu in Service Operations Workspace is
# built by sn_sow.SOWListTransformSNC, not by declarative actions -- a
# Global-Now-Actions-grouped assignment does not render there -- and the only
# way in is editing SOW's own SOWListTransform. Ticking one row and using the
# header button is the no-modification equivalent.


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--remove", action="store_true",
                    help="deactivate the action; the record is kept so history survives")
    ap.add_argument("--credentials", default=None)
    args = ap.parse_args()

    src = CLIENT_SCRIPT.read_text()
    inst = Instance(args.credentials).login()
    scope_id = inst.use_scope(SCOPE)

    for spec in ACTIONS:
        body = src
        payload = {
            "label": spec["label"],
            "model": LIST_MODEL,
            "table": "global",
            "declarative_action_type": "client_script",
            "client_script": body,
            "active": "false" if args.remove else "true",
            "enabled": "true",
            "enable_for_all_experiences": "true",
            "record_selection_required": spec["selection"],
            "group": spec["group"],
            "button_type": "secondary",
            "order": "50",
            "specificity": "1",
            "tooltip": spec["tooltip"],
            "description": "COMMAND Analytics workspace launcher. "
                           "Source: product/workspace/cmd_workspace_action.js. Deploy: "
                           "product/deploy/workspace.py",
        }
        inst.upsert_verified("sys_declarative_action_assignment", "action_name", spec["name"],
                             payload, verify_field="client_script",
                             match_query=f"sys_scope={scope_id}")
        back = inst.get_one("sys_declarative_action_assignment",
                            f"action_name={spec['name']}^sys_scope={scope_id}",
                            ["active", "model", "table", "declarative_action_type",
                             "enable_for_all_experiences", "sys_scope", "group",
                             "record_selection_required"])
        want = {"active": payload["active"], "model": LIST_MODEL, "table": "global",
                "declarative_action_type": "client_script",
                "enable_for_all_experiences": "true", "sys_scope": scope_id,
                "group": spec["group"], "record_selection_required": spec["selection"]}
        bad = {k: (back.get(k), v) for k, v in want.items() if back.get(k) != v}
        if bad:
            raise InstanceError(f"{spec['name']} stored differently from what was sent: {bad}")
    print(f"\n  {LABEL!r} is {'inactive' if args.remove else 'live'} on every workspace list "
          f"(header)\n")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except InstanceError as e:
        print(f"\n  WORKSPACE DEPLOY ABORTED: {e}\n", file=sys.stderr)
        sys.exit(1)
