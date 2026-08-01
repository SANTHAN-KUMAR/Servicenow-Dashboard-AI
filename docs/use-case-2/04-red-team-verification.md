# Use Case 2 — Red-Team Verification & Corrections

**Status:** authoritative correction record. Where this document and any of `00`/`01`/`02`/`03` disagree on a **fact**, this document wins (per CLAUDE.md §3 rule 1: research/measurement outranks assumption). Where it disagrees with `/CLAUDE.md` on **what we're building for**, CLAUDE.md still wins.
**Date:** 2026-07-31
**Method:** adversarial re-verification of every load-bearing claim in this folder, against the live `dev390988` instance (authenticated admin session, Table API + `sys.scripts.do` background scripts) plus official ServiceNow documentation. Nothing below is asserted from reasoning alone; every FALSIFIED / CONFIRMED entry names the exact query or script that produced it.

> **Why this pass exists.** The prior live-instance pass (`01-live-instance-findings.md`) produced findings that were then treated as the empirical backbone of the whole positioning (`00` §8: *"Ceiling 1 is now backed by live data instead of an inferred count"*). Re-running those queries showed the backbone was built on a **search-filter artifact**, not on what the instance actually contains. Several other "confirmed gaps" turned out to be capabilities ServiceNow already ships. The net effect is not fatal — the strongest single claim got *stronger* — but the pitch has to be rebuilt around a different centre of gravity.

---

## 0. Executive summary — what changed

| | Claim | Prior status | New status |
|---|---|---|---|
| **F1** | REST API on dev390988 is OAuth-only; session-cookie auth rejected by design | asserted as verified | **FALSIFIED** — session auth works, prior pass omitted the `X-UserToken` header |
| **F2** | OOB chart palette is **6 primitives**, live-confirmed | the single most-cited "live" fact in the repo | **FALSIFIED** — ≥15 on the instance, ~16 named types in ServiceNow's own docs |
| **F3** | Native stack = 3 surfaces with 5 / 6 / 17 chart counts; must bridge PA Studio → UI Builder | core of `02` §1 | **LARGELY FALSIFIED** — the 6-vs-17 split does not exist |
| **F4** | No native PPT export for dashboards; export/signage is an open gap | basis of Layer 5 / Phase 5 | **FALSIFIED** — native PPT + PDF + scheduled + emailed export ships and is enabled |
| **F5** | Now Assist's 5-chart cap was live-confirmed on this instance | `00` §8 | **NOT SUPPORTED** — the skill is not installed here; claim survives on documentation only |
| **F6** | GlideQuery does not enforce ACLs | compass A5 | **FALSIFIED as worded** — `withAcls()` exists; it *hard-blocks aggregates*, which is a stronger finding |
| **C1** | GlideAggregate silently over-counts past row-level ACLs | Verified-Documentation | **CONFIRMED — Verified-HandsOn**, reproducible script below (67 vs 0) |
| **W1** | No native surface does autonomous KPI/insight discovery | moat pillar #1 | **MATERIALLY WEAKENED** — KPI Signals, Spotlight, forecasting and computed insights all ship natively and are active here |
| **W2** | No aggregate data resource in UI Builder at all | `02` §2.2 | **WEAKENED** — aggregate brokers exist; the real gap is narrower (no *reusable ACL-safe* one) |
| **W4** | Export/view limit property defaults (50k / 500k / 5k / 10k) | Unverified | **STILL UNVERIFIED — and the properties do not exist as records on this instance** |

**One-line consequence:** the differentiator is no longer a three-legged stool. **Row-level ACL correctness on aggregates is now the load-bearing leg** — it is the only claim that got stronger under attack, and it is now the only one backed by a reproducible demonstration.

---

## 1. Access — how to actually reach this instance

Recorded because `01` §1 enshrined a wrong conclusion that would otherwise be re-litigated.

**Session-cookie auth against the REST API works.** It is not OAuth-only. The requirement is the session token header:

```bash
# 1. GET /navpage.do with the browser session cookies -> scrape g_ck
#    grep -oE "g_ck = '[a-z0-9]+'" navpage.html
# 2. every REST call carries it:
curl -b cookies.txt -H "X-UserToken: $g_ck" \
  'https://dev390988.service-now.com/api/now/table/sys_user?sysparm_limit=1'
# -> 200 OK
```

Without `X-UserToken`, ServiceNow returns `401 User is not authenticated / Required to provide Auth information` — **the same error text a bad credential produces**, which is exactly what misled the prior pass into diagnosing a platform-level OAuth mandate. It is a missing-header error, not an auth-policy error.

The same session also drives **`POST /sys.scripts.do`** (background scripts) with `sysparm_ck=$g_ck`, which is how the ACL tests in §3 were run. That is a far more powerful verification surface than the Table API alone and should be the default tool for future passes.

**Operational warning, learned the hard way:** calling `new GlideImpersonate().impersonate(...)` inside a background script **mutates the real session**, not a sandbox. It left the session impersonating a role-less user; `logout_impersonator.do` then dropped the session to `guest` entirely and required fresh credentials to recover. Do impersonation tests **last in a session**, or wrap them so the original user is restored in a `finally` block.

**Basic Auth was not re-tested** (no password available this pass). Given that the reasoning which ruled it out was wrong, treat `01`'s Basic-Auth conclusion as unverified rather than settled.

---

## 2. The chart-palette finding — how the core number was wrong

### 2.1 What the prior pass did

`01` §5 queried `sys_ux_lib_component` for records whose name matched **chart / visualization / graph**, got 21 rows, stripped wrappers and config panels, and concluded **six primitives**: bar, donut/pie, line/timeseries, sparkline, timeline, single-score. `00` §8 then promoted this to *"live confirmation of the fixed, capped chart palette (Ceiling 1)."*

### 2.2 Why that was wrong

