# CLAUDE.md — ServiceNow AI Dashboards & Reports (Use Case 2)

**Read this before touching any other document in this repo.** Its one job is to keep you
anchored to what the client asked for. The research dossiers in this repo are rigorous and
evidence-backed, but they were written to map the *solution space*, and solution-space mapping
pulls attention toward whatever is most technically interesting — right now, the AI layer. This
file is the counterweight. When a technical document and this file disagree about *what we are
building for*, this file wins. When they disagree about *what is technically true*, the measured
/ researched document wins. Keep those two kinds of authority separate.

---

## 0. The one-paragraph brief you must not drift from

The client asked for **beautiful, impressive, attractive, Power-BI-like dashboards and reports
inside ServiceNow** — visually rich, polished, native (the final artifact runs entirely inside
the platform, no data export, no external BI tool). **That visual/experiential bar is the
deliverable.** Our research found that the strongest differentiator — the actual moat — is an AI
layer (content-aware metric selection, data-shape-adaptive chart generation, provable ACL-correct
binding) that neither VividCharts nor native Now Assist does. **That AI layer is a bonus we are
delivering on top of the beautiful dashboard, not a substitute for it.** If a task makes the AI
smarter but the dashboard less beautiful, or skips visual polish to spend time on AI, that is
drift. Beautiful first. AI as the differentiator layered on top.

---

## 1. What the client actually asked for — the source of truth

1. **Beautiful, impressive, attractive dashboards and reports.** Not "functional," not
   "competent" — the client's own words are aesthetic and comparative: *Power-BI-like*. This is
   the primary, literal, non-negotiable requirement. Visual and interaction quality is a
   first-class deliverable, not a nice-to-have wrapped around a data pipeline.

2. **ServiceNow-native, no export.** The client was explicit: today, getting real analysis means
   exporting to Power BI, and ServiceNow doesn't have a native answer. **The final delivered
   artifact must run entirely inside ServiceNow** — no runtime dependency on an external service,
   no data leaving the instance. This is the one hard technical constraint that cannot be traded
   away for visual richness.

3. **The AI integration is our addition, not the client's ask.** The client did not ask for AI —
   they asked for beauty and richness. We are *choosing* to deliver AI-driven insight/metric
   selection as a differentiator, because our research shows it's the part nobody else
   (VividCharts, native Now Assist) does well. Position and build it as a bonus capability that
   makes the beautiful dashboard smarter — never let it become the reason the dashboard itself
   ships thin.

**What is NOT constrained:** the *build process*. Design tools, external LLMs, any charting
library, any AI model used during generation are all fair game — the constraint is only on the
**delivered runtime artifact**, which must be ServiceNow-native.

---

## 2. The priority rule — do not invert this

**Visual/experiential quality is the primary bar. AI is the differentiator layered on top.**
Every task, every sprint, every architecture decision gets checked against this ordering:

1. Does the dashboard look and feel beautiful, polished, Power-BI-comparable? (**primary — must
   ship**)
2. Does the AI layer make it smarter — better metrics, better-fitted visualizations, provably
   correct data — without compromising #1? (**secondary — the moat, ships alongside #1, never
   instead of it**)

If you find yourself deep in chart-spec-generation model work while the actual rendered dashboard
still looks like an OOB scorecard, you have inverted the priority. Stop and fix #1 first.

---

## 3. The two rules that resolve every conflict

1. **Requirements outrank architecture; research outranks assumption.** For *what to build for*
   (beautiful, native, AI as bonus), Section 1 wins over any technical document. For *what is
   technically true* (what's achievable, what a library costs, what Now Assist can/can't do), a
   researched/measured finding wins over reasoning or vibes. These don't usually conflict — one
   governs the target, the other the method — apply them in that order when it feels like they do.

2. **"ServiceNow-native" governs the runtime, not the toolchain.** Never let "must be native"
   creep into "must only use OOB tools to build it." Build with whatever helps; ship an artifact
   with no external runtime dependency.

---

## 4. The client's Now Design System / UI Builder governance document — the resolved position

The client separately supplied a UI standards document requiring adherence to the **Now Design
System** and preference for **UI Builder OOB components**, with custom UI allowed **only where a
business requirement cannot be met by standard components.** Do not re-litigate this from
scratch and do not treat it as an absolute ban on custom charting. The resolved position:

- **Use the document's own exception clause.** "Power-BI-like, beautiful, impressive" is
  precisely the kind of requirement OOB components cannot meet — the OOB Data Visualization
  palette is fixed and comparatively basic, and native Now Assist chart generation is capped at
  five chart types. That gap is your documented justification for going custom. State it
  explicitly wherever this decision is recorded: *"OOB Now Design System components cannot meet
  the client's stated visual/interactivity bar; custom components are used per the governance
  document's own exception clause."*
