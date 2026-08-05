# COMMAND — Technical Architecture and Delivery

**Product:** COMMAND, a dashboard and reporting library that runs inside ServiceNow.
**Audience:** the client's technical and quality teams. Written to be audited.
**Instance under test:** `dev390988` (Australia release).
**Date:** 2026-08-05.

---

## How to read this document

This describes the **production architecture** of the product, not a demo. Every
number in it is measured on a live instance, and every claim carries one of three
labels:

| Label | Meaning |
|---|---|
| **Built** | Running on the instance today, with the measurement shown |
| **Hardening** | Working, with a named gap and the fix specified |
| **Planned** | Designed and estimated, not yet written |

Nothing is labelled Built unless it can be reproduced on `dev390988` right now.
Section 12 is the honest status of everything, in one table. Section 13 lists what
is still wrong. We would rather your quality team read those two sections first.

---

## 1. What the product does

A user opens a catalog page. It lists every subject they are allowed to analyse.
They pick one. The system reads the data, works out which measures and charts that
data actually supports, and builds the dashboard. They can then click any value to
go deeper, up to three levels, and finish on the platform's own record list.

Nobody picks a chart type. Nobody builds a hierarchy. Nobody configures a drill
path. They pick a subject.

Three things make this different from a normal dashboard build:

1. **Chart form follows measured data shape,** not an author's choice.
2. **Every number is checked against what the viewer is allowed to read,** and the
   page says so.
3. **A weak analysis is refused rather than drawn.** If a breakdown would be 99%
   empty, the page says why instead of showing an empty chart.

---

## 2. Glossary

Plain meanings for the terms used in this document.

| Term | What it means here |
|---|---|
| **Subject** | One table you can analyse — Incident, Change, Risk, Asset |
| **Panel** | One chart or number on the dashboard |
| **Form** | The kind of chart — line, treemap, box plot. We support 27 |
| **Shape profile** | Measured facts about a field: how many distinct values, how full it is, how concentrated |
| **Gate** | A rule a chart must pass before it is drawn. Fails closed |
| **Caveat** | A short warning printed on a panel — "only 24 records, treat as indicative" |
| **Reduction / scan** | One pass over the rows that feeds many charts at once |
| **ACL** | ServiceNow's row-level permission rules |
| **ACL verdict** | Our per-page finding: are these counts complete for this viewer |
| **Drill path** | The chain of filters you clicked to get where you are |
| **Script Include** | Server-side JavaScript stored in ServiceNow |
| **UI Page / UI Script** | ServiceNow's built-in page and client-script records |
| **UXF component** | A modern ServiceNow custom UI component, the production target |
| **Scoped app** | A packaged ServiceNow application with its own namespace and clean uninstall |
| **Now Design System** | ServiceNow's official design language and token set |
| **GlideRecordSecure** | Platform API that reads records **with** permission checks |
| **GlideAggregate** | Platform API that counts fast but **without** row-level permission checks |

---

## 3. Architecture

Six layers. Data flows up. Each layer has one job and can be tested alone.

```
                         BROWSER
  ┌──────────────────────────────────────────────────────┐
  │ 6  RENDER            cmd_render.js    3,075 lines    │
  │    27 chart forms, tooltips, cross-filter,           │
  │    table view, light/dark, drill clicks              │
  └──────────────────────────────────────────────────────┘
             ▲  one payload, embedded in the page
                         SERVER
  ┌──────────────────────────────────────────────────────┐
  │ 5  ASSEMBLY   CmdPayload · CmdCatalog · CmdDrill      │
  │    picks panels, caps count, spreads chart variety,   │
  │    builds catalog, gates drill levels                 │
  ├──────────────────────────────────────────────────────┤
  │ 4  ANALYSIS   CmdAnalysis        1,302 lines          │
  │    21 panel builders. Each returns nothing rather     │
  │    than a weak chart                                  │
  ├──────────────────────────────────────────────────────┤
  │ 3  FORM ENGINE  CmdForm            493 lines          │
  │    rule table: shape + question -> form, or refuse    │
  ├──────────────────────────────────────────────────────┤
  │ 2  DATA       CmdData            2,336 lines          │
  │    permission-checked reads, one shared scan,         │
  │    ACL verdict, time budget                           │
  ├──────────────────────────────────────────────────────┤
  │ 1  METADATA   CmdMeta              444 lines          │
  │    tables, fields, types, labels, choice lists        │
  └──────────────────────────────────────────────────────┘
                    ServiceNow tables
```

