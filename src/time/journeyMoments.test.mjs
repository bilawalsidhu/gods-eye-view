import assert from 'node:assert/strict';
import test from 'node:test';
import { journeyMoments } from './journeyMoments.js';

const T = 1_795_550_000;
test('an airframe day gives a pin at each takeoff and landing', () => {
  const path = [
    [T, 41.9, -88.1, 0, 90],
    [T + 60, 41.9, -88.0, 0, 90],
    [T + 120, 41.9, -87.9, 400, 90],
    [T + 180, 41.9, -87.8, 900, 90],
    [T + 3600, 33.6, -84.4, 300, 90],
    [T + 3660, 33.6, -84.4, 0, 90],
    [T + 3720, 33.6, -84.4, null, 90],
  ];
  const moments = journeyMoments(path, { nowMs: (T + 9999) * 1000 });
  assert.deepEqual(
    moments.map((m) => [m.label, m.time / 1000]),
    [
      ['TOOK OFF', T + 60],
      ['LANDED', T + 3660],
    ],
  );
});

test('a track that starts and ends in the air says first and last seen', () => {
  const path = [
    [T, 50, -30, 11000, 90],
    [T + 60, 50, -29, 11000, 90],
    [T + 120, 50, -28, 11000, 90],
  ];
  const labels = journeyMoments(path, { nowMs: (T + 3600) * 1000 }).map((m) => m.label);
  assert.deepEqual(labels, ['FIRST SEEN', 'LAST SEEN']);
});

test('a lone ground blip does not land a cruising aircraft', () => {
  const path = [
    [T, 50, -30, 11000, 90],
    [T + 60, 50, -29, 0, 90],
    [T + 120, 50, -28, 11000, 90],
  ];
  assert.deepEqual(
    journeyMoments(path, { nowMs: (T + 200) * 1000 }).map((m) => m.label),
    ['FIRST SEEN'],
  );
});
