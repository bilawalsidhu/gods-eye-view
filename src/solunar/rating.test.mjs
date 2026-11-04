import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BAND_HALF_MS,
  CLOSE_SYZYGY_DAYS,
  MAX_STARS,
  NEAR_SYZYGY_DAYS,
  RATING_RULE,
  moonPoints,
  rateDay,
} from './rating.js';
import { solunarDay } from './solunarDay.js';

const H = 3_600_000;
const T0 = Date.UTC(2026, 10, 3, 12);
const day = (over = {}) => ({
  sunrise: [T0],
  sunset: [T0 + 11 * H],
  windows: [],
  daysFromSyzygy: 7,
  ...over,
});
const win = (kind, centerMs) => ({
  kind,
  source: kind === 'major' ? 'upper' : 'rise',
  centerMs,
  startMs: centerMs - (kind === 'major' ? H : H / 2),
  endMs: centerMs + (kind === 'major' ? H : H / 2),
});

test('the rule constants are what the panel prints', () => {
  assert.equal(NEAR_SYZYGY_DAYS, 1);
  assert.equal(CLOSE_SYZYGY_DAYS, 2.5);
  assert.equal(BAND_HALF_MS, H);
  assert.equal(MAX_STARS, 4);
  assert.deepEqual(
    RATING_RULE.moonPoints.map((r) => [r.withinDays, r.points]),
    [
      [1, 2],
      [2.5, 1],
    ],
  );
});

test('moon points: near new/full moon 2, close 1, otherwise 0', () => {
  assert.equal(moonPoints(0), 2);
  assert.equal(moonPoints(1), 2);
  assert.equal(moonPoints(1.01), 1);
  assert.equal(moonPoints(2.5), 1);
  assert.equal(moonPoints(2.51), 0);
  assert.equal(moonPoints(7), 0);
});

test('a quiet day is still one star, never zero', () => {
  const r = rateDay(day());
  assert.equal(r.fishingStars, 1);
  assert.equal(r.huntingStars, 1);
});

test('fishing counts only major windows at dawn and dusk; hunting counts any window', () => {
  // a minor window on the sunrise, a major window on the sunset
  const windows = [win('minor', T0 + 20 * 60_000), win('major', T0 + 11 * H)];
  const r = rateDay(day({ windows }));
  assert.equal(r.fishingPoints, 1, 'fishing: only the major window (dusk)');
  assert.equal(r.huntingPoints, 2, 'hunting: dawn minor + dusk major');
  assert.equal(r.fishingStars, 1);
  assert.equal(r.huntingStars, 2);
});

test('windows outside the one-hour bands do not count', () => {
  // major window ends exactly where the dawn band starts: touching is not overlap
  const w = win('major', T0 - 2 * H);
  assert.equal(w.endMs, T0 - H);
  assert.equal(rateDay(day({ windows: [w] })).fishingPoints, 0);
  const inside = win('major', T0 - 2 * H + 1);
  assert.equal(rateDay(day({ windows: [inside] })).fishingPoints, 1);
});

test('a full moon with major windows on both bands is the maximum four stars, and never more', () => {
  const windows = [
    win('major', T0),
    win('major', T0 + 11 * H),
    win('minor', T0),
  ];
  const r = rateDay(day({ windows, daysFromSyzygy: 0.2 }));
  assert.equal(r.fishingPoints, 4);
  assert.equal(r.fishingStars, 4);
  assert.equal(r.huntingStars, 4);
  const over = rateDay(
    day({ windows, daysFromSyzygy: 0, sunrise: [T0, T0], sunset: [T0, T0] }),
  );
  assert.ok(over.fishingStars <= MAX_STARS && over.huntingStars <= MAX_STARS);
});

test('a day without sunrise and sunset has no band and rates on the moon alone', () => {
  const r = rateDay(
    day({
      sunrise: [],
      sunset: [],
      windows: [win('major', T0)],
      daysFromSyzygy: 2,
    }),
  );
  assert.deepEqual(r.bands, []);
  assert.equal(r.fishingPoints, 1);
});

test('real days: stars stay in 1..4 and 2026-11-03 at Lake Bob Sandlin rates as the rule says', () => {
  const spot = { latDeg: 33.05, lonDeg: -95.1, zone: 'America/Chicago' };
  const d = solunarDay(spot, { year: 2026, month: 11, day: 3 });
  for (const s of [d.fishingStars, d.huntingStars]) assert.ok(s >= 1 && s <= 4);
  // waning crescent 30 %: more than 2.5 days from new moon (Nov 9) and full (Nov 24)
  assert.equal(d.moonPoints, 0);
  assert.equal(d.fishingPoints, rateDay(d).fishingPoints);
  // the new moon itself earns the moon points
  const newMoon = solunarDay(spot, { year: 2026, month: 11, day: 9 });
  assert.equal(newMoon.moonPoints, 2);
});
