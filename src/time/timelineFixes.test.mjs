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

/** The merge as first written, a reference the faster one must match. */
function referenceMerge(older, newer, timeOf, centreMs, limit = 240) {
  const SPACING = 20_000;
  const first = newer.length ? timeOf(newer[0]) : Infinity;
  const last = newer.length ? timeOf(newer[newer.length - 1]) : -Infinity;
  const newest = newer[newer.length - 1];
  const merged = [];
  const take = (entry) => {
    const k = merged.length - 1;
    if (k < 0 || timeOf(entry) - timeOf(merged[k]) >= SPACING)
      merged.push(entry);
    else if (entry === newest) merged[k] = entry;
  };
  let i = 0;
  let j = 0;
  while (i < older.length || j < newer.length) {
    if (i < older.length) {
      const t = timeOf(older[i]);
      if (t >= first && t <= last) {
        i++;
        continue;
      }
      if (j >= newer.length || t < timeOf(newer[j])) {
        take(older[i++]);
        continue;
      }
    }
    take(newer[j++]);
  }
  if (merged.length <= limit) return merged;
  let start = 0;
  while (
    start + limit < merged.length &&
    Math.abs(timeOf(merged[start + limit]) - centreMs) <
      Math.abs(timeOf(merged[start]) - centreMs)
  )
    start++;
  return merged.slice(start, start + limit);
}

test('the merge keeps exactly what it always kept, for runs of every shape', () => {
  let seed = 3;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const run = (n, from, stepMs, sorted) => {
    const out = Array.from({ length: n }, (_, k) => ({
      atMs:
        rnd() < 0.05
          ? Number.NaN
          : from +
            Math.round((sorted ? k : rnd() * n) * stepMs * (0.5 + rnd())),
    }));
    if (sorted) out.sort((a, b) => a.atMs - b.atMs);
    return out;
  };
  for (let round = 0; round < 3000; round++) {
    const sorted = round % 5 !== 0;
    const older = run(
      Math.floor(rnd() * 300),
      Math.floor(rnd() * 4e6),
      15_000 + rnd() * 50_000,
      sorted,
    );
    const newer = run(
      Math.floor(rnd() * 30),
      Math.floor(rnd() * 6e6),
      5_000 + rnd() * 70_000,
      sorted,
    );
    // The newest of the newer run is sometimes an entry of the older one.
    if (newer.length && older.length && rnd() < 0.1)
      newer[newer.length - 1] = older[older.length - 1];
    const centreMs = rnd() * 7e6;
    const limit = rnd() < 0.5 ? 240 : 1 + Math.floor(rnd() * 40);
    const expected = referenceMerge(
      older,
      newer,
      (f) => f.atMs,
      centreMs,
      limit,
    );
    const actual = mergeTimelineRuns(
      older,
      newer,
      (f) => f.atMs,
      centreMs,
      limit,
    );
    assert.equal(actual.length, expected.length, `round ${round}`);
    for (let k = 0; k < expected.length; k++)
      assert.equal(actual[k], expected[k], `round ${round} entry ${k}`);
  }
});
