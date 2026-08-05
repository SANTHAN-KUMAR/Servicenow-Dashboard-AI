# COMMAND — Technical Architecture and Delivery

**Product:** COMMAND, a dashboard and reporting library running inside ServiceNow.
**Audience:** the client's technical and quality teams. Written to be audited.
**Measured on:** `dev390988` (Australia release). **Date:** 2026-08-05.

This describes the **production architecture**. Every number is measured live. Labels
used throughout: **Built** = running today · **Planned** = designed and estimated,
not written. Nothing is Built unless it reproduces on `dev390988` right now.

**Section 7 is the status, the remaining work and the open defects. Read it first.**

Deeper background, already delivered: licensing and data protection in
`10-client-review-and-revised-scope.md` §1 and §3; the full competitive and platform
citation registry in `03-gap-registry.md`.

---

## 1. What it does

A user opens a catalog of subjects they may analyse, picks one, and gets a dashboard
built from that subject's real data. They click any value to go deeper, three levels,
ending on the platform's own record list. Nobody picks a chart type, builds a
hierarchy, or configures a drill path.

Three things make it different from a normal dashboard build:

1. **Chart form follows measured data shape,** not an author's choice.
2. **Every number is checked against what the viewer may read,** and the page says so.
3. **A weak analysis is refused rather than drawn** — a breakdown that would be 99%
   empty shows its reason instead.

---

## 2. Terms

| Term | Meaning here |
|---|---|
| **Subject** | One table you can analyse — Incident, Change, Risk |
| **Panel** | One chart or number on the dashboard |
| **Form** | The kind of chart. 27 supported |
| **Shape profile** | Measured facts about a field: distinct values, fill rate, concentration |
| **Gate** | A rule a chart must pass before being drawn. Fails closed |
| **Caveat** | A warning printed on a panel — "only 24 records, treat as indicative" |
| **ACL** | ServiceNow's row-level permission rules |
| **ACL verdict** | Our per-page finding: are these counts complete for this viewer |
| **Script Include** | Server-side JavaScript stored in ServiceNow |
| **UXF component** | A modern ServiceNow custom UI component. The production target |
| **Scoped app** | A packaged application with its own namespace and clean uninstall |
| **GlideRecordSecure** | Platform API that reads **with** permission checks |
| **GlideAggregate** | Platform API that counts fast, **without** row-level checks |

---

## 3. Architecture

Six layers, data flowing up, each testable alone.

```
                     BROWSER
  ┌──────────────────────────────────────────────────┐
  │ 6  RENDER    cmd_render.js        3,075 lines    │
  │    27 chart forms, tooltips, cross-filter,       │
  │    table view, light/dark, drill clicks          │
  └──────────────────────────────────────────────────┘
        ▲  one payload, embedded in the page
                     SERVER
  ┌──────────────────────────────────────────────────┐
  │ 5  ASSEMBLY  CmdPayload · CmdCatalog · CmdDrill   │
  │ 4  ANALYSIS  CmdAnalysis          1,302 lines    │
  │ 3  FORM      CmdForm                493 lines    │
  │ 2  DATA      CmdData              2,336 lines    │
  │ 1  METADATA  CmdMeta                444 lines    │
  └──────────────────────────────────────────────────┘
                ServiceNow tables
```

| Layer | Job |
|---|---|
| **1 Metadata** | Tables, fields, types, labels, choice lists |
| **2 Data** | Permission-checked reads, one shared scan per page, ACL verdict, time budget |
| **3 Form engine** | Rule table: shape + question → chart form, or a refusal with a reason |
| **4 Analysis** | 21 builders — trend, backlog, period change, distribution, correlation, concentration |
| **5 Assembly** | Chooses panels, builds the catalog, gates drill levels |
| **6 Render** | Draws SVG directly. Plain JavaScript, no framework |

All six are **Built**.

