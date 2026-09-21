#!/usr/bin/env node
/**
 * Quiet-window QA runner: waits for the shared box to go quiet, then runs QA
 * suites sequentially — the timing-sensitive harnesses are only meaningful
 * when the machine is not contended (PLAN.md 11.1: the radio catalog probe
 * measures 1.4 s at load 8.6 and fails its 5 s bar at load 34.7, with
 * identical code).
 *
 * Complements `qa-all.mjs` (same suite discovery, same per-suite argv and
 * timeout contracts, same ENV-GATED key-gate classification — all from
 * `scripts/lib/qaSuiteContracts.mjs`) and adds the load gate qa-all does
 * not have:
 *
 *   node scripts/qa-when-quiet.mjs                        # ALL suites, load < 15
 *   node scripts/qa-when-quiet.mjs labels perf            # just these suites
 *   node scripts/qa-when-quiet.mjs --max-load 10 --wait-max-min 120
 *   node scripts/qa-when-quiet.mjs --list                 # print suites, exit
 *
 * Per-suite logs land in `.gev-logs/qa-when-quiet/<suite>.log`; the tally is
 * written to stdout and `.gev-logs/qa-when-quiet/tally.log`.
 *
 * Scope note: the load gate is for TIMING-sensitive suites. Suites that
 * assert scheduler contracts rather than durations (rAF pump + laid-out
 * rects, stability windows) are load-robust by construction and gain nothing
 * from waiting — see scripts/lib/headlessFrames.mjs.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { ENV_GATE_MARKERS, suiteArgv, suiteTimeoutMs } from './lib/qaSuiteContracts.mjs';

const argv = process.argv.slice(2);
const getFlag = (name) => argv.includes(name);
const getOpt = (name, fallback) => {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};

const MAX_LOAD = Number(getOpt('--max-load', '15'));
const POLL_MS = Number(getOpt('--poll-ms', '30000'));
const WAIT_MAX_MIN = Number(getOpt('--wait-max-min', '360'));
const BASE_URL = getOpt('--url', process.env.QA_BASE_URL || 'http://localhost:4173');
const DEFAULT_TIMEOUT_MS = Number(getOpt('--timeout', '900000'));
const LOG_DIR = path.resolve(getOpt('--log-dir', '.gev-logs/qa-when-quiet'));
const LIST_ONLY = getFlag('--list');

const SCRIPTS_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname));

/** Current 1-minute load average, portable across /proc and os.loadavg. */
function currentLoad() {
  try {
    const [oneMin] = fs.readFileSync('/proc/loadavg', 'utf8').split(' ');
    const parsed = Number(oneMin);
    if (Number.isFinite(parsed)) return parsed;
  } catch {
    // /proc is Linux-only; fall through to os.loadavg().
  }
  return os.loadavg()[0];
}

// Positional args = suite name substrings. Option VALUES must not be
// mistaken for them (`--url http://localhost:4173`), so skip the token
// after every value-taking option.
const VALUE_OPTIONS = new Set(['--max-load', '--poll-ms', '--wait-max-min', '--url', '--timeout', '--log-dir']);
const requested = [];
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i].startsWith('--')) {
    if (VALUE_OPTIONS.has(argv[i])) i += 1;
    continue;
  }
  requested.push(argv[i]);
}
const suites = fs.readdirSync(SCRIPTS_DIR)
  .filter((f) => f.startsWith('qa-') && f.endsWith('.mjs') && f !== 'qa-all.mjs' && f !== 'qa-when-quiet.mjs')
  .filter((f) => (requested.length ? requested.some((r) => f.includes(r)) : true))
  .sort();

if (LIST_ONLY) {
  console.log(suites.join('\n'));
  process.exit(0);
}

if (requested.length) {
  const unmatched = requested.filter((r) => !suites.some((f) => f.includes(r)));
  if (unmatched.length) {
    console.error(`No suite matches: ${unmatched.join(', ')}`);
    process.exit(2);
  }
}

