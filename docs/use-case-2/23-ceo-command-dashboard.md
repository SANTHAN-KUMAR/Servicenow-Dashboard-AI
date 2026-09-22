# The CEO Dashboard, on one page — built, measured, and compared

Built overnight 2026-09-13/14 on dev390988, in the scoped app `x_2185255_command`
(COMMAND Analytics 0.2.0). Every number in this document was measured on that
instance on 2026-09-14 unless it says otherwise, and every measurement below can be
repeated with the command beside it.

**URL:** `https://dev390988.service-now.com/x_2185255_command_cmd_ceo.do`
(also under *COMMAND Analytics → CEO Dashboard* in the navigator)

---

## 1. What the client asked for, and what it became

On 2026-09-13 the client asked for *"ceo dashboard front page and navigation page
all in one page with multiple section"*, and sent references: three Power BI
screenshots — a tile grid, a circle navigator where clicking a circle opens its
detail, a hidden slicer panel — and the incometax.gov.in hero, a globe with services
on an orbit ring. They also said they want to compare our portal and theirs side
by side, the CEO dashboard first.

Their Control Tower app is two hops: a Summary page, and a header menu that swaps
the whole screen for each of eight portfolios (`22-ceo-dashboard-summary-and-navigation-live.md`).
The new page holds all of it:

| section | what it is |
|---|---|
| **Overview** | the orbit: the enterprise headline at the centre (open incidents, with a gauge of where it sits in its own 12-month range), the eight portfolios as orbs on the ring in the source's own portfolio1→8 order, each with its anchor measure and three Speed / Productivity / Risk pips. Beside it, *What moved*: the largest changes against the previous period, worse first, judged by each indicator's own PA direction. |
| **Pulse** | the client's Summary page — Speed1 / Productivity1 / Risk1 for all eight portfolios — as one grid, each cell with its value, change and history, so portfolios can be compared. |
| **Portfolios** | the chosen portfolio's full eight slots as cards, plus its breakdown slot (PA's bubble chart) drawn in the form the data supports, opened **in place** from the orbit, the pulse or the tabs. |
| **Trends** | twelve months of opened / resolved / closed incidents, the open backlog at each month end, and the emergency-change share — from the same measures as the cards. |
| **Trust** | per table, what this viewer can read, and how every number was counted. |

Top bar: section navigation, period (Today · 7D · 30D · 90D · 12M), a slide-in
filter panel (priority, category, assignment group), refresh with an "as of" time,
copy-link, present mode, PDF and CSV export, light/dark.

Screenshots: `ceo-dashboard-screens/` (dark full page, light, phone, and the analysis
a card opens).

## 2. Side by side with the client's Control Tower

Their side is from read-only evidence gathered on eypocinst (docs 17 and 22). We
had no access to eypocinst tonight, and it was not needed for anything except a
fresh number check (§6); nothing was installed on it and none of its pages were
rendered (rendering a portfolio page there writes a system property —
`sn_controltower.ceo_dashboard_portfolio*_links` — which is why no screenshots were
taken of it).

| Control Tower today | this page | the difference |
|---|---|---|
| Summary page + header menu; each portfolio is a full screen swap | one page; orbit, pulse and tabs all open the portfolio in place; URL holds the state | the "front page and navigation on one page" ask, literally |
| a Process Flow Map with 24 edges portfolio1→8 and **no nodes** (one edge still reads "Add random text here..") | the orbit ring is that flow, drawn and working | their unfinished diagram, finished |
| Summary shows Speed/Productivity/Risk × 8 portfolios | Pulse grid, plus orbit pips | comparable at a glance, with change and history |
| portfolios 3–6: one indicator repeated in every slot, 12 identical Summary tiles, **unlabelled** | drawn faithfully and **marked**: dashed orbs, "one measure, repeated", a note on the page | a configuration fault reported, not reproduced silently |
| most measures are defined for *today*: 51 of 72 slots blank or zero on the client (doc 17) | every card shows the chosen period **and** PA's own today value | the matching number is never hidden; the useful one is added |
| sparklines on every card with **no score history** behind them (`pa_scores` = 0 rows) | daily (30 days) or monthly (12 months) lines counted from the records | real history |
| PA scores: computed once, row-level security bypassed | every number counted at page load against the viewer's own access, verdict per table | the engagement's differentiator, on the CEO page |
| the bubble chart | the breakdown in the form the data supports, drillable to an analysis of that value | a click goes somewhere |
| real portfolio names, from a broker (`sn_controltower.ceo_dashboard_portfolionames`) | names from `x_2185255_command.ceo_portfolio_names`; until set, the source keys ("Portfolio 1") | **not yet equal** — we could not read their names tonight; one property to set |
| headline "Total workflows" / "Total Workflow Products" from two REST brokers | centre orb = a configurable indicator, default *Number of open incidents* | **not yet equal** — what their counters count was not readable tonight |