**Why this shape.** The render layer is a pure function of the payload: same
payload in, same pixels out. That is what lets us test all 27 chart forms offline,
and it is what makes moving from a UI Page to a UXF component a change of delivery
only, not a rewrite.

### 3.1 Layer 1 — Metadata · **Built**

Reads the schema: which tables exist, which fields they have, their types, labels
and choice lists.

One correctness note worth recording. Choice lists in ServiceNow are inherited
down a table hierarchy, and the platform **overrides** rather than accumulates
them. Our first version merged the chain, so `change_request.state` came back as
the generic Task vocabulary interleaved with the Change one — real labels, in a
meaningless order. It now walks most-specific-first and takes the first table that
declares a choice. Any product that reads choice lists across a table hierarchy
needs this; it is easy to get wrong and produces plausible-looking nonsense.

### 3.2 Layer 2 — Data · **Built**, with a named performance gap

This layer does three things.

**One scan feeds every panel.** A dashboard with eleven charts does not run eleven
queries. It declares what it needs, and one pass over the rows fills all of them.
This started as a speed change and turned out to be a correctness fix: separate
time-limited scans stop at different row counts, so panels on the same page were
being computed over *different sets of rows* and disagreeing with each other.

**Every read is permission-checked.** Reads go through `GlideRecordSecure`, which
applies row-level rules. See section 5.

**Work is bounded by a clock, not a row count.** Permission checking costs between
0.2ms and 5ms per row depending on the table's rules — a 25-fold spread. A
row-count limit is therefore instant on one table and unusable on another. Each
page has a time allowance and reports how it was spent.

### 3.3 Layer 3 — Form engine · **Built**

A flat rule table. Input: the field's type, its distinct count, top-value share,
concentration, row count, and the question being asked. Output: a chart form, or a
refusal with a reason.

It is deliberately **not** an AI model. It is a reviewable rule table, which means
it can be regression-tested and its output can be argued with. 42 automated tests
cover it.

Examples of live rules:

| Rule | Threshold | Why |
|---|---|---|
| Too many categories to draw as bars | above ~12 distinct | Bars become unreadable; becomes treemap or "top N + Other" |
| Not enough spread to rank | top value under 4% of total | Nothing meaningful to rank |
| Too few records | under 30 | Draws, with a visible caveat |
| A rank reversal is real | at least 2 places each way | Otherwise noise makes every chart a bump chart |
| Time window too sparse | fewer occupied buckets than the floor | A trend line over two points is not a trend |

### 3.4 Layer 4 — Analysis builders · **Built**

21 builders, each answering one kind of question: what is the trend, what is the
backlog, what changed between periods, how is this distributed, what correlates
with what, where is the concentration, how does the cycle look by weekday.

**Every builder returns nothing rather than something weak.** This is the single
most important design rule in the product, and it is what stops it degrading into
the generic dashboards it exists to replace.

### 3.5 Layer 5 — Assembly · **Built**

Chooses which panels make the page. Three rules:

1. **Ordered by how strict a gate the panel passed.** Clearing a strict gate is
   itself evidence the panel is informative.
2. **One of each chart form first, then fill.** Without this the same six charts
   opened every page and the rarer forms never appeared.
3. **Capped.** More panels is not more insight.

Also builds the catalog (permission-scoped — a card is not shown for data the user
cannot read) and gates drill levels.

### 3.6 Layer 6 — Render · **Built**

3,075 lines of plain JavaScript, no framework. Draws SVG directly.

Includes: tooltips, cross-panel highlighting, a table view of every chart for
accessibility and export, light and dark themes, a time-window slicer, and drill
click handling.

**Note on the chart library.** Today the render layer is ours, hand-written. The
plan has always been Apache ECharts for the production component, and that
decision is unchanged — but it is worth being clear that what runs today is not
ECharts. See section 13.

---

## 4. How it runs inside ServiceNow

This is the part your quality team will care about most, so it is split into what
we did, why, and what changes for production.

### 4.1 Today: UI Page harness · **Built**

| Piece | ServiceNow record | Count |
|---|---|---|
| Server logic | `sys_script_include` | 7 |
| Client renderer, theme, fonts | `sys_ui_script` | 3 |
| Pages | `sys_ui_page` | 2 |
| Stylesheet | inlined into both pages | 1 |

