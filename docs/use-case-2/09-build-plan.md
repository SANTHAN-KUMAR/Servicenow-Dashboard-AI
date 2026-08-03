# Build plan: how we actually construct this on ServiceNow

Written 2026-08-02. This is the technical implementation plan for the dashboard
and report product described in `07-scope-catalog-and-report-types.md`, rendered
to the design system in `design/command-brand-kit.html`, and justified by the live
instance evidence in `08-live-report-inventory.md`.

It assumes three things that are already settled and should not be re-litigated:

1. **Two surfaces, not one.** A permission-scoped catalog, and a dashboard/report
   renderer. See doc 07.
2. **Form is chosen from the measured shape of the data**, because the instance
   stores no field-to-form mapping and the product has no such logic. See doc 08
   section 3.
3. **External third-party components are permitted** as of 2026-08-01. This lifts
   the ceiling on typefaces and libraries. It does **not** authorise instance data
   leaving the instance. See section 6.

---

## 1. Scope

| In scope | Out of scope |
|---|---|
| Catalog surface (browse, search, filter, entitlement-scoped) | Authoring UI for end users to build new dashboards |
| Renderer for a dashboard definition | Semantic modelling layer / calculated measures |
| Form-selection engine over measured data shape | Natural language query |
| ACL-correct aggregation with proof | Cross-source joins |
| Light and dark themes | Now Mobile native rendering (not possible on any UI Builder page, see section 13) |
| Export to PDF/PPT via the native path | Custom export engine |

The AI insight layer is **parked** by direction on 2026-08-01. `EYAIDashAI` stays
in the codebase, unwired. Do not spend effort on it.

---

## 2. Delivering it as a native platform capability

**The goal is a native ServiceNow dashboards tool**, not a page that happens to
live on the instance. That distinction drives most of what follows, and it makes
one earlier instinct wrong: a `.do` UI Page is not a native tool no matter how
good it looks, so the UXF work cannot be deferred to the end of the plan.

### 2.1 What "native" has to mean concretely

A user should not be able to tell this was not shipped by ServiceNow. That is a
checklist, not a feeling:

| Property | Requirement |
|---|---|
| Installed as | A **scoped application**, versioned, promoted through Source Control, Store-publishable |
| Reached from | The platform navigator and the Next Experience nav, not a bookmarked `.do` URL |
| URL shape | `/now/<app>/dashboards` and `/now/<app>/dashboard/{sys_id}`, routed by UI Builder |
| Access controlled by | Platform roles and ACLs on our own tables, not page-level checks |
| Data | Platform tables via Script Includes, honouring ACLs |
| Drill-through | Lands on the **standard list view** for the table, not a bespoke record list |
| Export and scheduling | The native PDF/PPT and scheduled-report paths where they exist, not a parallel engine |
| Upgrade behaviour | Survives a family upgrade, no OOB record modified |
| Uninstall | Removing the app removes its artifacts cleanly |

### 2.2 Scoped application

Everything ships inside one scoped app, `x_<vendor>_cmd`. Nothing lands in the
global scope, and no OOB record is modified. This is what makes it installable,
upgrade-safe, and removable, and it is a precondition for the Store.

Artifacts in scope:

- Tables: `u_cmd_dashboard`, `u_cmd_dashboard_share`, `u_cmd_render_log`
- Script Includes: `CmdData`, `CmdPayload`, `CmdFormEngine`, `CmdCatalog`

The existing `EYAIDashData`, `EYAIDashPayload` and `EYAIDashAI` are global-scope
POC artifacts. They are **renamed into scope**, not rewritten: `EYAIDashData`
becomes `CmdData` with the same method surface (`fastGroupBy`, `secureGroupBy`,
`aclProof`, `monthlySeries`, `avgResolutionHours`, `profileField`). Renaming is
phase 0 work and should happen before anything new is written against the old
names.
- UXF components: `cmd-dashboard-canvas`, `cmd-catalog-grid`, `cmd-panel`
- UI Builder experience plus two pages, with route parameters
- Roles, ACLs, app menu and modules
- Theme records and the token stylesheet

### 2.3 Navigation and routes

Registered as a real UI Builder **experience** with two routed pages:

| Route | Page | Parameter |
|---|---|---|
| `/now/cmd/dashboards` | Catalog | optional `?tab=recent\|shared\|owned\|all` |
| `/now/cmd/dashboard/{id}` | Renderer | `id` is `u_cmd_dashboard.sys_id` |

