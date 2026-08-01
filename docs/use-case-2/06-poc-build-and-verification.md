# Use Case 2 — build record and verification

**Read doc 07 first.** It corrects the scope: the product is a permission-scoped
**catalog** of dashboards, and this build is a **single hard-coded page**. What
follows is an accurate record of a rendering-and-correctness spike, not a
description of the deliverable.

Instance `eypocinst.service-now.com` (Zurich,
`glide-zurich-07-01-2025__patch10-hotfix3-07-01-2026`), user `ey_Kumar`.
Everything below was measured on that instance on 2026-08-01.
Live page: <https://eypocinst.service-now.com/ey_ai_dashboard.do>

---

## 1. What the spike proves

| Question | Answer | Evidence |
|---|---|---|
| Can a real charting library run natively inside ServiceNow, no CDN? | **Yes** | ECharts 5.5.1 (Apache-2.0) served from the instance as a UI Script; 6 chart canvases render |
| Can we compute ACL-correct aggregates? | **Yes, and the gap is real** | `GlideAggregate` vs `GlideRecordSecure` cross-check runs on every load |
| Does it work on real data? | **Yes** | 13,986 incidents, not seed data |
| Does the visual bar reach Power BI? | **No — now a redesign task** | Client's assessment: reads as generic output. Assigned to a design agent (doc 07 §6) |
| Does in-page AI work? | **No** | Now Assist has no active provider for free-form analysis here; the BYO-key path is built but unverified |

## 2. Verified live

**Data.** `/overview` returns 13,986 incidents for `Kumar G`: 13,943 active, 922
P1, 11,181 unassigned-and-active, MTTR from a 2,000-record sample. 1.9 s over
basic auth.

**Rendering.** Loaded in an authenticated headless Chrome session driving the real
instance: **6 chart canvases, 0 JavaScript errors**, 23,968 bytes of DOM.

**Colour.** The categorical/ordinal palette was run through the dataviz validator
for CVD separation and contrast in both light and dark, not eyeballed. Light
`#2a78d6 / #eb6834 / #1baf7a`; dark `#3987e5 / #d95926 / #199e70`.

**ACL correctness.** `GlideAggregate` = 13,986, ACL-filtered = 13,986, delta 0 for
this viewer — because `ey_Kumar` can read everything. The check is real and runs;
**it has not yet caught a leak on this instance** because no restricted persona
exists. To demonstrate one, create a role-less user plus an incident read ACL and
the panel flips to a red "Leak detected" pill. Previously measured on dev390988:
a role-less user gets `GlideAggregate` = 67 where `GlideRecordSecure` returns 0.

**MCP.** Full stdio round trip verified — `initialize`, `tools/list`,
`tools/call`. `change_request` grouped by state returns New 96 / Authorize 78 /
Closed 48. It is a **local Node process** talking to the instance over HTTPS;
nothing about it runs on the platform. Parked by the client for now.

## 3. Three platform constraints found the hard way

Full measurements in `poc/servicenow/ui-page/probe-results.md`.

**Jelly evaluates `<script>` bodies.** A CDATA-wrapped inline script makes the
platform serve the **entire page as zero bytes** — HTTP 200, no error, no log
entry. Without CDATA, any `<` in the code breaks the XML parse instead. Client
JavaScript therefore **must** be a UI Script loaded by `src`. `<style>` with CDATA
is unaffected, so the stylesheet stays inline.

**In-session XHR to Scripted REST does not return.** From a logged-in browser,
`/api/eyi/ey_ai_dashboard/health` never resolves — and neither does the
platform's own Table API, with or without `X-UserToken`. The same calls answer in
1–5 s over basic auth, and a static same-origin `fetch()` returns in ~300 ms, so
neither the instance nor the browser is broadly at fault. **The page therefore
computes its payload server-side via `<g:evaluate>` and embeds it base64 on the
root element.** First paint needs no request; XHR is refresh-only with a 30 s
timeout.

*Significant for doc 07: do not design the catalog or the per-dashboard surface
around client-side data fetching on this instance until the cause is understood.*

**UI Scripts are cached hard.** A redeploy does not reach a browser that already
loaded the page — it silently runs old code. The `src` carries a content hash of
`app.js`, stamped in at build time.

## 4. The AI layer — what is and is not true

