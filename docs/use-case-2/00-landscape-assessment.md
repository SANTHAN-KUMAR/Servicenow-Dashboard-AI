# Use Case 2 — Landscape Assessment & Positioning

> ## ⚠️ CORRECTED — read [`04-red-team-verification.md`](04-red-team-verification.md) alongside this
>
> An adversarial re-verification pass falsified several claims below. The three that change the
> pitch most:
> - **Ceiling 1 was never live-backed and the "6 chart types" figure is wrong** (real: ~15–16). §8's
>   claim that live data confirms it is exactly backwards — live data contradicts it.
> - **Ceiling 2 is overstated.** Performance Analytics ships KPI Signals, Spotlight and forecasting,
>   which autonomously surface anomalies and rank KPI drivers without being prompted. Both are
>   active on this instance.
> - **The ACL claim (Ceiling 3) is CONFIRMED and got stronger** — now hands-on reproducible
>   (`GlideAggregate` = 67 vs `GlideRecordSecure` = 0 for a role-less user) and reinforced by
>   `GlideQuery.withAcls()` hard-blocking aggregates. It should be the lead, not the third pillar.
>
> Inline corrections are marked below. Where this doc and `04` disagree on a fact, `04` wins.

**Status:** assessment / pre-build — **partially superseded, see banner**
**Date:** 2026-07-31 (red-teamed same day)
**Instance checked:** dev390988 (live-verified, see [`01-live-instance-findings.md`](01-live-instance-findings.md))
**Governs:** everything here is subordinate to [`/CLAUDE.md`](../../CLAUDE.md) — if this doc and CLAUDE.md ever disagree on *what we're building for*, CLAUDE.md wins.
**Primary research source:** [`/compass_artifact_wf-69b0ad53-baab-5a08-9199-b4448425add4_text_markdown.md`](../../compass_artifact_wf-69b0ad53-baab-5a08-9199-b4448425add4_text_markdown.md) — a confidence-rated technical/competitive dossier (Verified-Documentation / Verified-Practitioner / Inference labels throughout) that CLAUDE.md's own claims are drawn from. This assessment cites its precise, sourced figures below rather than restating them from general knowledge.

Also published as a formatted artifact: https://claude.ai/code/artifact/e3c040e5-12e3-4bb0-a71b-8a66b7baf2e0

---

## 1. Why this assessment exists

The client asked for one thing: dashboards and reports inside ServiceNow that look and feel like Power BI. We're proposing to add an AI layer on top because our research shows it's the one place none of ServiceNow's own tools compete well. This document checks that claim against what ServiceNow actually ships today, and turns it into a position we can defend in front of the client.

Two separate questions get asked here, and they have different answers:

- **Can Now Assist and OOB components make something beautiful?** Mostly no — the component palette is fixed and comparatively basic.
- **Can Now Assist make something smart?** Partially — but it hits a hard ceiling almost immediately, and that ceiling is where our AI differentiator lives.

---

## 2. The current landscape, side by side

Four things a client could point to and ask "why not just use this." Scored on the two axes that matter per CLAUDE.md's priority rule: visual richness first, AI depth second.

| Tool | Visual richness | AI depth | Notes |
|---|---|---|---|
| **OOB Data Visualization + Performance Analytics** | 2/10 | 1/10 | Fixed chart palette, no data-shape adaptation, no autonomous metric selection. The floor the client has already said isn't good enough. |
| **Now Assist — chart/visualization generation** | 3/10 | 3.5/10 | NL prompt → exactly **single score, line, vertical bar, pie chart, or list** — a rigid "data sentence" prompt grammar (aggregate → state → source → condition → grouping → trend → presentation). **Unchanged Zurich → Australia** (the current release). Real, but shallow — picks a template, doesn't reason about the data's shape or discover what's worth showing. |
| **VividCharts (Store app)** | 8/10 | 1.5/10 | Proves the visual bar is reachable natively and sells commercially — D3.js-based, both Service Portal widgets and custom UXF components, GlideRecord/GlideAggregate server-side data collection, true-to-form PPT/PDF export. **G2: 4.7/5 across 16 reviews (93% 5-star, 6% 4-star, no 3/2/1-star).** Documented weakness: slow load times on larger datasets. No AI metric selection; ACL handling on its aggregates is architecturally consistent with the platform gap but not publicly documented either way. |
| **Our proposed build** | target 8.5 | target 8 | VividCharts-grade visual richness, NDS-token themed, plus autonomous KPI discovery + shape-adaptive chart specs + provable ACL correctness that nothing above attempts. |