**Why this shape.** The render layer is a pure function of the payload — same payload
in, same pixels out. That is what lets all 27 forms be tested offline, and what makes
the move to a UXF component a change of delivery rather than a rewrite.

**Four design rules carry most of the value:**

- **One scan feeds every panel.** Eleven charts, one pass over the rows. This began as
  a speed change and became a correctness fix: separate time-limited scans stop at
  different row counts, so panels on one page were computed over *different sets of
  rows* and disagreed with each other.
- **Work is bounded by a clock, not a row count.** Permission checking costs 0.2ms to
  5ms per row depending on the table — a 25-fold spread, so a row limit is instant on
  one table and unusable on another.
- **Every builder returns nothing rather than something weak.** The single rule that
  stops this degrading into the generic dashboards it replaces.
- **Panels are ordered by how strict a gate they passed,** then spread for form
  variety. Without the second rule the same six charts opened every page.

**The form engine is deliberately not an AI model.** It is a reviewable rule table
over measured statistics, so it can be regression-tested and argued with. Examples:
above ~12 distinct values bars become a treemap; a top value under 4% of total means
nothing worth ranking; under 30 records draws with a visible caveat.

---

## 4. How it runs inside ServiceNow

### 4.1 Today · Built

7 `sys_script_include` (server logic), 3 `sys_ui_script` (renderer, theme, fonts), 2
`sys_ui_page`. The page computes its payload server-side and embeds it: one round
trip, no loading spinner.

A UI Page came first because chart logic and delivery vehicle are separate problems —
this got the data layer, form engine and all 27 charts correct against real data
without also fighting a component build toolchain.

### 4.2 Four platform constraints, found by measurement

| Constraint | What happens | Our answer |
|---|---|---|
| **On-demand fetch fails here** | An XHR from a logged-in session to a Scripted REST endpoint never returns. The platform's own Table API behaves the same | Compute server-side, embed. Why there is no loading state — and why on-demand drilling is gated on §4.3 |
| **Inline client JS breaks the page silently** | Jelly evaluates `<script>` bodies. A CDATA-wrapped one makes the platform serve the **whole page as zero bytes, HTTP 200, no error logged** | All client JS is a UI Script loaded by reference; the build tool refuses to deploy a page that inlines one |
| **Assets cache hard; the platform's cache-buster never changes** | We shipped new renderers three times and browsers kept the old code while deploy reported success. `?hash=` failed too — **ServiceNow strips `src` and stores an empty `<script></script>`** | The content hash is part of the **asset name**: `cmd_render_8d9fb6103ccc`. New content, new name. Old versions pruned |
| **HTTP 200 does not mean the write landed** | The Table API returns 200 whether or not it stored what you sent. We lost two rounds reporting a fix as deployed while the old record was still served | Every write is read back and compared byte for byte, inside the deploy tool |

**One pattern caught us twice.** Server-side JavaScript is Rhino, and platform APIs
return **Java** strings. On a Java string `.length` is a method, not a property, and
`.split('|')` binds to Java's regex split — where `|` means alternation, so it splits
between every character. That silently broke multi-level drilldown:
`category:software` parsed into sixteen levels, one per letter. Every page still
returned 200 with a full set of charts; only the row count gave it away. Every value
arriving from a platform API is now coerced to a JavaScript string first.

### 4.3 Production · Planned

| Item | Now | Production |
|---|---|---|
| Packaging | Loose records | Scoped app `x_<vendor>_cmd`, clean uninstall |
| UI surface | UI Page (`.do`) | UXF components on a UI Builder experience |
| Navigation | Direct URL | App menu, modules, routed pages, deep links |
| Chart engine | Our own SVG renderer | Custom Apache ECharts build, used types only |
| Promotion | Deploy script | Source Control (Git), **not** Update Sets |
| Roles | Admin-tested only | Named roles, tested per persona |

