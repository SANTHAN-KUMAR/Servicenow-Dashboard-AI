# End-to-end audit, 2026-09-09

Commissioned as a full review of the delivered product — "not just API probing,
live eyeball check and verification as well." Every finding below was reproduced
against `dev390988`, and every visual finding was found by rendering the page the
instance actually serves in a real browser and looking at it.

**Method.** Three layers, because the first two had been passing while the page
was wrong:

1. **Drift.** Every deployed artefact read back and compared byte for byte against
   the repo, in both the global and the `x_2185255_command` scoped deployment.
   No drift: 9 script includes, 3 client assets, 2 pages, identical in both.
2. **Payload.** `smoke_live.py` over 11 tables × 4 windows (45 fetches), plus the
   offline suites.
3. **Eyeball.** The served HTML fetched over an authenticated session, its
   `.jsdbx` assets fetched from the URLs the page itself requests, and the result
   rendered in headless Chrome and screenshotted at full page height. This layer
   found everything the other two missed, which is most of what follows.

The scripts are in the session scratchpad, not checked in; the two that are worth
keeping are described at the end.

---

## What was wrong, and what it cost

### F1. The page stated a fact about 8,503 records having read none of them

**Severity: highest. This is the failure this engagement exists to prevent.**

The `task` dashboard printed six of these:

> every record here has the same **active**
> every record here has the same **approval**
> every record here has the same **contact type**

Live truth on the same instance:

| field | live distribution |
|---|---|
| `active` | true 7,380 · false 1,123 |
| `approval` | 5 values (8,260 / 129 / 101 / 11 / 2) |
| `contact_type` | 8 values |
| `reassignment_count` | 8 values |

The mechanism, proved by running the gate directly on the instance:

```
field=active  offer=false  reason="every record here has the same active"
              distinct=0  profTotal=0  profRows=0  profCapped=true  profMode=BOUNDED
```

`task` is expensive to permission-check, so `CmdData.profile` spent its whole
scan budget before admitting a **single row**. `_shape` returned `distinct: 0`
over `total: 0`, and `CmdDrill.gate` read `0 < MIN_DISTINCT` as a measurement of
uniformity. It also returned `fill: 1` — "fully populated" — from the same zero
rows.

So a measurement of nothing became a universal claim about everything, printed in
the same calm voice the product uses for numbers that are real. That is worse
than a wrong number: a wrong number invites checking, and this did not.

**The rule now encoded: a bounded scan proves presence and never absence.**
Every gate rejection except `MAX_DISTINCT` concludes that something is *not*
there, and no such conclusion survives a scan that stopped early — the rows it
never reached are exactly the ones that would overturn it. Two directions do
survive, because they are lower bounds: a prefix already holding enough distinct
values proves the slice does, and one already holding too many proves that too.

- `CmdData._shape` now carries `measured` and `capped`. `measured` is false when a
  capped scan admitted no rows, which is the one case indistinguishable from a
  genuinely empty slice and means the opposite.