The page computes its payload server-side and embeds it. One round trip, no
loading spinner, no second request.

**Why a UI Page and not a UXF component first.** The chart logic and the delivery
vehicle are separate problems. Building the logic on the simplest surface first let
us get the data layer, form engine and all 27 charts correct and tested against
real data, without also fighting a component build toolchain. The render layer is a
pure function of the payload, so the port moves delivery only.

### 4.2 Four platform constraints we hit, and what we do about them

These are recorded because they will affect anyone maintaining this, and because a
quality team should see that they were found by measurement rather than assumed.

**1. On-demand data fetching does not work on this surface.** An XHR from a
logged-in browser session to a Scripted REST endpoint never returns, and the
platform's own Table API behaves the same way. Measured, repeatedly.
*Our answer:* compute server-side and embed. This is why the page has no loading
state. It is also why on-demand drilling is gated on section 4.3.

**2. Inline client JavaScript in a UI Page breaks the page silently.** Jelly, the
platform's templating engine, evaluates `<script>` bodies. A CDATA-wrapped one
makes the platform serve the **whole page as zero bytes, HTTP 200, with no error
recorded anywhere.**
*Our answer:* all client JavaScript is a UI Script loaded by reference. The build
tool enforces this and refuses to deploy a page that inlines a script.

**3. Client assets are cached hard and the platform's cache-buster does not
change.** `<g:requires>` appends the platform's release stamp, which is identical
on every deploy. We shipped new renderers three times and browsers kept the old
code, while the deploy tool truthfully reported success. Adding our own `?hash=`
query string did not work either — **ServiceNow strips the `src` attribute and
stores an empty `<script></script>`.**
*Our answer:* the content hash is part of the **asset name**. `cmd_render` deploys
as `cmd_render_8d9fb6103ccc`. New content means a new name, which no cache can
serve stale. Old versions are pruned automatically.

**4. An HTTP 200 from the Table API does not mean the write landed.** It returns
200 whether or not it stored what you sent. We lost two rounds of work to
reporting a fix as deployed while the instance still served the old record.
*Our answer:* every write is read back and compared byte for byte. A status code is
never treated as proof. This is built into the deploy tool, not left to discipline.

**A pattern worth naming, because it caught us twice.** ServiceNow's server-side
JavaScript is Rhino, and platform APIs return Java strings, not JavaScript strings.
On a Java string, `.length` is a *method*, not a property, and `.split('|')` binds
to Java's regex split — where `|` means alternation, so it splits between every
character. That second one silently broke multi-level drilldown: `category:software`
parsed into sixteen drill levels, one per letter. Every page still returned 200 with
a full set of charts. Only the row count gave it away. **Every value that arrives
from a platform API is now coerced to a JavaScript string before use.**

### 4.3 Production: scoped app and UXF components · **Planned**

| Item | Now | Production |
|---|---|---|
| Packaging | Loose records | Scoped app `x_<vendor>_cmd`, clean uninstall |
| UI surface | UI Page (`.do`) | UXF components on a UI Builder experience |
| Navigation | Direct URL | App menu, modules, routed pages, deep links |
| Chart engine | Our own SVG renderer | Custom Apache ECharts build, only used types |
| Promotion | Deploy script | Source Control (Git), **not** Update Sets |
| Roles | Admin-tested only | Named roles, tested per persona |

**Promotion must use Source Control, not Update Sets.** Update Sets do not
reliably carry custom UXF component source — ServiceNow's own community
documentation states the Update Set "will NOT hold your source-code of the
Component Project." There is also a known platform defect (PRB1625935) causing
blank pages after promotion when the parent-app link is not captured. Source
Control in ServiceNow Studio arrived in the Zurich release, so this requires the
client to be on Zurich or later. **This needs confirming against the client's
release at kickoff.**

**The one genuinely open technical question.** Requirement 5 (deep drilldown) needs
data on demand. On-demand fetch fails on the UI Page surface with raw XHR (4.2.1).
A UXF component does not fetch that way — it goes through the platform's data
broker, a different mechanism that the platform's own pages depend on. We do not
know whether it works here, and it is cheap to find out.

This is why the first week of production work is a **gate, not a warm-up**. It must
prove three things: a custom component renders at the approved visual bar, it can
fetch aggregates on demand, and a drill round trip fits the latency budget. If
on-demand fetch works, drilldown is a normal build. If it does not, the fallback is
to precompute one level ahead and accept a round trip for deeper levels — and the
client should hear that answer in week two, not month four.