## 3. Native dashboard features, and ours

| native Platform Analytics dashboard | here |
|---|---|
| tabs / pages | sections with scroll-spy, portfolio tabs, orbit navigation |
| interactive filters | filter panel; applied to every measure whose table has the field, the rest marked, applicability counted on screen |
| time range | period selector; PA's today always shown alongside |
| breakdowns | the configured breakdown per portfolio; click a value to analyse it |
| scorecard change vs previous, with direction | delta against the previous period (flows) or N days ago (stocks), green/red by the indicator's own direction |
| drill to records | *Analyse* opens our analysis over the same rows (period and single-value filters carried as drill steps); *Records* opens the platform list with row-level security enforced |
| refresh | refresh button, bypassing the per-viewer memory; "as of" time |
| export | PDF (print stylesheet, light, orbit included) and CSV (every measure, with its verdict and filter state) |
| share | copy-link; the URL is the state |
| full screen / wall | present mode: full screen, cycles the sections and every portfolio, recounts every 5 minutes |
| widget info | an ⓘ on every card: formula in words, which records, period semantics, direction, access, filter state |
| role-based access | `ceo_viewer` role gates the page, the navigator module, the catalog cards **and** the GlideAjax endpoint |
| responsive | phone layout: the orbit becomes a grid; no horizontal scroll at 420 px (measured) |
| light / dark | both; the CEO page opens dark unless the viewer has chosen |
| **not here** | scheduled / emailed export and PPT export (native ships both — parity work, not a gap); per-user layout editing (the layout is configuration); PA targets/thresholds colouring (2 threshold records exist on the PDI; direction is used instead) |

## 4. How it is built, and why

