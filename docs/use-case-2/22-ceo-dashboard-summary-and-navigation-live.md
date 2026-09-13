# The CEO Dashboard's own front page and navigation — measured, not assumed

Measured **2026-09-13** against `eypocinst.service-now.com`, **read-only (GET
only, no writes of any kind)** — the same discipline
`docs/use-case-2/17-ceo-dashboard-instance-findings.md` used on 2026-09-07.
Every sys_id and value below is reproducible with the queries named, and the
raw response for every one of them is saved next to this file in `raw/`.

**Why this exists.** The client sent two short messages: *"For ceo dashboard
front page and navigation page all in one page with multiple section"* and,
separately, three phone-photographed screenshots of Power BI tutorial videos.
Doc 17 measured the eight portfolio pages in detail but explicitly did not
look at the `summary` route — the actual landing page of their Control Tower
app — because the original ask was one portfolio, redrawn. That gap is what
this document closes.

**Revision note, so the wrong version of this finding never gets quoted.** An
earlier pass of this same investigation concluded the Summary page was
"almost entirely static, 2 live bindings out of 331 properties." That
conclusion was wrong, and it was wrong for an instructive reason: it counted
one binding *type* (`DATA_OUTPUT_BINDING`) and missed that most of the page's
real data actually arrives through a different mechanism — a
`CLIENT_TRANSFORM_SCRIPT` wrapper whose inline function body reads
`api.data.<source>.output...`. Reading those scripts (§4) overturned it
completely: the page is substantially live. This note stays in the document
rather than being quietly edited away, because getting this exact kind of
thing wrong — a measurement of the wrong signal read as a measurement of the
thing itself — is the recurring failure mode this whole engagement exists to
catch, in our own dashboards and, now, in this investigation too.

---

## 1. The ten screens, resolved

`sys_ux_page_registry` (path=`ceo`, sys_id `f496a6badb42c910867d0472ba9619eb`)
is one row per **application**, not per route. The real routing table is
`sys_ux_screen`, filtered by `app_config` — confirmed correct by row count
matching doc 17's known inventory exactly:

```
GET /api/now/table/sys_ux_screen?sysparm_query=app_config=06d62ebadb42c910867d0472ba9619a2
-> 10 rows
```

Each screen's identity lives in `screen_type` / `macroponent` / `name` — not
`path`/`title`, which don't exist on this table.

| screen_type | sys_id | macroponent → |
|---|---|---|
| Portfolio1 | `1f0f2205dbde4150d63a43d913961929` | `Portfolio1` |
| Portfolio2 | `46e92ca5dbde8150d63a43d9139619e2` | `Portfolio2` |
| Portfolio3 | `670a6ca5dbde8150d63a43d91396195f` | `Portfolio3` |
| Portfolio4 | `7f1aeca5dbde8150d63a43d9139619ca` | `Portfolio4` |
| Portfolio5 | `272aeca5dbde8150d63a43d9139619d9` | `Portfolio5` |
| Portfolio6 | `fe3a60e5dbde8150d63a43d91396193e` | `Portfolio6` |
| Portfolio7 | `164a60e5dbde8150d63a43d9139619e0` | `Portfolio7` |
| Portfolio8 | `615aa0e5dbde8150d63a43d913961999` | `Portfolio8` |
| **Summary** | `a6e86efadb42c910867d0472ba96193a` | `Summary` |
| Workflow page | `a3c6e18ddb6e0510867d0472ba961984` | (workflow) |

All ten share one parent macroponent: `CEO Dashboard Appshell`
(`412722fadb42c910867d0472ba961973`).

Raw: `screen_<sys_id>.json` (one per row), `screens_by_app_config.json` (the
membership query), `dict_sys_ux_screen.json` (real field names, learned from
data rather than guessed).

## 2. The navigation — a conventional header menu, not a special visual

The Appshell's `composition` (6,455 bytes, `appshell_macroponent.json`) is a
standard Now Experience Framework shell: a `Canvas Header` holding a
`Canvas Menu` in slot `navigation-menu` —

```
elementId: "menu"    slot: "navigation-menu"
activeScreen -> @elements.canvasLayout.activeScreenId
items        -> DATA_OUTPUT_BINDING: portal_app_shell_data_source
                  .uxPropertiesAndAuthRoutes.chrome_menu.global
menuWidth: "1600"
logoSource: "/ceodashboard_headerlogo.png"
logoAltText: "Control Tower of Digital Transformation"
```

So today, moving between portfolios is: a persistent top menu, populated at
runtime from a data source, then a **full screen swap**. That's a two-hop
pattern, not "one page, multiple sections" — worth knowing before assuming
the client's own product already does what they're describing.

## 3. The Summary page — layout