### 4.4 Support model — state this plainly

**ServiceNow does not support custom components.** Their official FAQ says it
directly: they support the framework, but "will not support any custom components
customers are creating and deploying to their instances, nor will we provide
guidance on creating a custom component."

Whoever delivers this owns the support burden for the custom UI, indefinitely. This
is true of any custom ServiceNow UI, including VividCharts and any in-house build.
It is not a reason not to proceed, but it must be priced and staffed, not
discovered. It is also the strongest argument for the choices made here: plain
JavaScript, a permissively licensed chart engine, and no framework — so the
client's own team, or any future maintainer, can debug it.

---

## 5. Data correctness: the ACL problem

This is the part we would most like audited, because it is both our strongest
technical claim and a real platform gap.

### 5.1 The problem, demonstrated

ServiceNow's fast counting API does not apply row-level permissions.

- `GlideAggregate` does not enforce row-level ACLs. It exposes a table-level
  `canRead()` that a developer must remember to call.
- There is no `GlideAggregateSecure`.
- `GlideQuery.withAcls()` **refuses to aggregate** — it throws rather than answer.

Measured on `dev390988` with a role-less user: `GlideAggregate` returns a count of
**67** where `GlideRecordSecure` returns **0 rows**. Reproduced identically on the
client's own instance.

So the ordinary way to build a KPI tile shows people numbers that include records
they cannot open. This is not theoretical — it is the default outcome of the
obvious implementation.

It also matters commercially: ACL enforcement is a **named rejection criterion** in
ServiceNow's Store certification process.

### 5.2 What we do

Every page computes an **ACL verdict** and shows it. Three outcomes:

| Verdict | Meaning | Shown as |
|---|---|---|
| **Verified** | Permission-checked count equals the raw count. Nothing hidden, nothing over-counted | Green — "ACL verified" |
| **Filtered** | The viewer cannot read some records. They are excluded from every number | Amber — "Filtered to your access", with the count |
| **Bounded** | The check could not finish in budget, so counts are a floor | Amber — "Counts are a lower bound" |

The viewer always knows which of the three they are looking at. Measured today:
`incident`, `change_request` and `problem` return Verified and hold it across
repeated loads.

### 5.3 A bug worth showing you, because it shows the failure mode

The verdict is decided by a permission check under a time budget. To avoid spending
the whole budget to reach "cannot tell", it estimates the full cost early and stops
if it will not fit.

That estimate divided elapsed time by rows read. Elapsed time at row 50 is mostly
one-off setup — the query, the first fetch, the permission evaluator warming up —
so dividing it by 50 charged every row for work that happened once. It read
0.64ms per row against a true 0.208ms, and abandoned checks that fit their budget
three times over.

Because the overestimate raced setup cost, **the same dashboard returned "Verified,
4,266 records" on one load and "Bounded, 50 records" on the next.** A headline
number moving by two orders of magnitude on refresh discredits every other number
on the page.

Our own code comment had reasoned that the early stop "can only ever cause an
earlier Bounded, never a wrong Verified, so the correctness claim is untouched."
That is true and it missed the point: the damage was inconsistency, not
unsoundness.

Fixed by measuring the rate over a window that starts *after* setup, and only
abandoning a check when the projected cost clearly exceeds the budget. The
arithmetic was pulled into a separate function so it can be tested without an
instance — a wrong answer there does not crash, it silently gives up.

We include this because a quality team should see how we handle finding our own
mistakes, and because "the number changes on refresh" is exactly the class of bug
that survives a demo.

### 5.4 What is not yet proven — read this

**Everything above was verified as `admin`.** An administrator sees everything, so
the Verified path is well exercised and the **Filtered path has never run against a
genuinely role-less user.** That path is the whole point of the feature.

The gap is a test fixture, not a design gap — the logic is written and unit-tested.
But until it is run under real restricted personas, we will not claim it works, and
you should not accept that we have. It is the first item in section 12's remaining
work.

**Performance at scale is also unproven.** The correct approach — read securely and
count in memory — is inherently slower than an unchecked database count. It is
tested to roughly 14,000 rows. It has not been tested at 100,000+. If it does not
hold, the fallback is pre-computed aggregates keyed by role set, which is a
materially larger build. That decision should be made on a measurement, and the
measurement has not been taken.

