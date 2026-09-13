# The ACL differentiator, checked against the client's real security config

Measured **2026-09-13** against `eypocinst.service-now.com`, read-only, GET
only — the same discipline as `findings.md` in this folder. Raw responses in
`raw/`.

**Why this exists.** Every version of the ACL-correctness differentiator in
this engagement — the `GlideAggregate`-overcounts-what-a-viewer-can't-read
story, the FILTERED/BOUNDED/DENIED badge, the 4,284-vs-818 headline number —
has so far been demonstrated on `dev390988`, our own sandbox, with a
purpose-built role-less test persona. That's a legitimate demonstration of
the *mechanism*. It is not, on its own, evidence that the *precondition* for
the mechanism mattering — real tables whose read access genuinely depends on
a role a real viewer might not hold — exists on the client's own instance.
This closes that gap, without touching or needing to touch their actual
security configuration.

**What this is not.** This does not measure an actual overcount on
eypocinst — that would need either write access to create a test persona
(out of scope for read-only exploring) or a real, known low-privilege user's
own session (not available here). What it measures is whether the
*structural precondition* holds: are there real read ACLs on real tables
that require a role, such that a viewer without that role is a genuine,
reachable state rather than a hypothetical one. `product/deploy/
f2_acl_survey.py`'s own docstring draws exactly this line on dev390988,
for exactly this reason — this is the same question, asked of the client's
own instance instead.

## Method

`f2_acl_survey.py` answers this on dev390988 by running a background script
with admin rights (`GlideRecord` against `sys_security_acl` and
`sys_security_acl_role`, unfiltered by the querying session's own
permissions). That path isn't available here — this session is a real
browser login, not an admin script-execution session — so the same query was
rebuilt as plain Table API reads: `sys_security_acl` filtered to
`name=<table>^operation=read^type=record^active=true`, then
`sys_security_acl_role` per ACL found for its role list. Same logic, same
tables, different transport.

## Result

| table | active read ACLs (type=record) | unconditionally open | roles seen |
|---|---|---|---|
| `incident` | 11 | **0** | `itil`, `sn_incident_read`, `service_viewer`, `sn_dpm.dpm_manager`, `ml_report_user`, `sn_si.read`, `sn_hamp.ham_user`, `sn_sow_srm.*`, `snc_internal` (scripted) |
| `problem` | 6 | **0** | `sn_problem_read`, `problem_task_analyst`/`itil`, `sn_vul.vulnerability_admin`, `sn_si.read`, `sn_dpm.dpm_manager`, `snc_internal` (scripted) |
| `change_request` | 8 | **0** | `sn_change_read`, `itil`, `service_viewer`, `sn_dpm.dpm_manager`, `sn_si.read`, `sn_sow_srm.srm_responder`, `snc_internal` (scripted/conditional) |
| `kb_knowledge` | 5 | **0** | `public` (×4, all scripted, two also conditional), `sn_itom_leap.knowledge_read` |
| `sys_user` | 10 | **0** | a mix of scoped app roles, mostly scripted — no bare unconditional grant |
| `task` | **0** | — | none at all, `type=record` or `type=table`, active or inactive |

**Every active read ACL on every real table checked requires a role, a
script, or a condition. Not one is unconditionally open.** `task` — the
base table `incident`, `problem` and `change_request` all extend — carries
no ACL of its own whatsoever, which means it falls through to the
platform's default-deny security model rather than any explicit grant. This
is the identical structural pattern already resolved and recorded in
`CLAUDE.md` for dev390988 (`glide.sm.default_mode` = `deny`, `task` and
`problem` "carry no unconditional open read ACL and genuinely do filter") —
now independently confirmed on the client's own production-shaped instance,
not assumed to carry over from ours.

**What this means, stated at the size the evidence actually supports:** a
real viewer on this instance who lacks `itil` (or the more specific
equivalents above) is not a constructed edge case — the security model is
built around exactly that distinction being load-bearing. The
FILTERED/BOUNDED/DENIED story this product tells is not a demonstration
built for a sandbox that happens to have the right shape; the client's own
instance has the right shape too. Actually walking a real under-privileged
viewer through it — the number a native report shows them versus what they
can open — is the one thing this pass didn't and couldn't do, and it's the
natural next demonstration if the client wants it made concrete on their
own data rather than dev390988's.

Raw: `raw/acl_survey_eypocinst.json`.

## Report inventory freshness check

`docs/use-case-2/12-commercial-positioning.md` measured **2,368 reports** on
this instance. Re-measured today:

```
GET /api/now/stats/sys_report?sysparm_count=true
-> 2389
```

**+21 reports (0.9%) since that measurement.** Stable enough that the
2,368 figure and everything built on it (the chart-type distribution, the
77%-in-5-types finding) doesn't need re-running — normal organic growth on
a live instance, not drift that would change a conclusion. Raw:
`raw/report_count_eypocinst.json`.

## Raw evidence added by this document

| file | what it is |
|---|---|
| `landing_page_indicators.json` | the 24 Summary-page indicators, resolved (also referenced from `findings.md` §5) |
| `acl_survey_eypocinst.json` | every active read ACL on the six tables checked, with roles |
| `report_count_eypocinst.json` | the current `sys_report` count |

No credentials of any kind are stored in this file or anywhere in this
folder.
