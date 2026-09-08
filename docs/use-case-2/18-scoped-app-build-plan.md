# Build plan — COMMAND as a scoped application, end to end

Written 2026-09-07. Target: a scoped app on dev390988 that installs on the client's
instance, carries the approved design, drills dynamically everywhere, and renders one
CEO Dashboard portfolio in our theme.

Every platform constraint below was measured on dev390988 on 2026-09-07, not assumed.
Findings that drove the design are in `17-ceo-dashboard-instance-findings.md`.

---

## 0. The requirement conflict, resolved first

Two asks appear to collide:

- **Client:** "this is currently in raw script includes — make it a scoped application,
  just like we do for production."
- **Us:** "build the CEO work as a separate thing that does not disturb the existing
  product."

They are reconcilable. **One scoped app becomes the deliverable and contains the whole
product; the CEO adapter is a separate module inside it; the existing global records
stay deployed and untouched as a working fallback until the scoped build is proven.**

So nothing is migrated in place and nothing is duplicated in spirit — the same source
files gain a second deployment target. The global copy is deleted only after the
scoped app passes the same audits.

| | global (today) | scoped app (deliverable) |
|---|---|---|
| 8 Script Includes | stay, untouched | same source, `sys_scope` = app |
| 2 UI Pages, 3 UI Scripts | stay, untouched | same source, scoped |
| CEO adapter | — | **new, scoped only** |
| persona/ACL test harness | global background script | **stays global — see §1.3** |

---

## 1. Measured constraints that shape the build

### 1.1 What still works inside a scope (all verified)

`GlideRecord`, `GlideRecordSecure`, `GlideAggregate` (incl. `addAggregate`, `groupBy`,
`orderByAggregate`, single-arg `getAggregate`), `GlideDateTime` (incl. `subtract`,
`getDisplayValue`), `gs.getUserName` / `getUserID` / `getUserDisplayName`,
`gs.getProperty`, `getED().getInternalType()`, `getElements()`, `getLabel()`,
`getRowCount()`, and encoded queries containing `javascript:` calls.

Cross-scope reads to `incident`, `problem`, `task`, `change_request`, `kb_knowledge`,
`sys_user`, `sys_db_object`, `sys_dictionary`, `pa_indicators`, `pa_cubes` all succeed
— every one has `read_access = true`.

The product's entire server API surface is just those calls, so **the runtime moves
into a scope without a rewrite.**

### 1.2 What breaks inside a scope

| broken | impact | fix |
|---|---|---|
| **`gs.print` is fenced** — "Function print is not allowed in scope" | `snclient.run_script` / `run_json` scrape `gs.print` output; every build-time probe stops working | add `gs.info` output mode to `snclient`, keep `gs.print` for global |
| **`GlideImpersonate` is fenced** — "not allowed in scoped applications" | this is our ACL-proof mechanism | see §1.3 — it does not affect the runtime |
| two-arg `getAggregate('COUNT','field')` returns null | silent wrong numbers if used | use the single-arg form only; add a lint rule |

### 1.3 The ACL proof is unaffected, and here is why

`GlideImpersonate` is blocked in scope, but **the shipped product contains no
impersonation at all** — it appears only in `product/deploy/f2_persona_test.py`, a
build-time Python harness. At runtime the page already runs *as the viewer*, and
correctness comes from `GlideRecordSecure`, which works in scope.

So the persona harness stays a global-scope build tool, consistent with the standing
rule that build-time tooling is never part of the delivered artifact. **No
differentiator is lost.** This must be stated in the handover docs, because "you
scoped it and the ACL proof stopped working" is the obvious client question.

### 1.4 The one unknown left — a real gate

**No UI Page exists in any `x_` scope on this PDI**, so two things are untested:

1. Does a scoped UI Page keep the name `cmd_dashboard` (URL `cmd_dashboard.do`), or
   does the platform force a scope prefix and change the demo URL?
2. Does `<g:evaluate>` inside a scoped UI Page execute *in that scope*, so it can call
   `new CmdPayload()` directly rather than `x_2185255_command.CmdPayload`?

Both are answered by one 30-minute spike (§2.1). **Nothing else in the plan is
sequenced ahead of it**, because a forced URL change affects the client's demo links
and a cross-scope Jelly evaluation affects every server call the pages make.

---

## 2. Phases

### Phase 0 — spikes and gates (½ day)

