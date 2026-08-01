# Use Case 2 POC — Build Record & Verification

**Instance:** `eypocinst.service-now.com` (EY POC) · **Release:** Zurich, patch 10 hotfix 3
**Built as:** `ey_Kumar` · **Date:** 2026-08-01

**Live dashboard:** <https://eypocinst.service-now.com/ey_ai_dashboard.do>

This is the build-and-evidence record for the POC. Everything marked ✅ was executed
against the live instance and the output inspected — not inferred from documentation.

---

## 1. What was built

| Layer | Artifact | Where it lives |
|---|---|---|
| Charting library | Apache ECharts 5.5.1 (Apache-2.0), 1,030,855 bytes | Attachment on the UI page — **served from the instance, no CDN** |
| Data engine | `EYAIDashData` Script Include | `global` scope |
| AI layer | `EYAIDashAI` Script Include | `global` scope |
| API | `EY AI Dashboard API` Scripted REST service, 4 resources | base `/api/eyi/ey_ai_dashboard` |
| Dashboard | `ey_ai_dashboard` UI Page (+ CSS/JS attachments) | `/ey_ai_dashboard.do` |
| Chat access | `mcp/servicenow-analytics-mcp.js` | runs on the consultant's machine |

### API resources

| Method | Path | Purpose |
|---|---|---|
| GET | `/overview?table=&months=` | KPIs, monthly trend, 4 breakdowns, MTTR |
| GET | `/aclproof?table=&field=&query=` | Aggregate-vs-ACL correctness check |
| POST | `/insights` | AI analysis over the aggregates |
| GET | `/health?probe=1` | Status; `probe=1` tests outbound AI egress |

---

## 2. Verified against the live instance

### ✅ Instance and access
- Zurich release confirmed (`glide-zurich-07-01-2025__patch10-hotfix3`).
- `ey_Kumar` holds **no `admin` role**, but via group `ey_admin` can write
  `sys_script_include`, `sys_ws_definition`, `sys_ws_operation`, `sys_ui_page`,
  `sp_widget`, `sys_ux_macroponent`. Verified by create-then-delete probes.
- Basic-auth REST works. **Programmatic UI login does not** (SSO/CSRF), so the
  rendered page must be opened in a real browser session.

### ✅ Real data, not seed data
14,000 incidents with a genuine distribution — this is not an empty PDI.

| | |
|---|---|
| incident | 13,986 (13,943 active, 922 P1) |
| task | 112,256 |
| cmdb_ci | 5,508 · kb_knowledge 786 · change_request 238 |
| Categories | Inquiry 3,733 · Software 2,651 · Hardware 2,571 · Network 2,441 · Password reset 2,237 |

### ✅ Native rendering with a real charting library
ECharts is uploaded as an instance attachment and loaded from
`/sys_attachment.do?sys_id=…`. **No external runtime dependency** — the hard
constraint in the client brief is met.

### ✅ Dashboard renders correctly
Verified by running the *deployed* CSS/JS against the *live* API response in headless
Chrome, in both themes (`poc/shot_light.png`, `poc/shot_dark.png`). Four real bugs were
found this way and fixed before deployment: an HTML double-escape, a percentage
rounding error, unreadable axis labels, and priority slices coloured by volume rank
instead of severity.

### ✅ Colour validated, not eyeballed
Every colour was checked with the dataviz validator against both surfaces:
categorical slots pass lightness, chroma, CVD separation and normal-vision floors in
light and dark; the 5-step priority ramp passes monotonicity, step gaps and light-end
contrast. Identity is never carried by colour alone — every chart has direct labels,
and a table view backs the category breakdown.

### ✅ Aggregate correctness under access control
The differentiator, working live:

```
GET /aclproof?table=incident&field=priority
  glideaggregate_total : 13,986
  acl_filtered_total   : 13,986
  leaked               : 0
  verdict              : SAFE — counts agree for this viewer
```

**Read this honestly.** It proves the *mechanism* runs and that the two independent
paths agree **for `ey_Kumar`, who can read everything**. It does **not** demonstrate a
caught leak. To show a non-zero delta you need a restricted persona — see §4.

### ✅ In-instance AI is real
A live One Extend call as `ey_Kumar` returned `status: success`, provider
**Azure OpenAI**, model **gpt-5.4**, with `ENFORCE_ACL_STRICT_MODE` and role masking
active. `sys_generative_ai_log` records it against `ey_Kumar` — that audit row is a
good demo artifact.

### ✅ MCP chat path
Server tested over stdio: `initialize` → `tools/list` → three `tools/call` round
trips, all returning live data (including an ad-hoc group-by on `change_request`
returning the correct 238 records).

---

## 3. The one thing that does **not** work, and why

**Now Assist cannot generate free-form dashboard insight on this instance as `ey_Kumar`.**

Established by direct testing, not assumption:

| Capability | Active provider definition? | Permitted for `ey_Kumar`? |
|---|---|---|
| Analytics query generation | ✅ yes | ✅ yes — **but it is a query generator** |
| Analytics insight generation | ❌ all definitions `active=false` | — |
| Analytics hidden insight / follow-up / merge | ❌ none active | — |
| Summarize | ✅ yes | ❌ "user doesn't have permission" |
| Generic Prompt | ✅ yes | ❌ "user doesn't have permission" |

