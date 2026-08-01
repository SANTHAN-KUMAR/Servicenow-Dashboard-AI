#!/usr/bin/env node
/**
 * ServiceNow Analytics MCP server — EY Use Case 2 POC.
 *
 * Exposes the same ACL-safe aggregates that back the in-ServiceNow dashboard as
 * MCP tools, so the data can be explored and analysed from a chat client.
 *
 * There is deliberately no LLM API key here. In an MCP session the chat model IS
 * the analysis engine: these tools return the numbers, the model reasons over
 * them. Nothing to configure beyond the ServiceNow credentials.
 *
 * Zero dependencies — speaks MCP (JSON-RPC 2.0) over stdio directly.
 *
 * Env:
 *   SN_INSTANCE  e.g. eypocinst.service-now.com
 *   SN_USER      ServiceNow username
 *   SN_PASS      ServiceNow password
 */

'use strict';

const INSTANCE = process.env.SN_INSTANCE || 'eypocinst.service-now.com';
const USER = process.env.SN_USER || '';
const PASS = process.env.SN_PASS || '';
const BASE = `https://${INSTANCE}/api/eyi/ey_ai_dashboard`;
const PROTOCOL_VERSION = '2024-11-05';

function authHeader() {
  return 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64');
}

async function snGet(path) {
  const res = await fetch(`https://${INSTANCE}${path}`, {
    headers: { Authorization: authHeader(), Accept: 'application/json' },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`ServiceNow HTTP ${res.status}: ${text.slice(0, 300)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Non-JSON response: ${text.slice(0, 300)}`);
  }
}

// ------------------------------------------------------------------ tools

const TOOLS = [
  {
    name: 'servicenow_dashboard_overview',
    description:
      'Full analytics snapshot for a ServiceNow table: KPI totals, monthly opened volume, ' +
      'and breakdowns by category, priority, state and assignment group, plus mean resolution ' +
      'time. All counts are computed under the calling user\'s access rules. Use this first ' +
      'when asked to analyse or report on ServiceNow operational data.',
    inputSchema: {
      type: 'object',
      properties: {
        table: { type: 'string', description: 'Table name. Defaults to incident.' },
        months: { type: 'integer', description: 'Months of history for the trend. Default 12.' },
      },
    },
  },
  {
    name: 'servicenow_group_by',
    description:
      'Ad-hoc grouped counts for any table/field, with a data-shape profile (distinct values, ' +
      'top share, concentration) so a chart type can be fitted to the actual distribution. ' +
      'Use for questions the standard dashboard breakdowns do not answer.',
    inputSchema: {
      type: 'object',
      properties: {
        table: { type: 'string', description: 'Table name, e.g. incident, change_request, problem.' },
        field: { type: 'string', description: 'Field to group by, e.g. category, state, assigned_to.' },
        query: { type: 'string', description: 'Optional ServiceNow encoded query filter.' },
      },
      required: ['table', 'field'],
    },
  },
  {
    name: 'servicenow_acl_correctness_check',
    description:
      'Verifies an aggregate is safe to show. Runs GlideAggregate (which does NOT enforce ' +
      'row-level ACLs) and an ACL-filtered count over the same query as the calling user, and ' +
      'reports the delta. A non-zero delta means a naive KPI would expose records the viewer ' +
      'cannot open. Use when asked whether a number is trustworthy or access-safe.',
    inputSchema: {
      type: 'object',
      properties: {
        table: { type: 'string', description: 'Table name. Defaults to incident.' },
        field: { type: 'string', description: 'Field to group by. Defaults to category.' },
        query: { type: 'string', description: 'Optional encoded query.' },
      },
    },
  },
  {
    name: 'servicenow_dashboard_link',
    description:
      'Returns the URL of the live visual dashboard inside ServiceNow, and reports which AI ' +
      'provider the instance-side analysis is currently wired to.',
    inputSchema: { type: 'object', properties: {} },
  },
];

