# COMMAND inside the employee workspace, and keeping the PDI safe

Built and measured on dev390988 (release **Australia**, patch 3) on 2026-09-23.
Scoped app `x_2185255_command`, released as **COMMAND Analytics 0.3.2**. Every
claim below was measured on that instance. The command that repeats each
measurement is given next to it.

---

## 1. What the client asked for

In their workspaces (L1, L2, L3 and so on), employees work from lists: Incidents,
Tasks, Requests, Knowledge. Every column header has a menu with **Show
visualization**, which opens a **Data visualization** panel with a Group-by
dropdown and four chart types: vertical bar, horizontal bar, pie and donut. For
anything deeper, employees have to leave the workspace and open our dashboards.

The ask was to bring COMMAND's analysis into that flow, with three conditions:

- Do not modify ServiceNow core code, contracts or abstraction layers.
- If the native visualization selector cannot be extended, hook the interaction
  and offer COMMAND instead.
- Pass the list's real context, so the analysis runs on the actual data.

## 2. What the platform allows, measured rather than assumed

| Surface | Extensible without modifying native records? | Evidence |
|---|---|---|
| Column menu → **Show visualization** item | **No** | The item is emitted by the list component. A SOW page script (`sys_ux_client_script` *Open data visualization panel*, scope `sn_now_list_common`) turns it into `LIST_CTRL#OPEN_PANEL` with route `data-visualization`. There is no model or table for adding items. |
| **Data visualization panel** and its chart types | **No** | The four types belong to the component. The only way in is a replacement page variant, which means taking ownership of a ServiceNow page. |
| **List header actions** (Edit, Export, New) | **Yes, supported** | `sys_declarative_action_assignment` with the *List* model. ServiceNow uses the same pattern for its own cross-product launcher: **Launch Process Mining** is a List-model, Client Script, `table=global` action that reads `g_list.getTableName()` and `g_list.getQuery()` and hands off to a separate analytics experience. |
| **Row ⋮ menu** (Copy URL, Reassign, Assign to me) | **No** | These are not declarative actions. They are a fixed `actionsItems` array built by `sn_sow.SOWListTransformSNC`. The only way in is to edit SOW's own `SOWListTransform` stub, which is a ServiceNow-owned record, and the result would only work in SOW. A List action grouped under *Global Now Actions* was tried and does not render there. |
| **Left-nav list ⋮ menu** (Save a copy) | **No** | Built into the component. `sys_ux_list_menu_config` has no action records. |

**Decision.** Use the one supported surface, the list header. The column menu, the
Visualization panel and SOW's row menu are not touched.

## 3. What was built

### The agent's flow

**Workspace list → Analyse in COMMAND → COMMAND opens in the workspace's own modal
over the list, analysing exactly what the list is showing.** The agent never
leaves the workspace. Closing the modal returns them to the same list.

**Column first (0.3.2).** The native feature answers one question about one
column. COMMAND now asks that question first: **Analyse in COMMAND** opens a
**column picker** in about 1 s. It shows the list's own columns (the same fields
the native Group-by dropdown lists) with the row count the analysis will cover,
then the other fields. Choosing a column opens that column's own analysis over
**every row of the list**, not just the page of 20 on screen:

- its breakdown;
- how it moved over time;
- what changed between the last two periods, broken down by its values;
- rank shift;
- a funnel, if it is a stage field;
- Pareto;
- spread of the lead measure;
- crosstabs against the list's other columns.

Every panel is about that column. This is field mode:
`CmdPayload.dashboard(opts.fieldMode)` → `_fieldGrid`.

**Whole-list overview** is one tile, and the **Analyse by** dropdown switches
column without closing the modal. A list the agent has grouped by a column
(through the column menu) skips the picker and opens straight on that column. An
empty list says so instead of offering columns.

