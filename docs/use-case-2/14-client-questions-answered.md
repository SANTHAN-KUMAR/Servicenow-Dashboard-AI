# The ten questions, answered

Written 2026-08-15, against the build running on dev390988. Every number here was
measured on that instance on that date, and the method is given so the client's
quality team can repeat it rather than take it.

Three of the ten are questions. Seven are feature requests wearing question marks,
and they are marked as such, with what is built and what is not.

| # | Question | Short answer | State |
|---|---|---|---|
| 1 | Can we create reports? | Not yet. You open and redraw existing ones | **Not built** |
| 2 | How does the layout system decide, and can we choose? | It decides from measured data shape. Choosing is not built | **Partly built** |
| 3 | Are existing reports converted to the new design automatically? | Yes, on open, from their own saved definition | **Built** |
| 4 | Is there a mechanism to validate data loss? | Yes. Every converted report carries a parity check | **Built** |
| 5 | How is loading performance measured against existing reports? | Instrumented per page. Numbers below, and they are not all good | **Built, and honest** |
| 6 | Is there a boundary, e.g. 5,000 reports? | No batch conversion exists to have a boundary. Measured cost below | **Answered** |
| 7 | How are ACL, role and group restrictions handled? | Every number is permission-checked and carries a verdict | **Built and proven live** |
| 8 | Drilldown three levels or more? | Three today, and the cap is one constant | **Built, capped** |
| 9 | Do multi-table queries affect conversion? | They are executed as written. Limits stated below | **Answered** |
| 10 | Can we customise the new design, add fields and queries? | Not yet | **Not built** |

---

## 1. Can we create reports?

**No, not in this build.** COMMAND opens subjects and redraws saved reports. There
is no authoring surface: no place to name a report, pick a table, build a filter
and save it.

This is a real gap and worth being plain about, because "we can redraw your 682
reports" and "you can make the 683rd with us" are different products. Today, a new
report is created in ServiceNow's own report builder, and it appears in COMMAND
the moment it is saved, because COMMAND reads `sys_report` live rather than
importing from it. That is a workable answer for a first release and it is not the
same as the one being asked for.

What building it would involve: a definition surface, persistence in a table of
our own, and the sharing and ownership model that goes with it. Estimating it
properly needs a scope conversation, not a number in a document.

## 2. How does the layout system decide, and will there be an option to choose?

**Deciding is built and is the strongest thing in the product. Choosing is not.**

The form is chosen from the measured shape of the data, not from the field name and
not from what the report author picked. What gets measured, per field, on the rows
the viewer may read: the number of distinct values, what share the largest holds,
how concentrated the distribution is, how much of the column is populated at all,
and whether the values form a declared sequence.

Those feed a rule table where the first match wins, and every panel carries the
reason it was drawn that way. Real examples, measured:

| Saved report | Author drew | We draw | Because |
|---|---|---|---|
| Problems By State | horizontal bar | column | an ordered scale, drawn in its own order rather than ranked |
| Open Incidents by Assignment | bar | small multiples | 14 categories, too many for one legible plot |
| KPI Incidents by Category | trend | donut | part to whole, few enough slices for arcs to compare |
| KPI Repeated Incidents | trend | semi donut | very few slices, half arc leaves room for the total |
| Highest Change Activity | bar | treemap | many categories, mass spread evenly, area shows the whole |

Note the first row. `horizontal_bar` and `column` are the same family, so the
product reports **no difference**. A comparison that can only ever find a
difference is marketing rather than measurement.

**What is missing is the client's own words from an earlier session: give the user
options to analyse rather than overwhelming them.** Today the page decides and
explains. It does not offer "draw this as a pie instead", and it does not remember
a preference. That is a genuine gap against requirement 2 and it is not large: the
form catalogue already has 27 members and each carries its selection reason, so the
work is an override control and somewhere to persist the choice.

## 3. Will existing reports be converted automatically after deployment?

**Yes, and nothing is converted in advance.** A report is redrawn when someone
opens it, from its own saved definition, read live from `sys_report`.

This matters more than it sounds. There is no import, no copy and no generated
artefact to fall out of date. Edit a report in ServiceNow and COMMAND reflects the
edit on the next open, because there is no second copy to reflect it into.

How it works: the report's table and its saved filter are executed verbatim. The
filter is stripped only of clauses that select no rows — the query builder's `EQ`
terminator, `GROUPBY`, `ORDERBY`, `TRENDBY`, `STARTAT` — and **every removal is
recorded and shown on the page**, so "we did not change your report" is inspectable
rather than asserted.

