# Adversarial review: nine findings, two confirmed live

Reviewed against `product/` at commit `a4f605f`, 2026-08-10. This is a skeptical read of the
COMMAND dashboard codebase plus live verification against dev390988, done by someone other than
the person who built it, on the client's request for a side-by-side comparison with stock
ServiceNow reporting and a red-team pass on the codebase. Read-only throughout: no record, ACL,
script include or page was modified on the instance, and nothing in this repository was written
to during the review itself.

An interactive version of this report, with the live-injection proof rendered as a runnable trace
and a side-by-side comparison table, was published as a Claude Artifact during the review. This
document is the durable, checked-in record of the same findings.

**Scoreboard.** 2 high, 5 medium, 2 informational. 226 offline tests re-run, all passing. Two
findings confirmed against live data on dev390988 mid-review (F1, F7); two more need a
non-admin persona and current subcategory fill that this session did not obtain (see §5).

---

## 0. Status addendum, 2026-08-15

This review was written against commit `a4f605f`. Five days of work later, this is
what is closed and what is not. The addendum sits at the top rather than the bottom
because the review's own headline finding turned out to understate the problem.

| | Finding | Status |
|---|---|---|
| F1 | Drill URL turns the permission proof off | **Closed** in `ab760f9` |
| F2 | Nothing is ever tested as a non-admin | **Closed** in `bd07082`, and it was worse than reported |
| F3 | Catalog contradicts its own guarantee | **Closed** |
| F4 | ACL-unsafe count decides panel offers | **Closed** |
| F5 | Scatter panel is 87% of the payload | **Open**, unchanged |
| F6 | Deploy deletes live assets too early | **Closed** |
| F7 | Drill evidence cannot be reproduced | **Closed** by re-measurement, and the example is now false |
| F8 | Base64 costs 1.5× in gzip | Open, informational |
| F9 | Built is not the documented architecture | **Open**, unchanged |

### F2 was right, and the reason it stayed open was itself a bug

The review said the FILTERED, BOUNDED and DENIED branches had never executed
against a genuinely filtered viewer. Correct. Two follow-up attempts concluded the
instance had no restricted viewer available to test with, and recorded in CLAUDE.md
that all relevant tables carried an open `*` read ACL. **That conclusion was wrong
and came from a broken test.**

`gs.impersonate()` in a background script does not apply row-level ACLs. Every
persona test used it, so every one reported the persona reading every row — which
reads as "nothing is filtered here" rather than "this test does not work". A
role-less user appeared to read all 7,808 rows of `task`, a table whose read ACLs
grant them nothing. `GlideImpersonate` does apply them. Separately,
`glide.sm.default_mode` is `deny` here, so the wildcard ACL that looked open grants
nothing.

With both corrected, and with **no change to the instance's security config**:

| table | GlideAggregate | readable | verdict |
|---|---|---|---|
| `incident` | 4,266 | 815 | FILTERED |
| `task` | 7,808 | 815 | FILTERED |
| `kb_knowledge` | 757 | 669 | FILTERED |
| `problem` | 544 | 0 | DENIED |
| `change_request` | 1,505 | 0 | DENIED |
| `sys_user` | 665 | 665 | VERIFIED |

The first live run then found the product did not work for those viewers at all.
`GlideRecord.canRead()` evaluates read ACLs with no record in context, so an ACL
testing `current` fails it for a viewer who can read a real subset. `incident`
carries `answer = (current.category == "hardware")`, exactly that shape. Three call
sites treated `canRead()` as authoritative: the dashboard answered "You do not have
read access to this table" to a viewer holding 815 readable incidents, the catalog
dropped their cards, and `aclVerdict` returned DENIED without running the proof.

So the review's finding was not "an untested path"; it was "an untested path that
did not work". That is the strongest available argument for its own recommendation.

### F5 and F9 are unchanged and remain the two largest open items

F5: still no canvas fallback, no `content-visibility`, no `IntersectionObserver`,
no server-side binning, and `PAIR_CAP` is still 4000.