fs.mkdirSync(LOG_DIR, { recursive: true });
const tallyPath = path.join(LOG_DIR, 'tally.log');
const tally = (line) => {
  console.log(line);
  fs.appendFileSync(tallyPath, `${line}\n`);
};

// ── The load gate ────────────────────────────────────────────────────────────
// Gated per suite, not once per sweep: RUN 3d opened on load 6.49 and an
// external burst hit 27.8 before the second suite started. A quiet WINDOW,
// not a quiet instant, is what timing-sensitive suites need.
async function awaitQuietWindow(label) {
  const startedAt = Date.now();
  let load = currentLoad();
  while (load >= MAX_LOAD) {
    const waitedMin = (Date.now() - startedAt) / 60_000;
    if (waitedMin > WAIT_MAX_MIN) {
      tally(`GAVE UP before ${label} after ${Math.round(waitedMin)} min — load ${load} never dropped below ${MAX_LOAD}`);
      process.exit(1);
    }
    process.stdout.write(`load ${load} ≥ ${MAX_LOAD} — waiting (${Math.round(waitedMin)} min elapsed)\r`);
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    load = currentLoad();
  }
  tally(`=== quiet window open for ${label}: load ${load} < ${MAX_LOAD} at ${new Date().toISOString()} ===`);
}

await awaitQuietWindow('the sweep');

// ── The sweep (sequential — one browser at a time on this box) ───────────────
const failures = [];
const envGated = [];
for (const suite of suites) {
  await awaitQuietWindow(suite);
  const started = new Date().toISOString();
  tally(`=== ${suite} (load ${currentLoad()}) ${started} ===`);
  const { code, logText } = await new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [path.join(SCRIPTS_DIR, suite), ...suiteArgv(suite, BASE_URL)],
      // detached: the suite leads its own process group, so the ceiling kill
      // below can take its whole tree down.
      { env: { ...process.env, QA_BASE_URL: BASE_URL }, detached: true },
    );
    const logStream = fs.createWriteStream(path.join(LOG_DIR, `${suite}.log`));
    child.stdout.pipe(logStream);
    child.stderr.pipe(logStream);
    // In-memory copy for gate classification: the stream flushes
    // asynchronously, so re-reading the file here can miss the final lines —
    // exactly where a suite prints its key-gate message.
    let logText = '';
    child.stdout.on('data', (chunk) => { logText += chunk; });
    child.stderr.on('data', (chunk) => { logText += chunk; });
    const timer = setTimeout(() => {
      // Kill the process GROUP, not just the suite process: the suite's
      // puppeteer browser is a grandchild, and killing only node orphaned a
      // Chrome that pegged ~7 cores and manufactured phantom load the quiet
      // gate then waited out (RUN 3i ceiling kill poisoned the rest of the
      // sweep).
      try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
    }, suiteTimeoutMs(suite, DEFAULT_TIMEOUT_MS));
    child.on('exit', (exitCode) => {
      clearTimeout(timer);
      resolve({ code: exitCode, logText });
    });
  });
  const minutes = ((Date.now() - Date.parse(started)) / 60_000).toFixed(1);
  // A nonzero exit that self-declares a missing key is ENV-GATED (keyless by
  // design), not a failure — same contract as qa-all.mjs.
  const gated = code !== 0 && ENV_GATE_MARKERS.some((marker) => logText.includes(marker));
  tally(`${suite} exit=${code ?? 'signal'}${gated ? ' ENV-GATED' : ''} (${minutes} min)`);
  if (gated) envGated.push(suite);
  else if (code !== 0) failures.push(suite);
}

const gatedSuffix = envGated.length ? ` (${envGated.length} env-gated, keyless by design)` : '';
tally(`=== ${suites.length - failures.length - envGated.length}/${suites.length} PASS${gatedSuffix} ===`);
if (envGated.length) tally(`env-gated: ${envGated.join(', ')}`);
if (failures.length) tally(`failed: ${failures.join(', ')}`);
process.exit(failures.length ? 1 : 0);
