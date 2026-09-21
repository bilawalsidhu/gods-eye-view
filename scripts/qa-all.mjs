#!/usr/bin/env node
/**
 * E2E orchestrator: runs every scripts/qa-*.mjs harness sequentially against
 * one dev server (the `test:e2e` pattern from the sibling-projects review).
 *
 * Suites are discovered by glob, so new harnesses are picked up without
 * editing this file. Sequential execution is a hard requirement: each harness
 * drives the same browser and page state, and editing/serving sources mid-run
 * (e.g. a parallel suite triggering HMR) reloads the page out from under the
 * running suite.
 *
 * Usage:
 *   node scripts/qa-all.mjs                    # all suites against :4173
 *   node scripts/qa-all.mjs --filter labels    # suites whose name matches
 *   node scripts/qa-all.mjs --list             # print the suite list, exit
 *   node scripts/qa-all.mjs --url http://localhost:4177 --timeout 600000
 *
 * Environment: QA_BASE_URL is set for every child (suites that read it), and
 * the URL is passed twice on the command line — once bare (qa-voice-wav reads
 * positional argv[2]) and once as `--url <BASE_URL>` (flag-parsing suites;
 * several default to their own historical port, e.g. qa-attribution-b12 →
 * :4300, so the flag must win). Start the dev server and Xvfb before running;
 * this script does not manage either.
 *
 * Flake taxonomy — classify a red into one of these BEFORE touching code
 * (details and history in docs/PLAN.md 11.1):
 *   1. CONTENTION — timing bars, waitFor timeouts on live-data capture,
 *      protocolTimeout, paint p95: fails when the shared box is loaded
 *      (other tenants), passes solo. Re-run on a quiet box before believing
 *      it (`scripts/qa-when-quiet.mjs` automates the gate). A red that
 *      survives a solo re-run is a REAL regression.
 *   2. TRANSPORT — `net::ERR_NETWORK_CHANGED` and other disconnect-path
 *      codes on tile/CDN fetches: OS-level network events, no product
 *      change prevents them. Count and report; never fail on them.
 *   3. HEADLESS rAF STARVATION — an evaluate that never returns
 *      (protocolTimeout) or a 0×0/same-tick measurement: a settled scene
 *      produces no BeginFrames, so rAF-scheduled work sits pending through
 *      any sleep. Fix with scripts/lib/headlessFrames.mjs (pump + poll the
 *      real contract), never with a longer sleep.
 *   4. HARNESS DRIFT — the suite asserts a contract the product legitimately
 *      changed (e.g. a new optimization gate). Fix the suite in the same
 *      commit that changes the contract, or the optimization reads as a
 *      regression.
 *   5. REAL DEFECT — product failure reproducible solo on a quiet box.
 *      Blocks release.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { suiteArgv, suiteTimeoutMs } from './lib/qaSuiteContracts.mjs';
import process from 'node:process';

const argv = process.argv.slice(2);
const getFlag = (name) => argv.includes(name);
const getOpt = (name, fallback) => {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};

const LIST_ONLY = getFlag('--list');
const FILTER = getOpt('--filter', '');
const BASE_URL = getOpt('--url', process.env.QA_BASE_URL || 'http://localhost:4173');
const SUITE_TIMEOUT_MS = Number(getOpt('--timeout', '900000'));
const LOG_DIR = path.resolve(getOpt('--log-dir', '.gev-logs/qa-all'));

const SCRIPTS_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname));

// Per-suite invocation/timeout contracts live in `scripts/lib/qaSuiteContracts.mjs`,
// shared with the quiet-window runner (`scripts/qa-when-quiet.mjs`) so the two
// entrypoints cannot drift.


// Suites that exit nonzero with a self-declared key gate ("Server has no X
// key — run against the keyed dev server") cannot run on this machine by
// design — we do not fabricate credentials. They are reported as ENV-GATED,
// listed in the summary, and do not fail the run.
const ENV_GATE_MARKERS = [
  'run against the keyed dev server',
  'the A/B needs live flow',
  'OPENAI_API_KEY is not set',
];

function discoverSuites() {
  return fs
    .readdirSync(SCRIPTS_DIR)
    .filter((f) => f.startsWith('qa-') && f.endsWith('.mjs') && f !== 'qa-all.mjs')
    .filter((f) => !FILTER || f.includes(FILTER))
    .sort();
}

function runSuite(suite) {
  return new Promise((resolve) => {
    const extraArgs = suiteArgv(suite, BASE_URL);
    const timeoutMs = suiteTimeoutMs(suite, SUITE_TIMEOUT_MS);
    const child = spawn(
      process.execPath,
      [path.join(SCRIPTS_DIR, suite), ...extraArgs],
      {
        env: { ...process.env, QA_BASE_URL: BASE_URL },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const logPath = path.join(LOG_DIR, `${suite}.log`);
    const logStream = fs.createWriteStream(logPath);
    child.stdout.pipe(logStream);
    child.stderr.pipe(logStream);
    // Keep an in-memory copy for gate classification: `logStream.end()` on
    // 'close' flushes asynchronously, so re-reading the file here can miss
    // the final lines — exactly where a suite prints its key-gate message.
    let logText = '';
    child.stdout.on('data', (chunk) => { logText += chunk; });
    child.stderr.on('data', (chunk) => { logText += chunk; });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.on('close', (code) => {
      clearTimeout(timer);
      logStream.end();
      // A SIGKILL we issued means timeout, not a suite crash.
      if (timedOut) return resolve({ suite, status: 'TIMEOUT', code: null });
      if (code !== 0 && ENV_GATE_MARKERS.some((marker) => logText.includes(marker))) {
        return resolve({ suite, status: 'ENV-GATED', code });
      }
      resolve({ suite, status: code === 0 ? 'PASS' : 'FAIL', code });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ suite, status: 'FAIL', code: null, error: String(err) });
    });
  });
}

const suites = discoverSuites();
if (LIST_ONLY) {
  for (const s of suites) console.log(s);
  process.exit(0);
}
if (suites.length === 0) {
  console.error(`no suites match filter "${FILTER}"`);
  process.exit(2);
}

fs.mkdirSync(LOG_DIR, { recursive: true });
console.log(`qa-all: ${suites.length} suites → ${BASE_URL} (logs: ${LOG_DIR})`);

const results = [];
for (const suite of suites) {
  const startedAt = Date.now();
  process.stdout.write(`▶ ${suite} ... `);
  const result = await runSuite(suite);
  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  result.seconds = seconds;
  results.push(result);
  console.log(`${result.status} (${seconds}s)`);
}

const failed = results.filter((r) => r.status !== 'PASS' && r.status !== 'ENV-GATED');
const envGated = results.filter((r) => r.status === 'ENV-GATED');
const gatedSuffix = envGated.length ? ` (${envGated.length} env-gated, keyless by design)` : '';
console.log(`\n${results.length - failed.length - envGated.length}/${results.length} suites passed${gatedSuffix}`);
for (const r of envGated) {
  console.log(`  ⚠ ${r.suite} — ENV-GATED (needs an API key this machine does not have) — ${path.join(LOG_DIR, `${r.suite}.log`)}`);
}
for (const r of failed) {
  console.log(`  ✖ ${r.suite} — ${r.status}${r.code !== null ? ` (exit ${r.code})` : ''} — ${path.join(LOG_DIR, `${r.suite}.log`)}`);
}
process.exit(failed.length > 0 ? 1 : 0);
