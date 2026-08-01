# Live Verification Playbook — run this on any instance

**Purpose:** every claim in this folder, reduced to a check you can run yourself in a few minutes, with the **expected result** and **what it means if the answer differs**. Written so a ServiceNow admin with no context on this engagement can execute it.

**Why it exists:** the first live pass (`01`) reached wrong conclusions from a badly-filtered query, and `04` had to unwind them. This playbook exists so that never happens again — every check below states its own falsification condition.

**Target for this round:** `eypocinst.service-now.com` (EY POC instance). Everything here is instance-agnostic.

---

## 0A. DELEGATABLE TASK LIST — hand these to an agent one at a time

**How to use this section:** each task below is self-contained. Copy the whole task block (including the safety header in §0) into the agent. Tasks are ordered by value. **T1–T3 are the ones that could change the product thesis; run those first.**

**Paste this preamble with every task:**

> You are verifying claims on a **real client ServiceNow instance** (`eypocinst.service-now.com`). Rules, without exception:
> 1. **Read-only.** No insert, update, delete, plugin activation, property change, or record creation of any kind. If a step appears to need write access, stop and report that instead.
> 2. **Never call `GlideImpersonate` in a background script.** It mutates the real session and can log the user out. Use the UI Impersonate feature only, and always End Impersonation afterwards.
> 3. **Do not modify, deactivate, or "fix" anything you find**, however broken it looks.
> 4. **Report raw output verbatim** — full query, full result, unedited. Do not summarise away detail, and do not fill gaps with reasoning. If a query errors or returns nothing, report exactly that.
> 5. If you cannot complete a step, say so explicitly. **An honest "could not verify" is worth more than a confident guess** — a prior pass on this project reached wrong conclusions by inferring from an incomplete query, and it took a full re-audit to unwind.

### STATUS after the 2026-07-31 API sweep on `eypocinst`

The **API half of every task is done.** Results in [`04`](04-red-team-verification.md) §9B; raw JSON in `poc/out/ey_playbook_results.json`. **Everything still open is browser-only** — a human or a browser-capable agent, in the Now Assist panel / UI Builder / Visualization Designer.

**Baseline that reframes all of it: EY is on Zurich, one major release *behind* the PDI's Australia.** Where EY matches, the finding is stable across two consecutive releases. Where EY has less, expect it.

| # | Task | Status | What's left |
|---|---|---|---|
| **T1** | Now Assist chart cap | ✅ **CLOSED** | Refusal reproduced; **T4 killed the data-fit objection** — the platform ships heatmap, Now Assist can't emit it. No 2-D retest needed |
| **T2** | Now Assist shape-adaptivity | ✅ **CLOSED — differentiator #2 CONFIRMED** | *"Distribution is currently not supported"* → one bar per raw value, `(empty)` dominant. **Best demo artifact we have.** [`04`](04-red-team-verification.md) §9C.1 |
| **T3** | Code Assist / build agent | 🟠 **Not found** (API) | ❌ My "cookie ⇒ provisioned" premise was **wrong**. Zero tables/components/plugin. UI half unrun — record as *not found*, not *confirmed absent* |
| **T4** | Chart palette | ✅ **CLOSED — 24 types** | Picker read verbatim. **Third revision (6 → ~16 → 24).** Boxplot IS modern. **Retire chart variety as a headline.** [`04`](04-red-team-verification.md) §9C.3 |
| **T5** | ACL leak demo | 🟡 Targets ready | Impersonate half only. Targets + admin baselines captured — see below |
| **T6** | Export & signage | 🟢 Mostly ✅ | PPT on, `allowed_roles` empty. Left: export a real deck; look for kiosk/TV mode |
| **T7** | Autonomous insight | ✅ **DONE — biggest finding** | 292 computed insights, 35 recommendations, **in production**. Optional: screenshot the Insights panel |
| **T8** | Aggregate brokers | 🟡 API ✅ / picker ⬜ | 6,156 brokers, 8 types. Left: does the UIB resource-type picker expose an **ACL/security option**? |
| **T9** | Baseline | ✅ **DONE** | Zurich; Now Assist Core 28.10.8; ⚠️ `sys_user.roles` is a cache — `ey_Kumar` holds **200 roles** via `sys_user_has_role` |
| **T10** | Drilldown / cross-filter / a11y / mobile | ⬜ | All browser. `sn-par-chart-drilldown-config` and `sn-par-filter-cascading-config` both exist, so native support is real; behaviour untested |

*(✅ Do not repeat: the `withAcls()` aggregate block — reproduced on EY, [`04`](04-red-team-verification.md) §9A.1. The single-dimension heatmap refusal — §9A.2.)*

**T5 is ready to run — targets and admin baselines already captured:**

| Table | ACL kind | Admin count | Note |
|---|---|---|---|
| `incident` | **script** | **13,980** (13,930 active) | Big, universally understood, row-level by nature |
| `sn_hr_core_profile` | condition `userDYNAMIC…` | — | Cleanest possible per-user row filter |
| `sn_jny_journey` | condition on `manager.user` / `mentors` | — | Row-level via relationship |