**Now Assist cannot produce free-form analysis here.** `Summarize` and
`Generic Prompt` are permission-blocked for `ey_Kumar`. `Analytics insight
generation`, `Analytics hidden insight`, `Analytics follow up` and
`Insights — Merge Aggregation` all have **zero active provider definitions**. The
only capability both active and permitted is `Analytics query generation`, a
query generator whose system prompt fights this use case — asked for analysis it
replied *"I can't provide hidden chain-of-thought or internal analysis."*

**A bring-your-own-key path is built but unverified.** `POST /aiconfig` takes an
Anthropic key, validates it with a live 1-token call, and persists it only if the
provider answers — stored in `ey.ai.dashboard.anthropic_key`, type `password2`
(encrypted, admin-read). `GET /aiconfig` reports status and probes whether the
instance can reach `api.anthropic.com` at all. **Neither has been run:** no key
was available and outbound egress is unconfirmed. Treat the in-page AI button as
non-functional until both are tested.

Three ways to close it: grant `one_extend_admin` and activate a provider
definition; supply an Anthropic key and confirm egress; or use the MCP path,
where the chat model does the analysis and no key is configured anywhere.

## 5. Deployed records

| Artifact | sys_id |
|---|---|
| UI Page `ey_ai_dashboard` | `27cc1e7333928390c63690834d5c7bd8` |
| UI Script `eyd_app` (client code) | managed by `build_deploy.py` |
| UI Script `eyd_echarts` (ECharts 5.5.1) | `4df18fff3352c390c63690834d5c7b37` |
| Script Include `EYAIDashPayload` (server-side payload) | `afdc4377c3d64390c9efffba05013113` |
| Script Include `EYAIDashData` | `dcfe5e7f33928390c63690834d5c7b1d` |
| Script Include `EYAIDashAI` | `c32f9a3fc3920390c9efffba05013151` |
| REST definition `/api/eyi/ey_ai_dashboard` | `c47f9e3333d28390c63690834d5c7b74` |
| op `/overview` | `2a70ae3b33d28390c63690834d5c7b47` |
| op `/aclproof` | `3880a27b33d28390c63690834d5c7b34` |
| op `/insights` | `76f0aebb33d28390c63690834d5c7b78` |
| op `/health` | `f211267f33d28390c63690834d5c7bc7` |
| op `/aiconfig` GET / POST | `1c24077f3392c390c63690834d5c7b2d` / `8124477f3392c390c63690834d5c7bde` |
| op `/rendercheck` (**diagnostic — delete**) | `c5644b3333d2c390c63690834d5c7b28` |
| property `ey.ai.dashboard.anthropic_key` | `1be3cb773392c390c63690834d5c7bf6` |
| ECharts attachment (fallback copy) | `c8dc5e7333928390c63690834d5c7b6d` |
| UI Page `eyd_probe` (**diagnostic — delete**) | created by `probe.py` |

Two records are diagnostics and must be removed before any client-facing use:
`/rendercheck` and the `eyd_probe` page. `/rendercheck` is also **unreliable** —
it reports 0 rendered bytes for healthy OOB pages too, so its output means
nothing. It is listed so it gets deleted, not so it gets used.

## 6. How to build and deploy

```
python3 poc/servicenow/ui-page/build_deploy.py <netrc-file>
```

Assembles the page, XML-validates it, **rejects any inline `<script>` body**,
deploys `app.js` as UI Script `eyd_app`, deploys the page, then **reads both
records back and compares byte for byte**. A silent no-op write fails loudly.

That last step exists because the Table API answers 200 whether or not it stored
what you sent. Two rounds of this engagement were lost to trusting that 200 — a
"fix" was reported as deployed while the instance still served the old page.

```
python3 poc/servicenow/build_payload_include.py <netrc-file>
```

Regenerates `EYAIDashPayload` from the deployed `/overview` operation so the page
and the endpoint cannot drift. Edit the endpoint, then regenerate — do not
hand-edit the Script Include.

## 7. Honest limits

- **It is one hard-coded page, not a product.** See doc 07.
- **The visual bar is not met.** Client's own assessment.
- **Charts are a fixed template.** The shape profiler is computed and displayed
  but does not influence chart choice — the exact gap the client identified when
  comparing against their own tool.
- **In-page AI does not work.** §4.
- **No ACL leak has been demonstrated on this instance.** The mechanism is real
  and was proven elsewhere; this instance has no restricted persona.
- **The Script Includes are partly redundant.** REST operations inline their logic
  to avoid a cross-scope Restricted Caller Access grant. Consolidate before
  productionising.
- **Do not describe any of this as Power BI parity.**
