# Live-Instance Findings — dev390988

> ## ⚠️ SUPERSEDED IN PART — read [`04-red-team-verification.md`](04-red-team-verification.md) first
>
> A later adversarial re-verification pass on the same instance **falsified two of this
> document's load-bearing findings**:
>
> - **§1 (access) is wrong.** REST is *not* OAuth-only. Session-cookie auth works; the prior pass
>   omitted the `X-UserToken` header and misread the resulting 401 as an auth-policy decision.
>   See [`04`](04-red-team-verification.md) §1 for the working method.
> - **§5 (the "six primitives" chart inventory) is wrong.** The query filtered component names for
>   *chart / visualization / graph*, which excludes ServiceNow's actual `now-vis-*` /
>   `now-visualization-extensions/*` family. The real palette is **≥15 types**, not 6.
>   See [`04`](04-red-team-verification.md) §2.
>
> §3 (build info), §4 (plugin inventory) and §7 (MCP side note) stand. §6 is weaker than stated.
> Everything below is kept as the historical record; do not cite §1 or §5 as evidence.

**Date:** 2026-07-31
**Instance:** `https://dev390988.service-now.com`
**Purpose:** ground the claims in [`00-landscape-assessment.md`](00-landscape-assessment.md) in live data instead of documentation alone.

> **Credentials note:** no passwords, client secrets, or tokens are recorded in this file. The instance admin password and OAuth client secret were used interactively during this session and are not persisted here. If this instance is reused for future work, treat the OAuth application (`dashboard-ai-assessment` or equivalent) as already registered — check System OAuth → Application Registry before creating a duplicate.

---

## 1. Access troubleshooting (for future reference) — ❌ CONCLUSION FALSIFIED

> **This section's conclusion is wrong.** Session-cookie auth against the Table API works fine on
> this instance; it requires the `X-UserToken: <g_ck>` header, scraped from `/navpage.do`. Without
> that header ServiceNow returns `401 User is not authenticated` — **the same error text a bad
> credential produces** — which is what led to the mistaken "OAuth-only by design" diagnosis below.
> The same session also drives `POST /sys.scripts.do` for background scripts, a far more useful
> verification surface than the Table API. Full method: [`04`](04-red-team-verification.md) §1.
> The Basic Auth row was not re-tested (no password available); treat it as unverified, not settled.

REST API access on this instance did **not** work via the two most common methods, and it's worth recording why so it isn't re-litigated:

| Method | Result | Notes |
|---|---|---|
| HTTP Basic Auth (`admin` / password) against `/api/now/table/*` | `401 User is not authenticated` | Consistent across multiple retries, credential re-verification, and after a manual browser logout/login cycle. |
| Session-cookie auth (`login.do` form POST → cookie jar → Table API) | `401` on the API call, despite `X-Is-Logged-In: true` on the session itself | The split — UI-authenticated but REST-API-rejected — is the signature of the API layer requiring OAuth specifically, not a session/credential problem. |
| **OAuth 2.0 Password Grant** | **Works** | See §2. This is the correct path for this instance going forward. |