| The agent wants to analyse | How |
|---|---|
| This list (any saved list in the left nav) | Open the list, then click **Analyse in COMMAND**. The list's own condition and any filter the agent added are both applied. |
| One field (the "Show visualization" gesture) | Either use the column menu's **Group by X** and then **Analyse in COMMAND**, and X leads the analysis. Or open COMMAND and choose X in **Analyse by**. The picker lists the list's own columns first, the same fields the native panel's Group-by dropdown offers, and COMMAND redraws with X leading (tagged *You asked to see this*). |
| One record | Tick its row, then click **Analyse in COMMAND**. COMMAND shows the list's analysis plus a **This record** strip: its number (opens the record) and **records like it, by** chips for each of its values. Each chip is a normal drill step. |
| A few specific records | Tick them, then click **Analyse in COMMAND**. Exactly those rows are analysed. |
| A saved report | Open the reports list in the workspace (`/now/sow/simplelist/sys_report`), tick the report, then click **Analyse in COMMAND**. It opens as COMMAND's converted report, with the report's table and saved filter re-read server-side and a parity check against the native count. Measured: *Active Changes > 7 days*, **COUNTS MATCH, 1,483 records**. |

### Records on the instance, all new and all in scope `x_2185255_command`

| Record | What it is | Source |
|---|---|---|
| `sys_declarative_action_assignment` **x_2185255_command_analyse** | The **Analyse in COMMAND** header button. List model, Client Script, `table=global`, enabled for all configurable experiences, so it appears in every Next Experience workspace, not only SOW. | `product/workspace/cmd_workspace_action.js`, deployed by `product/deploy/workspace.py` |
| `sys_script_include` **CmdWorkspace** | The gate between the list's URL parameters and the engine (section 4). | `product/script-includes/CmdWorkspace.js` |
| `sys_ui_page` **cmd_frame** plus `sys_ui_script` **cmd_frame_<hash>** | The page the modal holds. It holds the dashboard in an inner iframe (why: section 6). | `product/ui-pages/cmd_frame.xhtml`, `product/ui-scripts/cmd_frame.js` |
| `sys_ui_page` **cmd_dashboard** (updated) | Workspace mode: `ws`, `wq`, `wlist`, `wgroup`, `wsel`, `wrec`, `wtitle` and `embed`. It also hands a ticked `sys_report` row to report conversion. | `product/ui-pages/cmd_dashboard.xhtml` |
| `sys_ui_script` **cmd_render_<hash>** (updated) | Context strip, **Analyse by** picker, **This record** strip, modal chrome ("Open full screen" in place of "All subjects"), and links that leave COMMAND open in a tab rather than inside the modal. | `product/ui-scripts/cmd_render.js`, `product/ui-pages/cmd.css` |

**No ServiceNow-owned record was created, changed or deleted.** This was audited
on the day: every configuration change on 2026-09-23 is in our scope. The one
exception is a property that the platform's own `system` user updated at 08:58,
before this work began. Removing the integration means deactivating one record:

```bash
python3 product/deploy/workspace.py --remove
```

The analysis engine, catalog and CEO Dashboard are unchanged in behaviour. Their
smoke test and a real-browser load of the CEO Dashboard pass.

## 4. What the list hands over, and why none of it is trusted

The client script reads the following from `g_list`:

- `getTableName()`
- `getQuery({fixed:true})`, which holds only what the agent changed (see below)
- `getGroupBy()`, which returns `^GROUPBYfield` rather than the field name
- `getChecked()` and `getTitle()`

It also takes the list's `sys_ux_list` id from the workspace route
(`/list/params/list-id/<id>`).

**Measured: a list definition's own condition is not in `g_list`.** "Incidents –
Open" (`active=true`) reports an empty query, because the condition is applied by
the list's data broker. The first build therefore analysed all 4,284 incidents
for "Open". The fix: the server reads that list's `condition` and `fixed_query`
from `sys_ux_list` itself (configuration, not browser input), checks the list
belongs to the same table, and ANDs it with the agent's filter across `^NQ`
branches.

`CmdWorkspace.context()` is the only code path from URL to engine. It:

