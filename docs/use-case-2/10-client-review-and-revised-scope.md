# Client review, 2026-08-03: revised scope and the build picture

The design was presented and accepted. The client's words: ServiceNow could never
do this natively. That settles the question the engagement has been stuck on since
the POC was called a dumb stub, and it means the visual bar in
`design/command-brand-kit.html` is now the approved target rather than a proposal.

Five things came out of the session. One is a hard constraint we did not have
before, one is a large scope addition, one is a question we have to answer
convincingly, one is a repositioning of the pitch, and one is a quality bar.

| # | What the client said | What it is | Effect on the plan |
|---|---|---|---|
| 1 | Be very cautious about third-party fonts, libraries and design assets deployed inside ServiceNow | Hard constraint, raised first and most emphatically | New required deliverable: a third-party component register with an enforced allowlist |
| 2 | We need Power BI style drilldown through many sub-layers, and all the options a custom analysis tool has | Large scope addition | Promotes the phase 1 UXF spike from de-risking to gating |
| 3 | Is our data safe through MCP, and how would AI work inside the portal | Question to answer, not work to do | Architecture position, written down, defaults to off |
| 4 | Data-driven analysis is the feature he liked; leaders should stop hand-building charts | Repositioning | This is now the headline of the pitch, not a supporting detail |
| 5 | Performance and loading speed, everywhere in the portal | Quality bar | Named budget with measured gates, and it collides with #2 |

Sections 1 to 5 take these in turn. Section 6 covers the technical path, which the
client explicitly did not care about and which we therefore have to be more
careful about, not less. Section 7 lists what changes in
`09-build-plan.md`. Section 8 lists the decisions still open.

---

## 1. Third-party licensing: the risk they named, and the risk that is actually there

The concern as stated was that a third party could claim copyright over their work
being used inside ServiceNow, and that this becomes a large licensing problem.
That instinct is right to have, but the specific mechanism is worth separating
from two adjacent risks that are more likely to bite.

### 1.1 What is already resolved, and verified

Every asset currently in the design is under a licence that permits exactly what
we are doing, with no royalty, no per-seat fee, and nothing to purchase or clear.

| Component | Licence | Permits self-hosting and commercial redistribution | Patent grant |
|---|---|---|---|
| Space Grotesk | SIL OFL 1.1 | yes | n/a |
| Inter Tight | SIL OFL 1.1 | yes | n/a |
| JetBrains Mono | SIL OFL 1.1 | yes | n/a |
| Apache ECharts | Apache 2.0 | yes | **express grant** |
| D3 (if used) | ISC | yes | no |
| Motion One (if used) | MIT | yes | no |

Two details here are worth putting in front of the client because they answer the
question more strongly than a general reassurance would.

**The OFL is the licence that most explicitly permits our exact case.** It grants
the right to use, study, modify, embed and redistribute the fonts, including as
part of a larger commercial work, and including bundled inside software. Its
conditions are that the copyright notice and licence text travel with the font
files, that a modified font cannot be sold on its own, and that a modified version
cannot use a Reserved Font Name without permission. We checked the last one
against the actual licence files rather than assuming: **none of the three fonts
declares a Reserved Font Name.** The copyright lines are plain, with no `with
Reserved Font Name` clause, which is the convention Google Fonts standardised on.
That matters because we do modify the fonts, by subsetting them to the glyphs the
document uses, and subsetting is a modification under the OFL's definition. With
no Reserved Font Name declared, subsetting while keeping the family name is
compliant. The licence texts are checked in at `design/LICENSES/`.

**Apache 2.0 on the chart engine is a stronger position than MIT would be.** It
carries an express patent grant from every contributor, which is the specific
protection against the scenario the client described: a contributor later
asserting a claim over code they contributed. ECharts is also an Apache Software
Foundation project, so contributions arrive under the ASF's contributor licence
agreement and the provenance chain is documented rather than assumed. If the
client wants one sentence on this, it is: the chart engine is licensed under
Apache 2.0 by the Apache Software Foundation, which includes an irrevocable
patent grant, and there is no commercial licence to buy or breach.