ServiceNow's actual visualization component family is named **`now-vis-*`** and its extension modules are **`now-visualization-extensions/*`**. Neither string contains "chart", "visualization" (the component names use the abbreviation `vis`), or "graph". **The search filter excluded the very components it was trying to count.** The instance has **1,831** components in `sys_ux_lib_component`; the prior pass looked at 21 of them.

### 2.3 What is actually there — live enumeration

`sys_ux_lib_component` where `source_script_name LIKE now-visualization-extensions` — **10 rows, exhaustive**:

```
now-visualization-extensions/__bar__          __bubble__     __dial__
now-visualization-extensions/__gauge__        __geomap__     __heatmap__
now-visualization-extensions/__pareto__       __pie__        __singleScore__
now-visualization-extensions/__timeseries__
```

Plus, from the `now-vis-*` and `sn-par-*` families on the same instance: `now-vis-sparkline`, `now-vis-navigator`, `sn-par-multipivot-extension` / `sn-multipivot` (pivot table), `sn-par-calendar-connected` (calendar report), `sn-par-scorecard-indicators` / `-metrics` / `-aggregates` (indicator scorecard), `timeline-chart`, `sn-chart-screen-reader-table`.

**≥15 distinct visualization types available to the UI Builder Data Visualization component — not 6.**

### 2.4 Corroborated by ServiceNow's own documentation