- **refuses a `javascript:` token** unless it is on a short allowlist of read-only
  helpers with literal arguments (`gs.beginningOf…`, `gs.daysAgo…`,
  `gs.dateGenerate`, `gs.getUserID()`, the three `getMy…()` helpers).
  `setPassword`, `deleteMultiple`, `eval`, IIFEs and concatenation are all
  refused, with the reason shown;
- **resolves `getMyAssignments()`, `getMyGroups()` and `getMyApprovals()` to
  literals**. Measured against the platform's own count, inside a scoped app they
  mis-evaluate: `assigned_to=javascript:getMyAssignments()` counts **650 in scope
  and 0 in global**, and `getMyGroups()` counts 46 against 0. "Tasks – Assigned to
  you" analysed 1,500 other people's tasks until this was fixed. The literal is the
  viewer alone, so work delegated to them in global is not included. That can only
  narrow the slice, never widen it;
- **refuses a query that names a field the table does not have**
  (`isEncodedQueryValid`), because the platform silently drops such a clause and
  the query widens;
- validates the table, group field, sys_ids (at most 100) and list id, and caps
  the query at 6,000 characters.

What the viewer may see is still decided by `CmdData.aclVerdict` against their own
session. A hand-edited URL can ask for any query and still only counts rows the
viewer can read.

Offline tests: `node product/tests/test_workspace_context.js` (43 checks).

## 5. Tested end to end, in a real browser, against the platform's own counts

```bash
python3 product/tests/workspace_live.py                  # as admin, with count oracle
python3 product/tests/workspace_live.py --user ceo.leader  # as an itil agent
```

The test drives headless Chrome through the agent's real gestures: the list, the
column menu's **Group by**, ticking rows, the header button, and the picker inside
the modal. It then reads the payload out of the modal and checks it against the
Table API's ACL-enforced count (`X-Total-Count`) of the same query.

| Scenario | admin | ceo.leader (itil) |
|---|---|---|
| s1 Incidents – All | 4,284 = 4,284 ✅ | ✅ |
| s2 Incidents – Open (list condition) | 3,826 = 3,826 ✅ | ✅ |
| s3 Group by Priority from the column menu | 4,284, Priority leads ✅ | ✅ |
| s4 three rows ticked | 3 = 3 ✅ | ✅ |
| s5 Tasks – Assigned to you (`getMyAssignments`) | 0 = 0 ✅ | platform gate (section 7) |
| s6 Knowledge – All articles | floor 750 or 500 ≤ 757, labelled BOUNDED ✅ | platform gate |
| s7 Requests – Open items | 5 = 5 ✅ | ✅ |
| s8 CMDB – Servers | 420 = 420 ✅ | ✅ |
| s9 Interactions – Assigned to you (dynamic "Me") | 0 = 0 ✅ | ✅ |
| s10 one row ticked, record in context | 3,826 plus record strip ✅ | ✅ |
| s11 **Analyse by → State** inside the modal | State leads, modal stays open ✅ | ✅ |
| s12 saved report ticked in the reports list | COUNTS MATCH 1,483 ✅ | platform gate |

Time from click to rendered analysis: **0.8–2 s** for small lists and **8–10 s**
for the full incident table. That is the engine's existing server build time and
the same as the standalone dashboard, well over the 1.2 s / 2.5 s budget in
CLAUDE.md. It is not new, but it is the most visible gap in this flow.

## 6. Findings that shaped the build

1. **The workspace modal closes when its iframe navigates.** `g_modal.showFrame`
   is built for dialogs that finish on reload, and an analysis navigates on every
   drill. So the modal holds `cmd_frame`, which never navigates, and `cmd_frame`
   holds the dashboard in an inner iframe. The loader forwards only the query
   string, to a path fixed in the script.
2. **Two actions with the same label collide.** The header click dispatched the
   other action (which needed a selection) and nothing opened, so the list
   resolves client-script actions by label. Only one action exists now.
