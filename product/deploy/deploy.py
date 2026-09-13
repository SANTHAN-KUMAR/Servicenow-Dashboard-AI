#!/usr/bin/env python3
"""Deploy the COMMAND dashboard product to a ServiceNow instance.

    python3 product/deploy/deploy.py            deploy everything, verify each write
    python3 product/deploy/deploy.py --dry-run  build and validate, write nothing
    python3 product/deploy/deploy.py --only ui  deploy one group

Three things this does that a plain Table API push does not.

**It validates before it writes.** Two failure modes on this platform are silent
and both answer HTTP 200 with a zero-byte page: a UI Page whose Jelly does not
parse, and a UI Page with an inline `<script>` body, because Jelly evaluates
script bodies and a CDATA-wrapped one blanks the entire page. Both are checked
here and both abort the deploy rather than reaching the instance.

**It content-hashes client assets.** `.jsdbx` UI Scripts are cached hard by the
platform, so a correct deploy of a changed script still serves the old one. Every
UI Script gets its hash in the URL the page requests.

**It verifies by readback.** Covered in snclient.upsert_verified: the status code
is not consulted, the record is read back and compared.
"""

import argparse
import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from snclient import Instance, InstanceError, content_hash  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]      # product/
SI = ROOT / "script-includes"
UIS = ROOT / "ui-scripts"
UIP = ROOT / "ui-pages"

GLOBAL_SCOPE = "global"

# Order matters: a Script Include that calls another must not be the first to
# land, or a page load between the two writes sees a half-deployed system.
SCRIPT_INCLUDES = [
    "CmdForm.js",
    "CmdMeta.js",
    "CmdData.js",
    "CmdDrill.js",
    "CmdAnalysis.js",
    "CmdCatalog.js",
    "CmdCeo.js",
    "CmdPayload.js",
    "CmdReport.js",
    "CmdCeoBoard.js",
    "CmdCeoAjax.js",
]

# Script Includes the browser calls through GlideAjax. Everything else stays
# server-only: a client-callable include is reachable by anyone who can post to
# xmlhttp.do, so the flag is granted by name, never by default, and the include
# checks the role itself.
CLIENT_CALLABLE = {"CmdCeoAjax"}

# Order is load order, and it matters: the theme must be on the root element
# before the stylesheet can apply it, or the page paints light and repaints dark.
# cmd_ceo comes after cmd_render because it draws with the renderer's kit.
UI_SCRIPTS = [
    "cmd_theme.js",
    "cmd_fonts.js",
    "cmd_render.js",
    "cmd_ceo.js",
]

UI_PAGES = [
    "cmd_catalog.xhtml",
    "cmd_dashboard.xhtml",
    "cmd_ceo.xhtml",
]

# Shared stylesheet, substituted into every page. Kept in one file so the
# surfaces cannot drift apart visually, and inlined rather than served as an asset
# so the page has no second request to make.
SHARED_CSS = "cmd.css"

# The CEO page's own styles, inlined only into the page that uses them, so the
# catalog and the dashboard do not carry the weight of an orbit they never draw.
PAGE_CSS = {"@@CEO_CSS@@": "cmd_ceo.css"}

# sys_ui_script.name is the API Name and is capped at 40 characters. In a scoped
# application it is computed as `<scope>.<script_name>`, so the scope prefix eats
# into the same 40 -- and the platform truncates rather than refusing.
#
# That is not a tidiness problem. `x_2185255_command.cmd_render_d5209a624137` is
# 41 characters, was stored as 40, and the page went on asking for the name it
# actually wrote: the dashboard served HTTP 200 with its renderer 404ing, which is
# a blank page with nothing in any log. The two smaller assets fitted, so two of
# three worked and the failure looked like something wrong with cmd_render.
#
# So the hash is short enough to fit the longest name under the longest scope, and
# ASSET_NAME_MAX is enforced at build time rather than trusted.
ASSET_NAME_MAX = 40
ASSET_HASH_LEN = 8


# ── validation ──────────────────────────────────────────────────────────────