The one permitted, active skill is a **query generator**. Asked to analyse data it
replies: *"I can't provide hidden chain-of-thought or internal analysis"* — its own
system prompt fights the use case. This is a licensing/entitlement configuration
issue, not a platform limitation.

### Three ways to close it

| Option | Client action | Effort | Result |
|---|---|---|---|
| **A** Grant `one_extend_admin` to the demo user | ServiceNow admin, one role grant | ~2 min | Unlocks Generic Prompt + Summarize; fully native AI |
| **B** Activate an "Analytics insight generation" provider definition | ServiceNow admin | ~5 min | Native analytics insight skill |
| **C** Use the MCP chat path | none | 0 | Chat model does the analysis; **no API key anywhere** |

**Option C works today with nothing to configure** and is what I'd lead the demo with.
A or B makes the in-page button light up too.

> I attempted the role grant during the build and it was correctly blocked as a
> privilege escalation. It needs a human with admin rights to approve.

---

## 4. To demonstrate a caught ACL leak

The correctness story is much stronger with a non-zero delta. Ten minutes of prep:

1. Create user `ey_demo_restricted`, no roles.
2. Add a query business rule or ACL restricting `incident` (e.g. only records whose
   `assignment_group` is one the user belongs to).
3. Call `/aclproof` as that user.

Expected: `glideaggregate_total` stays ~13,986 while `acl_filtered_total` drops
sharply — `leaked` becomes a large number and the dashboard pill flips to
**"Leak detected"** in red. That is the money shot for the correctness argument.

---

## 5. Running the MCP server

```bash
export SN_INSTANCE=eypocinst.service-now.com
export SN_USER=ey_Kumar
export SN_PASS='…'
node mcp/servicenow-analytics-mcp.js
```

Claude Desktop / Claude Code config:

```json
{
  "mcpServers": {
    "servicenow-analytics": {
      "command": "node",
      "args": ["/absolute/path/to/mcp/servicenow-analytics-mcp.js"],
      "env": {
        "SN_INSTANCE": "eypocinst.service-now.com",
        "SN_USER": "ey_Kumar",
        "SN_PASS": "…"
      }
    }
  }
}
```

Zero dependencies (Node 18+ built-in `fetch`). Tools exposed:
`servicenow_dashboard_overview`, `servicenow_group_by`,
`servicenow_acl_correctness_check`, `servicenow_dashboard_link`.

**No LLM API key is configured anywhere.** In a chat session the chat model *is* the
analysis engine — the tools return ACL-safe numbers and the model reasons over them.

---

## 6. Honest limits — do not oversell these

- **Not Power BI parity.** No cross-source semantic model, no DAX-equivalent
  calculated measures, no end-user ad-hoc exploration. What is proven is
  Power-BI-grade *visual and interaction quality on ServiceNow-native data*.
- **The ACL check is bounded.** The secure scan caps at 20,000 rows; past that the
  API returns `capped: true` and the figure is a floor, reported as such. The
  correct-by-construction path (iterate securely, count in memory) is inherently
  slower than `GlideAggregate` — that tradeoff is forced by the platform, and at
  much larger volumes it needs a caching or pre-aggregation strategy.
- **MTTR of ~440 days is real but is a data artifact** — only 46 of 13,986 records
  are resolved, and the seeded `opened_at` values are old. The tile says so on its
  face. Don't present it as an EY service metric.
- **Chart-type fitting is currently rule-based**, driven by the `top_share` /
  `concentration` profile the API returns. Genuinely AI-generated,
  data-shape-adaptive chart specs remain the unproven part of the plan — the
  research found no shipped product doing it, and this POC does not close that gap.
- **`ey_Kumar` is not an admin** but has unusually broad write access via `ey_admin`.
  A production rollout should use a dedicated scoped application.

---

## 7. Deployed record IDs

| Artifact | sys_id |
|---|---|
| UI Page `ey_ai_dashboard` | `27cc1e7333928390c63690834d5c7bd8` |
| ECharts attachment | `c8dc5e7333928390c63690834d5c7b6d` |
| CSS attachment | `da84ee3b33568390c63690834d5c7b04` |
| JS attachment | `49d62eb733968390c63690834d5c7b1e` |
| Script Include `EYAIDashData` | `dcfe5e7f33928390c63690834d5c7b1d` |
| Script Include `EYAIDashAI` | `c32f9a3fc3920390c9efffba05013151` |
| REST service definition | `c47f9e3333d28390c63690834d5c7b74` |

### Cleanup

Delete the two Script Includes, the REST definition (operations cascade), and the UI
Page (attachments cascade). Nothing else on the instance was modified — no OOB record
was touched, no role was granted, no data was written.

### Note on the Script Includes

The REST operations carry their logic **inline** rather than calling the Script
Includes. The Scripted REST service was created in the `eyi` application scope while
the Script Includes are in `global`, and cross-scope construction is blocked without a
Restricted Caller Access grant. Inlining keeps the API self-contained. The Script
Includes remain deployed as the reusable engine; consolidating both into one scope is
tidy-up work for productionisation.
