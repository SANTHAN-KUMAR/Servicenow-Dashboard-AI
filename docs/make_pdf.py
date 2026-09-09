#!/usr/bin/env python3
"""Render a markdown document to PDF in the product's own design language.

    python3 docs/make_pdf.py docs/use-case-2/19-how-it-works-code-traces.md
    python3 docs/make_pdf.py <in.md> --out <out.pdf> --subtitle "..."

Markdown to styled HTML, then headless Chrome to PDF. Chrome rather than a
dedicated engine because it is what is installed here, and because it is the same
renderer the dashboards are designed against -- so the type and the palette in a
document match the type and the palette in the product rather than approximating
them.

The fonts are the product's own, loaded from design/fonts as base64 data URIs so
the PDF is self-contained and needs no network at render time. Same licence
position as the runtime: SIL OFL 1.1, no Reserved Font Name, embedding permitted.
"""

import argparse
import base64
import html as htmllib
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FONTS = ROOT / "design" / "fonts"

CHROME_CANDIDATES = ["google-chrome", "google-chrome-stable", "chromium",
                     "chromium-browser", "chrome"]

# Straight from product/ui-pages/cmd.css, so a document and a dashboard are
# recognisably the same product.
CSS = """
:root{
  --ground:#F7F9FB; --surface:#FFFFFF; --surface-2:#F8FAFC; --surface-3:#EDF0F5;
  --edge:rgba(16,22,32,.10); --edge-2:rgba(16,22,32,.17);
  --ink-1:#10161F; --ink-2:#475364; --ink-3:#6B778A; --ink-4:#99A3B3;
  --c1:#008C9E; --c2:#A5741F; --c4:#C24438;
  --ok:#167C4F; --warn:#8A6410; --crit:#C0272E;
}
@page { size: A4; margin: 17mm 15mm 16mm 15mm; }
* { box-sizing: border-box; }
body{
  margin:0; background:var(--surface); color:var(--ink-1);
  font-family:"Inter Tight",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
  font-size:9.6pt; line-height:1.52; -webkit-font-smoothing:antialiased;
}
h1,h2,h3,h4{ font-family:"Space Grotesk","Inter Tight",sans-serif; font-weight:600;
  color:var(--ink-1); line-height:1.22; margin:0 0 .45em; }
h1{ font-size:21pt; letter-spacing:-.015em; }
h2{ font-size:14pt; letter-spacing:-.01em; margin-top:1.7em;
    padding-bottom:.3em; border-bottom:1.5px solid var(--edge-2); }
h3{ font-size:11.2pt; margin-top:1.35em; color:var(--ink-1); }
h4{ font-size:9.8pt; margin-top:1.1em; color:var(--ink-2); }
h2:first-of-type{ margin-top:1.1em; }
p{ margin:0 0 .72em; }
ul,ol{ margin:0 0 .8em; padding-left:1.25em; }
li{ margin-bottom:.3em; }
li>p{ margin-bottom:.35em; }
a{ color:var(--c1); text-decoration:none; border-bottom:.5px solid rgba(0,140,158,.35); }
strong{ font-weight:600; color:var(--ink-1); }
em{ color:var(--ink-2); }
hr{ border:0; border-top:1px solid var(--edge); margin:1.6em 0; }
code{ font-family:"JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,monospace;
  font-size:.855em; background:var(--surface-3); padding:.1em .34em;
  border-radius:3px; color:var(--ink-1); }
pre{ background:var(--surface-2); border:1px solid var(--edge);
  border-left:2.5px solid var(--c1); border-radius:5px; padding:.75em .9em;
  overflow-x:auto; margin:0 0 .9em; page-break-inside:avoid; }
pre code{ background:none; padding:0; font-size:8.1pt; line-height:1.5;
  color:var(--ink-1); white-space:pre-wrap; word-break:break-word;
  /* JetBrains Mono ligates operators, so `!==` in a quoted source line renders as
     `==` with a struck-through equals and reads as a different operator than the
     one the file contains. In a document whose whole claim is that the code is
     copied verbatim, that is the one place a ligature cannot be allowed. */
  font-variant-ligatures:none; font-feature-settings:"liga" 0, "calt" 0; }
code{ font-variant-ligatures:none; font-feature-settings:"liga" 0, "calt" 0; }
table{ border-collapse:collapse; width:100%; margin:.35em 0 1em;
  font-size:8.7pt; page-break-inside:avoid; }
th{ text-align:left; font-family:"Space Grotesk",sans-serif; font-weight:600;
  font-size:7.7pt; letter-spacing:.045em; text-transform:uppercase;
  color:var(--ink-3); border-bottom:1.5px solid var(--edge-2);
  padding:.42em .6em .38em; vertical-align:bottom; }
td{ padding:.42em .6em; border-bottom:1px solid var(--edge);
  vertical-align:top; color:var(--ink-2); }
td:first-child{ color:var(--ink-1); }
td code{ font-size:.9em; white-space:nowrap; }
blockquote{ margin:0 0 .9em; padding:.55em .9em; background:var(--surface-2);
  border-left:2.5px solid var(--ink-4); color:var(--ink-2); border-radius:0 5px 5px 0; }
blockquote p:last-child{ margin-bottom:0; }
h2,h3,h4{ page-break-after:avoid; }
.cover{ border-bottom:2px solid var(--ink-1); padding-bottom:1.1em; margin-bottom:1.5em; }
.cover .eyebrow{ font-family:"JetBrains Mono",monospace; font-size:7.6pt;
  letter-spacing:.14em; text-transform:uppercase; color:var(--c1); margin-bottom:.7em; }
.cover .sub{ color:var(--ink-2); font-size:10.2pt; margin-top:.5em; }
.cover .meta{ font-family:"JetBrains Mono",monospace; font-size:7.7pt;
  color:var(--ink-3); margin-top:1em; }
"""