def validate_page(name, html):
    """The two ways a UI Page serves as zero bytes, both silent, both HTTP 200."""
    try:
        root = ET.fromstring(html)
    except ET.ParseError as e:
        raise InstanceError(
            f"{name}: Jelly does not parse, so this would deploy as a blank "
            f"page: {e}"
        )

    for el in root.iter():
        tag = el.tag.split("}")[-1]
        if tag == "script" and (el.text or "").strip():
            raise InstanceError(
                f"{name}: a <script> element has an inline body. Jelly evaluates "
                f"script bodies and serves the whole page as 0 bytes when one is "
                f"wrapped in CDATA. Move it to a UI Script and load it by src."
            )

    # An undefined XML entity is the other way to blank a Jelly page, and it
    # parses fine as XML only because the parser resolves the five built-ins.
    for ent in re.findall(r"&([a-zA-Z][a-zA-Z0-9]*);", html):
        if ent not in ("amp", "lt", "gt", "quot", "apos"):
            raise InstanceError(
                f"{name}: undefined XML entity &{ent};. Jelly will fail to parse "
                f"this and serve a blank page. Use a numeric reference instead."
            )
    return True


def validate_script(name, src):
    """Rhino is ES5. The common ES6 slips fail at runtime, not at deploy."""
    problems = []
    for pat, why in (
        (r"(?<![\w$])(?:let|const)\s+[\w$]", "let/const"),
        (r"=>", "arrow function"),
        (r"`", "template literal"),
        (r"\bclass\s+[A-Z]", "class declaration"),
        (r"\.\.\.", "spread/rest"),
        (r"\bObject\.assign\b", "Object.assign"),
        (r"\bArray\.from\b", "Array.from"),
        (r"\.includes\(", "String/Array.includes"),
        (r"\bfor\s*\(\s*(?:var\s+)?[\w$]+\s+of\s", "for...of"),
        # Rhino keeps a longer reserved-word list than modern engines, and a
        # collision is a compile error rather than a runtime one: the whole
        # Script Include fails to load and every caller reports it as "not
        # defined", which points at the caller rather than at the cause.
        # `var native = ...` cost a deploy round to find.
        (r"(?<![\w$.])(?:native|goto|char|final|byte|synchronized|transient|"
         r"volatile|abstract|implements|interface|package|private|protected|"
         r"public|static|enum|export|import|super)\s*(?:=[^=]|;|\))", "Rhino reserved word"),
    ):
        # Strip comments and strings first, so prose about arrow functions in a
        # docblock does not fail the deploy.
        stripped = strip_comments_and_strings(src)
        if re.search(pat, stripped):
            problems.append(why)
    if problems:
        raise InstanceError(
            f"{name}: uses ES6+ features Rhino does not support: "
            f"{', '.join(sorted(set(problems)))}"
        )
    return True


def verify_compiles(inst, names):
    """Instantiate every deployed Script Include on the instance.

    A readback proves the bytes landed. It does not prove the script loads: a
    Rhino compile error leaves the record byte-perfect and the class undefined,
    and the first symptom is an unrelated caller reporting "X is not defined".
    `var native = ...` shipped that way and the readback said ok.

    So the deploy ends by asking the instance to construct each class. This runs
    in the same engine that will run them in production, which is the only
    authority worth asking.
    """
    js = ["var out = {};"]
    for n in names:
        js.append(
            "try { new %s(); out['%s'] = 'ok'; } "
            "catch (e) { out['%s'] = String(e).substring(0, 160); }" % (n, n, n)
        )
    # gs.info and JSON.stringify, not gs.print and new JSON(): `print` is fenced
    # inside a scope, and an es_latest app has the native JSON object, so the
    # legacy encoder is not a function there. Both forms work in global too, so
    # there is one convention rather than a branch.
    js.append("gs.info('@@' + JSON.stringify(out));")

    result = inst.run_json("\n".join(js))
    broken = {k: v for k, v in result.items() if v != "ok"}
    for n in names:
        status = result.get(n, "MISSING")
        print(f"  compile  {n:22s} {status}")
    if broken:
        raise InstanceError(
            "deployed but does not load on the instance: "
            + "; ".join(f"{k}: {v}" for k, v in broken.items())
        )
    return True


def strip_comments_and_strings(src):
    src = re.sub(r"/\*.*?\*/", " ", src, flags=re.S)
    src = re.sub(r"//[^\n]*", " ", src)
    src = re.sub(r"'(?:\\.|[^'\\])*'", "''", src)
    src = re.sub(r'"(?:\\.|[^"\\])*"', '""', src)
    return src


# ── artefact builders ───────────────────────────────────────────────────────