F9: still Script Includes and UI Pages in the global scope, still no scoped
application, no roles, no navigation entry and no Store route. The UXF spike is
still unrun, and it now gates the performance answer as well as drilldown.

### Performance, re-measured

Section 4 of this review recorded a catalog at 12.2s and a dashboard at 9.7s. After
three fixes — a memo guard that never hit because an empty array is falsy in this
script engine, a box-plot builder rescanning the table once per ordinal dimension,
and a trusted table planning group-by accumulators onto a row scan an index could
answer — measured today:

| Surface | Review | Now |
|---|---|---|
| Catalog | 12.2s | ~4.6s |
| `sys_user` | not recorded | 1.0s |
| `problem` | not recorded | 1.7s |
| `change_request` | not recorded | 3.7s |
| `incident` | 9.7s | 6.0s |

The budget is still missed on large subjects, and the reason is structural rather
than a remaining optimisation. See `14-client-questions-answered.md` §5.

---

## 1. Findings, worst first

### F1 — A drill URL can turn the permission proof off (High, confirmed live)

**Where.** `cmd_dashboard.xhtml:39–54` parses the `path` query parameter with
`decodeURIComponent` and no validation. `CmdDrill.stepQuery` (`CmdDrill.js:199`) concatenates it
straight into an encoded query: `field + '=' + key`. Separately, `CmdData._trustedFor`
(`CmdData.js:1066`) decides whether to open an ACL-enforcing cursor by testing whether the current
query *starts with* an already-proven query followed by `^`.

That prefix test is sound for `^` used as AND — a narrower query is always a subset of a proven
wider one — and unsound for `^OR` and `^NQ`, which widen a query instead of narrowing it.

**Proof, code level.** `CmdDrill.stepQuery`, `CmdData._trustedFor` and the `cmd_dashboard.xhtml`
path parser were copied verbatim into a standalone script and run against a proven base query:

```
proven-safe base query: opened_at>=2025-08-10 00:00:00

1. category:software                        (normal drill, AND)
   -> opened_at>=...^category=software
   -> subset of the proven query -- sound

2. category:software^ORsys_idISNOTEMPTY     (injected OR)
   -> opened_at>=...^category=software^ORsys_idISNOTEMPTY
   -> accepted as trusted -> new GlideRecord() -> ACLs NOT enforced

3. category:software^NQsys_idISNOTEMPTY     (injected NQ, matches the whole table)
   -> opened_at>=...^category=software^NQsys_idISNOTEMPTY
   -> accepted as trusted -> new GlideRecord() -> ACLs NOT enforced
```

**Proof, live on dev390988, same day.** The identical payload fired at the real page, admin
session, table `incident`:

```
legitimate drill  category:software
  -> query  category=software
  -> 1,112 rows, acl.mode=VERIFIED        (a genuine subset -- correct)

injected drill    category:software%5EORsys_idISNOTEMPTY
  -> query  category=software^ORsys_idISNOTEMPTY
  -> 4,266 rows, acl.mode=VERIFIED        (== the WHOLE incident table)
  -> listUrl carries the injected clause verbatim:
     /incident_list.do?sysparm_query=category%3Dsoftware%5EORsys_idISNOTEMPTY
```

A URL that reads as "drill into Software" silently returns the entire table, still labelled
`VERIFIED`, and hands the same widened query to the terminal record-list link.

**Honest bound on severity.** This live run was as `admin`, where `aggregate == secure` by
construction, so no row was actually hidden from this session — the visible symptom here is query
injection breaking the drill scope, not a demonstrated ACL leak on this account. The ACL leak is
the code-level consequence for a viewer whose base verdict is trusted on a narrow slice but not
the whole table: the injected clause pulls in exactly the rows the proof never covered, and
`reduce()` opens an unchecked cursor over them. No seeded non-admin persona exists to run that
case against (see F2), which is also why this shipped unnoticed.

Independent of ACLs, arbitrary encoded-query injection through a URL parameter is a defect on its
own terms — the same input reaches `listUrl()` and the drill-through, so a crafted link can also
be used to construct an arbitrary query against the table, not just widen the current one.

