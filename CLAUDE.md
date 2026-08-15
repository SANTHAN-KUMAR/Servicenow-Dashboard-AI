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

4. **The artifact is a dashboard *library*, not a dashboard.** Added 2026-08-01
   after comparing the POC against the client's own Dashboards experience. The
   entry point is a **catalog page** listing every dashboard/report the logged-in
   user is entitled to open — cards, search, group filter, Recent / Owned by Me /
   Shared with Me / All. Opening a card renders *that* dashboard at the full
   visual bar. Two surfaces, not one. **The catalog is permission-scoped**: a user
   must not see a card for data they cannot read, which makes entitlement
   correctness a catalog-membership concern as well as a cell-value one.

5. **Multi-level drilldown, at the level a custom analysis tool offers.** Added
   2026-08-03 after the client review. They want what Power BI gives them: click a
   value, keep going down through sub-layers, plus cross-filtering, a reversible
   and shareable drill path, and drill-through to the underlying records. This is a
   first-class requirement now, not a polish item. The terminal drill target is the
   **standard platform list view**, which is the one place being inside ServiceNow
   beats Power BI: the platform enforces row-level ACLs on that list, so we neither
   build a record grid nor have to get its security right.
   Full detail in `docs/use-case-2/10-client-review-and-revised-scope.md`.

6. **Different report types get different visual grammars.** The client's tool
   already does this — an approval-state breakdown draws part-to-whole, a ranked
   task list draws sorted bars, a trend draws a time series. A fixed chart set for
   every subject is the specific failure they identified in our build. Chart form
   follows the kind of question plus the measured shape of the data. Also: *give
   the user options to analyse rather than overwhelming them* — their words.

Full detail in `docs/use-case-2/07-scope-catalog-and-report-types.md`.

**What is NOT constrained:** the *build process*. Design tools, external LLMs, any charting
library, any AI model used during generation are all fair game — the constraint is only on the
**delivered runtime artifact**, which must be ServiceNow-native.

**The design is approved.** As of 2026-08-03 the client has seen
`design/command-brand-kit.html` and accepted it, in their words: ServiceNow could
never do this natively. So the visual bar is no longer a proposal to be argued for,
it is the agreed target to be reproduced inside the platform. The remaining job on
requirement 1 is fidelity, not persuasion. Published for client review at
https://santhan-kumar.github.io/command-analytics-design-system/

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
  ✅ **Resolved and superseded, 2026-08-15.** The 2026-08-11 correction that stood here was
  wrong, and it was wrong in the direction that matters: it concluded the differentiator could
  not be demonstrated live on this instance, and that conclusion came from a broken test rather
  than from the instance. Two things were measured incorrectly.

  **`gs.impersonate()` in a background script does not apply row-level ACLs.** Every persona
  test this engagement ran used it, so every one came back showing the persona reading every
  row, which read as "nothing is filtered here" instead of as "this test does not work". A
  role-less user appeared to read all 7,808 rows of `task`, a table with no read ACL that grants
  them anything. **`GlideImpersonate` does apply them** and is what persona tests must use.

  **`glide.sm.default_mode` is `deny` on dev390988**, so the wildcard `*` read ACL whose script
  is `gs.getProperty('glide.sm.default_mode') == 'allow'` grants nothing. `problem`, `task` and
  `kb_knowledge` carry no unconditional open read ACL and genuinely do filter. `incident` does
  carry one at the table level, and still filters at the row level through a separate ACL
  scripted as `answer = (current.category == "hardware")`.

  Measured live on 2026-08-15 against a role-less persona, with **no change to the instance's
  security configuration**:

  | table | GlideAggregate | readable | verdict |
  |---|---|---|---|
  | `incident` | 4,266 | **815** | FILTERED |
  | `task` | 7,808 | **815** | FILTERED |
  | `kb_knowledge` | 757 | **669** | FILTERED |
  | `problem` | 544 | **0** | DENIED |
  | `change_request` | 1,505 | **0** | DENIED |
  | `sys_user` | 665 | 665 | VERIFIED |

  This replaces the stale 67-vs-0 figure, is repeatable, and is the number to put in front of
  the client: **native reporting counts 4,266 incidents for this user and they can open 815, an
  overstatement of 3,451 records.** All three verdicts occur naturally, so FILTERED, BOUNDED and
  DENIED now have live coverage and not only offline assertions.

  The first live run also found that the product did not work for these viewers at all.
  `GlideRecord.canRead()` evaluates read ACLs with no record in context, so an ACL testing
  `current` fails it for someone who can still read a real subset. Three call sites treated it
  as authoritative: the dashboard answered "You do not have read access to this table" to a
  viewer holding 815 readable incidents, the catalog dropped their cards, and `aclVerdict`
  returned DENIED without ever running the proof — which is why those branches had no live
  coverage. Fixed in `bd07082`. **The standing lesson is the one this whole entry is about: an
  ACL claim tested only as admin is untested, and a persona test that finds nothing filtered
  should be assumed broken before the instance is.**

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

- **DRIFT: building one hard-coded dashboard page instead of a catalog.** This
  already happened once — the POC shipped a single page with six fixed charts over
  `incident`, which the client called *"a dumb stub with some random default
  graphs."* **Correction:** the entry point is the catalog (Section 1.4). A page
  that only ever shows one subject is a spike, not a deliverable.