---

### Original task list (full detail below)

| # | Task | Answers |
|---|---|---|
| **T1** | Now Assist chart cap — 2-dimensional retest | Closes the last caveat on a *Verified-HandsOn* finding |
| **T2** | Now Assist shape-adaptivity probe | Whether differentiator #2 survives |
| **T3** | Code Assist / build agent scope | Whether the *delivery-model* advantage survives |
| **T4** | UI Builder + Visualization Designer chart palette | Rebuilds the visual argument on correct facts |
| **T5** | ACL leak demo on real data | Turns the lead differentiator into a client-facing demo |
| **T6** | Export & signage reality check | Confirms Layer 5 stays cut |
| **T7** | Native autonomous insight in production | Sizes how far Layer 2 must be narrowed |
| **T8** | Data resource / aggregate broker inventory | Confirms Layer 1's framing |
| **T9** | Baseline: release, roles, plugin inventory | Context for everything else |
| **T10** | Drilldown, cross-filter, accessibility, mobile | Long-standing unverified claims |

---

### T1 — Now Assist chart cap, two-dimensional retest ⭐ highest value

**Why:** We have a hands-on result — Now Assist refused *"Show open incidents by priority as a heatmap"* with **"Heatmap is currently not supported. Alternative chart type is selected instead."** But a heatmap needs two dimensions and that prompt supplied one, so a sceptic can argue it refused on data fit, not capability. One prompt closes this permanently.

**Steps.** In the **Now Assist panel**, run each prompt and screenshot the full response:
1. `Show open incidents by priority and assignment group as a heatmap`
2. `Show incident count by assignment group and month as a heatmap`
3. `Show open incidents by category as a treemap`
4. `Show incident flow from category to resolution as a sankey diagram`
5. `Show open incidents by priority as a donut chart`
6. `Show open incidents by priority as a horizontal bar chart`

**Report:** for each — exact prompt, exact message text, what chart type actually rendered.

**Interpretation:**
- 1 & 2 refused → **cap is capability-based. Finding is airtight.**
- 1 or 2 renders a heatmap → the refusal was data-fit. **Weaken the claim to "refuses when the data doesn't fit the type" and tell the engagement lead immediately.**
- 5 (donut) is interesting either way: donut is OOB but *not* on the documented 5-type list. If it works, the documented list understates the real cap.
- 6 (horizontal bar) same — the documented list says "vertical bar."

---

### T2 — Does Now Assist react to the *shape* of the data? ⭐ highest value

**Why:** Our second differentiator is *data-shape-adaptive chart specs*. It rests on Now Assist doing pure template selection and never looking at skew, cardinality, outliers or time density. **If it does adapt, differentiator #2 is gone.** Nobody has tested this.

**Steps.** Prompts that state **no chart type at all**, so the model must choose:
1. `Show me the distribution of incident resolution times`
2. `Show me how long incidents take to resolve`
3. `Show incidents by assignment group` *(likely high cardinality — does it top-N, group an "other" bucket, or render 200 unreadable bars?)*
4. `Show incident volume over the last 12 months`
5. `Show me the relationship between priority and resolution time`
6. `What's unusual about our incident data this month?`

**Report:** exact prompt → chart type chosen → **did it say anything about the data's shape** (outliers, skew, "too many categories to display", a top-N cut, a log axis, a note about distribution)?

**Interpretation:**
- Always picks from single-score/line/bar/pie/list with no commentary → ✅ template selection confirmed, **differentiator #2 holds.**
- Mentions outliers/skew, bins a histogram, applies top-N, or picks a boxplot → ⚠️ **partial adaptivity exists. Escalate — this is the single most damaging possible finding for Layer 3.**
- #6 producing a narrative insight → that's AI Data Explorer / insight summarisation, a *different* capability. Note it, don't confuse it with chart adaptivity.

---

### T3 — Code Assist / build agent: what can it actually generate? ⭐ highest value

**Why:** EY's session carries `sk8s_codeassist_t2c_refresh_token`, so **Now Assist Code Assist (text-to-code) is provisioned.** This repo has never examined it. Every differentiator we hold is about the *runtime product*; a build agent that generates custom UXF components attacks the **delivery model** — it makes it cheaper for EY's own admins to build bespoke, which erodes "why hire us" even if all three product differentiators hold. **This is an unmeasured threat, not a known one.**

**Steps.**
1. Inventory (read-only, browser address bar while logged in):
   ```
   /api/now/table/v_plugin?sysparm_query=nameLIKECode Assist^ORidLIKEcodeassist^ORnameLIKEBuild&sysparm_fields=id,name,active,version&sysparm_limit=60
   /api/now/table/sys_db_object?sysparm_query=nameLIKEcode_assist^ORnameLIKEsn_codeassist&sysparm_fields=name,label
   /api/now/table/sys_ux_lib_component?sysparm_query=sys_nameLIKEcode-assist^ORsys_nameLIKEbuild-agent&sysparm_fields=sys_name&sysparm_limit=50
   ```
