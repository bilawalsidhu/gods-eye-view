import test from 'node:test';
import assert from 'node:assert/strict';
import {
  tideHeightAt,
  tideTrendAt,
  tideSpan,
  waterEllipsoidHeight,
  mllwEllipsoidHeight,
  formatFeet,
} from './model.js';
import {
  TIDE_STATIONS,
  nearestTideStation,
  findTideStation,
} from './stations.js';

// NOAA predictions for Santa Cruz 9413745, 1 Oct 2026 (GMT, metres MLLW).
const turns = [
  ['2026-10-01T10:21:00Z', 1.073, 'H'],
  ['2026-10-01T14:08:00Z', 0.893, 'L'],
  ['2026-10-01T20:39:00Z', 1.727, 'H'],
  ['2026-10-02T04:28:00Z', -0.021, 'L'],
].map(([time, height, type]) => ({ timeMs: Date.parse(time), height, type }));

test('turning points are returned exactly and the midpoint is the mean', () => {
  for (const turn of turns)
    assert.equal(tideHeightAt(turns, turn.timeMs), turn.height);
  const mid = (turns[2].timeMs + turns[3].timeMs) / 2;
  assert.ok(
    Math.abs(tideHeightAt(turns, mid) - (1.727 - 0.021) / 2) < 1e-9,
  );
});

test('the curve stays between its turning points and is null outside', () => {
  for (let t = turns[1].timeMs; t <= turns[2].timeMs; t += 60_000) {
    const h = tideHeightAt(turns, t);
    assert.ok(h >= 0.893 - 1e-9 && h <= 1.727 + 1e-9);
  }
  assert.equal(tideHeightAt(turns, turns[0].timeMs - 1), null);
  assert.equal(tideHeightAt(turns, turns[3].timeMs + 1), null);
  assert.equal(tideHeightAt([], 0), null);
});

test('trend names the next turn and its direction', () => {
  const t = Date.parse('2026-10-01T16:00:00Z');
  const trend = tideTrendAt(turns, t);
  assert.equal(trend.rising, true);
  assert.equal(trend.next.type, 'H');
  assert.equal(trend.next.height, 1.727);
  assert.equal(tideTrendAt(turns, turns[3].timeMs + 1), null);
  assert.deepEqual(tideSpan(turns), {
    startMs: turns[0].timeMs,
    endMs: turns[3].timeMs,
  });
});

test('water height chains MLLW → NAVD88 → ellipsoid with user adjustments', () => {
  const santaCruz = findTideStation('9413745');
  assert.ok(Math.abs(mllwEllipsoidHeight(santaCruz) - (0.043 - 33.509)) < 1e-9);
  const h = waterEllipsoidHeight(santaCruz, 1.727, {
    calibrationM: -0.5,
    extraM: 0.8,
  });
  assert.ok(Math.abs(h - (1.727 + 0.043 - 33.509 - 0.5 + 0.8)) < 1e-9);
  assert.equal(formatFeet(1.727), '5.7 ft');
});

test('the nearest station is chosen within range and none far offshore', () => {
  assert.equal(nearestTideStation(36.96, -122.02).station.id, '9413745');
  assert.equal(nearestTideStation(37.75, -122.5).station.id, '9414290');
  assert.equal(nearestTideStation(32.8, -117.3).station.id, '9410230');
  assert.equal(nearestTideStation(40.7, -74.0), null);
  assert.equal(nearestTideStation(Number.NaN, 0), null);
  for (const s of TIDE_STATIONS) {
    assert.match(s.id, /^\d{7}$/);
    assert.ok(s.geoidN < -20 && s.geoidN > -40, s.id);
    assert.ok(Math.abs(s.mllwAboveNavd88) < 1, s.id);
  }
});