3. **The list's own `g_list.getQuery()` throws on a list with no query**
   (`Incidents – All`: it calls `.split` on `null`). Every `g_list` read is
   guarded.

## 7. Known limitations (all platform behaviour, none worked around)

- **The header button follows the platform's action gate.** The platform sends no
  list header action (Edit, New, or ours) to a user whose table-level,
  context-free `canRead()` is false. For `ceo.leader` that is `task`,
  `kb_knowledge` and `sys_report`, although the agent reads rows in those lists.
  This is the same `canRead()` behaviour recorded in CLAUDE.md §5. A
  table-specific action was tried and is gated the same way. It does not affect
  admins or roles with table-wide read, and COMMAND analyses those tables
  correctly when opened directly.
- **No entry in the column menu, the row ⋮ menu or the left-nav ⋮ menu** (section
  2). The single-record flow uses a ticked row.
- **Knowledge counts are a floor** (BOUNDED) when the per-row ACL proof runs out
  of time budget, as before this work.

## 8. Update sets and protecting the PDI

### What an update set is

A record (`sys_update_set`) that collects the XML of every *configuration* change
made while it is current: scripts, pages, UI actions, roles, properties and so
on. It is exported as one XML file and imported on another instance through
*Retrieved Update Sets → Import Update Set from XML → Preview → Commit*. For a
scoped app, **Publish to Update Set** builds one containing every file of the
application, which is what `product/deploy/package.py` automates.

### What it preserves, and what it does not

| Preserved | Not preserved |
|---|---|
| Every application file in scope: 12 script includes, 4 UI pages, 5 UI scripts, the workspace action, 2 roles and their containment, 4 properties, the menu and 3 modules | **Data.** Incidents and every task record, including the reshaped demo data. `product/deploy/seed.py` and `seed_lifecycle.py` regenerate it. |
| Deletions of records that no longer exist (harmless on a new target) | **Users and role grants** (`sys_user`, `sys_user_has_role`). The personas `ceo.leader` and `ceo.restricted` are recreated by `setup_app.py`. |
| Property definitions | Changed property **values** made outside the app, user preferences, attachments |
| | Anything created outside our scope. Nothing was, today. |

**Noise in the package.** 34 NLU language records (`open_nlu_driver_language`,
`sys_cs_nlu_language`) were attached to our scope by the platform on 2026-09-14,
07:00, and travel in the update set. They are not ours. They are left untouched
on the PDI. Before the client install, decide whether to move them back to global
on the PDI or skip them at Preview.

### PDI reclamation

A PDI is reclaimed after inactivity. The published rule from 11 July 2026: once
the instance is 90 or more days old, it is reclaimed if nobody has **explicitly
logged in** for 10 days. Scheduled jobs and integrations do not count. A
reclaimed instance is reset and **cannot be recovered**. Sources: the ServiceNow
developer community article *PDI reclamation rules* and KB3140725. **Log in to
dev390988 at least weekly.**

### The backup, three independent copies

Any one of these rebuilds the application:

1. **Source in git** (`product/`), the primary copy. `deploy.py`, `setup_app.py`
   and `workspace.py` rebuild every record from it.
2. **Release update set**: `product/dist/COMMAND-Analytics-0.3.2-update-set.xml`,
   committed to git. What the client imports.
3. **XML snapshot**: every record in the app scope, one file per type, as
   produced by the platform's *Export → XML*, with sys_ids intact and a
   SHA-256 manifest. Each file must parse and must match the instance's own count
   before the backup reports success.

```bash
python3 product/deploy/backup.py                    # snapshot only; read-only on the PDI
python3 product/deploy/backup.py --release 0.3.3    # snapshot + publish/export an update set
```

Snapshots land in `backup/pdi/<timestamp>/`, which is gitignored, so they stay
local. **Copy that folder off this machine** (drive or cloud), and push the git
repository to a remote. A single disk is not a backup.

**Routine.** Run `backup.py` after every working session. Run
`backup.py --release <next>` before every client hand-off, and commit
`product/dist/`. Also log in to the PDI weekly.