2. Find the UI: ServiceNow Studio / the script editor's AI panel / Now Assist Admin → Skills → anything named Code Assist, Code Generation, Flow Generation, or a "build agent."
3. **Ask it to build things, but do not save/deploy anything it produces.** Generation-only; discard every result:
   - `Create a UI Builder page that shows incident counts by priority`
   - `Create a custom UI Builder component that renders a chart`
   - `Generate a Script Include that returns incident counts grouped by assignment group`
   - `Build me a dashboard for service desk managers`

**Report:** does it emit **UI Builder pages / custom UXF components**, or only server-side script (Business Rules, Script Includes, Flows)? Does anything in it choose chart types? Is there a multi-artifact "build an app" agent, and how close does it get to a working dashboard?

> ⚠️ **Do not deploy, save, publish or commit anything it generates.** Read the output, screenshot it, discard it.

**Interpretation:** server-side script only → delivery advantage intact. Generates custom components or whole UI Builder pages → **our build-cost advantage narrows sharply; log it as a new gap-registry entry and flag it to the engagement lead.**

---

### T4 — The real chart palette, from both authoring surfaces

**Why:** The single worst error in this project's research was concluding "OOB has 6 chart types" from a mis-filtered query. The real number is ~16. The argument has been rebuilt around chart **kind**, not count — and that rebuild needs verifying on EY.

**Steps.**
1. Queries:
   ```
   /api/now/table/sys_ux_lib_component?sysparm_query=source_script_nameLIKEnow-visualization-extensions&sysparm_fields=sys_name,source_script_name&sysparm_limit=100
   /api/now/table/sys_ux_lib_component?sysparm_query=sys_nameLIKEnow-vis&sysparm_fields=sys_name&sysparm_limit=200
   /api/now/stats/sys_ux_lib_component?sysparm_count=true
   /api/now/table/sys_choice?sysparm_query=name=sys_report^element=type&sysparm_fields=value,label,inactive&sysparm_limit=100
   ```
2. **Open the tools and list what you actually see** — this outranks any query:
   - *Analytics Center / Platform Analytics → Visualization Designer* → Create visualization → **write down every chart type in the picker, verbatim.**
   - *UI Builder* → open any page → add the **Data Visualization** component → **write down every type in its config panel, verbatim.** Note whether time series exposes sub-types (line/area/spline/step/column/scatter).
3. **Search both pickers for each of these and record present/absent:** sankey, treemap, sunburst, chord, network/force-directed, radar/spider, waterfall, bullet, candlestick, parallel coordinates, scatter matrix, small multiples, combo/dual-axis.
4. Note whether a **free-form canvas** layout exists (vs. grid/container only), and whether custom animation or a bespoke annotation layer is configurable.

**Interpretation:** any of the step-3 types present → **that one comes out of our pitch immediately.** All absent → the "gap is kind, not count" argument holds on EY.

---

### T5 — The ACL leak, demonstrated on EY's own data ⭐ this is the demo

**Why:** Our lead differentiator. The API block is already proven on EY. This turns it into something a stakeholder can *see*.

> ⚠️ **Use the UI Impersonate feature only. Never `GlideImpersonate` in a background script** — it mutates the real session and previously logged a session out entirely. Always End Impersonation when finished.

**Steps.**
1. Find tables with **row-level** ACLs (read-only query):
   ```
   /api/now/table/sys_security_acl?sysparm_query=operation=read^active=true^conditionISNOTEMPTY^ORscriptISNOTEMPTY&sysparm_fields=name,operation,condition,script&sysparm_limit=50
   ```
   Any read ACL with a **condition** or **script** is row-level — those are where aggregates over-count. Also check whether **domain separation** is active.
2. Pick a low-privilege user (`sys_user` with empty `roles`, or ESS-only).
3. **As admin**, record the true count: `/api/now/stats/<table>?sysparm_count=true`
4. **Top-right avatar → Impersonate User** → select that user.
5. As that user: open the table's **list view**, read the count in the list header (ACL-enforced). Then open any **KPI tile / single-score visualization** bound to a count on the same table.
6. **End Impersonation.**

**Report:** table name, ACL type, admin count, impersonated list count, KPI tile count. Screenshot the list and the tile.

**Interpretation:** tile count > list count → ✅ **the leak on EY's own data — this is the demo.** Equal → that table's ACLs are role-based (all-or-nothing); try one with a condition/script ACL or under domain separation.

---

### T6 — Export and signage

**Why:** Native PPT/PDF export was found on the PDI, which cut Layer 5's export half. Confirm on EY.

**Steps.**
```
/api/now/table/sys_choice?sysparm_query=nameSTARTSWITHpar_export&sysparm_fields=name,element,value,label&sysparm_limit=100
/api/now/table/sys_properties?sysparm_query=nameLIKEglide.par.export^ORname=com.snc.pdf.exports.enabled&sysparm_fields=name,value
```
Then open a Platform Analytics dashboard → kebab/hamburger menu → **actually export a deck** and open the file. Look for **Schedule export** too.
Finally: is there any native **wall-monitor / kiosk / TV / rotate-tabs** mode?