### 1.2 The risk that is actually more likely: a commercial component arriving later

Nothing in the current design is a licensing problem. The realistic failure is a
future one. Someone reaches for Highcharts because a specific visual is easier
there, or for AG Grid Enterprise for the matrix, or drops in a licensed
foundry font because it looks better, and none of those are free to redistribute
inside a product the client hosts. Highcharts in particular needs an OEM licence,
quote-only, if it is embedded in something distributed to and hosted by customers,
which is precisely the Store scenario.

The other version of this is copyleft. A GPL or AGPL component pulled in as a
transitive dependency is the actual "huge licensing issue" the client is worried
about, because it can reach the whole distributed work.

Neither of these is solved by being careful. They are solved by a gate.

### 1.3 What we build: a register and an enforced allowlist

**Deliverable: `THIRD-PARTY.md` in the app repo,** one row per component, with
name, version, licence, upstream URL, why it is needed, and where its licence text
ships inside the app. This is the document the client's legal or procurement
function will ask for, and it is also what ServiceNow Store certification requires
if the app is ever published.

**Allowlist, enforced in CI rather than by review.** Permitted: MIT, ISC, BSD 2 and
3 clause, Apache 2.0, SIL OFL 1.1, CC0, Unlicense. Denied outright: GPL, LGPL,
AGPL, SSPL, anything source-available or non-commercial, and anything commercial
without a signed redistribution right on file. The build fails on a licence that
is not on the list, including transitive dependencies. This turns a standing
anxiety into a check that either passes or does not.

**Licence texts ship inside the app.** Not linked, shipped. The OFL and Apache 2.0
both require the notice to travel with the work. Concretely this means the scoped
app carries the licence texts as a record the app installs, and the register points
at them.

### 1.4 The risk the client did not name, which is the one that has teeth

Loading a font or a library from a CDN is not primarily a licensing problem. It is
a data-protection problem, and it is a live one: serving Google Fonts from
Google's servers has been found to transmit visitor IP addresses to a third party
without consent in European case law. On a ServiceNow instance, the people whose
IP addresses would be transmitted are the client's own employees, on every
dashboard load.

This is the same boundary as the standing rule for this engagement, which is that
code and fonts travel in and data does not travel out. So it is already settled in
principle, and as of this commit it is settled in fact: the brand kit makes **zero
external requests**. Fonts are self-hosted and subsetted, all CSS and JS is inline,
and the page renders identically on an air-gapped network. That is verified, not
asserted, at five viewport widths.

The rule for the ServiceNow artifact is the same and is not negotiable: no runtime
request to any host outside the instance. Not for fonts, not for a chart library,
not for a telemetry beacon.

---

## 2. Drilldown: the largest addition, and it collides with performance

The client wants what Power BI gives them: click into a value and keep going down
through sub-layers, plus the general set of affordances a custom analysis tool has.
This was not in scope before. It is a substantial build, and one measured fact
changes how it has to be designed.

### 2.1 What we owe, concretely

Power BI's drill surface is a set of distinct behaviours, not one feature. Mapped
to what we are building:

| Behaviour | What it means here | Cost |
|---|---|---|
| Drill down in place | Click a bar, the same chart re-renders one level deeper, scoped to the clicked member | High: needs a hierarchy and a payload per level |
| Drill up and breadcrumb | The path is visible, reversible, and encoded in the URL so a drill state is shareable | Low once drill down exists |
| Drill through to records | The terminal level lands on the record list, filtered to the exact slice | **Low, and this is a native advantage** |
| Cross-filter | Selecting a member filters the other panels on the page | Medium |
| Expand and collapse in the matrix | Already specified in the report matrix | Already designed |
| Rich hover | A small report on hover, not one number | Already designed |
| Show as table | Every chart has a table view, for accessibility and for export | Low, already required by the a11y workstream |

