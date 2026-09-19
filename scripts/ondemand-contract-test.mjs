#!/usr/bin/env node
/**
 * Thin CLI for the OnDemand integration contract test -- all step logic
 * lives in server/ondemand/contract-steps.js (`runContractSteps()` /
 * `buildDryPlan()`); this file only parses argv/env, prints progress lines,
 * writes the optional --json-out report, and picks the process exit code.
 * Gated 1:1 to docs/ONDEMAND_API_CURRENT.md.
 *
 *   --mode direct  talks to OnDemand directly (needs ONDEMAND_API_KEY)
 *   --mode proxy   talks to THIS repo's same-origin proxy (api/ondemand/*.js)
 *                  at --proxy-base <url> / ONDEMAND_PROXY_BASE -- NO key
 *
 * Auto-detect (when --mode is omitted): a proxy base present (flag or env)
 * selects proxy mode; otherwise direct mode is selected. Every run prints a
 * `MODE: ...` header line stating which mode it picked and why.
 *
 * Usage:
 *   ONDEMAND_API_KEY=... node scripts/ondemand-contract-test.mjs
 *   node scripts/ondemand-contract-test.mjs --mode proxy --proxy-base https://host/api/ondemand
 *   node scripts/ondemand-contract-test.mjs --dry-run [--mode proxy --proxy-base <url>]
 *   node scripts/ondemand-contract-test.mjs --json-out /path/report.json [...]
 *
 * Flags: --mode direct|proxy, --proxy-base <url> (or env ONDEMAND_PROXY_BASE),
 * --dry-run (print the 10 planned requests, no network, exit 0), --json-out
 * <path> (write the report -- shape documented on runContractSteps() in
 * server/ondemand/contract-steps.js), --timeout-ms <n> (default 60000; SSE
 * steps default to 120000 unless this flag is given, which then applies to
 * every request including SSE).
 *
 * Env (read ONLY from process.env -- a key is NEVER accepted as an argv
 * value, and process.env is never printed or logged in full):
 *   ONDEMAND_API_KEY                  required for --mode direct
 *   ONDEMAND_BASE_URL / ONDEMAND_API_BASE  direct mode base url (canonical /
 *                                     alias), default https://api.on-demand.io
 *   ONDEMAND_FULFILLMENT_ENDPOINT_ID / ONDEMAND_ENDPOINT_ID  endpointId to
 *                                     send; direct mode falls back to
 *                                     'predefined-claude-sonnet-5' when unset
 *                                     (see server/ondemand/contract-steps.js);
 *                                     proxy mode omits it so the proxy
 *                                     applies its own default
 *   ONDEMAND_SPATIAL_AGENT_ID         direct-mode pluginIds for steps 4/9
 *                                     (single id or comma/whitespace list)
 *   ONDEMAND_SPATIAL_FLOW_ID          direct-mode workflow id for step 8
 *
 * Node 18+, ESM. Zero dependencies beyond node:fs/node:path for --json-out;
 * see server/ondemand/contract-steps.js for the network layer.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  runContractSteps,
  buildDryPlan,
} from '../server/ondemand/contract-steps.js';

function parseArgs(argv) {
  const out = {
    mode: null,
    proxyBase: null,
    dryRun: false,
    jsonOut: null,
    timeoutMs: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--mode') out.mode = argv[++i] ?? null;
    else if (a.startsWith('--mode=')) out.mode = a.slice('--mode='.length);
    else if (a === '--proxy-base') out.proxyBase = argv[++i] ?? null;
    else if (a.startsWith('--proxy-base='))
      out.proxyBase = a.slice('--proxy-base='.length);
    else if (a === '--json-out') out.jsonOut = argv[++i] ?? null;
    else if (a.startsWith('--json-out='))
      out.jsonOut = a.slice('--json-out='.length);
    else if (a === '--timeout-ms') out.timeoutMs = Number(argv[++i]);
    else if (a.startsWith('--timeout-ms='))
      out.timeoutMs = Number(a.slice('--timeout-ms='.length));
  }
  return out;
}

const ARGS = parseArgs(process.argv.slice(2));
const DRY_RUN = ARGS.dryRun;
const JSON_OUT = ARGS.jsonOut;

if (ARGS.mode !== null && ARGS.mode !== 'direct' && ARGS.mode !== 'proxy') {
  console.error(`Invalid --mode "${ARGS.mode}"; expected "direct" or "proxy".`);
  process.exit(2);
}
const MODE_EXPLICIT = ARGS.mode !== null;
const proxyBaseRaw = ARGS.proxyBase || process.env.ONDEMAND_PROXY_BASE || '';
const MODE = MODE_EXPLICIT ? ARGS.mode : proxyBaseRaw ? 'proxy' : 'direct';

let PROXY_BASE = '';
if (MODE === 'proxy') {
  if (!proxyBaseRaw) {
    console.error(
      '--mode proxy requires --proxy-base <url> or the ONDEMAND_PROXY_BASE environment variable.',
    );
    process.exit(2);
  }
  try {
    const u = new URL(proxyBaseRaw);
    u.search = '';
    u.hash = '';
    PROXY_BASE = u.toString().replace(/\/+$/, '');
  } catch {
    console.error(`--proxy-base is not a valid URL: "${proxyBaseRaw}"`);
    process.exit(2);
  }
}

const API_KEY = process.env.ONDEMAND_API_KEY || '';
const BASE_URL = (
  process.env.ONDEMAND_BASE_URL ||
  process.env.ONDEMAND_API_BASE ||
  'https://api.on-demand.io'
).replace(/\/+$/, '');
const FULFILLMENT_ENDPOINT_ID =
  process.env.ONDEMAND_FULFILLMENT_ENDPOINT_ID ||
  process.env.ONDEMAND_ENDPOINT_ID ||
  '';
const SPATIAL_AGENT_IDS = (process.env.ONDEMAND_SPATIAL_AGENT_ID || '')
  .split(/[,\s]+/)
  .map((s) => s.trim())
  .filter(Boolean);
const SPATIAL_FLOW_ID = process.env.ONDEMAND_SPATIAL_FLOW_ID || '';
const TIMEOUT_MS =
  Number.isFinite(ARGS.timeoutMs) && ARGS.timeoutMs > 0
    ? ARGS.timeoutMs
    : undefined;

function headerLine() {
  if (MODE === 'proxy') {
    let reason;
    if (MODE_EXPLICIT) reason = 'explicit --mode proxy';
    else if (!API_KEY) reason = 'forced: no ONDEMAND_API_KEY in env';
    else reason = 'auto-detected: --proxy-base/ONDEMAND_PROXY_BASE set';
    return `MODE: proxy (${reason}; base=${PROXY_BASE})`;
  }
  const reason = MODE_EXPLICIT
    ? 'explicit --mode direct'
    : 'auto-detected: no --proxy-base/ONDEMAND_PROXY_BASE set';
  return `MODE: direct (${reason}; base=${BASE_URL})`;
}

console.log(headerLine());

if (MODE === 'direct' && !API_KEY && !DRY_RUN) {
  console.error(
    'ONDEMAND_API_KEY is required for --mode direct (read from the environment only -- this script never accepts a key as a command-line argument). Aborting.',
  );
  process.exit(2);
}

const runOptions = {
  mode: MODE,
  apiKey: API_KEY,
  baseUrl: BASE_URL,
  proxyBase: PROXY_BASE,
  fulfillmentEndpointId: FULFILLMENT_ENDPOINT_ID,
  pluginIds: SPATIAL_AGENT_IDS,
  flowId: SPATIAL_FLOW_ID,
  ...(TIMEOUT_MS !== undefined
    ? { timeoutMs: TIMEOUT_MS, sseTimeoutMs: TIMEOUT_MS }
    : {}),
};

if (DRY_RUN) {
  for (const line of buildDryPlan(runOptions)) console.log(line);
  process.exit(0);
}

let report;
try {
  report = await runContractSteps({ ...runOptions, log: console.log });
} catch (err) {
  console.error(
    'Unexpected contract-test crash:',
    err?.stack || err?.message || err,
  );
  console.log(
    `CONTRACT RESULT: mode=${MODE} passed=0 failed=1 skipped=0 totalMs=0`,
  );
  process.exit(1);
}

if (JSON_OUT) {
  fs.mkdirSync(path.dirname(JSON_OUT), { recursive: true });
  fs.writeFileSync(JSON_OUT, JSON.stringify(report, null, 2));
}

const { summary } = report;
console.log(
  `CONTRACT RESULT: mode=${MODE} passed=${summary.passed} failed=${summary.failed} skipped=${summary.skipped} totalMs=${summary.totalMs}`,
);
process.exit(summary.failed > 0 ? 1 : 0);
