import test from 'node:test';
import assert from 'node:assert/strict';
import { reduceFleet } from './qaMetrics.js';
const rows = () =>
  Array.from({ length: 400 }, (_, i) => ({
    x: i / 6,
    y: 0,
    z: 0,
    displayT: (i * 1000) / 60,
    expectedMps: 10,
    segment: 1,
    cpuMs: 0.5,
    intervalMs: 1000 / 60,
    uploadBytes: 128000,
    moving: 800,
  }));
test('impossible negative measurements cannot pass fleet acceptance', () => {
  const judge = (frames, allocation = 100) =>
    reduceFleet(frames, 800, allocation, 10000, 800 * 128 * 48).pass;
  assert.equal(judge(rows()), true);
  assert.equal(judge(rows(), -1), false);
  for (const field of ['cpuMs', 'intervalMs', 'uploadBytes']) {
    const frames = rows();
    frames[0][field] = -1;
    assert.equal(judge(frames), false, field);
  }
  const zeroInterval = rows();
  zeroInterval[0].intervalMs = 0;
  assert.equal(judge(zeroInterval), false);
  const zeroCpu = rows();
  zeroCpu[0].cpuMs = 0;
  assert.equal(judge(zeroCpu, 0), true);
});