The drill-through row is worth pausing on because it is the one place where being
inside ServiceNow is a genuine advantage over Power BI rather than a constraint.
The terminal drill target is the **standard platform list view** with an encoded
query. We do not build a record grid, we do not paginate, we do not re-implement
sorting, and most importantly **we do not have to get row-level security right,
because the list view already does**. Power BI's equivalent, drill to detail rows,
is a copy of the data sitting in a different security model. Ours is the record,
in the platform, under the platform's ACLs. That is a real selling point and it is
also less work.

### 2.2 The measured problem: declared hierarchies are mostly empty

> ⚠️ **Re-measured 2026-08-15, and the example below is now false on this
> instance.** The figures in this section (13,986 incidents, 42 with subcategory
> set, 99.7% empty) were measured on 2026-08-03, before this engagement's own
> demo seeding and reshaping ran. Measured live today:
>
> | | 2026-08-03 | 2026-08-15 |
> |---|---|---|
> | incidents | 13,986 | **4,266** |
> | subcategory set | 42 | **2,175** |
> | fill rate | 0.3% | **51.0%** |
> | distinct subcategories | not recorded | **18** |
>
> **Do not demonstrate this section's example live.** At 51% fill with 18 distinct
> values the gate will now *offer* the category-to-subcategory drill, so the
> document and the screen would contradict each other in front of the client. The
> seeding this engagement ran is what changed it.
>
> **The design conclusion is unaffected and is worth separating from the example
> that motivated it**: a drill level must be offered on measured fill and
> cardinality over the viewer's own permitted rows, never on the dictionary's
> declaration alone. That the same instance moved from 0.3% to 51% on the same
> declared hierarchy in twelve days is, if anything, a stronger argument for
> measuring than the original 99.7% was — a declaration that was equally true on
> both dates predicted neither. Use `change_request` category-to-type, which was
> fully populated on both measurements, if a live example is needed.

The obvious way to build this is to read the dictionary's dependent-field
declarations, which is where `category` to `subcategory` lives, and use them as
the drill hierarchy. We checked what that would actually produce.

On `incident`, 13,986 records, measured 2026-08-03:

| category | subcategory | records |
|---|---|---:|
| inquiry | *(empty)* | 3,729 |
| software | *(empty)* | 2,633 |
| hardware | *(empty)* | 2,567 |
| network | *(empty)* | 2,430 |
| password_reset | *(empty)* | 2,237 |
| *(empty)* | *(empty)* | 340 |
| software | email | 11 |
| software | os | 7 |
| network | vpn | 6 |
| database | db2 | 4 |
| network | dhcp | 4 |
| ... 11 more rows, none above 4 records | | |

That is the complete result, 22 rows against a limit of 40, so nothing is
truncated. **Subcategory is set on 42 of 13,986 records. It is empty on 13,944,
which is 99.70%.** The hierarchy is declared in the dictionary and populated in
0.3% of the data. There is also visible dirt in the tail: free text like `Outlook`
and `Outllook SPA mailbox`, plus `undefined` and `network alert` as categories.

A naive implementation of the client's request produces this: a leader opens a
beautiful chart, clicks into Software, which holds 2,651 incidents, and lands on a
level where 2,633 of them, 99.3%, are "(none)". That is the dumb stub failure
again, expressed as an interaction instead of a chart.

It is not universal, which is the important part. On `change_request`, the
`category` to `type` pair is fully populated across all 238 records, with a healthy
distribution. So drill quality is a property of a specific field pair on a specific
table, and it varies enormously.

**The conclusion is the same one the chart-form work reached, one level up: the
platform's stored metadata records an author's intent, not a property of the data.**
`sys_report.type` records which chart someone picked. `sys_dictionary.dependent_on`
records that someone intended a hierarchy. Neither tells you whether it is true of
the rows. Both have to be measured.

### 2.3 The design that follows

A drill path is discovered and then gated on measurement, exactly like a chart
form. Candidate levels come from three sources, in order:

