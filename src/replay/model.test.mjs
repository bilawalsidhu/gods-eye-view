import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTicks,
  groupTracks,
  nearestDeltaMs,
  replayWindow,
  splitAtGaps,
  tickIndexAt,
} from './model.js';

test('buildTicks spaces ticks evenly and refuses an empty span', () => {
  const ticks = buildTicks(0, 3000, 4);
  assert.equal(ticks.length, 4);
  assert.equal(ticks[0], '1970-01-01T00:00:00.000Z');
  assert.equal(ticks[3], '1970-01-01T00:00:03.000Z');
  assert.deepEqual(buildTicks(5, 5), []);
  assert.deepEqual(buildTicks(NaN, 5), []);
});

test('groupTracks separates layers and sorts by time', () => {
  const tracks = groupTracks([
    { id: 'a', layer: 'air', ts: 20 },
    { id: 'a', layer: 'air', ts: 10 },
    { id: 'a', layer: 'mil', ts: 5 },
  ]);
  assert.equal(tracks.size, 2);
  assert.deepEqual(
    tracks.get('air:a').points.map((p) => p.ts),
    [10, 20],
  );
});

test('replayWindow clips to the newest hours and needs a span', () => {
  assert.deepEqual(replayWindow({ from_ts: 0, to_ts: 100000 }, 1), {
    fromSec: 96400,
    toSec: 100000,
  });
  assert.equal(replayWindow({ from_ts: 5, to_ts: 5 }), null);
  assert.equal(replayWindow(null), null);
});

test('tickIndexAt finds the last tick at or before a time', () => {
  const ticks = buildTicks(0, 3000, 4);
  assert.equal(tickIndexAt(ticks, 1500), 1);
  assert.equal(tickIndexAt(ticks, -5), 0);
  assert.equal(tickIndexAt(ticks, 9999), 3);
});

test('splitAtGaps breaks a track where recording stopped', () => {
  const p = (ts) => ({ ts });
  const parts = splitAtGaps([p(0), p(60), p(120), p(1000), p(1060)], 300);
  assert.deepEqual(
    parts.map((s) => s.map((x) => x.ts)),
    [
      [0, 60, 120],
      [1000, 1060],
    ],
  );
  assert.deepEqual(splitAtGaps([], 300), []);
});

test('nearestDeltaMs tells recorded moments from estimated ones', () => {
  const times = [1000, 31000, 61000];
  assert.equal(nearestDeltaMs(times, 31000), 0);
  assert.equal(nearestDeltaMs(times, 33000), 2000);
  assert.equal(nearestDeltaMs(times, 16000), 15000);
  assert.equal(nearestDeltaMs(times, 90000), 29000);
  assert.equal(nearestDeltaMs([], 5), Infinity);
});