---

## 6. Choosing the analysis: how it works and why we trust it

### 6.1 The evidence this is needed

We read all **2,368 reports** on the instance.

| Finding | Number |
|---|---|
| A datetime field drawn as a single number instead of a time series | **20 of 26** |
| Different chart forms used for the same field, `priority` | **9** |
| Different chart forms used for the same field, `category` | **11** |
| Reports that are a plain count | **75%** |
| Reports with no breakdown at all | **37%** |
| Of 24 available chart types, the share used by the top five | **77%** |

There is no field-to-chart mapping stored anywhere on the instance, because the
platform has no such logic. `sys_report.type` records what an author picked, not
what the data warranted.

**This is the strongest argument in the product because the client can check it
themselves on their own instance.**

### 6.2 The same idea applied to drilldown

The obvious way to build drilldown is to use the schema's declared hierarchies —
Category to Subcategory. We measured what that produces.

On `incident`, 13,986 records: **subcategory is set on 42 of them.** It is empty on
99.70%. A leader clicks into Software, which holds 2,651 incidents, and lands on a
level where 99.3% are "(none)".

It is not universal, which is the point. On `change_request`, Category to Type is
fully populated with a healthy distribution.

**The conclusion, one level up: the platform's stored metadata records what an
author intended, not what is true of the data.** `sys_report.type` records a chart
someone picked. `sys_dictionary.dependent_on` records a hierarchy someone intended.
Neither is a property of the rows. Both must be measured.

So a drill level is offered only after passing fill-rate and cardinality gates **on
the viewer's own permitted rows** — otherwise the drill menu itself leaks the shape
of data the viewer cannot see. A rejected level shows its reason rather than a
dead-end click. A leader who learns their subcategory field is unused has learned
something more useful than a broken click.

### 6.3 Drilldown today · **Built** (in-page), depth 3

Measured live:

| Level | Path | Records | Next levels offered |
|---|---|---:|---|
| 0 | (top) | 4,266 | escalation, active, category |
| 1 | `category=software` | 1,112 | escalation, active, impact |
| 2 | `category=software`, `priority=3` | 502 | active, impact |

The path is in the URL, so a drill state is shareable and the back button reverses
it. Fields drop out of the menu once used. The verdict stays Verified at every
level. Drilling gets *faster* with depth, because fewer rows remain to check.

The terminal step hands off to the **platform's own record list** with the real
query. This is the one place where being inside ServiceNow beats Power BI: the
platform enforces row-level security on that list, so we neither build a record
grid nor have to get its security right. Power BI's equivalent is a copy of the
data under a different security model.

---

## 7. Performance

The client raised loading speed twice, so it is a numbered budget we can fail
against.

| Gate | Target | Measured today | Status |
|---|---|---|---|
| First paint | < 1.2s | — | Not yet measured on the real surface |
| Interactive | < 2.5s | **4–12s** | **Fails** |
| Payload size | ≤ 250 KB gzipped | ~24 KB typical | **Passes**, 10x inside budget |
| Drill round trip | < 400ms | in-page rebuild, 4–5s | **Fails** |
| Repeat visit from cache | assets cached | Content-hashed names | **Passes** |

**We are not going to present this as met.** Typical pages are 4–9 seconds and the
worst measured is 12.4. That is three to five times over budget on a concern the
client named explicitly.

**Where the time goes.** Roughly 3–6 seconds is server-side payload building,
dominated by permission-checked reading. The rest is transport of a 70–240 KB HTML
document. Progress so far: the worst page was 39 seconds before the shared-scan
work, so this is 3x better than it was, and still not good enough.

**One wrong theory, recorded.** We suspected query planning was unbounded on wide
base tables like `task`. Measured: 8–27ms everywhere. The real cause was a
permission-check routine that charged the page's time allowance without checking
it, so late work ran after the budget was already spent.

**What closes the gap.** The main lever is that the ACL verdict and field profiles
are recomputed on every single page load, to reach the same answer. Caching them
per (role set, table, filter) with a short expiry removes most of the server time.
We have deliberately **not** shipped that yet: it puts a cache in the permission
path, and the cache key and expiry are a correctness decision about what happens
when someone's roles change — not a performance tweak. It needs to be designed and
reviewed, and it is scoped in section 12.

