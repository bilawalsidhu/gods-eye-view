import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeTimelineRuns, readTimelineFixes } from './timelineFixes.js';

test('fixes are read in time order, the malformed left out, and fewer than two are none', () => {
  assert.equal(readTimelineFixes(undefined), null);
  assert.equal(readTimelineFixes([{ atMs: 1, lat: 1, lon: 1 }]), null);
  assert.deepEqual(
    readTimelineFixes([
      { atMs: 3_000, lat: 3, lon: 3, altitudeM: 30 },
      { atMs: 'x', lat: 0, lon: 0 },
      { atMs: 2_000, lat: 95, lon: 2 },
      { atMs: 1_000, lat: 1, lon: 1, altitudeM: null },
    ]),
    [
      { atMs: 1_000, lat: 1, lon: 1, altitudeM: null },
      { atMs: 3_000, lat: 3, lon: 3, altitudeM: 30 },
    ],
  );
});

test('two runs merge in order, the newer standing in for the older within its time, thinned to the spacing', () => {
  const at = (atMs, from) => ({ atMs, from });
  const merged = mergeTimelineRuns(
    [at(0, 'old'), at(30_000, 'old'), at(105_000, 'old'), at(160_000, 'old')],
    [
      at(40_000, 'new'),
      at(80_000, 'new'),
      at(90_000, 'new'),
      at(150_000, 'new'),
    ],
    (fix) => fix.atMs,
    60_000,
  );
  // 40 s is too near 30 s; 90 s too near 80 s; 105 s is within the newer
  // run; 160 s too near 150 s, the newest of the newer run, kept.
  assert.deepEqual(merged, [
    at(0, 'old'),
    at(30_000, 'old'),
    at(80_000, 'new'),
    at(150_000, 'new'),
  ]);
  const ends = mergeTimelineRuns(
    [at(0, 'old')],
    [at(5_000, 'new'), at(10_000, 'new')],
    (fix) => fix.atMs,
    0,
  );
  assert.deepEqual(ends, [at(10_000, 'new')]);
});

test("runs a step apart, however dense, keep a contact's fixes back over every step", () => {
  const spanMs = 5 * 60_000;
  for (const [stepMs, spacingMs] of [
    [10_000, 5_000],
    [60_000, 5_000],
    [60_000, 30_000],
  ]) {
    let fixes = [];
    for (let t = 0; t <= 20 * 60_000; t += stepMs) {
      const run = [];
      for (
        let f = Math.ceil((t - spanMs) / spacingMs) * spacingMs;
        f <= t + spanMs;
        f += spacingMs
      )
        run.push({ atMs: f });
      fixes = mergeTimelineRuns(fixes, run, (fix) => fix.atMs, t);
    }
    assert.equal(fixes[0].atMs, -spanMs, `${stepMs}/${spacingMs}`);
    assert.equal(fixes.at(-1).atMs, 25 * 60_000);
    for (let k = 1; k < fixes.length - 1; k++)
      assert.ok(fixes[k].atMs - fixes[k - 1].atMs >= 20_000);
  }
});

test('past the limit only the fixes nearest the centre are kept', () => {
  const run = (from, to) =>
    Array.from({ length: to - from }, (_, k) => ({
      atMs: (from + k) * 60_000,
    }));
  const kept = mergeTimelineRuns(
    run(0, 10),
    run(10, 20),
    (f) => f.atMs,
    15 * 60_000,
    6,
  );
  assert.deepEqual(
    kept.map((f) => f.atMs / 60_000),
    [12, 13, 14, 15, 16, 17],
  );
  const early = mergeTimelineRuns(run(0, 10), run(10, 20), (f) => f.atMs, 0, 4);
  assert.deepEqual(
    early.map((f) => f.atMs / 60_000),
    [0, 1, 2, 3],
  );
});
