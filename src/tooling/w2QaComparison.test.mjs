import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
function report(engine) {
  return {
    engine,
    geometryEpochMs: 1792152000000,
    checks: [{ name: 'positive capture', pass: true }],
    browserErrors: [],
    runtimePages: ['main'],
    records: Array.from({ length: 15 }, (_, i) => ({
      id: `quake-${i}`,
      magnitude: 3,
      lat: 30,
      lon: -100,
    })),
    poses: Object.fromEntries(
      ['global', 'city', 'orbit', 'terrain'].map((pose) => [
        pose,
        {
          engineEpochMs: 1792152000000,
          total: 15,
          onScreen: 5,
          known: Array.from({ length: 5 }, (_, i) => ({
            id: `quake-${i}`,
            screen: { x: 100 + i * 20, y: 200 },
          })),
        },
      ]),
    ),
  };
}
for (const [name, mutate, expected] of [
  ['valid detached geometry', () => {}, 0],
  ['late runtime errors', (d) => d.browserErrors.push('late page error'), 1],
  [
    'a failed capture assertion',
    (d) => {
      d.checks[0].pass = false;
    },
    1,
  ],
  [
    'unequal fixture clock',
    (d) => {
      d.geometryEpochMs++;
    },
    1,
  ],
  [
    'empty projected control sample',
    (d) => {
      d.poses.city.known = [];
    },
    1,
  ],
  [
    'missing screen coordinate',
    (d) => {
      delete d.poses.city.known[0].screen.y;
    },
    1,
  ],
  [
    'unfrozen pose clock',
    (d) => {
      d.poses.city.engineEpochMs++;
    },
    1,
  ],
  [
    'missing runtime observer evidence',
    (d) => {
      delete d.browserErrors;
    },
    1,
  ],
]) {
  test(`W2 comparison rejects invalid evidence: ${name}`, () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'gev-w2-compare-'));
    try {
      const a = report('cesium'),
        b = report('navara');
      mutate(b);
      const files = ['a.json', 'b.json'].map((file) => path.join(dir, file));
      files.forEach((file, i) =>
        writeFileSync(file, JSON.stringify([a, b][i])),
      );
      const result = spawnSync(
        process.execPath,
        ['scripts/qa-w2-layers.mjs', `--compare=${files.join(',')}`],
        { encoding: 'utf8' },
      );
      assert.equal(result.status, expected, result.stdout + result.stderr);
      assert.equal(JSON.parse(result.stdout).pass, expected === 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