Plus an app menu **Analytics** with modules *Dashboards* and *All reports*, so the
tool is reachable from the platform navigator the way any other application is.
Deep links must be shareable and must survive being pasted into a ticket, which is
why the dashboard identity lives in the path rather than in client state.

### 2.4 Roles

| Role | Grants |
|---|---|
| `x_cmd.viewer` | Read the catalog and open dashboards they are entitled to |
| `x_cmd.author` | Create and edit dashboard definitions they own |
| `x_cmd.admin` | Manage all definitions, sharing and app configuration |

Entitlement to the **data** is never granted by these roles. A viewer sees a
dashboard only if they can also read the subject table, which is enforced in the
data layer (section 3) rather than at the page.

### 2.5 The rendering surface

Given 2.1, the renderer is a **custom UXF component on a UI Builder page**. There
is no alternative that is genuinely native: a UI Page is classic, and a Service
Portal widget is a legacy portal surface.

That said, the UI Page harness that already works is too useful to throw away, so
it stays as **scaffolding, not as the product**:

- It has a two second deploy loop (`build_deploy.py`) against real instance data.
- Every platform constraint we have measured came from it.
- It lets phases 1 to 3 get the data layer, form engine and theme correct against
  real records before the component plumbing is in the way.

**The design constraint that makes this safe:** the render layer must be a pure
function of `(payload, tokens) -> DOM`. No Jelly, no `g:evaluate`, no `GlideAjax`,
no globals. The harness and the component then differ only in how the payload is
delivered. If that discipline slips, the port becomes a rewrite, and the plan
fails at its most important step.

The harness is deleted at the end of phase 4. It is not a fallback and it is not
shipped.

### 2.6 Store considerations

If this is ever published to the Store, three things follow, and all three are
already how the plan is written:

- **No external runtime dependency.** Customers with restricted egress must be
  able to install and run it. Self-host every asset (section 6).
- **Redistributable licences only.** ECharts is Apache-2.0, the three typefaces
  are SIL OFL, D3 is ISC. Highcharts would require a quote-only OEM licence, which
  is the main reason it is excluded.
- **Scoped, upgrade-safe, no OOB modification.** Already required by 2.2.

### 2.7 Measured constraints on the harness

From `poc/servicenow/ui-page/probe-results.md`. **Re-verify every row on the UXF
surface in phase 4** rather than assuming it carries over; two of these may simply
not apply there, and one of them changes the product if it does.

| Constraint | Consequence |
|---|---|
| Jelly evaluates `<script>` bodies. A CDATA-wrapped one makes the platform serve the whole page as **zero bytes, HTTP 200**, with no error anywhere | Harness-only. All client JS loads by `src`. `build_deploy.py` fails the build if any `<script>` has an inline body. |
| In-session XHR to Scripted REST **never returns**. The platform's own Table API behaves identically | Harness-only, we hope. First paint uses an embedded payload. **If this also holds on UXF, live filtering is off the table**, which is a product-level limitation the client must hear early. |
| UI Scripts are cached hard | Every asset URL carries a content hash. Applies to component assets too. |
| Table API returns HTTP 200 whether or not it stored what you sent | Every write is followed by a read-back and byte comparison. Keep it. |

## 3. Data layer

### 3.1 The correctness problem, stated precisely

`GlideAggregate` does not apply row-level ACLs. There is no `GlideAggregateSecure`.
`GlideQuery.withAcls()` throws rather than aggregating. Measured on dev390988: a
role-less user gets `GlideAggregate` count 67 where `GlideRecordSecure` returns 0
rows.

This means the naive aggregate is a **data leak**, not a rounding error. A count
tile can tell a user how many records exist that they are not allowed to see, and
a group-by can disclose the existence of categories.

### 3.2 What already exists

`EYAIDashData` (Script Include) provides:

| Method | What it does | ACL |
|---|---|---|
| `fastGroupBy(table, field, q)` | `GlideAggregate` group-and-count | **Not enforced** |
| `secureGroupBy(table, field, q)` | `GlideRecordSecure` iterate and count in memory | Enforced |
| `aclProof(table, field, q)` | Runs both and returns the delta | n/a |
| `monthlySeries(table, dateField, months, q)` | Time bucket counts | fast path |
| `avgResolutionHours(table, groupField, q)` | Mean, with `n` | fast path |
| `profileField(table, field, q)` | distinct count, top share, concentration | fast path |

`EYAIDashPayload.overview(table, months)` composes these into one payload, and
`overviewB64` base64-encodes it for embedding.

### 3.3 The tiered strategy