---

## 3. Where Now Assist actually hits its ceiling

Four concrete, checkable limitations — not vibes. Ceiling 1 is now backed by a live component inventory, not just documentation (see §8 / live-instance findings doc).

**Ceiling 1 — chart type is capped, not learned.** *(claim survives; "live-confirmed" does not)*
Now Assist's visualization generation offers a fixed, small set of chart types (5: single score, line, vertical bar, pie, list), unchanged across the last two platform releases. It selects from that list based on the prompt and field types — it does not evaluate the actual statistical shape of the data (skew, cardinality, time density, outliers) to decide what visualization would honestly represent it. A distribution with three extreme outliers gets the same bar chart as one without.

> ✅ **FULLY VERIFIED-HANDSON (customer instance).** On **`eypocinst`** (EY POC, Zurich), two
> unrelated prompts drew the same refusal pattern from Now Assist:
> - *"…as a heatmap"* → **"Heatmap is currently not supported. Alternative chart type is selected instead."**
> - *"Show me incident resolution time distribution"* → **"Distribution is currently not supported. Alternative chart type is selected instead."**
>
> **The data-fit objection is dead.** The Visualization Designer picker on the same instance ships
> **heatmap** *and* **boxplot** as first-class types — so the platform has them and **Now Assist
> simply cannot emit them.** This is a skill-level cap, not a palette or data limitation.
> See [`04`](04-red-team-verification.md) §9C.1–§9C.2.
>
> ⚠️ **Keep straight:** the skill is not installed on `dev390988`, so EY is the sole hands-on
> source, and the result is at the **Zurich** end of the "unchanged Zurich→Australia" claim.
>
> 🔴 **But do not build the pitch on the chart cap.** The native palette is **24 types** (§9C.3) —
> arguing "limited chart variety" loses the room. The durable argument is the *intelligence* gap
> below, not the type list. Separately: the **OOB** chart palette is ~15–16 types, not the 6 previously
> claimed; do not conflate the Now Assist cap with the OOB palette. See [`04`](04-red-team-verification.md) §2, §7.

**Ceiling 2 — it waits to be asked.** *(⚠️ materially overstated — see correction)*
Every Now Assist chart starts from a human-written prompt. It has no autonomous mode that looks at a table, a module, or a persona's workspace and decides *what's worth surfacing* — that judgment call stays entirely on the user. A dashboard "AI layer" that only responds to prompts one chart at a time isn't doing dashboard-level metric curation; it's NL-to-chart, which is table stakes, not a differentiator.

> ⚠️ **Correction — this ceiling is much lower than written.** It is true of the *Now Assist chat
> surface* and false of *Performance Analytics*. Active on dev390988: **KPI Signals** (continuously
> analyses time-series indicators and autonomously flags anomalies, spikes, dips and trend breaks),
> **Spotlight** (ML-ranks which factors most influence a KPI), **Performance Analytics AI**, plus
> native forecasting (`sn-par-forecast-config`) and computed-insight/recommendation tables
> (`par_computed_insight`, `par_recommendation`, `par_custom_insight_content`). None of that is
> prompt-driven.
>
> **The surviving, narrower differentiator:** PA autonomously analyses **indicators a human already
> defined**. It does not decide **which metrics should exist**. Our pillar is *candidate metric
> definition from table/process content*, sitting upstream of PA indicator configuration — not
> "autonomous analytics," which ServiceNow ships. See [`04`](04-red-team-verification.md) §5.
>
> 🔴 **Escalated: this is no longer theoretical at the client.** On **`eypocinst`**,
> `par_computed_insight` holds **292 rows** and `par_recommendation` **35** — on the PDI both were
> empty. KPI Signals, Spotlight and Performance Analytics AI are all active. **Native autonomous
> insight generation is running in production against EY's own data today.**
> **Do not say "no native autonomous analytics" in front of this client.**
> See [`04`](04-red-team-verification.md) §9B.1.

**Ceiling 3 — the ACL gap is platform-wide, not Now-Assist-specific.** *(✅ CONFIRMED hands-on — strengthened)*
Any aggregate binding built on `GlideAggregate` — which is what both OOB widgets and Now Assist's generated visualizations ultimately run on — does not enforce row-level ACLs. There is no `GlideAggregateSecure`. A count or sum card can silently include records the viewer isn't entitled to see.

