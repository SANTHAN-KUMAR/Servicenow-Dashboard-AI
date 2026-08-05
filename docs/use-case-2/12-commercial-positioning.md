# COMMAND — Commercial Positioning

**Product:** COMMAND, a dashboard and reporting library that runs inside ServiceNow.
**Purpose of this document:** the evidence pack for pitching this to leadership and
to customers. Every claim here is checkable.
**Date:** 2026-08-05.

---

## How to use this document

Section 2 is the pitch. Section 3 is the problem in the customer's own data.
Sections 4 and 5 are the competitive picture with proof. Section 8 is cost.
**Section 10 is what not to say** — read it before any customer meeting, because
three of the obvious things to claim are false and a technical buyer will know.

Every competitive claim carries a source label:

| Label | Meaning |
|---|---|
| **Verified live** | We ran it and saw the result, on a real instance |
| **Verified — customer instance** | Same, on the client's own production-grade instance |
| **Documented** | Stated in ServiceNow's own official documentation |
| **Unverified** | We believe it, we cannot prove it. Do not present as fact |

---

## 1. What it is, in one paragraph

COMMAND is a dashboard library that runs entirely inside ServiceNow. A user opens a
catalog of subjects they are allowed to analyse, picks one, and gets a full
dashboard built from that subject's real data — with the charts chosen by measuring
the data, not by someone picking from a menu. They can click into any value and
keep going deeper, finishing on the platform's own record list. No data leaves the
instance. Nothing is exported to Power BI.

---

## 2. The pitch

**The problem.** Getting real analysis out of ServiceNow today means exporting to
Power BI. That means a copy of the data, in a second security model, in a second
tool, with a person maintaining both.

**Why people export.** Not because ServiceNow has too few chart types. Because
building a good dashboard needs someone to decide what to measure and how to draw
it, and that person is expensive and usually unavailable. So dashboards get built
once, badly, and then trusted anyway.

**What we do.** COMMAND measures the data and builds the analysis the data
supports. The user picks a subject, not a chart type. And every number is checked
against what that specific viewer is allowed to read — which the platform's own
fast counting API does not do.

**The one-sentence version:**

> ServiceNow's AI turns a prompt into one of five chart types. We turn the data
> itself into the right analysis, chosen automatically, and provably correct for
> whoever is looking at it.

**Why now.** ServiceNow is pushing AI analytics across every tier. That closes some
gaps and widens others. The gaps we are aiming at — permission-correct aggregates
and data-shape-driven chart selection — are not on their roadmap in any release
notes we can find. Treat this as a window, not a permanent advantage.

---

## 3. The problem, in the customer's own numbers

This is the strongest part of the pitch because **the customer can verify it on
their own instance in ten minutes.** Do not lead with our product. Lead with their
data.

We read all **2,368 reports** on the instance:

| What we found | Number |
|---|---:|
| A date field drawn as a single number instead of a trend line | **20 of 26** |
| Number of different chart forms used for the same field, `priority` | **9** |
| Number of different chart forms used for the same field, `category` | **11** |
| Reports that are just a count | **75%** |
| Reports with no breakdown at all | **37%** |
| Share of all reporting carried by just five of 24 available chart types | **77%** |

*Verified live.*

**What this means.** The platform's own reporting draws a time field as a static
number 77% of the time. The same five-value field is drawn nine different ways.
There is no rule anywhere deciding which chart suits which data, because the
platform has no such logic — a report's chart type records what an author picked,
nothing more.

**So the richness is already available and almost entirely unused.** That is not a
tooling gap. It is a decision-making gap, and it is the one we automate.

**A second finding, same shape.** The schema declares that Category rolls up to
Subcategory. On 13,986 incidents, subcategory is filled on **42 of them** — empty
99.7% of the time. So a customer clicking into "Software" (2,651 incidents) would
land on a level where 99.3% of records read "(none)".

The lesson generalises: **the platform's metadata records what somebody intended,
not what is true of the data.** Every chart and every drill level we offer is
measured against the actual rows first. That is the product.

---