- **Go custom on rendering, stay compliant on everything else.** Build custom Next Experience
  components (primary) or Service Portal widgets (legacy portals) that embed a real charting
  library — but have them **consume Now Design System tokens** (color, typography, spacing) so
  the result is visually consistent with the platform's brand kit even though the chart engine
  underneath is bespoke. This is the middle path: escape the *component palette*, honor the
  *design language*.
- **Never modify OOB components directly.** Net-new custom components only, same upgrade-safety
  discipline as Use Case 1. Report every deviation from OOB (what was needed, why OOB couldn't
  meet it) — this is a compliance asset, not paperwork to skip.
- **Do not oversell "Power-BI-like" as literal parity.** Internally and to the client: what's
  achievable is a beautiful, richly interactive, ServiceNow-native dashboard — not true
  cross-source semantic modeling, DAX-equivalent calculated measures, or arbitrary end-user
  ad-hoc exploration. Those are structural gaps custom rendering doesn't fix. Say "Power-BI-grade
  visual and interaction quality on ServiceNow-native data," not "Power BI replacement."

---

## 5. The drift you are most likely to commit (and the correction)

- **DRIFT: treating the AI layer as the product and the dashboard as a wrapper around it.**
  **Correction:** the client asked for beauty; we're adding AI. If a status update is all about
  model behavior and has nothing to say about how the dashboard looks, that's the tell.

- **DRIFT: retreating to OOB-only components to be "safe" on governance, producing a dashboard
  that looks like every other ServiceNow dashboard.** **Correction:** Section 4's exception clause
  exists precisely so this doesn't happen. Beautiful is the requirement; use it.

- **DRIFT: repeating the falsified "OOB only has six chart types" figure.** A red-team pass
  (`docs/use-case-2/04-red-team-verification.md`) traced that number to a search-filter artifact.
  The real OOB palette is **~16 types** (Visualization Designer) / 29 in classic reporting.
  **Correction:** argue from *kind*, not count — no sankey/treemap/sunburst/network/radar/waterfall,
  fixed visual treatment, no free-form canvas. Same conclusion, defensible premise.

- **DRIFT: pitching export (PPT/PDF) as an open native gap.** It isn't — ServiceNow ships native,
  scheduled, emailable PPT and PDF dashboard export, verified live. **Correction:** treat export as
  parity work, never as a differentiator.

- **DRIFT: claiming nothing native surfaces insight autonomously.** Performance Analytics ships
  KPI Signals, Spotlight and forecasting, all unprompted. **Correction:** the open gap is metric
  ***candidacy*** — which metrics should exist — upstream of PA's indicator definition. That is a
  real gap and a much smaller claim than "autonomous analytics."

- **DRIFT: building "AI picks one of five chart types from a prompt" and calling it the moat.**
  **Correction:** that's what native Now Assist Data Visualization Generation already ships,
  unchanged across the last two releases. It is not a differentiator. The actual moat, per
  research, is (a) autonomous KPI/metric selection from real content, (b) chart specs adapted to
  the real statistical shape of the data rather than picked from a template list, and (c) provably
  ACL-correct aggregate binding. Build toward those three, not toward NL-to-chart.

- **DRIFT: shipping an aggregate/KPI card without checking ACL correctness.** GlideAggregate does
  **not** enforce **row-level** ACLs (it does expose a table-level `canRead()` you must remember to
  call), there is no GlideAggregateSecure, and `GlideQuery.withAcls()` **throws rather than
  aggregate** — verified live. A card that silently shows a count including records the viewer can't
  read is a **demonstrated** failure mode: on dev390988, a role-less user gets `GlideAggregate` = 67
  where `GlideRecordSecure` returns 0 rows. This is now the engagement's **lead** differentiator —
  the only one that got stronger under red-teaming — not the third pillar. **Correction:** every aggregate binding must be checked against the viewer's persona before
  it's considered done. This is also where the AI moat and the correctness obligation are the same
  piece of work — don't treat them as separate backlog items.

- **DRIFT: reaching for Highcharts by default.** It requires a paid commercial license, and an OEM
  license (quote-only, perpetual) if embedded in something distributed to and hosted by customers
  — directly relevant if this ships as a Store app. **Correction:** default to **ECharts**
  (richest OOB chart set, permissive Apache-2.0 license, plain-JS, plays well with the deployment
  toolchain). Only reach for Highcharts if a specific visual genuinely requires it, and get the
  licensing cost confirmed before committing.

