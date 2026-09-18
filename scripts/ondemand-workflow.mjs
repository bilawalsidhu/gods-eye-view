#!/usr/bin/env node
/**
 * scripts/ondemand-workflow.mjs — operator CLI for the GodsEye Advanced
 * Spatial Workflow on the OnDemand Agents Flow Builder.
 *
 * Uses ONLY the endpoints documented in docs/ONDEMAND_API_CURRENT.md §7.1
 * (base `https://api.on-demand.io/automation/api`, header `apikey`):
 *
 *   build                     print the create-body (no network)
 *   create                    POST /workflow/                -> {id}
 *   get <workflowId>          GET  /workflow/{id}
 *   list [keyword]            GET  /workflow/?limit=50&keyword=
 *   activate <workflowId>     POST /workflow/{id}/activate
 *   deactivate <workflowId>   POST /workflow/{id}/deactivate
 *   update <workflowId>       PATCH /workflow/{id} with the current build
 *   export <workflowId> <out> GET  /workflow/{id} -> secrets stripped -> file
 *   execute <workflowId>      POST /workflow/{id}/execute      -> {executionID}
 *   status <executionId>      GET  /execution/{executionID}
 *   logs <executionId>        GET  /execution/{executionID}/logs
 *   outputs <executionId>     GET  /execution/{executionID}/node/outputs
 *   executions <workflowId>   GET  /execution/list?workflowID=
 *   verify <workflowId> [--report <file>] [--timeout-ms N]
 *                             execute, poll status/logs (documented polling —
 *                             a streaming-logs endpoint is NOT FOUND IN LIVE
 *                             DOCS), read node outputs, validate the final
 *                             StructuredResponse (7 keys, 28 action names)
 *
 * Credentials: ONDEMAND_API_KEY is read from the process environment ONLY
 * and never printed, written or echoed (every log line and report is
 * passed through redact()). ONDEMAND_BASE_URL overrides the host.
 *
 * Node 18+, zero dependencies.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildGodsEyeWorkflowDefinition,
  validateStructuredResponse,
  NODE_KEYS,
  WORKFLOW_NAME,
  WORKFLOW_VERSION,
} from '../server/ondemand/workflow-definition.js';
import { TIER_DEFAULTS, config } from '../server/ondemand/config.js';
import { GEV_ACTION_SCHEMAS } from '../src/voice/actionSchemas.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API_KEY = process.env.ONDEMAND_API_KEY || '';
const BASE = `${(process.env.ONDEMAND_BASE_URL || 'https://api.on-demand.io').replace(/\/+$/, '')}/automation/api`;

function nowIso() {
  return new Date().toISOString();
}

function redact(value) {
  if (!API_KEY) return value;
  if (typeof value === 'string') return value.split(API_KEY).join('****');
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = redact(v);
    return out;
  }
  return value;
}

function log(line) {
  process.stderr.write(`${redact(line)}\n`);
}

function requireKey() {
  if (!API_KEY) {
    log('ONDEMAND_API_KEY is not set in the environment');
    process.exit(2);
  }
}

/** One documented call; returns {status, ms, utc, json, text}. */
async function call(method, pathname, body) {
  requireKey();
  const url = `${BASE}${pathname}`;
  const headers = { apikey: API_KEY };
  const init = { method, headers };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const utc = nowIso();
  const started = Date.now();
  const res = await fetch(url, init);
  const ms = Date.now() - started;
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  log(`${utc} ${method} ${pathname} -> ${res.status} (${ms} ms)`);
  return { status: res.status, ms, utc, json, text };
}

function buildBody() {
  return buildGodsEyeWorkflowDefinition({
    actionSchemas: GEV_ACTION_SCHEMAS,
    tiers: TIER_DEFAULTS,
    fulfillmentEndpointId: config.fulfillmentEndpointId,
    nowIso: nowIso(),
  });
}

