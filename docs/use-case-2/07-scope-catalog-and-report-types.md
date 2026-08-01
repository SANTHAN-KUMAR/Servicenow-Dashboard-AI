# Scope correction — the product is a dashboard *library*, not a dashboard

Recorded 2026-08-01, after reviewing the client's in-house Dashboards experience
against what the POC had built. This supersedes the implicit "one dashboard page"
assumption in docs 00–06. Nothing about the visual bar, the native constraint, or
the AI differentiator changes — the **shape of the artifact** changes.

---

## 1. What the POC got wrong

The POC delivered a **single hard-coded page** (`ey_ai_dashboard.do`) showing six
fixed charts over the `incident` table. Whoever opens it sees the same six charts.
There is no way to pick a subject, no way to see what else exists, and no
relationship between what is being analysed and how it is drawn.

The client's own words for this shape: *"a dumb stub with some random default
graphs."* That is accurate. It proves the rendering stack works; it is not the
product.

## 2. What the client actually has, and expects us to match

From `$pa_dashboards_overview.do` on the live instance:

**An index page is the entry point.** Landing on Dashboards shows a **catalog of
dashboard cards** — `Admin Console`, `Change Overview`, `HR Case Dashboard`,
`MID Server Dashboard`, `Discovery Dashboard`, and so on. Each card carries a
name, an owner, a type chip, and a thumbnail hinting at its layout. Tabs slice
the catalog by relationship to the viewer — **Recent / Owned by Me / Shared with
Me / All** — plus a group filter and a name search.

**The catalog is permission-scoped.** "Owned by Me" and "Shared with Me" are not
cosmetic tabs; they reflect what this user is entitled to see. The catalog itself
is an access-controlled surface.

**Opening a card opens that dashboard.** Only then does a rendered analytical view
appear — the sample `Request Overview` shows a distribution pie and a ranked
horizontal bar, sized to the data, not to a template.

**Different report types produce different visual grammars.** This is the point
the POC missed entirely. Their tool does not draw the same chart set for every
subject: an approval-state breakdown gets a part-to-whole treatment, a ranked
task list gets sorted bars, a trend gets a time series. The visualisation follows
the **kind of question the report answers**.

## 3. The corrected target architecture

Two surfaces, not one.

### Surface A — the catalog (entry point)

A single page listing every dashboard/report the **logged-in user is entitled to
open**, with search, filtering, and Recent/Owned/Shared/All style slicing. Cards
carry enough identity — name, subject, type, last viewed — to choose from.

Requirements that follow from this:

- **Entitlement filtering is a first-class feature of the catalog**, not an
  afterthought. A user must not see a card for a dashboard whose data they cannot
  read. This is the same persona/ACL machinery already used for aggregate
  correctness, applied one level up — to *catalog membership* rather than to
  *cell values*.
- The catalog needs a **registry** of available dashboards (definition records),
  not hard-coded page names.

### Surface B — the rendered dashboard (per item)

Opening a catalog entry renders that specific dashboard at the full visual bar:
Power-BI-grade polish, ECharts, Now Design System tokens.

Requirements that follow:

- **Chart selection is driven by report type and data shape**, not by a fixed
  six-chart template. The existing `profileField()` shape profiler (distinct
  count, top share, concentration) is the right input; it is currently computed
  and displayed but **not** used to choose a form. It should be.
- **The user chooses what to analyse.** The client was explicit: *"it should give
  options to the user to analyse rather than overwhelming."* Present controls
  and let the user drive, rather than dumping every chart the engine can produce.

## 4. Where this lands against the existing brief

| CLAUDE.md commitment | Effect of this correction |
|---|---|
| Beautiful/Power-BI-like visuals are primary | Unchanged. Now applies per-dashboard, at Surface B. |
| ServiceNow-native runtime, no export | Unchanged. Both surfaces are native. |
| AI as bonus differentiator | **Strengthened.** Autonomous KPI/metric candidacy now has an obvious home: deciding what dashboards should exist in the catalog and which metrics belong in each. |
| Chart specs fitted to data shape, not a template list | **Promoted from aspiration to explicit requirement.** This is the gap the client independently identified in our build. |
| Provable ACL-correct aggregate binding | **Extended in scope.** Correctness now covers catalog membership as well as aggregate values. |

Note that the client, without seeing our research, arrived at data-shape-adaptive
charting as the thing their tool does and ours does not. That is the same
capability doc 00 identified as the least-proven, most-novel part of the plan. It
is no longer optional differentiation — it is table stakes for matching what they
already run.

## 5. What is now out of date in earlier docs

- **Doc 06** described the POC as a finished deliverable. It is a **rendering and
  correctness spike** — proof that a real charting library, real ACL-checked
  aggregates, and a native page work together on this instance. Read it that way.
- Any statement implying "the dashboard" (singular) is the artifact should be read
  as "a dashboard", one of many in a catalog.

## 6. Deliberately deferred

- **Visual quality of the current page.** The client has flagged it as reading
  like generic AI output rather than a Power BI experience, and has assigned
  redesign to a **design agent**. Do not spend effort polishing the existing
  six-chart layout; it is being replaced, and the visual language is someone
  else's call.
- **MCP work.** Explicitly parked by the client until the in-platform surfaces are
  right. See doc 06 for its current, working state.

## 7. Implied backlog

Nothing below is built. Order reflects dependency, not priority.

1. **Dashboard definition registry** — a table describing each available
   dashboard: name, subject table, report type, owner, entitlement rule.
2. **Catalog page** — cards, search, filter, Recent/Owned/Shared/All, rendering
   only entries the viewer is entitled to.
3. **Entitlement filter for catalog membership** — reuse the persona-validation
   engine, applied to registry rows.
4. **Report-type → visual grammar mapping** — an explicit, reviewable mapping from
   report kind plus measured data shape to chart form. The shape profiler exists;
   the mapping does not.
5. **Per-dashboard render surface** — one page that renders any registry entry,
   replacing the hard-coded page.
6. **User-driven analysis controls** — let the viewer choose the cut rather than
   presenting everything at once.
7. **AI layer, repointed** — metric candidacy feeding the registry; chart-spec
   adaptation feeding the mapping in item 4.