### Recovery onto a fresh or reset PDI

**Fastest route: the update set.**
*Retrieved Update Sets → Import Update Set from XML* →
`COMMAND-Analytics-0.3.2-update-set.xml` → *Preview* (resolve any conflicts) →
*Commit*. Then recreate the demo data and personas:

```bash
python3 product/deploy/setup_app.py
python3 product/deploy/seed.py
python3 product/deploy/seed_lifecycle.py
```

**From source, if the update set will not import cleanly.** Create the scoped
application `x_2185255_command` in Studio (the scope prefix comes from the
developer account, so a new account gets a new prefix; see the next section).
Then run, in order:

```bash
python3 product/deploy/deploy.py --scope x_2185255_command
python3 product/deploy/workspace.py
python3 product/deploy/setup_app.py
```

Verify with `workspace_live.py`, `smoke_live.py` and `run_all.sh`.

**From the XML snapshot.** *System Definition → Import XML* on each file,
`sys_app.xml` first.

## 9. Moving this to the client's instance

1. Import and commit `COMMAND-Analytics-0.3.2-update-set.xml` (section 8). The
   app keeps its scope `x_2185255_command`. Nothing global is included, so it
   cannot overwrite anything of theirs.
2. The **Analyse in COMMAND** button appears on every list in every configurable
   workspace they run, not only SOW. To limit it to their L1/L2/L3 workspaces,
   set `enable_for_all_experiences=false` on the action and link it to each
   workspace's *UX Actions Configuration* through
   `sys_ux_m2m_action_assignment_action_config`. That adds new records only.
3. Give the agents who should see COMMAND's catalog and CEO page the app roles.
   The workspace button itself needs no role, and every count is ACL-checked
   against the viewer.
4. Re-run `workspace_live.py` there against their own list ids. The list ids in
   the test are SOW defaults and exist on any instance with SOW installed.

---

## 10. Update, 2026-09-26: COMMAND as a side panel beside the list (0.3.3)

The client's picture was the native **Show visualization** side panel, but with
COMMAND's analysis in it. The centred pop-up is replaced by a **side panel docked
in the same slot as Data visualization**, still built only from new records in our
scope. `product/deploy/workspace.py` owns every record and is idempotent.

| # | New record (our scope) | Platform mechanism |
|---|---|---|
| 1 | `sys_declarative_action_assignment` **Analyse in COMMAND** | List-model header button (UXF client action), every workspace |
| 2 | `sys_declarative_action_payload_definition` | the List model's own tokens `{{table}} {{query}} {{groupBy}} {{sysIds}}` |
| 3 | `sys_ux_addon_event_mapping` | controller-scoped add-on mapping: button → `LIST_CTRL#OPEN_PANEL` on the List Controller, whose own generic *Open panel* script opens the route |
| 4 | `sys_ux_app_route` | registered on **List Page Panes**, the List Controller's viewport extension point, like Data visualization, Quick edit and Multi edit |
| 5 | `sys_ux_screen_type` + `sys_ux_screen` | the route's screen |
| 6 | `sys_ux_macroponent` **COMMAND Analytics panel page** | our own page holding the stock iFrame component, used unmodified |

**What the panel opens on.** It follows the list:

- the list's own condition, read from `sys_ux_list` using the list id taken from
  the workspace address;
- the agent's filter;
- **grouped by a column** (the column ⋮ → Group by) → that column's field
  analysis;
- **one ticked row** → that record in context;
- **several ticked rows** → exactly those rows;
- **nothing chosen** → the list's analysis, over **the list's own columns only**.
  On `incident` that is 7 columns instead of 49; ranking all 49 on a cold start
  drew nothing.

The **Analyse** dropdown switches to any column without closing the panel. The
panel follows the workspace theme, read from the workspace's background
brightness, which is read-only. A viewer's own Light/Dark choice still wins.