- **The page paints before it counts.** `cmd_ceo.xhtml` builds only the frame
  (`CmdCeoBoard.frame()`: portfolios, slots, names, units, filters — 118–213 ms of
  configuration reads) and embeds it. Numbers arrive over **GlideAjax**
  (`CmdCeoAjax`), which was measured to work from a scoped UI Page here (the XHR
  failure on record was raw XHR to Scripted REST on eypocinst; GlideAjax is the
  platform's own form channel).
- **One query per measure.** A card needs today, the period, the previous period,
  30 days and 12 months. One GlideAggregate trended by day over the span answers all
  of it (77 ms for 400 days of incidents).
- **Periods widen exactly one clause.** `ceoClassify` finds the single clause pinning
  a date to today and widens only that; PA's "open as at today" OR-group is
  recognised as a stock and left alone; a RELATIVE clause means no as-of history is
  claimed. 64 offline tests (`test_ceo_board.js`).
- **Permission checking is unchanged.** Each table is proved once per request
  (`CmdData.aclVerdict`); trusted viewers take the aggregate path, others a time-boxed
  `GlideRecordSecure` scan, labelled BOUNDED if the box ran out.
- **Per-viewer memory.** Each indicator's result is remembered in the session for
  three minutes, keyed by viewer, period and filters; the page embeds whatever a
  returning viewer already has.
- **Scope-correct links.** Catalog and dashboard links now carry the scope prefix;
  before this, links from the scoped catalog opened the global fallback pages.

## 5. Performance, measured

Headless Chrome against dev390988, admin, `product/tests/browse.mjs`.

| | measured |
|---|---|
| frame, server | 118–213 ms |
| page painted (layout, labels, skeletons) | 0.65 s (warm browser cache) – 1.4 s (cold) |
| orbit numbers in (first call returns) | 1.9–2.1 s after the page starts |
| every number in, new session | 5.1–6.2 s |
| **returning viewer, reload** | **0.82–1.04 s, complete** (every number embedded) |
| period change | 1.4 s |
| page transfer | 29 KB (the platform's own UI Page chrome is most of the 112 KB decoded) |

**Why cold is not faster:** GlideAjax calls from one session are served **one at a
time** — measured: two calls sent together returned at 3.4 s and 4.7 s. The cold
cost is mostly the first permission proof per table (incident ≈ 1.2 s), paid once
per three minutes per viewer. So the calls are ordered for what the eye needs first:
the orbit (`hero`), then the Summary (`pulse`), then the rest.

## 6. Accuracy

- `product/tests/verify_ceo_numbers.py`: **48 checks, 0 mismatches.** Every card's
  *today, PA definition* value equals `CmdCeo.value()` — the resolver checked against
  the client's own PA scores on 2026-09-07 (11 matches, 0 mismatches) — and every
  period value equals an independent GlideAggregate over the widened query. Six
  checks are where the board answers what that resolver refuses (a distinct count;
  sums of elapsed time over no records, which are 0 h, not unknown).
- `product/tests/acceptance_live.py`: **21/21**, including: a card's analysis counts
  exactly the card's rows (357 = 357); an injected filter (`^OR`) and a bogus period
  are refused; the breakdown returns a panel.
- Offline: **643 tests pass** (`product/tests/run_all.sh`).
- **Not re-run tonight:** `oracle_ceo.py` against eypocinst — no access. Re-run it
  before the side-by-side is shown; it is read-only.

## 7. Personas, and the ACL claim, re-measured live (2026-09-22)

`setup_app.py` creates two demo logins (password in `product/deploy/credentials.json`,
gitignored, key `demo_password`):

- **ceo.leader** (ceo_viewer + itil): incidents, changes, problems, requests all
  VERIFIED; PA's job-log table is closed to itil, so the two PA-housekeeping cards
  on Portfolios 7 and 8 say *you cannot read any of the records behind this measure*.
- **ceo.restricted** (ceo_viewer only, no other roles — the "role-less" persona):
  sees **no incidents at all** — and not because of a row-level ACL. The OOB
  `incident query` before-query business rule restricts a user without itil /
  sn_incident_read to their own incidents **when the session is interactive**
  (`gs.isInteractive()`), and it restricts `GlideAggregate` on `incident` too.

**The 2026-09-14 note below flagged this needed re-testing in a real browser
session, not a background script. Done today, six tables, both personas, real
form-login sessions (not `GlideImpersonate`):**

| table | native count (GlideAggregate) | ceo.restricted can open | verdict |
|---|---:|---:|---|
| `incident` | 0 | 0 | **VERIFIED — no gap on this table for this persona.** The query business rule above restricts the native aggregate too, in a real interactive session. The old 4,266-vs-815 claim does not reproduce here; retire it. |
| `problem` | 544 | **0** | **DENIED.** Clean, fully proven (not a floor). |
| `change_request` | 1,505 | **0** | **DENIED.** Clean, fully proven. Screenshots: `ceo-dashboard-screens/leader-change_request-verified.png` (1,505 records, full analysis) next to `restricted-change_request-denied.png` (same URL, same table, "This subject holds 1505 records and your permissions do not admit any of them"). |
| `task` | 8,838 | 124 (floor — scan capped) | BOUNDED |
| `kb_knowledge` | 757 | 435 (floor — scan capped) | BOUNDED |
| `sys_user` | 668 | 668 | VERIFIED — correctly no gap |

**What this means for the client story:** the mechanism is not weaker than
claimed — it's stronger, because it's now demonstrated with a real login instead
of a background-script trick, and the cleanest example (`change_request`: 1,505
vs 0, same page, same URL, two real logins) needs no caveats about scan bounds
or impersonation quirks at all. **Use `change_request` or `problem` for the
demo, not `incident`.**

Repeatable with `python3 product/tests/verify_acl_live.py` — real form login,
no admin, no impersonation, both personas, all six tables, one command:

```
  ceo.leader
    incident         VERIFIED  native=  4284  readable=  4284
    problem          VERIFIED  native=   544  readable=   544
    change_request   VERIFIED  native=  1505  readable=  1505
    task             BOUNDED   native=  8838  readable=  1119
    kb_knowledge     BOUNDED   native=   757  readable=   437
    sys_user         VERIFIED  native=   668  readable=   668

  ceo.restricted
    incident         VERIFIED  native=     0  readable=     0
    problem          DENIED    native=   544  readable=     0  <-- native says 544, this viewer opens 0
    change_request   DENIED    native=  1505  readable=     0  <-- native says 1,505, this viewer opens 0
    task             BOUNDED   native=  8838  readable=   146
    kb_knowledge     BOUNDED   native=   757  readable=   435
    sys_user         VERIFIED  native=   668  readable=   668
```

## 8. Configuration

| property | default | |
|---|---|---|
| `x_2185255_command.ceo_portfolio_names` | empty | JSON, e.g. `{"portfolio1":"Service Operations"}` |
| `x_2185255_command.ceo_default_period` | `30d` | today, 7d, 30d, 90d, 12m |
| `x_2185255_command.ceo_headline_indicator` | empty | a pa_indicators sys_id; empty = Number of open incidents |
| `x_2185255_command.ceo_source_table` | `sn_controltower_ceo_dashboard` | set to `u_cmd_ceo_dashboard` on the PDI only; **not** in the update set |

Roles: `x_2185255_command.ceo_viewer` opens it; `x_2185255_command.admin` contains it.

**Deploy, set up, package:**
```
python3 product/deploy/deploy.py --scope x_2185255_command
python3 product/deploy/setup_app.py
python3 product/deploy/package.py --version 0.2.0   # product/dist/COMMAND-Analytics-0.2.0-update-set.xml
```

## 9. A five-minute demo

1. Open the CEO Dashboard. The layout is there immediately; the orbit fills first.
2. Point at the centre: open incidents, the change against 30 days ago, where it sits
   in its 12-month range. Point at *What moved*.
3. Click Portfolio 7 on the orbit: its eight cards open in place. On a card, point at
   *Today, PA definition* — the number the source dashboard shows — and at the
   period value beside it. Open ⓘ.
4. Switch to 12M; open Filters, pick Priority 1, apply — 21 measures filtered, 3
   marked as on tables without the field.
5. Scroll to Portfolios 3–6: marked as one indicator repeated, as the source is
   configured.
6. Trust: the per-table verdict.
7. **The ACL proof, the sharpest moment of the demo.** Open a second window
   logged in as `ceo.restricted`. Navigate both windows to
   `cmd_dashboard.do?table=change_request`. Leader's window: 1,505 records, full
   analysis, ACL VERIFIED. Restricted's window, same URL: *"This subject holds
   1505 records and your permissions do not admit any of them."* Same page, same
   code, same instant — the only thing that changed is who's logged in. This is
   what a native PA scorecard or GlideAggregate-based report cannot do: it would
   show 1,505 to both of them. Screenshots pre-captured at
   `ceo-dashboard-screens/leader-change_request-verified.png` and
   `restricted-change_request-denied.png` if you want a fallback that doesn't
   depend on a live second login.
8. Present mode for the wall; PDF for the inbox.

## 10. Still open

- Their portfolio names and the Summary header counters: readable from eypocinst
  in about fifteen minutes of read-only GETs, once access returns.
- `oracle_ceo.py` against eypocinst, before the side-by-side.
- ~~The incident overstatement figure, re-measured interactively.~~ **Done
  2026-09-22** — see §7. `incident` itself no longer demonstrates a gap for a
  real interactive login (the platform's own business rule already restricts it);
  `change_request` and `problem` do, cleanly, and are now the ones to use.
- Cold load is bounded by the first proof per table; a per-user proof memory that
  survives a new login would remove most of it, and is a decision about how long a
  permission proof may be trusted, not an engineering one.
