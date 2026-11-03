import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';
import { APPLICATION_LAYER_DIRECTORY } from '../src/app/layers/directory.js';

// Runs every browser scenario against one keyless local preview and writes
// <output>/acceptance.json plus one log per scenario.

const base = new URL(process.argv[2]);
if (
  !['127.0.0.1', 'localhost'].includes(base.hostname) ||
  ['', '4173', '4185', '4186', '4187', '4188', '4189', '4194'].includes(
    base.port,
  )
)
  throw Error('Supply an unreserved keyless local preview URL');
const output = process.argv[3]
  ? resolve(process.argv[3])
  : mkdtempSync(join(tmpdir(), 'gev-layer-switch-'));
mkdirSync(output, { recursive: true });

// Fail once, with the fix, instead of once per scenario.
let chrome;
try {
  const browser = await puppeteer.launch({ headless: true });
  chrome = await browser.version();
  await browser.close();
} catch (error) {
  console.error(
    'Puppeteer cannot start Chrome: ' +
      String(error?.message)
        .split('\n')[0]
        .replace(/ This can occur.*/, '') +
      '\nPoint PUPPETEER_EXECUTABLE_PATH at an installed Chrome, for example\n' +
      '  PUPPETEER_EXECUTABLE_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"\n' +
      'or download the pinned build with `npx puppeteer browsers install chrome`.',
  );
  process.exit(2);
}
try {
  const response = await fetch(base.origin + '/', {
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw Error('HTTP ' + response.status);
} catch (error) {
  console.error(
    'No preview answers at ' + base.origin + ' (' + error.message + ').',
  );
  process.exit(2);
}
const root = fileURLToPath(new URL('..', import.meta.url));
const git = (...args) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8' });
// Other work may change the tree while the run lasts; record both ends.
const dirty = () =>
  git('status', '--porcelain')
    .split('\n')
    .filter(Boolean)
    .map((line) => line.slice(3));
const dirtyFiles = dirty();
const runs = [
  ['engine-switch', ['earthquakes']],
  ['director-engine-switch', []],
  ['layer-handoff', ['flights']],
  ['layer-handoff', ['military'], '--military'],
  [
    'ground-layer-switch',
    ['ais-live-vessels', 'air-quality', 'gnss-integrity', 'fire-perimeters'],
  ],
  ['contact-switch', ['military-awareness', 'military-installations']],
  ['local-adsb-engine-switch', ['local-adsb']],
  ['ghostmaps-switch', ['s2-ghostmaps']],
  [
    'weather-engine-switch',
    [
      'weather-radar',
      'weather-satellite',
      'weather-lightning',
      'weather-cyclones',
    ],
  ],
  ['wind-engine-switch', ['wind']],
  ['infrastructure-engine-switch', ['local-dams', 'local-datacenters']],
  ['submarine-cables-engine-switch', ['telegeography-submarine-cables']],
  ['directions-engine-switch', ['directions']],
  ['nepal-locator-switch', ['bhote-koshi-locator']],
  ['nepal-event-switch', ['bhote-koshi-2026']],
  ['traffic-engine-switch', ['traffic']],
  ['traffic-engine-switch', ['traffic'], '--simulation'],
  ['street-level-engine-switch', ['street-level']],
  ['street-level-engine-switch', ['street-level'], '--panoramax'],
  ['radio-engine-switch', ['radio']],
  ['w2-imagery', ['recent-imagery']],
  ['fire-camera-switch', ['alpr-cameras']],
  ['fire-camera-switch', ['local-firms'], '--fires'],
  ['urban-engine-switch', ['bikeshare']],
  ['urban-engine-switch', ['transit'], '--transit'],
  ['cctv-engine-switch', ['cctv']],
  ['space-engine-switch', ['satellites']],
  ['space-engine-switch', ['rocket-launches'], '--missions'],
];
const ids = [...new Set(runs.flatMap(([, ids]) => ids))].sort();
assert.deepEqual(
  ids,
  APPLICATION_LAYER_DIRECTORY.map((l) => l.id).sort(),
  'Every catalog layer must have a browser scenario',
);
const scenarios = [];
const report = {
  commit: git('rev-parse', 'HEAD').trim(),
  dirty: dirtyFiles.length > 0,
  dirtyFiles,
  dirtyFilesAtEnd: null,
  chrome,
  puppeteerExecutable: process.env.PUPPETEER_EXECUTABLE_PATH || null,
  node: process.version,
  platform: process.platform + ' ' + process.arch,
  baseUrl: base.origin,
  startedAt: new Date().toISOString(),
  finishedAt: null,
  layers: ids,
  passed: 0,
  failed: 0,
  scenarios,
};
const save = () =>
  writeFileSync(
    join(output, 'acceptance.json'),
    JSON.stringify(report, null, 2) + '\n',
  );
for (const [name, layers, flag] of runs) {
  const label = name + (flag ?? '');
  const script = 'scripts/qa-' + name + '.mjs';
  const args =
    name === 'w2-imagery'
      ? [
          '--url',
          base.origin + '/?engine=navara',
          '--report',
          join(output, 'imagery.json'),
          '--switch',
          '--preview',
        ]
      : [base.origin, ...(flag ? [flag] : [])];
  const start = Date.now();
  const run = spawnSync(process.execPath, [join(root, script), ...args], {
    encoding: 'utf8',
    timeout: 240000,
    maxBuffer: 8388608,
    env: { ...process.env, GOOGLE_MAPS_API_KEY: '', CESIUM_ION_TOKEN: '' },
  });
  const status =
    run.status === 0
      ? 'pass'
      : run.error?.code === 'ETIMEDOUT'
        ? 'timeout'
        : 'fail';
  const log =
    (run.stdout || '') + (run.stderr || '') + (run.error?.message || '');
  writeFileSync(join(output, label + '.log'), log);
  scenarios.push({
    label,
    script,
    args: args.map((arg) =>
      arg.startsWith(output) ? '<output>' + arg.slice(output.length) : arg,
    ),
    layers,
    status,
    exitCode: run.status,
    seconds: Math.round((Date.now() - start) / 100) / 10,
    log: label + '.log',
    logSha256: createHash('sha256').update(log).digest('hex'),
  });
  report.passed = scenarios.filter((row) => row.status === 'pass').length;
  report.failed = scenarios.length - report.passed;
  save();
  console.log(status.toUpperCase(), label, scenarios.at(-1).seconds);
}
report.finishedAt = new Date().toISOString();
report.dirtyFilesAtEnd = dirty();
save();
console.log(
  ids.length +
    ' layers, ' +
    report.passed +
    '/' +
    runs.length +
    ' browser scenarios. ' +
    join(output, 'acceptance.json'),
);
if (report.failed) process.exitCode = 1;
