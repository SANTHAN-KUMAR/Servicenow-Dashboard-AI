# Live report inventory: what the instance actually draws

Pulled 2026-08-01 from the live instance via the ServiceNow enterprise-graph MCP,
querying `sys_report` directly. Every number below is a measured row count, not an
estimate and not documentation.

This exists to answer a specific question: *"we don't know what charts or analysis
each report has, so how do we know which graph belongs to which category?"*

**The short answer: nothing on the instance records that, because no such mapping
exists.** Form is whatever the report's author picked at authoring time. The
evidence for that claim is in §3, and it is the strongest argument yet for a
shape-driven selector.

---

## 1. Chart type distribution

2,368 reports, 24 distinct types.

| Type | Reports | Share | Cumulative |
|---|---:|---:|---:|
| `single_score` | 756 | 31.9% | 31.9% |
| `bar` | 486 | 20.5% | 52.4% |
| `list` | 287 | 12.1% | 64.6% |
| `horizontal_bar` | 180 | 7.6% | 72.2% |
| `line` | 124 | 5.2% | **77.4%** |
| `pie` | 106 | 4.5% | 81.9% |
| `donut` | 88 | 3.7% | 85.6% |
| `heatmap` | 85 | 3.6% | **89.2%** |
| `trend` | 66 | 2.8% | 92.0% |
| `line_bar` | 42 | 1.8% | 93.8% |
| `pivot_v2` | 38 | 1.6% | 95.4% |
| `spline` | 37 | 1.6% | 96.9% |
| `pivot` | 25 | 1.1% | 98.0% |
| `semi_donut` | 12 | 0.5% | 98.5% |
| `map` | 8 | 0.3% | 98.8% |
| `calendar` | 6 | 0.3% | 99.1% |
| `pareto` | 4 | 0.2% | 99.2% |
| `solid_gauge` | 4 | 0.2% | 99.4% |
| `box` | 3 | 0.1% | 99.5% |
| `angular_gauge` | 3 | 0.1% | 99.7% |
| `bubble` | 3 | 0.1% | 99.8% |
| `area` | 3 | 0.1% | 99.9% |
| `step_line` | 1 | 0.04% | 100% |
| `vertical_bar` | 1 | 0.04% | 100% |

**Read this two ways, and keep both.**

- *Against the "OOB is limited" claim:* 24 types is not a small palette. The
  falsified "six chart types" figure stays falsified. Do not resurrect it.
- *For the "OOB is not used richly" claim:* five types carry **77.4%** of all
  reporting, eight carry **89.2%**, and the bottom eleven types together account
  for **2.0%**. The richness is available and almost entirely unused.

**What is absent entirely.** No sankey, no stream/themeRiver, no bump, no radar,
no treemap, no sunburst, no network/graph, no waterfall, no ridgeline, no
parallel-coordinates. These are not rare on the instance; they have **zero**
instances because the platform cannot draw them. That is the honest,
evidence-backed version of the differentiation argument: argue from *kind*, and
now from *measured usage*, never from count.

## 2. Aggregate and group-by distribution

| Aggregate | Reports | Share |
|---|---:|---:|
| `COUNT` | 1,772 | 74.8% |
| `SUM` | 222 | 9.4% |
| `AVG` | 160 | 6.8% |
| `COUNT(DISTINCT` | 146 | 6.2% |
| *(none)* | 67 | 2.8% |
| `MAX` | 1 | 0.04% |

| Group-by field | Reports | Note |
|---|---:|---|
| *(none)* | 874 | 36.9% of all reports have no group-by at all |
| `active` | 200 | boolean, 2 distinct |
| `state` | 95 | ordinal choice |
| `assigned_to` | 53 | reference, high cardinality |
| `priority` | 53 | ordinal choice, 5 distinct |
| `category` | 52 | nominal choice, ~10 distinct |
| `sys_class_name` | 30 | nominal, high cardinality |
| `sys_created_on` | 26 | datetime |
| `type` | 23 | nominal choice |
| `assignment_group` | 12 | reference, medium cardinality |

Three quarters of all reporting is a `COUNT`, and over a third has no dimension
at all. The analytical surface is far narrower than the type list suggests.

## 3. The finding that matters: form is not a function of anything

Cross-tabulating group-by field against chart type, for three fields whose correct
visual treatment is not genuinely ambiguous:

**`priority`** (ordinal, 5 values, part-to-whole or ranked) is drawn **nine
different ways** across 53 reports:

