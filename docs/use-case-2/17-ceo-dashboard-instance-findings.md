# CEO Dashboard — what it actually is, measured on the client instance

Measured **2026-09-07** against `eypocinst.service-now.com`, read-only (GET only, no
writes of any kind). Every number here is reproducible with the queries shown.

The question this answers is the one we could not answer from the screenshots:
*are the CEO dashboard's "reports" the same shape as the reports our engine
converts?* **They are not.** Details below, then what that costs us.

---

## 1. It is not a report. It is Control Tower.

`/now/ceo/summary` resolves to a **UI Builder (UXF) experience**, not `sys_report`:

| object | value |
|---|---|
| `sys_ux_page_registry` | `path=ceo`, title "CEO Dashboard", sys_id `f496a6badb42c910867d0472ba9619eb` |
| `sys_ux_app_config` | `06d62ebadb42c910867d0472ba9619a2`, landing_path `summary` |
| scope | **`sn_controltower` v3.0.1** (ServiceNow Control Tower, a Store app) |
| routes | `portfolio1` … `portfolio8`, plus `summary` and a workflow page |

Each portfolio page is one macroponent (~480 KB of composition JSON). The pages
carry no query of their own — they read a config table.

## 2. The config table is the whole dashboard

`sn_controltower_ceo_dashboard` — **72 active rows**, one per card:

```
business_function  = Portfolio1 … Portfolio8
metric_type        = Anchor1/2, Speed1/2, Productivity1/2, Risk1/2, Bubblechart
pa_indicator       -> pa_indicators
breakdown          -> pa_breakdowns   (bubble chart only)
```

So a "report" here is **(portfolio, slot) → PA indicator**. Nine slots × eight
portfolios. There is no chart type, no table, no filter stored on the page at all.

## 3. How a card gets its number

Data brokers on the page, all in the `sn_controltower` scope:

| broker | role |
|---|---|
| `getMetricsofFunctionalPage` | portfolio name → the nine indicator sys_ids |
| `getPAScore With Multiple Scores & forecast` | REST, takes `uuid` → `pa_indicators` |
| `getPAScorewithBreakdown` | REST, `uuid` + `breakdown` → the bubble chart |
| `TransformPAScoresAsInputToSparklineChart` | shapes scores into a sparkline |
| `getSystemProperty` | reads `sn_controltower.ceo_dashboard_*` properties |

The underlying API is the PA Scorecard API. **The filter parameter is
`sysparm_uuid`** — `uuid`, `indicator_sys_id` and `sysparm_query` are all silently
ignored and return an unfiltered list. This bit us twice; see §7.

## 4. An indicator *is* resolvable to our model

This is the load-bearing finding. The link field is **`cube`** (not `data_source`,
which is empty on every one of these):

```
pa_indicators.cube -> pa_cubes.facts_table + pa_cubes.conditions
pa_indicators.conditions    (extra filter, appended)
pa_indicators.aggregate     1=Count 2=Sum 3=Average 4=Minimum 5=Maximum 6=Distinct Count
pa_indicators.field
pa_breakdowns + pa_breakdown_mappings[facts_table] -> a real field
```

Portfolio1 resolves completely, every slot, to `incident`:

| slot | indicator | resolves to |
|---|---|---|
| Anchor1 | Number of open incidents | `incident` COUNT, opened/unresolved window |
| Anchor2 | Number of closed incidents | `incident` COUNT, `closed_at` today |
| Speed1 | Average age open incidents | **formula**: summed age ÷ open count ÷ 24 |
| Speed2 | % resolved by first assigned group | **formula**: `reassignment_count=0` ÷ resolved |
| Productivity1 | Number of resolved incidents | `incident` COUNT, `resolved_at` today |
| Productivity2 | Number of new incidents | `incident` COUNT, `opened_at` today |
| Risk1 | % open not updated in 30 days | **formula**: ratio of two counts |
| Risk2 | Average close time | **formula**: SUM(`calendar_duration`) ÷ closed ÷ 24 |
| Bubblechart | Number of new incidents | COUNT, breakdown `Priority` → `incident.priority` |

Breakdowns map cleanly: `Priority`→`priority`, `Category`→`category` on `incident`.

**Reproduction proof.** The dashboard shows "14k" for Anchor1. Running that cube's
own encoded query against `incident` live returns **14,013** (table total 14,072).
We can regenerate their numbers from their own definitions.

## 5. The dashboard is mostly empty, and that is not our doing

Swept all 72 slots through the scorecard API:

> **21 of 72 slots show a non-zero value. 51 are blank or zero.
> `pa_scores` contains 0 rows — not one indicator has any score history.**