- `CmdDrill.gate` refuses to generalise from a capped profile. Where the scan read
  nothing it says so; where it read some rows it scopes the claim to them
  ("the 300 records read before the scan stopped all share one Active, which is
  too few to tell whether the rest do").
- `product/tests/test_drill_gates.js`, 25 assertions, pins the asymmetry.

### F2. A gap in the data was drawn as a collapse in the business

The headline card on every incident page read **4,284 ▼100%**, in red.

The newest incident on the instance is dated `2026-08-28`; today is `2026-09-09`;
September holds **zero**. The pace projection divides what has arrived by how much
of the window has elapsed — sound while something has arrived, meaningless when
nothing has. `0 / 0.291 = 0`, so the card computed a −100% change and printed it
with the same confidence it would use for a real collapse.

Three charts carried the same artefact:

- the trend line plunged to zero, with a forecast band rising off the zero point;
- the 100%-share stream chart collapsed to 0% across every category at once — the
  most alarming shape a dashboard can make, and here it meant only that the month
  had not happened yet;
- the backlog area sat at 0 for six months (see F7).

Fixed:

- `CmdAnalysis` drops the comparison when the current partial period is empty and
  says why, rather than asserting a change it has not measured.
- `CmdAnalysis.trendByGroup` trims trailing empty periods **from the `stream` form
  only**. A share of nothing is not a share. Zero is a real count on a line and a
  real absence on a small multiple; it is undefined only on a proportion. Interior
  gaps are left alone — a hole in the middle of a window is a fact about the data.

### F3. The client's report: "each portfolio will have different stuff, not same incident analyst report page"

Reproduced exactly. Every one of the eight CEO portfolios rendered as:

```
INCIDENT
Incident analysis
4,284 records  ·  built in 3926ms          [Open record list] [All subjects]
```

`CmdCeo.portfolio` sets `subject` to whichever table most of the cards happen to
rest on, and the renderer built the entire header from `subject`. So Portfolio 2 —
whose leading two cards are *request* benchmarks — announced itself as an incident
page, as did Portfolio 7, which carries problem and change benchmarks. The cards
underneath were already different. Only the frame around them lied, and the frame
is what a reader sees first.

The same fault ran one level down: a measure opened from a portfolio card is
`builder.dashboard('incident', …)` underneath, so all sixty-four routes into the
measure view were headed "Incident analysis" too, with only a bar below the title
saying which measure it was.

Fixed:

- `payload.ceo` now carries the portfolio's own identity — label, measure count,
  and the tables its cards actually rest on, counted from the resolved cards
  rather than guessed. A portfolio reads `CEO Dashboard › Portfolio 2 /
  **Portfolio 2** / 6 measures · on incident`, and the whole-table record link is
  gone, because its cards each count a different query and several a different
  table.
- A measure page is titled with the measure and breadcrumbed through its
  portfolio.
- The catalog now offers **all eight** portfolios (`x_2185255_command.ceo_portfolios`),
  where it previously offered only Portfolio 1.

**One part of this is not ours to fix, and saying so is the point.** Portfolios
3–6 are the same indicator repeated across all eight slots. That is faithful:
`17-ceo-dashboard-instance-findings.md` §5 recorded it on the client's own
instance as unconfigured duplicates. Left silent it reads as our bug, so the page
now says it:

> Every card slot in Portfolio 4 points at the same indicator in the source
> configuration, so this page has one measure repeated rather than 8 different
> ones. That is how the portfolio is configured on the source dashboard, not a
> result of redrawing it.

### F4. The gauge was not a card

`drawGauge` returned a bare `<svg>` straight into the KPI grid: no card
background, no field label, and laid out on the 520-wide *panel* viewBox while
sitting in a quarter-width tile. On screen that was a graphic floating between two
cards with "median" hanging off its left edge and the caption `mean of 4,281,
target 100` printed straight through the arc's own `0` and `100` end labels.

Rebuilt as a `.kpi` tile with its own viewBox, its own value size, and every word
moved out of the SVG into HTML below the arc, where the browser lays it out and it
cannot collide by construction.

### F5. Half-width panels never paired

Panel order is meaningful — `CmdPayload` ranks builders by usefulness and the
renderer follows exactly — so halves separated by full panels each landed alone
in a two-column row. On the incident page that was two holes about 700px wide; on
`task`, whose only content is one half-width drill panel, it was a page that
looked broken. `packGrid` walks the grid's own children after they exist and
widens any half with nothing beside it. Nothing is reordered.

### F6. The scatter's axis title printed through its own tick labels

The last x tick is centred on `p.x1` and the axis title ended on `p.x1`, both at
`p.h - 30`. Rendered: `6.75Reassignment count9`. Ticks moved under the plot, title
onto its own row.

---

## Found, not fixed — these are judgement calls, not defects

**The `task` subject is still empty, and the catalog still offers it.** The page
is now honest about why (it says the scan ran out of time before reading any
rows) but it draws nothing. `SCAN_ALLOWANCE_MS` is 6,500 and the proof alone
exhausts it on 8,503 rows. Raising the budget fights the performance target;
dropping the card hides a real subject. Worth a decision.

**Performance is outside the stated budget.** CLAUDE.md §8 names first paint under
1.2s and interactive under 2.5s. Measured server build times across 45 fetches:
worst 13,080ms, and `incident` between 10.5s and 13.1s at every window. This is
server-side build before a byte reaches the browser, so it *is* the wait a viewer
feels. It is not a regression and it is not new; it is unmet.

**The catalog understates every subject.** Cards read `Task 48+`, `Incident 210+`,
`Configuration Item 300+` where the tables hold 8,503, 4,284 and 3,581. The `+`
is honest — the card count is a 160ms permission-checked scan — but a client who
opens `Incident 210+` and lands on `4,284 records` has two numbers for one thing
and no way to reconcile them. Cards are also *ordered* by that scan count, so the
catalog is effectively sorted by scan throughput rather than by size.

**Four catalog cards have no distribution bar**, leaving a hole in the card:
`cmdb_ci`, `cmdb_ci_computer`, `alm_asset`, `ast_contract`. Their lead preview
dimension is `attestation_status`, which is 3,275 blank against 306 set — the
preview is correctly refused, but no second dimension is tried.

**The backlog panel picks a degenerate date pair.** "How much is still open at the
end of each month?" uses `sys_created_on → opened_at`, which on `incident` are a
mean of 24 hours apart, so it reports a backlog of ~0 across six months on a table
holding 4,284 records. The right pair is opened → resolved/closed.

**The scatter panel is drawn on data with no spread.** `child_incidents` is 0 on
all but three rows, so the chart is a line of dots at y=0 and the caption says so
(`r = -0.017`). The form was chosen legitimately; the shape gate should refuse a
scatter whose y-axis has two distinct values.

**`task` holds records dated 2027-11-03**, more than a year in the future. Seed
data, but it distorts any window.

---

## What was verified working

- **The ACL differentiator, visually, as a role-less user.** Payload built on the
  instance under `GlideImpersonate` (the only call that applies row-level ACLs in
  a background script — see CLAUDE.md §5) and rendered with the deployed
  renderer. On `problem`: aggregate 544, secure 0, and the page shows a red **NO
  ACCESS** chip over *"This subject holds 544 records and your permissions do not
  admit any of them, so there is nothing to show."* Native reporting shows 544 on
  that same table for that same user. `f2_persona_test.py` passes.
- **Drilldown.** `incident → category:software → priority:3`, counts 4,284 →
  1,022 → 429, breadcrumb, removable filter chip, and the chart form adapting
  (stream → small multiples at 11 categories).
- **Verdict stability.** Four identical requests each on three tables, identical
  verdict and headline every time.
- **27 distinct chart forms live** across the 11 subjects.
- **No poison text, no zero-byte pages, no dead assets** across 45 fetches.
- **554 offline assertions** across 8 suites, plus the 25 new ones.

---

## Reproducing this

```bash
bash product/tests/run_all.sh                    # offline, ~5s
python3 product/tests/smoke_live.py              # 45 live fetches
python3 product/deploy/f2_persona_test.py        # the ACL claim, as a real persona
python3 product/deploy/deploy.py --dry-run       # validate without writing
```

The eyeball layer is worth keeping and is not yet checked in. It is about 80 lines:
authenticate, `inst.fetch()` the page, `inst.fetch()` each `.jsdbx` the page
references, rewrite those `src`s to local copies, render in headless Chrome with
`--screenshot`, and read the image. Everything in F2 through F6 was invisible to
the payload assertions and obvious in the first screenshot.
