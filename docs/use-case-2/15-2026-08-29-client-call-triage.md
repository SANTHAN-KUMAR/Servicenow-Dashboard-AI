# The 2026-08-29 call, triaged

Eight items came out of the call, in the client's own shorthand. Two of them
turned out to already be built. One turned out to be a request that, taken
literally, would make the product worse — the investigation below explains
why, with live numbers, rather than either building it blind or dismissing it.
The rest are real, open, and now scoped.

This continues `14-client-questions-answered.md`'s method: measure on
`dev390988`, state the method, don't quote a number without a date next to it.

| # | Client said | What it actually is | State |
|---|---|---|---|
| 1 | "Single report conversion based on active status" | Two different "active" fields were conflated — see §1. The one shown on the call (`sys_report.active`) would be harmful to filter on. The one that likely matters (a record's own `active` field) is a real, open default-behaviour question | **Needs a decision, not a build** |
| 2 | "Add or change of pattern based on our collections" | Chart-form override, per subject | **Already built**, shipped in the commit just before this session (`0c41463`) |
| 3 | "Adoptable with data visualisation in ServiceNow" | Whether this complies with the client's own UI Builder / Now Design System governance document | **Already answered**, in `CLAUDE.md` §4 — restated in §3 below |
| 4 | "Drill down for 2 levels is OK" | Not a request for more — the client is saying 2 levels would satisfy them | **Already exceeded** — 3 levels are built (`CmdDrill.MAX_DEPTH`) |
| 5 | "Architecture design and data flow diagram" | A real, missing deliverable — prose architecture exists, a diagram of the request lifecycle does not | **Built below**, added to `11-technical-architecture.md` §3.1 |
| 6a | "Where converted reports are stored, or dynamic retrieval at time of access" | A real question with a one-line answer | **Answered in §4** — nothing is stored, ever |
| 6b | "Collection of pattern, if it is free or cost" | Almost certainly a different thing from #2 — see §5 | **Needs clarification from the client** |
| 7 | "Concurrent users, access and performance" | A real, unmeasured gap | **Open — needs a load test, scoped in §6** |
| 8 | "Feature and layout design, happy, fine-tuning" | Not an ask. Positive feedback on what's shipped | **No action** |

---

## 1. The "active" question — what the screenshot actually shows, and why filtering on it would be a mistake

The screenshot from the call is `sys_report_list.do`, the platform's own list of
report *definitions*, with its `Active` column visible. The client's read was:
plenty of rows say `false`, and asked whether COMMAND respects that.

**Measured live on `dev390988`, 2026-08-29:** of 682 `sys_report` rows, **2 are
`active=true` and 680 are `active=false`** — including reports with completely
ordinary, currently-useful names: *My Groups Work*, *Business Services by
Location*, *Servers in an application service*. Pulling two of the `false` ones
directly:

```
Active Changes > 7 days   | change_request | active=false | filter: active=true^sys_created_on<...
My Groups Work            | task           | active=false | filter: assignment_groupDYNAMIC...^active=true^state!=-5
```

Both are perfectly good, currently-relevant reports. `sys_report.active` on
this instance does not track "is this report still wanted" — it is the
platform's own default state for most stock and admin-authored reports, and it
carries no relationship to whether a report is retired. **If COMMAND's catalog
filtered `sys_report.active=true`, the "Saved reports" tab would go from 682
entries to 2**, hiding almost everything the client actually uses. This is the
same trap `10-client-review-and-revised-scope.md` documents for
`sys_dictionary.dependent_on` and the form engine documents for
`sys_report.type`: a platform metadata flag records an author's or the
platform's own intent, not a property worth trusting blind. It was checked
before building anything, which is why nothing was built on it.

**What the client is very likely actually asking about is different, and it is
real.** Every subject table with its own `active` field —
`incident`, `problem`, `change_request`, `samp_sw_reclamation_candidate` —
currently opens with **no default filter at all**. Confirmed live: opening
`cmd_dashboard.do?table=incident` with no drill path offers `active` as a
drillable field with two populated values, meaning open and closed incidents
are counted and charted together from the first screen. A saved report that
already encodes `active=true` in its own filter is respected exactly as
written (verified above — the converted "Active Changes > 7 days" page carries
the filter through unchanged), so this only affects **browsing a subject
directly from the catalog, not opening a saved report.**

**This needs a decision, not code**, because both defaults are legitimate
products: a leader might want "what's open right now" by default, or might
want the full history with active/inactive as just another filter to apply.
Recommended default, to confirm with the client: when a subject's table has an
`active` field, the un-drilled view defaults to `active=true`, with `active`
itself remaining a normal drill dimension so a viewer who wants the full
history clicks into it explicitly. Small build once confirmed — one extra
default clause in `CmdPayload.dashboard`, gated on `CmdMeta` already knowing
the field exists.

## 2. "Change the pattern based on our collections" — already built

This is the chart-form override control, and — confirmed by reading the
current, deployed `cmd_render.js` — it now covers exactly what the client
described:

- Every panel has a **"Chart"** control. Opening it shows what was drawn, why,
  every alternative the data can honestly support with its own reason, and
  every form that was considered and refused, with the refusal reason stated
  rather than hidden.
- Choosing an alternative rebuilds that one panel via a link
  (`&forms=field:form`), so the choice is shareable and reversible, same
  discipline as the drill path.
- A form the data cannot honestly carry is never offered — the same
  measured-shape gate that picks the default also bounds what a viewer is
  allowed to override to.

`14-client-questions-answered.md` §2, written 2026-08-15, called this exact
capability the one open gap against the client's own words — *"give the user
options to analyse rather than overwhelming them"* — and it has since shipped
(`0c41463`, the commit immediately before this session started). That doc's
§2 is now stale on this specific point and should be updated to point here
next time it's touched.

## 3. "Adoptable with data visualisation in ServiceNow" — already answered

`CLAUDE.md` §4 has the resolved position, already agreed for this engagement:
custom rendering is used because the client's own UI Builder / Now Design
System governance document has an exception clause for exactly this case —
"Power BI-like, beautiful, impressive" is a requirement the OOB Data
Visualization palette cannot meet (fixed chart set, no data-shape adaptation).
The middle path already built: custom charts, drawn with a real charting
engine, styled from the platform's own Now Design System tokens (colour,
type, spacing), so the output is visually native even though the rendering
underneath is bespoke. Nothing new to build here; worth restating to the
client in those terms if the question comes up again.