`Summary`'s macroponent (`62e86efadb42c910867d0472ba961938`,
`summary_macroponent.json`, 1.16 MB) has one flex-column layout (`layout`
field) — a single scrollable "Main" slot, dark navy (`#032D42`) — with
everything else nested inside it as children. Element census:

| element kind | count |
|---|---|
| `stylized_text` | 57 |
| `container` (layout only) | 51 |
| `image` | 28 |
| `rich_text` | 8 |
| `process_flow_map` | 1 |

Structurally: a header block (icon + one live title), **two grids of
repeating icon-and-caption tiles**, one large diagram, and a closing row of
three more tiles. The tile grids use four icon files —
`/ceodashboard_speedicon.png`, `/ceodashboard_productivityicon.png`,
`/ceodashboard_riskicon.png`, `/ceodashboard_icon.png` — matching three of
the `metric_type` categories doc 17 already catalogued (Speed, Productivity,
Risk), plus one general "Enterprise View" icon.

## 4. What actually feeds those tiles — traced to source

Every `CLIENT_TRANSFORM_SCRIPT` property's logic is inline in the file
already fetched — no further API calls needed to read it:

```js
function evaluateProperty({api}) {
    return api.data.totalworkflows.output.result[0].name;
}
```

All 59 were extracted (`raw/all_transform_scripts.json`) and scanned for
their `api.data.<name>` reference. **28 distinct data sources**, and the
pattern is exact:

| source name pattern | count | what it is |
|---|---|---|
| `p1_speed` … `p8_risk` | 24 (8 portfolios × 3 metrics) | live, per-portfolio PA scores |
| `getmetricsoflandingpage` | referenced 8× | the upstream lookup all 24 depend on |
| `getportfolionames` | referenced 8× | portfolio display names |
| `totalworkflows`, `totalworkflowproducts` | 2 each | two more live REST counters |

**24 of the 28 are Speed/Productivity/Risk for every one of the eight
portfolios, live.** This is a genuine cross-portfolio overview — it just
doesn't cover Anchor1/2, Speed2, Productivity2, Risk2 or Bubblechart, the
other six slots each portfolio page shows.

The `data` field (28 declarations, one per source, `raw/data_sources.json`)
shows exactly how: each `pN_metric` is a `REST` resource whose own `uuid`
input is **itself** a binding, chained from the shared lookup —

```json
{
  "elementId": "p1_speed",
  "definition": { "type": "REST" },
  "inputValues": {
    "uuid": {
      "type": "DATA_OUTPUT_BINDING",
      "binding": { "address":
        ["getmetricsoflandingpage", "output", "Portfolio1", "Speed1", "0", "sysid"] }
    }
  }
}
```

Read plainly: `getmetricsoflandingpage` returns a `pa_indicators` sys_id
keyed by `[Portfolio][Slot]`, and each `pN_metric` REST call passes that
straight to the PA Scorecard API as `sysparm_uuid` — **the identical
mechanism doc 17 already fully reverse-engineered for the portfolio pages**
(§3 of that document). The Summary page is not a separate system; it reads
the same `sn_controltower_ceo_dashboard` config table doc 17 already knows,
filtered to three slots, across all eight portfolios instead of nine slots
for one.

**Why this is the most consequential finding in this document, for the
build:** `CmdCeo.resolve()` (`CmdCeo.js:275`) already does this exact
indicator-to-table-and-query resolution — it's the machinery that made the
individual portfolio redraws possible, already verified 11-for-11 against
PA's own numbers by `oracle_ceo.py`. A front page showing Speed/Productivity/
Risk across all eight portfolios is very likely **assembly of what already
exists, not new indicator-resolution work.** That materially changes what
this would cost to build.

## 5. The literal 24 indicators, resolved (session refreshed, 2026-09-13 later same day)

The first pass of this section ended on an HTTP 401 across the board — a
dead session, confirmed by a control request that had worked minutes earlier
also failing. A fresh login resolved it (confirmed alive against the exact
same control request before anything else was attempted), and the query
that had been blocked ran clean:

```
GET /api/now/table/sn_controltower_ceo_dashboard
    ?sysparm_query=business_functionINPortfolio1,...,Portfolio8
                   ^metric_typeINSpeed1,Productivity1,Risk1
-> 24 rows
```

Raw: `raw/landing_page_indicators.json`. And this is the second major
correction this document has needed, in the other direction from §0's
revision — not "the page is more live than it looked," but **"a quarter of
what it shows is a data-integrity problem, on the client's own live
instance, not a reproduction artifact of ours:**