> ✅ **Verified hands-on, and sharper than originally written.** On dev390988, impersonating a user
> with **zero roles**: `GlideAggregate('incident').COUNT` → **67**, while `GlideRecordSecure('incident')`
> returns **0 visible rows**. A user entitled to see nothing gets a tile reading 67.
>
> Two wording corrections that matter, because both are checkable and the original phrasing hands a
> client an easy rebuttal:
> 1. **`GlideQuery` is not part of the gap — it is the best evidence for it.** `GlideQuery.withAcls()`
>    *does* enforce ACLs. It simply refuses to aggregate: `new GlideQuery('incident').withAcls().aggregate('count')`
>    throws **"Cannot use aggregate queries with withAcls()"**. ServiceNow's own ACL-aware query API
>    is deliberately blocked from aggregating. Lead with this.
> 2. **`GlideAggregate.canRead()` exists** and gives a correct *table-level* answer; ServiceNow's own
>    OOB `SOW - Announcements Aggregate` broker calls it. So say "no **row-level** ACL enforcement,
>    and a table-level check you have to remember to call" — not "no ACL awareness at all."
>
> See [`04`](04-red-team-verification.md) §3. **This should be the lead differentiator, not the third one.**

**Closing, not settled.**
On **April 9, 2026**, ServiceNow collapsed its five legacy tiers (Standard/Pro/Pro Plus/Enterprise/Enterprise Plus) into three AI-native tiers (Foundation/Advanced/Prime) and bundled Now Assist, the Moveworks layer, Workflow Data Fabric, Context Engine, and AI Control Tower into every tier rather than selling them as add-ons (legacy SKUs hit end-of-sale July 1, 2026). At Knowledge 2026 (May 5), ServiceNow launched **Otto** — a unified AI experience folding Now Assist + Moveworks + AI Experience together, with **AI Data Explorer (AIDE)** as its analytics channel, plus **Autonomous Data Analytics** (Pyramid-Analytics-fueled, acquisition closed March 10, 2026), marketed as letting "any person or AI agent query the entire enterprise data estate in plain language."

None of that touches ceilings 1–3 as documented as of the Australia release — AIDE does NL-driven exploration and insight summarization, not adaptive chart-spec generation, autonomous KPI discovery, or ACL-proof aggregation. But this is a fast-moving front, not a settled one. **Concrete signals that would change this assessment**, worth checking against release notes periodically:
- A release note showing DV Generation expanding past 5 chart types, or adding data-shape adaptivity → the viz-AI wedge weakens; shift weight toward the correctness moat and cross-source gaps.
- Pyramid/Autonomous Data Analytics shipping an ACL-provable aggregate layer → the correctness moat erodes; accelerate the adaptive-spec differentiator instead.
- A Store ISV combining beautiful custom viz + AI insight selection + provable ACL correctness in one product → the white space is contested; compete on depth of proof and export polish.

The pitch should lean on the specific capability gap, not on Now Assist being paywalled — bundling makes "AI from NL" table stakes, not a reason it's unavailable to the client.

---

## 4. Capability matrix

> ⚠️ **Three rows in this matrix were corrected by [`04`](04-red-team-verification.md).** Fixed values shown inline.

| Capability | OOB Data Viz / PA | Now Assist | VividCharts | Our build |
|---|---|---|---|---|
| Chart variety | ~~~6-8 fixed primitives~~ ~~~16~~ → **24 types, read from the picker** (incl. heatmap, boxplot, scatter, pareto, geomap, pivot, quadrant bubble); 29 in classic. Fixed *treatment*, no composability | Small fixed set, capped at 5 | 20+ (charting-library-grade) | Full ECharts library — **but do not lead with this**; the palette gap is narrower than assumed |
| Data-shape-adaptive specs | none | **none — proven.** Asked for a distribution it says *"Distribution is currently not supported"* and renders one bar per raw value, `(empty)` dominant, 43→345,805 on a linear axis | none | targeted — **the strongest surviving visual argument**, and the gap is now demonstrable rather than asserted |
| Autonomous KPI/metric discovery | ~~none~~ → **partial: KPI Signals (anomaly detection), Spotlight (driver ranking), forecasting — all on *human-defined* indicators** | none (prompt-driven only) | none | targeted: metric **candidacy** from content, upstream of indicator definition, via content graph reuse |
| Autonomous dashboard export (PPT/PDF) | ~~n/a~~ → **native, scheduled, emailed; 150-viz cap** | — | yes (marketed differentiator) | parity, not a differentiator |
| ACL-correct aggregate binding | **not enforced at row level** (table-level `canRead()` only; `GlideQuery.withAcls()` refuses to aggregate) | not enforced | not verified / not their concern | targeted, via persona-validation engine reuse |
| Runs fully native, no export | yes | yes | yes | yes — hard constraint |
| NDS token / brand consistency | yes (it is NDS) | yes | library-dependent | yes — tokens consumed by design |
| Licensing | included | bundled into every tier as of Apr 9 2026 | commercial, pricing not public (G2: "No pricing available") | Apache-2.0 (ECharts) |