# A tighter setting for a document with a stated page budget.
#
# The client asked the "under the hood" brief to be one or two pages, and at the
# default setting it ran to 2.3 -- which is the worst of both, a third page
# holding a paragraph. The alternative was cutting the honesty section or the
# deployment section to make the arithmetic work, and neither is worth losing to
# a leading value. So the type comes down about 7%, the margins about 3mm, and
# nothing about the document changes.
#
# Opt-in, so every document already rendered against the default is unaffected.
DENSE = """
@page { margin: 14mm 14mm 13mm 14mm; }
body{ font-size:8.9pt; line-height:1.43; }
h1{ font-size:19pt; }
h2{ font-size:12.6pt; margin-top:1.35em; }
h3{ font-size:10.4pt; margin-top:1.1em; }
p{ margin:0 0 .6em; }
pre{ padding:.62em .8em; margin:0 0 .72em; }
pre code{ font-size:7.5pt; line-height:1.44; }
table{ font-size:8.2pt; margin:.3em 0 .8em; }
th{ padding:.34em .5em .3em; }
td{ padding:.34em .5em; }
ul,ol{ margin:0 0 .65em; }
li{ margin-bottom:.22em; }
.cover{ padding-bottom:.85em; margin-bottom:1.15em; }
.cover .sub{ font-size:9.6pt; }
.cover .meta{ margin-top:.75em; }
"""


def font_face_rules():
    faces = [("Space Grotesk", 500, "space-grotesk-500-latin.woff2"),
             ("Space Grotesk", 600, "space-grotesk-600-latin.woff2"),
             ("Inter Tight", 400, "inter-tight-400-latin.woff2"),
             ("Inter Tight", 500, "inter-tight-500-latin.woff2"),
             ("Inter Tight", 600, "inter-tight-600-latin.woff2"),
             ("JetBrains Mono", 400, "jetbrains-mono-400-latin.woff2"),
             ("JetBrains Mono", 500, "jetbrains-mono-500-latin.woff2")]
    out = []
    for family, weight, filename in faces:
        path = FONTS / filename
        if not path.exists():
            continue
        b64 = base64.b64encode(path.read_bytes()).decode()
        out.append(
            f'@font-face{{font-family:"{family}";font-style:normal;'
            f'font-weight:{weight};font-display:block;'
            f'src:url(data:font/woff2;base64,{b64}) format("woff2");}}')
    return "\n".join(out)


def find_chrome():
    for name in CHROME_CANDIDATES:
        path = shutil.which(name)
        if path:
            return path
    sys.exit("No Chrome or Chromium on PATH; cannot render a PDF.")


def to_html(md_text, title, subtitle, source_name, dense=False):
    import markdown

    # The first H1 becomes the cover heading rather than being repeated in flow.
    lines = md_text.split("\n")
    heading = title
    if lines and lines[0].startswith("# "):
        heading = lines[0][2:].strip()
        lines = lines[1:]
        while lines and not lines[0].strip():
            lines = lines[1:]
    body_md = "\n".join(lines)

    body = markdown.markdown(
        body_md,
        extensions=["tables", "fenced_code", "sane_lists", "attr_list"])

    # Links between markdown documents mean nothing in a PDF; keep the text.
    body = re.sub(r'<a href="(?!https?:)[^"]*">(.*?)</a>', r"\1", body,
                  flags=re.S)

    cover = f"""
<div class="cover">
  <div class="eyebrow">COMMAND Analytics &middot; ServiceNow</div>
  <h1>{htmllib.escape(heading)}</h1>
  {f'<div class="sub">{htmllib.escape(subtitle)}</div>' if subtitle else ''}
  <div class="meta">{htmllib.escape(source_name)}</div>
</div>"""

    return (f"<!doctype html><html><head><meta charset='utf-8'>"
            f"<title>{htmllib.escape(heading)}</title>"
            f"<style>{font_face_rules()}\n{CSS}\n{DENSE if dense else ''}</style></head>"
            f"<body>{cover}{body}</body></html>")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("source")
    ap.add_argument("--out", default=None)
    ap.add_argument("--subtitle", default="")
    ap.add_argument("--title", default="")
    ap.add_argument("--dense", action="store_true",
                    help="tighter type and margins, for a document with a page budget")
    args = ap.parse_args()

    src = Path(args.source)
    if not src.exists():
        sys.exit(f"no such file: {src}")
    out = Path(args.out) if args.out else src.with_suffix(".pdf")

    html = to_html(src.read_text(encoding="utf-8"),
                   args.title or src.stem, args.subtitle,
                   f"{src.as_posix()}  ·  rendered for review",
                   dense=args.dense)

    chrome = find_chrome()
    with tempfile.TemporaryDirectory() as tmp:
        page = Path(tmp) / "doc.html"
        page.write_text(html, encoding="utf-8")
        cmd = [chrome, "--headless", "--disable-gpu", "--no-sandbox",
               f"--user-data-dir={tmp}/profile",
               "--no-pdf-header-footer",
               f"--print-to-pdf={out.resolve()}",
               "--virtual-time-budget=20000",
               page.resolve().as_uri()]
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=300)

    if not out.exists() or out.stat().st_size == 0:
        sys.exit(f"Chrome produced no PDF.\n{proc.stderr[:900]}")

    print(f"  {out}  {out.stat().st_size:,} bytes")
    return 0


if __name__ == "__main__":
    sys.exit(main())