| portfolio | Speed1 | Productivity1 | Risk1 |
|---|---|---|---|
| Portfolio1 | Average age open incidents | Number of resolved incidents | % open not updated in last 30 days |
| Portfolio2 | Number of open incidents not updated in last 5 days | Number of open incidents not updated in last 30 days | Number of incidents closed by self-service |
| **Portfolio3** | **% of incidents resolved by first assigned group** | **% of incidents resolved by first assigned group** | **% of incidents resolved by first assigned group** |
| **Portfolio4** | **% of incidents resolved by first assigned group** | **% of incidents resolved by first assigned group** | **% of incidents resolved by first assigned group** |
| **Portfolio5** | **% of incidents resolved by first assigned group** | **% of incidents resolved by first assigned group** | **% of incidents resolved by first assigned group** |
| **Portfolio6** | **% of incidents resolved by first assigned group** | **% of incidents resolved by first assigned group** | **% of incidents resolved by first assigned group** |
| Portfolio7 | % of incidents not solved | PA: Daily Errors | Benchmark: Number of emergency changes closed |
| Portfolio8 | PA: Daily Updates | AppSec-Total Number of Configuration Properties | Average age of last update of open incidents |

**Portfolios 3, 4, 5 and 6 — all twelve of their tiles — point at the exact
same single indicator**, `pa_indicators/002d65c3d7131100b96d45a3ce6103e2`
("% of incidents resolved by first assigned group"), every row marked
`active=true`. This is the same unconfigured-duplicate pattern doc 17 found
on the portfolio detail pages for those same four portfolios, now confirmed
independently on a third surface — the Summary page has its own copy of the
problem, not an inherited one. Whatever number that indicator resolves to,
the client's real Summary page will show it twelve times over, unlabelled as
a repeat.

Portfolio8's `Productivity1` — "AppSec-Total Number of Configuration
Properties" — is also worth flagging on its own: unlike every other cell in
this table, it isn't incident-shaped at all. Whether that's a deliberate
choice or a stray misconfiguration is not answerable from this table alone,
but it doesn't match the pattern of anything around it.

**Left genuinely open:** the 20 KB `data` field's structure beyond the 28
declarations already extracted, and an actual browser screenshot of
`/now/ceo/summary` — still the cheapest way to settle what a viewer
literally sees, and now the only remaining unverified step in this
document.

## 6. What this means for the client's message

- Their **existing** front page is not a counter-example to build against as
  a working whole: it genuinely does show live, cross-portfolio numbers
  (§4 corrects the earlier claim otherwise) — but a third of those numbers
  (§5) are the same one indicator repeated twelve times because four
  portfolios were never individually configured, and its one component
  shaped like a *navigation* visual, the `Process Flow Map`, is unwired: its
  `nodeDataArray` is empty while its 24 edges reference `portfolio1`
  through `portfolio8` by name, and one edge still carries the literal
  placeholder `"Add random text here.."`. A diagram can't render nodes it
  was never given.
- The actual **navigation** is a conventional header menu (§2), shared
  across nine screens, not anything resembling the reference screenshots'
  bubble/orbit layout.
- Nothing here rules out building what the client described. It does mean
  there's no single existing, fully-working artifact to reproduce — the live
  data and the metric groupings are real and reusable; the "front page as
  navigation" idea their own diagram gestures at was never finished.

Worth a direct, specific question back to the client, now backed by
evidence instead of a guess: *"your Summary page's portfolio diagram doesn't
currently connect its nodes — is a working version of that the kind of
thing you mean?"*

## Raw evidence index

All in `raw/`, one file per API response, saved verbatim:

| file | what it is |
|---|---|
| `ceo_page_registry_row_full.json` | the app-level `sys_ux_page_registry` row (path=ceo) |
| `app_config_full.json` | the `sys_ux_app_config` record (landing_path=summary) |
| `dictionary_both_tables.json` | `sys_dictionary` fields for page_registry/app_config |
| `dict_sys_ux_screen.json` | `sys_dictionary` fields for `sys_ux_screen` |
| `screens_by_app_config.json` | the query that found all 10 screens |
| `screen_*.json` | full record for each of the 10 screens |
| `appshell_macroponent.json` | the shared nav shell, full record |
| `summary_macroponent.json` | the Summary page, full record (1.16 MB) |
| `all_transform_scripts.json` | all 59 inline transform scripts, extracted with their element/property |
| `data_sources.json` | all 28 declared data resources, parsed from the `data` field |

No session cookies, tokens, or any other credential are stored anywhere in
this folder or this document — the read-only session used to gather this was
supplied at call time and was never written to disk.

**To move this into the project repo:** the drive was mounted read-only for
the whole of this investigation. Once it's writable,
`cp -r ~/ceo-dashboard-eypocinst-findings/raw "docs/use-case-2/ceo-dashboard-live-eypocinst"`
and this file becomes `docs/use-case-2/22-ceo-dashboard-summary-and-navigation-live.md`
— no rework, it's already written to land there.