1. **Dictionary dependent fields.** `category` to `subcategory`. A declared
   parent and child.
2. **Reference chains.** Dot-walking gives free hierarchies: `assigned_to` to its
   department, `cmdb_ci` to its business service. These are often better populated
   than the declared choice hierarchies.
3. **Any dimension that profiles well.** Not a hierarchy in the schema, but a
   legitimate next question. Priority inside Category is a useful drill even
   though nothing declares it as a child.

Every candidate then passes gates before it is offered:

```
offer(parent_slice, child_field):
    fill      = non_empty(child_field, parent_slice) / count(parent_slice)
    distinct  = distinct(child_field, parent_slice)

    if fill < 0.60                       -> do not offer, reason: sparse
    if distinct < 2                       -> do not offer, reason: single value
    if distinct > 50                      -> offer as search, not as a chart level
    if field is free text, unindexed      -> do not offer, reason: not a dimension
    otherwise                             -> offer, form chosen by the shape profiler
```

Two rules make this honest rather than merely clever.

**A dead end is never dressed as a drill.** If no child level clears the gates, the
affordance is not rendered as an enabled control that disappoints. The panel says
what it can do, which is drill straight through to the records, and if a level was
considered and rejected the reason is available: subcategory is empty for 99.3% of
these records. A leader who learns that their subcategory field is unused has
learned something worth knowing, which is more useful than a broken click.

**The gates run against the viewer's own permitted rows, not the table.** Fill rate
and distinct count are computed on the slice the viewer can actually read.
Otherwise the drill affordance itself leaks the shape of data the viewer is not
entitled to, and the counts behind it are the same ACL problem the engagement
already has a position on.

### 2.4 Where this collides with performance, and why it changes priorities

Drilldown is interactive by nature: it needs data on demand, in response to a
click. The measured constraint on this instance is that an XHR from a logged-in
browser session to a Scripted REST endpoint never returns, and the platform's own
Table API behaves the same way. The current architecture works around that by
computing server-side and embedding the payload, which is genuinely good for first
paint, one round trip and no waterfall, and useless for drilling.

That leaves three options:

| Option | Cost | Verdict |
|---|---|---|
| Precompute every drill level into the initial payload | Payload grows multiplicatively with depth and breadth | Fails the client's loading-speed bar |
| Fetch each level on demand | One round trip per drill, needs a working data path | Correct, if a data path exists |
| Precompute one level ahead, fetch deeper levels | Bounded payload, instant first drill, round trip after | Right answer if on-demand works at all |

The important thing is that the failure was measured on the **UI Page** surface,
using raw XHR. A UXF component does not fetch that way. It goes through the
platform's own data broker and GraphQL layer, which is a different mechanism, and
one the platform's own pages depend on. So it is genuinely unknown whether the
constraint applies there, and it is cheap to find out.

**This is what changes the priority.** The phase 1 UXF spike was already the right
first move because it de-risked the port. It is now the gate on whether the
client's second requirement is achievable at all. One week of work answers: can a
custom UXF component fetch aggregate data on demand, on this instance, in a logged
in session. If yes, drilldown is a normal build. If no, we owe the client that
answer in week two, with the precompute-one-level-ahead fallback and its honest
limits, rather than in month four.

The spike now has to prove three things, not one: that a custom component renders
at the approved visual bar, that it can fetch on demand, and that a drill round
trip completes inside the interaction budget in section 5.

---

## 3. AI: the data-protection answer, and why the design already makes it easy

AI is a side track by the client's own framing and by ours. It is good to have,
not mandatory, and the main goal is getting the approved design live. So the work
here is to have a defensible answer ready, not to build anything yet.

### 3.1 Separate build time from run time, because the client's question conflates them

The question was whether data is safe when going through MCP. Two different things
are being asked about.