[Types of data visualization](https://www.servicenow.com/docs/r/now-intelligence/data-visualization-type-overview.html) names **single score, boxplot, bubble, dial, gauge, geomap, heatmap, horizontal and vertical bar, pie and donut, pareto bar, pivot table, time series, calendar report, list, indicator scorecard** — and assigns them all to the **Visualization Designer**, the modern Platform Analytics authoring surface that the UI Builder Data Visualization component consumes. Time series itself carries sub-types (line, area, spline, step, column, scatter).

### 2.5 Classic reporting, for completeness

`sys_choice` on `sys_report.type` returns **35 rows = 29 real chart types + 6 group separators**:

> angular_gauge (Speedometer), area, availability, bar, box, bubble, calendar, control, donut, funnel, heatmap, hist (Histogram), horizontal_bar, line, line_bar (Column), list, map, pareto, pie, pivot, pivot_v2 (Multilevel Pivot), pyramid, semi_donut, single_score, solid_gauge (Dial), spline, step_line, tbox (Trendbox), trend

So the "17 named types" figure in `02` §1 is also an undercount, for a different surface.

### 2.6 What survives, and how the argument has to be restated

The claim **"OOB can't hit the client's visual bar"** is still defensible. What is *not* defensible is the reason previously given for it. Rewrite the argument from a **count** to a **kind**:

- ✅ Still true: no sankey, treemap, sunburst, chord, network/force-directed, radar/spider, waterfall, bullet, candlestick/OHLC, parallel-coordinates, scatter-matrix, sunburst, small-multiples, or combo/dual-axis in any native surface.
- ✅ Still true: the visual treatment of each native type is fixed — theming reskins colour/typography (and `02` §2.3's RGB-not-hex friction is real), it does not let you compose a new chart grammar, custom animation, or bespoke annotation layer.
- ✅ Still true: no free-form report canvas (VividCharts' "Slate" concept); UI Builder is grid/container-only.
- ❌ **Stop saying** "OOB gives you six chart types." A client's own admin will open the Visualization Designer and disprove it in ten seconds, and every other claim in the deck loses credibility with it.

### 2.7 The fragmentation argument (`02` §1) needs rebuilding too

The "three surfaces / 5, 6, 17 / bridge via Saved Data Visualization" framing does not hold: the 6-vs-17 split was an artifact of §2.2 above, and the UI Builder component and Visualization Designer render the *same* type set.

There **is** a real seam, but it is a different one — **Classic Reporting (`sys_report`, 29 types) vs. Platform Analytics / Visualization Designer** — and the instance shows ServiceNow actively closing it: `com.glide.par.coreui.migration_banner.enabled=true`, `com.glide.par.coreui_single_migration.enabled=true`, `com.glide.par.bulk_migration.invoked`, and tables `par_coreui_migration_bridge_component` / `_widget` / `_dashboard` / `_sysauto`, plus `glide.par.coreui.migration.unmigratable_components` (a list of components that *can't* migrate). Also live: `com.glide.par.unified_analytics.enabled = true`.

Use that instead if the fragmentation point is worth making at all — but note it is a **narrowing** gap, not a widening one, and betting a pitch on it is betting against ServiceNow's own roadmap.

---

## 3. The ACL finding — CONFIRMED, and now demonstrable

This is the one claim that survived the attack and came out **stronger**. It should be the centre of the product.

### 3.1 Hands-on proof of the leak

Background script on `dev390988`, impersonating `abel.tuter` (an active user with **zero roles**):

```javascript
new GlideImpersonate().impersonate(abelSysId);       // roles = []

var ga = new GlideAggregate('incident');
ga.addAggregate('COUNT'); ga.query(); ga.next();
ga.getAggregate('COUNT');                            // -> "67"
ga.canRead();                                        // -> false

var grs = new GlideRecordSecure('incident');
grs.query(); var n = 0; while (grs.next()) n++;      // -> 0

var gr = new GlideRecord('incident');
gr.query(); var m = 0; while (gr.next()) m++;        // -> 67
```

**A user entitled to see zero incidents gets a KPI tile reading 67.** Not inferred from a community anecdote — reproduced on a current-release instance in one script. This is a demo asset: it is the entire product pitch in five lines of code, and it runs on the client's own instance against their own data.

### 3.2 The stronger version of the API argument

`typeof GlideAggregateSecure` → `undefined`. Confirmed.

But the sharper finding is about **GlideQuery**, and it corrects the compass dossier (A5) which states flatly that "GlideQuery also does not enforce ACLs by default." `GlideQuery.prototype.withAcls` **does** exist and **does** enforce ACLs. What it will not do is aggregate:

```javascript
new GlideQuery('incident').aggregate('count').select().toArray(1);
// -> [{"count":67}]

new GlideQuery('incident').withAcls().aggregate('count').select().toArray(1);
// -> throws: "Cannot use aggregate queries with withAcls()"
//    at GlideQueryEvaluator [sys_script_include:d52b3c8a08013300fa9b4300d8d67a76]:352
```

That is materially better evidence than "there's no GlideAggregateSecure." ServiceNow's own ACL-aware query API **explicitly refuses to run aggregates** — a deliberate, platform-enforced block with an error message you can put on a slide. Lead with this.

### 3.3 The honest caveat that must ship with the claim

`GlideAggregate.canRead()` **exists** and returns a correct table-level answer (`false` for our role-less user), and ServiceNow's own OOB code uses it — the shipped `SOW - Announcements Aggregate` data broker contains literally `if (!aggGr.canRead()) continue;`.

So the accurate statement is:

> **The platform provides a table-level read check on aggregates (`canRead()`), which developers must remember to call. It provides nothing at all for row-level ACLs, and its ACL-aware query API refuses to aggregate. Any aggregate narrowed by a row-level or query-based ACL will silently over-count.**

Do **not** say "GlideAggregate has no ACL awareness at all" — it is checkable and wrong, and it hands a knowledgeable client an easy rebuttal to the one claim we most need them to accept.

### 3.4 Reinforcement from the certification path

`03` §3.2's finding that "GlideRecord without ACL enforcement" is a named Store-certification rejection criterion is untouched by this pass and now sits on much firmer ground: **the correctness layer is simultaneously the differentiator, the demo, and the certification gate.** Layer 1 is not optional under any go-to-market path.

---

## 4. Export — the gap that was already closed

`02` §2.4 states: *"There is no native PPT export for UI Builder dashboards or the Data Visualization component. The only OOB path is exporting a single visualization."* Layer 5 and Phase 5 are built on it. **It is false on this instance.**

Live `sys_choice` evidence:

| Table | Field | Values |
|---|---|---|
| `par_export_dashboard` | `file_type` | **ppt (PPT)**, pdf (PDF) |
| `par_export_dashboard` | `page_size` / `orientation` | a3, a4, letter, legal / portrait, landscape |
| `par_export_visualization` | `file_type` | pdf, png, jpeg, csv, xls, xlsx, Embedded PNG, Embedded LIST |
| `par_export_job` | `status` | queued, processing, completed, failed |

Live `sys_properties`:

```
glide.par.export.enabled                       = true
glide.par.export.ppt.max_visualizations_allowed = 150
glide.par.export.use_uxf_renderer              = true
glide.par.export.use_multivis_api              = true
glide.par.export.use.sk8s                      = true
glide.par.export.host / .snowK8s.host          = (dedicated render service)
glide.par.export.allowed_roles                 = (empty — no role gate configured)
com.snc.pdf.exports.enabled                    = true
```

Live supporting artifacts: tables `par_export`, `par_export_job`, `par_export_dashboard`, `par_export_visualization`, `snpar_sched_export_v_scheduled_export_visualization`; components `sn-par-scheduled-export`, `sn-par-export-email-composer`. Official docs carry a page whose slug is literally `export-pae-dashboard-ppt.html` plus *"Schedule the export of dashboards and data visualizations."*

**Native, asynchronous, job-queued, schedulable, emailable PPT and PDF dashboard export, rendered server-side by a dedicated service, capped at 150 visualizations per deck.** The community threads cited in `02` §2.4 saying otherwise pre-date this.

**Consequence:** Layer 5 / Phase 5 drops from "closing a real open gap" to "reaching parity with something already in the box." Wall-signage rotation may still be a genuine gap (not verified either way this pass) — but do not build a phase, or a sentence of the pitch, on native PPT export being missing.

---

## 5. Autonomous insight — the moat pillar that shrank

`00` §3 Ceiling 2 ("it waits to be asked") and `02` §2.5 ("AI-driven KPI discovery... does not exist on any native surface today") are both materially overstated.

**Active on dev390988** (`v_plugin`): Performance Analytics AI, **Performance Analytics – KPI Signals**, **Performance Analytics – Spotlight**, Now Experience Analytics 2.0.0, Self-Service Analytics Core 29.0.2.

**Live tables:** `par_computed_insight`, `par_recommendation`, `par_recommendation_user_action`, `par_custom_insight_content`, `par_insight_user_action`, `par_indicator_model`, `par_automated_kpi_promin_project`.

**Live components:** `sn-par-insights-panel`, `sn-par-forecast-config`, `sn-kpi-signals`, `sn-kpi-signals-config`, `sn-nlq-analytics`, `sn-analytics-kpi`.

**Live property:** `com.glide.par.dashboards.additional.plugins = com.glide.cs.genai, sn_pa_dash_ui_conv, sn_pa_aia_insights, sn_pa_aia` — an "AIA insights" extension surface wired into PA dashboards.

Per ServiceNow, [KPI Signals](https://www.servicenow.com/docs/bundle/yokohama-now-intelligence/page/use/par-for-workspace/concept/process-behavior-charts-for-kpis.html) *"acts like a mini agent, continuously analyzing your time series data to automatically highlight anomalies — sudden spikes, dips, or trends that deviate from historical norms"*, and **Spotlight** ML-ranks *"which factors most influence a KPI."* Native **forecasting** exists too (`sn-par-forecast-config`) and is not mentioned anywhere in this repo's research.

**None of that is prompt-driven.** "Native AI waits to be asked" is simply not true of Performance Analytics.

### The differentiator, restated honestly and narrowly

> Performance Analytics autonomously analyses **indicators a human has already defined** — it detects anomalies in them, forecasts them, and ranks their drivers. It does not decide **which metrics should exist** in the first place. Our pillar is *candidate metric definition from table/process content*, sitting **upstream** of PA's indicator configuration — not "autonomous analytics," which ServiceNow ships and has shipped for several releases.

That is a real and defensible gap, and reusing the Use Case 1 content graph for it is still the right mechanism. But it is a much smaller claim than the one currently written down, and the current wording will not survive contact with a client who runs PA.

---

## 6. Data resources — the aggregate gap is real but narrower

`02` §2.2: *"There is no GlideAggregate Query Data Resource in UI Builder at all. The only documented path to an aggregate is a Transform Data Resource."*

Live counter-evidence: `sys_ux_data_broker` holds **1,454** brokers, including `Aggregation Query`, `Get aggregate counts`, `Get task aggregation query`, `Transform base aggregate encoded query`, `SOW - Announcements Aggregate`, `Data Visualization API for table data source`, `Data Visualization API for indicator data source`, `Data Visualization API for multiple data visualizations`, `Single Score Visualization`, `TrendBy Visualization`.

Broker **types** are also richer than the four listed in `02` §1. From `sys_db_object`:
`sys_ux_data_broker_simple`, `_transform` (server script), `_rest`, `_rest_external`, `_graphql`, `_composite`, `_proxy`, `_scriptlet`.

**Corrected claim — still supports Layer 1, but state it this way:**

> Aggregate data brokers exist, but they are **app-specific, hand-written, and individually responsible for their own ACL handling**. There is no *generic, reusable, ACL-safe* aggregate data-resource type a builder can drag onto a page. ServiceNow's own OOB aggregate brokers demonstrate the pattern and its ceiling: the shipped `SOW - Announcements Aggregate` guards with `canRead()` — a table-level check only — and nothing in the platform offers a row-level-correct alternative.

That is a sharper and more credible version of the same point, and it comes with ServiceNow's own source code as the citation.

Related: `sn-par-filter-cascading-config`, `par_dashboard_filter`, `par_component_filter`, and `par_component_filter_permission` all exist, so native **cascading/interactive dashboard filters** are a real configured feature. `02` §2.1's "cross-filtering works best when widgets share a compatible data source" limitation is sourced from a community article, not the product — **re-verify it hands-on before using it as a gap.**

---

## 7. Now Assist — nothing about it was verified on this instance

`00` §8 lists "Now Assist Core v29.3.10, active, current build" among the live confirmations, and §3 presents Ceiling 1 as live-backed. The analytics skills are **not present**:

- No `sn_query_gen_table_config` table (nor any table matching `query_gen`) — this is the Semantic Table registration table that Data Visualization Generation requires.
- No `sn_pa_aia` / `sn_pa_aia_insights` plugin records in `v_plugin`, despite being named in `com.glide.par.dashboards.additional.plugins`.
- `Glide Conversation Generative AI` and `Flow Designer – Generative AI Extensions` both **inactive**.
- Now Assist Core 29.3.10 is active, but the components present are record/search-oriented (`@devsnc/sn-record-nowassist`, `sn-search-genius-card-assist`), not analytics.

**Nothing about Now Assist's chart-generation behaviour was, or could be, verified on `dev390988`.**

The 5-chart-type cap itself **survives** — corroborated independently this pass against ServiceNow's own [Data Visualization generation prompting guide](https://www.servicenow.com/community/now-assist-for-creator-articles/data-visualization-generation-quick-start-and-prompting-guide/ta-p/3037710) (*"Currently Data Visualization generation supports: single score, line, vertical bar, pie chart and list"*). But it is **Verified-Documentation only**. Remove every implication that it is hands-on confirmed.

---

## 8. Smaller corrections

| Item | Prior | Corrected |
|---|---|---|
| Export/view limit properties (`03` §2.5, §2.4) | "reported defaults" 50,000 / 500,000 cells / 5,000 PDF rows / 10,000 view records | **None of `glide.ui.export.limit`, `glide.excel.max_cells`, `glide.pdf.max_rows`, `glide.db.max_view_records` exists as a property record on this Australia instance.** They may be code-level defaults with no record, but the numbers remain unconfirmed. Real live values that *do* exist: `glide.par.export.ppt.max_visualizations_allowed=150`, `glide.ui.report.list.published.max_rows=1000`, `com.snc.pa.scorecard.breakdown.chart.max_rows=10`, `glide.export.query.enforce_field_acl=true` |
| "No third-party charting app — clean instance" (`01` §6) | stated as confirmed | Method was weak (`sys_app` with non-empty `vendor`; `sys_store_app` returned 403). Conclusion is *probably* right for a PDI but should read "no evidence found, `sys_store_app` unreadable" — not "confirmed clean" |
| Accessibility (`02` §3.1) | "canvas/SVG charts get no ARIA for free — needs a custom accessible-table workstream" | **Unchanged and correct, now with live support**: `sn-chart-screen-reader-table` (`@devsnc/sn-chart-screen-reader-table`) exists as an OOB component, confirming both that ServiceNow considers this necessary and that the pattern to copy is real |
| Classic report types (`02` §1) | "up to 17 named types" | 29 real types in `sys_choice` on `sys_report.type` (35 rows incl. 6 separators) |
| UI Builder data resource types (`02` §1) | "Client State, GraphQL, REST, Transform" | plus Simple, Composite, Proxied, Scriptlet, External REST |

---

## 9. What this does to the architecture

### 9.1 Re-ranked differentiators

| Was | Now | Why |
|---|---|---|
| 1. Autonomous KPI discovery | **1. Row-level ACL-correct aggregation** | The only claim that got *stronger* under attack. Hands-on reproducible, backed by a platform-enforced `withAcls()` block, and simultaneously a Store-certification gate |
| 2. Data-shape-adaptive chart specs | **2. Data-shape-adaptive chart specs** | Unchanged — still unproven anywhere, still the biggest technical risk |
| 3. Provable ACL correctness | **3. Metric *candidacy* discovery** | Demoted and renamed. PA already does autonomous anomaly detection, driver ranking and forecasting on defined indicators; only the "which metrics should exist" step upstream is open |
| — | **4. Chart grammars OOB doesn't have** | Promoted from a count argument to a kind argument: sankey/treemap/sunburst/network/radar/waterfall/parallel-coordinates + free-form canvas |

### 9.2 Layer changes to `02` §5

- **Layer 1 (ACL-safe aggregation) — promote to the headline.** It is the product's spine, not one of five layers. The reconciliation job and the "ACL-verified" badge move to Phase 1, demoed alongside the first beautiful dashboard, not after it. Add the §3.1 script as a standing regression test *and* as the client-facing demo.
- **Layer 2 (Semantic/KPI) — rescope.** Target metric *candidacy* from content, and explicitly position it as feeding PA indicators rather than replacing PA's analysis. Do not claim autonomous analytics.
- **Layer 3 (adaptive chart-spec) — unchanged.** Still the highest-risk, highest-novelty layer. All the caveats already written (cache-key synthesis, drift thresholds, deterministic fallback rung 3, data residency) stand.
- **Layer 4 (rendering) — unchanged in mechanism, changed in justification.** The reason for custom ECharts components is no longer "OOB has 6 chart types"; it is bespoke grammars + composable visual treatment + free-form canvas. Accessibility, i18n/RTL, Record-Watcher refresh and the Shadow-DOM load test all stand.
- **Layer 5 (export/governance) — split.** Export drops out as a differentiator (native PPT/PDF/scheduled ships). The **governance half stays and gets bigger**: the ACL-verified badge and the OOB-deviation log are now Layer 1's public face.

### 9.3 Roadmap changes to `02` §7

- **Phase 1** — visual bar **+ the ACL demo together.** The `GlideAggregate 67 / GlideRecordSecure 0` script is a stronger opener than any chart. Benchmark the dashboard against the **Visualization Designer** (all ~16 types), not against a strawman 6-type palette.
- **Phase 2** — unchanged in substance (Layer 1 hardening), but it is now Phase 1's other half rather than a follow-on.
- **Phase 3** — unchanged. Highest risk.
- **Phase 4** — accessibility/mobile, unchanged.
- **Phase 5** — **cut or radically rescope.** Native export exists. Only pursue if wall-signage rotation is verified as a genuine gap and the client actually wants it.
- **Phase 0** — largely dischargeable now: see §1 for how to get back in. Still open: hands-on drilldown reliability, cross-filter behaviour with unrelated tables, whether the OOB DV component inherits `sn-chart-screen-reader-table` when embedded.

### 9.4 Positioning sentences to retire

- ❌ *"OOB gives you six chart types."* → ✅ *"OOB gives you around sixteen fixed types with no composable visual treatment and no exotic grammars."*
- ❌ *"There's no native PPT export."* → delete.
- ❌ *"Native AI only responds to prompts; nothing surfaces insight autonomously."* → ✅ *"Native AI autonomously analyses metrics you've already defined. It doesn't decide which metrics should exist."*
- ❌ *"GlideAggregate has no ACL awareness."* → ✅ *"GlideAggregate offers a table-level check you have to remember to call, nothing for row-level ACLs, and ServiceNow's own ACL-aware query API refuses to aggregate at all."*
- ✅ **Keep and lead with:** *"On your instance, a user entitled to see zero incidents sees a KPI tile reading 67. Here's the five-line script. Let's run it on yours."*

---

## 9A. Second-instance corroboration — `eypocinst` (EY POC, real customer environment)

Run by the engagement lead using [`05-live-verification-playbook.md`](05-live-verification-playbook.md) §6.1 and §4.3, after this document was written. **Both results are independent confirmations on a real customer instance, not a PDI.**

### 9A.1 The ACL block — reproduced identically ✅

```
GlideAggregateSecure:  undefined
GlideRecordSecure:     function
GlideQuery.withAcls:   function
withAcls aggregate THREW: Cannot use aggregate queries with withAcls()
  at GlideQueryEvaluator [sys_script_include:d52b3c8a08013300fa9b4300d8d67a76]:348 (executeSelectQuery)
  at GlideQueryEvaluator [...]:293 (createQuerySession)
  at Stream [sys_script_include:9f50ba7773a31300bb513198caf6a791]:321 (toArray)
```

Same script include `sys_id` as `dev390988`; line numbers differ (348/293/334 vs 352/297/338), consistent with a different patch level of the same code path.

**Verdict: the lead differentiator survives on two independent instances, one of them a real enterprise environment.** This is no longer a PDI curiosity — it is platform behaviour. `§3` is upgraded from *Verified-HandsOn (one instance)* to **Verified-HandsOn (two instances, incl. customer)**.

### 9A.2 Now Assist chart cap — HANDS-ON VERIFIED for the first time ✅

Prompt: **"Show open incidents by priority as a heatmap"** in the Now Assist panel.

Now Assist returned, verbatim and user-visibly:

> **"Heatmap is currently not supported. Alternative chart type is selected instead."**

…then rendered a plain **vertical bar chart** (priority on X, count on Y; `5 - Planning` ≈ 11,000, `1 - Critical` ≈ 800 — real EY data volumes).

**This closes the longest-standing evidence gap in the engagement.** The 5-chart-type cap (`00` §3 Ceiling 1) had been *Verified-Documentation only* — sourced from a ServiceNow community prompting guide — and §7 above established it could not be tested on `dev390988` because the skill was not installed there. It is now **Verified-HandsOn on a customer instance**, with a product-generated refusal string as the artifact.

**Why the refusal string is better evidence than a silent substitution:** it is ServiceNow's own product, in the client's own environment, stating its own limitation in plain language. It needs no interpretation and no citation.

**One caveat to close before quoting it as absolute.** A heatmap requires two dimensions; "open incidents by priority" is one-dimensional, so a sceptic can argue the refusal was about data fit rather than capability. The wording *"currently not supported"* is a capability statement, not a data-fit one — but to remove the argument entirely, re-run with a genuinely two-dimensional prompt:

> *"Show open incidents by priority and assignment group as a heatmap."*

If it still refuses, the cap is proven beyond rebuttal. Until then, present the finding as strong-but-with-one-open-check.

### 9A.3 Incidental finding — the native visual bar, captured

The rendered chart is worth keeping as a *before* image independent of the cap finding: default cyan/orange palette, no data labels, no styling, no axis formatting, truncated category axis. **That is what native AI-generated visualization looks like on real EY data.** It is the most useful single piece of evidence for the "beautiful" requirement in `/CLAUDE.md` §1 — worth putting side by side with our Phase 1 dashboard on the same dataset.

---

## 9B. Full playbook execution on `eypocinst` — read-only API sweep

Executed 2026-07-31 against `eypocinst.service-now.com` as `ey_Kumar`. Raw output: `poc/out/ey_playbook_results.json`; narrative: `docs/client_and_instance/EY-PLAYBOOK-RESULTS-2026-07-31.md`. Read-only throughout — nothing inserted, updated, deleted or activated.

### 9B.0 The release framing — and its direction matters

```
EY  : glide-zurich-07-01-2025__patch10-hotfix3-07-01-2026
PDI : glide-australia-02-11-2026__patch3-05-25-2026
```

**Zurich precedes Australia** (Yokohama → Zurich → Australia). So EY is **one major release behind** the PDI, though on a *later patch date* (2026-07-01 vs 2026-06-12). Now Assist Core is `28.10.8` at EY vs `29.3.10` on the PDI, consistent with that.

Direction matters for how each result reads:

- **Where EY matches the PDI → the finding is stable across two consecutive major releases.** Stronger than either alone.
- **Where EY has *less* than the PDI → expect it.** That is a release lag, not a contradiction.
- **Where EY has *more* than the PDI → that would be genuinely surprising** and worth investigating. (Nothing in this sweep did.)

### 9B.1 ⭐ Native autonomous insight is running **in production**

| Table | PDI (Australia) | **EY (Zurich)** |
|---|---|---|
| `par_computed_insight` | 0 (empty) | **292** |
| `par_recommendation` | 0 (empty) | **35** |

Active plugins: `com.snc.pa.ai` (Performance Analytics AI), `com.snc.pa.kpi_signals`, `com.snc.pa.spotlight`, `com.snc.pa.spotlight.incident`, `com.snc.pa.premium`, `com.snc.pa.par_analytics_center`. Components: `sn-kpi-signals`, `sn-kpi-signals-config`, `sn-par-insights-panel`, `sn-par-forecast-config`, `sn-manager-forecast-timeseries`.

**This is the decisive evidence for §5's correction.** On the PDI these tables shipped empty, so "the capability exists" was an inference from schema. At EY there are **292 computed insights and 35 recommendations actually generated** — native autonomous analysis is not a dormant feature here, it is running against this client's data today.

> **Binding consequence for Layer 2 and for the room:** position it strictly as *upstream metric candidacy*. **The phrase "no native autonomous analytics" must never be said in front of this client** — they are running it.

*Caveat:* `com.glide.par.dashboards.additional.plugins` returned **0 rows** at EY (the PDI had four entries). Property absence ≠ capability absence; the plugin inventory above is the better evidence.

### 9B.2 ⭐ The DV Generation skill **is installed** — which validates §9A.2

`sys_db_object LIKE query_gen` → **12 tables** at EY, including **`sn_query_gen_table_config`** (Semantic Table Configuration) plus `_column_config`, `_entity`, `_entity_metadata`, `_dimension`, `_segment`, `_segment_table_config`, `_utterance_bank`, `_log`, `_event`/`_event_type`/`_event_topic`. On the PDI this returned **nothing**.

**Why this matters retroactively:** §9A.2's heatmap refusal was produced by a **properly installed, configured skill** — not a half-provisioned one. That removes the last doubt about the result's validity.

**Precision to carry:** the refusal was observed on **Zurich**. The dossier's claim is "5 types, unchanged Zurich→Australia." The **Zurich end is now Verified-HandsOn**; the Australia end remains Verified-Documentation. Say it that way.

### 9B.3 Chart palette — identical across two release trains

`source_script_nameLIKEnow-visualization-extensions` → **exactly 10, exactly the same names** as the PDI: `__bar__ __bubble__ __dial__ __gauge__ __geomap__ __heatmap__ __pareto__ __pie__ __singleScore__ __timeseries__`.

**The "6 primitives" error is now dead on two release trains.** Classic reporting: **35 rows = 29 real types + 6 separators**, identical structure, none inactive. Total components: **2,514** at EY vs 1,831 on the PDI (larger estate, more plugins).

> ⚠️ **A correction to how we phrase the visual gap — this one would have embarrassed us.**
> `box` (boxplot), `funnel`, `pyramid`, `hist` (histogram), `trend` and `tbox` (trend box) **exist in classic reporting.** `02` §2.5 lists "funnel with stage conversion" and box-and-whisker among things no native surface reaches. **That is wrong for classic.**
>
> Scope the claim explicitly: *"absent from the modern Platform Analytics / UI Builder surface"* — because a client admin can open classic reporting and produce a boxplot, a funnel and a histogram. The genuinely-absent-everywhere list is narrower: **sankey, treemap, sunburst, chord, network/force-directed, radar/spider, waterfall, bullet, candlestick/OHLC, parallel coordinates, scatter matrix, small multiples, combo/dual-axis.**
>
> Also note a real discrepancy worth resolving in the picker: ServiceNow's docs list **boxplot** as a *Visualization Designer* type, but it is **not** among the 10 visualization extensions. Either the docs overstate the modern surface or the extension list is not the whole story — §7.3 below settles it.

**And the fragmentation argument is partly rehabilitated — in its corrected form.** At EY the classic/PAR seam is **open**, not closing:
```
com.glide.par.unified_analytics.enabled                    = false   (PDI: true)
glide.par.coreui.migration.new_coreui_artifacts_created    = false
com.glide.par.coreui.migration.scope.repaired              = false
glide.par.coreui.migration.unmigratable_components         = 2 components
```
Two components are recorded as **unmigratable**. So "the native analytics estate is split between classic and PAR" is live and demonstrable *at this client* — but state it as **classic-vs-PAR**, never as the falsified "5 / 6 / 17" framing from `02` §1.

### 9B.4 Export — confirmed native, enabled, and not role-gated

`par_export_dashboard.file_type` → **ppt, pdf**. `glide.par.export.enabled=true`, `ppt.max_visualizations_allowed=150`, `use_uxf_renderer=true`, `com.snc.pdf.exports.enabled=true`, and **`glide.par.export.allowed_roles = ""` (empty — not restricted)**.

Confirmed on both instances and both release trains. **Layer 5's export half stays cut.** No property or component surfaced for kiosk/TV/rotate mode — consistent with signage being the one surviving piece.

### 9B.5 ❌ Code Assist — my inference was wrong

```
sys_db_object   LIKE code_assist / sn_codeassist  -> 0 rows
sys_ux_lib_component LIKE code-assist / build-agent -> 0 rows
v_plugin        LIKE Code Assist / Build          -> 13 rows, none of them Code Assist
```
The 13 are unrelated "builder"-named artifacts (Service Catalog Builder, PAR Component Builder, Now Predicate Builder, UI Builder panes, etc.).

**I asserted that `sk8s_codeassist_t2c_refresh_token` in the browser session meant Code Assist was provisioned on this instance. That inference is not supported.** The cookie is a token for a ServiceNow-side token-exchange service and says nothing about instance provisioning.

Recorded as **Not found**, deliberately *not* "confirmed absent" — the UI half (Studio / script-editor AI panel) has not been run, and absence of tables is weaker evidence than a UI that refuses. **Interim: the delivery-model advantage is intact**, and T3's threat is unmeasured rather than dismissed.

### 9B.6 T5 demo targets identified — the leak demo is ready to run

Row-level read ACLs exist in quantity (50 returned at the query limit; more exist). Best targets, in order:

| Table | ACL kind | Why |
|---|---|---|
| **`incident`** | **script** | 13,980 rows / 13,930 active; universally understood; script ACLs are row-level by nature |
| `sn_hr_core_profile` | condition `userDYNAMIC…` | Per-user row filter — the cleanest possible demonstration |
| `sn_jny_journey` | condition on `manager.user` / `mentors` DYNAMIC | Row-level via relationship |

Admin baselines captured: `incident` = **13,980** total, **13,930** active. Only the UI-Impersonate half remains.

### 9B.7 Brokers, and the limits question

`sys_ux_data_broker` → **6,156** at EY (PDI: 1,454). Broker types: the expected **8** (simple, transform, rest, rest_external, graphql, composite, proxy, scriptlet). 34 aggregate/visualisation brokers, all named and purpose-built — consistent with the corrected Layer 1 framing (no generic, reusable, ACL-safe aggregate resource). The definitive check is the UI Builder resource-type picker.

`glide.ui.export.limit`, `glide.excel.max_cells`, `glide.pdf.max_rows`, `glide.db.max_view_records` → **0 rows again.** Unconfirmed on **two instances across two release trains**. Treat `03` §2.5's 50k/500k/5k/10k as platform defaults not materialised as records; never quote them as measured.

### 9B.8 ⚠️ A trap that could have unwound a correct finding

**`sys_user.roles` for `ey_Kumar` is an empty string, but the account holds 200 roles** via `sys_user_has_role`. That field is a denormalised cache, not the role set.

**This does not affect §3.1's leak proof.** That test read roles via `gs.getUser().getRoles()` *inside* the impersonated session — the live role list, not the cached field — and it returned `[]` for `abel.tuter`. The 67-vs-0 result stands. Flagging it because anyone re-reading §3.1 alongside this trap note might wrongly conclude the PDI test was contaminated.

---

## 9C. Browser-half results on `eypocinst` — T1, T2 and T4 all closed, 2026-08-01

Screenshots captured in the Now Assist panel and the Platform Analytics **Visualization Designer** (`/now/platform-analytics-workspace/visualization-designer/`). **Two differentiator questions are now settled, and the chart-count baseline moves again.**

### 9C.1 ⭐⭐ T2 — Now Assist CANNOT do distributions. Differentiator #2 confirmed, with proof.

Prompt (no chart type stated): **"Show me incident resolution time distribution"**

Now Assist replied *"I'll create a data visualization showing the dis…"*, then:

> **"Distribution is currently not supported. Alternative chart type is selected instead."**

…and rendered a **bar chart whose X axis is the raw resolution-time values**:

```
(empty)  43  120  148  169  330  454  719  895  1,202  2,219  2,286
4,984  74,834  85,368  86,495  102,197  172,767  172,800  345,805  Other
```

**This is the textbook failure mode our entire Layer 3 thesis predicts, produced unprompted by the product itself.** Every specific defect is visible in one image:

| What it did | What shape-adaptive generation would do |
|---|---|
| Treated a **continuous numeric variable as categorical** — one bar per distinct value | Bin it into a histogram, or render a boxplot/density |
| **No binning at all**, then dumped the tail into `Other` | Choose bin width from the distribution (Freedman–Diaconis / Sturges) |
| **`(empty)` is the dominant bar** (~10,000+, dwarfing everything else) — nulls neither excluded nor flagged | Detect and surface the null rate; exclude or annotate |
| Linear axis spanning **43 → 345,805** — extreme skew rendered unreadable | Log axis, or outlier handling |
| Raw seconds as labels (345,805 s ≈ 4 days) | Duration formatting |
| **Explicitly declined the intent**: "Distribution is currently not supported" | — |

**Verdict against the playbook's own interpretation rule** (*"Always picks from single-score/line/bar/pie/list with no commentary → template selection confirmed, differentiator #2 holds"*): **✅ CONFIRMED, and more strongly than the rule anticipated.** Now Assist did not merely fail to adapt — it *recognised the distributional intent, announced it could not serve it, and fell back to a template that misrepresents the data.*

> **This is now the single best demo artifact in the engagement**, alongside the ACL script. It is ServiceNow's own AI, on the client's own data, producing a chart that is actively misleading — and saying so in its own words first. It needs no narration.
>
> **Bonus finding for the client, unrelated to our pitch:** the `(empty)` bar means a large share of EY's incidents have no resolution time recorded. Worth raising on its own merits.

### 9C.2 ⭐ T1 — closed, by a better route than the 2-D retest

The heatmap prompt was re-run and refused identically: *"Heatmap is currently not supported. Alternative chart type is selected instead."* → vertical bar chart (3-Moderate / 4-Low / 2-High).

**But T4 settles the caveat far more decisively than a two-dimensional prompt ever could.** The open worry was that Now Assist refused on *data fit* (a heatmap needs two dimensions) rather than *capability*. The Visualization Designer picker (§9C.3) shows:

> **Heatmap is a first-class native chart type in Platform Analytics** — it sits in the "Multidimensional charts" group alongside Pivot Table, Bubble and Quadrant Bubble.

So the platform ships heatmap; **Now Assist simply cannot emit it.** Combined with §9C.1's "Distribution is currently not supported" and the same refusal string appearing for two unrelated requests, the conclusion is unambiguous:

**The cap is a limitation of the Now Assist DV Generation skill, not of the platform's chart palette and not of the data.** The 2-D retest is no longer needed. `00` §3 Ceiling 1 is **fully Verified-HandsOn** (at the Zurich end).

### 9C.3 ⭐ T4 — the real palette is **24 types**, read directly from the picker

Visualization Designer → *Create new visualization* → chart-type picker, verbatim:

| Group | Types | n |
|---|---|---|
| **Time series** | Area, Scatter, Column, Spline, Line, Step | 6 |
| **Scores** | Single score, Gauge, Dial | 3 |
| **Bars** | Vertical bar, Horizontal bar, Pareto | 3 |
| **Pie and donuts** | Semi donut, Pie, Donut | 3 |
| **Multidimensional charts** | Heatmap, Pivot Table, Bubble, **Quadrant Bubble** | 4 |
| **Other** | **Boxplot**, Calendar Report, Geomap, Indicator scorecard, List | 5 |
| | **Total** | **24** |

**The count has now moved three times: 6 (falsified artifact) → ~16 (docs) → 24 (the actual picker).** The playbook was right that the picker outranks every other source. Two specific corrections:

- **Boxplot IS in the modern surface.** §9B.3 flagged a docs-vs-extensions discrepancy and provisionally scoped boxplot to classic only. Wrong — it is right there under "Other." Any wording implying the modern surface lacks a boxplot must go.
- **Quadrant Bubble** appears in no documentation we sourced and was in none of our counts. The native palette is richer than any of our research suggested.

**The corrected "genuinely absent from the modern Visualization Designer" list**, and this is now the whole of the type-based visual argument:

> sankey · treemap · sunburst · chord · network / force-directed graph · radar / spider · waterfall · bullet · candlestick / OHLC · parallel coordinates · scatter-plot **matrix** (plain scatter exists) · small multiples · combo / dual-axis · **histogram / binned distribution** · funnel¹ · pyramid¹
>
> ¹ *present in **classic** reporting only — scope accordingly, per §9B.3.*

**Histogram is the one to lead with**, because §9C.1 proves the consequence rather than asserting it: there is no binned-distribution type in the modern surface, and when a user asks for a distribution the platform's own AI produces a broken chart.

### 9C.4 What this does to the visual differentiator

**The type-count argument is now weak and should be retired as a headline.** 24 native types, including heatmap, boxplot, pareto, geomap, pivot, scatter and quadrant bubble, is a respectable palette. Anyone opening with "the native palette is limited" will lose the room.

The three visual arguments that survive, in descending strength:

1. **Intelligence, not palette.** The platform *has* heatmap and boxplot; its AI cannot reach them, and given a distribution it renders one bar per raw value with `(empty)` dominating. **The gap is in what drives the chart, not in the chart list.** This is where §9C.1 belongs, and it is the strongest visual argument we have.
2. **Fixed treatment / no composability.** 24 types, each with a fixed visual treatment. No new grammars, no bespoke annotation layers, no custom animation, no free-form report canvas. Still true, still verifiable in the config panel.
3. **The genuinely-absent grammars** (§9C.3 list). Real, but a narrower and less impressive list than we have been carrying — and it must be scoped to the modern surface.

> **Consequence for `/CLAUDE.md` §2's priority rule:** the "beautiful" requirement is *not* going to be won on chart variety against a 24-type palette. It has to be won on **visual craft** — typography, spacing, colour discipline, annotation, layout, motion, and composition across a page — plus the intelligence gap above. Phase 1's acceptance test should be a side-by-side against a *competently built* Visualization Designer dashboard, not a strawman.

---

## 10. Open items this pass could not close

> **To close these, use [`05-live-verification-playbook.md`](05-live-verification-playbook.md)** — every
> item below is reduced there to a runnable check with its expected result and falsification condition.
> It also adds a surface this repo has never examined: **Now Assist Code Assist / build agent** (§7 there),
> which threatens the *delivery-model* advantage rather than the product differentiators.

- **Basic Auth on `dev390988`** — untested (no password); prior "rejected by design" conclusion is unverified, not settled.
- **Wall-signage / display rotation** — is it genuinely absent natively? Not checked. This is now the only surviving part of the old Layer 5 thesis.
- **Cross-filter across unrelated tables** — the "tables that relate cleanly" limitation is community-sourced; `sn-par-filter-cascading-config` suggests the native story is better than documented. Verify hands-on.
- **Drilldown reliability** — the community reports in `02` §2.1 were not reproduced. Still plausible, still unverified by us.
- **Whether the embedded OOB DV component inherits the screen-reader-table fallback** — unresolved, matters for §3.1's accessibility workstream sizing.
- **VividCharts G2 rating** — unchanged from `03` §3.3: do not quote either number without a manual live check.
- **VividCharts' own ACL handling** — unchanged: unverified, and if they already solve it, differentiator #1 narrows.
- **Now Assist DV Generation hands-on** — needs an instance with the skill actually installed. `dev390988` cannot answer any question about it.