- **DRIFT: assuming this is a totally separate codebase/engine from Use Case 1.** **Correction:**
  reuse what already exists — the content graph (for KPI/metric discovery) and the persona-based
  validation engine (for provable ACL-correct binding) are the same machinery Use Case 1 built for
  IA and entitlement correctness, pointed at a different output. Don't rebuild them from scratch;
  don't silently merge the two products either — the target artifact (a dashboard/report page,
  not a whole generated portal) is genuinely distinct and gets its own emission surface.

- **DRIFT: overclaiming the ceiling.** Do not describe the product, internally or to the client,
  as achieving true Power BI parity. The honest ceiling is high on visual/interaction richness and
  low on cross-source modeling and ad-hoc self-service exploration. State it that way.

---

## 6. What is proven vs. targeted vs. open (keep this honest and current)

- **Proven (researched, high confidence):** custom Next Experience components and Service Portal
  widgets can embed arbitrary charting libraries (ECharts/D3/Highcharts/Chart.js) fully natively;
  VividCharts is a live, Store-distributed, revenue-generating existence proof this looks
  "beautiful" and works commercially. GlideAggregate/GlideQuery do not enforce ACLs — a real,
  documented gap. Native Now Assist chart generation is capped at 5 chart types, unchanged across
  the last two releases. No shipped BI product — ServiceNow-native or general market — does true
  data-shape-adaptive chart-spec generation; it exists only in research (not as an enterprise
  feature), meaning this is the most novel and least proven part of our own plan too.

- **Targeted (in scope, not yet built):** a dashboard/report generation module on custom Next
  Experience components, ECharts-first, Now-Design-System-token-themed; reuse of the content graph
  for autonomous KPI selection; reuse of the persona-validation engine for provable ACL-correct
  aggregate binding; export/reporting polish (PPT/PDF, wall-display) to match the bar VividCharts
  already sets.

- **Open / unresolved (the real risks):** whether AI-generated, data-shape-adaptive chart specs
  are actually reliably good — this is unproven anywhere, by anyone, and is the single biggest
  technical risk in this use case (same category of bet as Use Case 1's IA-quality risk — treat it
  with the same seriousness, don't assume it'll just work). Whether ACL-safe aggregate binding can
  be done both correctly and performantly at scale (the naive correct approach — iterate securely
  and count in memory — is slow). Whether any specific visual genuinely needs Highcharts (avoid
  the licensing cost if not). The realistic richness ceiling relative to true Power BI is an
  estimate, not a measurement — don't quote it as fact.

**Priority signal for planning:** spend early effort proving (a) the dashboard can actually look
beautiful in practice, not just in principle, and (b) whether adaptive chart-spec generation
produces good output on real data — those are the two things that could each independently sink
this use case, and neither has been built yet.

---

## 7. Before you finish any task, check it against the brief

- Does this make the dashboard more beautiful, or does it only make the AI smarter? If the
  latter, is #1 already solid enough to afford the detour?
- Have I reached for OOB components out of caution in a way that undercuts the visual bar the
  client explicitly asked for? If so, does the Section 4 exception clause apply?
- Is every aggregate/KPI binding checked for ACL correctness, not just assumed fine?
- Am I quoting "Power-BI-like" as a literal parity claim anywhere? Reframe to the honest ceiling.
- Have I reused the Use Case 1 content-graph / persona-validation engine where it applies, instead
  of rebuilding it?
- Would a reader unfamiliar with the whole research lineage understand this output, or does it
  assume context only we have?

---

## 8. Standing facts about the engagement (context, low churn)

- Primary rendering target: **custom Next Experience components**, ECharts-first. Service Portal
  widget parity only where a legacy portal genuinely needs it.
- Design compliance: consume **Now Design System tokens** (color, typography, spacing) inside
  custom components; never modify OOB components directly; every custom-vs-OOB deviation gets
  recorded with its justification.
- The AI differentiator, in priority order: (1) autonomous KPI/metric discovery from real content
  — not human-specified; (2) chart specs fitted to the actual statistical shape of the data, not
  picked from a fixed template list; (3) provable, persona-specific ACL correctness on aggregate
  bindings. NL-to-chart alone is not a differentiator — Now Assist already ships it, free, in
  every tier.
- Licensing default: ECharts (Apache-2.0). Confirm OEM licensing cost before using Highcharts for
  anything shipped in a distributable Store app.
- ServiceNow is pushing AI analytics systemwide (Now Assist bundled into every tier as of April
  2026; Otto; Pyramid-Analytics-fueled autonomous data analytics). Treat this as a closing window,
  not a settled one — re-check native capability against new release notes periodically, and don't
  build the pitch on a gap that's actively being narrowed.
- For commercial questions (pricing, margin, channel) — ask the client, don't theorize.