Measured on this instance: **682 saved reports, 665 convertible.** The 17 that are
not name tables no installed plugin provides, so they are broken in ServiceNow's
own reporting too.

A defect worth reporting, because it shows why the parity check in question 4
exists. `TRENDBY` was initially left in the query. It selects no rows, but the two
counting methods disagree about it: on "KPI - Number of Incidents by Category", as
**admin**, GlideAggregate returned 4,239 and GlideRecordSecure returned 12. The
product concluded the viewer was restricted and told an administrator they could
not read 4,227 records they could read. A layout clause had manufactured a
permission finding. It was caught by the parity check disagreeing with itself.

## 4. Is there a mechanism to validate data loss or missing data?

**Yes, and it runs on every converted report rather than as an audit you schedule.**

The report's own filter is counted twice: once with `GlideAggregate`, which is what
the platform's reporting engine counts and therefore what the existing report
displays, and once with a permission-checked scan. Three outcomes:

- **MATCH.** The two agree. That agreement *is* the proof that nothing was sampled,
  capped, re-scoped or dropped. This is what an unrestricted viewer sees.
- **RESTRICTED.** Ours is smaller. The difference is rows matching the filter that
  this viewer may not open, which the native report is showing them anyway.
- **BOUNDED.** The permission check did not finish inside its budget, so our number
  is a floor and is never presented as exact.

A fourth outcome, ours larger than native, is impossible and is reported as an
error rather than displayed.

Measured live, as admin, on real reports:

```
Problems By State                 544 = 544     MATCH
Open Incidents by Assignment    4,239 = 4,239   MATCH
KPI Incidents by Category       4,239 = 4,239   MATCH
KPI Repeated Incidents             31 = 31      MATCH
Highest Change Activity            50 = 50      MATCH
```

## 5. How do we measure loading performance against the existing reports?

**It is instrumented on every page, and the answer is mixed. The bad half is here
too.**

Every page reports the milliseconds it took to build and what it spent scanning.
Measured over HTTP as a logged-in session on dev390988, which is a shared
development instance that stalls under its own background jobs:

| Surface | Time |
|---|---|
| Catalog, subjects | ~4.6s |
| Catalog, saved reports | 4.0s |
| Subject dashboard, `problem` (544 rows) | 1.7s |
| Subject dashboard, `sys_user` (665 rows) | 1.0s |
| Subject dashboard, `change_request` (1,505 rows) | 3.7s |
| Subject dashboard, `incident` (4,266 rows) | 6.0s |
| Converted report | 4.5s |

**The stated budget is 1.2s to first paint and 2.5s to interactive. Small and
medium subjects meet it. Large ones do not.**

The cause is structural rather than a missing optimisation. A client-side fetch was
measured not to return on this instance — a Scripted REST call from a logged-in
browser session never comes back, and the platform's own Table API behaves the same
way from the same context — so everything is computed server side and embedded in
one response. First paint is therefore the whole server build. There is no
waterfall, which is good, and no way to paint before the slowest number is ready,
which is the cost.

Two routes close it, and both are named rather than promised: the UXF data broker,
which fetches through a different mechanism that has **not been tested here** and
is the phase one spike still owed; or caching the permission verdict per viewer.

This work did make real reductions, all measured: a dashboard on `sys_user` went
from 6.0s to 1.0s, `change_request` from 6.0s to 3.7s, and the catalog from 7.1s to
4.6s. The largest single cause was a cache guard written as `if (cache[key])` where
the cached value was an empty array — **an empty array is falsy in ServiceNow's
script engine**, so the cache never hit for any field without a choice list, and one
helper was costing 23.7ms per row against 0.46ms for the bare database cursor. It
was 98% of the page scan.

Against native reporting: a native single-chart report is faster than a COMMAND page
and should be, because it draws one chart from one indexed query while a COMMAND
page profiles every candidate dimension and draws nine to twelve panels. The
comparison worth making is not chart against chart, it is one COMMAND page against
the several native reports a leader opens to answer the same question.

## 6. Is there a limit, for example 5,000 report conversions?

**There is no batch conversion, so there is no batch to size.** A report is
converted when it is opened. There is no build step whose cost grows with the
library.

What does scale with library size is listing and reading definitions, and that is
measured rather than estimated:

- Reading and normalising **all 682 definitions: 1,271ms, or 1.86ms each.** At
  5,000 reports that is about **9.3 seconds** to process the entire library, and
  nothing in the product ever needs to do that in one go.
- The reports list is paged at 300 and reports its own truncation. Listing 60
  reports took 61ms.
- Opening one report costs one read of `sys_report` plus a normal page build.

So the honest boundary is not a report count. It is the per-page cost in question
5, which is a property of the table's size and its ACLs, not of how many reports
exist.