**Charting-library licensing, for the record:** Highcharts is free only under CC BY-NC (personal/non-profit/school) — commercial per-developer licenses run roughly **$176–$416.50/developer** depending on source and version, and an **OEM license (perpetual, quote-only) is required for anything embedded in a product distributed to and hosted by customers** — directly relevant if this ships as a Store app. ECharts (Apache-2.0), Chart.js (MIT), D3 (ISC/BSD), and Plotly.js (MIT) are all permissively licensed and safe to redistribute — hence the standing default to ECharts in CLAUDE.md §5.

---

## 5. Positioning for the client

Three sentences that should anchor every stakeholder conversation, in order:

1. **Lead with the demo, not the architecture.** Show a beautiful dashboard first. If the AI story gets told before the visual bar is proven, the pitch has already inverted the client's own priority.
2. **Name the OOB gap explicitly, using the governance document's own language.** "Power-BI-like, beautiful, impressive" is precisely the class of requirement the Now Design System's exception clause anticipates — OOB components can't meet it, so custom rendering is compliant, not a deviation to apologize for.
3. **Frame the ceiling honestly: "Power-BI-grade visual and interaction quality on ServiceNow-native data," never "Power BI replacement."** We are not claiming cross-source modeling, DAX-equivalent measures, or ad-hoc self-service exploration. Overselling that is the fastest way to lose credibility in the first follow-up meeting.

**The one differentiator sentence:**
> "Now Assist turns a prompt into one of a handful of chart types. We turn the data itself into the right chart, chosen automatically, provably safe for whoever's looking at it."

That's autonomous discovery + shape-adaptive specs + ACL correctness — the three things nothing on the market does together.

> ⚠️ **Re-ranked.** "Autonomous discovery" is the weakest of the three, not the strongest —
> Performance Analytics already does autonomous anomaly detection and driver ranking on defined
> indicators ([`04`](04-red-team-verification.md) §5). **Open with correctness instead**, because
> it is the only leg that survived red-teaming and got stronger:
>
> > *"On your instance, a user entitled to see zero incidents sees a KPI tile reading 67. ServiceNow's
> > own ACL-aware query API refuses to aggregate at all — it throws rather than answer. Here's the
> > five-line script. Let's run it on yours."*
>
> Then layer shape-adaptive specs (still genuinely novel, still the biggest risk) and metric
> *candidacy* discovery (narrower than originally claimed) on top.

---

## 6. Recommended next steps

Sequenced to retire the two biggest risks first — the same order CLAUDE.md §6 already flags as unproven: whether the dashboard can actually look beautiful in practice, and whether adaptive chart generation produces good output on real data.

### Phase 1 — Prove the visual bar, on one real dashboard
Build one custom Next Experience dashboard — ECharts, NDS-token themed — against real dev390988 data. No AI yet. This is the artifact that either earns the client's confidence or doesn't.
- Pick one persona and one dataset the client already cares about (incident/CSM volume, SLA breach trend, etc.)
- Match VividCharts' visual bar as the internal acceptance test
- Instance is confirmed clean and current (§8 of live-instance findings) — no competing charting app to work around, Now Assist Core on a recent build

### Phase 2 — Prove shape-adaptive chart-spec generation on real data
The single biggest technical risk in this use case — unproven anywhere, by anyone, per CLAUDE.md §6. **Highest risk phase.**
- Prototype the spec-selection logic against 5–10 real tables with varied statistical shape (skewed, sparse, time-dense, high-cardinality)
- Evaluate output quality by hand before investing in productionizing it