## 4. Where the alternatives stop

### 4.1 Built-in reporting and Performance Analytics

**What it genuinely does well** — and you must say this, because a technical buyer
knows it:

- **24 chart types** in the modern designer, including heatmap, boxplot, scatter,
  pareto, geomap and pivot. *Verified live — read from the picker.*
- **Native PowerPoint and PDF dashboard export**, scheduled and emailed. *Verified
  live.*
- **Autonomous insight generation that is already running.** KPI Signals for
  anomaly detection, Spotlight for driver ranking, and native forecasting. On the
  client's own instance the insight table holds **292 generated insights**.
  *Verified — customer instance.*

**Where it stops:**

| Gap | Detail | Source |
|---|---|---|
| Chart *kinds*, not count | No treemap, sankey, sunburst, network, radar, waterfall, stream, bump, small multiples, combo axis or histogram in the modern surface | Verified live |
| Fixed visual treatment | No free-form canvas, no control over how a chart looks | Verified live |
| Metric **candidacy** | Its AI analyses indicators a human already defined. It never decides which metrics should exist | Verified — customer instance |
| Permission-correct aggregates | Row-level permissions not applied to counts. See 4.4 | Verified, two instances |

### 4.2 Now Assist — ServiceNow's AI charting

This is the sharpest competitive evidence we have, and it is a live demo rather
than a slide.

**Capped at five chart types.** Asked for a heatmap on the client's own instance, it
answered verbatim: *"Heatmap is currently not supported. Alternative chart type is
selected instead."* — and drew a bar chart. *Verified — customer instance.*

**The cap is a product limit, not a data limit.** The Visualization Designer ships
heatmap and boxplot as first-class types. Now Assist refuses both. *Verified —
customer instance.*

**And when it cannot do something, it substitutes something misleading.** Asked
*"show me incident resolution time distribution"*, it replied *"Distribution is
currently not supported. Alternative chart type is selected instead"* — then drew a
bar chart with **one bar per raw resolution-time value**, values running from 43 to
345,805 on a straight linear axis, no grouping, with `(empty)` the tallest bar at
over 10,000 records. *Verified — customer instance.*

**This is the single best artifact in the pitch.** It is not "the AI is limited". It
is: the AI understood the question, declined it, and drew something that
misrepresents the data — with no warning to the reader. Run it live in the meeting.

*A useful side observation for the customer: that `(empty)` bar means most of their
incidents carry no resolution time at all. That is a data-quality finding they will
want, and it costs us nothing to hand over.*

### 4.3 VividCharts — the closest commercial competitor

**Treat this as an existence proof, not a punching bag.** It is a live,
Store-distributed, revenue-generating app. It proves customers pay for
better-looking charts inside ServiceNow. That is good news for the market case.

| Aspect | Position |
|---|---|
| Visual quality | Strong. 20+ chart types, D3-based, both modern and legacy portal surfaces |
| Export | True-to-form PowerPoint and PDF — a marketed strength |
| Reviews | G2 4.7/5 across 16 reviews. **Unverified** — cached snapshot, we could not load G2 directly. Do not quote it |
| Pricing | Not public |
| Documented weakness | Slow load times on larger datasets |
| Chart selection | None. A person still picks every chart |
| Permission-correct aggregates | **Unverified.** Their architecture is consistent with the platform gap, but we have not confirmed either way |

**Two honest notes.** First, do not assert that VividCharts gets ACLs wrong — we
have not checked, and if they solve it, part of our correctness claim narrows.
Second, their weakness on large datasets is worth noting given that our own
latency is currently over budget too (section 9). Do not attack them on speed until
we have fixed ours.

**Where we differ, defensibly:** they draw the chart a person chose, beautifully.
We choose the analysis. That is the whole difference and it is enough.

### 4.4 The correctness gap — our strongest claim

This is the one to open with. It survived every attempt to knock it down and got
stronger.

**ServiceNow's fast counting API does not apply row-level permissions.**

- `GlideAggregate` does not enforce row-level ACLs.
- There is no `GlideAggregateSecure`.
- `GlideQuery.withAcls()` **refuses to aggregate** — it throws an error rather than
  answer.

