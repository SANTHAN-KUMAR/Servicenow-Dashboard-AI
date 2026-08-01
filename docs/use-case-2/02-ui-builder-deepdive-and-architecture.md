# Use Case 2 — UI Builder Capability Deep-Dive, Buildable Architecture & Universal Positioning

> ## ⚠️ MATERIALLY CORRECTED — read [`04-red-team-verification.md`](04-red-team-verification.md) first
>
> This document inherited the falsified "6 chart primitives" figure from `01` §5 and built §1's
> whole fragmentation thesis on it. An adversarial re-verification pass on the same instance found:
>
> | Section | Verdict |
> |---|---|
> | **§1** — three surfaces, 5 / 6 / 17 chart counts, bridge via Saved Data Visualization | ❌ **largely falsified** — the 6-vs-17 split does not exist; the UI Builder component and Visualization Designer render the same ~16 types |
> | **§2.2** — "no aggregate data resource in UI Builder at all" | ⚠️ **weakened** — aggregate brokers exist; the real gap is "no *reusable ACL-safe* one" |
> | **§2.4** — "no native PPT export" (basis of Layer 5 / Phase 5) | ❌ **falsified** — native PPT + PDF + scheduled + emailed export ships, enabled, 150-viz cap |
> | **§2.5** — "AI-driven KPI discovery doesn't exist on any native surface" | ⚠️ **overstated** — KPI Signals, Spotlight and forecasting all ship and are active |
> | **§2.1, §2.3, §3.1, §3.2, §3A, §4, Layers 3/4/4A** | ✅ **stand** — unaffected, several now with live support |
> | **Layer 1 (ACL-safe aggregation)** | ✅ **confirmed hands-on and promoted to the headline** |
>
> Section-level corrections are inline below. `04` §9 has the re-ranked differentiators and the
> revised layer/roadmap. Where this doc and `04` disagree on a fact, `04` wins.

**Status:** assessment / pre-build — **partially superseded, see banner**; extends [`00-landscape-assessment.md`](00-landscape-assessment.md) and [`01-live-instance-findings.md`](01-live-instance-findings.md)
**Date:** 2026-07-31
**Governs:** subordinate to [`/CLAUDE.md`](../../CLAUDE.md), same rule as the other docs in this folder.
**Positioning scope:** this document treats the product as a **universal ServiceNow-native capability** — buildable and deployable by any delivery team (internal platform team, any systems integrator, or a Store ISV). No firm-specific commercial framing is used here by request; if a sponsoring firm wants a firm-specific pitch overlay later, that's a separate, later document.

---

## 0. Why this document exists, and what's different from the last pass

The last assessment ([`00-landscape-assessment.md`](00-landscape-assessment.md)) benchmarked against **VividCharts** and **Now Assist**. Both are real competitors, but neither is the one a client will actually compare the delivered product against day-to-day — **the client's own ServiceNow admins already have UI Builder + Data Visualization + Performance Analytics sitting in the platform they're paying for.** That's the true default alternative to "build something custom": *"why not just use what's already in the box?"* This document answers that question with the same rigor as the prior pass — live component inventory plus official documentation, not vibes — and folds in several blind spots the prior research pass didn't surface.

Three corrections to how this workstream frames itself, per instructions received mid-analysis this session:
1. **The benchmark target is UI Builder / Data Visualization / Performance Analytics itself**, not just the third-party competitors. Sections 1–3 below are a full capability audit of what ships natively today.
2. **Positioning is universal, not tied to any one delivery firm's go-to-market story.** Anywhere the prior research surfaced firm-specific packaging patterns, that material is set aside here in favor of a generic "who would build/buy this and why" framing.
3. **Live re-probing of `dev390988` was requested but could not be completed this session** — the OAuth application registered in the prior session (`01-live-instance-findings.md` §2) issued a 30-minute bearer token that is not persisted, by design (no secrets are stored in this repo), and a broad filesystem credential search was correctly blocked by the environment's permission classifier. This document is therefore built on (a) the live component inventory already captured in `01-live-instance-findings.md` §5 — which is real, direct evidence from that exact instance, not assumed — plus (b) fresh documentation research to fill in what the live table query alone couldn't show (interaction behavior, theming, export). **If deeper live verification is wanted (e.g., actually clicking through a drilldown, testing cross-filter behavior, checking mobile rendering firsthand), that needs a fresh OAuth client secret / bearer token supplied for this session** — re-registering the OAuth app requires the instance admin password, which isn't in this environment either. Flagging this explicitly rather than silently working around it.

---

## 1. The native stack is not one tool — it's three fragmented surfaces

This is the single biggest thing worth understanding before comparing chart counts: **"ServiceNow's native dashboard capability" is not a single, coherent product.** It's three separate authoring surfaces built at different times, with different chart libraries, different data-binding models, and different interaction engines, that happen to be visible from the same platform:

