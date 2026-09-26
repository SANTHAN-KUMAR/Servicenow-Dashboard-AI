#!/usr/bin/env python3
"""Publish the scoped application to an update set and export it for transfer.

    python3 product/deploy/package.py                 publish and export
    python3 product/deploy/package.py --version 0.2.0 name the release

Produces `product/dist/COMMAND-Analytics-<version>-update-set.xml`, which is what
the client imports: Retrieved Update Sets -> Import Update Set from XML -> Preview
-> Commit.

Why this is not a Table API export of our own records. An update set is the
platform's own transfer format, and building one by hand means deciding which
records constitute the application -- which is exactly the decision the platform
already makes and we would get wrong. So this drives the same two calls the
"Publish to Update Set..." button makes, `createUpdateSet` then
`publishToUpdateSet` on com.snc.apps.AppsAjaxProcessor, waits for the progress
worker they start, and then runs the same UpdateSetExport the "Export to XML"
action runs.

The publish also carries deletions. A set exported after this application's
history contains DELETE entries for records that no longer exist -- the naming
probes, and every superseded content-hashed asset. Those are correct and are
left in: on a target instance that never had them they are a no-op, and removing
them by hand would mean editing a payload the platform generated.

Run deploy.py first. This packages what is on the instance, not what is on disk,
and the difference between those two is the thing readback verification exists to
prevent.
"""

import argparse
import hashlib
import json
import re
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from snclient import Instance, InstanceError  # noqa: E402

SCOPE = "x_2185255_command"
DIST = Path(__file__).resolve().parents[1] / "dist"
PROCESSOR = "com.snc.apps.AppsAjaxProcessor"

# What a complete package must contain. Checked after the publish, because a
# publish that quietly produced an empty set answers exactly like one that worked
# -- the first attempt at this returned an update set sys_id and zero files.
# 0.2.0 adds the CEO Dashboard: CmdCeoBoard and CmdCeoAjax, the cmd_ceo page and
# its cmd_ceo script. Its roles, settings and menu travel too and are listed by
# type in the output; they are not pinned here because their platform type labels
# are the platform's to choose.
# 0.3.0 adds the workspace integration: CmdWorkspace, the cmd_frame page and its
# loader script, and the "Analyse in COMMAND" list action (an Action Assignment).
EXPECTED = {"Script Include": 12, "UI Page": 4, "UI Script": 5, "Custom Application": 1,
            "Action Assignment": 3}
# 0.3.3: the side panel. Three action records -- the live "Analyse in COMMAND"
# panel button, and the retired modal and spike buttons, kept inactive so their
# history travels. The panel's page, screen, route and add-on mapping are
# listed by type in the output.


def ajax(inst, function, **params):
    body = {"sysparm_processor": PROCESSOR, "sysparm_scope": SCOPE,
            "sysparm_function": function}
    body.update(params)
    req = urllib.request.Request(
        f"{inst.base}/xmlhttp.do",
        data=urllib.parse.urlencode(body).encode(), method="POST",
        headers={"Content-Type": "application/x-www-form-urlencoded",
                 "X-UserToken": inst.token, "Accept": "application/xml"})
    with inst._op.open(req, timeout=600) as r:
        return r.read().decode("utf-8", "replace")