**MCP as we use it today is a development tool.** It runs on our workstation,
against a development instance carrying demo data, and it is how the measured
findings in this document and in `08-live-report-inventory.md` were obtained. It
sends query results to an external model provider. For a dev instance with demo
data that is an acceptable engagement practice. It is not an architecture, it is
not part of the product, and it must never be pointed at production data. Nothing
we ship contains an MCP client.

**AI inside the delivered product is a separate question** with three possible
shapes, and they have very different paperwork.

| Shape | Where data goes | New DPA needed | Capability |
|---|---|---|---|
| Now Assist, ServiceNow-hosted models | Stays inside the ServiceNow boundary, under the client's existing ServiceNow agreement | **No** | Prescriptive, limited, but free of friction |
| Generic AI connector, customer's own LLM tenant | Leaves ServiceNow, stays inside the client's own cloud tenant | No new vendor, client already owns it | Good, but client must own and pay for the LLM |
| Direct outbound to a third-party API from the scoped app | Leaves the client's control boundary entirely | **Yes**, plus residency and security review | Best capability, worst friction |

Recommendation: build the AI layer as an **optional, pluggable adapter that
defaults to off**, and support shapes 1 and 2. Shape 3 is not worth the friction
for a good-to-have feature, and offering it invites the exact objection the client
already raised.

### 3.2 The design decision that makes this answerable in one sentence

The important point, and it is a consequence of how the form engine already works
rather than something we need to add: **the AI layer never needs to see a record.**

The shape profiler operates on field names, data types, distinct counts, fill
rates and concentration. Those are schema statistics. The narrative layer, if we
build it, operates on aggregate series, which are the same numbers already
rendered on the screen. Neither needs a row, a description field, a customer name,
or a work note.

So the answer to the client is: no record-level data is sent to any model, in any
configuration. What a model can see is field names, type information, distribution
statistics, and the aggregate values already displayed on the dashboard. If they
want a stronger version, shape 1 keeps even that inside the ServiceNow boundary.

This should be written into the adapter as an enforced boundary, not a convention:
the adapter's input type carries no record payload, so there is nothing to leak by
mistake.

### 3.3 What does not change

The engagement's differentiators stay where they were. Autonomous metric candidacy
and shape-adaptive form selection are the interesting parts, and neither requires
an LLM at runtime: the form engine is a deterministic rule table over measured
statistics, which is why it can be regression-tested against all 2,368 live
reports. That is worth being clear about internally, because it means **the
headline feature the client liked has no AI dependency and no data-protection
exposure at all.** Which is the next section.

---

## 4. Data-driven analysis is the pitch now

The feature the client responded to is the one where numerical and time series
data produce the analysis appropriate to them, without a person choosing charts.
Their framing of the goal: leaders should spend their time on the analysis, not on
building the charts and then working out what they mean.

That is the strongest thing we have, and it should lead. Three reasons to
reposition around it deliberately.

**It is the part with hard evidence behind it.** The instance draws a datetime
field as a scalar 20 times out of 26, and never once as a line, trend, spline or
area. It draws `priority` nine different ways and `category` eleven. There is no
field-to-form mapping stored anywhere, because the product has no such logic.
That is measured, from 2,368 live reports, and it is a much better argument than
any claim about visual quality because the client can check it themselves.

**It has no AI dependency.** The selector is a flat rule table over measured
statistics: field type, distinct count, top share, concentration, row count,
aggregate function. Deterministic, reviewable, and testable. So the feature the
client likes most is also the one with no data-protection question, no model cost,
and no vendor risk. Say that out loud in the next conversation.

**Section 2 extends it rather than sitting beside it.** The drill path is chosen
the same way as the chart form, from the same profiler, gated on the same kind of
measurement. So drilldown is not a second feature bolted on; it is the same idea
applied to the next question down. That is a much better story than a feature
list, and it is true.

What to emphasise, in the client's own terms: they do not pick a chart type, they
do not build a hierarchy, and they do not configure a drill path. They pick a
subject. The system measures the data and offers the analysis that data supports,
including telling them when it does not support one.