### Phase 3 — Reuse, don't rebuild
Wire in the content graph and persona-validation engine from Use Case 1. Point them at dashboard/report output instead of portal/IA output.
- Content graph → autonomous KPI/metric candidate discovery
- Persona-validation engine → provable ACL-correct aggregate binding, checked per viewer persona before any card ships
- Benchmark the correct-but-slow "iterate securely and count in memory" approach; decide if it's fast enough or needs a cached/precomputed layer

### Phase 4 — Close the gap to VividCharts' polish
Export/reporting parity — PPT/PDF, wall-display mode — so the finished product doesn't lose on the details a client will notice immediately in a side-by-side.

---

## 7. Caveats carried over from the research dossier

The primary source rates its own claims by confidence (Verified-Documentation / Verified-Practitioner / Verified-HandsOn / Inference / Unverified) — worth preserving rather than flattening into false certainty:

- **VividCharts' internal ACL handling is unverified**, not confirmed-bad. Its architecture (GlideRecord/GlideAggregate server-side collection) is *consistent* with the platform-wide ACL gap, but whether its chart-type scripts manually replicate ACL filters was not confirmed either way. If VividCharts already solves this, part of the correctness-moat claim shrinks.
- **The "≈80–90% of Power BI/Tableau dashboard richness" ceiling is an inference, not a measured benchmark** — it's a qualitative read of structural gaps (cross-source modeling, ad-hoc exploration, ACL aggregation) against otherwise-high rendering parity. Don't quote it as a measured number to the client.
- **"No ISV combines all three" (beauty + AI selection + provable ACL correctness) is an absence-of-evidence finding**, not proof of nonexistence — the Store is large and wasn't exhaustively searched.
- **Now Assist commercial/bundling mechanics are less certain than the directional trend.** ServiceNow publishes no public Now Assist list prices; at least one licensing advisory disputes "bundled = free" framing (overage still bills per unit past a pool). The direction (AI pushed systemwide, in every tier) is well-corroborated; the exact economics aren't.
- **Biggest risk to this whole thesis is ServiceNow's own velocity.** Otto, bundled Now Assist, and Pyramid/Autonomous Data Analytics are a real, fast-moving systemwide AI-analytics push. If ServiceNow adds bespoke visual quality or ACL-provable aggregation natively, two of our three white-space pillars close. The durable differentiator is the **combination** of all three — not any single leg in isolation.

## 8. Live-instance verification

Full methodology, raw data, and access-troubleshooting history: [`01-live-instance-findings.md`](01-live-instance-findings.md).

Summary: REST API on dev390988 is OAuth-only (Basic Auth and session-cookie auth are both rejected by design). Once an OAuth application was registered and a password-grant token issued, live Table API reads confirmed:

- Now Assist Core v29.3.10, active, current build ✅ *(but the analytics/DV-generation skills are **not** installed — see [`04`](04-red-team-verification.md) §7)*
- ~~OOB chart component inventory is a genuinely small, fixed set (bar, pie/donut, line/timeseries, sparkline, timeline, single-score) — live confirmation of Ceiling 1~~ ❌ **FALSIFIED** — search-filter artifact; the real palette is ≥15 types ([`04`](04-red-team-verification.md) §2)
- Performance Analytics extensively active ✅ — ~~but running on the same limited chart primitives~~ **and running KPI Signals, Spotlight, forecasting, computed insights and native PPT/PDF/scheduled export** ([`04`](04-red-team-verification.md) §4, §5)
- ~~No third-party charting app (VividCharts or similar) installed — clean instance~~ ⚠️ weaker than stated: `sys_store_app` was unreadable, so this is "no evidence found," not confirmed
- UI Builder / Data Visualization are not separate toggleable plugins; they're bundled into the core Now Experience Framework ✅

~~Nothing in §3–7 needed to change as a result — if anything, Ceiling 1 is now backed by live data instead of an inferred count.~~

> ❌ **That closing sentence is the most wrong sentence in this repo.** Live data *contradicts*
> Ceiling 1's chart-count framing rather than backing it, and Ceiling 2 is contradicted too. What
> the live pass actually established, decisively, is **Ceiling 3** — and that one is now
> demonstrable in five lines of script. Read [`04-red-team-verification.md`](04-red-team-verification.md)
> for the corrected picture and what it does to §3–7.