def wait_for(inst, worker_id, label, timeout=300):
    waited = 0
    while waited < timeout:
        rows = inst.query("sys_progress_worker", f"sys_id={worker_id}",
                          ["state", "state_code", "message"], limit=1)
        if rows and rows[0].get("state") in ("complete", "error", "cancelled"):
            row = rows[0]
            if row.get("state_code") != "success":
                raise InstanceError(f"{label}: {row.get('message')}")
            return row
        time.sleep(5)
        waited += 5
    raise InstanceError(f"{label}: still running after {timeout}s")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--version", default="0.1.0")
    ap.add_argument("--credentials", default=None)
    args = ap.parse_args()

    name = f"COMMAND Analytics {args.version}"
    inst = Instance(args.credentials, verbose=False).login()

    app = inst.get_one("sys_app", f"scope={SCOPE}", ["sys_id", "name", "version"])
    if not app:
        raise InstanceError(f"no application with scope {SCOPE} on {inst.host}")
    inst.use_scope(SCOPE)
    print(f"\n  packaging {app['name']} from {inst.host}")

    if app.get("version") != args.version:
        inst.update("sys_app", app["sys_id"], {"version": args.version})
        back = inst.get_one("sys_app", f"sys_id={app['sys_id']}", ["version"])
        if back.get("version") != args.version:
            raise InstanceError("set the application version and it did not stick")
        print(f"  version set to {args.version}")

    raw = ajax(inst, "createUpdateSet", sysparm_name=name, sysparm_appid=app["sys_id"],
               sysparm_description=f"{app['name']}, published for transfer.",
               sysparm_current="false")
    m = re.search(r'answer="([0-9a-f]{32})"', raw)
    if not m:
        raise InstanceError(f"createUpdateSet returned no update set: {raw[:300]}")
    update_set = m.group(1)

    raw = ajax(inst, "publishToUpdateSet", sysparm_update_set_id=update_set,
               sysparm_sys_id=app["sys_id"], sysparm_name=name,
               sysparm_version=args.version,
               sysparm_description=f"{app['name']}, published for transfer.",
               sysparm_include_data="false")
    w = re.search(r"<workerid>([0-9a-f]{32})</workerid>", raw)
    if not w:
        raise InstanceError(f"publishToUpdateSet started no worker: {raw[:300]}")
    wait_for(inst, w.group(1), "publish")

    rows = inst.query("sys_update_xml", f"update_set={update_set}",
                      ["type", "action", "target_name"], limit=1000)
    live = {}
    for r in rows:
        if (r.get("action") or "INSERT_OR_UPDATE") == "DELETE":
            continue
        live[r["type"]] = live.get(r["type"], 0) + 1
    print(f"  published {len(rows)} entries, {sum(live.values())} of them live")
    for t in sorted(set(list(EXPECTED) + list(live))):
        got, want = live.get(t, 0), EXPECTED.get(t, 0)
        mark = "ok" if got == want else "## EXPECTED %d" % want
        print(f"    {t:22s} {got:>3}  {mark}")
    missing = {t: (live.get(t, 0), n) for t, n in EXPECTED.items() if live.get(t, 0) != n}
    if missing:
        raise InstanceError(
            "the published set does not contain what this application is made of: "
            + "; ".join(f"{t} {g} not {w}" for t, (g, w) in missing.items()))

    inst.update("sys_update_set", update_set, {"state": "complete"})
    state = inst.get_one("sys_update_set", f"sys_id={update_set}", ["state"])
    if state.get("state") != "complete":
        raise InstanceError("marked the update set complete and it did not stick")

    # Same two steps as the Export to XML action: build the remote record, then
    # download it. Kept rather than deleted on the instance, so a failed download
    # can be retried without republishing.
    result = inst.run_json(
        "var out={};var gr=new GlideRecord('sys_update_set');"
        "if (gr.get('%s')) { out.remoteId=String(new UpdateSetExport()"
        ".exportUpdateSet(gr)); } else { out.err='not found'; }"
        "gs.info('@@'+JSON.stringify(out));" % update_set, scope="global")
    remote = result.get("remoteId")
    if not remote or remote == "null":
        raise InstanceError(f"UpdateSetExport produced nothing: {json.dumps(result)}")

    url = (f"/export_update_set.do?sysparm_sys_id={remote}"
           f"&sysparm_delete_when_done=false&sysparm_is_remote=false"
           f"&sysparm_ck={inst.token}")
    req = urllib.request.Request(f"{inst.base}{url}",
                                 headers={"X-UserToken": inst.token,
                                          "Accept": "application/xml"})
    with inst._op.open(req, timeout=900) as r:
        body = r.read()

    if not body.startswith(b"<?xml"):
        raise InstanceError(
            f"the export is not XML, so something served a page instead of a "
            f"file: {body[:160]!r}")

    DIST.mkdir(exist_ok=True)
    out = DIST / f"COMMAND-Analytics-{args.version}-update-set.xml"
    out.write_bytes(body)
    print(f"\n  {out.relative_to(Path(__file__).resolve().parents[2])}")
    print(f"  {len(body):,} bytes   sha256 {hashlib.sha256(body).hexdigest()}")
    print("\n  Install: Retrieved Update Sets -> Import Update Set from XML -> "
          "Preview -> Commit\n")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except InstanceError as e:
        print(f"\n  PACKAGING ABORTED: {e}\n", file=sys.stderr)
        sys.exit(1)