`secureGroupBy` is correct and slow: it materialises every row. `fastGroupBy` is
fast and unsafe. Running secure everywhere does not scale; running fast everywhere
is a leak. The strategy is therefore:

```
for each aggregate binding:
    fast  = fastGroupBy(...)
    proof = aclProof(...)            # cheap: one secure count, not a full group-by
    if proof.delta == 0:
        publish fast, mark VERIFIED
    else:
        publish secureGroupBy(...), mark FILTERED, log the delta
```

Three properties this gives us:

- The **common case is fast**. Most viewers of an operational dashboard are
  entitled to the whole table, so the delta is zero and the fast path publishes.
- The **unsafe case is never published**. A non-zero delta forces the secure path.
- The **delta is observable**. Every divergence is logged with table, field, query
  and viewer role set, which is the input for tuning.

**Open risk:** we have not measured `secureGroupBy` at 100k+ rows. Phase 2 must
include a load test with a real table and a role-less persona. If the secure path
is too slow at scale, the fallback is a nightly materialised aggregate table keyed
by role set, which is a materially larger build. Budget for the possibility.

### 3.4 Payload delivery

Because in-session XHR does not return, first paint uses a server-computed payload
embedded in the page:

```xml
<g:evaluate var="jvar_payload" object="true">
  new EYAIDashPayload().overviewB64($sp.getParameter('def'), 12);
</g:evaluate>
<div class="cmd" id="cmd-root" data-payload="${jvar_payload}">
```

Base64 avoids every quoting hazard in the Jelly/XML layer. The client decodes once
on boot.

**Filters therefore pre-compute.** A filter control does not fetch; it selects
among cuts already present in the payload, or triggers a full page reload with new
URL parameters. This is a real limitation and it must be stated to the client
rather than discovered. Re-test XHR on the UXF surface in Phase 4: if it works
there, filters become live and this constraint disappears.

### 3.5 Payload contract

The renderer consumes exactly this. Versioned, so the renderer can reject a
payload it does not understand.

```json
{
  "v": 1,
  "generated": "2026-08-02T10:03:55Z",
  "viewer": { "sys_id": "...", "name": "Kumar G", "roles": ["itil"] },
  "definition": { "sys_id": "...", "title": "...", "table": "incident" },
  "range": { "months": 12, "from": "...", "to": "...", "partialTail": true },
  "acl": { "mode": "VERIFIED|FILTERED", "aggregate": 13986, "secure": 13986, "delta": 0 },
  "panels": [
    {
      "id": "volume-by-category",
      "question": "rank",
      "field": { "name": "category", "type": "choice", "label": "Category" },
      "shape": { "distinct": 10, "topShare": 0.27, "concentration": 0.46, "n": 13986 },
      "aggregate": "COUNT",
      "form": "ranked_bar",
      "guards": ["nulls_merged", "top_n_6"],
      "series": [ { "label": "Inquiry / Help", "value": 3733 } ],
      "other": { "label": "Unknown", "value": 344 }
    }
  ]
}
```

`form` is written by the engine (section 4), not by an author. `guards` records
what the engine did to the data so the renderer can caption it honestly.

---

## 4. The form engine

New Script Include: **`CmdFormEngine`**.

### 4.1 Inputs

All four already exist or are a single lookup away.

| Input | Source | Status |
|---|---|---|
| Field data type | `sys_dictionary.internal_type` | To build, trivial, cache per table |
| Distinct / top share / concentration | `EYAIDashData.profileField()` | **Exists** |
| Aggregate function | Dashboard definition record | Exists |
| Row count `n` | `EYAIDashData` count | **Exists** |

### 4.2 The selector

```javascript
selectForm: function (ctx) {
  // ctx = { fieldType, distinct, topShare, concentration, n, aggregate, isTime, dims }
  if (!ctx.field)                                   return 'stat_tile';
  if (ctx.isTime && ctx.dims === 1)                 return 'line';
  if (ctx.isTime && ctx.distinct <= 8)              return 'stream';
  if (ctx.isTime)                                   return 'small_multiples';
  if (ctx.fieldType === 'boolean')                  return 'stacked_proportion';
  if (ctx.isOrdinal && ctx.distinct <= 7)           return 'stacked_ordinal';
  if (ctx.dims === 2)                               return 'heatmap';
  if (ctx.isFlow)                                   return 'sankey';
  if (ctx.distinct <= 12)                           return 'ranked_bar';
  if (ctx.concentration > 0.8)                      return 'ranked_bar_top_n';
  if (ctx.concentration < 0.5)                      return 'treemap';
  return 'ranked_bar_top_n';
}
```