**Fix.** Two independent, cheap changes. Validate `field` against `CmdMeta.dimensions()` and
reject any `key` containing `^`. Separately, make `_trustedFor` compare parsed clause sets rather
than string prefixes, or simply refuse to transfer trust to any query containing `^OR` or `^NQ`.

---

### F2 — Nothing is ever tested as a non-admin (High)

A search across the entire test and deploy tree for `impersonate`, `setUser`, `persona`, `role`,
`itil` and `GlideImpersonation` returns zero hits. All 226 offline tests and the live smoke test
(`smoke_live.py`) run under the admin credential.

**What the product claims.** CLAUDE.md names provable, persona-specific ACL correctness on
aggregate bindings as the engagement's *lead* differentiator — "the only one that got stronger
under red-teaming."

**What is actually tested.** Only the path where `fast === secure` by construction. The FILTERED,
BOUNDED and DENIED branches of `CmdData.aclVerdict` — the entire reason the tiered strategy
exists — have no test that ever executes them against a genuinely filtered viewer.

This is not hypothetical. `CmdData.js:1691` documents that the trend panel previously shipped
drawing ACL-unsafe counts under a "filtered" badge, and diagnoses why it survived review:
*"It went unnoticed because every test ran as admin, where the fast and secure counts agree by
construction."* That diagnosis was correct, and the condition it describes is still fully in
place. F1 is a second bug from the identical blind spot, found the same way — by reading the code,
not by testing it.

**Fix.** One seeded role-restricted user, one ACL that filters `incident` by assignment group, and
one test asserting the resulting mode is FILTERED and the headline count matches
`GlideRecordSecure`. That single test would have caught the historical trend bug, F1, and F3/F4
below.

---

### F3 — The catalog contradicts its own guarantee, on screen (Medium)

`CmdCatalog.js:135` states, verbatim: *"Every number here is ACL-checked; nothing is a
GlideAggregate total."* One hundred lines later, `CmdCatalog.js:238` computes report counts with
`this.data.fastGroupBy('sys_report', 'table', …)` — `GlideAggregate`, unchecked — and that number
is rendered on every catalog card (`cmd_render.js:2948`).

Card *membership* is correctly gated: `canRead` then a bounded, secure `hasAtLeast()` decide
whether a table appears at all, so no card surfaces for a table the viewer cannot read (the
requirement CLAUDE.md §1.4 sets). But the "N reports" figure printed on an admitted card is not
ACL-checked, and `sys_report` carries genuinely private, owner-scoped rows. The same unchecked
number also ranks the candidate list, so it decides which subjects survive the 40-card cap.

**Fix.** Either count reports through `GlideRecordSecure` (bounded, the same way the row counts
beside it already are), or drop the number from the card and keep it purely as an internal ranking
signal. Then correct the docstring — an invariant contradicted in the same file it's declared in
is worse than no stated invariant.

---

### F4 — An ACL-unsafe count decides which panels a viewer is offered (Medium)

`CmdData.dateSpread` (`CmdData.js:1766`) takes real care over `min`/`max`, using
`GlideRecordSecure` with the comment *"Secure rather than raw, because this decides what the
viewer is shown."* Three lines later: `out.nonEmpty = this.fastCount(table, q)` —
`GlideAggregate`, unchecked.

`nonEmpty` is never rendered directly, so this is not a wrong number on screen — it is used as a
*gate*. `CmdPayload.js:857` and `CmdAnalysis.js:1256` both use it to decide whether a date field is
worth a trend panel at all. That directly contradicts the rule the engagement wrote for itself in
`10-client-review-and-revised-scope.md` §2.3 — *"the gates run against the viewer's own permitted
rows"* — and means a restricted viewer can be offered a trend built on a field that is populated
only in rows they cannot read.

**Fix.** Route it through `total()`, which already resolves to the correct cursor from the
request's single ACL verdict, exactly as `CmdDrill.gate` already does for its own gates.

---

