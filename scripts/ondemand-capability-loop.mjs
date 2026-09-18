#!/usr/bin/env node
/**
 * scripts/ondemand-capability-loop.mjs — run the interim capability loop
 * (server/ondemand/capability-loop.js) end-to-end from a shell, directly
 * against OnDemand, exactly as api/ondemand/chat.js `mode:'capability-loop'`
 * does inside the deployment. This is the replacement for the run-B
 * "inject provider data into the prompt" E2E step: nothing is pre-fetched;
 * OnDemand decides, the gateway executes only that, the results go back
 * into the same session, and the 7-key StructuredResponse is validated.
 *
 *   ONDEMAND_API_KEY=… node scripts/ondemand-capability-loop.mjs \
 *     --query "Anything unusual around this airport?" \
 *     --bbox 51,24,57,27 --center 24.433,54.651 --tier INVESTIGATE \
 *     [--layers flights,earthquakes] [--user <externalUserId>] \
 *     [--report docs/audit/<file>.json]
 *
 * Credentials: ONDEMAND_API_KEY is read by server/ondemand/config.js from
 * the environment only; it is never printed (every output line is passed
 * through redact()). The report contains the sha256 of the session id,
 * never the id itself.
 */

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  config,
  baseUrls,
  isConfigured,
  tierDefaults,
  TIER_DEFAULTS,
} from '../server/ondemand/config.js';
import { ondemandFetch } from '../server/ondemand/client.js';
import {
  runCapabilityLoop,
  loadRegistry,
} from '../server/ondemand/capability-loop.js';
import { SOURCE_ADAPTERS } from '../server/sources/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i > -1 && process.argv[i + 1] !== undefined
    ? process.argv[i + 1]
    : fallback;
}

function redact(value) {
  const key = config.apiKey;
  if (!key) return value;
  if (typeof value === 'string') return value.split(key).join('<redacted>');
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = redact(v);
    return out;
  }
  return value;
}

async function main() {
  if (!isConfigured()) {
    process.stderr.write('ONDEMAND_API_KEY is not set in the environment\n');
    process.exitCode = 2;
    return;
  }
  const query = arg('--query', 'What is unusual around this airport?');
  const [west, south, east, north] = arg('--bbox', '51,24,57,27')
    .split(',')
    .map(Number);
  const [clat, clon] = arg('--center', '24.433,54.651').split(',').map(Number);
  const tier = arg('--tier', 'INVESTIGATE');
  const layers = arg('--layers', 'flights,earthquakes').split(',');
  const userId =
    arg('--user', '') ||
    `ondemand-spatial-capability-loop-${new Date().toISOString().slice(0, 10)}`;
  const reportPath = arg('--report', '');
  const tierRow = tierDefaults(tier);
  const resolvedTier =
    Object.keys(TIER_DEFAULTS).find((k) => TIER_DEFAULTS[k] === tierRow) ||
    'INVESTIGATE';
  const now = new Date();
  const spatialContext = {
    bbox: { west, south, east, north },
    center: { latitude: clat, longitude: clon },
    activeLayers: layers,
    timeline: { mode: 'live', now: now.toISOString() },
    userAction: 'query',
  };
  const registry = await loadRegistry();
  const log = (line) => process.stderr.write(`${redact(line)}\n`);
  const result = await runCapabilityLoop({
    query,
    spatialContext,
    tier: resolvedTier,
    userId,
    registry,
    adapters: SOURCE_ADAPTERS,
    ondemand: { fetch: ondemandFetch, chatBase: baseUrls().chat },
    endpointId: tierRow.fulfillmentEndpointId,
    reasoningMode: tierRow.reasoningMode,
    log,
  });
  const report = redact({
    ranAtUtc: now.toISOString(),
    query,
    spatialContext,
    ...result,
  });
  if (reportPath) {
    writeFileSync(
      path.resolve(ROOT, reportPath),
      `${JSON.stringify(report, null, 2)}\n`,
    );
    log(`report written to ${reportPath}`);
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = result.ok ? 0 : 1;
}

main().catch((err) => {
  process.stderr.write(`error: ${redact(err?.message || String(err))}\n`);
  process.exitCode = 1;
});