def build_ui_scripts():
    """Returns [(name, source, hash)] for every client asset."""
    out = []
    for fn in UI_SCRIPTS:
        p = UIS / fn
        if not p.exists():
            continue
        src = p.read_text()
        name = p.stem
        validate_script(name, src)
        h = content_hash(src, ASSET_HASH_LEN)
        # The deployed asset name carries the content hash, because that is the
        # only part of a .jsdbx URL the browser cache respects. See the comment in
        # the page templates for the two approaches that failed before this one.
        asset = f"{name}_{h}"
        out.append((name, src, h, asset))
    return out


def check_asset_names(scripts, api_prefix):
    """Refuse a deploy whose asset names the platform would silently truncate.

    The API Name is capped, the platform cuts rather than complains, and the page
    keeps requesting the untruncated name -- so the symptom is a 404 on one asset
    and a dashboard that renders nothing, with no error anywhere. Caught here,
    where the name is still ours.
    """
    for _, _, _, asset in scripts:
        full = api_prefix + asset
        if len(full) > ASSET_NAME_MAX:
            raise InstanceError(
                f"asset name {full!r} is {len(full)} characters and the platform "
                f"stores at most {ASSET_NAME_MAX}, silently truncating the rest. "
                f"The page would then request a name no record has. Shorten "
                f"ASSET_HASH_LEN or the script's filename.")
    return True


def build_pages(script_hashes, api_prefix=""):
    """Substitutes asset hashes into each page, then validates the result.

    `api_prefix` is what a scoped deployment has to put in front of an asset name.
    A UI Script's `name` is not a name: it is the API Name, computed by the
    platform as `<scope>.<script_name>`, and it is what the `.jsdbx` URL resolves
    against. In global the two are the same string, so the distinction never came
    up; in a scope the page must ask for `x_2185255_command.cmd_render_<hash>` and
    asking for `cmd_render_<hash>` gets a 404.
    """
    out = []
    for fn in UI_PAGES:
        p = UIP / fn
        if not p.exists():
            continue
        html = p.read_text()
        css_path = UIP / SHARED_CSS
        if "@@CSS@@" in html:
            if not css_path.exists():
                raise InstanceError(f"{p.name} wants @@CSS@@ but {SHARED_CSS} is missing")
            css = css_path.read_text()
            # A stylesheet is inlined into a Jelly document, so it must not contain
            # anything Jelly or XML will act on.
            for bad, why in (("]]>", "CDATA terminator"),
                             ("${", "Jelly expression"),
                             ("$[", "Jelly expression")):
                if bad in css:
                    raise InstanceError(f"{SHARED_CSS} contains {bad!r} ({why})")
            html = html.replace("@@CSS@@", css)
        for placeholder, fname in PAGE_CSS.items():
            if placeholder not in html:
                continue
            extra_path = UIP / fname
            if not extra_path.exists():
                raise InstanceError(f"{p.name} wants {placeholder} but {fname} is missing")
            extra = extra_path.read_text()
            for bad, why in (("]]>", "CDATA terminator"), ("${", "Jelly expression"),
                             ("$[", "Jelly expression")):
                if bad in extra:
                    raise InstanceError(f"{fname} contains {bad!r} ({why})")
            html = html.replace(placeholder, extra)
        for name, (h, asset) in script_hashes.items():
            html = html.replace(f"@@{name.upper()}_V@@", h)
            html = html.replace(f"@@{name.upper()}_ASSET@@", api_prefix + asset)
        left = re.findall(r"@@[A-Z_]+@@", html)
        if left:
            raise InstanceError(f"{p.name}: unsubstituted placeholders {set(left)}")
        validate_page(p.name, html)
        out.append((p.stem, html))
    return out