**Interpretation:** PPT works → export stays cut as a differentiator. `glide.par.export.enabled=false` → it's a *config* gap at EY, a quick win to raise, **not** a reason to build. No kiosk mode → signage is the one surviving piece of old Layer 5.

---

### T7 — Is native autonomous insight actually running here?

**Why:** PA's KPI Signals / Spotlight / forecasting forced us to narrow differentiator #1 from "autonomous KPI discovery" to "metric *candidacy*." On the PDI those tables existed but were **empty**. EY is a real instance — rows here mean it's running in production.

**Steps.**
```
/api/now/stats/par_computed_insight?sysparm_count=true
/api/now/stats/par_recommendation?sysparm_count=true
/api/now/table/v_plugin?sysparm_query=nameLIKEKPI Signals^ORnameLIKESpotlight^ORnameLIKEPerformance Analytics AI&sysparm_fields=id,name,active,version
/api/now/table/sys_properties?sysparm_query=name=com.glide.par.dashboards.additional.plugins&sysparm_fields=name,value
```
Then open a PA dashboard: is there an **Insights panel**, **KPI Signals** indicators, or **forecast bands** on a time-series chart? Screenshot anything found.

**Interpretation:** rows present + insights visible → **native autonomous analysis is live at EY.** Our Layer 2 must be positioned strictly as *upstream metric candidacy*, and the words "no native autonomous analytics" must never be said in front of this client.

---

### T8 — Data resources and aggregate brokers

**Steps.**
```
/api/now/stats/sys_ux_data_broker?sysparm_count=true
/api/now/table/sys_ux_data_broker?sysparm_query=nameLIKEaggregat^ORnameLIKEvisualiz&sysparm_fields=name&sysparm_limit=60
/api/now/table/sys_db_object?sysparm_query=nameLIKEux_data_broker&sysparm_fields=name,label
```
Then in **UI Builder → Data → Add data resource**, list every available type verbatim.

**Interpretation:** if the list contains an aggregate resource **with an ACL/security option**, Layer 1's framing needs revisiting — report immediately. Otherwise the corrected claim holds: aggregate brokers exist, but none is generic + reusable + ACL-safe.

---

### T9 — Baseline

```
/api/now/table/sys_properties?sysparm_query=nameINglide.war,glide.buildname,glide.product.description&sysparm_fields=name,value
/api/now/table/sys_user?sysparm_query=user_name=ey_Kumar&sysparm_fields=user_name,roles,sys_id
/api/now/table/v_plugin?sysparm_query=nameLIKEAssist^ORnameLIKEAnalytics^ORnameLIKEInsight&sysparm_fields=id,name,active,version&sysparm_limit=150
```
**Report the `glide.war` string verbatim.** Every other finding is release-bound; `dev390988` was `glide-australia-02-11-2026__patch3`. A different release train means differences are expected, not contradictions.

---

### T10 — The long-standing unverified claims

Lower value individually, but each has been asserted in our docs without ever being tested.

1. **Drilldown reliability** — build a 2-level drilldown on a UI Builder page, click through it. Community reports say it breaks; we have never reproduced it.
2. **Cross-filter across *unrelated* tables** — put two visualizations from unrelated tables on one dashboard, add an interactive filter. Our doc claims it's gated on "tables that relate cleanly," but native `sn-par-filter-cascading-config` suggests better. Test it.
3. **Accessibility** — embed the OOB Data Visualization component, tab to it with a keyboard, check whether a screen-reader table alternative appears (`sn-chart-screen-reader-table` exists as an OOB component). Sizes our accessibility workstream.
4. **Now Mobile** — open a UI Builder page in the Now Mobile app. We claim it throws "Unsupported screen" for *any* UIB page, OOB or custom. Confirm.
5. **Export/view limits** — `/api/now/table/sys_properties?sysparm_query=nameINglide.ui.export.limit,glide.excel.max_cells,glide.pdf.max_rows,glide.db.max_view_records&sysparm_fields=name,value` — on the PDI **none of these existed as records**, so our quoted defaults are unconfirmed.

---

## 0. Safety rules for a client instance

`dev390988` was a disposable PDI. A client instance is not. Before running anything:

| Rule | Why |
|---|---|
| **Everything in §2–§8 is read-only.** No inserts, no updates, no plugin activation. | Nothing here needs write access. If a step seems to need it, stop. |
| **Never call `GlideImpersonate` in a background script.** | It mutates the *real* session, not a sandbox. On the PDI it left the session impersonating a role-less user; `logout_impersonator.do` then dropped it to `guest` and required re-login. Use the **UI Impersonate** feature (§6) instead — it is designed for this and has a proper exit. |
| **Prefer Table API / list views over Scripts–Background where a check allows it.** | Background scripts are an audited, write-capable surface on a client system. §2–§5 need no scripting at all. |
| **The two scripts in §6–§7 are read-only** (no `insert`/`update`/`deleteRecord`). Read them before pasting. | Standard hygiene on someone else's instance. |
| **Note the release first (§1).** | Every finding is release-bound. A result from Australia says nothing about Brazil. |

