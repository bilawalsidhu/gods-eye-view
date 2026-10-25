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

test('bytes and spans read plainly', async () => {
  const { formatBytes, formatSpan } = await import('./model.js');
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(88 * 1048576), '88 MB');
  assert.equal(formatSpan(1500), '25min');
  assert.equal(formatSpan(23400), '6.5h');
  assert.equal(formatSpan(86400 * 12), '12d');
});

test('storage bar uses the cap, else the disk, and turns red near full', async () => {
  const { storageUse } = await import('./model.js');
  const MB = 1048576;
  const capped = storageUse({
    bytes: 300 * MB,
    max_bytes: 500 * MB,
    disk_free_bytes: 90000 * MB,
  });
  assert.equal(capped.basis, 'cap');
  assert.equal(capped.total, 500 * MB);
  assert.equal(capped.level, 'orange');
  assert.equal(capped.free, 200 * MB);
  const disk = storageUse({ bytes: 100 * MB, disk_free_bytes: 900 * MB });
  assert.equal(disk.basis, 'disk');
  assert.equal(disk.fraction, 0.1);
  assert.equal(disk.level, 'green');
  assert.equal(storageUse({ bytes: 90, max_bytes: 100 }).level, 'red');
  const unknown = storageUse({ bytes: 5 * MB });
  assert.equal(unknown.basis, 'none');
  assert.equal(unknown.fraction, 0);
});

test('storage bar projects growth against retention', async () => {
  const { storageUse } = await import('./model.js');
  const MB = 1048576;
  // 10 MB in the first hour, kept for 7 days: settles near 1.6 GB.
  const fits = storageUse({
    bytes: 10 * MB,
    from_ts: 0,
    to_ts: 3600,
    retention_sec: 7 * 86400,
    max_bytes: 4096 * MB,
  });
  assert.ok(Math.abs(fits.settlesAt - 1680 * MB) < MB);
  assert.equal(fits.fullInSec, null);
  // Same growth into a 500 MB cap: full in about 49 hours.
  const fills = storageUse({
    bytes: 10 * MB,
    from_ts: 0,
    to_ts: 3600,
    retention_sec: 7 * 86400,
    max_bytes: 500 * MB,
  });
  assert.equal(fills.settlesAt, null);
  assert.ok(Math.abs(fills.fullInSec - 49 * 3600) < 60);
  // Too little history to say.
  assert.equal(storageUse({ bytes: MB, from_ts: 0, to_ts: 60 }).perHour, null);
});