| # | gate | pass condition |
|---|---|---|
| 0.1 | scoped UI Page naming + `g:evaluate` scope | page renders, name and URL known, `new CmdPayload()` resolves |
| 0.2 | `snclient` scoped output mode | `run_json` works against a scoped background script |
| 0.3 | scoped app skeleton installs | `sys_app` `x_2185255_command` exists, artifacts land in it |

If 0.1 forces a prefixed URL, decide then whether to keep a thin global UI Page that
redirects, so the client's existing links survive.

### Phase 1 — scoped app foundation (2 days)

- Create `sys_app`: scope `x_2185255_command`, name **COMMAND Analytics**, v0.1.0.
- Extend `product/deploy/deploy.py` with `--scope`: stamp `sys_scope` on every record,
  keep readback verification, keep Jelly/ES5/inline-script validation unchanged.
- Deploy all 8 Script Includes, 2 UI Pages, 3 UI Scripts into the scope.
- Re-run the existing audits (`product/tests/run_all.sh`, `audit_numbers.py`,
  `audit_integrity.py`, `smoke_live.py`) against the scoped deployment.
- **Exit criterion:** scoped catalog and dashboard render byte-identically to global,
  and every audit that passes on global passes on scoped.

### Phase 2 — dynamic drilldown (3 days) — *client requirement #2*

The machinery already exists and is more capable than the review suggested:
`drillUrl()` builds a reversible, shareable multi-level `path=field:key|field:key`;
the server side (`CmdDrill.sanitizePath`, `stepQuery`, `gate`, `listUrl`) is mature;
and the "Where you can go next" panel is already computed from live fill-rate and
cardinality gates, not hardcoded.

Three concrete changes:

1. **One click drills.** Today a click cross-highlights and offers a *"Filter the whole
   page"* button ([cmd_render.js:2790](../../product/ui-scripts/cmd_render.js#L2790)).
   The client clicked a treemap box, saw a highlight, and read it as "no drilldown".
   Make a plain click navigate to `drillUrl` immediately; keep cross-highlight on hover.
