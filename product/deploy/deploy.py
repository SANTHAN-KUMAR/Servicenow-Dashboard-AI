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
    "CmdCatalog.js",
    "CmdPayload.js",
]

UI_SCRIPTS = [
    "cmd_fonts.js",
    "cmd_render.js",
]

UI_PAGES = [
    "cmd_catalog.xhtml",
    "cmd_dashboard.xhtml",
]

# Shared stylesheet, substituted into both pages. Kept in one file so the two
# surfaces cannot drift apart visually, and inlined rather than served as an asset
# so the page has no second request to make.
SHARED_CSS = "cmd.css"


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
        out.append((name, src, content_hash(src)))
    return out


def build_pages(script_hashes):
    """Substitutes asset hashes into each page, then validates the result."""
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
        for name, h in script_hashes.items():
            html = html.replace(f"@@{name.upper()}_V@@", h)
        left = re.findall(r"@@[A-Z_]+@@", html)
        if left:
            raise InstanceError(f"{p.name}: unsubstituted placeholders {set(left)}")
        validate_page(p.name, html)
        out.append((p.stem, html))
    return out


# ── main ────────────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true",
                    help="build and validate, write nothing")
    ap.add_argument("--only", choices=["si", "ui", "pages"], default=None)
    ap.add_argument("--credentials", default=None)
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
    pages = build_pages({n: h for n, _, h in scripts})

    print(f"  validated {len(includes)} script includes, {len(scripts)} ui scripts, "
          f"{len(pages)} pages")

    if args.dry_run:
        for n, s in includes:
            print(f"    si    {n:20s} {len(s):>8,}b")
        for n, s, h in scripts:
            print(f"    uis   {n:20s} {len(s):>8,}b  v={h}")
        for n, s in pages:
            print(f"    page  {n:20s} {len(s):>8,}b")
        print("\n  dry run, nothing written\n")
        return 0

    inst = Instance(args.credentials).login()
    print()

    if args.only in (None, "si"):
        for name, src in includes:
            inst.upsert_verified(
                "sys_script_include", "name", name,
                {"script": src, "api_name": f"global.{name}",
                 "client_callable": "false", "active": "true",
                 "access": "public", "sys_scope": GLOBAL_SCOPE,
                 "description": f"COMMAND dashboards. See product/script-includes/{name}.js"},
                verify_field="script")

    if args.only in (None, "ui"):
        for name, src, h in scripts:
            inst.upsert_verified(
                "sys_ui_script", "name", name,
                {"script": src, "active": "true", "sys_scope": GLOBAL_SCOPE,
                 "description": f"COMMAND dashboards client asset. content hash {h}"},
                verify_field="script")

    if args.only in (None, "pages"):
        for name, html in pages:
            inst.upsert_verified(
                "sys_ui_page", "name", name,
                {"html": html, "category": "general", "direct": "false",
                 "sys_scope": GLOBAL_SCOPE,
                 "description": "COMMAND dashboards surface"},
                verify_field="html")

    print(f"\n  all writes verified by readback")
    print(f"  catalog:   https://{inst.host}/cmd_catalog.do")
    print(f"  dashboard: https://{inst.host}/cmd_dashboard.do\n")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except InstanceError as e:
        print(f"\n  DEPLOY ABORTED: {e}\n", file=sys.stderr)
        sys.exit(1)