## 4. Where converted reports live

**Nowhere. There is no storage.** A converted report is recomputed, from
`sys_report`'s own live row, every time the page is opened — same as every
other dashboard. Opening `cmd_dashboard.do?report=<sys_id>` runs
`CmdReport.convert()` inside that one request, which reads the report's table
and filter at that moment and throws the result away once the response is
sent. Nothing is cached, materialised, or written back anywhere. The
practical effect the client will notice: edit a report's filter in
ServiceNow's own report builder, save it, reopen it in COMMAND, and the
change is there immediately — there is no second copy anywhere to fall out of
sync.

## 5. "Collection of pattern, free or cost" — needs the client to say more

This does not obviously match #2 (the chart-form control, which is free —
ECharts is Apache 2.0, no licence to buy). Two other readings seem more
likely and point at different work:

- **Colour-blind-safe pattern fills** (hatching/texture in addition to colour,
  so two categories are distinguishable without relying on colour vision) —
  a real accessibility technique, not currently built anywhere in
  `cmd_render.js`. If this is what's meant, it's new work, and it is free —
  it's a rendering technique, not a licensed asset.
- **An icon or pattern *asset library*** (a purchased or third-party set of
  symbols/textures for the brand kit) — if the client means a specific named
  product or library they've seen elsewhere, that's a licensing question this
  document can't answer without knowing which one.

**Recommended next step: ask the client directly which of these they mean**,
ideally by having them point at an example. Building the wrong one wastes the
same afternoon either way.

## 6. Concurrent users and performance — open, and worse than it looks

`14-client-questions-answered.md` §5 already measured single-viewer
performance and found large subjects miss the stated budget (`incident` at
4,266 rows: ~6.0s). **Nothing in this engagement has yet measured multiple
viewers hitting the instance at the same time.** That matters here
specifically because of how the page is built: there is no caching anywhere
in the product — confirmed by inspecting every script include, there is no
`gs.cacheable`, no module-level cache, nothing — every single page load
re-runs its own full permission-checked scan from zero. That is good for
correctness (no risk of one viewer's cached result leaking to another) and
bad for concurrency: N viewers opening the same subject in the same minute is
N independent full scans against the same tables, not one scan served N
times.

**Scoped as a real task:** a small load-test script (the deploy tooling
already has an authenticated instance client to build on —
`product/deploy/snclient.py`) firing concurrent requests at a shared subject
and a shared catalog, measured against a role-less persona and an
unrestricted one, reporting p50/p95 latency and whether the shared dev
instance's own background-job stalls (already known to happen,
`snclient.py`'s own comments) make the numbers noisy. This is genuinely
unmeasured today — say that plainly if asked before the test exists, rather
than estimating.

---

## The TODO, in the order to attack it

| Priority | Item | Type | Depends on |
|---|---|---|---|
| 1 | Confirm with the client: should a bare subject dashboard default to `active=true` when the table has that field? | **Decision needed from client** | — |
| 2 | If yes to #1: add the default-active clause in `CmdPayload.dashboard`, keep `active` drillable as normal | Small build | #1 |
| 3 | Ask the client which "pattern" they mean (§5) — pattern fills, or a named asset library | **Decision needed from client** | — |
| 4 | Build whichever #3 turns out to be | Build, unscoped until #3 answered | #3 |
| 5 | Concurrent-user load test against dev390988 | Build + measure | none, can start now |
| 6 | Update `14-client-questions-answered.md` §2 to point at the now-shipped form-override control | Docs | none |
| 7 | Tell the client #2 (pattern/form choice), #3 (governance compliance) and #4 (2-level drill) are already satisfied, so effort isn't spent re-solving them | Communication | none |

Items 1 and 3 block real work and cost nothing to resolve — they're the two
to put in front of the client before the next session, not after.
