#!/usr/bin/env python3
"""Generate the font UI Script from the subsetted woff2 files in design/fonts/.

Run: python3 product/deploy/build_fonts.py

Why a UI Script and not an attachment. A `sys_ui_script` carries text, so the
woff2 has to travel as a base64 data URI inside a stylesheet the script injects.
That is more bytes than a binary attachment would be, and it is worth it: a data
URI cannot become an external request, cannot 404 after an update set is applied
to a different instance, and needs no separate record to promote. The rule this
engagement rests on is that code and fonts travel in and data does not travel out,
and inlining is the only version of that with no moving parts.

Which faces ship, and why not all of them. The approved brand kit uses three
families across ten files, 188 KB. Inlined that is roughly 250 KB of base64, which
against a 250 KB total payload budget is the entire budget spent on type. So the
display face ships at two weights and the mono at one, and body text uses the
platform's own sans. That is roughly a third of the bytes for nearly all of the
visual character, and it is the trade the client chose when it was put to them.
"""

import base64
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
FONTS = ROOT / "design" / "fonts"
OUT = ROOT / "product" / "ui-scripts" / "cmd_fonts.js"

# family, weight, filename. Order is load order.
FACES = [
    ("Space Grotesk", 500, "space-grotesk-500-latin.woff2"),
    ("Space Grotesk", 600, "space-grotesk-600-latin.woff2"),
    ("JetBrains Mono", 500, "jetbrains-mono-500-latin.woff2"),
]

HEADER = '''/**
 * cmd_fonts. Typography for the COMMAND dashboards, inlined.
 *
 * GENERATED FILE. Edit product/deploy/build_fonts.py, not this.
 *
 * Injects @font-face rules whose sources are base64 data URIs, so the page makes
 * no external request for type. Three faces: the display family at two weights and
 * the mono at one. Body text deliberately uses the platform's own sans stack, which
 * is what keeps this affordable against the payload budget.
 *
 * Licensing. Both families are SIL Open Font License 1.1, which permits embedding,
 * subsetting and redistribution inside a larger work, commercially, with no royalty
 * and no per-seat fee. Neither declares a Reserved Font Name, which is what makes
 * subsetting them while keeping the family name compliant. The OFL requires the
 * copyright notice and licence to travel with the font, which is why they are in the
 * comment below rather than in a file somewhere else.
 *
 *   Space Grotesk    Copyright 2020 The Space Grotesk Project Authors
 *   JetBrains Mono   Copyright 2020 The JetBrains Mono Project Authors
 *
 *   Licensed under the SIL Open Font License, Version 1.1. Full text ships with the
 *   application and is reproduced at https://scripts.sil.org/OFL
 *
 * Files are subsetted to basic Latin plus the typographic and geometric marks the
 * product uses. Subsetting is a Modified Version under the OFL and is permitted;
 * the notice above is retained as the licence requires.
 */
(function () {
  'use strict';
  if (document.getElementById('cmd-fonts')) { return; }

  var FACES = [
'''

FOOTER = '''  ];

  var css = [];
  for (var i = 0; i < FACES.length; i++) {
    var f = FACES[i];
    css.push(
      '@font-face{font-family:"' + f.family + '";font-style:normal;' +
      'font-weight:' + f.weight + ';font-display:swap;' +
      'src:url(data:font/woff2;base64,' + f.data + ') format("woff2")}'
    );
  }

  var el = document.createElement('style');
  el.id = 'cmd-fonts';
  el.textContent = css.join('\\n');
  document.head.appendChild(el);
})();
'''


def main():
    if not FONTS.exists():
        print(f"  no fonts at {FONTS}", file=sys.stderr)
        return 1

    rows, total_raw = [], 0
    for family, weight, fn in FACES:
        p = FONTS / fn
        if not p.exists():
            print(f"  missing {p}", file=sys.stderr)
            return 1
        raw = p.read_bytes()
        total_raw += len(raw)
        b64 = base64.b64encode(raw).decode()
        rows.append(
            f'    {{family: "{family}", weight: {weight},\n'
            f'     data: "{b64}"}}'
        )
        print(f"    {fn:34s} {len(raw):>7,}b -> {len(b64):>7,}b base64")

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(HEADER + ",\n".join(rows) + "\n" + FOOTER)
    size = OUT.stat().st_size
    print(f"\n  wrote {OUT.relative_to(ROOT)}")
    print(f"  {len(FACES)} faces, {total_raw:,}b of woff2, {size:,}b of UI Script\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
