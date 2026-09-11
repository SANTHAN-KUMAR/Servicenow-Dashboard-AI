#!/usr/bin/env python3
"""Resolve every file:line reference in a client-facing document.

    python3 docs/verify_citations.py docs/use-case-2/21-under-the-hood-brief.md

The under-the-hood brief ships alongside the source and tells the client that any
reference in it can be opened and checked. That promise is worth making only if it
is enforced, because line numbers drift every time the code is touched -- and a
document that points a client at the wrong line is worse than one that gives no
line at all, especially where the point being made is about honesty.

So this resolves every `File.ext:NNN` in the document, in code blocks and in
running prose alike, and prints the line it lands on for review. It fails on a
reference outside the file, on a quoted line that is not verbatim, on a quoted
line that is not where it says it is, and on a wrong line count in the file table.

Indentation is not compared: snippets are dedented to fit the printed column.
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

WHERE = {
    "CmdData.js": "product/script-includes/CmdData.js",
    "CmdForm.js": "product/script-includes/CmdForm.js",
    "CmdDrill.js": "product/script-includes/CmdDrill.js",
    "CmdMeta.js": "product/script-includes/CmdMeta.js",
    "CmdPayload.js": "product/script-includes/CmdPayload.js",
    "CmdCatalog.js": "product/script-includes/CmdCatalog.js",
    "CmdCeo.js": "product/script-includes/CmdCeo.js",
    "CmdReport.js": "product/script-includes/CmdReport.js",
    "CmdAnalysis.js": "product/script-includes/CmdAnalysis.js",
    "cmd_render.js": "product/ui-scripts/cmd_render.js",
    "cmd_fonts.js": "product/ui-scripts/cmd_fonts.js",
    "cmd.css": "product/ui-pages/cmd.css",
    "cmd_dashboard.xhtml": "product/ui-pages/cmd_dashboard.xhtml",
    "cmd_catalog.xhtml": "product/ui-pages/cmd_catalog.xhtml",
    "deploy.py": "product/deploy/deploy.py",
    "snclient.py": "product/deploy/snclient.py",
    "test_drill_gates.js": "product/tests/test_drill_gates.js",
    "probe-results.md": "poc/servicenow/ui-page/probe-results.md",
}


def main():
    doc_path = Path(sys.argv[1]) if len(sys.argv) > 1 else \
        ROOT / "docs/use-case-2/21-under-the-hood-brief.md"
    doc = doc_path.read_text()

    lines, src, bad = {}, {}, 0
    for k, v in WHERE.items():
        p = ROOT / v
        if not p.exists():
            print(f"  MISSING FILE: {v}")
            return 1
        src[k] = p.read_text()
        lines[k] = src[k].splitlines()

    names = "|".join(re.escape(k) for k in WHERE)

    # ── every reference resolves ────────────────────────────────────────────
    print("REFERENCES\n")
    tok = re.compile(rf"(?:({names}):(\d+))|(?:`?:(\d+)`?)")
    current, seen, shown = None, [], set()
    for m in tok.finditer(doc):
        if m.group(1):
            current, ln = m.group(1), int(m.group(2))
        elif current and m.group(3):
            ln = int(m.group(3))
        else:
            continue
        seen.append((current, ln))
    for f, ln in seen:
        if (f, ln) in shown:
            continue
        shown.add((f, ln))
        if ln < 1 or ln > len(lines[f]):
            print(f"  OUT OF RANGE  {f}:{ln}  (file has {len(lines[f])} lines)")
            bad += 1
            continue
        print(f"  {f}:{ln:<5} {lines[f][ln - 1].strip()[:82]}")

    # ── quoted code is verbatim, and where it says ─────────────────────────
    cite = re.compile(rf"\s*(?://|#)\s*(?:(?:{names}))?:?(\d+)\s*$")
    print("\nQUOTED LINES")
    checked = 0
    for block in re.findall(r"```(?:js|python)\n(.*?)```", doc, re.S):
        found = re.findall(rf"({names}):(\d+)", block)
        if not found:
            continue
        cur = found[0][0]
        for raw in block.splitlines():
            if not raw.strip():
                continue
            m = re.search(rf"({names}):(\d+)", raw)
            want = None
            if m:
                cur, want = m.group(1), int(m.group(2))
            else:
                m2 = re.search(r"(?://|#)\s*:(\d+)\s*$", raw)
                if m2:
                    want = int(m2.group(1))
            st = cite.sub("", raw).strip()
            if not st or st.startswith("//") or st.startswith("#"):
                continue
            checked += 1
            if st not in src[cur]:
                print(f"  NOT VERBATIM in {cur}: {st[:70]}")
                bad += 1
                continue
            if want is not None and lines[cur][want - 1].strip() != st:
                print(f"  WRONG LINE {cur}:{want}")
                print(f"      doc:  {st[:68]}")
                print(f"      file: {lines[cur][want - 1].strip()[:68]}")
                bad += 1
    print(f"  {checked} quoted lines checked")

    # ── the file table's line counts ───────────────────────────────────────
    print("\nLINE COUNTS CLAIMED IN THE TABLE")
    for m in re.finditer(r"^\| `([^`]+)`(?:, `([^`]+)`)? \| ([\d,]+) \|", doc, re.M):
        files = [m.group(1)] + ([m.group(2)] if m.group(2) else [])
        # Other tables in the document also have a backticked first column and a
        # number -- the permission-check table names tables, not files. Only rows
        # naming files this script knows about are line counts.
        if not all(f in lines for f in files):
            continue
        claimed = int(m.group(3).replace(",", ""))
        actual = sum(len(lines[f]) for f in files if f in lines)
        okish = abs(actual - claimed) <= max(50, claimed * 0.03)
        print(f"  {'+'.join(files):42s} claimed {claimed:>6,}  actual {actual:>6,}"
              f"  {'ok' if okish else 'OFF'}")
        if not okish:
            bad += 1

    print(f"\n  {bad} problem(s)")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
