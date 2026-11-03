import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { APPLICATION_LAYER_DIRECTORY } from '../src/app/layers/directory.js';

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
const report = [];
for (const [name, layers, flag] of runs) {
  const label = name + (flag ?? '');
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
  const run = spawnSync(
    process.execPath,
    [fileURLToPath(new URL('./qa-' + name + '.mjs', import.meta.url)), ...args],
    {
      encoding: 'utf8',
      timeout: 240000,
      maxBuffer: 8388608,
      env: { ...process.env, GOOGLE_MAPS_API_KEY: '', CESIUM_ION_TOKEN: '' },
    },
  );
  const ok = run.status === 0;
  writeFileSync(
    join(output, label + '.log'),
    (run.stdout || '') + (run.stderr || '') + (run.error?.message || ''),
  );
  report.push({
    label,
    layers,
    ok,
    seconds: Math.round((Date.now() - start) / 1000),
  });
  writeFileSync(
    join(output, 'summary.json'),
    JSON.stringify({ ids, report }, null, 2) + '\n',
  );
  console.log(ok ? 'PASS' : 'FAIL', label, report.at(-1).seconds);
}
console.log(
  ids.length +
    ' layers, ' +
    report.filter((row) => row.ok).length +
    '/' +
    runs.length +
    ' browser scenarios. ' +
    output,
);
if (report.some((row) => !row.ok)) process.exitCode = 1;