### F5 — One scatter panel is 87% of the payload and 3,198 SVG circles (Medium)

Rendering every checked-in fixture through the real renderer (`cmd_render.js`) under an
instrumented Node.js DOM shim, best of five runs each:

| Payload | DOM nodes | SVG marks | Heaviest tag | Render (shim only) |
|---|---:|---:|---|---:|
| `incident` | 4,038 | 3,685 | `circle` = 3,322 | 8.3 ms |
| `task` | 1,148 | 845 | `rect` = 659 | 5.8 ms |
| `cmdb_ci` | 1,099 | 808 | `rect` = 684 | 3.9 ms |
| `sys_user` | 982 | 642 | `rect` = 487 | 4.3 ms |
| `change_request` | 906 | 525 | `circle` = 113 | 3.0 ms |
| `catalog` | 382 | 0 | `div` = 222 | 0.4 ms |

The shim measures JavaScript execution only — no style, layout or paint cost, which a real browser
pays on top of every number above.

Breaking the `incident` payload down by panel: the scatter panel alone is 146,364 of 167,970 bytes
of that payload — **87.1%** — carrying 3,198 points. The other ten panels together are under
14 KB. `CmdData.PAIR_CAP` is 4,000, so this is not even the worst case the code permits.

Two performance mechanisms the project documents as already in place do not exist in the codebase
at all:

| Stated (CLAUDE.md §8, doc 10 §5) | Measured in `cmd_render.js` |
|---|---|
| "Canvas renderer above roughly 1,000 marks, SVG below" | `canvas` / `getContext`: **0 occurrences** |
| "Charts initialise progressively, below-fold panels deferred"; `content-visibility:auto` | `content-visibility`, `IntersectionObserver`, `requestIdleCallback`, `requestAnimationFrame`: **0 occurrences** |

Every panel renders synchronously as SVG on load. 3,322 circles is 3.3× the threshold at which the
project's own stated budget says to switch renderer, and there is currently no renderer to switch
to. This is also the panel most likely to be hovered, and hover on a several-thousand-node SVG
subtree is where the 60 fps interaction gate is most likely to fail.

**Fix, in order of value.** Bin or sample the scatter server-side — roughly 800 points is already
more marks than a ~520px-wide plot can visually separate, so this removes ~85% of the payload at
no real visual cost. Then add `content-visibility:auto` to below-fold panels, a one-line change.
Canvas is a genuine build and should wait until the first two are measured and found insufficient.

---

### F6 — Deploy deletes live assets before it replaces the pages that reference them (Medium)

`deploy.py` writes the new content-hashed UI Scripts, calls `prune_assets()` at line 281 to delete
superseded ones, and only afterward rewrites the UI Pages at lines 286–293. Between those two
steps, the page currently live on the instance still references the *old* asset name — which has
just been deleted.

The failure mode is a page that serves HTTP 200 with no client JavaScript at all: a blank
dashboard, nothing in any log. That is precisely the class of failure this project has already
lost engagement rounds to, and which the header comment in `cmd_dashboard.xhtml` exists to
prevent. On a healthy instance the window is a few seconds; on an instance behaving the way
dev390988 did for part of this review — a page write hanging 90 seconds — the dashboard would be
broken for the full 90 seconds.

**Fix.** Move the `prune_assets()` call after the page-write loop. One line, and the window closes
completely.

---

### F7 — The headline evidence for the drill design cannot be reproduced on the instance it cites (Medium, confirmed live)

`10-client-review-and-revised-scope.md` §2.2 builds the entire drill-gating design on one
measurement, stated in §9 as queried live from dev390988 on 2026-08-03: *subcategory is set on
42 of 13,986 incidents, empty on 99.70%*.

**What the repo's own code already implied.** `seed.py:8` — *"dev390988 carries 67 incidents"*.
`seed.py:46` — `TARGETS = {"incident": 4200, "change_request": 1400, "problem": 520}`. Comments in
`CmdData.js` cite a live run returning 4,266 records. None of these correspond to 13,986.

