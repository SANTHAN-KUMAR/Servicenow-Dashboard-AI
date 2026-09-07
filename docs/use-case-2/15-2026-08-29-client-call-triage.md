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
| 6b | "Collection of pattern, if it is free or cost" | Clarified 2026-08-31: "Report design outcome skeleton" — a loading skeleton screen | **Built and deployed**, free (plain CSS/JS, no asset) — see §5 |
| 7 | "Concurrent users, access and performance" | A real gap, now measured | **Measured 2026-08-30 — see §6, real numbers, no errors, but confirms no caching exists** |
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

## 5. "Collection of pattern, free or cost" — resolved 2026-08-31: a loading skeleton

**Client clarification, verbatim: "Report design outcome skeleton."** Neither
of the two readings below was right — this is a UI/UX term of art: a
*skeleton screen*, the grey placeholder blocks shown while a view is loading,
shaped like the content that's coming (Power BI, Tableau and most polished BI
tools all show one while a visual renders). "Design outcome" is the report's
finished visual shape; "skeleton" is the wireframe stand-in for it while the
real one builds. In hindsight, consistent with item #2's own framing
("collection of *patterns*" — a UI pattern, not a fabric/texture pattern).

**Checked before building anything: was this even architecturally possible
here?** This surface computes the whole page server-side and embeds the
result in one response (`cmd_dashboard.xhtml`'s `g:evaluate`) — there is no
partial render and no safe client-side fetch to layer a loading state over (an
XHR from a logged-in session on this instance was measured earlier in this
engagement never to return). So the classic pattern — paint a skeleton, fetch
data, swap it in — does not work here at all. What does: the entire wait a
viewer feels (2 to 7+ seconds on the tables measured in
`16-2026-08-30-boolean-bug-and-final-audit.md`) happens *before* the browser
receives a single byte of the next page, which means the only place left to
paint anything is the page being **left**, in the instant before navigating
away. No network call, so nothing that could hang the way the XHR route did.

**Built and deployed.** Every link inside the app that goes to another
COMMAND page — catalog cards, saved-report links, drilldown, chart-form
override, pagination, search — is now intercepted by one delegated click
handler; a skeleton shaped like the destination (header + KPI row + chart
grid for a dashboard; header + card grid for the catalog; header + grouped
list for the reports tab) is painted into the current page instantly, then
the browser is handed off to the real navigation as normal. The two
navigations that don't go through a link click (Enter-to-search, the Search
button) are wired the same way directly, so the experience is consistent
everywhere rather than only on `<a>` clicks. Links that leave COMMAND
entirely (`_list.do`, the platform's own report-template page) are correctly
left alone — our skeleton would misrepresent a page that isn't ours.

**Free**, confirmed directly rather than assumed: plain CSS (a gradient sweep
`@keyframes` animation) and vanilla DOM manipulation, no library, no asset,
nothing to license. It also inherits the existing `prefers-reduced-motion`
rule for free, since that rule already disables every animation under
`#cmd-wrap`.

Verified live on dev390988: the skeleton markup and both new functions
(`paintSkeleton`, `wireSkeletonNav`) are present in the deployed asset, all
four page/view combinations still render with no error, and all 533 offline
tests pass unchanged.
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

**Measured 2026-08-30** (`backup/2026-08-30-boolean-and-drill-audit/round5_concurrency.py`),
against `dev390988`, real HTTP page loads, admin session:

| Page | 1 viewer | 4 concurrent | 8 concurrent | 16 concurrent | Errors |
|---|---|---|---|---|---|
| `cmd_dashboard.do?table=incident` | 10.48s | wall 16.15s, p95 16.15s | wall 27.99s, p95 27.99s | wall 40.59s, p95 40.58s | 0 at every level |
| `cmd_catalog.do` | 6.72s | wall 11.87s, p95 11.87s | wall 19.56s, p95 19.55s | not run | 0 at every level |

Zero errors and zero cross-viewer data leakage at any concurrency level
tested — the permission-checked scan held under load. But latency degrades
roughly 3-4x from 1 to 8-16 concurrent viewers, which is the expected
consequence of a fact already on record: **there is no caching anywhere in
this product** (confirmed by inspecting every script include — no
`gs.cacheable`, no module-level cache). N viewers opening the same subject
in the same window is N independent full scans, not one scan served N
times. This is a real, now-quantified reason to prioritize a short-lived
per-subject cache before a 100k+-report, many-concurrent-viewer rollout —
not before, since the qualitative behavior (correct, no leakage) matters
more than the speed at this stage, but it is next once item 1 is decided.
Caveat carried over from the note above: `dev390988` is a shared dev
instance with its own background-job noise, so the absolute seconds will
not reproduce on production-class hardware — the multiplying pattern will,
until caching exists.

---

## The TODO, in the order to attack it

| Priority | Item | Type | Depends on |
|---|---|---|---|
| 1 | Confirm with the client: should a bare subject dashboard default to `active=true` when the table has that field? | **Decision needed from client** | — |
| 2 | If yes to #1: add the default-active clause in `CmdPayload.dashboard`, keep `active` drillable as normal | Small build | #1 |
| ~~3~~ | ~~Ask the client which "pattern" they mean~~ | ~~Decision needed~~ | **Done** — clarified 2026-08-31, built same day (§5) |
| ~~5~~ | ~~Concurrent-user load test against dev390988~~ | ~~Build + measure~~ | **Done** — measured 2026-08-30, see §6 |
| 6 | Update `14-client-questions-answered.md` §2 to point at the now-shipped form-override control | Docs | none |
| ~~7~~ | ~~Tell the client #2, #3, #4, #6b are already satisfied~~ | ~~Communication~~ | **Done** — folded into the 2026-08-30 client-facing PDF (below) |
| 8 | Get item 1's decision, then build the caching layer §6 recommends before any 100k+/many-concurrent-viewer rollout | Decision + build | #1, then #5 |

Item 1 blocks real work and costs nothing to resolve — it's the one
to put in front of the client before the next session, not after.

**2026-08-30: a client-facing PDF answering all eight items, plus a fifth
independent round of live stress/rogue testing, was sent to the client.**
Source: `backup/2026-08-30-boolean-and-drill-audit/client_report.html`,
rendered to `docs/use-case-2/COMMAND-client-report-2026-08-30.pdf` (4 pages,
under the 6-page cap). It covers items 1-8 in client language with the
concurrency numbers above and a fresh live proof of the region/role/ACL
question (two real non-admin test accounts, five tables, plus a three-layer
entitlement check — report-open, direct-subject, and catalog-card exclusion
— all confirmed independently for a fully-denied table). The round's own
rogue testing (drill-path injection, malformed search input, bogus IDs,
concurrency) found zero new product defects; the offline suite stayed at
533/533. The two failures the round did surface were both in the *test
script*, not the product — a wrong argument order calling `fastGroupBy`,
and `aclVerdict()`'s return object not carrying a `mode` field (it's on
`data.total()` instead) — both are worth remembering next time a script is
written against this engine, not signs of anything wrong live. The round
also reconfirmed and sharpened the existing `GlideImpersonate` warning: even
within one script execution, `gs.getUserName()` still reports the
impersonated user *after* `unimpersonate()` runs, and the corruption
persists on the underlying session for every later call — every persona
check must use its own disposable, throwaway login, never share a session
across an impersonation call and whatever runs after it.
