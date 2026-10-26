import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url));
async function compare(change) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gev-w1-compare-'));
  const base = {
    layer: 'flights',
    engine: 'cesium',
    geometryClock: { epochMs: 1000, engineMs: 1000 },
    view: {
      city: { onScreen: 1, known: [{ id: 'a', screen: { x: 100, y: 100 } }] },
    },
    sections: {},
    results: [{ name: 'no errors', pass: true }],
    browserErrors: [],
  };
  const other = structuredClone(base);
  other.engine = 'navara';
  change(other);
  try {
    const a = path.join(dir, 'a.json'),
      b = path.join(dir, 'b.json');
    await fs.writeFile(a, JSON.stringify(base));
    await fs.writeFile(b, JSON.stringify(other));
    return spawnSync(
      process.execPath,
      ['scripts/qa-w1-layers.mjs', `--compare=${a},${b}`],
      { cwd: root, encoding: 'utf8' },
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
test('W1 comparison rejects a late browser error even when the earlier checks all passed', async () => {
  const result = await compare((report) =>
    report.browserErrors.push('HTTP503 after voice action'),
  );
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /recorded browser errors/);
});
test('W1 comparison rejects failed acceptance even with identical geometry', async () => {
  const result = await compare((report) => {
    report.results[0].pass = false;
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /failed checks/);
});
test('W1 comparison accepts matching geometry with clean complete acceptance', async () => {
  const result = await compare(() => {});
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /parity/);
});

test('W1 comparison rejects unequal geometry epochs with identical positions', async () => {
  const result = await compare((report) => {
    report.geometryClock = { epochMs: 2000, engineMs: 2000 };
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /geometry clocks/);
});
test('W1 comparison rejects a missing geometry clock with identical positions', async () => {
  const result = await compare((report) => {
    delete report.geometryClock;
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /geometry clocks/);
});
