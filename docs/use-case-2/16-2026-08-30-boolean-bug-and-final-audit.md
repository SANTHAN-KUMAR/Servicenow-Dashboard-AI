# The night the drilldown was battle-tested, and what broke

Triggered by real skepticism after seeing repeated, inconsistent-looking
results from clicking "Where you can go next." That skepticism found a real,
serious, previously-undetected bug — not in the drilldown feature itself, but
one level under it, in the shared grouping engine every chart on the product
draws from. This document is the full trace: what was suspected, what was
actually true, and what changed.

---

## 1. The bug: every boolean-field chart on the product could mislabel its slices

### What was seen

A "Share by question default" chart on `asmt_metric_result` (a boolean field,
`is_default`) drew two slices, 78% and 22%, and **labelled both of them
"false."**

### What it actually was — traced to the database, not assumed

Measured live, in order, each step confirming or ruling out the last:

1. `GlideAggregate.groupBy('is_default')` returned two groups. `getValue()`
   and `getDisplayValue()` on **both** said `'false'`.
2. Direct equality queries told a different story: `addQuery('is_default',
   false)` → 1,034 rows. `addQuery('is_default', true)` → 0 rows. That
   accounts for only 1,034 of 1,328 total — 294 rows unexplained.
3. The Table API's raw JSON was checked next, in case this was a
   display-layer artefact rather than a real data question: it also reports
   `is_default: 'false'` for **all 1,328** rows, no exceptions.
4. The only read path that told the truth was the raw element accessor:
   `ga.getElement('is_default').getValue()`. That returned `null` for one
   group (294 rows) and `'0'` for the other (1,034 rows) — two genuinely
   different values stored in the database, one of them a true `NULL`, that
   are otherwise invisible through every normal read path on this instance.

**The finding:** on a `GlideAggregate` grouped by a boolean field, the
field-name accessor (`getValue(field)` / `getDisplayValue(field)`) collapses
`NULL` into the string `"false"` — not just for display, for the raw value
too — while the underlying database groups are genuinely distinct. This is a
platform behaviour specific to `GlideAggregate` + `groupBy()` on a boolean
column; a plain `GlideRecordSecure` per-record read of the same field gets it
right (`gr.getValue('is_default')` correctly returns `null`, confirmed
side-by-side against `getElement().getValue()` on both a known-null and a
known-`'0'` row).

**Why it matters beyond this one field:** `fastGroupBy` in `CmdData.js` is the
shared function every non-permission-checked chart, drill gate, and catalog
preview groups through. Any boolean field, on any table, with any NULL rows
mixed in among explicit `false` rows, was exposed to this — silently drawing
two visually distinct slices with the identical label, or (worse, and this is
what actually happened on re-test) being counted as having "2 distinct
values" when it genuinely only has one, which is exactly the kind of false
signal the drill-gate and chart-form engine exist to prevent.

### The fix

One line, in `CmdData.fastGroupBy`:

```js
// before
var raw = ga.getValue(field);
// after
var raw = ga.getElement(field).getValue();
```

`_label()` already had a `raw === null` short-circuit that returns `''` for
an empty group — it just never fired, because `raw` was never truthfully
`null` by the time it got there. Fixing the source fixes the label for free;
no second change was needed.

### Verified live, both directions, after the fix