---

## 1. Establish the baseline — which release, which user

**UI:** All → *System Diagnostics → Stats → Stats* — or simpler, the release name appears in *System Definition → Plugins* header.

**Table API (browser address bar, while logged in):**
```
/api/now/table/sys_properties?sysparm_query=nameINglide.war,glide.buildname,glide.product.description&sysparm_fields=name,value
```

> **Record the `glide.war` value.** `dev390988` was `glide-australia-02-11-2026__patch3-05-25-2026`. If `eypocinst` is on a different release train, **every comparison below is against a different baseline** and differences are expected, not contradictions.

**Confirm who you are** (matters for every ACL-related result):
```
/api/now/table/sys_user?sysparm_query=user_name=ey_Kumar&sysparm_fields=user_name,roles,sys_id
```

---

## 2. UI Builder — what chart types are actually available

> **This is the check that broke last time.** `01` §5 searched component names for *chart / visualization / graph*, which **excludes ServiceNow's own `now-vis-*` components**, and concluded "6 primitives." Do not repeat that filter.

### 2.1 The authoritative query — visualization extensions

```
/api/now/table/sys_ux_lib_component?sysparm_query=source_script_nameLIKEnow-visualization-extensions&sysparm_fields=sys_name,source_script_name&sysparm_limit=100
```

**Expected (matching dev390988) — 10 rows:**
`__bar__`, `__bubble__`, `__dial__`, `__gauge__`, `__geomap__`, `__heatmap__`, `__pareto__`, `__pie__`, `__singleScore__`, `__timeseries__`

| If you get | It means |
|---|---|
| 10, same names | Matches our baseline. The "6 primitives" claim stays dead. |
| **More than 10** | ServiceNow has expanded the palette, or EY has an add-on. **Our "OOB is limited in kind" argument shrinks further** — re-check §2.3 immediately. |
| Fewer / empty | Different release or Platform Analytics not fully provisioned. Check §1 and §4 before drawing any conclusion. |

### 2.2 The wider family

```
/api/now/table/sys_ux_lib_component?sysparm_query=sys_nameLIKEnow-vis&sysparm_fields=sys_name,source_script_name&sysparm_limit=200
/api/now/table/sys_ux_lib_component?sysparm_query=sys_nameLIKEsn-par&sysparm_fields=sys_name&sysparm_limit=200
```
Expected additions: `now-vis-sparkline`, `now-vis-navigator`, `sn-multipivot` (pivot), `sn-par-calendar-connected` (calendar), `sn-par-scorecard-*` (indicator scorecard), `timeline-chart`, `sn-chart-screen-reader-table`.