| Form | Count |
|---|---:|
| `horizontal_bar` | 15 |
| `bar` | 10 |
| `donut` | 7 |
| `heatmap` | 5 |
| `pivot_v2` | 5 |
| `line` | 4 |
| `pie` | 3 |
| `single_score` | 3 |
| `trend` | 1 |

**`category`** (nominal, ~10 values, ranked) is drawn **eleven different ways**
across 52 reports: `bar` 14, `pivot_v2` 10, `pie` 6, `horizontal_bar` 5, `list` 5,
`single_score` 3, `trend` 3, `donut` 2, `line` 2, `heatmap` 1, `pivot` 1.

**`sys_created_on`** (a datetime, so a time series) is drawn as `single_score`
**20 times out of 26**, `bar` 5 times, `pivot_v2` once. Not one `line`, `trend`,
`spline` or `area` report groups by it.

That last row is the clearest statement of the problem available. The platform's
own reporting draws a **time field as a scalar 77% of the time**, and a five-value
ordinal field as a line chart four times.

**Conclusion.** There is no field-to-form mapping stored anywhere on the instance,
because there is no such logic in the product. `sys_report.type` records what an
author chose, not what the data warranted. Any attempt to "read the existing
category-to-graph mapping off the instance" fails, not for lack of access but
because the mapping does not exist.

This settles the design question. A shape-driven selector is not one option among
several; it is the only approach with a defensible input.

## 4. What the selector can actually read

All three inputs already exist and need no human tagging:

| Input | Source | Already built? |
|---|---|---|
| Field data type (boolean / choice / reference / datetime / numeric) | `sys_dictionary.internal_type` | no, trivial |
| Distinct count, top share, concentration | `profileField()` in `EYAIDashData` | **yes, already computed** |
| Aggregate function | the report/widget definition | yes |
| Row count *n* behind the aggregate | `GlideAggregate` / ACL-checked count | **yes, already computed** |

`profileField()` currently computes cardinality and concentration and then uses
the result only to print a caption. Wiring that output to a form-selection table
is a small change against work already done, and it is the change the client
independently asked for.

## 5. Real dashboard inventory

The catalog surface has real entries to list. Sample of 25 from the dashboard
table, with owners:

`Admin Console`, `Incident Overview`, `Change Overview`, `IT Manager`,
`CMDB Dashboard - CMDB View`, `CMDB Correctness Dashboard`,
`CMDB Completeness Dashboard`, `Software Asset Management Foundation`,
`SPM Data Migration Dashboard`, `Usage Overview`, `Legacy Usage Overview`,
`Orchestration Usage`, `Instance Scan Results`, `Custom Application Inventory`,
`HR Agent`, `HR Employee Documents`, `Universal Request Process Overview`,
`SOX Compliance Dashboard`, `Compliance Overview - PA Premium`,
`Policy Overview - PA Premium`, `Advanced Risk Assessment Overview`,
`Application Risk and Compliance Overview`, `MITRE ATT&CK`,
`Invoice Processing` (Amit Kumar Khandelwal), `PAG Invoice Tracker` (Amit Kumar
Khandelwal).

Almost every dashboard is owned by `System Administrator`, with two exceptions
owned by a named user. Worth noting for the catalog design: **"Owned by me" will
be empty or near-empty for most viewers on this instance**, so the default tab
should be Recent or All, not Owned.

## 6. Top report-bearing tables

`incident` 100, `change_request` 73, `sn_grc_issue` 60,
`sn_customerservice_case` 50, `sn_risk_risk` 41, `usageanalytics_count` 37,
`sn_hr_core_case` 35, `pm_project` 34, `problem` 34,
`awa_interaction_work_item` 34, `task` 34, `sn_si_incident` 33, `task_sla` 31,
`asmt_assessment_instance` 31, `asmt_metric_result` 29, `sn_compliance_control` 28,
`sn_audit_task` 23, `sn_audit_engagement` 22, `sn_audit_control_test` 21,
`sc_req_item` 20, `alm_asset` 20, `ast_contract` 19, `kb_knowledge` 17,
`em_alert` 17, `cost_plan_breakdown` 17.

Reporting demand is far broader than ITSM. GRC, risk, audit and compliance
together out-weigh `incident`. A catalog and a generic render surface are
therefore the right shape, and an incident-only page is the wrong one.

## 7. Method note

Queried through the `enterprise_graph` MCP tool against the live instance.
`sys_dictionary` and `pa_dashboards` were not reachable by that tool under those
names; the dashboard list in §5 came back through a differently-phrased request.
Field data types in §4 are therefore stated as a required lookup, not as measured
values. Everything in §1, §2, §3, §5 and §6 is measured.