Secondary levers, all standard: a custom ECharts build with only the used chart
types, deferring below-fold panels, and canvas rendering above roughly 1,000 marks.

---

## 8. Security and data protection

### 8.1 Nothing leaves the instance

**No runtime request to any host outside the instance.** Not for fonts, not for a
chart library, not for telemetry. Fonts are subsetted and embedded. All CSS and
JavaScript is inlined or served from platform records.

This is a data-protection rule, not a licensing one. Loading a font from a public
CDN transmits every viewer's IP address to a third party on every dashboard load —
which European case law has found to be a violation for Google Fonts specifically.
The people affected would be the client's own employees.

The rule in one line: **code and fonts travel in, data does not travel out.**

### 8.2 AI: optional, off by default, and never sees a record

The client asked whether data is safe going through MCP. Two different things are
being asked about, and they should not be conflated.

**MCP is a build-time tool.** It runs on our workstation against a development
instance with demo data. It is how the measured findings in this document were
obtained. **Nothing we ship contains an MCP client**, and it must never be pointed
at production data.

**AI in the product is a separate question.** Our position:

| Option | Where data goes | New agreement needed |
|---|---|---|
| Now Assist (ServiceNow-hosted) | Stays inside ServiceNow, under the existing agreement | **No** |
| Client's own LLM tenant | Stays inside the client's own cloud | No new vendor |
| Direct call to a third-party API | Leaves the client's control | **Yes**, plus review |

We recommend supporting the first two and **not** the third. For a good-to-have
feature it invites exactly the objection already raised.

**The structural point:** the AI layer never needs to see a record. The shape
profiler works on field names, types, distinct counts and fill rates — schema
statistics. A narrative layer would work on aggregate values already on screen.
Neither needs a row, a description, a customer name or a work note.

So: **no record-level data is sent to any model, in any configuration.** This is
enforced by the adapter's input type carrying no record payload, so there is
nothing to leak by mistake — not by convention.

**AI is off by default and ships after the design is live.** That is the client's
own stated priority order. The headline feature — data-driven chart selection — is
a deterministic rule table with no AI dependency, no model cost and no
data-protection exposure.

---

## 9. Third-party components and licensing

The client's first and most emphatic concern. Every component in the design is
under a licence that permits exactly what we are doing, with nothing to buy.

| Component | Licence | Redistribution | Patent grant |
|---|---|---|---|
| Space Grotesk | SIL OFL 1.1 | Yes | n/a |
| Inter Tight | SIL OFL 1.1 | Yes | n/a |
| JetBrains Mono | SIL OFL 1.1 | Yes | n/a |
| Apache ECharts | Apache 2.0 | Yes | **Express grant** |

Two details answer the concern better than a general reassurance:

**The fonts are checked, not assumed.** We subset the fonts, and subsetting counts
as modification under the OFL. The OFL forbids a modified font from using a
Reserved Font Name — so we checked the actual licence files. **None of the three
declares a Reserved Font Name.** Subsetting while keeping the family name is
therefore compliant. Licence texts are checked in at `design/LICENSES/`.

**Apache 2.0 is a stronger position than MIT.** It carries an express, irrevocable
patent grant from every contributor — which is the specific protection against the
scenario the client described, a contributor later asserting a claim over code they
contributed. ECharts is an Apache Software Foundation project, so contributions
arrive under the ASF's contributor agreement and provenance is documented.

**Two compliance actions.** Ship the LICENSE and NOTICE contents inside the app,
and do not name the product or any feature "ECharts" — the name is an ASF
trademark. Also: some ECharts internals derive from d3 under BSD 3-Clause, which
carries its own attribution requirement.

### 9.1 The real risk is a future component, so we gate it · **Planned**

Nothing currently in the design is a licensing problem. The realistic failure is
someone later reaching for Highcharts because one visual is easier there, or a
licensed foundry font because it looks better. Highcharts needs a quote-only OEM
licence if embedded in something distributed to and hosted by customers — exactly
the Store scenario. The other version is copyleft: a GPL or AGPL transitive
dependency can reach the whole distributed work.

**Neither is solved by being careful. They are solved by a gate.**

- **`THIRD-PARTY.md`**, generated not hand-maintained, one row per component with
  name, version, licence, source and where its licence text ships. This is what
  procurement will ask for and what Store certification requires.
