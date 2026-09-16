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
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
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

// Per-suite invocation/timeout overrides. Most suites take `[url, --url url]`;
// the map exists for the few that don't:
//  - qa-voice-wav reads argv[2] as the app URL and argv[3] as the WAV fixture
//    path, so a `--url` flag would be mistaken for a fixture path.
const SUITE_ARGV_OVERRIDES = {
  'qa-voice-wav.mjs': (baseUrl) => [baseUrl],
};

// Wall-clock ceiling per suite. The default covers the ordinary harnesses;
// the two matrix/baseline suites embed long inner waits (qa-l9-matrix even
// runs `npm test` inside itself) and were measured to need more.
const SUITE_TIMEOUT_OVERRIDES = {
  'qa-l9-matrix.mjs': 2_700_000,
  'qa-overlay-baseline.mjs': 1_800_000,
};

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
    const extraArgs = SUITE_ARGV_OVERRIDES[suite]
      ? SUITE_ARGV_OVERRIDES[suite](BASE_URL)
      : [BASE_URL, '--url', BASE_URL];
    const timeoutMs = SUITE_TIMEOUT_OVERRIDES[suite] ?? SUITE_TIMEOUT_MS;
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