**Promotion must use Source Control.** Update Sets do not reliably carry custom UXF
component source — ServiceNow's own documentation states the Update Set "will NOT
hold your source-code of the Component Project." There is also a known defect
(PRB1625935) causing blank pages after promotion. Source Control in Studio arrived in
**Zurich**, so **this needs confirming against the client's release at kickoff.**

**The one genuinely open technical question.** Deep drilldown needs data on demand,
and on-demand fetch fails on this surface (§4.2). A UXF component does not fetch that
way — it goes through the platform's data broker, a different mechanism the
platform's own pages depend on. We do not know whether it works here.

So the first week of production work is a **gate, not a warm-up**: prove a custom
component renders at the approved visual bar, can fetch aggregates on demand, and
completes a drill round trip inside budget. If yes, drilldown is a normal build. If
no, the fallback is precomputing one level ahead — and the client hears that in week
two, not month four.

### 4.4 Support model — state this plainly

**ServiceNow does not support custom components.** Their official FAQ: they support
the framework but "will not support any custom components customers are creating and
deploying to their instances."

Whoever delivers this owns support for the custom UI indefinitely — true of any
custom ServiceNow UI, including VividCharts and any in-house build. It must be priced
and staffed, not discovered. It is also the reason for the choices here (plain
JavaScript, permissive chart engine, no framework): the client's own team can debug it.

---

## 5. Data correctness: the ACL problem

The part we would most like audited.

### 5.1 The gap, demonstrated

ServiceNow's fast counting API does not apply row-level permissions. `GlideAggregate`
does not enforce them (only a table-level `canRead()` a developer must remember to
call), there is no `GlideAggregateSecure`, and `GlideQuery.withAcls()` **refuses to
aggregate** — it throws rather than answer.

**Measured with a role-less user: `GlideAggregate` returns 67 where
`GlideRecordSecure` returns 0 rows.** Reproduced on the client's own instance.

So the ordinary way to build a KPI tile shows numbers including records the viewer
cannot open — not an edge case, the default result of the obvious implementation. ACL
enforcement is also a **named rejection criterion** in ServiceNow's Store
certification process.

### 5.2 What we do

Every page computes an **ACL verdict** and shows it:

| Verdict | Meaning | Shown as |
|---|---|---|
| **Verified** | Checked count equals raw count. Nothing hidden or over-counted | Green — "ACL verified" |
| **Filtered** | Viewer cannot read some records; excluded from every number | Amber — "Filtered to your access", with count |
| **Bounded** | The check could not finish in budget, so counts are a floor | Amber — "Counts are a lower bound" |

`incident`, `change_request` and `problem` return Verified and hold it across
repeated loads.

**A bug worth showing you.** The verdict runs under a time budget, estimating full
cost early and stopping if it will not fit. That estimate divided elapsed time by
rows read — but elapsed time at row 50 is mostly one-off setup, so every row was
charged for work that happened once: 0.64ms per row against a true 0.208ms. Because
the overestimate raced setup cost, **the same dashboard returned "Verified, 4,266
records" on one load and "Bounded, 50" on the next.** Our own code comment had
reasoned the early stop "can only ever cause an earlier Bounded, never a wrong
Verified, so the correctness claim is untouched" — true, and it missed the point: the
damage was inconsistency, not unsoundness. Fixed by measuring the rate over a window
starting *after* setup. Included because "the number changes on refresh" is exactly
the class of bug that survives a demo.

### 5.3 What is not yet proven — read this

**Everything above was verified as `admin`.** An admin sees everything, so the
**Filtered path has never run against a genuinely role-less user** — and that path is
the whole point of the feature. The logic is written and unit-tested; the gap is a
test fixture. Until it runs under real restricted personas we will not claim it
works, and you should not accept that we have.

**Scale is also unproven.** Reading securely and counting in memory is inherently
slower than an unchecked database count. Tested to ~14,000 rows, untested at
100,000+. If it does not hold, the fallback is pre-computed aggregates keyed by role
set — a materially larger build, and a decision that should rest on a measurement we
have not taken.