The honest boundary stays where it was. This is not cross-source semantic
modelling, not DAX-equivalent calculated measures, and not arbitrary end-user
ad-hoc exploration. It is Power BI grade visual and interaction quality over
ServiceNow-native data, with automated form and drill selection that Power BI does
not do.

---

## 5. Performance: a named budget, because they asked twice

The client stressed loading speed and general responsiveness. Turning that into
numbers we can fail against.

| Gate | Target | How it is met |
|---|---|---|
| First contentful paint | < 1.2 s | Payload computed server side and embedded, so one round trip and no fetch waterfall |
| Interactive | < 2.5 s | Charts initialise progressively, below-fold panels deferred |
| Initial payload | <= 250 KB gzipped | Panel count cap, series truncation into Other, one level of drill precomputed |
| Drill round trip | < 400 ms to first paint of the new level | Aggregate-only response, no record payload |
| Chart engine bundle | Measured, then budgeted | **Custom ECharts build**, only the used chart types and one renderer, not the full distribution |
| Frame rate on drill and hover | 60 fps | Canvas renderer above roughly 1,000 marks, SVG below; no layout thrash on hover |
| Repeat visit | Assets from cache | Content-hashed asset URLs, already solved in `build_deploy.py` |

Four notes on how these are actually achieved rather than hoped for.

**The chart engine is the single biggest lever and the easiest to get wrong.**
ECharts shipped as its full distribution is large enough to dominate the budget on
its own. Imported as individual chart and component modules with one renderer, it
is a fraction of that. The exact figures need measuring on the real bundle rather
than quoting from memory, and that measurement belongs in the phase 1 spike
alongside everything else.

**The techniques are already proven in the brand kit, not theoretical.** The
render-budget work there is measured: `mix-blend-mode` and `backdrop-filter` were
removed because a full-viewport blend layer forces the compositor to read back
everything beneath it on every paint, `content-visibility: auto` defers below-fold
layout, and coloured drop-shadow filters were removed because SVG filters scale
badly per mark. Those decisions carry directly into the component.

**Fonts inside the instance are a real byte cost that needs a decision.** The
subsetted set is 188 KB across ten files, which is fine over HTTP from GitHub
Pages but has to be inlined or attached inside a scoped app. Recommendation: on
the ServiceNow artifact, inline the display face at two weights and the mono at
one or two, and let body text use the platform's existing sans. That is roughly a
third of the bytes for nearly all of the visual character. It is a deviation from
the brand kit and it should be a conscious one, so it is listed in section 8.

**The 99.7% finding is also a performance argument.** Not offering a hollow drill
level is one fewer query, one fewer round trip, and one fewer render. Measuring
the data first is faster than drilling into it and finding out.

---

## 6. The technical path

The client did not care about this, which is exactly why it needs to be right.
A product that impresses in a demo and then cannot be installed, upgraded or
supported is a worse outcome than a plain one that can.

Most of this is already specified in `09-build-plan.md` sections 2 and 3, and it
does not change. The delivery target is a scoped application, `x_<vendor>_cmd`,
with custom UXF components on a real UI Builder experience, routed pages, app menu
and modules, roles, and a clean uninstall. The UI Page harness stays scaffolding
and is deleted at the end of the port.

What the client review adds or sharpens:

**Asset delivery for the chart engine.** UXF components are built with the
ServiceNow CLI, and dependencies are bundled by that build, so ECharts can be an
ordinary npm dependency rather than something smuggled in as a UI Script. That is
the clean path and it keeps the artifact self-contained with no external request.
The open question is the practical size ceiling on a bundled component on this
instance, which the spike measures.

**Fonts inside a scoped app.** A `sys_ui_script` cannot carry binary, so the
options are base64 data URIs inside the component stylesheet, or an attachment
record the app installs. Data URIs are simplest and give the strongest guarantee
of no external request, at the cost of bytes in the bundle. See section 5 and the
open decision in section 8.