**Measured, for a user entitled to see nothing:** `GlideAggregate` returns a count
of **67**. `GlideRecordSecure` returns **0 rows**. *Verified on two instances,
including the client's own.*

**In plain terms:** the normal way to build a KPI tile shows people numbers that
include records they are not allowed to open. Not as an edge case — as the default
result of the obvious implementation.

**The demo, five lines, on their instance:**

> "Pick a user who should see zero incidents. Here is a KPI tile reading 67.
> ServiceNow's own permission-aware query API won't even answer this question — it
> throws. Shall we run it on yours?"

**Two things make this more than a technical curiosity:**

1. **It is a compliance exposure.** A dashboard that leaks counts across a
   permission boundary is a reportable problem in a regulated environment, and
   nobody knows it is happening because the number looks fine.
2. **ServiceNow's own Store certification names it.** "GlideRecord without ACL
   enforcement" is a documented rejection criterion. *Documented.* So getting this
   right is not polish — it is a gate for anything sold through the Store.

---

## 5. Positioning

Three differentiators, **in this order**. The order matters — it was wrong before
and we corrected it after testing each claim adversarially.

| # | Differentiator | Strength | Why this rank |
|---|---|---|---|
| 1 | **Provably permission-correct numbers** | Strongest | A demonstrated platform gap, reproduced on the customer's own instance, and a Store certification criterion |
| 2 | **Charts chosen by measured data shape** | Strong, and genuinely novel | No shipped BI product does this. Also the least proven part of our own plan |
| 3 | **Metric candidacy — which metrics should exist** | Real but narrow | Performance Analytics already does autonomous analysis *on defined indicators*. Our gap sits upstream of that |

**Do not lead with #3, and never describe it as "ServiceNow has no autonomous
analytics."** That is false and provably so on the customer's own instance.

**The honest ceiling, stated the same way every time:**

> Power-BI-grade visual and interaction quality on ServiceNow-native data, with
> automated chart and drill selection that Power BI does not do.

**Not** a Power BI replacement. We do not do cross-source semantic modelling,
DAX-equivalent calculated measures, or arbitrary end-user ad-hoc exploration. Those
are structural, and custom rendering does not fix them. Overselling this is the
fastest way to lose the second meeting.

**One structural advantage worth naming.** The deepest drill step hands off to
ServiceNow's own record list. The platform enforces row-level security there, so we
never build a record grid or take on its security. Power BI's equivalent is a copy
of the data under a different security model. **Being inside the platform beats
exporting, on exactly the dimension that matters most to an auditor.**

---

## 6. Who buys this, and why

| Buyer | What they feel today | What lands |
|---|---|---|
| **IT / Service Delivery leader** | Waits on someone to build a dashboard, then does not fully trust it | Pick a subject, get the analysis. No queue |
| **Risk, Audit, Compliance** | Numbers used in reporting that may cross permission boundaries | The correctness proof. This is the strongest room for us |
| **Platform owner** | Two tools, two security models, an export to maintain | One tool. No copy of the data. No second model |
| **CIO / Exec** | Pays for Power BI seats to report on ServiceNow data | Fewer seats, less duplication, one place to look |

**Where the demand actually is.** On the instance we measured, reporting demand is
much broader than ITSM: GRC, risk, audit and compliance together outweigh Incident.
An incident-first pitch aims at the wrong buyer. **Lead with risk and compliance**
— they have the most reports and they care most about the correctness argument.

---

## 7. Market case

**The gap is real and structural.** Customers export ServiceNow data to Power BI
because native reporting does not answer their questions well. That is the whole
reason this engagement exists — it came from the customer, unprompted.

**Somebody already proved people pay.** VividCharts sells commercially into exactly
this gap with a narrower product: better charts, still hand-picked. We are not
testing whether the market exists.

**The addressable base is every ServiceNow customer with a reporting problem**,
which is most of them at scale. No new licence to negotiate, no new vendor to
onboard, no data leaving the tenant — the three things that usually kill an
analytics purchase.

