import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COVERAGE_SPOT_PX,
  buildTransitCoveragePoints,
  coverageColorAt,
} from './transitCoverage.js';
import { TRANSIT_ENABLED_FEEDS } from './transitFeeds.js';
import {
  ACTIVATION_ENTER_ALTITUDE_M,
  ACTIVATION_EXIT_ALTITUDE_M,
  COVERAGE_FADE,
  COVERAGE_PEAK_ALPHA,
  coverageOpacityAt,
} from '../layers/transit/policy.js';

const feed = (id, lat, lon) => ({ id, center: { lat, lon } });

test('an empty registry gives no points, and a feed without a centre is skipped', () => {
  assert.deepEqual(buildTransitCoveragePoints([]), []);
  assert.deepEqual(buildTransitCoveragePoints(null), []);
  const points = buildTransitCoveragePoints([
    feed('a', 10, 10),
    { id: 'no-centre' },
    { id: 'bad', center: { lat: NaN, lon: 3 } },
  ]);
  assert.deepEqual(
    points.map((p) => p.id),
    ['a'],
  );
});

test('a lone feed is the smallest, deepest spot', () => {
  const [point] = buildTransitCoveragePoints([feed('lone', 46.8, -100.8)]);
  assert.equal(point.neighbours, 0);
  assert.equal(point.heat, 0);
  assert.equal(point.sizePx, COVERAGE_SPOT_PX.lone);
  assert.deepEqual(point.rgb, coverageColorAt(0));
});

test('a lone feed looks the same however dense the busiest region is', () => {
  const lone = feed('lone', 46.8, -100.8);
  const cluster = Array.from({ length: 40 }, (_, i) =>
    feed(`c${i}`, 48 + (i % 8) * 0.1, 2 + Math.floor(i / 8) * 0.1),
  );
  const alone = buildTransitCoveragePoints([lone])[0];
  const crowded = buildTransitCoveragePoints([lone, ...cluster]);
  assert.deepEqual(
    crowded.find((p) => p.id === 'lone'),
    alone,
  );
  const hottest = crowded.find((p) => p.id === 'c0');
  assert.equal(hottest.neighbours, 39);
  assert.equal(hottest.heat, 1);
  assert.equal(hottest.sizePx, COVERAGE_SPOT_PX.dense);
});

test('neighbours are counted by distance, across the antimeridian too', () => {
  const points = buildTransitCoveragePoints([
    feed('west', 0, 179.8),
    feed('east', 0, -179.8),
    feed('far', 0, 170),
  ]);
  const by = Object.fromEntries(points.map((p) => [p.id, p.neighbours]));
  assert.deepEqual(by, { west: 1, east: 1, far: 0 });
});

test('the palette runs from the lone green to a pale core and clamps', () => {
  assert.deepEqual(coverageColorAt(-1), coverageColorAt(0));
  assert.deepEqual(coverageColorAt(2), coverageColorAt(1));
  assert.deepEqual(coverageColorAt(NaN), coverageColorAt(0));
  const brightness = (t) => coverageColorAt(t).reduce((a, b) => a + b, 0);
  let previous = 0;
  for (let t = 0; t <= 1.0001; t += 0.1) {
    assert.ok(brightness(t) >= previous, `does not darken at ${t.toFixed(1)}`);
    previous = brightness(t);
  }
});

test('every enabled feed gets exactly one spot, and dense regions read hotter', () => {
  const points = buildTransitCoveragePoints(TRANSIT_ENABLED_FEEDS);
  assert.equal(points.length, TRANSIT_ENABLED_FEEDS.length);
  assert.equal(new Set(points.map((p) => p.id)).size, points.length);
  const heat = (id) => points.find((p) => p.id === id).heat;
  assert.ok(heat('axo-creil') > heat('mbta'), 'the Oise outranks Boston');
  for (const point of points) {
    assert.ok(point.heat >= 0 && point.heat <= 1);
    assert.ok(
      point.sizePx >= COVERAGE_SPOT_PX.lone &&
        point.sizePx <= COVERAGE_SPOT_PX.dense,
    );
  }
});

test('the glow fades in across the altitude gate and is off near the ground', () => {
  assert.equal(coverageOpacityAt(0), 0);
  assert.equal(coverageOpacityAt(COVERAGE_FADE.from), 0);
  assert.equal(coverageOpacityAt(COVERAGE_FADE.to), 1);
  assert.equal(coverageOpacityAt(20_000_000), 1);
  assert.equal(coverageOpacityAt(Infinity), 1);
  assert.equal(coverageOpacityAt(NaN), 0);
  // Never a height with neither vehicles nor glow: the fade has begun before
  // the layer stops polling, on the way up and on the way down.
  assert.ok(COVERAGE_FADE.from < ACTIVATION_ENTER_ALTITUDE_M);
  assert.ok(coverageOpacityAt(ACTIVATION_ENTER_ALTITUDE_M) > 0);
  assert.ok(coverageOpacityAt(ACTIVATION_EXIT_ALTITUDE_M) > 0.5);
  let previous = 0;
  for (let h = 1_000_000; h <= 4_000_000; h += 50_000) {
    const opacity = coverageOpacityAt(h);
    assert.ok(opacity >= previous, `opacity does not fall at ${h} m`);
    previous = opacity;
  }
  assert.ok(COVERAGE_PEAK_ALPHA > 0.5 && COVERAGE_PEAK_ALPHA <= 1);
});