**Not possible without modifying ServiceNow: following the field that the native
Data visualization panel is showing.** Its chosen Group-by lives only in browser
memory. It is not in the URL, not in a preference, and not among the List model's
tokens. The only way to read it would be scraping ServiceNow's rendered panel,
which we do not do.

**Speed.** A workspace-opened request gets a larger allowance: 11 s page, 5 s
permission proof, 11 s scan. It is scoped to that one request, because script
include statics are evaluated per transaction; verified that a separate request
still sees 6 s and 2.5 s. Measured cold on dev390988: *Incidents – All*, 4,284
rows, full analysis, about 16 s. Repeat opens within the 3-minute verdict cache
are faster. This is the engine's cost, not the panel's, and it is the largest
remaining gap against the performance budget in CLAUDE.md.

**Verified.** `workspace_live.py` 12/12 through the side panel. Every count
equals the Table API's permission-checked count. The Knowledge floor is labelled
BOUNDED.

### Incident, 2026-09-23: a ServiceNow component was renamed by the spike, then restored

The first spike pointed our `sys_ux_screen` at ServiceNow's stock iFrame
component (`sys_ux_macroponent` `2eda8d95aae6d05a26d94fbf692ac6f9`), and **a
screen renames the component it points at**. ServiceNow's component became
"COMMAND Analytics panel", with its props re-serialised.

- **Restored** the same day by loading its shipped version XML through
  `GlideUpdateManager2`. Every field now equals the shipped copy, and the shipped
  XML is kept in `backup/incident-2026-09-23-iframe/`.
- **Audited:** nothing else outside our scope was changed.
- **Prevented:** our screen now points only at our own page, and every
  `workspace.py` run aborts if the stock component differs from its shipped state.
- **Still open, needs the owner:** the three bookkeeping records the platform
  wrote at 15:36:03 still flag the component as customised. They are a
  `sys_update_xml` row in the *Default* update set, a `sys_update_version` row
  and a `sys_metadata_customization` row. Deleting audit history was
  deliberately not automated. Resolve it in ServiceNow: open the component's
  *Versions* and **Revert to this version** on the June 2026 shipped version, and
  keep that Default-set entry out of anything moved to the client.

## 11. Update, 2026-09-27: two buttons, following what the employee is looking at (0.3.4)

The client's choice. Both buttons are verified by hand in a real browser, with a
screenshot at every step.

| Button | Opens | Follows |
|---|---|---|
| **Analyse in COMMAND** | the workspace pop-up, with **Open in new tab** | **the field shown in the native Data visualization panel** (Show visualization on Priority → COMMAND on Priority), otherwise the column the list is grouped by, a ticked row, or ticked rows |
| **COMMAND side panel** | docked beside the list, in Data visualization's slot | the column the list is grouped by, a ticked row, or ticked rows |

**Why only the pop-up follows the Data visualization field.** Only a client-script
list action runs code at click time. That is the one moment the field is on
screen: opening COMMAND replaces that panel, and the field is in no URL, no
storage and no List-model token.

- The script reads the label of the panel's `Group by dropdown` combobox,
  read-only. The server maps the label to a field of the table
  (`CmdWorkspace._fieldForLabel`) and ignores anything that is not one.
- The side-panel button is configuration (a UXF client action). Measured: its
  client script never runs.
- If ServiceNow ever redraws that panel, the read finds nothing and COMMAND falls
  back to the list's own context.

**The field view is exact and stable.** For a viewer proven to read every row,
trends come from indexed counts over the scan's own month boundaries
(`CmdData._fastSeries`). On `incident` the fast path and an unlimited full scan
matched on every value: 143 ms against 3.3 s. Before this, the same field drew
different "lower bound" trend numbers on each open. The field's own breakdown is
now drawn first, and the page no longer jumps past its title.

**Still slow.** A full field view takes about 12 s on dev390988, because the KPI
tiles and the spread chart still read rows one by one. Moving those to indexed
aggregates for trusted viewers is the next performance step.