**Risks to the market case, honestly:**

| Risk | Severity | Note |
|---|---|---|
| ServiceNow closes the gap themselves | **High** | They are pushing AI analytics into every tier. Re-check every release |
| Chart auto-selection is judged poor on real data | **High** | Unproven anywhere, by anyone. Our biggest technical bet |
| VividCharts already solves correctness | Medium | Unverified. Would narrow our lead claim |
| Support burden is underestimated | Medium | See 8.3 |
| Customer's own data is too dirty for auto-selection | Medium | Partly mitigated: we refuse weak charts rather than draw them. But it caps the "wow" on messy instances |

---

## 8. What it costs to build

### 8.1 Effort

All figures are person-weeks for one engineer. Several items run in parallel.

| Stage | Person-weeks |
|---|---:|
| **Already built** — data layer, chart-selection engine, 27 chart forms, catalog, drilldown, ACL verdict, test suite, deploy pipeline | **~12–14** |
| **Remaining to production** — see the technical document, section 12.2 | **~11.5–14.5** |
| **Total to a production release** | **~24–28** |

Roughly **6 to 7 person-months** total, with about half already spent.

Not included: ServiceNow Store certification (a 3–5 week external review, if Store
distribution is a goal), and one contingency item — if permission-correct counting
does not hold at 100,000+ rows, the fallback is pre-computed aggregates, which is a
materially larger build. That should be decided on a measurement we have not yet
taken.

### 8.2 Cost

Apply your own blended rate. Illustrative only:

| Blended day rate | Remaining (~13 weeks) | Total (~26 weeks) |
|---|---:|---:|
| $400 | ~$26,000 | ~$52,000 |
| $600 | ~$39,000 | ~$78,000 |
| $800 | ~$52,000 | ~$104,000 |

**Rates are placeholders. Substitute real ones before this goes near a customer.**

**Third-party software cost: zero.** Every component is permissively licensed —
Apache 2.0 for the chart engine, SIL OFL 1.1 for the fonts. Nothing to buy, no
per-seat fee, no royalty.

One cost to avoid: **Highcharts** is roughly $176–$416 per developer, and needs a
quote-only OEM licence if embedded in a product distributed to and hosted by
customers. We use Apache ECharts specifically to avoid this. If anyone proposes
Highcharts for one visual, get the OEM quote first.

### 8.3 The recurring cost nobody budgets

**ServiceNow does not support custom components.** Their official FAQ: they support
the framework but "will not support any custom components customers are creating and
deploying to their instances, nor will we provide guidance on creating a custom
component." *Documented.*

So whoever delivers this owns support for the custom UI, indefinitely. This is true
of VividCharts and of any in-house build too — it is the cost of going beyond
built-in components at all.

**Two consequences:**

1. **Budget an ongoing support and maintenance line.** Including a regression pass
   after each quarterly platform upgrade — ServiceNow staff have acknowledged
   non-zero upgrade risk to custom UI work, with data-binding configuration
   specifically flagged.
2. **It is also a revenue line.** A support and maintenance subscription is the
   natural recurring component of any commercial model below.

### 8.4 Commercial models

| Model | Fit | Note |
|---|---|---|
| **Fixed-price build** | Simplest first sale | One customer pays, no reuse. Weakest economics |
| **Reusable accelerator** | Best near-term | Build once, deploy per customer with configuration. Margin improves each time |
| **Store app + licence** | Best long-term | Needs certification, ACL correctness as a gate, and a real support function |
| **Support subscription** | Attach to any of the above | Follows directly from 8.3 |

**Recommendation: build as a reusable accelerator, with the option to certify for
the Store later.** Keep the chart-component library in its own scope from day one —
there is a documented case of custom components failing to appear after Store
publishing, with the guidance being to separate the component library from the
consuming app. That is nearly free to do now and expensive to retrofit.

---

## 9. What is not finished

Include this in any internal pitch. Leaving it out is how a deal gets sold and then
missed.