2. **Cover the remaining 10 renderers.** `drillable()` is wired into 15 of 25. Missing:
   `drawHeatmap`, `drawMatrix` (two keys → compound filter), `drawHistogram` /
   `drawHistogramBins` (bin → `BETWEEN` range), `drawLine` (point → date window),
   `drawCalendar` (day → date), `drawScatter` (point → record), and
   `drawGauge` / `drawKpi` / `drawStatTile` (single value → that metric's own records).
3. **Honest empty states.** `emptyChart()` already covers per-panel emptiness; add a
   page-level "No data available for this selection" when a drill step yields zero
   rows, with a one-click step back out.

**Tests:** extend `test_drill_security.js` (path tampering, `^OR` trust transfer,
depth limit) and `test_render_edges.js` (each newly drillable renderer emits a valid
`data-drill-field`/`data-drill-key`, and a zero-row slice renders the empty state
rather than a blank box).

### Phase 3 — CEO Portfolio1 conversion (4 days) — *client requirement #3*

**Fixture first.** Control Tower is not on the PDI and does not need to be: 24 of 27
CEO indicators and 14 of 14 formula components already exist there with identical
sys_ids. Recreate only the 72-row config table as
`x_2185255_command_report_source` (columns: `business_function`, `metric_type`,
`pa_indicator`, `breakdown`), seeded from a read-only export of the client's rows.
**Portfolio1 uses only incident indicators, all present on the PDI.**

**New module `CmdCeo` (scoped only), four responsibilities:**

1. `sources(configTable, portfolio)` — read the config table. **The table name is a
   parameter**, so pointing at `sn_controltower_ceo_dashboard` on the client instance
   is configuration, not a code change.
2. `resolve(indicatorId)` → a node:
   - **leaf**: `pa_indicators.cube` → `pa_cubes.facts_table` + `conditions`, appended
     with `pa_indicators.conditions`; `aggregate` + `field`.
     Aggregate codes are **`1=Count 2=Sum 3=Average 4=Minimum 5=Maximum
     6=Distinct Count`** — read them from `sys_choice`, never hardcode.
   - **scripted** (6 of 26): all are age/duration expressions of the form
     `(score_end - <dateField>)` in hours. Recognise the shape, emit
     `{kind:'age', dateField}`. Anything unrecognised is refused loudly, never guessed.
   - **formula** (9 of 27): parse `[[sys_id]]` refs and arithmetic.
3. `evaluate(node)` — compute ACL-correct through the existing `CmdData` /
   `aclVerdict` path, so every card inherits FILTERED / BOUNDED / DENIED.
4. `toPanels(portfolio)` — hand our existing chart chooser a normal subject payload, so
   Portfolio1 renders through the *same* renderer as everything else. No CEO-specific
   drawing code.

**The formula evaluator, and how it gets tested rigorously.**
A recursive-descent parser over `+ - * / ( )`, numeric literals and `[[sys_id]]` refs.
**No `eval()`.** Required behaviours: operator precedence, parentheses, division by
zero → "not computable" (never `NaN`/`Infinity` on screen), missing indicator →
refusal with the id named, cycle detection, depth cap.

Two test layers:

- **Unit** (offline, existing JS harness): precedence, parens, div-by-zero, unknown
  ref, cycle, depth, whitespace, nested formulas.
- **Oracle** (read-only against the client instance): for each of the **21 CEO slots
  that currently show a real value**, compute ours and compare within tolerance. This
  is a genuine regression suite because PA's own numbers are the expected values.

Three oracle cases already pass by hand:

| slot | ours | PA | delta |
|---|---|---|---|
| Anchor1 open incidents | 14,013 | "14k" | — |
| Risk1 % open not updated 30d *(formula)* | 95.69 | 95.74 | 0.05 |
| Speed1 average age open *(scripted → formula)* | 545.1 d | 545 | 0.1 |

**Trends are real, not synthetic.** `pa_scores` is empty, so the client's own
sparklines are decorative — the same shape on every card. We do not need PA history
and we do not need fabricated data: the 14,013 open incidents span 2016-08 to 2026-09
across 37 months, so a true time series is computable from `opened_at` on the client's
own instance. Our engine already draws time series this way.

**Reconciliation is a feature, not an apology.** PA scores bypass row-level ACLs; our
numbers are ACL-correct, so for any non-admin viewer they will differ. Each card shows
our value, and on request the PA value beside it with the reason for the gap. Without
this the client reads a correct number as a bug.

### Phase 4 — packaging and handover (2 days) — *client requirement #1*

- **Update Set XML** for transfer to the client instance, plus install notes. Verify by
  installing into a clean scope on the PDI, not by trusting the export.
- **Code-trace documentation** — the client's actual first ask: for each visible
  behaviour (skeleton loading state, fonts, each chart type, theme, drilldown, export),
  the file and function that produces it, and how deployment works. Structure:
  *screenshot → file:line → what runs on the server → what runs in the browser.*
  Must answer the three questions raised in the review verbatim:
  - "which line of code draws this?" → a behaviour-to-`file:line` index
  - "how does code reach the instance?" → `deploy.py`: validate → content-hash →
    upsert → **read back and compare**, never trusting HTTP 200
  - "why is there no CSS record?" → `cmd.css` is substituted into the `@@CSS@@`
    placeholder in both UI Pages at deploy time
    ([deploy.py:208](../../product/deploy/deploy.py#L208)), so it ships inlined with
    zero extra requests; UI Scripts deploy under content-hashed names
    (`cmd_render_<hash>`) because `.jsdbx` is cached hard.
- **`THIRD-PARTY.md`** register + licence CI gate (allowlist: MIT, ISC, BSD-2/3,
  Apache-2.0, SIL OFL 1.1, CC0, Unlicense). Fonts are OFL 1.1 with no Reserved Font
  Name and ship inside the app.
- **Performance measurement** against the stated budget: first paint < 1.2s,
  interactive < 2.5s, payload ≤ 250 KB gzipped, drill round trip < 400ms. Measured,
  not asserted.
- **Persona/ACL results** re-run against the scoped build (harness stays global).

---

## 3. Risks, with the honest status of each

| risk | status | mitigation |
|---|---|---|
| Scoped UI Page URL changes | **open — Phase 0 gate** | thin global redirect page if forced |
| `g:evaluate` scope resolution | **open — Phase 0 gate** | qualify calls as `x_2185255_command.CmdPayload` |
| ACL-correct counting is slow at 14k rows × 9 cards | known, previously hit | reuse the existing bounding work from `perf(catalog)`; measure before optimising |
| Scripted indicators beyond the age/duration shape | bounded — 6 of 26, all one shape | refuse loudly and name the indicator; never guess a semantic |
| Client instance drift between now and demo | live | oracle suite is read-only and re-runnable; re-run the morning of the demo |
| Formula division by zero on empty slices | expected — 51 of 72 slots are empty | "not computable" state, designed rather than defaulted |

## 4. Sequencing and estimate

```
Phase 0  gates            0.5d   ← blocks everything
Phase 1  scoped app       2d
Phase 2  drilldown        3d     ← can run parallel to Phase 1 after 0.1
Phase 3  CEO Portfolio1   4d
Phase 4  packaging/docs   2d
                         ─────
                         ~11.5d
```

Phase 2 is deliberately ahead of Phase 3: it is the requirement the client raised most
sharply, it improves every surface including the converted CEO page, and it does not
depend on the CEO adapter existing.

## 5. Scope discipline

Out of scope, recorded so it is a decision and not a drift: converting more than one
portfolio (the client said "just one", emphatically), a universal any-dashboard
converter (stated as the eventual goal, explicitly not a blocker now), writing anything
to the client instance, and AI features (optional, defaults to off, and the approved
design ships first).

---

# Phase 0 and Phase 1 — results, measured 2026-09-07/08

## Gate 0.1 — PASSED, with one consequence

A scoped UI Page works, and `g:evaluate` inside one works. Proven on dev390988:

```
A=LITERAL-OK | B=USER-admin | C=AGG-4266
D=UNQUAL-scoped-ok count=4266 | E=QUAL-scoped-ok count=4266
```

**Unqualified `new CmdPayload()` resolves inside the scope**, so the pages call
their Script Includes unchanged — no `x_2185255_command.` prefixing anywhere.

**The consequence: the URL changes.** `<name>.do` resolves global pages only and
answers HTTP 200 with "Page not found" for a scoped one. The platform serves a
scoped page at `<scope>_<name>.do` and records that in the page's `endpoint`
field, which the deploy now reads back rather than assembling by hand:

- `https://dev390988.service-now.com/x_2185255_command_cmd_catalog.do`
- `https://dev390988.service-now.com/x_2185255_command_cmd_dashboard.do`

## Five platform constraints found by measurement

| constraint | evidence | resolution |
|---|---|---|
| `gs.print` fenced in scope | "Function print is not allowed in scope" | `gs.info` everywhere, works in both |
| `new JSON().encode()` absent under `es_latest` | "NativeJSON@… is not a function" | `JSON.stringify`, works in both |
| `GlideStringUtil.base64Encode` absent in scope; `gs.base64Encode` absent in global | measured both ways | feature-detect in both pages |
| `GlideAggregate.getElement()` fenced in scope | "Function getElement is not allowed in scope" | booleans routed to explicit exact counts |
| a Table API write ignores `sys_scope` in the payload | insert carrying `sys_scope=<app>` created `global.CmdProbe` | `use_scope()` switches the session first |

### The boolean one is the one that nearly shipped a regression

`ga.getElement(field).getValue()` was the only accessor that told a genuinely NULL
boolean from a `'0'` one, and it is fenced in a scope. Replacing it with
`ga.getValue()` would have silently reintroduced a fixed bug. Booleans now get
three exact counts (`addNullQuery`, `=false`, `=true`), which is correct in both
engines and verified against the same rows the original fix used:

| | global, old `getElement` | new explicit counts |
|---|---|---|
| `asmt_metric_result.is_default` NULL | 294 | **294** |
| `asmt_metric_result.is_default` false | 1,034 | **1,034** |

### Scope switching is done through the platform's own API

Writing the `apps.current_app` preference works only for sessions created after it
lands, and the gap is real: a global deploy immediately after a scoped one failed
with "ACL Exception Update Failed due to security constraints" on a global record —
a still-scoped session writing outside its scope, indistinguishable from a
permissions fault. `use_scope()` now PUTs to
`/api/now/ui/concoursepicker/application`, reads the session's application back,
and refuses to continue unless it matches. Rapid scoped → global → scoped
alternation verified clean.

## Phase 1 — deployed and rendering

Both targets carry the same source. Global is untouched as the fallback and was
re-verified after the shared-code changes.

| | global | scoped |
|---|---|---|
| Script Includes | 8, all compile | 8, all compile |
| catalog | 5 areas / 12 cards | 5 areas / 12 cards |
| dashboard `change_request` | 1,505 rows / 11 panels | 1,505 rows / 11 panels |
| dashboard `incident` | 4,266 rows / **11 panels** | 4,266 rows / **9 panels** |

## The one open divergence: the scan allowance, not correctness

`incident` draws 11 panels in global and 9 in the scope, consistently across three
runs each. It is not a fenced API and not variance. The scoped build reports:

> "This subject is expensive to permission-check, so the page stopped reading rows
> after 5s. 1 further measurement was not attempted."

Secure iteration is measurably slower inside a scope:

| operation | global | scoped | delta |
|---|---|---|---|
| `GlideAggregate` count | 4 ms | 4 ms | — |
| secure scan, 4,266 rows | 994 ms | 1,116 ms | +12% |
| secure grouped scan | 1,224 ms | 1,483 ms | +21% |
| `aclVerdict('incident')` | 1,189 ms | 1,329 ms | +12% |

`CmdData.SCAN_ALLOWANCE_MS` is 5,000 ms per request, and the overhead is enough to
cross it. The panels lost are the rich ones — `line_multi`, `waterfall`, `scatter`,
`box`, `small_multiples` — replaced by cheaper `histogram`, `heatmap`,
`calendar_heatmap`. For a product whose deliverable is visual richness that is a
real regression, not a cosmetic one.

**The underlying cause is a duplicated scan, and it is present in global too.** The
ACL verdict proves `aggregate == secure` by iterating all 4,266 rows (1.2 s), and
the shared reduction pass then iterates *the same rows again* for the values that
quantiles, bins and correlations need. Two full secure passes over one row set in
one request. Merging them would save roughly a second on every page in both
deployments and would put the scope back inside the allowance.

Raising `SCAN_ALLOWANCE_MS` would hide this rather than fix it, and the page is
already slower than its stated budget: a full server round trip measures **8–10 s**
against a first-paint target of 1.2 s and interactive of 2.5 s. That gap is now a
measured number rather than an estimate, and it is the next thing worth attention.

---

# Delivered — 2026-09-08

All four phases are done. The deliverable is
`product/dist/COMMAND-Analytics-0.1.0-update-set.xml`, installed on the target
through **Retrieved Update Sets → Import Update Set from XML → Preview → Commit**.

| phase | state |
|---|---|
| 0 · gates | passed. The one consequence is the URL: `x_2185255_command_cmd_dashboard.do` |
| 1 · scoped application | 9 Script Includes, 2 UI Pages, 3 assets, all readback-verified and compiling in scope |
| 2 · dynamic drilldown | a click filters; 22 of 25 renderers drillable; empty slices say so |
| 3 · CEO Portfolio 1 | 8 cards, real monthly trends, refusals where PA prints a zero |
| 4 · packaging and docs | reproducible update set, code traces, licence register |

**End-to-end on the scoped build, all passing:** catalog renders; it offers
exactly one portfolio; the incident dashboard draws its panels; Portfolio 1 draws
8 cards with real trends; a category drill returns 816 rows; a month drill returns
624 and is labelled "Jun 2026"; an out-of-range drill returns nothing and says so.

**534 offline tests pass**, and `oracle_ceo.py` reports 11 resolution matches and 0
mismatches against Performance Analytics' own answers.

## What is not done, stated plainly

**Page time misses its budget and is the top of the next list.** 4.9–9.5 s of
server work against a 2.5 s interactive target. Payload passes at ~107 KB gzipped
against 250 KB. The cause is measured and the two duplications behind it are
named in `19-how-it-works-code-traces.md` §6: the ACL proof scans every row to
count them and the first reduction scans the same rows again to read them, and the
page opens separate reduction passes over one row set. Either is worth more than
the allowance raise that currently absorbs the difference.

**Two CEO cards carry no trend.** Both rest on elapsed-time measures, which would
need a scan per period. The other six carry a real one.

**The global deployment is still live** and should stay until the scoped build has
run in front of the client. It is the fallback, and it is byte-identical in source.

**The PDI's Portfolio 1 is thinner than the client's will be.** Several of its
measures are defined for a single day and dev390988 has little activity today —
which is also true of the client's own page, where the same cards read 0. The
difference is that ours says why.

## The four platform findings worth carrying forward

Each cost real time and each is invisible until it bites:

1. A Table API write lands in the **session's** current application, not the one
   named in `sys_scope`.
2. A scoped UI Page is served at `<scope>_<name>.do`; `<name>.do` answers 200 with
   "Page not found".
3. A UI Script's `name` is the **API Name** — `<scope>.<script_name>` — it is
   capped at 40 characters, and the platform truncates instead of refusing.
4. `GlideRecord.getValue()` on a boolean returns `'1'`/`'0'`, never `'true'`.

The first three all produce a page that answers HTTP 200 with nothing on it. The
deploy now checks for all of them, and the check that generalises is
`verify_assets_served`: a readback proves storage and has never proved routing.