First match wins, top to bottom. It is deliberately a flat rule list rather than a
model: it is reviewable, diffable, and testable.

### 4.3 Guards, applied after selection

These are what stop a technically valid chart from being a dishonest one.

| Guard | Rule |
|---|---|
| `low_n` | `n < 30` attaches a caveat. The current build shows a 440-day mean from 46 of 13,986 records with no warning at all. |
| `nulls_merged` | Empty and `undefined` merge to one Unknown bucket, painted the reserved neutral, pinned last regardless of magnitude. |
| `non_additive` | Part-to-whole is refused when the aggregate is AVG. Averages do not sum to a whole. |
| `dominant_slice` | `topShare > 0.9` demotes part-to-whole to a stat tile plus a note. |
| `series_cap` | More than 6 series folds the tail to Other. A seventh hue is never generated. |
| `all_pairs_cap` | Scatter, bubble and choropleth cap at 3 series. Measured: only the first three palette slots clear the all-pairs colour gate. |
| `partial_period` | A trailing incomplete bucket is flagged, because an in-progress month always looks like a collapse. |
| `acl_divergence` | Aggregate compared against the ACL-filtered count; any delta forces the secure path and marks the panel. |

### 4.4 Proving it before shipping

Run the selector over all 2,368 live reports in `sys_report` and diff chosen form
against authored form. Two outputs, both useful:

- **Agreement** becomes a regression baseline. Any future change to the rule table
  that moves a previously agreeing report is flagged in CI.
- **Disagreement** is a reviewable list of the instance's worst existing charts,
  starting with the 20 datetime fields currently rendered as a single score.

This costs one script and is a client deliverable in its own right.

---

## 5. Render layer

### 5.1 Single source of truth for colour

The design tokens are the source. The ECharts theme is **generated** from them at
build time, never hand-maintained in parallel.

```
design/command.tokens.css   ->  tools/gen-echarts-theme.js  ->  cmd.echarts.theme.json
```

This matters because the failure mode is real and already happened once: `app.js`
in the POC carries per-chart colour literals, so the palette and the charts drift.
After this change there are zero colour literals in the render layer.

### 5.2 Chart adapters

One module per form, each with the same signature:

```javascript
// forms/ranked_bar.js
export function build(panel, tokens) {
  return { /* ECharts option object */ };
}
```

22 forms specified in the design system. Adapters map the payload panel to an
ECharts option. All mark specs (bar cap 24px, 4px radius on the data end only, 2px
line, 8px marker, 2px surface gap, horizontal gridlines only) live here, once.

### 5.3 The report matrix is not ECharts

The matrix visual is plain HTML and CSS: hierarchy, in-cell data bars, colour
scale cells, inline sparklines, variance columns, subtotals. It renders faster
than a chart library would, it is natively accessible, it prints, and it exports
to CSV without a second code path. Do not build it in ECharts.

### 5.4 Themes

`data-theme="light|dark"` on the root. Both palettes are independently validated
against their own surface. Persist the choice per user. Default follows the
instance's own theme setting if one is readable, otherwise dark.

---

## 6. Asset delivery

The permission to use external components changes what we can load. It does not
change where data lives.

| | Allowed | Recommendation |
|---|---|---|
| Typefaces (Space Grotesk, Inter Tight, JetBrains Mono, all SIL OFL) | Yes | **Self-host** as instance assets. Free to redistribute, and the product then survives a CDN outage. |
| ECharts, ECharts GL, D3, Motion One | Yes | Self-host, content-hashed. Same reason. |
| Any CDN at runtime | Yes, now | Avoid. Adds an availability dependency the client does not control for zero quality gain. |
| Instance record data leaving the instance | **No** | Aggregate and render in-browser. This is a different risk class: residency, DPA, ACL enforcement at the boundary. |

If this is published to the Store, self-hosting stops being a preference and
becomes a requirement: customers with restricted egress must be able to install and
run it with no outbound calls at all.

Stated plainly for the record: **code and fonts travel in, data does not travel
out.** If the client wants to revisit the second half, that is a separate
conversation with legal, not a design decision.

---

## 7. The catalog surface

### 7.1 New table: `u_cmd_dashboard`