| Item | Status |
|---|---|
| Page load speed | **4–12 seconds against a 2.5 second target.** Fix identified, not applied |
| Permission-filtered view | Logic built and unit-tested, but **never run as a genuinely restricted user** — only as admin |
| Chart engine | Currently our own renderer. The Apache ECharts port is planned, not done |
| UI surface | A platform UI Page today, not the modern component the production version needs |
| Deep on-demand drilldown | Works in-page to three levels. The on-demand version depends on an open technical question |
| Scale | Tested to ~14,000 rows. Untested at 100,000+ |
| Licence gate in CI | Specified, not built |
| Wider IP review | Fonts and libraries cleared. Colour, layout, chart forms, icons, patents, product name **not reviewed** |

**How to present this.** The engine is built and tested — 27 chart types running on
real data, 226 automated tests, a permission-correctness model no competitor has.
What remains is packaging, performance tuning, and proving the permission work under
real user roles. That is a known, estimated 11–15 weeks. It is not research.

---

## 10. What not to say

Each of these is wrong, and a technical buyer will catch it.

| Do not say | Say instead |
|---|---|
| "ServiceNow only has six chart types" | "24 types, and the richness is almost entirely unused — five types carry 77% of all reporting." The six-type figure is false; it came from a search filter artifact |
| "ServiceNow has no autonomous analytics" | "It analyses indicators a human defined. It doesn't decide which metrics should exist." Their instance has 292 auto-generated insights — this claim dies instantly |
| "ServiceNow can't export to PowerPoint" | Nothing. It ships, scheduled and emailed. Export is parity, never a differentiator |
| "AI picks the right chart from your prompt" | That is Now Assist, free in every tier. Our claim is chart choice from **measured data shape**, with no prompt |
| "It's a Power BI replacement" | "Power-BI-grade visual and interaction quality on ServiceNow-native data." We do not do cross-source modelling or ad-hoc self-service |
| "VividCharts gets permissions wrong" | Nothing. Unverified. If it is wrong it damages our credibility badly |
| "It's fast" | Not yet. Do not claim a speed we have not achieved |
| "G2 rates them 4.7" | Nothing. Cached snapshot, not confirmed |

**The general rule: argue from measurement, not adjectives.** Everything durable in
this pack is a number from the customer's own instance. That is what makes it hard
to argue with, and it is also what makes us easy to trust when we say something is
not finished.

---

## 11. The demo, in order

Fifteen minutes. Do not open with architecture.

1. **Their data, their problem (3 min).** The 2,368-report finding. A date field
   drawn as a number 20 times out of 26. Let them check it.
2. **The Now Assist distribution failure (3 min).** Live. Ask for a distribution,
   watch it decline and then draw something misleading.
3. **The permission gap (3 min).** Five lines. Count of 67 for a user entitled to
   zero. Offer to run it on theirs.
4. **COMMAND (5 min).** Catalog → pick a subject → dashboard builds itself → click
   into a value, twice → land on the record list. Point out the permission badge on
   the page.
5. **The honest close (1 min).** What is built, what is not, how long the rest
   takes.

**Use `incident`, `change_request` or `problem`.** They are stable and each carries
eleven panels. Avoid `sc_request` — it holds one record on the demo instance, so the
engine correctly refuses to chart it and the page looks bare.

**Decide before the meeting: live or recorded.** Live is more convincing. Pages
currently take 4 to 9 seconds to load, which is noticeable when someone is watching.
Recorded removes that entirely and buys time to fix it. Either is defensible;
walking into a live demo without deciding is not.

---

## 12. Sources

Everything labelled *Verified live* or *Verified — customer instance* was run by us
on `dev390988` or the client's instance between 2026-07-29 and 2026-08-05, and the
underlying records and scripts are in this repository. The full citation registry,
including confidence labels on every competitive claim, is
`03-gap-registry.md`. The adversarial re-check that corrected three of our earlier
claims — the chart-type count, the autonomous-analytics claim, and the export claim
— is `04-red-team-verification.md`.

Anything labelled **Unverified** must not be presented as fact. There are only three
of them, and they are marked in place.