- **An allowlist enforced in CI.** Permitted: MIT, ISC, BSD-2/3, Apache-2.0, SIL
  OFL 1.1, CC0, Unlicense. Denied: GPL, LGPL, AGPL, SSPL, source-available,
  non-commercial, and anything commercial without a signed redistribution right on
  file. The build fails on a licence not on the list, including transitive
  dependencies.

This turns a standing anxiety into a check that either passes or does not. It is
not yet built and it should be built early, because it is cheap now and expensive
to retrofit.

**Not yet done: the wider IP review.** Fonts and libraries are settled. Colour,
layout, chart forms, icons, software patents and the product-name trademark have
**not** been reviewed. This is scoped in section 12.

---

## 10. Design governance

The client's UI standards document requires adherence to the Now Design System and
prefers built-in UI Builder components, allowing custom UI **only where a business
requirement cannot be met by standard components.**

Our position, using that document's own exception clause:

**"Beautiful, impressive, Power-BI-like" is precisely the class of requirement
built-in components cannot meet.** The modern chart palette is 24 types — a
respectable number, and we will not argue from count. We argue from *kind*: there
is no treemap, sankey, sunburst, network, radar, waterfall, stream, bump or
histogram in the modern surface, the visual treatment is fixed, and there is no
free-form canvas. Native AI chart generation is capped at five chart types.

So we go custom on **rendering** and stay compliant on **everything else**:

- Custom components consume Now Design System tokens for colour, type and spacing,
  so the result sits inside the platform's design language even though the chart
  engine is ours.
- **No built-in component is ever modified.** Net-new components only, so upgrades
  stay safe.
- Every custom-versus-standard deviation is recorded with its justification. That
  register is a compliance asset.

**What we do not claim.** This is not true Power BI parity. There is no
cross-source semantic modelling, no DAX-equivalent calculated measures, and no
arbitrary end-user ad-hoc exploration. The honest description is: **Power-BI-grade
visual and interaction quality on ServiceNow-native data, with automated chart and
drill selection that Power BI does not do.**

---

## 11. Testing

| Suite | Assertions | What it protects |
|---|---:|---|
| `test_data_helpers.js` | 72 | Date arithmetic, quantiles, binning, correlation, cost projection |
| `test_form_engine.js` | 42 | Every gate and caveat rule |
| `test_render_coverage.js` | 14 | All 27 forms map to distinct renderers |
| `test_render_edges.js` | 27 forms / 116 cases | Empty, single-value, huge, negative, malformed input |
| `test_render_live.js` | 71 | Real renderers over real captured payloads |
| `smoke_live.py` | live | The deployed instance over HTTP |
| **Total offline** | **226** | Runs in seconds, no instance needed |

**Two things about this suite are worth an auditor's attention.**

**It is tested against its own blind spots.** We deliberately broke renderers to
see whether the suite noticed. It did not: node counts stayed healthy while a
chart silently drew one series and discarded the rest. The suite now asserts that
every series, stage and row in the payload actually appears in the output. A test
suite that has not been attacked is an assumption.

**`smoke_live.py` exists because every offline suite passed while the instance
served a stale renderer.** A fixture cannot tell you what the browser was handed.
It checks for zero-byte 200s, leaked platform error traces, unsubstituted build
placeholders, assets referenced but not present, drilldown actually filtering, and
the ACL verdict staying identical across repeated identical requests.

**Note on ATF.** ServiceNow's Automated Test Framework does not cover custom UXF
components with parity to classic forms — stated in ServiceNow's own community
blog. Automated regression testing for this product cannot lean on ATF. The suite
above is the primary mechanism; ATF covers only what it can reach. This is a
budgeted workstream, not an oversight.

---

## 12. Status and remaining work

### 12.1 Built and measured on `dev390988`

| Item | Evidence |
|---|---|
| 6 architecture layers, 6,420 lines server + 3,075 client | Deployed, readback-verified |
| 27 chart forms, all rendering from real records | Verified live across 11 tables |
| Form engine with gates and caveats | 42 tests |
| Catalog, permission-scoped | 12 subjects offered from 30 considered, stable across loads |
| Multi-level drilldown, depth 3, shareable URL | 4,266 → 1,112 → 502 |
| Drill-through to platform record list | Real query handed off |
| ACL verdict, three states, always shown | Verified and stable on 3 tables |
| Cross-panel filtering, tooltips, table view, light/dark | Deployed |
| Time-window slicer, 3/6/12/24 months | Deployed |
| Deploy tool with byte-for-byte write verification | 18 checks pass |
| 226 offline assertions + live smoke test | All green |
| Payload size | ~24 KB gzipped vs 250 KB budget |