**Confirmed live on dev390988, same session.** `/cmd_dashboard.do?table=incident&months=12`
returns `subject.rows = 4266`, `acl.mode = VERIFIED`. This matches `seed.py`'s target of 4,200
almost exactly, as expected, and matches the figure `CmdData.js`'s own comments cite. The number
13,986 does not correspond to any state of this instance, before or after seeding.

Worse for a live demo: the seeding commit landed the *same day* as that document (`6424912`,
after `831f5e4`) and sets `subcategory` on roughly 70% of seeded incidents (`seed.py:174`). So on
the instance as it stands today, the drill gate is expected to *offer* subcategory as a level, not
reject it for sparsity — the opposite of what doc 10 §2.2 demonstrates. Anyone who walks a client
through doc 10 §2.2 and then opens the live dashboard risks visibly contradicting the document on
screen.

**What was not re-measured this session.** The current subcategory fill percentage specifically —
the top-level drill candidate list only surfaces its top-ranked fields, and subcategory was not
among them at the levels checked in this session. The row-count discrepancy (4,266 vs. 13,986) is
confirmed; the exact current fill rate is not.

**Fix.** Re-measure subcategory fill on the current instance and restate the figure with its real
provenance and date, or relabel it explicitly as a pre-seed observation. The underlying design
conclusion is still sound — `change_request` category→type is genuinely well populated where
incident subcategory likely is not — but the specific cited number needs to survive a client
checking it live, which as written it does not.

---

### F8 — Base64 embedding costs about 1.5× in gzip (Informational)

Embedding the server-computed payload as base64 is well-justified architecturally: it makes Jelly
evaluation of `$`/`{`/`}` inside record data and XML breakage structurally impossible. It is not
free, because base64 destroys the byte alignment gzip depends on:

```
incident         json 271,194 -> gzip  11,497   b64 361,592 -> gzip  16,813   1.46x
change_request    35,762 -> gzip   6,868         47,684 -> gzip  10,701   1.56x
task              24,729 -> gzip   5,308         32,972 -> gzip   8,286   1.56x
```

The stated 250 KB gzipped budget still holds comfortably: the worst page measured is roughly
96 KB gzipped (79.4 KB of client assets — 33.1 KB renderer, 38.7 KB fonts, 6.9 KB CSS, 0.7 KB
theme — plus ~17 KB of payload). Worth recording, not worth fixing on its own; fixing F5 removes
most of the payload base this multiplier applies to anyway.

---

### F9 — What is built is not the architecture that is documented (Informational)

| Documented target (CLAUDE.md §8, doc 10 §6) | What is actually deployed |
|---|---|
| Custom Next Experience (UXF) components, ECharts-first, in a scoped app `x_<vendor>_cmd` with roles, modules and a clean uninstall | Two UI Pages plus UI Scripts, all written to `sys_scope = "global"`, drawing through a bespoke 3,075-line hand-authored SVG renderer with no charting library at all |

This is flagged informational, not as a fault on its own: the docs describe the UI Page surface as
scaffolding, and the renderer's own header comment argues the no-library decision well — zero
third-party runtime dependencies is a genuinely strong answer to the client's most emphatic
concern (§1 of doc 10), and arguably a better one than a custom ECharts build would have been.

Two consequences of the gap are worth stating plainly:

- **The UXF spike is still unrun.** Doc 10 §2.4 makes on-demand data fetch from a real UXF
  component the thing that decides whether drilldown is buildable to the stated interaction
  budget at all, and calls that answer "owed in week two." Drilldown today works by full page
  navigation — correct and shareable, but measured live at **9.4 seconds time-to-first-byte for
  one drill step**, against the stated <400ms round-trip budget (23× over). This confirms F9's
  premise directly: the fetch mechanism the performance budget assumes has not been built.
- **Global scope is not a delivery path.** No scoped app means no clean uninstall, no Store
  distribution route, and no separation from the customer's own global-scope artifacts.

---

## 2. What holds up

A review that only reports faults is not a useful one. These specific claims were tested and
survived scrutiny:

- **The form engine really is shape-driven.** Selection in `CmdForm.js` branches on `distinct`,
  `concentration`, `fillRate`, `n`, `isPartToWhole` and the aggregate function — a genuine rule
  table over measured statistics, not a lookup from field name to chart type. The product's
  central claim is true, and it is the strongest thing in the codebase.
- **All 27 declared forms have a real renderer.** Cross-checking the engine's emitted `form`
  values against the renderer's `FORMS` table leaves no orphans; anything the engine could emit
  that the renderer doesn't implement degrades to a labelled table view rather than a blank panel.
- **No HTML injection surface found.** Every `innerHTML` assignment in the renderer is `= ''`
  for clearing only; content insertion goes through `textContent` and `setAttribute`. The base64
  payload transport (F8's cost) removes the Jelly-evaluation injection class entirely.
- **Deploy verifies by readback, not by status code.** `upsert_verified` in `snclient.py` reads
  every write back and compares it byte for byte, because a Table API 200 proves nothing about
  what was actually stored. That discipline is correct and unusual.
- **226 offline tests pass**, including 71 that execute every renderer against real captured
  payloads from the live instance — the kind of test that catches NaN coordinates and
  zero-range divisions that a pure coverage test misses.
- **The tiered ACL strategy is the right design.** Establishing trust once per table and query,
  then letting every panel inherit it, is the correct insight and the reason the page is fast at
  all. F1 is a hole in one predicate of that design, not a flaw in the underlying approach.

---

## 3. Side-by-side against stock ServiceNow reporting

Measured from the instance's own `sys_report` estate (2,368 live report definitions, see doc 08)
and the platform's documented Visualization Designer palette (doc 04), compared against the
COMMAND code and captured payloads.

| Dimension | ServiceNow, as it ships | COMMAND, as built | Verdict |
|---|---|---|---|
| Chart forms available | ~16 in Visualization Designer; 29 real types in `sys_report.type` | 27 implemented renderers, all reachable from the engine | **Ours** — 12 forms have no OOB equivalent |
| Forms the other side cannot draw | geomap, bubble, list, indicator scorecard, pie | bump, funnel, histogram, line_multi, ranked_bar_top_n, slope, small_multiples, stacked_proportion, stat_tile_delta, stream, treemap, waterfall | **Ours**, 12 to 5 |
| Who chooses the form | The report author, per report. Measured: `priority` drawn 9 different ways, `category` 11, `sys_created_on` drawn as a scalar 20 times out of 26 — never once as a line | A deterministic rule table over measured shape (distinct count, fill rate, concentration, row count, aggregate), reason and caveats shown alongside the chart | **Ours**, and the strongest claim in the product |
| Richness actually in use | 5 types carry 77.4% of all reporting; the bottom 11 carry 2.0% | All 27 forms exercised against real captured payloads in the test suite | **Ours** |
| Multi-level drilldown | Interactive filtering and drill-to-list; no measured, gated multi-level hierarchy | 3 levels, each gated on fill rate and cardinality, rejected levels state why, path is in the URL and shareable, terminal step hands off to the platform list view | **Ours** — but see F1, and the round trip is a full page load at ~9s, not <400ms |
| ACL correctness on aggregates | `GlideAggregate` does not enforce row-level ACLs, no secure equivalent exists — a real, documented platform gap | Tiered proof: fast path, one bounded secure count to prove it, escalate on disagreement; verdict badged on the page | **Ours in design, unproven in practice** — F1, F2, F3, F4 |
| Entry point | Dashboard and report lists, permission-scoped | Catalog of subjects derived from where reporting demand already is, membership ACL-gated | Comparable |
| Export — PPT, PDF, CSV | Native, scheduled and emailable, verified live earlier in the engagement | None. No export, download, print or CSV path anywhere in the renderer | **Theirs** — a straight regression |
| Third-party runtime dependencies | n/a — it is the platform | Zero. No chart library, fonts self-hosted and inlined, no external request at runtime | **Ours** — answers the client's first and most emphatic concern |
| Delivery and upgrade safety | Native, upgrade-safe by definition | UI Pages and UI Scripts in `global` scope. No scoped app, no roles, no clean uninstall | **Theirs**, today |
| Accessibility | Platform-standard, list and pivot views of every report | Partial — 16 aria/role uses, keyboard-reachable tooltips, labelled controls, table fallback for any unrendered form | Comparable, not yet audited |
| Cross-source data modelling | Single-instance, same as ours | Single-instance | Neither — and neither is Power BI parity |

**Where the comparison is weaker than a deck would imply:**

- **Export is a real loss, not a gap to gloss over.** A leader who can email a scheduled PDF of a
  stock report today cannot do that with COMMAND at all. CLAUDE.md already names export as parity
  work; it has not been built, and it will be the first thing a client asks for after the first
  demo.
- **"12 forms OOB cannot draw" is the honest headline, not "27 vs 6."** The six-chart-type figure
  was already falsified inside this engagement and must stay buried (see doc 04). 27 against a
  real ~16–29 is still a genuine win, but it is a win on *kind* — treemap, waterfall, stream,
  slope, small multiples — not on raw count.
- **The ACL differentiator is currently a design, not a proof.** It is the right design, and the
  reasoning around it (`aclVerdict`, `PREDICT_WARM`) is the best engineering writing in the
  repository. But with F1 open and F2 unaddressed, a client's own security reviewer who reads
  `_trustedFor` will reach the same conclusion this review did. Fix F1 and add the persona test
  before this is pitched as proven rather than designed.
- **Drilldown is a page navigation, not an in-place update.** It is genuinely multi-level, gated
  and shareable, which is more than stock ServiceNow offers. It is not the sub-400ms in-place
  drill the performance budget describes — measured live at 9.4 seconds — and the UXF spike that
  would determine whether that budget is even reachable has still not been run.

---

## 4. Performance against the stated budget

`10-client-review-and-revised-scope.md` §5 sets seven numeric gates.

| Gate | Target | Measured | Status |
|---|---|---|---|
| Initial payload | ≤ 250 KB gzip | ~96 KB worst page | **Pass** |
| Client assets | measured, then budgeted | 79.4 KB gzip (render 33.1, fonts 38.7, css 6.9, theme 0.7) | **Pass** |
| Chart engine bundle | custom ECharts build | no library at all; 33.1 KB gzip of hand-written SVG | **Beats it** |
| Renderer above ~1,000 marks | Canvas | 3,322 SVG nodes measured; no canvas path exists in the code | **Fail** — F5 |
| Progressive / deferred panels | below-fold deferred | 0 occurrences of any deferral mechanism | **Fail** — F5 |
| Server TTFB, top-level dashboard | < 1.2 s (FCP target) | 7.9 s live; one attempt hung past 35 s | **Fail** |
| Server TTFB, catalog | n/a | 7.8–9.2 s across 2 live loads | **Fail** vs. the < 2.5 s interactive bar |
| Drill round trip | < 400 ms | 9.4 s TTFB, live, one step deep | **Fail** — 23× the budget |

These server-side TTFB numbers were measured on an instance that was independently unstable during
this review — the same session saw both ~5s and >35s-timeout responses to the identical URL
minutes apart — so treat the absolute figures as an upper bound shaped partly by instance health,
not a clean isolated measurement of the product's own server time alone. What is not ambiguous:
drill is architecturally a full server round trip through Jelly plus a fresh permission proof,
consistently in the 8–10 second range even on a healthy response, nowhere near the sub-400ms
budget — which directly confirms F9's point that the on-demand fetch path the budget assumes was
never built or tested.

On the server side, the *design* of the budget discipline is genuinely good and worth crediting
independently of the numbers above: a request-level scan allowance (`SCAN_ALLOWANCE_MS`),
per-scan wall-clock boxes, a single shared page scan so every panel derives from the same rows,
and a projection that abandons a permission proof it cannot finish rather than burning the whole
budget to reach the same verdict. The reasoning recorded around `PREDICT_WARM` in `CmdData.js` —
where a three-fold overestimate made the same dashboard report 4,266 records on one load and 50 on
the next — is the best piece of engineering writing in the repository.

---

## 5. What remains unmeasured

Live access was blocked for roughly the first two hours of this review, then restored using a
supplied browser session partway through. F1 and F7 are confirmed against today's live data. Two
items are still open:

- **Current subcategory fill rate on the live 4,266-row incident table.** The row-count
  discrepancy in F7 is confirmed; the current subcategory percentage specifically was not isolated
  in this session, because the top-level drill candidate list only surfaces its top four ranked
  fields and subcategory did not appear among them at the levels checked.
- **A genuinely restricted, non-admin persona.** Everything measured live in this session,
  including F1's injection, ran as `admin`, so `aggregate == secure` by construction and no live
  session yet demonstrates rows actually being hidden or leaked. This is precisely the gap F2
  names: there is still no seeded, role-restricted account to point any of the above at.

### About the instance itself

Worth recording because the pattern is diagnostic. For roughly the first two hours of this review,
anonymous cacheable GETs of `/login.do` returned 200 in ~2s consistently, while everything
requiring an application transaction — the login POST, `/home.do`, `/stats.do`, the Table API —
hung until the client gave up. That is the web tier answering while the application node does not,
which on a personal developer instance usually means transaction semaphores are exhausted or the
instance is hibernating. It then recovered enough for a supplied browser session to load pages,
but stayed inconsistent: the same dashboard URL returned in 7.9s on one request and hung past 35s
minutes later on an identical one, and the Table API failed on every attempt even during recovery
— consistent with the XHR/Table API failure already documented in
`poc/servicenow/ui-page/probe-results.md`.

Recommend waking or restarting the instance from the developer portal before the next working
session, and confirming that a `smoke_live.py` run — 44 page builds, each permitted up to five
seconds of permission-checked scanning — is not itself a contributor to load when one is run.

---

## 6. Recommended order of work

1. **Validate the drill path and fix the trust predicate (F1).** Half a day. Reject `^` in a key,
   check the field against the dimension list, and refuse trust transfer across `^OR` and `^NQ`.
2. **Add one non-admin persona test (F2).** One user, one filtering ACL, one assertion. Closes the
   blind spot that has now produced two bugs, and is the evidence the lead differentiator
   currently lacks.
3. **Cut the scatter server-side (F5).** Removes ~85% of the worst payload and the only mark count
   that breaches the render budget. Follow with one line of `content-visibility`.
4. **Move `prune_assets()` after the page writes (F6).** One line.
5. **Correct the two documentation defects (F3's docstring, F7's figure).** Both are things a
   client can catch directly, and both cost more credibility than their size suggests.
6. **Run the UXF spike (F9).** Still the gate on whether drilldown can meet the interaction
   budget; owed since week two, and now confirmed necessary by the 9.4s live measurement.
7. **Decide on export.** The one dimension where stock ServiceNow is strictly better today, and it
   will surface in the first client demo.

---

## 7. Method note

Offline: all 226 tests in `product/tests/` re-run via `run_all.sh`. The renderer was benchmarked
by executing `cmd_render.js` verbatim inside a Node.js `vm` context over an instrumented DOM shim
(`domshim.js`) against all 11 checked-in fixtures in `product/tests/fixtures/`, counting every
element created, best of 5 runs per fixture. The F1 injection was first proven by extracting
`CmdDrill.stepQuery`, `CmdData._trustedFor` and the `cmd_dashboard.xhtml` path-parsing logic
verbatim into a standalone script and exercising them directly.

Live: session established via `product/deploy/snclient.py`'s login flow where the instance
allowed it, and via a supplied authenticated browser session once the login POST began hanging.
F1 and F7 were confirmed by fetching `/cmd_dashboard.do?table=incident&months=12` with and without
the injected drill path and decoding the returned `cmd-data` payload. TTFB figures in §4 were
measured with `curl -w` against the live instance. No table, record, ACL rule, script include or
UI page was created, modified or deleted on the instance at any point.