**Drilldown data path.** The one genuinely unknown piece, covered in section 2.4.
Everything else in the plan degrades gracefully if a phase runs long. This one
does not: it determines whether requirement 2 is buildable as specified.

**Licence compliance as a build step.** The allowlist check from section 1.3 runs
in CI on the app repo, and the register is generated rather than maintained by
hand, so it cannot drift from what is actually installed.

**Update Sets do not reliably carry UXF artifacts.** Already in the risk register.
Promotion between instances is via the application repository and scoped app
publishing, not Update Sets, and that needs to be true from phase 0 rather than
discovered at the first promotion.

---

## 7. What changes in `09-build-plan.md`

The plan does not need rewriting. It needs these amendments.

1. **New section on the third-party register and the CI licence gate.** A phase 0
   deliverable, because it is cheap then and expensive to retrofit.
2. **Phase 1 spike scope widened, and reclassified as a gate.** It now has to prove
   render quality, on-demand data fetch, and drill round-trip latency. Its
   risk-register entry changes from "de-risks the port" to "determines whether
   drilldown is achievable as specified".
3. **New workstream: drilldown and cross-filter.** Hierarchy discovery, the
   fill-rate and cardinality gates, breadcrumb and URL drill state, cross-filter,
   and drill-through to the platform list view. Sequenced after the form engine
   because it reuses the profiler, and after the spike because it depends on the
   answer.
4. **The form engine's rule table gains a sibling.** The drill-offer gate from
   section 2.3, regression-tested the same way, and computed against the viewer's
   permitted rows.
5. **Performance budget promoted to a gate with numbers**, per section 5, including
   the ECharts custom-build measurement.
6. **AI section rewritten** as an optional adapter defaulting to off, with the
   no-record-level-data boundary enforced by the adapter's input type, and the
   three deployment shapes from section 3.1.
7. **Open decisions updated**, per section 8.

## 8. Open decisions

Carried forward, still open:

1. **Default theme, light or dark.** The design ships both. Dark is the flagship.
2. **Which subject areas ship first.** Reporting demand on the instance is far
   broader than ITSM: GRC, risk, audit and compliance together outweigh
   `incident`. An incident-first build would be aiming at the wrong subject.
3. **Appetite for the materialised-aggregate fallback** if the ACL-safe aggregate
   path fails its load test. `secureGroupBy` has never been tested above demo
   scale, and the fallback is a materially larger build.

New from this review:

4. **Font strategy inside the app.** Full self-hosted set at roughly 188 KB, or
   the reduced set from section 5 at roughly a third of that with body text on the
   platform's sans. This is a visible design trade-off, so it is the client's call
   and not ours.
5. **Whether AI ships at all in v1**, and if so, Now Assist or the client's own LLM
   tenant. Our recommendation is to defer it entirely until the design is live,
   because it is the client's own stated priority order and because the headline
   feature does not depend on it.
6. **Drill depth cap.** Unbounded drill is an unbounded payload and an unbounded
   number of queries. Three levels below the top covers the questions a leader
   actually asks, with drill-through to records always available as the terminal
   step. Needs confirming against how deep they actually go in Power BI today.

## 9. Method note

The licence facts in section 1.1 were checked against the licence texts in
`design/LICENSES/`, including the Reserved Font Name check. The zero-external-request
claim was verified by instrumented load at 360, 390, 414, 600, 768 and 1440 px.
The `incident` and `change_request` figures in section 2.2 were queried live
through the `enterprise_graph` MCP tool on 2026-08-03; the incident total of
13,986 reconciles with the figure used in the brand kit. Attempts to read
`sys_dictionary`, plugin state and the Performance Analytics breakdown tables
through that tool returned empty, consistent with the note in
`08-live-report-inventory.md`, so the dependent-field and Now Assist availability
claims in sections 2.3 and 3.1 are stated as required lookups rather than measured
values. Bundle sizes in sections 5 and 6 are deliberately not quoted; they are
listed as measurements the phase 1 spike owes.