### 12.2 Remaining to production

Estimates are person-weeks and assume one engineer. Several items can run in
parallel.

| # | Work | Why it matters | Estimate |
|---|---|---|---:|
| 1 | **Multi-user ACL testing under real restricted personas** | The Filtered path is the lead differentiator and has never run | 0.5 |
| 2 | **Performance: cache the ACL verdict and profiles** | Closes most of the 4–12s gap | 1 |
| 3 | **UXF spike — the gate.** Render quality, on-demand fetch, drill latency | Decides whether deep drilldown is buildable as specified | 1 |
| 4 | **Scoped app skeleton**, roles, tables, clean uninstall | Nothing ships as loose records | 1 |
| 5 | **`THIRD-PARTY.md` + CI licence gate** | Client's first concern; cheap now | 0.5 |
| 6 | **Port render layer into UXF components**, ECharts build | The production UI surface | 1.5–2 |
| 7 | **On-demand drilldown** (shape depends on #3) | Requirement 5 in full | 2–3 |
| 8 | **Navigation**: experience, routes, app menu, deep links | Product, not a page | 0.5–1 |
| 9 | **Accessibility completion, performance pass, upgrade regression** | Release quality | 2 |
| 10 | **Wider IP review**: colour, layout, chart forms, icons, patents, product name | Not started | external |
| 11 | **Load test the secure path at 100k+ rows** | Decides if the fallback is needed | 0.5 |
| | **Total** | | **~11.5–14.5** |

Not included: Store certification (3–5 week external review), and the pre-computed
aggregate fallback if item 11 fails, which is a materially larger build.

---

## 13. What is still wrong

Stated plainly, because a document that hides these is worth less than one that
does not.

1. **Latency is 3–5x over budget.** 4–12 seconds against 1.2s/2.5s. Fix scoped
   (12.2 #2), not applied.
2. **The Filtered ACL path is unproven.** Everything verified as `admin`. This is
   the lead differentiator.
3. **Two tables give an unstable verdict.** `kb_knowledge` and `cmdb_ci` sit close
   enough to the time budget that repeated loads disagree. Same fix as #1.
4. **It is not ECharts yet.** The renderer is ours. The ECharts decision stands but
   the port is not done, so its bundle size is unmeasured.
5. **It is a UI Page, not a UXF component.** The production surface is unproven, and
   on-demand fetch — which deep drilldown needs — is an open question.
6. **The secure path is untested above ~14,000 rows.**
7. **No licence gate in CI yet**, and the wider IP review has not started.
8. **One table shows a near-empty dashboard.** `sc_request` has one record on this
   instance. The engine correctly refuses to chart it and says why, but the page
   looks bare behind a catalog card.

---

## 14. What we need from the client

| # | Need | Blocks |
|---|---|---|
| 1 | Instance release version | Source Control promotion needs Zurich or later |
| 2 | Test accounts under **real restricted roles** | The entire Filtered ACL proof |
| 3 | Which subject areas ship first | Reporting demand is broader than ITSM — GRC, risk and audit together outweigh Incident |
| 4 | Default theme, light or dark | Both ship; dark is the flagship |
| 5 | Font strategy: full set (~188 KB) or reduced (~a third) with body text on the platform sans | A visible design trade-off, so the client's call |
| 6 | How deep they actually drill in Power BI today | Confirms the depth-3 cap |
| 7 | Whether AI ships in v1 at all | We recommend deferring until the design is live |
| 8 | Whether Store distribution is a goal | Changes certification and licensing obligations |

---

## 15. Method note

Every measurement in this document was taken on `dev390988` between 2026-07-29 and
2026-08-05. The 2,368-report inventory was read from `sys_report`. The ACL
demonstration (67 versus 0) was run as a background script and reproduced on the
client's own instance. Drilldown figures come from live page fetches. Latency
figures are wall-clock from an external network to a shared development instance,
so they include real network transport and are not a clean server benchmark.

Bundle sizes for the ECharts production build are deliberately **not** quoted —
they are a measurement the UXF spike owes, and quoting them from memory is how
performance budgets get missed.

Where this document says a thing is not proven, it is not proven. We would rather
be held to that than to a claim that does not survive your audit.