def verify_assets_served(inst, scripts, api_prefix):
    """Fetch every asset URL the pages will ask for, and refuse a deploy that
    leaves one unreachable.

    A readback proves the record holds the right bytes. It does not prove the
    platform will serve them at the URL the page requests, and twice now it did
    not: a scoped asset whose API Name was truncated at 40 characters, and a
    global asset whose API Name was left empty because only `script_name` was
    written. Both readbacks passed. Both produced a dashboard that answered
    HTTP 200 with no client JavaScript and nothing in any log.

    So the last thing the deploy does is behave like the browser: ask for each
    `.jsdbx` and insist on a body of roughly the right size. This is the only
    check in the file that tests the platform's routing rather than its storage,
    which is precisely where both failures lived.
    """
    problems = []
    for name, src, h, asset in scripts:
        url = f"/{api_prefix}{asset}.jsdbx"
        try:
            body = inst.fetch(url)
        except Exception as exc:                       # noqa: BLE001
            problems.append(f"{url} -> {exc}")
            continue
        # The platform wraps and may minify, so this is a sanity floor rather
        # than an equality: what it must not be is a 404 body or an empty one.
        if len(body) < max(200, len(src) // 4):
            problems.append(
                f"{url} -> served {len(body):,} bytes for a {len(src):,} byte "
                f"asset, which is not this script")
        else:
            print(f"  serves   {url:52s} {len(body):>9,}b  ok")
    if problems:
        raise InstanceError(
            "deployed, but the pages ask for assets the instance will not serve:\n    "
            + "\n    ".join(problems))
    return True


def prune_assets(inst, current, scope_id=None, api_prefix=""):
    """Removes content-hashed assets that no deployed page references any more.

    Without this the instance accumulates one orphaned UI Script per edit, and a
    reviewer opening sys_ui_script finds a dozen near-identical records with no way
    to tell which one is live. The pages only ever reference the current hashes, so
    anything else is dead weight -- but it is deleted only when it matches the
    product's own naming, never on a broad pattern.
    """
    stems = tuple(Path(fn).stem for fn in UI_SCRIPTS)
    stale = []
    # Matched on script_name, not name. `name` is the API Name and in a scope it
    # is `<scope>.<script_name>`, so a prefix match on "cmd_" finds nothing there
    # -- which is why a scoped instance accumulated 21 copies of three assets
    # before this was noticed.
    #
    # Scoped and global deployments carry the same script_names, so a prune that
    # ignored the scope would delete the other deployment's live assets and take
    # it down with no error anywhere.
    # Either field: records written before script_name was understood carry the
    # asset name in `name` and nothing in `script_name`, and they are exactly the
    # ones that need clearing out.
    scope_clause = f"^sys_scope={scope_id}" if scope_id else "^sys_scope=global"
    seen = {}
    for field in ("script_name", "name"):
        for row in inst.query("sys_ui_script", f"{field}STARTSWITHcmd_{scope_clause}",
                              ["script_name", "name", "sys_id"], limit=500):
            seen[row["sys_id"]] = row
    for row in seen.values():
        name = row.get("script_name") or row.get("name") or ""
        if api_prefix and name.startswith(api_prefix):
            name = name[len(api_prefix):]
        if name in current:
            continue
        for stem in stems:
            if name.startswith(stem + "_") and len(name) > len(stem) + 1:
                stale.append(row)
                break
    for row in stale:
        try:
            inst._call("DELETE", f"/api/now/table/sys_ui_script/{row['sys_id']}")
            print(f"  removed  sys_ui_script          {row['name']}  (superseded)")
        except Exception as exc:                       # noqa: BLE001
            print(f"  NOTE: could not remove {row['name']}: {exc}")


# ── main ────────────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true",
                    help="build and validate, write nothing")
    ap.add_argument("--only", choices=["si", "ui", "pages"], default=None,
                    help="si = script includes; ui = client assets AND the pages "
                         "that carry their hashes, which cannot be separated")
    ap.add_argument("--credentials", default=None)
    ap.add_argument("--scope", default=None,
                    help="deploy into this scoped application (e.g. "
                         "x_2185255_command) instead of global. The app must "
                         "already exist. The global deployment is left alone.")
    args = ap.parse_args()

    print()

    # Build and validate everything before touching the instance, so a broken
    # artefact never lands next to a good one.
    includes = []
    for fn in SCRIPT_INCLUDES:
        p = SI / fn
        if not p.exists():
            print(f"  skip      {fn} (not written yet)")
            continue
        src = p.read_text()
        validate_script(p.stem, src)
        includes.append((p.stem, src))

    scripts = build_ui_scripts()
    # A scoped UI Script is addressed by its API Name, `<scope>.<script_name>`,
    # so the page has to ask for that and not for the bare asset name.
    api_prefix = f"{args.scope}." if args.scope else ""
    check_asset_names(scripts, api_prefix)
    pages = build_pages({n: (h, asset) for n, _, h, asset in scripts}, api_prefix)

    print(f"  validated {len(includes)} script includes, {len(scripts)} ui scripts, "
          f"{len(pages)} pages")

    if args.dry_run:
        for n, s in includes:
            print(f"    si    {n:20s} {len(s):>8,}b")
        for n, s, h, asset in scripts:
            print(f"    uis   {n:20s} {len(s):>8,}b  v={h}")
        for n, s in pages:
            print(f"    page  {n:20s} {len(s):>8,}b")
        print("\n  dry run, nothing written\n")
        return 0

    inst = Instance(args.credentials).login()

    # Scope is a property of the session, not of the payload. use_scope() sets the
    # current application and re-authenticates; without it a write carrying
    # sys_scope=<app> is still created in global and answers 200.
    # Always set it, including back to global: the preference persists on the
    # instance between runs, so "no --scope" has to mean global explicitly.
    scope_id = inst.use_scope(args.scope or "global")
    # Every write is keyed within its own scope so a scoped deploy can never
    # find, and overwrite, the global record of the same name.
    where = f"sys_scope={scope_id}" if scope_id else f"sys_scope={GLOBAL_SCOPE}"
    api_ns = args.scope if args.scope else GLOBAL_SCOPE
    print()

    if args.only in (None, "si"):
        for name, src in includes:
            inst.upsert_verified(
                "sys_script_include", "name", name,
                {"script": src, "api_name": f"{api_ns}.{name}",
                 "client_callable": "true" if name in CLIENT_CALLABLE else "false",
                 "active": "true",
                 "access": "public",
                 "description": f"COMMAND dashboards. See product/script-includes/{name}.js"},
                verify_field="script", match_query=where)

        verify_compiles(inst, [n for n, _ in includes])

    if args.only in (None, "ui"):
        current = set()
        for name, src, h, asset in scripts:
            current.add(asset)
            # Both fields, deliberately. `script_name` is the name; `name` is the
            # API Name the .jsdbx URL resolves against. In a scope the platform
            # computes name as `<scope>.<script_name>` and ignores what we send;
            # in global nothing computes it, so setting only script_name left it
            # empty and every asset 404'd -- the global dashboard lost its client
            # JavaScript the moment the scoped one got it back.
            inst.upsert_verified(
                "sys_ui_script", "script_name", asset,
                {"script": src, "active": "true", "name": api_prefix + asset,
                 "description": f"COMMAND dashboards client asset. content hash {h}"},
                verify_field="script", match_query=where)

    # Pages carry the content hashes of the client assets, so a UI script can
    # never be deployed without them. Separating the two is what let a correct
    # renderer sit on the instance while every browser kept running the old one.
    if args.only in (None, "ui", "pages"):
        for name, html in pages:
            inst.upsert_verified(
                "sys_ui_page", "name", name,
                {"html": html, "category": "general", "direct": "false",
                 "description": "COMMAND dashboards surface"},
                verify_field="html", match_query=where)

    # Pruning old assets happens LAST, after the pages that reference the new
    # ones have already landed. It used to run right after the new scripts were
    # written and before the pages were rewritten, which left a window where the
    # live page still pointed at the asset name this call was about to delete --
    # a dashboard serving HTTP 200 with no client JavaScript at all, no error
    # anywhere. On a healthy instance the window was a few seconds; on one
    # answering as slowly as dev390988 sometimes has, a single write in that gap
    # taking 90 seconds means the dashboard is broken for the full 90 seconds.
    # There is no version of this ordering that is fine to get wrong "just this
    # once" -- flip it back and the window returns immediately.
    if args.only in (None, "ui"):
        verify_assets_served(inst, scripts, api_prefix)
        prune_assets(inst, current, scope_id, api_prefix)

    print(f"\n  all writes verified by readback")
    # A scoped UI Page is not served at <name>.do -- that route resolves global
    # pages only and answers 200 with "Page not found" for a scoped one. The
    # platform serves it at <scope>_<name>.do and records that in the page's
    # `endpoint` field, which is read back here rather than assembled by hand.
    for name, _ in pages:
        row = inst.get_one("sys_ui_page", f"name={name}^{where}", ["endpoint", "name"])
        url = (row.get("endpoint") if row else None) or f"{name}.do"
        print(f"  {name + ':':22s} https://{inst.host}/{url}")
    print()
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except InstanceError as e:
        print(f"\n  DEPLOY ABORTED: {e}\n", file=sys.stderr)
        sys.exit(1)