Two dead ends investigated and ruled out along the way:
- **Concurrent sessions** (a separate browser tab or another tool's session against the same instance) — ruled out, because it wouldn't produce "login succeeds, API rejects"; it would produce a failed login outright.
- **A pre-authenticated `ServiceNow MCP` connector** available in this environment — turned out to be bound to a *different*, persistent demo tenant (real usage history, non-fresh data) with an ITSM-skill-scoped toolset (incident/case summarization, alert analysis, access audits) and no chart/dashboard-generation tool. Useful for testing Now Assist's summarization behavior in general (see §4), but not a substitute for direct access to dev390988.

## 2. OAuth setup used

1. System OAuth → Application Registry → New → "Create an OAuth API endpoint for external clients"
2. Registered an application, generating a Client ID + Client Secret
3. Token request:
   ```
   POST https://dev390988.service-now.com/oauth_token.do
   Content-Type: application/x-www-form-urlencoded

   grant_type=password
   client_id=<redacted>
   client_secret=<redacted>
   username=admin
   password=<redacted>
   ```
4. Response: a `Bearer` access token, `expires_in: 1799` (30 min), plus a refresh token.
5. All subsequent Table API calls used `Authorization: Bearer <access_token>`.

## 3. Instance build info

Queried `sys_properties` for `glide.buildname` / `glide.buildtag` / `glide.war` / `glide.product.description`:

```
glide.product.description = Service Management
glide.war = glide-australia-02-11-2026__patch3-05-25-2026_06-12-2026_1106.zip
```

Instance is on the **"Australia"** release train, built 2026-02-11, patched through 2026-06-12. Current at time of check.

## 4. Plugin / capability inventory

`sys_plugins` returned `403 Failed API level ACL Validation` for the API-authenticated user on direct queries — the readable table for this purpose turned out to be **`v_plugin`**, not `sys_plugins`.

### Now Assist

| Plugin | Active | Version |
|---|---|---|
| Now Assist Core | ✅ active | 29.3.10 |
| ServiceNow Call Now Assist Skill Step Plugin | inactive | 1.0.0 |

### UI Builder / Now Experience Framework (UXF)

No plugin literally named "UI Builder" or "Data Visualization" — these are bundled into the core Now Experience Framework rather than being separately toggleable. Confirmed via `sys_ux_lib_component` (see below) that the visualization tooling is present and active.

### Performance Analytics

Extensively active — dozens of content packs. Selected active ones: Performance Analytics (core), Performance Analytics AI, Performance Analytics – KPI Signals, Asset Management PA, Performance Analytics Premium for Software Asset Management, Content Packs for Change/Problem/Request/Incident SLA Management, Performance Analytics and Reporting – Service Portal Widgets, Performance Analytics – Spotlight, Now Experience Analytics (2.0.0), Self-Service Analytics Core (29.0.2).

Many other Content Packs and Premium modules are present but **inactive** (Customer Service, CMDB, Communities, Event Management, HR, Financial, IT Ops Suite, PPM, Security Ops, Service Watch Insight, etc.) — available but not currently switched on for this instance.

### Generative AI (platform-level, non-Now-Assist)

| Plugin | Active |
|---|---|
| Glide Conversation Generative AI | inactive |
| Flow Designer – Generative AI Extensions | inactive |

## 5. OOB chart component inventory — ❌ FALSIFIED (search-filter artifact)

> **This section is wrong and its conclusion must not be cited.** The query below filtered
> component names for **chart / visualization / graph**. ServiceNow's actual visualization
> components are named `now-vis-*` with extension modules under `now-visualization-extensions/*`
> — none of which match that filter. The search excluded the very components it was counting.
> The instance holds **1,831** components in `sys_ux_lib_component`; this pass looked at 21.
>
> **Actual live inventory** (`source_script_name LIKE now-visualization-extensions`, exhaustive):
> `__bar__`, `__bubble__`, `__dial__`, `__gauge__`, `__geomap__`, `__heatmap__`, `__pareto__`,
> `__pie__`, `__singleScore__`, `__timeseries__` — **10** — plus `now-vis-sparkline`,
> `now-vis-navigator`, `sn-multipivot` / `sn-par-multipivot-extension` (pivot),
> `sn-par-calendar-connected` (calendar report), `sn-par-scorecard-*` (indicator scorecard),
> `timeline-chart`. **≥15 types, not 6.** Corroborated by ServiceNow's own
> [Types of data visualization](https://www.servicenow.com/docs/r/now-intelligence/data-visualization-type-overview.html),
> which names ~16 Visualization Designer types (adding boxplot and list).
>
> Full analysis and what the argument becomes instead: [`04`](04-red-team-verification.md) §2.

Queried `sys_ux_lib_component` (fields are `sys_name` / `tag` / `source_script_name`, not `name`/`label` — the table doesn't use conventional field names) for anything matching chart/visualization/graph:

```
now-chart-sparkline           | @servicenow/now-chart-sparkline
now-chart-navigator           | @servicenow/now-chart-navigator
now-chart-bar                 | @servicenow/now-chart-bar
now-chart-donut-pie           | @servicenow/now-chart-donut-pie
now-chart-timeseries          | @servicenow/now-chart-timeseries
sn-uxa-pie-chart               | @servicenow/uxa-commons
sn-uxa-line-chart               | @servicenow/uxa-commons-connected
timeline-chart                 | sn-component-timeline
sn-chart-renderer              | sn-chart-renderer
sn-single-score-visualization  | sn-component-visualization
sn-component-visualization      | sn-component-visualization
sn-component-visualization-list | sn-component-visualization
sn-component-visualization-error| sn-component-visualization
now-uxf-visualization-connected | @servicenow/now-uxf-visualization-connected
now-uxf-visualization-config-panel | @servicenow/now-uxf-visualization-config-panel
sn-chart-screen-reader-table   | @devsnc/sn-chart-screen-reader-table
sn-par-visualization-base       | sn-par-visualization-base
sn-par-chart-size               | @now-par-components/sn-par-chart-size
sn-par-visualization-header     | @now-par-components/sn-par-visualization-header
sn-par-chart-drilldown-config   | sn-app-par-components-chart-drilldown-configuration
sn-par-data-visualization-wrapper | sn-app-par-components-data-visualization-wrapper
sn-par-saved-data-visualization  | sn-app-par-components-saved-data-visualization
sn-visualization-controls-section | @now-par-components/sn-par-visualization-controls-section
```

**Distinct chart *types* in that list** (stripping out config panels, wrappers, and accessibility helpers): **bar, donut/pie, line/timeseries, sparkline, timeline, single-score.** Six primitives. ~~This is what both native Now Assist visualization generation and OOB UI Builder dashboards are ultimately drawing from — live, direct confirmation of the "fixed, capped chart palette" claim (Ceiling 1) in the main assessment, not an assumption carried over from documentation.~~

> ❌ **The conclusion in the struck-through sentence is false.** See the banner at the top of this
> section. The list above is an incomplete slice of the component library, not the OOB chart
> palette, and it was never evidence for Ceiling 1.

## 6. Third-party charting apps

Queried `sys_app` for any app with a non-empty `vendor` field, and separately searched both `sys_app` and `sys_store_app` for names matching chart/vivid/d3/echarts:

- `sys_app` (vendor-attributed apps): **no results**
- `sys_app` name search: **no results**
- `sys_store_app` name search: `403 Failed API level ACL Validation` (table not readable with this token's scope — inconclusive by that path, but the `sys_app` result is consistent with a clean instance)

No evidence of VividCharts, Highcharts, ECharts, or D3 already installed as an app. Treat dev390988 as a clean slate for a custom-build demo — no existing charting app to work around or be confused with.

> ⚠️ **Weaker than stated.** `sys_store_app` was unreadable (403), so the primary table for
> Store-installed apps was never checked; the `sys_app` vendor query is an indirect proxy. The
> conclusion is *probably* right for a fresh PDI, but the honest wording is "no evidence found,
> `sys_store_app` unreadable" — not "confirmed clean."

## 7. ServiceNow MCP connector (side note, different tenant)

Not dev390988. Tested for completeness once discovered mid-session:

- `look_up_incident_records` returned classic seed/demo incident numbers (`INC0000007`, `INC0000017`, `INC0000059`)
- `get_access_audit` for `admin` returned a fully computed access-audit result with real usage telemetry (last login 2 days prior, 7,811 tasks) — inconsistent with a fresh PDI, confirming this is a different, persistent tenant
- `incident_summarization` on `INC0000007` produced a clean single-record structured summary (Issue / Key Actions Taken / Resolution) — useful corroboration that Now Assist skills operate record-by-record, not as autonomous dataset-level curation (supports Ceiling 2 in the main assessment), but not a dev390988-specific data point

No chart/dashboard-generation tool exists in this connector's toolset, so it could not be used to verify chart-type counts directly — that came from the `sys_ux_lib_component` query in §5 instead.