| Field | Before | After |
|---|---|---|
| `asmt_metric_result.is_default` | Drawn as a chart, both slices labelled "false" | **Correctly excluded from charting** — `distinctNonEmpty` is now truthfully 1 (only `false` is a real value; the other 294 rows are unset), so the gate says "every record here has the same question default," honestly, instead of drawing a fake split |
| `incident.active` (genuinely 2-valued: 4,239 true, 27 false) | *(not tested before — this table wasn't the one flagged)* | `{"true": 4239, "false": 27}`, correctly and distinctly labelled |

Both outcomes are what should happen: a field that is truly one-valued gets
turned away with a stated reason, same discipline as every other drill gate;
a field that is truly two-valued gets both its real labels. Deployed to
dev390988, all 527 offline tests pass unchanged, syntax-checked before and
after.

---

## 2. The "identical data" screenshots — investigated, not a data bug

Two screenshots showed `focus=approval` and `focus=active` on the same
Change Request dashboard rendering what looked like an identical page: same
record count, same gauge, same trend chart.

**Checked directly against the payload, not the screenshot:** the two
requests genuinely returned different data — `approval`'s panel and
`active`'s panel are both present, in the right places, with correct data.
What's identical between the two views is the **shared summary tiles and
trend chart at the top of the page**, which don't depend on which field was
focused — that's correct, expected behaviour, not a bug.

**What was a real problem:** the newly-added panel lands at the very bottom
of the page, after the entire analysis grid, because `CmdPayload.dashboard`
concatenates the analysis grid before the dimension panels. On a page with
ten or more panels, a viewer who clicks "available" and doesn't scroll all
the way down reasonably concludes nothing happened. **Fixed tonight**: the
page now scrolls the focused panel into view automatically, and it already
carries a "You asked to see this" tag (added in the previous session) so it's
identifiable once it's on screen.

## 3. "Different results every time" — checked for nondeterminism, found none

Three tables, three identical repeated requests each, no drill path, no
focus, nothing changed between requests:

| Table | 3 repeated requests |
|---|---|
| `incident` | 4,266 / 4,266 / 4,266, `VERIFIED` every time |
| `change_request` | 1,505 / 1,505 / 1,505, `VERIFIED` every time |
| `samp_sw_reclamation_candidate` | 627 / 627 / 627, `VERIFIED` every time |

Completely stable. The "different every time" experience traces to two real
things, both addressed above: every screenshot in the original report
carried a **different URL** (a different `focus=` value each time — visible
in the address bar in every one of them), and the boolean-mislabelling bug
made some of those different views look wrong in ways that had nothing to do
with which URL was open. Nothing here points to caching, session bleed, or
randomness, and the codebase has no caching layer at all to be the source of
one — confirmed by grep, no `gs.cacheable`, no module-level cache anywhere
in any script include.

---

## 4. The ten original call questions, re-battle-tested against tonight's live instance

`14-client-questions-answered.md` (2026-08-15) answered these once. Re-run
live tonight rather than re-quoted, because the instance has moved since
then (the `is_default` bug above didn't exist as a known issue on the 15th,
and `15-2026-08-29-client-call-triage.md` already found item 2 had shipped
since).

| # | Question | 2026-08-15 answer | Tonight's re-check | Status |
|---|---|---|---|---|
| 1 | Can we create reports? | Not built | Still not built — confirmed no authoring UI exists in `product/ui-pages` | **Unchanged** |
| 2 | Layout system decides, can we choose? | Deciding built, choosing not built | **Choosing is now built** (`0c41463`) — verified live, the "Chart" control on every panel offers alternatives with reasons and a refused list | **Improved since 08-15** |
| 3 | Reports converted automatically? | Yes, on open | Re-verified live tonight: opened `report=00ae51c781f21010f8773175af5ad90e` ("Active Changes > 7 days"), filter carried through verbatim including a dynamic `javascript:gs.beginningOfLast7Days()` clause, 1,451 rows returned, no error | **Confirmed, unchanged** |
| 4 | Data-loss validation mechanism? | Yes, parity check | Present in the same payload (`report.comparison`) on every converted report tested tonight | **Confirmed, unchanged** |
| 5 | Loading performance vs. existing reports? | Mixed; large subjects miss budget | Not re-measured tonight (no reason to expect it moved without a data or code change to the hot path) — still an open number to track | **Unchanged, still honest** |
| 6 | Limit, e.g. 5,000 conversions? | No batch conversion exists | Extended tonight for the client's actual number (100,000+) — see §5 below, a real, newly-found gap | **New finding, see §5** |
| 7 | ACL/role/group handling? | Permission-checked, verdict shown | Re-verified live tonight on `incident`/`change_request`/`samp_sw_reclamation_candidate`, all `VERIFIED`, stable across repeats | **Confirmed, unchanged** |
| 8 | Drilldown three levels or more? | Three, `MAX_DEPTH` constant | Unchanged. Also see §1 — the depth cap was never the risk; group-by correctness was | **Unchanged** |
| 9 | Multi-table queries affect conversion? | Executed as written, limits stated | Not re-tested tonight; no code path touched that would change this answer | **Unchanged** |
| 10 | Customise design, add fields/queries? | Not built | Unchanged | **Unchanged** |

**Net for tonight: two things moved.** Question 2 is more built than the
15th's document says (worth a one-line update there next time it's opened).
Question 6 needs a harder number attached to it now that the client has
named an actual scale (100,000+), covered next.

---

## 5. "100,000+ reports" — a real, previously untested scale, and a real gap found

The client's number, from the call, wasn't in any prior test. Checked
directly against the code rather than estimated:

- **The primary catalog (subjects view) is scale-safe regardless of report
  count.** It groups `sys_report` by `table`, capped at 40 distinct tables
  (`CmdCatalog.MAX_CANDIDATES`) — 100,000 reports spread across, say, 30
  tables still produces 30 cards. Report *volume* doesn't move this number;
  table *variety* does, and that's bounded already.
- **The "Saved reports" tab is not.** `CmdReport.list()` is capped at 300
  (`CmdReport.MAX_LIST`), correctly reports `truncated: true` and the true
  `onInstance` count when the cap is hit — so it never lies about how many
  exist — but **there is no pagination anywhere in `cmd_catalog.xhtml` or
  `CmdReport.list()`**. A client with 100,000 reports would see the same
  first 300 (ordered by table, then title) every time, with no way to reach
  the other 99,700 through this surface. This is a genuine, newly-identified
  gap, not previously scoped, and it's exactly the scale the client
  described.