async function callTool(name, args) {
  args = args || {};

  if (name === 'servicenow_dashboard_overview') {
    const table = args.table || 'incident';
    const months = args.months || 12;
    const j = await snGet(
      `/api/eyi/ey_ai_dashboard/overview?table=${encodeURIComponent(table)}&months=${months}`
    );
    const d = j.result;
    return {
      viewer: d.viewer_display,
      table: d.table,
      generated_at: d.generated_at,
      note:
        'Counts are ACL-filtered for the calling user. acl_hidden_from_viewer > 0 means a raw ' +
        'aggregate would have over-reported.',
      kpis: d.kpis,
      monthly_opened: d.monthly,
      by_category: d.by_category,
      by_priority: d.by_priority,
      by_state: d.by_state,
      by_assignment_group: d.by_group,
      mean_resolution_hours_by_category: d.mttr_by_category,
    };
  }

  if (name === 'servicenow_group_by') {
    const q = args.query ? `&query=${encodeURIComponent(args.query)}` : '';
    const j = await snGet(
      `/api/eyi/ey_ai_dashboard/aclproof?table=${encodeURIComponent(args.table)}` +
      `&field=${encodeURIComponent(args.field)}${q}`
    );
    const d = j.result;
    return {
      table: d.table,
      field: d.field,
      rows: d.secure_rows,
      total_visible: d.secure_total,
      raw_aggregate_total: d.aggregate_total,
      hidden_by_acl: d.leaked,
      truncated: d.capped,
    };
  }

  if (name === 'servicenow_acl_correctness_check') {
    const table = args.table || 'incident';
    const field = args.field || 'category';
    const q = args.query ? `&query=${encodeURIComponent(args.query)}` : '';
    const j = await snGet(
      `/api/eyi/ey_ai_dashboard/aclproof?table=${encodeURIComponent(table)}` +
      `&field=${encodeURIComponent(field)}${q}`
    );
    const d = j.result;
    return {
      viewer: d.user_display,
      table: d.table,
      field: d.field,
      glideaggregate_total: d.aggregate_total,
      acl_filtered_total: d.secure_total,
      records_hidden_from_viewer: d.leaked,
      safe_to_display: d.leaked === 0,
      scan_truncated: d.capped,
      verdict: d.verdict,
    };
  }

  if (name === 'servicenow_dashboard_link') {
    const j = await snGet('/api/eyi/ey_ai_dashboard/health');
    return {
      dashboard_url: `https://${INSTANCE}/ey_ai_dashboard.do`,
      instance: j.result.instance,
      viewer: j.result.viewer,
      instance_side_ai: j.result.ai,
      note:
        'Open the dashboard URL in a browser with an authenticated ServiceNow session. ' +
        'Analysis in this chat is performed by the chat model over the tool results, so no ' +
        'LLM API key is configured on the ServiceNow side.',
    };
  }

  throw new Error(`Unknown tool: ${name}`);
}

// ------------------------------------------------------------- JSON-RPC

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function replyError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handle(msg) {
  const { id, method, params } = msg;

  if (method === 'initialize') {
    return reply(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: 'servicenow-analytics', version: '1.0.0' },
    });
  }

  if (method === 'notifications/initialized') return; // no response for notifications

  if (method === 'tools/list') {
    return reply(id, { tools: TOOLS });
  }

  if (method === 'tools/call') {
    const toolName = params && params.name;
    try {
      const out = await callTool(toolName, params && params.arguments);
      return reply(id, {
        content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
      });
    } catch (e) {
      return reply(id, {
        content: [{ type: 'text', text: `Error calling ${toolName}: ${e.message}` }],
        isError: true,
      });
    }
  }

  if (id !== undefined) replyError(id, -32601, `Method not found: ${method}`);
}

let buf = '';
let inFlight = 0;
let stdinClosed = false;

// Tool calls are async. Exiting the moment stdin closes would drop any request
// still waiting on ServiceNow, so shutdown waits for the last one to answer.
function maybeExit() {
  if (stdinClosed && inFlight === 0) process.exit(0);
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    inFlight++;
    Promise.resolve(handle(msg))
      .catch((e) => {
        if (msg && msg.id !== undefined) replyError(msg.id, -32603, String(e));
      })
      .finally(() => {
        inFlight--;
        maybeExit();
      });
  }
});

process.stdin.on('end', () => {
  stdinClosed = true;
  maybeExit();
});