- Portfolios **3, 4, 5 and 6** are the same indicator ("% of incidents resolved by
  first assigned group") repeated across all eight slots, every one blank. They are
  unconfigured duplicates.
- Portfolios 1, 2, 7, 8 carry the only real values (14k, 545, 95.74, 13k, 3,284,
  479.63, 95).
- With `pa_scores` empty, **the sparklines on every card are decorative** — the same
  shape repeats on every card of every portfolio. There is no trend data behind them.
- The values that do appear come from PA *real-time* scores, not collected history.

Most cube queries are scoped to **today** (`gs.beginningOfToday()`), and this
instance's incident data is not from today, which is why so much reads 0.

## 5b. Validated by reproduction, not by reasoning

Three tests against the client's own live values, as oracles:

| test | ours | PA's | verdict |
|---|---|---|---|
| Anchor1 open-incident count | **14,013** | "14k" | match |
| Risk1 `%` open not updated 30d (formula ÷ formula) | **95.69** | 95.74 | match (0.05 drift — PA's score is from 09:00) |
| Speed1 average age open (scripted → formula) | **545.1 days** | 545 | match (0.1 day) |

The Speed1 chain is the important one: it goes *scripted indicator → formula →
arithmetic* and still lands on their number. The "scripted" indicators are not a
wall — the script behind `Summed age of open incidents` is three lines:

```js
var diff=function(x,y){return y.dateNumericValue() - x.dateNumericValue();};
var hours=function(x,y){return diff(x,y)/(60*60*1000);};
hours(current.opened_at, score_end);
```

It is a per-record age-in-hours expression over a date field. All **6** scripted
indicators in the CEO set are age/duration variants of this shape, so they map to a
direct computation on the base table.

**Indicator census for the whole dashboard:** 27 root indicators → 9 formula, 26
leaf. Of the 26 leaves, **20 resolve to table+query+aggregate and 6 are scripted**
(all age/duration). Nothing is unreadable.

## 5c. There *is* real trend data — just not in PA

`pa_scores` is empty, but the base table is not. The 14,013 open incidents span
**2016-08 to 2026-09 across 37 distinct months**, with real recent variation:

```
2025-10:13  2025-11:22  2025-12:15  2026-01:22  2026-02:15  2026-03:17
2026-04:26  2026-05:14  2026-06:154 2026-07:201 2026-08:34  2026-09:63
```

So a trend line is drawable **on the client's own instance** from `opened_at`
directly, with no PA collection and no synthetic data. Our engine already computes
time series this way. Their sparklines are decorative; ours would be real.

## 5d. The PDI can host a faithful fixture

Control Tower is not installed on dev390988, but it does not need to be. The PA
indicators are OOB platform content with **stable sys_ids across instances**:

- **24 of 27** CEO root indicators exist on the PDI with identical sys_ids
- **14 of 14** formula components exist
- the 3 missing are plugin-specific (`Active Users`, `External Logins`,
  `AppSec-Total Number of Configuration Properties`) and none are used by Portfolio1

So the only thing to recreate locally is the **72-row config table** — four columns,
pointing at indicator sys_ids that are already there. **Portfolio1 is fully
reproducible on the PDI.**

## 6. What this costs us — the honest gaps

1. **Formula indicators.** Five of Portfolio1's nine slots are ratios of two other
   indicators. Our engine has no derived-measure concept; it computes one aggregate
   per panel. Conversion needs a formula evaluator (÷, ×, constants, nested
   indicator refs) plus 6 age/duration recognizers. **Validated in §5b** — both
   formula cards tested reproduce PA's own number.
2. ~~No trend data.~~ **Superseded by §5c** — trends are computable from the base
   table on the client's instance. What is genuinely absent is *PA's* history, which
   we do not need.
3. **ACL divergence is expected, and is the point.** PA scores are precomputed
   aggregates that bypass row-level ACLs entirely. If we recompute ACL-correctly,
   our number will differ from theirs for any non-admin viewer. That is our
   differentiator, but it must be *presented* as reconciliation, not as a bug.
4. ~~Control Tower is not installed on our PDI.~~ **Superseded by §5d** — it does
   not need to be. Only the 72-row config table must be recreated; the indicators are
   already present with matching sys_ids.
5. **The one real remaining gap: aggregate codes are easy to get wrong.** The
   correct map is `1=Count 2=Sum 3=Average 4=Minimum 5=Maximum 6=Distinct Count`.
   An earlier draft of this document had 3/4/5 as Max/Min/Avg, which would have
   silently mislabelled any Average indicator. Read them from
   `sys_choice[name=pa_indicators, element=aggregate]`, do not hardcode from memory.

## 7. Two traps that produce confident nonsense

Both hit during this session and both would have shipped a wrong answer:

- **ServiceNow silently ignores unknown fields in `sysparm_query`.** A query on a
  column that does not exist returns *everything*, not an error. `sys_ux_app_route`
  has no `route` field; querying it returned 30 unrelated rows that looked like data.
  **Always resolve columns against `sys_dictionary` first.**
- **The PA Scorecard API ignores unknown parameters the same way.** Only
  `sysparm_uuid` filters; `uuid` returns a full unfiltered list whose first row looks
  like a plausible answer.

Same failure family as the `gs.impersonate()` lesson in CLAUDE.md: a test that finds
nothing wrong should be assumed broken before the instance is.