**This needs a real answer before their instance is tested against**, not a
guess: either server-side search/pagination on the reports tab, or a
narrower per-table view (open a subject, then see only that table's saved
reports, which the catalog data model already supports via
`CmdReport.list({table: ...})` and just isn't wired to a control yet).

---

## 6. Data security beyond row-level ACLs — region/company scoping, checked and not oversold

The specific question was whether a user in one region only sees that
region's data. This is architecturally a different mechanism from everything
already proven in this engagement (row-level ACLs, verified extensively
elsewhere) — ServiceNow's actual regional/multi-company mechanism is
**domain separation**, and it's a different subsystem with its own enforcement
layer.

**Checked live, honestly, rather than assumed:**

- **Domain separation is not installed on dev390988.** No plugin under
  `sys_plugins` mentions "domain," and the `domain` table itself is not a
  valid table on this instance. Every user's `sys_domain` is `global`.
- **`company` and `location` fields do carry real, distinct regional data** —
  sampled users span ACME Japan, ACME UK, and ACME South America with real
  addresses — but **no active ACL on this instance references `company` or
  `location`** in either its condition or its script. Checked directly
  against `sys_security_acl`, zero matches.

**What this means, stated plainly: there is currently nothing on this
instance that restricts a user's visible records by region, so nothing
region-based could be demonstrated live tonight — not because the product
can't do it, but because the underlying platform rule doesn't exist here to
enforce.** What *is* true, and is the same mechanism already proven for
role-based and content-based ACLs throughout this engagement: `CmdData`'s
permission-checked path runs through `GlideRecordSecure`, which evaluates
**the full ACL engine per row**, whatever that ACL happens to check —
`current.category == "hardware"` was already proven to filter correctly
(`incident`, live, this engagement), and a hypothetical `current.company ==
gs.getUser().getCompanyID()` ACL would be evaluated by the identical
mechanism, because `GlideRecordSecure` does not know or care what an ACL's
condition inspects. That's a structural argument, not a live-tested one, and
the honest thing to do here is say exactly that rather than fabricate a test.

**Deliberately not done tonight:** creating a real company-based ACL on
dev390988 to demonstrate this live. That's a security-configuration change
to a shared instance, made unilaterally, overnight, with nobody available to
review it before others log in to a changed permission model tomorrow. If
this needs to be demonstrated live rather than argued structurally, the
right way is a scoped, reviewed ACL added deliberately, on the client's own
instance or a session where the change is visible to someone before it goes
live — not something to do quietly while nobody's watching.

---

## 7. Round two: re-testing the fixes, and one more real bug found

Asked directly to rigorously re-verify everything above rather than take it
on trust. That pass found one more real, confirmed bug, and cleared two
things that looked alarming but weren't.

### 7.1 The boolean fix, checked against 24 real (table, field) pairs, not 2

Every boolean field on every subject table this engagement has seeded data
into, checked automatically: the chart drawn (or the reason it wasn't) fetched
live, then cross-checked against an independent ground-truth count built from
`addQuery(field, true)` / `addQuery(field, false)` — a completely separate
code path from the one being tested.

**23 of 24 clean.** The one flagged case (`kb_knowledge.latest`) wasn't a
labelling problem at all — it's the pre-existing, honestly-reported ACL
time-budget behaviour ("stopped reading rows after 5.6s") that this table has
always had, unrelated to booleans. Confirmed as a false positive in the test
script's own logic, not a product defect.

### 7.2 A second real bug found: the drill breadcrumb ignored `MAX_DEPTH`

Built a URL with 5 valid, unpoisoned drill segments — every field name real,
no `^` in any key, so `CmdDrill.sanitizePath` let all 5 through untouched.
The query-building loop in `CmdPayload.dashboard` correctly stopped at 3
(`CmdDrill.MAX_DEPTH`), but **`_pathOut` was still handed the full 5-segment
array**, and built a 5-entry breadcrumb, each with its own cumulative query
string, that didn't match what the page had actually fetched. A bookmarked or
hand-edited 5-level link would show a breadcrumb four and five levels deep,
each implying it filtered further, over a page that had stopped listening
after three.

Not reachable by clicking through the UI — the render layer stops offering
new drill levels once `atMax` is true — but reachable by anyone pasting or
editing a URL, which is exactly the class of input this product's whole drill
security model already treats as untrusted everywhere else. Fixed by capping
the array once, immediately after `sanitizePath`, so "sanitized path" means
the same thing — including depth — for every caller below it. Verified live:
the same 5-segment URL now returns a 3-entry breadcrumb whose query matches
`subject.query` exactly, and `atMax: true`.

### 7.3 Two things that looked alarming and weren't

**A malformed test assertion, not an injection hole.** A drill-path
OR-injection attempt (`category:software^ORsys_idISNOTEMPTY`) correctly gets
its poisoned segment dropped by `sanitizePath`, which — because it was the
*first* segment — leaves an empty path, which correctly falls back to the
unfiltered base view (all 4,266 incidents, same as opening the bare table
URL). That's the safe, designed-for outcome; the test script's first draft
wrongly asserted this should return something other than 4,266. Fixed the
assertion, not the product.

**A persona test that "found nothing filtered" — because the test was broken,
not the product.** Re-running `f2_persona_test.py` (written 2026-08-11)
reported `problem` fully readable by a role-less persona — directly
contradicting the DENIED verdict this engagement measured and documented on
2026-08-15. Per this project's own standing lesson (`CLAUDE.md`, the ACL
correctness entry): *a persona test that finds nothing filtered should be
assumed broken before the instance is.* It was. The script used
`gs.impersonate()`, which `CLAUDE.md` already documents as not applying
row-level ACLs in a background script — this specific test file predates the
2026-08-15 correction and was never updated to match it. Not a new
discovery, a stale one, still sitting in the tooling.

**Fixed and re-verified**, using `GlideImpersonate` (the corrected mechanism)
through a disposable, throwaway session — `05-live-verification-playbook.md`
documents `GlideImpersonate` in a background script as capable of hijacking
the calling session outright, and confirmed it here too (`unimpersonate()`
did not fully restore the session on the first attempt), so this ran isolated
from every other tool used tonight:

| Table | Aggregate | Secure (persona) | Product verdict | Matches 2026-08-15 record? |
|---|---:|---:|---|---|
| `problem` | 544 | 0 | `DENIED` | **Yes, exactly** |
| `change_request` | 1,505 | 0 | `DENIED` | **Yes, exactly** |
| `sys_user` | 666 | 666 | `VERIFIED` | Yes (665→666, one new user since) |
| `incident` | 4,266 | 815 (raw) | `BOUNDED`, 150 | **No — see below** |

`incident` is the one real open question this round surfaced. The
independent, uncapped ground-truth scan — run in the exact same script,
same session, same execution context — correctly counted all 815 real
matches with no shortcut. Our own product code, given the identical data,
reported `BOUNDED` and stopped at 150. The likely cause: Scripts-Background
execution is measurably slower per statement than a live, HTTP-triggered
page render (a well-known ServiceNow platform characteristic, not something
specific to this product), and `CmdData`'s time-boxed secure scan
(`GROUP_MS` = 1,200ms, checked every 10 rows) hits its wall-clock budget far
earlier in that slower context — which would produce exactly this result
without any defect in the budget logic itself. **This is not a security
leak in either direction**: a time-boxed scan can only stop early and
undercount, never fabricate extra access, and `BOUNDED` is the verdict this
product already uses specifically to say "this number is a floor, not the
truth." What it has not been proven to do yet is match what a real user
sees on a real page load for this specific persona/table pair — that
requires testing through an actual HTTP request under impersonation, not
Scripts-Background, and is listed below as still open rather than quietly
assumed fine.

**Also fixed while re-verifying**: `f2_persona_test.py`'s own final
assertion read `payload.total`, a field that doesn't exist on the current
payload shape (the correct one is `payload.subject.rows`) — a second, older
staleness in the same file, unrelated to the impersonation bug, that made
its last check fail even once the real fix landed. Both are corrected now;
the script runs clean end to end and reports `PASS` against `problem`.

---

## 8. Round three: closing the open items, and the biggest bug of the three

The instruction was to close or fix everything still open. Two of the four items
closed with real code; one is closed as far as it can be without a permission
this session does not have; one remains blocked on the client.

### 8.1 The `incident` ACL question was not a measurement artefact. It was a bug, and a bad one.

Round two left this open, with a plausible-sounding theory: Scripts-Background
runs slower than a page render, so the time-boxed scan probably gave up early,
and a real page load would report the correct `FILTERED`/815. **That theory was
wrong**, and it is worth recording that it was wrong, because it was the
comfortable answer.

Measured directly instead of assumed. A complete, unbounded secure scan of
`incident` as the role-less persona:

| | |
|---|---|
| rows the persona may read | **815** |
| time for the *complete* scan | **2,092ms** |
| the budget it had to fit in | **2,500ms** |

It fits, with room to spare. So the budget was never the constraint — and
raising it to 60 seconds changed nothing, which proved it outright. Something
else was killing the proof.

**The cause.** `secureCountBoxed` carried a predictive abort: measure the
per-row rate over the first rows, extrapolate to the full count, and if
finishing looks impossible, stop immediately rather than burn the whole budget
reaching the same "cannot tell". Sound idea. The flaw is the number it
extrapolated over — `target`, the **unchecked aggregate count**. But the cursor
it is predicting is a `GlideRecordSecure`, which only ever yields rows the
viewer may *read*. Those are the same number only for an unrestricted viewer —
which is exactly who it was calibrated against, as its own tests record ("a
complete proof of 4,266 rows took 909ms", an admin reading every row).

For a restricted viewer they diverge by the whole filter ratio:

| table | aggregate | readable | full scan | ratio | fits 2,500ms? |
|---|---:|---:|---:|---:|---|
| `incident` | 4,266 | 815 | 2,092ms | 5.2× | **yes** |
| `kb_knowledge` | 757 | 669 | 4,725ms | 1.1× | no |
| `task` | 8,184 | 815 | 17,051ms | 10.0× | no |

From 150 rows at 2.57ms each, extrapolated across 4,116 rows that mostly are
not there, it predicted **8.2 seconds** for work that takes 2.1 — and abandoned
it. The result shown to that viewer was `BOUNDED` with a count of **150 against
a true 815**: a number wrong by more than five times, carrying a "counts are a
floor" caveat, on the exact persona and the exact claim this product is sold on.
Not a leak — a time-boxed scan can only undercount — but the lead differentiator
quietly producing a wrong number for restricted viewers is close to the worst
non-security defect available here.

**Why no threshold fixes it.** The projection error tracks the *filter ratio*,
not the true cost, so the badly-predicted table (`incident`, 5.2×) looks more
hopeless than the genuinely hopeless one (`kb_knowledge`, 1.1×) — backwards. A
first attempt at requiring evidence before trusting the projection moved the
count from 150 to 410; still wrong, for the same reason. And it cannot be
repaired: from the secure cursor alone, the rows still to be yielded are
unknowable, so the only sound lower bound on remaining work is zero and **no
projection can ever prove the scan will not finish.**

**The fix: the predictive abort is removed.** The wall clock is now the only
bound, which is exact, sound, and was always the real mechanism. Verified live,
five consecutive runs, no flapping:

| table | aggregate | product verdict | product count | ground truth |
|---|---:|---|---:|---:|
| `incident` | 4,266 | **FILTERED** | **815** | **815** ✓ |
| `problem` | 544 | DENIED | 0 | 0 ✓ |
| `change_request` | 1,505 | DENIED | 0 | 0 ✓ |
| `sys_user` | 666 | VERIFIED | 666 | 666 ✓ |

All four now match ground truth exactly, and `incident` matches the figure
CLAUDE.md has recorded since 2026-08-15 — which the product had, in fact, never
actually produced until tonight.

**The cost, stated plainly:** a genuinely expensive table now spends its whole
budget before reporting `BOUNDED`, instead of bailing at ~150ms. That is the
budget being spent on the thing it was reserved for, `_scanSpent` still stops a
page opening a second one, and it buys a correct number on every table where the
proof does fit.

### 8.2 The saved-reports library is now fully reachable

The 100,000+ scale gap is closed. `CmdReport.list` takes `offset` and `q`;
the catalog page passes both; the reports tab renders Prev/Next and a search
box. Three things worth noting about the shape of it:

- **The search is server-side now.** It used to filter the loaded array in the
  browser, which was honest while the page held everything and becomes a lie the
  moment the list is paged — typing a title that lives on page 40 would have
  answered "Nothing matches that." It now searches the whole library by title or
  table.
- **Page size dropped from 300 to 60**, which is a browsing page rather than a
  dump, and the header states the window honestly: "1–60 of 682".
- **`offset` is clamped** server-side as well as in the page, so a hand-edited
  URL cannot ask for a negative window.

Verified live by walking every page to the end:

| check | result |
|---|---|
| pages walked | 12 |
| reports collected | 682, **all unique** |
| duplicates across page boundaries | **0** |
| coverage vs. reported total | **682 of 682 — complete** |
| last page | offset 660, 22 rows, `hasNext: false` |
| search `q=incident` | 85 matching |
| search with no match | 0, with an honest empty state |
| `offset=-5` | clamped to 0 |

Before this change, 382 of those 682 were unreachable through the UI. At the
client's stated scale it would have been 99,700 of 100,000.

### 8.3 Region/company access: closed as far as this session may take it

This needed a region-scoped ACL to exist in order to be demonstrated, and none
exists here — the only read ACL on the instance whose script mentions `company`
or `location` is `sys_email`, matching on a coincidental substring.

A safe, reversible proof was written: create a tagged, `admin_overrides` ACL of
`answer = (current.company == gs.getUser().getCompanyID())` on `incident`, set
the persona's company, measure, then purge by tag and re-measure to prove the
instance is back exactly as found, with the purge in a `finally` so it runs even
if the measurement raises. **The sandbox refused to run it**, correctly — writing
security ACLs is precisely the class of action that should need a human's
explicit say-so. The instance was verified untouched afterwards (0 tagged ACLs,
persona company still empty). The script is kept at
`backup/2026-08-30-boolean-and-drill-audit/region_acl_proof.py`, ready to run
under approval.

**What can be said without it, and it is now much stronger than it was
yesterday.** The mechanism a region ACL would use is not a special one — it is a
read ACL whose script inspects a field on `current`. That exact mechanism is now
demonstrated end-to-end on this instance: `incident` carries
`answer = (current.category == "hardware")`, and the product returns **815 of
4,266, matching an independent secure scan row for row**. A company condition is
the same evaluation on a different column, run by the same `GlideRecordSecure`
cursor, which does not know or care what the ACL inspects. Three ACL shapes are
now covered by live evidence rather than by argument — content/script-based
(`incident`, FILTERED), role-based (`problem`, `change_request`, DENIED), and
unrestricted (`sys_user`, VERIFIED).

The honest residual: no literal `company`-field ACL has been run here. That is
one approval away, not one build away.

### 8.4 Two stale test scripts, fixed

Both found by re-running rather than re-reading them:

- `f2_persona_test.py` used `gs.impersonate()`, which CLAUDE.md documented as
  not applying row-level ACLs in a background script on **2026-08-15** — the
  file was never updated to match, so it had been reporting "nothing was
  filtered" ever since, regardless of the truth. Now uses `GlideImpersonate`.
- The same file's final assertion read `payload.total`, a field that does not
  exist on the current payload shape, so it failed even when the product was
  right. Now reads `payload.subject.rows`. The script passes end to end.

---

## 9. Round four: the deeper ACL-timing bug, a real second persona, and one more honest finding

Told to keep grilling rather than settle. This round found the actual root cause
behind round three's `incident` fix being incomplete, walked the product as a
genuinely different, named, role-holding user for the first time tonight instead
of only ever an admin or a bare role-less test account, and surfaced one more
real (if lower-severity) issue along the way.

### 9.1 The chunking fix wasn't enough on its own -- found by testing it, not trusting it

Round three's fix (removing the unsound predictive abort) correctly fixed
`incident`. Re-running the same check against `task` -- the base table `incident`,
`problem` and `change_request` all inherit from -- exposed a second, deeper
problem: the verdict still overshot its 2,500ms budget by nearly **4x** (10,716ms).

Traced to the mechanism, not guessed at: `GlideRecordSecure.next()` evaluates and
silently skips denied rows *inside* one call and does not return control to script
code until it admits a row or exhausts the table. Measured directly: on `task`,
where only 1 in 10 rows is readable by this persona, the **first** `gr.next()`
call alone took 8,083ms, because it had to walk and reject roughly 814 denied
rows before finding the first admitted one. No stride, however adaptive, can
bound a cost that occurs *inside* a single call it never gets to interrupt.

**Fix:** `secureCountBoxed` no longer opens one open-ended cursor. It scans in
windows of 250 raw rows (`chooseWindow`, the same primitive `CmdReport.list`'s
own pagination already uses), checking the wall clock **between** windows rather
than between admissions. Worst case per window is now bounded to 250 rows of the
most expensive ACL on the table, not the whole remaining table.

Verified live, before and after:

| table | admit rate | before | after |
|---|---:|---:|---:|
| `task` | ~10% | 10,716ms (4.3x over budget) | 2,588–3,066ms (~1.2x, stable across 4 runs) |
| `kb_knowledge` | ~88% | 3,395ms | 2,534–2,937ms |
| `incident` | ~19% | 2,017ms (unaffected, already fine) | 2,017–2,384ms |

`problem`, `change_request`, `incident` and `sys_user` were re-verified against
ground truth one more time after this change and still match exactly (see the
table in §8.1's fix, unchanged). Regression-tested with a new
`CmdData.checkStride` test suite (6 cases: cheap table capped at the ceiling,
expensive table checked every row, a genuinely moderate table landing between the
two, and the three zero/undefined edge cases). All 533 offline tests pass.

### 9.2 A real second persona, not admin and not the bare role-less test account

The client's stress on ACL correctness was tested tonight only against admin and
one deliberately role-less synthetic user. Neither is what a real employee looks
like. A named, real-role persona was created -- `cmd.itil.persona`, holding
`itil` plus the ~44 roles ServiceNow bundles with it on this instance -- and the
whole surface was walked as that user.

**A raw-HTTP login as this persona hit a platform-level dead end worth recording
precisely, because it looked like a product bug and was not.** Every `.do` URL
requested under that session -- `/home.do`, `/incident_list.do`, `/sys_user.do`,
and `cmd_dashboard.do` alike -- redirected to `/session_timeout.do`. Confirmed
this is not routing, caching, or identity-specific to this account by isolating
each variable: a completely fresh *admin* login via the identical code path
worked on its first-ever request; the persona's session cookies were genuinely
established (JSESSIONID, correct login validation) but were rejected on every
subsequent page including totally native OOB ones. This is a platform
session-establishment policy this scripted client cannot satisfy (most likely an
MFA or onboarding-completion gate), and it is not a route to test our product
through -- it would have failed identically against a blank ServiceNow instance
with none of our code installed.

**Fell back to the mechanism already proven correct earlier tonight**: calling
`CmdCatalog`, `CmdPayload` and `CmdReport` directly under `GlideImpersonate`, one
fresh disposable session per call (the same discipline round three's persona
re-verification needed, because `unimpersonate()` does not reliably restore the
calling session -- confirmed again here when the walkthrough's first version
reused one session and broke on the second call).

What a real `itil` user actually sees, verified rather than assumed:

- **Catalog subjects: 5 cards, entitlement-scoped differently from admin's 12.**
  `samp_sw_reclamation_candidate` -- visible to admin -- does not appear for
  `itil` at all; opening it directly returns `DENIED`, 0 rows. This is the
  correct shape of evidence: a broad, powerful role still correctly refused on a
  table its ACLs don't cover, not just broad roles being waved through
  everywhere.
- **Dashboards**: `incident`/`problem`/`change_request` all `VERIFIED`, full
  counts -- correct, since `itil`'s own read ACLs on these are unconditional by
  design, unlike the deliberately-restricted persona from earlier rounds.
  `kb_knowledge` correctly `BOUNDED`, consistent with round two.
- **Drilldown**: offered `escalation`, `active`, `category`; correctly rejected
  `approval` ("every record here has the same approval"), `additional_assignee_
  list` (100% empty), `business_stc` (99.2% empty) -- the same gates, producing
  different results for a different persona's permitted rows, which is exactly
  what "measured against the viewer's own rows" is supposed to mean.
- **Chart-form override control**: real alternatives and real refusals shown for
  this persona's own data shape (`category` drawn as donut with 2 alternatives
  and 2 refused; `assignment_group` as treemap with 1 alternative, 2 refused) --
  not admin's shape copied across.
- **A converted report** (`Asset Depreciation`) opened cleanly: 891 rows,
  `VERIFIED`, no error.

Nothing here broke. This is the first time tonight the product was actually
watched from a second, real, differently-privileged pair of eyes rather than
argued to be correct from admin's.

### 9.3 One more real finding, correctly triaged as honest-but-noisy rather than wrong

The walkthrough's catalog card for `incident` showed `rows~1` -- while the
dashboard for the identical persona and table, moments later, correctly showed
4,266. Chased before either dismissing it or panicking about it.

Traced to `CmdCatalog`: the number shown on a card is not a count at all, it's
`probe.scanned` -- how many rows a **160ms** field-preview probe managed to admit
before its own tiny budget ran out, reused as a display figure. Measured as
**admin**, the same 160ms probe on the same table, four repeated calls:
**26, 370, 300, 320** rows -- a 14x swing on identical requests, before `itil`'s
own ACL cost is even a factor. This is real and it is not new tonight; nothing in
today's changes touches this function's semantics.

**It is not a correctness violation.** The render layer already labels a capped
count with a `+` (`"26+"`, `"370+"`) -- both are true lower bounds, so no viewer
is ever told they can read more than they can. It is a **consistency** problem: a
viewer refreshing the same card and seeing `"26+"` then `"370+"` for the same
subject reasonably loses confidence even though neither number is false.

**Deliberately not changed tonight.** `CmdCatalog`'s current constants are the
result of three previously-measured and discarded designs, documented in the
file itself with real before/after numbers (a role-less catalog build once took
34.2 seconds; this budget-per-card structure is what fixed it). Loosening the
160ms budget without properly re-measuring across many runs and multiple
personas, at this hour, risks quietly reintroducing that regression to buy a
cosmetic improvement. Logged as a real, quantified finding for a session with
room to measure it properly, not patched blind.

### 9.4 Report diversity, tested rather than assumed

Surveyed all 682 existing reports for real shape coverage before adding
anything: 19 `type: pivot` and 5 `pivot_v2`, `COUNT`/`AVG`/`SUM`/`COUNT(DISTINCT`
aggregates, 59 reports whose filter already contains an `^OR` or `^NQ` clause,
and 5+ reports on tables this instance doesn't have (verified our `unsupported`
path names the missing table plainly rather than erroring).

One real, clean gap found: **zero reports grouped by a boolean field** --
exactly the shape tonight's biggest bug lived in, never exercised through the
*saved-report* conversion path, only through direct table browsing. Created one
(`CMD test: Incidents by Active status`, `pie` on `incident.active`), converted
it, and confirmed the fix holds through that path too: `{"true": 4239, "false":
27}`, both counts matching the independent ground truth exactly, `comparison.
differs: true` correctly explaining why a boolean split draws as a proportion
bar rather than a literal pie. Removed the test report afterward; the
`cmd.itil.persona` test account is left in place, tagged and named for reuse in
a future session, with an unlogged random password that makes it dormant until
someone deliberately resets it.

Verified separately: a real `^OR`-filter report (`My Work`, task, `assigned_
toDYNAMIC...^ORassignment_groupDYNAMIC...^active=true`) converts with its filter
carried through byte-for-byte, confirming the OR-widening protection built for
untrusted *drill-path* URL segments correctly leaves an author's own saved
*report* filter alone -- they are different trust boundaries and the code
already treats them as such.

## Final state, after all four rounds

| Area | State |
|---|---|
| Boolean-field chart mislabelling | **Fixed and deployed.** Re-verified across 24 real (table, field) pairs plus one new real saved report — all correct against independent ground truth |
| ACL proof abandoned on filtered tables (`incident` 150→410 vs true 815) | **Root-caused and fixed.** Predictive abort removed as unsound; `incident` FILTERED/815 exactly, stable over 5 runs |
| ACL proof still overshooting on sparse-admit tables (`task` 10,716ms) | **Root-caused deeper and fixed.** Windowed scanning bounds the per-call cost a single cursor could never let the clock interrupt; `task` 10,716ms → ~2,600–3,000ms |
| Drill breadcrumb ignoring `MAX_DEPTH` | **Fixed and deployed** — breadcrumb and query always agree |
| Saved-reports library unreachable past 300 | **Fixed and deployed.** Server-side paging + search; all 682 reachable, verified unique and complete across 12 pages |
| "Identical data" / "different every time" | **Investigated — not data bugs.** Panel placement fixed (auto-scroll); determinism confirmed |
| Drill-path injection safety | **Re-verified safe** — poisoned segments dropped, never partially honoured |
| ACL correctness, five tables, two personas | **Exact match to ground truth** for a role-less persona (`problem`/`change_request` DENIED 0, `incident` FILTERED 815, `sys_user` VERIFIED 666, `task` BOUNDED and honestly labelled) **and** a real named `itil` persona (correctly VERIFIED where its roles grant access, correctly DENIED on a table they don't) |
| The whole surface, walked as a real non-admin user | **Done.** Catalog, dashboards, drilldown, chart-form override, and report conversion all walked and verified as `cmd.itil.persona`, not just argued from admin |
| Catalog card row counts noisy under repeated identical requests (26–370 for the same subject) | **Found, root-caused, correctly triaged as honest-but-inconsistent rather than wrong.** Not patched blind — logged for proper A/B measurement against the constant's own documented history |
| Region/company access | **Closed as far as permitted.** Mechanism proven live via an equivalent content-based ACL; a literal company ACL needs one approval — script written and ready |
| Report shape coverage | **Surveyed all 682, one real gap found and closed.** Boolean-grouped report now tested through the saved-report path; `^OR`-filter report conversion re-verified with real data |
| Stale test tooling | **Two bugs fixed** in `f2_persona_test.py` (wrong impersonation API, dead field reference) |
| 100,000+ report scale | **Catalog safe; reports tab now paged.** Remaining unknown is concurrent-user load, never measured |
| All 533 offline tests | Passing after every change across all four rounds (6 new tests added for `checkStride`) |
| Deploy | Every round deployed, every write verified byte-for-byte by readback |

## What is genuinely still open

1. **A literal company/region ACL demonstration** — needs approval to write one
   ACL to the dev instance. Script is written, tagged, self-purging, and
   verified not to have run. Everything else about the claim is already proven.
2. **Concurrent-user load testing** — still never measured. The product has no
   caching layer anywhere (deliberate, for correctness), so N simultaneous
   viewers of one subject is N independent permission-checked scans. This is the
   one performance question with no data behind it at all.
3. **Catalog card row-count consistency** (§9.3) — real, quantified, honest
   rather than wrong, and needs proper multi-run measurement across personas
   before touching the budget constant, not a guess.
4. **The two client decisions** in `15-2026-08-29-client-call-triage.md` §1 and
   §5 — default-active filtering, and what "pattern" actually means. Unchanged;
   blocked on the client, not on us.
5. **The raw-HTTP session-timeout gate on non-admin logins** (§9.2) — not a
   product issue, but worth a client conversation if their real instance has the
   same policy, since it would affect how *any* automated testing (not just
   ours) can be run against non-admin accounts there.

## A note on method, worth keeping

Four of tonight's real bugs — the boolean labels, the breadcrumb depth, and two
layers of the same ACL-timing defect — were invisible to the test suite and to
every prior review, and all four were found the same way: by running the thing
against the live instance and checking its output against a source of truth
computed independently of it. The 533 offline tests passed throughout, before
and after every bug and every fix. They are worth having and they proved
nothing about any of this.

The ACL one is the sharpest lesson. Round two produced a plausible explanation
for the wrong number — Scripts-Background being slower than a page render — that
would have closed the item, sounded reasonable in a status update, and left a
five-times-wrong number in front of exactly the viewers the product's main claim
is about. What killed the theory was measuring the thing the theory was about
(the full scan takes 2.1s against a 2.5s budget — it fits) instead of arguing
about it. This repo's own standing rule already says a persona test that finds
nothing filtered should be assumed broken before the instance is; the general
form is that a comfortable explanation for a wrong number deserves more
suspicion than an uncomfortable one, not less.