---

## 6. Analysis selection, drilldown, performance

### 6.1 Why automated selection is needed — measured

From all **2,368 reports** on the instance:

| Finding | Number |
|---|---:|
| A datetime field drawn as a single number, not a time series | **20 of 26** |
| Chart forms used for the same field, `priority` | **9** |
| Chart forms used for the same field, `category` | **11** |
| Reports that are a plain count | **75%** |
| Share of reporting carried by 5 of 24 available chart types | **77%** |

No field-to-chart mapping exists anywhere on the instance, because the platform has
no such logic — `sys_report.type` records what an author picked. **The client can
check this themselves.**

### 6.2 Drilldown · Built, depth 3

Using the schema's declared hierarchies naively fails: on `incident`, 13,986 records,
**subcategory is set on 42** — empty 99.70%. A user clicking into Software (2,651
incidents) would land where 99.3% read "(none)". On `change_request`, Category→Type is
fully populated. So drill quality is a property of a specific field pair on a
specific table.

**The general lesson: platform metadata records what an author intended, not what is
true of the rows.** A drill level is offered only after passing fill-rate and
cardinality gates **on the viewer's own permitted rows** — otherwise the drill menu
leaks the shape of data the viewer cannot see. A rejected level shows its reason
rather than a dead-end click.

| Level | Path | Records | Next offered |
|---|---|---:|---|
| 0 | (top) | 4,266 | escalation, active, category |
| 1 | `category=software` | 1,112 | escalation, active, impact |
| 2 | `+ priority=3` | 502 | active, impact |

The path is in the URL, so a drill state is shareable and the back button reverses
it. Fields drop out once used. Verdict stays Verified throughout. Drilling gets
*faster* with depth — fewer rows left to check.

The terminal step hands off to the **platform's own record list** with the real
query. This is where being inside ServiceNow beats Power BI: the platform enforces
row-level security there, so we never build a record grid or own its security.

### 6.3 Performance · **Fails budget**

| Gate | Target | Measured | Status |
|---|---|---|---|
| Interactive | < 2.5s | **4–12s** | **Fails** |
| Drill round trip | < 400ms | 4–5s in-page rebuild | **Fails** |
| Payload size | ≤ 250 KB gzipped | ~24 KB typical | Passes, 10x inside |
| Repeat visit cached | assets cached | content-hashed names | Passes |
| First paint | < 1.2s | not yet measured on the real surface | — |

**We do not present this as met.** Typical pages are 4–9 seconds, worst measured
12.4 — three to five times over budget on a concern the client named explicitly. It
was 39 seconds before the shared-scan work, so 3x better and still not good enough.
Roughly 3–6s is server-side payload building dominated by permission-checked reading;
the rest is transport of a 70–240 KB document.

**One wrong theory, recorded.** We suspected query planning was unbounded on wide
base tables like `task`. Measured at 8–27ms everywhere. The real cause was a
permission-check routine charging the page's time allowance without checking it.

**What closes the gap.** The ACL verdict and field profiles are recomputed on every
page load to reach the same answer. Caching them per (role set, table, filter) with a
short expiry removes most of the server time. We have deliberately **not** shipped
this: it puts a cache in the permission path, and the key and expiry are a
correctness decision about what happens when someone's roles change. Secondary levers
are standard — custom ECharts build, deferred below-fold panels, canvas above ~1,000
marks.

---

## 7. Status, remaining work, open defects

### 7.1 Built and measured on `dev390988`

6 layers, 6,420 lines server + 3,075 client, deployed and readback-verified · 27 chart
forms all rendering from real records across 11 tables · form engine with gates and
caveats · permission-scoped catalog (12 subjects from 30 considered, stable) ·
multi-level drilldown to depth 3 with shareable URL · drill-through to the platform
record list · ACL verdict in three states, always shown · cross-panel filtering,
tooltips, table view, light and dark · time-window slicer · deploy tool with
byte-for-byte write verification · 226 offline assertions plus a live smoke test, all
green · ~24 KB gzipped against a 250 KB budget.