| Column | Type | Notes |
|---|---|---|
| `name` | String | Display title |
| `description` | String(400) | Card body |
| `table` | Table name | Subject table |
| `filter` | Conditions | Base query |
| `panels` | JSON | Panel definitions (field, aggregate, question hint) |
| `owner` | Reference sys_user | |
| `group` | Reference sys_user_group | Sharing scope |
| `roles` | List | Required roles to see the entry |
| `active` | Boolean | |
| `thumb_form` | String | Which form drives the card preview |

### 7.2 Entitlement is catalog membership

An entry the viewer cannot read is **absent**, not greyed out. The read ACL on
`u_cmd_dashboard` checks both the declared `roles` and the viewer's read access to
the subject `table`. A locked card appears only where someone explicitly shared a
link, so the state carries information rather than teasing.

This is the same persona machinery Use Case 1 built. Reuse it. Do not rebuild.

### 7.3 Live finding that shapes the UI

Measured on the instance: almost every dashboard is owned by `System
Administrator`, with two exceptions owned by a named user. **"Owned by me" will be
empty for nearly every viewer.** Default tab is Recent, not Owned. Do not ship a
default tab that is empty for 95% of users.

### 7.4 Thumbnails

Generated from the dashboard's own panel spec through the same form engine, at
card size, with axes and labels suppressed. Never a stored screenshot: a
screenshot goes stale silently, and staleness in a catalog destroys trust in the
whole surface.

---

## 8. Performance budget

A dashboard is left open all day on machines we do not control, sometimes on a
wall display that never sleeps. These are functional requirements.

| Rule | Reason |
|---|---|
| No `mix-blend-mode` | Forces the compositor to read back everything beneath it on every paint. Verified to pin a workstation during this engagement. |
| No `backdrop-filter` | Re-renders a blurred backdrop every scroll frame. |
| No coloured `drop-shadow` on marks | Multiplies rasterisation by the number of marks, which is the direction that scales worst. |
| `content-visibility: auto` per panel | Off-screen panels are not laid out or painted. Largest single win on a long report. |
| No infinite animation | A looping pulse keeps the compositor awake forever. |
| Canvas renderer above ~1,000 marks | SVG stops scaling there. ECharts switches on a config flag, so it is not a rewrite. |

Targets: first contentful paint under 1.5s on the embedded payload, panel
interaction under 100ms, no long task over 200ms during scroll.

---

## 9. Accessibility

Named workstream, not an inheritance. A canvas or SVG chart gets no ARIA, no
keyboard traversal and no screen-reader support for free, and ServiceNow publishes
no accessibility conformance report covering custom UI Builder pages or custom UXF
components as a category. That responsibility is ours.

| Item | Requirement |
|---|---|
| Table view | Same-page toggle on every chart to a linear table. This is the pattern classic PA already ships and the only credible answer for canvas charts. |
| Focus order | Every chart focusable, arrow keys traverse marks. |
| Announcements | Each mark carries an accessible name; the tooltip content is announced. |
| Colour | Never the sole channel. Legend plus direct labels plus 2px gaps, in both themes. |
| Contrast | WCAG 2.2 AA. Both palettes validated against their own surface. |
| Reduced motion | `prefers-reduced-motion` renders final state. |

Build it alongside the charts. Retrofitting accessibility onto 22 chart adapters
is several times the cost of building it in.

---

## 10. Build, deploy, promotion

- **Source Control (Git) is the system of record.** Update Sets are confirmed not
  to reliably carry custom UXF component source or all UI Builder page artifacts.
- **`build_deploy.py` stays and keeps both guards**: XML validation before deploy,
  and read-back byte comparison after. Two rounds of this engagement were lost to
  reporting a fix as deployed while the instance still served the old record.
- **Content hash on every asset URL**, because UI Scripts are cached hard.
- **A regression pass after every quarterly platform upgrade**, specifically around
  data-binding configuration, which has a corroborated report of clearing
  unexpectedly across upgrades.

## 11. Testing

| Layer | Mechanism | Notes |
|---|---|---|
| Form engine | Unit tests, plus the 2,368-report regression diff | The highest-value test we have |
| Guards | Unit tests with synthetic edge data | low n, all nulls, single category, dominant slice |
| ACL correctness | Persona matrix: admin, itil, role-less, group-scoped | Assert `delta == 0` or that the secure path published |
| Chart adapters | Visual regression in CI, outside ATF | ATF does not cover custom UXF with parity |
| Accessibility | axe plus manual keyboard pass per form | |
| Performance | Lighthouse plus a scripted long-task check | Against the section 8 budget |

**ATF is not the primary net.** Its own ServiceNow-authored documentation
acknowledges it does not cover custom UXF/UI Builder components with parity to
classic forms.