## 7. How are ACL, role and group permissions handled?

**Every number is permission-checked, every number carries a verdict, and this is
now proven live rather than argued.**

The problem being solved: `GlideAggregate`, which is what native ServiceNow
reporting and Performance Analytics indicators count with, does **not** enforce
row-level ACLs. There is no `GlideAggregateSecure`. So a native chart can show a
viewer a count that includes records they cannot open.

Measured live on 2026-08-15 against a genuinely role-less user, **with no change to
the instance's security configuration**:

| Table | Native reporting counts | User can actually open | Verdict shown |
|---|---|---|---|
| `incident` | 4,266 | **815** | FILTERED |
| `task` | 7,808 | **815** | FILTERED |
| `kb_knowledge` | 757 | **669** | FILTERED |
| `problem` | 544 | **0** | DENIED |
| `change_request` | 1,505 | **0** | DENIED |
| `sys_user` | 665 | 665 | VERIFIED |

On `incident` the native number overstates what this user may see by **3,451
records, 81%**.

Entitlement is enforced in three places, not one:

- **Cell values.** Every count comes from a permission-checked scan, or from an
  unchecked one only where a proof has already established the two agree for this
  viewer and this filter.
- **Catalog membership.** A viewer is not offered a subject they hold no readable
  rows in, and is never told the row count of one.
- **The report library.** `sys_report` holds private owner-scoped rows and is read
  through `GlideRecordSecure`. Admin sees 682 reports; the role-less persona sees
  **226**.

Drilling to the underlying records hands off to the platform's standard list view,
which enforces its own ACLs. We do not build a record grid, so we cannot get its
security wrong.

Two honest limits. A permission-checked count on a large table with expensive ACLs
may not finish inside the page budget, in which case the number is reported as a
floor and labelled BOUNDED rather than presented as exact. And group-level
restrictions are enforced by the platform's ACLs like any other; the product does
not model groups separately, it asks the platform per row.

## 8. Will drilldown be three levels or more?

**Three today.** It is one constant, `CmdDrill.MAX_DEPTH`, and raising it is a
one-line change rather than a redesign.

Three was chosen because each level must earn its place: a level is offered only
after passing fill-rate and cardinality gates **on the rows that viewer may read**,
and a rejected level shows why instead of being a dead click. In practice the
fourth level is usually rejected by those gates anyway, because the slice has become
too small or the next column too empty to say anything.

The drill path travels in the URL, so a drill state is shareable and the browser
back button reverses it. The terminal step opens the platform list view.

The real constraint on going deeper is question 5, not the constant: each step is a
full page rebuild at present, so depth costs latency. Raising the cap is a
half-hour change; making step four feel instant is the same fetch problem.

## 9. Do multiple-table queries affect conversion?

Reports on this instance read one table each, with related fields reached by
dot-walking, and that is what the converter handles: **the report's table and its
filter, executed as written**, including dot-walked conditions and dynamic clauses
such as `opened_by=javascript:gs.getUserID()`, which are evaluated as the viewer
because that is what they mean.

What is not handled, stated plainly: joining two tables into one result set with
columns from both. That is not a limitation of the converter, it is a property of
ServiceNow's data access — there is no cross-table semantic model to query, which
is also why "Power BI parity" is the wrong claim to make anywhere. Database views
exist and a report over one converts like any other table, because to the converter
it is just a table.

## 10. Can we customise the new design, add fields and queries?

**Not in this build.** A converted report is drawn from its saved definition and
the measured shape of its data. There is no way to add a field, change the filter,
pin a chart type, or save any of that.

Some of the machinery is there — the page already accepts a base filter and a lead
dimension as inputs, which is what a customisation layer would set — but the
surface to set them and the place to persist them do not exist. This is the same
gap as questions 1 and 2 and they are one piece of work, not three.

---

## What this build does not do

Kept separate and blunt, because the technical write-up goes to an audit team.

- **No authoring or customisation.** Questions 1, 2 and 10.
- **No export.** ServiceNow ships scheduled, emailable PDF and PPT export of
  dashboards today. COMMAND has no export, print or CSV path. This is a regression
  against the platform and will be the first thing asked for after a demo.
- **Not a scoped application.** It runs as Script Includes and UI Pages in the
  global scope. That means no clean uninstall, no Store route, no application
  menu, and no roles of its own. It works and it is not yet packaged.
- **The UXF spike is unrun**, so whether drilldown can meet an interaction budget
  is still open. It gates questions 5 and 8.
- **The 1.2s budget is missed on large subjects.** Question 5.
- **AI is not in this release**, by the client's own direction.