| Surface | What it is | Chart-type count | Data binding | Authored where |
|---|---|---|---|---|
| **Now Assist Data Visualization Generation** | NL-prompt-driven AI chart creation | **5**: single score, line, vertical bar, pie, list *(Verified-Documentation/Verified-Practitioner — carried over from `00-landscape-assessment.md`, unchanged as of this pass, see §4)* | Semantic Table config (`sn_query_gen_table_config`) → generated query | Now Assist panel |
| **UI Builder "Data Visualization" embeddable component** | The component you drag onto a custom Next Experience page | **6 primitives, live-confirmed on `dev390988`**: bar, donut/pie, line/timeseries, sparkline, timeline, single-score *(Verified-HandsOn(ours) — `01-live-instance-findings.md` §5, `sys_ux_lib_component` query)* | UI Builder Data Resources: **Client State, GraphQL, REST, Transform** — no aggregate-specific resource type *(Verified-Documentation, see §1.4)* | UI Builder canvas |
| **Performance Analytics / Dashboard Designer ("PA Studio")** | The older, separate dashboard-and-widget authoring tool | **Up to 17 named types**: single score, boxplot, bubble, dial, gauge, geomap, heatmap, horizontal bar, vertical bar, pie, donut, pareto bar, pivot table, time series, calendar report, list, indicator scorecard *(Verified-Documentation: [Types of data visualization](https://www.servicenow.com/docs/r/now-intelligence/data-visualization-type-overview.html))* | Performance Analytics data collectors / breakdowns, its own scripting model | PA Studio / Dashboards app |

~~**Why this matters more than any single number:** none of the three "which chart types are available" answers found in earlier research (5, 6, or 17) is wrong — they're answers to three *different questions*, and a client evaluating "just use what ServiceNow gives you" will experience this as friction, not richness. To get anywhere near the 17-type palette onto a UI Builder page, you don't pick a wider chart-type dropdown — you author the chart in the separate PA Studio tool, then drop in a **"Saved Data Visualization"** bridge component to embed it. That's a two-tool workflow with its own documented reliability problems (§1.3).~~

> ❌ **The 6-vs-17 framing above is falsified.** The "6" came from a search-filter artifact in
> `01` §5 (the filter excluded ServiceNow's own `now-vis-*` / `now-visualization-extensions/*`
> components). Live enumeration on `dev390988` gives **≥15 types available to the UI Builder Data
> Visualization component**: bar, bubble, dial, gauge, geomap, heatmap, pareto, pie/donut,
> single score, timeseries, sparkline, navigator, pivot, calendar, indicator scorecard, timeline.
> ServiceNow's own [Types of data visualization](https://www.servicenow.com/docs/r/now-intelligence/data-visualization-type-overview.html)
> assigns ~16 types to the **Visualization Designer** and the UI Builder component consumes those
> same types. There is no palette gap to bridge, so the two-tool-workflow argument collapses with it.
>
> **A real seam does exist, but it's a different one:** *Classic Reporting* (`sys_report`, **29**
> chart types per live `sys_choice`) vs. *Platform Analytics / Visualization Designer*. And the
> instance shows ServiceNow actively **closing** it — `com.glide.par.coreui.migration_banner.enabled=true`,
> `com.glide.par.coreui_single_migration.enabled=true`, `com.glide.par.unified_analytics.enabled=true`,
> plus `par_coreui_migration_bridge_component/_widget/_dashboard/_sysauto` tables. Use this only if
> the fragmentation point is worth making at all, and note you'd be betting against ServiceNow's own
> roadmap. See [`04`](04-red-team-verification.md) §2.
>
> **What survives — restate the argument from *count* to *kind*:** the native palette has no sankey,
> treemap, sunburst, chord, network/force-directed, radar, waterfall, bullet, candlestick,
> parallel-coordinates, scatter-matrix, small-multiples or combo/dual-axis; each native type's visual
> treatment is fixed (theming reskins colour/type, it does not compose new grammars); and there is no
> free-form report canvas. That is still true, still demonstrable, and still enough. **Never say "OOB
> gives you six chart types"** — a client's own admin disproves it in ten seconds and every other
> claim in the deck loses credibility with it.

---

## 2. What each surface actually gives you (the capability audit)

### 2.1 Drilldown & filtering — real, but documented as unreliable in practice

- Drilldown is a real, documented feature: **"Add a drilldown event to a data visualization"** and **"Add a drilldown event to a saved data visualization"** are separate, supported configurations that pass `@payload.params.table` / `@payload.params.query` to a destination page. *(Verified-Documentation: [Chart interactions in a data visualization](https://www.servicenow.com/docs/r/now-intelligence/dv-chart-interactions.html), [Multiple Drill-Down Level Reports in UI Builder](https://www.servicenow.com/community/developer-articles/multiple-drill-down-level-reports-in-ui-builder/ta-p/3173165))*
- **But community threads — current, 2025–2026 — repeatedly report it breaking**: *"Dashboard in Workspace: Drilldowns do not work properly"*, *"Drilldown not working for 'Saved Data Visualization' component in UI Builder"*, *"Platform Analytics - Data Visualization - Drill Down to Chart Not Working."* *(Verified-Practitioner: [1](https://www.servicenow.com/community/platform-analytics-forum/dashboard-in-workspace-drilldowns-do-not-work-properly/m-p/3381551), [2](https://www.servicenow.com/community/platform-analytics-forum/drilldown-not-working-for-quot-saved-data-visualization-quot/m-p/3474076), [3](https://www.servicenow.com/community/platform-analytics-forum/platform-analytics-data-visualization-drill-down-to-chart-not/m-p/3058346))* This is a materially different claim from "drilldown doesn't exist" — it exists, is a documented recurring pain point precisely at the UI-Builder/PA-Studio seam described in §1, which is exactly where a unified single-surface tool would have an advantage.
- **Cross-filtering** ("make a data visualization act as a filter," interactive filters that "sit above widgets and narrow the view") is real and documented, with an explicit, honestly-stated limitation: it **"works best when your dashboard widgets share a compatible data source... tables that relate cleanly."** *(Verified-Documentation: [How to Add Interactive Filters in ServiceNow App Dashboards](https://www.servicenow.com/community/servicenow-ai-platform-articles/how-to-add-interactive-filters-in-servicenow-app-dashboards-2026/ta-p/3461519))* This directly reconfirms the cross-source/ad-hoc structural gap already identified in the prior dossier, now pinned to the exact mechanism (shared-table requirement) that causes it.

### 2.2 Data binding and the ACL gap — sharper than previously stated

The prior dossier established that GlideAggregate doesn't enforce ACLs. This pass adds a sharper, UI-Builder-specific version of that finding:

> ⚠️ **Corrected below.** "No aggregate data resource *at all*" is false — the live instance holds
> **1,454** data brokers including `Aggregation Query`, `Get aggregate counts`, `Get task aggregation
> query`, and three `Data Visualization API for …` brokers. Broker *types* also go beyond the four
> named in §1: Simple, Transform, REST, External REST, GraphQL, **Composite, Proxied, Scriptlet**.
>
> **The accurate — and sharper — claim:** aggregate brokers exist, but each is app-specific,
> hand-written, and individually responsible for its own ACL handling. There is no *generic,
> reusable, ACL-safe* aggregate data-resource type a builder can drag onto a page. ServiceNow's own
> OOB code demonstrates both the pattern and its ceiling: the shipped `SOW - Announcements Aggregate`
> broker guards with `if (!aggGr.canRead()) continue;` — a **table-level** check only, with nothing
> available for row-level correctness. That version of the argument comes with ServiceNow's own
> source as the citation, and still fully supports Layer 1. See [`04`](04-red-team-verification.md) §6.

~~**There is no GlideAggregate Query Data Resource in UI Builder at all.**~~ The only documented path to a *builder-facing* aggregate is a **Transform Data Resource** — i.e., hand-written server-side script — which the ServiceNow Community explicitly notes **"needs an ACL rule"** you write yourself. *(Verified-Documentation/Verified-Practitioner: [GlideAggregate Query Data Resource in UI Builder](https://www.servicenow.com/community/developer-forum/glideaggregate-query-data-resource-in-ui-builder/m-p/2985928), [All About Data Resources in UI Builder](https://www.servicenow.com/community/next-experience-articles/all-about-data-resources-in-ui-builder/ta-p/2360643))*

This means the *tool itself* offers builders no aggregate-with-ACL-checked-by-default option — the path of least resistance for anyone dragging a widget onto a UI Builder page and wiring it to a count/sum is the least-secure one, repeated by hand, per widget, across every dashboard anyone builds on the platform. It's not just "GlideAggregate is a gap you can misuse" — it's "the recommended workflow has no built-in safe option to reach for," which is a stronger and more specific version of the correctness argument than "ACLs aren't enforced by default." **A reusable, provably-correct aggregate data-resource type is not just a nice differentiator — it's fixing a hole in the tool's own supported workflow**, something a client's own admins hit routinely, per the community thread's existence.

### 2.3 Theming — reskinning, not a new visual language

Customization inside the UI Builder canvas for the Data Visualization component covers colors, fonts, and other visual properties, with the caveat that **colors must be RGB values, not hex** — a small but real friction point for anyone pasting brand colors from a design system. Deeper, reusable theming needs **Theme records** and, for easier management, the separate **Theme Builder** Store app; CSS custom properties can be layered on top for shared styling across components. *(Verified-Documentation: [UI Builder – Theming](https://www.servicenow.com/community/next-experience-articles/ui-builder-theming/ta-p/2331911), [UI Builder: Theming Basics](https://codecreative.io/notebook/ui-builder-theming-basics/))* This is real, working theming — but it's theming of a fixed small chart-type palette, not the ability to introduce new chart grammars, animations, or bespoke visual treatments. It answers "can it match my brand's colors" (yes) not "can it look like a bespoke Power BI report" (no — that's the rendering-engine gap the custom-ECharts approach already targets).

### 2.4 Export & signage — ❌ MOSTLY FALSIFIED (export ships natively; only signage may survive)

> ❌ **The claim below is false on a current-release instance.** Live evidence from `dev390988`:
>
> - `sys_choice` on **`par_export_dashboard.file_type`** → **`ppt` (PPT)** and **`pdf` (PDF)**,
>   with `page_size` (a3/a4/letter/legal) and `orientation` (portrait/landscape).
> - `sys_choice` on `par_export_visualization.file_type` → pdf, png, jpeg, csv, xls, xlsx,
>   Embedded PNG, Embedded LIST.
> - `sys_properties`: `glide.par.export.enabled=true`, **`glide.par.export.ppt.max_visualizations_allowed=150`**,
>   `glide.par.export.use_uxf_renderer=true`, `glide.par.export.use_multivis_api=true`,
>   `glide.par.export.host` (a dedicated server-side render service), `com.snc.pdf.exports.enabled=true`.
> - Tables `par_export`, `par_export_job` (queued/processing/completed/failed),
>   `par_export_dashboard`, `par_export_visualization`, `snpar_sched_export_v_scheduled_export_visualization`.
> - Components `sn-par-scheduled-export`, `sn-par-export-email-composer`.
> - Official docs page slug is literally `export-pae-dashboard-ppt.html`, plus *"Schedule the export
>   of dashboards and data visualizations."*
>
> **Native, asynchronous, job-queued, schedulable, emailable PPT and PDF dashboard export ships and
> is enabled.** The community threads cited originally pre-date it. **Layer 5 / Phase 5 must be cut
> or rescoped** — export is parity work, not a differentiator, and claiming otherwise is the kind of
> error a client's admin catches in the first demo. See [`04`](04-red-team-verification.md) §4.
>
> **What may still survive:** wall-monitor / digital-signage **rotation** was not verified either way
> this pass. It is now the only remaining candidate in this section, and it needs its own check
> before anything is built on it.

~~**There is no native PPT export for UI Builder dashboards or the Data Visualization component.** The only OOB path is exporting a single visualization (image/PDF-style), and dedicated "export to PPT" documentation that does exist is scoped to specific IT Business Management reports, not general dashboards.~~ *(original citations: [Export a data visualization](https://www.servicenow.com/docs/r/now-intelligence/export-visualization-vd.html); [OptiSigns](https://www.optisigns.com/post/display-servicenow-dashboards-in-the-workplace))*

### 2.5 What's not served anywhere natively — the concrete coverage target

Putting §1–2.4 together, here is the concrete list of what a unified, ECharts-based custom build should cover that no native surface (Now Assist, UI Builder, or PA Studio) reaches today:

- **Exotic-but-common enterprise chart types:** sankey, treemap, sunburst, network/force-directed graph, radar/spider, funnel with stage conversion, waterfall, bullet chart, candlestick/OHLC, parallel coordinates, box-and-whisker with real outlier/jitter points (the OOB "boxplot" exists but is a simple summary form), scatter matrix, calendar heatmap (OOB "calendar report" exists but is simpler), combo/dual-axis charts, small multiples.

  > 🔴 **THIS LIST IS SUBSTANTIALLY WRONG — REWRITTEN BELOW.** The Visualization Designer chart-type
  > picker was read directly on `eypocinst` and contains **24 types**, including **boxplot**,
  > **heatmap**, **scatter**, **pareto**, **geomap**, **pivot table** and **quadrant bubble**.
  > (Count history: 6 → ~16 → **24**. The picker outranks every other source.)
  >
  > **Corrected list — genuinely absent from the modern Visualization Designer:**
  > sankey · treemap · sunburst · chord · network/force-directed · radar/spider · waterfall ·
  > bullet · candlestick/OHLC · parallel coordinates · scatter **matrix** (plain scatter exists) ·
  > small multiples · combo/dual-axis · **histogram / binned distribution** · funnel¹ · pyramid¹
  > *(¹ present in **classic** reporting only — say "absent from the modern PAR/UI Builder surface,"
  > never "absent from ServiceNow," or a client admin will open classic and show you a funnel.)*
  >
  > ⚠️ **Do not lead with chart variety.** A 24-type palette is respectable; opening with "the native
  > palette is limited" loses the room. **Lead with the intelligence gap instead** — the platform
  > *has* heatmap and boxplot, but Now Assist cannot emit either, and asked for a distribution it
  > renders one bar per raw value with `(empty)` dominating. See [`04`](04-red-team-verification.md)
  > §9C.1–§9C.4.
- **Real cross-filtering/brushing** across charts regardless of underlying table relation — not gated on "tables that relate cleanly."
- **Free-form report/canvas layout** (VividCharts' "Slate" concept) rather than UI Builder's grid/container-only page model — matters for anyone building slide-deck-style exec reports, not just live dashboards.
- **A reusable calculated/derived-measures registry** — something closer to a lightweight semantic layer than "write a new Transform script per widget every time." This doesn't need to (and per CLAUDE.md, shouldn't be oversold to) reach DAX/cross-source parity, but a named, reusable metric definition beats a one-off script per chart.
- **Reliable, single-surface drilldown** that doesn't inherit the PA-Studio/UI-Builder seam bugs in §2.1.
- **A built-in, ACL-correct aggregate data resource** — not a per-widget hand-written workaround.
- ~~**PPT/PDF export and wall-signage rotation**, native, not bolted on via a third-party signage vendor.~~ → ❌ **export ships natively** (§2.4 banner); only **wall-signage rotation** remains a candidate, and it is unverified.
- Everything the prior dossier already flagged: **AI-driven KPI discovery, data-shape-adaptive chart-spec generation, and provable ACL correctness**.
  > ⚠️ **Corrected.** Of these three, only two are still open on any native surface:
  > - **Data-shape-adaptive chart-spec generation** — ✅ genuinely absent everywhere, unchanged.
  > - **Provable row-level ACL correctness on aggregates** — ✅ absent, now confirmed hands-on and
  >   strengthened (`GlideQuery.withAcls()` throws on aggregates). **This is the strongest leg.**
  > - **AI-driven KPI discovery** — ⚠️ **partly served natively.** Performance Analytics ships
  >   KPI Signals (autonomous anomaly/trend-break detection), Spotlight (ML driver ranking) and
  >   forecasting, all active on `dev390988`. What remains open is metric ***candidacy*** — deciding
  >   which metrics should exist from table/process content, upstream of PA indicator definition.
  >   Scope Layer 2 to that, and never claim "no native autonomous analytics." See
  >   [`04`](04-red-team-verification.md) §5.

---

## 3. Two gaps the prior research pass missed entirely

Neither of these appeared in `00-landscape-assessment.md` / `01-live-instance-findings.md` / the compass dossier. Both were surfaced this session and are significant enough to change how "beautiful across the whole experience" gets scoped.

### 3.1 Accessibility — the compliance obligation is entirely on the builder, for both approaches

ServiceNow benchmarks its own OOB products against **WCAG 2.2** (the current baseline, not 2.1 — worth correcting anywhere 2.1 AA is quoted as the target) plus Section 508 and EN 301 549, publishing per-product Accessibility Conformance Reports (ACRs). *(Verified-Documentation: [Understanding Accessibility Conformance Reports](https://www.servicenow.com/community/servicenow-ai-platform-articles/understanding-accessibility-conformance-reports-acrs/ta-p/2920062))* **Critically, no ACR exists for UI-Builder-authored custom pages or custom UXF components as a category** — that responsibility sits with whoever built the page, native-OOB-component-only or not. ServiceNow's own developer guidance recommends using `@servicenow/react-components` specifically because doing so is what confers ARIA attributes, keyboard navigation, and screen-reader support automatically — the clear implication being that a canvas/SVG-rendered charting library (ECharts included) gets **none of this for free**.

The one proven, ServiceNow-endorsed pattern worth copying directly: classic Performance Analytics has a documented feature (introduced in San Diego) that toggles a chart into a **linear, text-based data-table view** for screen-reader/keyboard users. **This needs to become a first-class, mandatory workstream in the architecture** — every custom chart ships a same-page toggle to an accessible table equivalent — not an assumed inheritance from "the platform is accessible" or a nice-to-have deferred to a later phase. Whether the OOB UI Builder "Data Visualization" component itself inherits this pattern when embedded is not confirmed either way and would need live verification (see §0.3).

### 3.2 Now Mobile — "Unsupported screen," and it's a shared constraint, not a reason to prefer OOB

**Custom UI Builder / Next Experience screens do not render in the native Now Mobile app at all** — opening one, even pinned to Quick Links, throws an explicit **"Unsupported screen"** error. *(Verified-Documentation/Verified-Practitioner: [Community thread](https://www.servicenow.com/community/mobile-apps-platform-forum/getting-error-unsupported-screen-in-nowmobile/td-p/3458590), KB0551212 "Classic Mobile UI limitations")* Now Mobile's supported surface is limited to record-based forms (OOB tables or custom tables with a dedicated mobile form view) — a freeform dashboard page is categorically outside that, and this cascades to AI Lens too (mobile-form-only).

**The important nuance:** this limitation applies to *any* screen authored via UI Builder/Next Experience — including a dashboard built entirely from OOB Data Visualization components, with zero custom code. So this is **not a reason to prefer the native UI Builder path over a custom build** — both hit the identical wall on Now Mobile. It is, however, a real gap in the "beautiful across every form factor" promise that needs a named, stated mitigation regardless of which path is chosen: most realistically, a responsive mobile-web view accessed via browser (an unverified, separate rendering path — not yet confirmed to work well) rather than any native-app rendering. State this to the client proactively; don't let it surface for the first time in UAT.

---

## 3A. A full gap registry now exists — read it alongside this section

A follow-up research pass went looking for **every remaining gap that could be found with a real citation** — governance/DevOps, runtime/technical limits, and licensing/certification/support. Every finding there carries a confidence label (Confirmed / Corroborated / Unverified / Not found) and a direct source; nothing is asserted without one. Full detail: [`03-gap-registry.md`](03-gap-registry.md). The single most important new fact from that pass, worth stating here rather than only in the registry:

> **ServiceNow's own official FAQ states that custom components built on the Next Experience UI Framework are explicitly excluded from standard ServiceNow support**: *"No. ServiceNow supports the Next Experience UI Framework and ServiceNow CLI technologies... but will not support any custom components customers are creating and deploying to their instances, nor will we provide guidance on creating a custom component."* *(Confirmed, verbatim: [UI Builder FAQ, ServiceNow Community, Q10](https://www.servicenow.com/community/next-experience-articles/ui-builder-faq/ta-p/2331977))*

Whoever builds this owns 100% of the support burden for every custom chart component, indefinitely. This is not a footnote — it belongs in front of any client considering this approach, and it's the strongest concrete argument for the portability point already made in §6 below: build on portable, non-proprietary tooling (ECharts, plain-JS, no framework beyond what UXF itself requires) specifically because no one else — not ServiceNow, not necessarily the original builder forever — is obligated to keep it running.

A second finding from that pass changes how Layer 1 (§5) should be framed: **ACL enforcement is not only this product's own differentiator — it is a named, documented Store-certification rejection criterion** ("GlideRecord without ACL enforcement" is cited as a common cause of failed app certification). *(Confirmed: [Guide to getting your App Certified](https://www.servicenow.com/community/app-publisher-blog/guide-to-getting-your-app-certified-and-certification/ba-p/2477630); [Store Applications Certification Process KB0813336](https://support.servicenow.com/kb?id=kb_article_view&sysparm_article=KB0813336))* If Store distribution is ever the plan, Layer 1 isn't optional depth — it's a pass/fail gate.

A third finding changes how "live-updating dashboard" gets built in Layer 4: **there is a documented, supported, native push mechanism** — the **Record Watcher Data Resource** (AMB-backed, introduced in the Tokyo release) — and a documented, explicitly **unsupported** alternative (raw AMB inside hand-coded components, which ServiceNow itself told a developer had "no docs that could be passed on," and which has a real, cited performance ceiling around 200+ records before browser tabs start locking up). *(Confirmed: [How to use AMB Record Watcher in ServiceNow UIB](https://www.servicenow.com/community/next-experience-articles/how-to-use-amb-record-watcher-in-servicenow-uib/ta-p/2352975); [Using AMB with Web Components](https://www.servicenow.com/community/developer-articles/using-asynchronous-message-bus-amb-with-web-components-i-e/ta-p/2309411))* Build real-time refresh on the Record Watcher Data Resource; do not attempt raw AMB.

Everything else from that pass — promotion/DevOps risk, ATF's limited coverage of custom UXF components, i18n/RTL being entirely the builder's own responsibility, unresolved licensing/certification specifics, data-volume/export limits, and the still-untested Shadow-DOM chart-rendering-at-scale question — is catalogued with citations in [`03-gap-registry.md`](03-gap-registry.md) rather than duplicated here.

---

## 4. Three smaller corrections worth carrying forward

1. **The "AI push is closing the window" finding should be treated as accelerating, not just directionally true.** AI Data Explorer (AIDE) already has a live ServiceNow Store listing (not just a keynote announcement), and Autonomous Data Analytics is being cited with named customer references (The Foschini Group, Universal Health Services) rather than only roadmap language. *(Verified-Documentation: [ServiceNow Newsroom](https://newsroom.servicenow.com/press-releases/details/2026/ServiceNow-launches-the-real-time-data-foundation-that-puts-autonomous-AI-to-work-across-the-enterprise/default.aspx), [ServiceNow UK blog](https://www.servicenow.com/uk/blogs/2026/autonomous-data-analytics-strong-vision))* What's still unconfirmed is whether AIDE does *content-aware KPI selection* (this product's differentiator #1) versus *natural-language querying of pre-existing, human-defined metrics* (a different, narrower capability) — worth a hands-on trial if a Store install becomes available, rather than assuming either answer.
2. **No release has shipped after Australia as of today (July 31, 2026).** The next release, **Brazil**, is targeted for early access mid-September 2026 and GA early November 2026. *(Verified-Practitioner: [ServiceNow Community](https://www.servicenow.com/community/servicenow-impact-forum/brazil-release/m-p/3518630))* The 5-chart-type cap on Now Assist Data Visualization Generation is confirmed unchanged as of a March 9, 2026 Community guide — still current. Re-check both of these against Brazil's release notes once it ships; that's the next natural checkpoint for the whole thesis, not an arbitrary future date.
3. **The VividCharts G2 rating needs a manual re-check before it's quoted again.** The prior dossier cites 4.7/5 across 16 reviews; this pass's search returned a conflicting snippet of 4.6/5 across 5 reviews, and a direct fetch of the G2 page was blocked (403). This could be stale caching, a different listing, or genuine review churn — **don't repeat either number in a client-facing document until someone manually opens the live G2 page and confirms it.**

---

## 5. The buildable architecture

Five layers, each justified by a specific gap identified above or in the prior research. This is deliberately more specific than the prior dossier's phase list — it names the actual mechanism per layer, drawn from patterns proven in adjacent domains (RAG semantic caching, ML drift monitoring, row-level-security databases) rather than inventing something from nothing. Where a mechanism is a synthesis rather than a proven precedent, that's called out explicitly — this is a place to be honest about engineering risk, not to oversell.

### Layer 1 — ACL-safe aggregation service ⭐ **PROMOTED: this is the headline, not one of five**
**Problem it solves:** §2.2 — there is no row-level-ACL-checked aggregate option anywhere in the native stack; the tool itself pushes builders toward an insecure-by-default pattern.

> ⭐ **Red-team outcome: this is the only differentiator that got *stronger* under attack, and the
> only one now backed by a reproducible demonstration.** It should lead the pitch, ship in Phase 1
> alongside the first beautiful dashboard, and carry the demo.
>
> **The proof, live on `dev390988`, impersonating a user with zero roles:**
> ```javascript
> var ga = new GlideAggregate('incident');
> ga.addAggregate('COUNT'); ga.query(); ga.next();
> ga.getAggregate('COUNT');                       // -> "67"
> var grs = new GlideRecordSecure('incident');
> grs.query(); var n=0; while (grs.next()) n++;   // -> 0
> ```
> A user entitled to see **zero** incidents gets a KPI tile reading **67**.
>
> **And the sharper API argument:** `GlideQuery.withAcls()` *does* enforce ACLs — it simply refuses
> to aggregate. `new GlideQuery('incident').withAcls().aggregate('count')` throws
> **"Cannot use aggregate queries with withAcls()"**. ServiceNow's own ACL-aware query API is
> deliberately blocked from aggregating. That is far better evidence than "there's no
> GlideAggregateSecure" (also confirmed: `typeof GlideAggregateSecure === 'undefined'`).
>
> **Ship the caveat with the claim.** `GlideAggregate.canRead()` exists and gives a correct
> *table-level* answer, and ServiceNow's own OOB `SOW - Announcements Aggregate` broker calls it.
> Say *"no row-level enforcement, plus a table-level check you have to remember to call"* — not
> *"no ACL awareness"*, which is checkable and wrong. See [`04`](04-red-team-verification.md) §3.
- **Primary mechanism:** precomputed, persona/domain-scope-partitioned aggregate tables with **incremental** refresh (not full recompute) — the standard data-warehouse materialized-view pattern (Snowflake, Materialize, ksqlDB all do this: maintain a rollup by applying only the delta from new events, not recalculating from scratch). ServiceNow has no equivalent of Postgres/Snowflake row-level-security predicate push-down at the GlideAggregate layer, so this has to be built at the app layer: a scoped-app service that always composes the domain/ACL-equivalent filter into `addQuery()` before any aggregate runs, then materializes results per persona/domain scope on a schedule or change trigger.
- **Correctness harness, not a runtime path:** the "correct but slow" baseline — iterate with `GlideRecordSecure` and count in memory — becomes an **automated reconciliation job**: periodically spot-check the precomputed aggregate against a fully secure enumeration for a sample of persona/scope combinations, and surface a per-tile "ACL-verified" badge only when that check has passed. This operationalizes the CLAUDE.md mandate that every aggregate binding gets checked against the viewer's persona, as a continuous test rather than a one-time manual audit.
- **Named risk:** the refresh trigger must fire on both data change *and* ACL/role-definition change — precomputed views that update on data change alone can silently serve correctly-computed-but-wrongly-scoped results after a permission change, a documented footgun in comparable systems (Kusto's materialized-view RLS docs call this out explicitly).

### Layer 2 — Semantic / KPI layer ⚠️ **RESCOPED — narrower than originally written**
**Problem it solves:** ~~autonomous metric discovery (no native surface does this)~~ → **metric *candidacy*** — deciding which metrics should exist — plus the "one-off Transform script per widget" pattern in §2.2/2.5.

> ⚠️ **Rescoped by the red-team pass.** Performance Analytics *does* do autonomous analysis:
> **KPI Signals** continuously flags anomalies and trend breaks, **Spotlight** ML-ranks KPI drivers,
> and native **forecasting** ships (`sn-par-forecast-config`) — all active on `dev390988`, none
> prompt-driven. What PA does **not** do is decide *which indicators should exist in the first place*;
> a human configures every indicator.
>
> **So Layer 2 targets the step upstream of PA indicator definition, and feeds it — it does not
> replace PA's analysis.** Do not claim "no native autonomous analytics"; it is false and a client
> running PA will say so. See [`04`](04-red-team-verification.md) §5.

- Reuse the Use Case 1 content graph, pointed at dashboard/report metadata instead of portal/IA structure, to surface KPI/metric *candidates* from table and process metadata rather than requiring a human to name the metric first.
- A small **reusable calculated-measures registry** — named, versioned metric definitions that multiple charts can reference — closing part of the "no DAX-equivalent" gap without overclaiming full semantic-modeling parity (per CLAUDE.md §4's honesty requirement).

### Layer 3 — AI adaptive chart-spec layer (the least-proven layer, budget engineering risk accordingly)
**Problem it solves:** data-shape-adaptive chart generation — unproven anywhere as a shipped BI feature, the single biggest technical risk per CLAUDE.md §6.
- **Separation of concerns, Flint/Draco-style:** an LLM (via the platform's Generative AI Controller, routed to an external model — see the residency note below) proposes a compact, structured "what": semantic field types, chart intent, field-to-encoding-channel mapping. A **deterministic constraint layer** (Draco-style: hard/soft rules like "a bar chart's quantitative axis must include zero") owns "how" — it validates, corrects, or outright rejects the LLM's proposal, and can complete a partial spec on its own. Only the first stage is probabilistic; everything downstream is deterministic and independently testable — this is what makes the system auditable enough to demo credibly, not a black box.
- **Never trust temperature=0 as a consistency guarantee.** Structured-output schema enforcement (constrained decoding) guarantees the output is well-formed; it does not guarantee the same input produces the same chart choice twice. The deterministic validator in the paragraph above is what actually owns consistency, not the LLM call.
- **Cost/latency control via semantic caching, adapted from the RAG-gateway pattern (GPTCache-style: pluggable embedding + vector store, TTL/eviction), keyed on a "data-shape signature"** — a fingerprint over field schema, cardinality bucket, skew/outlier summary, time-density bucket, rounded so near-identical shapes collapse to one cache entry — **rather than raw data or literal prompt text.** Every cache key is scoped by persona/ACL context (never shared across viewers with different access) — the same discipline as Layer 1, and a well-documented cache-leakage failure mode if skipped. **This exact composite cache key is a synthesis from adjacent proven patterns, not a citable precedent — treat it as a real design bet to prototype and validate early, not an assumed-safe default.**
- **Drift-triggered invalidation, not TTL alone:** a scheduled job computes a small per-field statistics vector (cardinality, null rate, skew, outlier count, time-density) and diffs it against the vector that produced the currently-cached spec, using Population Stability Index or Jensen-Shannon divergence for distribution shift (PSI < 0.1 = no action, 0.1–0.25 = investigate, > 0.25 = invalidate) plus a hard cardinality-delta threshold for categorical fields. This is a direct adaptation of mature ML-ops drift-monitoring technique (the individual metrics are production-proven; using them to drive chart-spec re-selection specifically is the novel part).
- **Fallback hierarchy when the LLM is unavailable or budget-capped:** circuit-breaker pattern (closed → open after a failure threshold → half-open probe), falling back to (1) a cheaper/faster model, (2) a near-match cache hit, (3) the deterministic rule-based selector running **with zero LLM dependency**. Build rung 3 as a fully standalone selector from day one — it's not just a validator, it's also the outage/budget fallback, so it can't depend on the LLM ever having run.
- **Data residency, stated as a decision point, not an assumption:** ServiceNow's own proprietary "Now LLM" is reserved for ServiceNow's managed Now Assist skills and is **not reachable from a custom scoped app** — any custom AI feature here routes through the Generative AI Controller to an external provider (Azure OpenAI, OpenAI, Google Gemini, AWS Bedrock/Claude, IBM WatsonX, or a generic connector). ServiceNow's documented "data stays in-region, deleted after processing" guarantee applies specifically to Now LLM traffic, **not automatically to whichever external model ends up configured behind the Controller.** For a client in a regulated industry, the residency/training-data-use answer depends entirely on that specific provider deployment's configuration (region, data-zone options, BYO-key vs. shared tenant) — this needs to be a named, per-client decision confirmed explicitly, not a "we use ServiceNow's native AI stack so it's covered" assumption.

### Layer 4 — Rendering layer
**Problem it solves:** the primary "beautiful" requirement, plus the accessibility and mobile gaps from §3.
- Custom Next Experience (UXF) components, ECharts as the primary engine (Apache-2.0, richest chart set, plain-JS-safe against the documented Webpack/sub-exports fragility — unchanged recommendation from the prior dossier), consuming Now Design System tokens for color/typography/spacing.
- **A free-form canvas/report-layout mode**, not just a dashboard grid — closes the concrete gap in §2.5 (VividCharts' "Slate" concept) for anyone building exec-report/slide-style output, not only live-monitoring dashboards.
- **Mandatory accessible-table fallback per chart** (§3.1) — every custom visualization ships a same-page toggle to a linear, screen-reader-navigable table view, matching the one proven OOB pattern (Performance Analytics' linear view) rather than assuming ARIA-labeling a canvas element is sufficient (it isn't — canvas is opaque to assistive tech by default).
- **A stated, tested mobile-web fallback path** (§3.2) given that no UI-Builder-authored screen — custom or OOB — renders in the native Now Mobile app.
- **Internationalization is a named workstream, not an inheritance from the Now Design System.** Custom-component i18n requires explicit wiring per component (`requiredTranslationKeys` in `now-ui.json`, matching `sys_ui_message` records, `@servicenow/library-translate`) — untranslated keys render as raw strings if this is skipped. RTL is handled per-OOB-component in the Horizon Design System, but no evidence was found that it extends automatically to a bespoke chart's internals (axis direction, legend position, number/date formatting) — that's the builder's own responsibility if any client needs it. *(Confirmed: see [`03-gap-registry.md`](03-gap-registry.md) §2.7–2.9 for citations.)*
- **Real-time refresh uses the Record Watcher Data Resource, not raw AMB** (§3A above) — with an explicit design awareness of its ~200-record throttling ceiling before client-side batching is needed.
- **Shadow-DOM chart-rendering performance at scale is an open, untested risk**, not an assumed-fine inheritance from ECharts' own (non-ServiceNow) canvas-vs-SVG benchmarks — budget a dedicated load test in Phase 3/7, not just a demo-scale sanity check. *(See [`03-gap-registry.md`](03-gap-registry.md) §2.11.)*

### Layer 4A — Delivery/DevOps discipline (a prerequisite, not a layer of the running product)
**Problem it solves:** the promotion and testing gaps in [`03-gap-registry.md`](03-gap-registry.md) §1, which are real and citable, not hypothetical.
- **Source Control (Git/SCM) as the primary promotion path, not Update Sets** — Update Sets are confirmed not to reliably carry custom UXF component source or all UI Builder page artifacts (missing events, missing parent-app links causing blank pages after promotion). Use Update Sets, if at all, only for what they're documented to reliably carry; treat Source Control as the system of record. *(§1.1, 1.3–1.6 in the registry.)*
- **A dedicated test strategy that does not lean on ATF as the primary mechanism** — ATF's own ServiceNow-authored documentation acknowledges it doesn't cover custom UXF/UI Builder components with parity to classic forms. Plan component-level tests (unit/visual regression in CI, outside ATF) as the primary net, with a thin ATF/Custom-UI-step layer only for what it can actually reach. *(§1.8–1.9.)*
- **A regression-test pass after every quarterly platform upgrade**, specifically around data-binding configuration — a ServiceNow employee has acknowledged non-zero upgrade risk to in-flight UI Builder work, with a corroborated report of binding configurations "occasionally clearing unexpectedly" across upgrades. *(§1.11–1.12.)*

### Layer 5 — ~~Export &~~ Governance ⚠️ **SPLIT — the export half is cut**
**Problem it solves:** ~~§2.4's confirmed native gap~~ → making Layer 1's correctness claim visible and auditable rather than an internal implementation detail.

> ⚠️ **The export half of this layer is cut.** §2.4's "native gap" was falsified — ServiceNow ships
> native, scheduled, emailable **PPT and PDF** dashboard export (150-visualization cap), enabled on
> `dev390988`. Build export only as **parity**, sized accordingly, and never pitch it as a
> differentiator. Wall-signage rotation is the one unverified remainder; check before scoping it.
>
> **The governance half stays and gets bigger** — it is now Layer 1's public face and, per
> [`03`](03-gap-registry.md) §3.2, a Store-certification pass/fail gate.

- ~~Native PPT/PDF export and a wall-signage rotation mode, closing the gap that currently pushes clients toward VividCharts or third-party signage tools.~~ → parity-only; see banner.
- A visible **"ACL-verified" badge** per aggregate tile, backed by Layer 1's reconciliation job — the correctness engine and the trust signal are the same piece of work, not separate backlog items (per CLAUDE.md §5's explicit instruction not to split these).
- A running log of every deviation from OOB components, with its justification, per the governance document's own exception-clause discipline (CLAUDE.md §4) — a compliance asset, not paperwork to skip.

---

## 6. Positioning — universal framing

This section intentionally avoids tying the offering to any single delivery firm's commercial story (a separate, later conversation per instruction received this session). Framed generically, for whoever is building or evaluating this:

- ~~**The real "why build" answer isn't "beat VividCharts" — it's "the native stack itself is three disconnected tools with a documented drilldown-reliability seam, no safe aggregate primitive, and no export/signage story."**~~
  > ⚠️ **Rewrite this.** Two of its three legs were falsified: the "three disconnected tools with
  > different chart counts" framing (§1 banner) and "no export story" (§2.4 banner). The corrected
  > version, which is narrower but actually holds up:
  >
  > > **The real "why build" answer is: the native stack has no row-level-ACL-safe aggregate
  > > primitive — ServiceNow's own ACL-aware query API refuses to aggregate at all — and its chart
  > > palette, while broader than often assumed (~16 types), is fixed in *kind* and *treatment*: no
  > > sankey, treemap, sunburst, network, radar or waterfall, no composable visual grammar, and no
  > > free-form report canvas.**
  >
  > Drop the export claim entirely. Keep drilldown reliability only if it is reproduced hands-on
  > (Phase 0) — it is currently community-sourced and unverified by us.
- **The provable-ACL-correctness capability is valuable to any organization running ACL-sensitive dashboards** — regulated industries, multi-tenant MSPs, any enterprise where "who can see this aggregate" actually matters — not tied to any one firm's brand identity. State it as a governance/audit capability the platform itself doesn't provide, full stop.
- **Portability is a legitimate, generic selling point regardless of who delivers it:** the stack (ECharts under Apache-2.0, native custom UXF components, Now Design System tokens, no proprietary runtime dependency) means whoever inherits the codebase after initial delivery — the client's own admins, a different SI, an in-house platform team — can maintain and extend it without being locked into the original builder. This directly answers the standard build-vs-buy objection ("what happens when the original team moves on") with a concrete, honest answer: nothing proprietary, nothing that requires the original vendor to keep running.
- **Don't oversell "Power-BI-like" as literal parity**, per CLAUDE.md §4 — the honest ceiling is high on visual/interaction richness and low on cross-source modeling, DAX-equivalent measures, and true ad-hoc self-service exploration. Say "Power-BI-grade visual and interaction quality on ServiceNow-native data," never "Power BI replacement," regardless of who's presenting it.

---

## 7. Updated phased roadmap

> ⚠️ **Roadmap revised by the red-team pass — see [`04`](04-red-team-verification.md) §9.3.**
> Phase 0 is largely dischargeable (access method solved). Phases 1 and 2 **merge**. Phase 5 is
> **cut or radically rescoped**.

**Phase 0 — Live-instance re-verification.** ~~Blocked on credentials.~~ **Mostly unblocked:**
session-cookie auth works with the `X-UserToken` header, and the same session drives
`POST /sys.scripts.do` background scripts ([`04`](04-red-team-verification.md) §1). Still open and
worth a pass: hands-on drilldown reliability, cross-filter behaviour across *unrelated* tables
(native `sn-par-filter-cascading-config` suggests this is better than documented), whether the
embedded OOB DV component inherits `sn-chart-screen-reader-table`, and whether wall-signage
rotation is genuinely absent.
> ⚠️ **Session hygiene:** `GlideImpersonate` inside a background script mutates the *real* session.
> Run impersonation tests last, or restore the original user in a `finally` block.

**Phase 1 — Prove the visual bar *and* demo the ACL leak, together.** *(Phase 2 merged in.)*
Benchmark side by side against the **Visualization Designer's full ~16-type palette** — not against
a strawman six-type one — and against VividCharts. Compete on chart *kind* (sankey, treemap,
sunburst, network, radar, waterfall, parallel-coordinates), composable visual treatment, and
free-form canvas, because those are what the native palette genuinely lacks.
**Ship the ACL demo in the same phase**: the `GlideAggregate` 67 vs `GlideRecordSecure` 0 script is a
stronger opener than any chart, and Layer 1's reconciliation job plus the visible "ACL-verified"
badge belong here — not in a later phase.

**~~Phase 2 — ACL-correctness moat~~ — merged into Phase 1.** It is the lead differentiator, so it
cannot ship after the thing it differentiates.

**Phase 3 — Adaptive chart-spec generation, Layer 3 above.** Still the highest-risk phase per CLAUDE.md §6. Add explicitly to the prototype scope: the semantic-cache data-shape-signature design and the drift-detection job, both flagged above as syntheses rather than proven precedents — validate these early on real data rather than assuming the caching design works as sketched.

**Phase 4 (elevated, was implicit before) — Accessibility and mobile-fallback workstream.** Per §3, this is not optional polish: build the per-chart accessible-table toggle and a tested responsive mobile-web path as first-class deliverables, not something discovered missing during UAT.

**~~Phase 5 — Export/signage parity~~ — CUT or radically rescoped.**
~~per §2.4 and the prior dossier's Phase 4: native PPT/PDF export and wall-display rotation, closing the one area where VividCharts and third-party signage tools currently have a real, visible edge.~~
> ❌ ServiceNow ships native, scheduled, emailable **PPT and PDF** dashboard export (§2.4 banner).
> There is no gap to close. Build export as **parity only**, sized as such. The single surviving
> candidate is **wall-signage rotation**, which is unverified — check it before scoping any work.

---

## 8. Open items for the user

- **Live credentials for `dev390988`** (or equivalent) if deeper live verification of drilldown/cross-filter/accessibility/mobile behavior is wanted beyond what's documented here — an OAuth client id/secret or a fresh bearer token would let Phase 0 run this session.
- **The VividCharts G2 rating discrepancy (§4.3)** needs a manual check of the live G2 page before either number gets quoted again in a client-facing document.
- Confirmed: this document keeps positioning generic per instruction; the firm-specific commercial framing mentioned mid-session is explicitly out of scope here and can be layered on separately later if wanted.