### 7.2 Remaining to production

Person-weeks, one engineer. Several run in parallel.

| # | Work | Why it matters | Est |
|---|---|---|---:|
| 1 | Multi-user ACL testing under real restricted personas | The Filtered path is the lead differentiator and has never run | 0.5 |
| 2 | Performance: cache the ACL verdict and profiles | Closes most of the 4–12s gap | 1 |
| 3 | **UXF spike — the gate.** Render quality, on-demand fetch, drill latency | Decides whether deep drilldown is buildable as specified | 1 |
| 4 | Scoped app skeleton, roles, tables, clean uninstall | Nothing ships as loose records | 1 |
| 5 | `THIRD-PARTY.md` register + CI licence gate | Client's first concern; cheap now | 0.5 |
| 6 | Port render layer into UXF components, ECharts build | The production UI surface | 1.5–2 |
| 7 | On-demand drilldown (shape depends on #3) | Requirement 5 in full | 2–3 |
| 8 | Navigation: experience, routes, app menu, deep links | Product, not a page | 0.5–1 |
| 9 | Accessibility completion, performance pass, upgrade regression | Release quality | 2 |
| 10 | Wider IP review — colour, layout, chart forms, icons, patents, product name | Not started | external |
| 11 | Load test the secure path at 100k+ rows | Decides if the fallback is needed | 0.5 |
| | **Total** | | **~11.5–14.5** |

Excluded: Store certification (3–5 week external review) and the pre-computed
aggregate fallback if #11 fails.

### 7.3 What is still wrong

1. **Latency 3–5x over budget** — 4–12s against 1.2s/2.5s. Fix scoped, not applied.
2. **The Filtered ACL path is unproven.** All verification was as `admin`. This is the
   lead differentiator.
3. **Two tables give an unstable verdict.** `kb_knowledge` and `cmdb_ci` sit close
   enough to the time budget that repeated loads disagree. Same fix as #1.
4. **It is not ECharts yet.** The renderer is ours; the port is not done, so its
   bundle size is unmeasured.
5. **It is a UI Page, not a UXF component.** The production surface is unproven, and
   on-demand fetch is an open question.
6. **The secure path is untested above ~14,000 rows.**
7. **No CI licence gate yet**, and the wider IP review has not started.
8. **One table shows a near-empty dashboard.** `sc_request` has one record here. The
   engine correctly refuses to chart it and says why, but the page looks bare behind a
   catalog card.

---

## 8. Compliance, security, testing

### 8.1 Nothing leaves the instance

No runtime request to any host outside it — not for
fonts, a chart library, or telemetry. Fonts are subsetted and embedded. This is data
protection, not licensing: loading a font from a public CDN transmits every viewer's
IP to a third party on every dashboard load, and the people affected would be the
client's own employees. **Code and fonts travel in, data does not travel out.**

### 8.2 AI: optional, off by default, never sees a record

MCP is a build-time tool
on a dev instance; **nothing we ship contains an MCP client.** In the product we
recommend Now Assist or the client's own LLM tenant, not a direct third-party call.
Structurally the AI layer never needs a record: the profiler works on field names,
types, distinct counts and fill rates; a narrative layer would work on aggregates
already on screen. **No record-level data is sent to any model, in any configuration**
— enforced by the adapter's input type carrying no record payload. The headline
feature has no AI dependency at all. Detail: `10-client-review...` §3.

### 8.3 Licensing

Fonts are SIL OFL 1.1, the chart engine Apache 2.0 with an express
patent grant. We subset the fonts, which counts as modification under the OFL, so we
checked the actual licence files: **none of the three declares a Reserved Font Name**,
making it compliant. Obligations: ship LICENSE/NOTICE inside the app, and never name a
feature "ECharts" (an ASF trademark). The real risk is a *future* component —
Highcharts' quote-only OEM licence, or a GPL/AGPL transitive dependency — so it is
solved by a gate, not by care: a generated `THIRD-PARTY.md` and a CI allowlist that
fails the build. **Planned, not built.** Detail: `10-client-review...` §1.

### 8.4 Design governance

The client's UI standards document allows custom UI where a
requirement cannot be met by standard components, and we use that exception clause.
We do not argue from chart count — 24 types is respectable — but from **kind**: no
treemap, sankey, sunburst, network, radar, waterfall, stream or histogram in the
modern surface, fixed visual treatment, no free-form canvas, and native AI chart
generation capped at five types. So: custom on **rendering**, compliant elsewhere.
Components consume Now Design System tokens; **no built-in component is ever
modified**; every deviation is recorded with its justification.

**What we do not claim.** Not Power BI parity — no cross-source semantic modelling, no
DAX-equivalent measures, no arbitrary ad-hoc exploration. The honest description:
**Power-BI-grade visual and interaction quality on ServiceNow-native data, with
automated chart and drill selection that Power BI does not do.**

### 8.5 Testing — 226 offline assertions plus a live smoke test

| Suite | Count | Protects |
|---|---:|---|
| `test_data_helpers.js` | 72 | Date arithmetic, quantiles, binning, correlation, cost projection |
| `test_form_engine.js` | 42 | Every gate and caveat rule |
| `test_render_coverage.js` | 14 | All 27 forms map to distinct renderers |
| `test_render_edges.js` | 116 cases | Empty, single-value, huge, negative, malformed input |
| `test_render_live.js` | 71 | Real renderers over real captured payloads |
| `smoke_live.py` | live | The deployed instance over HTTP |

Two things deserve an auditor's attention. **The suite is tested against its own blind
spots:** we broke renderers deliberately to see whether it noticed, and it did not —
node counts stayed healthy while a chart drew one series and discarded the rest. It
now asserts every series and row in the payload appears in the output. **`smoke_live.py`
exists because every offline suite passed while the instance served a stale
renderer** — a fixture cannot tell you what the browser was handed. It checks
zero-byte 200s, leaked platform traces, unsubstituted build placeholders, missing
assets, drilldown actually filtering, and verdict stability across identical requests.

**ATF is not the mechanism.** ServiceNow's Automated Test Framework does not cover
custom UXF components with parity to classic forms, per ServiceNow's own community
blog. The suite above is primary; ATF covers only what it reaches.

---

## 9. What we need from the client

| # | Need | Blocks |
|---|---|---|
| 1 | Instance release version | Source Control promotion needs Zurich or later |
| 2 | Test accounts under **real restricted roles** | The entire Filtered ACL proof |
| 3 | Which subject areas ship first | Demand is broader than ITSM — GRC, risk and audit together outweigh Incident |
| 4 | Default theme, light or dark | Both ship; dark is the flagship |
| 5 | Font strategy: full set (~188 KB) or ~a third with body text on the platform sans | A visible design trade-off, so the client's call |
| 6 | How deep they actually drill in Power BI today | Confirms the depth-3 cap |
| 7 | Whether AI ships in v1 | We recommend deferring until the design is live |
| 8 | Whether Store distribution is a goal | Changes certification and licensing obligations |

---

## 10. Method note

All measurements taken on `dev390988` between 2026-07-29 and 2026-08-05. The
2,368-report inventory was read from `sys_report`. The ACL demonstration (67 vs 0) was
a background script, reproduced on the client's instance. Drilldown figures come from
live page fetches. **Latency is wall-clock from an external network to a shared
development instance**, so it includes real transport and is not a clean server
benchmark. ECharts bundle sizes are deliberately not quoted — that measurement is owed
by the UXF spike.

Where this document says a thing is not proven, it is not proven.
