import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import {
  classifyAttempt,
  flakeReport,
  formatFlakeReport,
  historyLine,
  retryStatus,
} from './qa/acceptance.mjs';
import { processTree, readProcesses, runScenario } from './qa/process.mjs';

test('a timeout after passing evidence is hung, even after a zero exit', () => {
  const timeout = { status: 0, error: { code: 'ETIMEDOUT' } };
  assert.equal(classifyAttempt(timeout, { status: 'pass' }), 'hung');
  assert.equal(classifyAttempt(timeout, { status: 'fail' }), 'timeout');
  assert.equal(classifyAttempt(timeout, null), 'timeout');
});

test('a pass requires a successful exit and passing evidence', () => {
  const pass = { status: 'pass' };
  assert.equal(classifyAttempt({ status: 0 }, pass), 'pass');
  assert.equal(classifyAttempt({ status: 1 }, pass), 'fail');
  assert.equal(classifyAttempt({ status: 0, signal: 'SIGTERM' }, pass), 'fail');
  assert.equal(
    classifyAttempt({ status: 0, error: { code: 'ENOBUFS' } }, pass),
    'fail',
  );
  assert.equal(classifyAttempt({ status: 0 }, { status: 'fail' }), 'fail');
  assert.equal(classifyAttempt({ status: 0 }, null), 'fail');
  assert.equal(
    classifyAttempt({ status: 0 }, null, { external: true }),
    'pass',
  );
});

test('a passing retry is flaky; no retry preserves the first status', () => {
  for (const status of ['fail', 'timeout', 'hung']) {
    assert.equal(retryStatus(status, 'pass'), 'flaky');
    assert.equal(retryStatus(status), status);
    assert.equal(retryStatus(status, 'fail'), 'fail');
  }
  assert.equal(retryStatus('pass'), 'pass');
});

const report = (scenarios) => ({
  commit: 'abc123',
  dirty: true,
  startedAt: '2026-11-10T12:00:00Z',
  finishedAt: '2026-11-10T12:00:12.500Z',
  scenarios: Object.entries(scenarios).map(([label, status]) => ({
    label,
    status,
  })),
});

test('history records provenance, duration, every status, and selected scenarios', () => {
  assert.deepEqual(
    historyLine(
      report({ a: 'pass', b: 'flaky', c: 'hung', d: 'timeout', e: 'fail' }),
    ),
    {
      commit: 'abc123',
      dirty: true,
      startedAt: '2026-11-10T12:00:00Z',
      finishedAt: '2026-11-10T12:00:12.500Z',
      seconds: 12.5,
      counts: { pass: 1, flaky: 1, hung: 1, timeout: 1, fail: 1 },
      scenarios: ['a', 'b', 'c', 'd', 'e'],
      nonPass: [
        { label: 'b', status: 'flaky' },
        { label: 'c', status: 'hung' },
        { label: 'd', status: 'timeout' },
        { label: 'e', status: 'fail' },
      ],
    },
  );
});

test('flake shares include flaky runs and exclude scenarios absent from partial runs', () => {
  const history = [
    historyLine(report({ a: 'pass', b: 'flaky', c: 'fail' })),
    historyLine(report({ a: 'pass', b: 'pass' })),
    historyLine(report({ a: 'hung' })),
  ];
  assert.deepEqual(flakeReport(history), {
    scenarios: [
      { label: 'c', runs: 1, passes: 0, nonPassShare: 1 },
      { label: 'b', runs: 2, passes: 1, nonPassShare: 0.5 },
      { label: 'a', runs: 3, passes: 2, nonPassShare: 1 / 3 },
    ],
    overall: { runs: 6, passes: 3, nonPassShare: 0.5 },
  });
  assert.match(formatFlakeReport(history), /overall\t6\t3\t50.0%$/);
  assert.deepEqual(flakeReport([]), {
    scenarios: [],
    overall: { runs: 0, passes: 0, nonPassShare: 0 },
  });
});

test('the report CLI reads JSON lines and rejects malformed input', async (t) => {
  const dir = mkdtempSync('tmp_acceptance_history_');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = `${dir}/history.jsonl`;
  writeFileSync(
    file,
    JSON.stringify(historyLine(report({ a: 'flaky' }))) + '\n',
  );
  const run = promisify(execFile);
  const script = new URL('./report-acceptance-flake.mjs', import.meta.url);
  const result = await run(process.execPath, [script.pathname, file]);
  assert.match(result.stdout, /a\t1\t0\t100.0%/);
  writeFileSync(file, '{broken}\n');
  await assert.rejects(run(process.execPath, [script.pathname, file]), {
    code: 1,
  });
});

test('process trees include detached descendants and orphaned group members only', () => {
  const rows = [
    { pid: 10, ppid: 1, pgid: 10 },
    { pid: 20, ppid: 10, pgid: 20 },
    { pid: 21, ppid: 20, pgid: 20 },
    { pid: 22, ppid: 1, pgid: 20 },
    { pid: 99, ppid: 1, pgid: 99 },
  ];
  assert.deepEqual(
    processTree(10, rows).map((row) => row.pid),
    [10, 20, 21],
  );
  assert.deepEqual(
    processTree(20, rows).map((row) => row.pid),
    [20, 21, 22],
  );
});

test('scenario spawning captures both streams and reports spawn failures', async () => {
  const run = await runScenario(
    process.execPath,
    ['-e', "console.log('out'); console.error('err'); process.exitCode = 3"],
    { timeout: 5000 },
  );
  assert.equal(run.status, 3);
  assert.equal(run.stdout, 'out\n');
  assert.equal(run.stderr, 'err\n');
  assert.equal(run.error, null);
  const missing = await runScenario('./tmp_acceptance_missing_executable', [], {
    timeout: 5000,
  });
  assert.equal(missing.error.code, 'ENOENT');
});

test('timeout kills the scenario and a detached group after its leader exits', async (t) => {
  // These Node children stand in for Chrome and a renderer; no browser is run.
  const renderer = 'setInterval(() => {}, 1000)';
  const browser = `
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ['-e', ${JSON.stringify(renderer)}], { stdio: 'inherit' });
    console.log('renderer', child.pid);
    setTimeout(() => process.exit(0), 1500);
  `;
  const scenario = `
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ['-e', ${JSON.stringify(browser)}], { detached: true, stdio: 'inherit' });
    console.log('browser', child.pid);
    console.log('scenario', process.pid);
    setInterval(() => {}, 1000);
  `;
  const run = await runScenario(process.execPath, ['-e', scenario], {
    timeout: 2600,
  });
  const pids = [
    ...run.stdout.matchAll(/(?:browser|renderer|scenario) (\d+)/g),
  ].map((match) => Number(match[1]));
  t.after(() => {
    for (const pid of pids) {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {}
    }
  });
  assert.equal(run.error.code, 'ETIMEDOUT');
  assert.equal(pids.length, 3);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const survivors = readProcesses().filter(
    (row) => pids.includes(row.pid) && !/defunct/.test(row.command),
  );
  assert.deepEqual(survivors, []);
});