/** Remove anything credential-like from an exported workflow object. */
export function stripSecrets(workflow) {
  const clone = JSON.parse(JSON.stringify(workflow));
  const data = clone.data || clone;
  if (data.trigger?.webhook) {
    if (data.trigger.webhook.auth) {
      data.trigger.webhook.auth = { username: '', password: '' };
    }
    if (
      typeof data.trigger.webhook.url === 'string' &&
      data.trigger.webhook.url
    ) {
      data.trigger.webhook.url = '<redacted — read it from the dashboard>';
    }
  }
  for (const d of data.delivery || []) {
    if (d?.config?.webhook?.basicAuth) {
      d.config.webhook.basicAuth = { username: '', password: '' };
    }
    if (d?.config?.slack?.webhook) d.config.slack.webhook = '<redacted>';
  }
  return redact(clone);
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(redact(value), null, 2)}\n`);
}

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function actionNames() {
  return GEV_ACTION_SCHEMAS.map((s) => s.name);
}

/** Parse the value of a node output into JSON if it is JSON text. */
function parseNodeValue(value) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string') return null;
  const trimmed = value
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start > -1 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

async function verify(workflowId) {
  const timeoutMs = Number(arg('--timeout-ms', '240000'));
  const pollMs = Number(arg('--poll-ms', '3000'));
  const reportPath = arg('--report', '');
  const report = {
    workflowId,
    workflowName: WORKFLOW_NAME,
    flowVersion: WORKFLOW_VERSION,
    startedAtUtc: nowIso(),
    calls: [],
    logEvents: [],
    timeToFirstLogMs: null,
    finalStatus: null,
    totalLatencyMs: null,
    nodeOutputs: {},
    structuredResponse: null,
    validation: null,
  };
  const record = (label, r) => {
    report.calls.push({ label, status: r.status, ms: r.ms, utc: r.utc });
    return r;
  };
  const t0 = Date.now();
  const exec = record(
    'execute',
    await call('POST', `/workflow/${encodeURIComponent(workflowId)}/execute`),
  );
  const executionId = exec.json?.executionID;
  report.executionId = executionId || null;
  if (!executionId) {
    report.error = `execute returned no executionID: ${exec.text.slice(0, 200)}`;
    return finish(report, reportPath, 1);
  }
  const seenLogs = new Set();
  let status = null;
  let firstLogAt = null;
  while (Date.now() - t0 < timeoutMs) {
    const st = record(
      'status',
      await call('GET', `/execution/${encodeURIComponent(executionId)}`),
    );
    status = st.json?.data?.status ?? st.json?.status ?? null;
    const lg = record(
      'logs',
      await call('GET', `/execution/${encodeURIComponent(executionId)}/logs`),
    );
    const entries = Array.isArray(lg.json?.data) ? lg.json.data : [];
    for (const e of entries) {
      const id = `${e.timestamp}|${e.nodeKey}|${e.message}`;
      if (seenLogs.has(id)) continue;
      seenLogs.add(id);
      report.logEvents.push({
        timestamp: e.timestamp,
        utc: e.timestamp ? new Date(e.timestamp).toISOString() : null,
        nodeKey: e.nodeKey,
        message: e.message,
      });
    }
    if (entries.length && firstLogAt === null) {
      firstLogAt = Date.now();
      report.timeToFirstLogMs = firstLogAt - t0;
      const earliest = Math.min(...entries.map((e) => e.timestamp || Infinity));
      if (Number.isFinite(earliest)) {
        report.firstLogEventUtc = new Date(earliest).toISOString();
      }
    }
    const ended = st.json?.data?.endedAtInMilliseconds;
    if (
      status &&
      status !== 'executing' &&
      status !== 'pending' &&
      status !== 'running'
    )
      break;
    if (typeof ended === 'number' && ended > 0) break;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  report.finalStatus = status;
  report.totalLatencyMs = Date.now() - t0;
  report.logEvents.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  const out = record(
    'outputs',
    await call(
      'GET',
      `/execution/${encodeURIComponent(executionId)}/node/outputs`,
    ),
  );
  const outputs = out.json?.data?.outputs || {};
  for (const key of NODE_KEYS) {
    const o = outputs[key];
    if (!o) continue;
    const value =
      typeof o.value === 'string' ? o.value : JSON.stringify(o.value);
    report.nodeOutputs[key] = {
      nodeType: o.nodeType,
      timeTakenInMilliseconds: o.timeTakenInMilliseconds,
      valueChars: value ? value.length : 0,
      valuePreview: value ? value.slice(0, 160) : '',
    };
  }
  const finalNode = outputs.structured_response;
  const parsed = finalNode ? parseNodeValue(finalNode.value) : null;
  report.structuredResponse = parsed;
  report.validation = parsed
    ? validateStructuredResponse(parsed, actionNames())
    : {
        ok: false,
        errors: ['structured_response node output missing or not JSON'],
      };
  if (parsed && Array.isArray(parsed.actions)) {
    report.actionNamesUsed = [
      ...new Set(parsed.actions.map((a) => a && a.name)),
    ];
  }
  return finish(report, reportPath, report.validation.ok ? 0 : 1);
}

function finish(report, reportPath, code) {
  report.finishedAtUtc = nowIso();
  const safe = redact(report);
  if (reportPath) {
    writeFileSync(
      path.resolve(ROOT, reportPath),
      `${JSON.stringify(safe, null, 2)}\n`,
    );
    log(`report written to ${reportPath}`);
  }
  printJson(safe);
  process.exitCode = code;
}

async function main() {
  const [cmd, a1, a2] = process.argv.slice(2);
  switch (cmd) {
    case 'build':
      return printJson(buildBody());
    case 'create': {
      const r = await call('POST', '/workflow/', buildBody());
      return printJson({
        status: r.status,
        utc: r.utc,
        ms: r.ms,
        body: r.json ?? r.text.slice(0, 300),
      });
    }
    case 'update': {
      const body = buildBody();
      const r = await call(
        'PATCH',
        `/workflow/${encodeURIComponent(a1)}`,
        body,
      );
      return printJson({
        status: r.status,
        utc: r.utc,
        ms: r.ms,
        body: r.json ?? r.text.slice(0, 300),
      });
    }
    case 'get': {
      const r = await call('GET', `/workflow/${encodeURIComponent(a1)}`);
      return printJson({
        status: r.status,
        utc: r.utc,
        ms: r.ms,
        body: stripSecrets(r.json ?? {}),
      });
    }
    case 'list': {
      const q = a1 ? `&keyword=${encodeURIComponent(a1)}` : '';
      const r = await call('GET', `/workflow/?limit=50${q}`);
      return printJson({
        status: r.status,
        utc: r.utc,
        ms: r.ms,
        body: r.json,
      });
    }
    case 'activate':
    case 'deactivate': {
      const r = await call(
        'POST',
        `/workflow/${encodeURIComponent(a1)}/${cmd}`,
      );
      return printJson({
        status: r.status,
        utc: r.utc,
        ms: r.ms,
        body: r.json ?? r.text.slice(0, 300),
      });
    }
    case 'export': {
      const r = await call('GET', `/workflow/${encodeURIComponent(a1)}`);
      if (r.status !== 200)
        return printJson({
          status: r.status,
          utc: r.utc,
          body: r.text.slice(0, 300),
        });
      const stripped = stripSecrets(r.json);
      const doc = {
        _export: {
          source:
            'GET https://api.on-demand.io/automation/api/workflow/{id} (docs/ONDEMAND_API_CURRENT.md §7.1 "Get workflow")',
          note: 'No documented "Get Code"/export endpoint exists (§7.3: NOT FOUND IN LIVE DOCS); this is the documented workflow object with credential-like fields stripped. Re-import: POST the "createBody" below to /automation/api/workflow/ (see README.md).',
          exportedAtUtc: r.utc,
          httpStatus: r.status,
          flowVersion: WORKFLOW_VERSION,
        },
        workflow: stripped.data ?? stripped,
        createBody: buildBody(),
      };
      writeFileSync(
        path.resolve(ROOT, a2),
        `${JSON.stringify(redact(doc), null, 2)}\n`,
      );
      log(`exported to ${a2}`);
      return printJson({
        status: r.status,
        utc: r.utc,
        id: doc.workflow.id,
        isActive: doc.workflow.isActive,
      });
    }
    case 'execute': {
      const r = await call(
        'POST',
        `/workflow/${encodeURIComponent(a1)}/execute`,
      );
      return printJson({
        status: r.status,
        utc: r.utc,
        ms: r.ms,
        body: r.json ?? r.text.slice(0, 300),
      });
    }
    case 'status': {
      const r = await call('GET', `/execution/${encodeURIComponent(a1)}`);
      return printJson({
        status: r.status,
        utc: r.utc,
        ms: r.ms,
        body: r.json,
      });
    }
    case 'logs': {
      const r = await call('GET', `/execution/${encodeURIComponent(a1)}/logs`);
      return printJson({
        status: r.status,
        utc: r.utc,
        ms: r.ms,
        body: r.json,
      });
    }
    case 'outputs': {
      const r = await call(
        'GET',
        `/execution/${encodeURIComponent(a1)}/node/outputs`,
      );
      return printJson({
        status: r.status,
        utc: r.utc,
        ms: r.ms,
        body: r.json,
      });
    }
    case 'executions': {
      const r = await call(
        'GET',
        `/execution/list?workflowID=${encodeURIComponent(a1)}`,
      );
      return printJson({
        status: r.status,
        utc: r.utc,
        ms: r.ms,
        body: r.json,
      });
    }
    case 'verify':
      return verify(a1);
    default:
      log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0]);
      process.exitCode = 2;
  }
}

main().catch((err) => {
  log(`error: ${err?.message || err}`);
  process.exitCode = 1;
});
