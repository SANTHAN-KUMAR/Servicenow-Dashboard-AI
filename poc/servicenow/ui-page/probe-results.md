# UI Page rendering constraints — measured on eypocinst

Every row below was measured by deploying a real `sys_ui_page` record to the
instance and fetching it from a logged-in browser session. None of it is inferred
from documentation. The harness is `scratchpad/probe.py`; each round trip is
about two seconds.

This exists because a UI Page that the platform refuses to render returns
**HTTP 200, `Content-Type: text/html`, and zero bytes** — no error page, no entry
in the system log, nothing in the browser console. There is no signal to debug
from, so the constraints have to be established by bisection.

## Results

| Page body | Served | Verdict |
|---|---:|---|
| `<div>HELLO</div>` | 16 | ✅ baseline |
| `<div>HELLO &#183; WORLD</div>` | 24 | ✅ numeric entities are fine |
| `<style><![CDATA[ .x{color:red} ]]></style>` + div | 49 | ✅ CDATA in `<style>` is fine |
| the real 9 KB `app.css` in `<style><![CDATA[…]]></style>` | 9,095 | ✅ |
| `<script>var x = 1;</script>` | 55 | ✅ served as `<script eval="true">` |
| `<script>` + newlines, no CDATA | 55 | ✅ |
| `<script src="/eyd_echarts.jsdbx"></script>` | 70 | ✅ |
| **`<script><![CDATA[ var x = 1; ]]></script>`** | **0** | ❌ **kills the whole page** |
| `<script type="text/javascript"><![CDATA[…]]></script>` | 0 | ❌ same |
| CDATA script placed *after* the markup | 0 | ❌ position is irrelevant |
| `<g:evaluate>` + `${jvar_x}` interpolation | 31 | ✅ returns live data |
| `<g:evaluate>` result in a `data-` attribute | 51 | ✅ |

## The rule

**Jelly evaluates `<script>` bodies.** The platform rewrites every inline script
to `<script eval="true">`, which means the body is processed, not passed through.
A CDATA-wrapped body cannot be processed, and the failure is not contained to
that element — the entire page renders to nothing.

That leaves no way to inline client code:

- **With CDATA** → whole page serves 0 bytes.
- **Without CDATA** → the body is parsed as XML, so any `<` (`i < len`, `a <= b`)
  breaks the page instead.

So client JavaScript **must** be a UI Script loaded by `src`. This is not a style
preference; it is the only form that works. `build_deploy.py` fails the build if
a `<script>` element has an inline body.

`<style>` has no such constraint — CSS is inlined with CDATA and served intact.

## Two related findings from the same session

**In-session XHR to Scripted REST does not return.** Called from a logged-in
browser, `/api/eyi/ey_ai_dashboard/health` never resolves. The platform's own
`/api/now/table/incident?sysparm_limit=1` behaves identically, with and without
an `X-UserToken` header, so this is not specific to our resource. The same
endpoints answer in 1–5 s over basic auth, and a same-origin `fetch()` for a
static path from the same page returns in ~300 ms, so neither the instance nor
the browser is broadly at fault.

Consequence: the dashboard computes its payload server-side in `<g:evaluate>` and
embeds it base64-encoded on the root element. First paint needs no request.
XHR is refresh-only, with a 30 s timeout so it reports rather than hangs.

**UI Scripts are cached hard.** A redeployed `.jsdbx` does not reach a browser
that already loaded the page; it will run the old code with no error and no
visible clue. The `src` therefore carries a content hash of `app.js`, stamped in
at build time, so the URL changes exactly when the code does.

## What was wrong before this was measured

The blank page was first attributed to `&middot;` — an HTML-only entity that is
undefined in XML. That reasoning was sound and the entity was genuinely invalid,
but it was **not the cause**: row 2 above shows numeric entities render fine, and
the page stayed blank after the entity was corrected. The actual cause was the
CDATA-wrapped `<script>` introduced by the very change that "fixed" the entity.

Diagnosing from the source instead of from the served bytes is what made this
take three attempts. The served response is the evidence; the source is not.