- **DRIFT: drawing the same chart set regardless of subject.** **Correction:** the
  shape profiler (`profileField()` — distinct count, top share, concentration)
  already exists and is already computed. Use it to *choose the form*, not just to
  print a caption. See Section 1.5.

- **DRIFT: assuming the page can fetch its own data over XHR.** Measured on this
  instance: Scripted REST called from a logged-in browser session never returns,
  and the platform's own Table API behaves the same. **Correction:** compute
  server-side in `<g:evaluate>` and embed the payload; treat XHR as refresh-only.
  See `poc/servicenow/ui-page/probe-results.md`.

- **DRIFT: inlining client JavaScript into a UI Page.** Jelly evaluates `<script>`
  bodies; a CDATA-wrapped one makes the platform serve the **whole page as zero
  bytes**, HTTP 200, no error anywhere. **Correction:** client JS is always a UI
  Script loaded by `src`, with a content hash on the URL because `.jsdbx` is
  cached hard. `build_deploy.py` enforces this.

- **DRIFT: trusting an HTTP 200 from the Table API as proof a write landed.** It
  returns 200 whether or not it stored what you sent. Two rounds of this
  engagement were lost to reporting a fix as deployed while the instance still
  served the old record. **Correction:** read the record back and compare byte for
  byte. Never report something as fixed on the strength of a status code.

- **DRIFT: building drilldown off the dictionary's declared hierarchies without measuring
  whether they hold in the data.** `sys_dictionary.dependent_on` says someone *intended* a
  hierarchy, exactly as `sys_report.type` says someone *picked* a chart. Neither is a property
  of the rows. Measured on this instance **on 2026-08-03, before demo seeding**:
  `incident.subcategory` was set on **42 of 13,986 records**, so the declared
  category-to-subcategory drill was 99.7% empty, while `change_request` category-to-type was
  fully populated. ⚠️ **That row count is stale — do not quote it as current.** Demo seeding and
  reshaping since then has made `incident` 98.4% synthetic (4,266 rows total as of
  2026-08-10); no query against the live instance now returns 13,986. Re-measure before
  repeating either number, especially in front of the client. **Correction (still valid, the
  seeding date doesn't change it):** a drill level is offered only after passing fill-rate and
  cardinality gates *on the viewer's permitted rows*, and a rejected level shows its reason
  rather than a dead-end click. Same profiler, same discipline, one question further down. See
  section 2 of `10-client-review-and-revised-scope.md`, corrected 2026-08-10, and
  `13-adversarial-review-findings.md` §F7.

- **DRIFT: letting anything reach the runtime over a CDN.** External libraries and fonts are
  permitted in the *build*, and the client agreed to that, but a runtime request to an outside
  host sends every viewer's IP to a third party on every dashboard load. That is a
  data-protection exposure, not a licensing one, and it is the rule the whole engagement rests
  on: **code and fonts travel in, data does not travel out.** **Correction:** self-host and
  inline everything; the brand kit now makes zero external requests and the app must too.

- **DRIFT: reaching for a component without checking its licence against the allowlist.**
  Permitted: MIT, ISC, BSD-2/3, Apache-2.0, SIL OFL 1.1, CC0, Unlicense. Denied: GPL/LGPL/AGPL,
  SSPL, source-available, non-commercial, and anything commercial without a signed
  redistribution right on file. This was the client's **first and most emphatic** concern.
  **Correction:** it is a CI gate on the app repo plus a generated `THIRD-PARTY.md` register,
  not a habit of being careful.

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
- Typography is settled and verified: Space Grotesk, Inter Tight and JetBrains Mono, all SIL OFL
  1.1, **none declaring a Reserved Font Name**, which is what makes subsetting them while keeping
  the family name compliant. Licence texts are checked in at `design/LICENSES/` and must ship
  inside the scoped app, not be linked from it.
- **AI is optional, defaults to off, and never sees a record.** The client's priority order is
  explicit: get the approved design live first, AI is good-to-have. When it does ship it is a
  pluggable adapter over Now Assist or the client's own LLM tenant, and its input type carries no
  record payload by construction, only schema statistics and the aggregates already on screen.
  Direct outbound to a third-party API is not on the table for a good-to-have feature. MCP is a
  build-time tool on a dev instance and never part of the delivered artifact.
- **Performance is a named client concern with a budget**, not an implicit quality. First paint
  under 1.2s, interactive under 2.5s, initial payload at or under 250 KB gzipped, drill round trip
  under 400ms. The chart engine is the biggest lever: custom ECharts build, used chart types and
  one renderer only, measured rather than assumed.
- The phase 1 UXF spike is a **gate, not a de-risking exercise**. The measured XHR failure was on
  the UI Page surface with raw XHR; a UXF component fetches through the platform data broker,
  which is a different mechanism and untested here. Whether on-demand fetch works there decides
  whether drilldown is buildable as specified, so that answer is owed in week two.
- ServiceNow is pushing AI analytics systemwide (Now Assist bundled into every tier as of April
  2026; Otto; Pyramid-Analytics-fueled autonomous data analytics). Treat this as a closing window,
  not a settled one — re-check native capability against new release notes periodically, and don't
  build the pitch on a gap that's actively being narrowed.
- For commercial questions (pricing, margin, channel) — ask the client, don't theorize.