---

## 12. Phasing

Reordered from an earlier draft. Because the goal is a native tool, the UXF
component is on the critical path, and the largest unknown in the whole plan is
whether the platform constraints we measured on the UI Page also hold there. That
question is answered in **week two**, by a deliberately small spike, rather than in
month four when the answer is expensive.

| Phase | Deliverable | Depends on | Rough effort |
|---|---|---|---|
| 0 | Scoped app skeleton: app record, roles, tables, ACLs. Script Includes renamed into scope. Token export and ECharts theme generator. No visual change. | none | 1 week |
| 1 | **UXF spike.** One component on a UI Builder page rendering one chart from a payload. Re-test XHR, asset loading, caching and Shadow DOM sizing on that surface. | 0 | 1 week |
| 2 | Data layer hardening: tiered ACL strategy, payload contract v1, load test of the secure path | 0 | 1.5 to 2 weeks |
| 3 | Design system applied on the harness: material, type, stat tiles, both themes | 0 | 1 to 1.5 weeks |
| 4 | Form engine plus guards, regression diff against all 2,368 live reports | 2 | 2 to 3 weeks |
| 5 | Chart adapters, 22 forms, light and dark | 3, 4 | 3 to 4 weeks |
| 6 | Report matrix and native export path | 2 | 1.5 weeks |
| 7 | Render layer into the UXF component. Harness deleted. | 1, 5 | 1.5 to 2 weeks |
| 8 | Catalog surface: definition table, entitlement, thumbnails | 4, 7 | 2 weeks |
| 9 | Navigation: experience, routes, app menu, modules, deep links | 7 | 3 to 5 days |
| 10 | Accessibility completion, performance pass, upgrade regression suite | all | 2 weeks |

Two ordering rules worth stating, because they are the ones that will come under
pressure:

- **Phase 1 does not get skipped.** It is one week and it de-risks the most
  expensive assumption in the plan. Skipping it to "get something visible sooner"
  is how the port becomes a rewrite in phase 7.
- **Phase 4 does not slip.** It is the thing the client asked for by name after
  seeing the POC, and phase 5 is largely wasted effort if the form engine is wrong.

## 13. Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| `secureGroupBy` too slow at scale | Medium | High | Load test in phase 2. Fallback is a materialised aggregate keyed by role set, which is a bigger build. Decide early. |
| XHR also broken on the UXF surface | Medium | Medium | Answered by the phase 1 spike. The embedded payload already works, so this degrades live filtering rather than breaking the product. Tell the client the answer as soon as we have it. |
| UXF port overruns | Low to medium | Medium | The phase 1 spike answers the surface questions in week two, and the render layer is kept as a pure function of payload plus tokens throughout, so the port touches only delivery. |
| Custom components unsupported by ServiceNow | Certain | Medium | Portable plain JS, no framework beyond what UXF requires. Documented as an ownership cost to the client up front. This is the price of native, and it is not avoidable by any other surface. |
| Update Sets do not carry UXF artifacts reliably | High | Medium | Source Control is the system of record from phase 0. Never rely on an Update Set to move a component. |
| Form engine output is judged poor on real data | Medium | High | The 2,368-report diff surfaces this in phase 3, before the expensive adapter work. |
| Quarterly upgrade breaks data binding | Low | Medium | Regression suite, section 10. |
| Now Mobile cannot render the page | Certain | Low | True of OOB-component pages too. Mitigation is a responsive browser view. State it to the client proactively. |

---

## 14. Decisions the client still needs to make

1. **Light or dark as the default theme.** Both are built and validated. Dark is
   the flagship in the design system; light is likely the safer default for a
   broad ITSM audience and for printing.
2. **Does the external-component permission extend to data egress?** Our position
   is no, and nothing in the plan needs it. Confirm.
3. **Which subject areas ship first.** Measured on the instance, GRC, risk, audit
   and compliance together carry more reports than `incident`. An incident-only
   pilot may be the wrong pilot.
4. **Appetite for the materialised aggregate fallback** if phase 2's load test
   fails, since it is a materially larger build.

---

## 15. What this plan does not claim

Not Power BI parity. What is achievable is Power-BI-grade visual and interaction
quality on ServiceNow-native data. Cross-source semantic modelling, DAX-equivalent
calculated measures, key influencers, natural language query and genuine end-user
ad-hoc exploration are structural gaps that better rendering does not close. The
parity table in section 06 of the design system states exactly which of these are
covered, which are deliberately different, and which are not matched.
