import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(
  new URL('../scripts/qa-firms.mjs', import.meta.url),
  'utf8',
);
const helper = source.slice(
  source.indexOf('async function waitForFirmsActionCount('),
  source.indexOf('/** Boot the app'),
);

function fixture(snapshots) {
  let time = 0;
  let reads = 0;
  const wait = vm.runInNewContext(`(${helper.trim()})`, {
    Date: { now: () => time },
    sleep: async (ms) => {
      time += ms;
    },
    firmsActionSnapshot: async () =>
      snapshots[Math.min(reads++, snapshots.length - 1)],
  });
  return {
    run: (expected, options) =>
      wait({ evaluate: async () => {} }, expected, options),
    elapsed: () => time,
  };
}

test('FIRMS gate waits for selected action publication, not an ambient action', async () => {
  const probe = fixture([
    { count: 1, selectedCount: 0 },
    { count: 1, selectedCount: 0 },
    { count: 2, selectedCount: 1 },
  ]);
  const result = await probe.run(1, { selectedOnly: true });
  assert.equal(result.selectedCount, 1);
  assert.ok(probe.elapsed() >= 350);
});

test('FIRMS selected-action wait remains bounded and cannot turn absence into success', async () => {
  const probe = fixture([{ count: 1, selectedCount: 0 }]);
  const result = await probe.run(1, { selectedOnly: true, timeoutMs: 350 });
  assert.equal(result.selectedCount, 0);
  assert.equal(probe.elapsed(), 350);
});

test('FIRMS aggregate wait still checks all action buttons by default', async () => {
  const probe = fixture([
    { count: 1, selectedCount: 0 },
    { count: 0, selectedCount: 0 },
  ]);
  const result = await probe.run(0);
  assert.equal(result.count, 0);
  assert.equal(probe.elapsed(), 175);
});