**Total component count** (sanity check that you're not looking at a slice):
```
/api/now/stats/sys_ux_lib_component?sysparm_count=true
```
dev390988: **1,831**. If your filtered result is a tiny fraction of this, ask whether your filter is the problem — that is exactly how the original error happened.

### 2.3 The ground truth — open the tool

**UI:** All → *Analytics Center* (or *Platform Analytics → Visualization Designer*) → **Create visualization** → look at the type picker.

Then: All → *UI Builder* → open/create a page → add the **Data Visualization** component → open its config panel → look at the type list.

**Write down both lists verbatim.** This is the comparison a client's own admin will make in the room, and it outranks any table query. Expected: ~16 types (single score, boxplot, bubble, dial, gauge, geomap, heatmap, horizontal bar, vertical bar, pie, donut, pareto, pivot, time series, calendar, list, indicator scorecard), with time series exposing line/area/spline/step/column/scatter sub-types.

### 2.4 What we still claim is missing — verify each is genuinely absent

Search the picker for: **sankey, treemap, sunburst, chord, network / force-directed, radar / spider, waterfall, bullet, candlestick / OHLC, parallel coordinates, scatter matrix, small multiples, combo / dual-axis.**

> **This is now the load-bearing visual argument** (`04` §2.6): the gap is *kind*, not *count*. If any of these turn up in the picker, **that specific one must come out of the pitch immediately.**

Also check: can you apply a **custom animation, bespoke annotation layer, or a second Y-axis of a different type**? And is there a **free-form canvas** layout (vs. grid/container only)? Both are claimed absent.

### 2.5 Classic reporting palette (for the fragmentation question)

```
/api/now/table/sys_choice?sysparm_query=name=sys_report^element=type&sysparm_fields=value,label,inactive&sysparm_limit=100
```
dev390988: **35 rows = 29 real types + 6 separators.** Note which are `inactive=true` on EY — a client may have restricted them.

**Migration state** (is ServiceNow closing the classic/PAR seam here?):
```
/api/now/table/sys_properties?sysparm_query=nameLIKEcoreui.migration^ORname=com.glide.par.unified_analytics.enabled&sysparm_fields=name,value
```

---

## 3. Export — is PPT/PDF already native here?

> Falsified `02` §2.4 on the PDI. Confirm it holds on EY, because if it does, **Layer 5 / Phase 5 stays cut.**

```
/api/now/table/sys_choice?sysparm_query=nameSTARTSWITHpar_export&sysparm_fields=name,element,value,label&sysparm_limit=100
/api/now/table/sys_properties?sysparm_query=nameLIKEglide.par.export^ORname=com.snc.pdf.exports.enabled&sysparm_fields=name,value
```

**Expected:**
- `par_export_dashboard.file_type` → **`ppt` (PPT)**, `pdf` (PDF)
- `par_export_visualization.file_type` → pdf, png, jpeg, csv, xls, xlsx, Embedded PNG, Embedded LIST
- `glide.par.export.enabled = true`, `glide.par.export.ppt.max_visualizations_allowed = 150`, `glide.par.export.use_uxf_renderer = true`

**UI confirmation:** open any Platform Analytics dashboard → hamburger/kebab menu → look for **Export** and **Schedule export**. Actually export one deck.

| If | Then |
|---|---|
| PPT present and enabled | Confirmed. Export is parity work. **Do not pitch it as a gap.** |
| `glide.par.export.enabled = false` or the property is absent | Export exists but is **switched off here** — that is a *configuration* gap, not a product gap. Worth raising with EY as a quick win, **not** as a reason to build. |
| `glide.par.export.allowed_roles` is populated | Export is role-gated. Note which roles; may explain "we can't export" complaints. |

**Still genuinely open:** wall-monitor / digital-signage **rotation**. Look for any native "rotate tabs / kiosk / TV mode" on a dashboard. If absent, this is the one surviving piece of the old Layer 5 thesis.

---

## 4. Now Assist — what's actually licensed and installed

> On dev390988 the analytics skills were **absent**, so nothing about Now Assist's chart behaviour could be verified. **EY is a real customer instance — this may be the first chance to hands-on test the 5-chart-type cap.** That would be a genuinely new finding either way.

### 4.1 Is the Data Visualization Generation skill present?

```
/api/now/table/sys_db_object?sysparm_query=nameLIKEquery_gen&sysparm_fields=name,label
```
**Expected if the skill is installed:** a `sn_query_gen_table_config` table (Semantic Table config). On dev390988 this returned **nothing**.

### 4.2 Plugin inventory

```
/api/now/table/v_plugin?sysparm_query=nameLIKEAssist&sysparm_fields=id,name,active,version&sysparm_limit=100
/api/now/table/v_plugin?sysparm_query=nameLIKEAnalytics^ORnameLIKEInsight&sysparm_fields=id,name,active,version&sysparm_limit=100
```
Watch for: **Now Assist Core**, **Now Assist for Platform Analytics / Creator**, `sn_pa_aia`, `sn_pa_aia_insights`, `Performance Analytics – KPI Signals`, `Performance Analytics – Spotlight`, `Performance Analytics AI`.

Also:
```
/api/now/table/sys_properties?sysparm_query=name=com.glide.par.dashboards.additional.plugins&sysparm_fields=name,value
```
dev390988 returned `com.glide.cs.genai, sn_pa_dash_ui_conv, sn_pa_aia_insights, sn_pa_aia`.

### 4.3 The actual test — if the skill IS active

**UI:** All → *Now Assist Admin* (Now Assist Admin Center) → *Skills* → find **Data visualization generation** → confirm Active.
Requires roles `now.assist.creator` / `now.assist.analytics` / `now_assist_panel_user` on your user.

Then open the **Now Assist panel** on a Platform Analytics dashboard and prompt it. **Test the cap directly:**

| Prompt | Claim | What confirms / breaks it |
|---|---|---|
| "Show open incidents by priority **as a bar chart**" | should work | baseline |
| "…**as a heatmap**" | **should fail or silently substitute** | ✅ cap holds if refused/substituted. ❌ **claim dead** if it renders a heatmap |
| "…**as a treemap**" / "**as a sankey**" | should fail | same |
| "…**as a donut**" | ambiguous — donut is OOB but not on the documented 5-list | tells you whether the 5-list is the real cap or just the documented one |
| "Show me incident resolution time distribution" *(no chart type stated)* | should pick from the 5 | **watch whether it reacts to skew/outliers.** If it picks a boxplot or notes the distribution shape, our **shape-adaptive differentiator is weakened** |

**Documented cap (Verified-Documentation):** single score, line, vertical bar, pie, list. Source: [ServiceNow's own prompting guide](https://www.servicenow.com/community/now-assist-for-creator-articles/data-visualization-generation-quick-start-and-prompting-guide/ta-p/3037710).

> **Record the result either way.** If the cap holds hands-on, we upgrade the claim from Verified-Documentation to Verified-HandsOn — the first time in this engagement. If it doesn't hold, `00` §3 Ceiling 1 needs rewriting the same day.

### 4.4 Autonomous insight — does PA surface things unprompted?

```
/api/now/table/sys_ux_lib_component?sysparm_query=sys_nameLIKEkpi-signal^ORsys_nameLIKEinsights-panel^ORsys_nameLIKEforecast&sysparm_fields=sys_name
/api/now/stats/par_computed_insight?sysparm_count=true
/api/now/stats/par_recommendation?sysparm_count=true
```

On dev390988 the components and tables existed but were **empty** (no dashboards built). **EY is a real instance — if `par_computed_insight` or `par_recommendation` has rows, that is native autonomous insight generation actually running in production**, and it is the strongest available evidence about how far `04` §5's correction goes.

**UI:** open a PA dashboard → look for an **Insights** panel, **KPI Signals** indicators, or forecast bands on a time-series chart. Screenshot whatever you find — it is what our Layer 2 has to be positioned *against*.

---

## 5. Data resources / aggregate brokers

```
/api/now/stats/sys_ux_data_broker?sysparm_count=true
/api/now/table/sys_ux_data_broker?sysparm_query=nameLIKEaggregat^ORnameLIKEvisualiz&sysparm_fields=name&sysparm_limit=60
/api/now/table/sys_db_object?sysparm_query=nameLIKEux_data_broker&sysparm_fields=name,label
```

**Expected:** ~1,400+ brokers; broker *types* = simple, transform, rest, rest_external, graphql, composite, proxy, scriptlet.

**UI:** in UI Builder, open **Data** on any page → **Add data resource** → **read the actual list of available types.** This is the definitive answer to "is there an aggregate data resource," and it is what `02` §2.2 got partly wrong.

**Claim to test:** there is no *generic, reusable, ACL-safe* aggregate resource a builder can drag on. If EY's list contains something like "GlideAggregate" or "Aggregate query" **with an ACL/security option**, Layer 1's framing needs revisiting.

---

## 6. The ACL test — the one that matters most

> This is the engagement's lead differentiator (`04` §3). **Do this on EY**, because a real instance with real ACLs and real domain separation is a far better test than a PDI.

### 6.1 The API-behaviour check — safe, no impersonation, run as yourself

*Scripts – Background* (All → *Scripts - Background*), scope **global**. **Read-only.**

```javascript
var out = [];
out.push('GlideAggregateSecure exists?  ' + (typeof GlideAggregateSecure)); // expect: undefined
out.push('GlideRecordSecure exists?     ' + (typeof GlideRecordSecure));    // expect: function
out.push('GlideQuery.withAcls exists?   ' + (typeof GlideQuery.prototype.withAcls)); // expect: function

var ga = new GlideAggregate('incident');
out.push('GlideAggregate.canRead type:  ' + (typeof ga.canRead));           // expect: function

try {
  var r = new GlideQuery('incident').withAcls().aggregate('count').select().toArray(1);
  out.push('withAcls aggregate RESULT:   ' + JSON.stringify(r));
} catch (e) {
  out.push('withAcls aggregate THREW:    ' + e);
}
gs.print(out.join('\n'));
```

**Expected on dev390988 (Australia):**
```
GlideAggregateSecure exists?  undefined
GlideRecordSecure exists?     function
GlideQuery.withAcls exists?   function
GlideAggregate.canRead type:  function
withAcls aggregate THREW:     Cannot use aggregate queries with withAcls()
```

| If | Then |
|---|---|
| It throws as above | ✅ Confirmed. **This error message is the single best slide in the deck** — ServiceNow's own ACL-aware query API refuses to aggregate. |
| **It returns a number instead of throwing** | ❌ **ServiceNow has shipped ACL-safe aggregation.** The lead differentiator is gone. Escalate immediately — this changes the whole product thesis, and `04` §9.1 has to be redone. |
| `GlideAggregateSecure` is `function` | ❌ Same conclusion. Escalate. |

### 6.2 The leak demo — use the **UI** Impersonate feature, not a script

> **Do not use `GlideImpersonate` in a background script here.** It hijacks the live session. The UI feature is safe and reversible.

1. Pick a low-privilege user on EY (`sys_user` with `roles` empty, or an ESS-only user). Note their `sys_id`.
2. **As admin, first** — record the true count:
   `/api/now/stats/incident?sysparm_count=true` (or any table with row-level ACLs / domain separation).
3. **Top-right avatar → Impersonate User →** select that user.
4. As the impersonated user, open the **list view** of that table (`/incident_list.do`) and read the record count in the list header. This is the ACL-enforced number.
5. Also open any **KPI tile / single-score visualization** bound to a count on that table.
6. **End impersonation** (same menu).

| Result | Meaning |
|---|---|
| **List count < KPI tile count** | ✅ **The leak, demonstrated on EY's own data.** Screenshot both. This is the demo. |
| Counts equal | The ACLs on that table are role-based (all-or-nothing), so the *table-level* `canRead()` guard is sufficient there. **Try a table with a query/script-based ACL or domain separation** — that is where row-level leakage lives. EY, as a large enterprise, very likely has domain separation somewhere. |
| Impersonated user sees nothing at all | Table-level denial. Still a valid (dramatic) demo if a KPI tile still renders a number — that is the 67-vs-0 case from the PDI. |

**Where to look for a genuinely row-level ACL** to make this land:
```
/api/now/table/sys_security_acl?sysparm_query=operation=read^active=true^conditionISNOTEMPTY^ORscriptISNOTEMPTY&sysparm_fields=name,operation,condition,script&sysparm_limit=50
```
Any `read` ACL with a **condition** or **script** is a row-level rule — those are the tables where aggregates over-count.

---

## 7. Build Agent / Code Assist — what EY actually has

> EY's session carries an `sk8s_codeassist_t2c_refresh_token` cookie, which indicates **Now Assist Code Assist (text-to-code)** is provisioned. dev390988 carried the analogous `sk8s_build_agent_refresh_token`. Neither has been examined in this engagement's research — **this is an unresearched surface and worth a proper look**, because a build agent that can generate UI Builder pages or components would compete with our delivery model, not just our product.

**Checks:**
```
/api/now/table/v_plugin?sysparm_query=nameLIKECode Assist^ORnameLIKEcode_assist^ORidLIKEcodeassist&sysparm_fields=id,name,active,version
/api/now/table/sys_db_object?sysparm_query=nameLIKEcode_assist^ORnameLIKEsn_codeassist&sysparm_fields=name,label
/api/now/table/sys_ux_lib_component?sysparm_query=sys_nameLIKEcode-assist^ORsys_nameLIKEbuild-agent&sysparm_fields=sys_name&sysparm_limit=50
```

Note also: this environment exposes ServiceNow MCP tools including `code_assist_generation`, `code_assist_edit`, `code_assist_autocomplete`, and `flow_generation` — evidence ServiceNow ships an agentic code-generation surface.

**Questions to answer, none of which our research currently addresses:**
1. Can Code Assist generate a **UI Builder page or a custom UXF component**, or only server-side script (Business Rules, Script Includes)?
2. Is there a **"Build Agent"** that composes multi-artifact apps? If yes, how close does it get to generating a dashboard?
3. Does anything in it do **chart selection**, or is it purely code-completion?

> **Why this matters to the thesis:** our differentiators are all about the *runtime product*. If ServiceNow's build agent can generate custom components, it compresses the *delivery* advantage — cheaper for a client's own admins to build something bespoke. That is a different threat from the one `00` §3 tracks, and it is currently unexamined in this repo. **Treat the answer as a new gap-registry entry regardless of which way it goes.**

---

## 8. Everything still open (carried from `04` §10)

| # | Open item | How to close it |
|---|---|---|
| 1 | **Drilldown reliability** — community reports of breakage, never reproduced by us | Build a 2-level drilldown on a UI Builder page (§2.3), click through it, and try it again after any promotion |
| 2 | **Cross-filter across *unrelated* tables** — `02` §2.1's "tables that relate cleanly" limit is community-sourced | Put two visualizations from unrelated tables on one dashboard, add an interactive filter, see what happens. `sn-par-filter-cascading-config` suggests native is better than documented |
| 3 | **Does the embedded OOB DV component inherit `sn-chart-screen-reader-table`?** | Embed one in UI Builder, tab to it with a keyboard, run a screen reader. Sizes the §3.1 accessibility workstream |
| 4 | **Wall-signage / kiosk rotation** — last surviving piece of old Layer 5 | Look for a native rotate/TV mode on a PA dashboard (§3) |
| 5 | **Export/view limit properties** — the 50k/500k/5k/10k figures are unconfirmed and the properties don't exist as records on Australia | `/api/now/table/sys_properties?sysparm_query=nameINglide.ui.export.limit,glide.excel.max_cells,glide.pdf.max_rows,glide.db.max_view_records&sysparm_fields=name,value` — then export something large and observe the real ceiling |
| 6 | **VividCharts G2 rating** | Manual, logged-in check of the live G2 page. Do not quote 4.7/16 or 4.6/5 until then |
| 7 | **VividCharts' own ACL handling** | If they already solve ACL-safe aggregation, differentiator #1 narrows. Needs their docs or a trial install |
| 8 | **Now Assist DV Generation hands-on** | §4.3 — EY may finally make this answerable |
| 9 | **Build Agent / Code Assist scope** | §7 — entirely unresearched |
| 10 | **Shadow-DOM chart rendering at scale** | Dedicated load test; generic ECharts benchmarks do not transfer (`03` §2.11) |

---

## 9. Reporting results back

For each check, record: **query/step run → raw result → verdict (confirms / falsifies / inconclusive) → which document section it affects.**

Findings that **falsify** something go into [`04-red-team-verification.md`](04-red-team-verification.md) with the same discipline used there: the exact query, the raw output, and the corrected wording. Findings that **confirm** a claim upgrade its confidence label (Verified-Documentation → Verified-HandsOn) in [`03-gap-registry.md`](03-gap-registry.md).

**The three results that would most change the plan, in order:**
1. §6.1 returning a number instead of throwing → **the lead differentiator is gone.**
2. §4.3 showing Now Assist reacting to data shape → **the second differentiator is gone.**
3. §7 showing a build agent that generates custom UXF components → **the delivery-model advantage narrows**, even if the product differentiators hold.
